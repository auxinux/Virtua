/**
 * Disposable VMs (beta) — API routes. A base is a read-only system disk kept
 * on the node (made from a stopped VM, or imported from a `.vmtmp` of the
 * AuxiNux depot); a disposable VM is an overlay on it. The runner owns every
 * file and libvirt operation; this module validates, authorizes, tracks the
 * task and keeps the VM ownership rows.
 *
 * Bases live on the node that serves this API: like /api/resources template
 * creation, disposable VMs are created on the local node only.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateBaseSchema,
  DisposableActionSchema,
  ImportDepotBaseSchema,
  LaunchDisposableSchema,
  isVmtmpFilename,
  type BaseInfo,
  type DepotBaseEntry,
} from "@auxinux/shared";
import type { RunnerProgress } from "./runnerClient.js";

type Task = { id: string; message?: string };

/**
 * Who is acting: a web session or a Virtua Desktop token (same user + role).
 * Every check (RBAC, quota, permission flags) and the task/audit trail is
 * keyed on it, so both surfaces get exactly the same rules.
 */
export interface ApiActor {
  userId: number;
  role: string;
  username: string;
  ip: string;
}

/** A refusal with its HTTP status (4xx), raised before anything is done. */
export class ApiError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

/** HTTP answer of a service call (`status` 200 or 202). */
export interface ServiceResult<T = unknown> {
  status: number;
  body: T;
}

export interface DisposableRouteDeps {
  db: Database.Database;
  callRunner: <T = unknown>(action: string, params?: unknown, timeoutMs?: number, onProgress?: (p: RunnerProgress) => void) => Promise<T>;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => void;
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => void;
  /** The web session's actor (called after requireAuth/requireAdmin). */
  actorOf: (req: FastifyRequest) => ApiActor;
  /** Per-resource RBAC (ADMIN = all, owner, ACL) — the panel's own check. */
  hasVmPermission: (actor: ApiActor, name: string, permission: "view" | "power" | "modify" | "delete") => boolean;
  /** VM quota + `allow_vm_create`. */
  checkVmCreateAllowed: (actor: ApiActor) => { ok: boolean; reason?: string };
  checkPermission: (actor: ApiActor, action: "allow_vm_delete" | "allow_vm_modify") => { ok: boolean; reason?: string };
  /** Pool name → path, only when the pool may hold VM disks. */
  resolveVmDiskPool: (name: string) => { path: string } | undefined;
  /** Whether the VM is hosted by this node (disposables are local-only). */
  isLocalVm: (name: string) => Promise<boolean>;
  localNodeName: () => string;
  /** Same cleanup as DELETE /api/vms/:name once the domain is gone. */
  forgetVm: (name: string) => Promise<void>;
  createTask: (actor: ApiActor, options: { kind: "create" | "delete" | "action" | "url-download"; action: string; label: string; resourceType?: string; resourceName?: string; message?: string; detail?: string }) => Task;
  runInstantTask: <T>(task: Task, ip: string, fn: () => Promise<T>) => Promise<T>;
  runTrackedTask: (task: Task, ip: string, fn: (helpers: { update: (patch: Record<string, unknown>) => void }) => Promise<unknown>) => Promise<void>;
  publicTask: (task: Task) => unknown;
  onRunnerProgress: (taskId: string) => (p: RunnerProgress) => void;
  downloadToFile: (taskId: string, url: string, file: string) => Promise<void>;
  depotBase: () => string;
  /** Scratch directory the API may write (the .vmtmp carrier before import). */
  scratchDir: string;
}

const LONG_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const ARCH_FOLDERS: Array<{ folder: string; arch: "amd64" | "arm64" }> = [
  { folder: "AMD64", arch: "amd64" },
  { folder: "ARM", arch: "arm64" },
];

/** This node's arch in the base vocabulary. */
export function nodeBaseArch(processArch = process.arch): "amd64" | "arm64" {
  return processArch === "arm64" ? "arm64" : "amd64";
}

/** `.vmtmp` names of an autoindex page (hrefs at the folder root only). */
export function parseVmtmpListing(html: string): string[] {
  const names = new Set<string>();
  for (const match of html.matchAll(/href="([^"?#]+)"/g)) {
    let name: string;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (name.includes("/") || !isVmtmpFilename(name)) continue;
    names.add(name);
  }
  return [...names];
}

async function headContentLength(url: string): Promise<number | undefined> {
  try {
    // A HEAD response has no body: the size is the header, not the body length.
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    const size = parseInt(res.headers.get("content-length") ?? "", 10);
    return res.ok && Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

export async function listDepotBases(depotBase: string, arch: "amd64" | "arm64"): Promise<DepotBaseEntry[]> {
  const folder = ARCH_FOLDERS.find((entry) => entry.arch === arch)!.folder;
  const dirUrl = `${depotBase.replace(/\/*$/, "/")}VM/${folder}/`;
  const res = await fetch(dirUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw Object.assign(new Error(`AuxiNux depot unreachable (HTTP ${res.status})`), { statusCode: 502 });
  const names = parseVmtmpListing(await res.text());
  return Promise.all(names.map(async (name) => {
    const url = `${dirUrl}${encodeURIComponent(name)}`;
    return { name, url, architecture: arch, sizeBytes: await headContentLength(url) };
  }));
}

function zodError(issues: Array<{ path: Array<string | number>; message: string }>) {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export function registerDisposableRoutes(app: FastifyInstance, deps: DisposableRouteDeps) {
  const { callRunner } = deps;
  const service = createDisposableService(deps);

  app.get("/api/disposable/bases", async (req, reply) => {
    deps.requireAuth(req, reply);
    return service.listBases();
  });

  // Base from a stopped VM: a flattened copy of its disk (long: task-tracked).
  app.post("/api/disposable/bases", async (req, reply) => {
    deps.requireAdmin(req, reply);
    const parsed = CreateBaseSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: zodError(parsed.error.issues) });
    const { vmName, label, os, removeSource } = parsed.data;
    if (!(await deps.isLocalVm(vmName))) return reply.status(400).send({ error: "Bases are made from VMs of this node" });
    const actor = deps.actorOf(req);
    const ip = actor.ip;
    const task = deps.createTask(actor, { kind: "create", action: "disposable.base.create", label: `Make a disposable base from ${vmName}`, resourceType: "vm", resourceName: vmName, message: "Copying the system disk" });
    void deps.runTrackedTask(task, ip, async () => {
      const result = await callRunner("qemu_base_create", { name: vmName, label, os, removeSource }, LONG_TIMEOUT_MS, deps.onRunnerProgress(task.id));
      if (removeSource) await deps.forgetVm(vmName);
      return result;
    });
    return reply.status(202).send(deps.publicTask(task));
  });

  app.delete("/api/disposable/bases/:id", async (req, reply) => {
    deps.requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const actor = deps.actorOf(req);
    const ip = actor.ip;
    const task = deps.createTask(actor, { kind: "delete", action: "disposable.base.delete", label: `Delete disposable base ${id}`, message: id });
    return deps.runInstantTask(task, ip, () => callRunner("qemu_base_delete", { id }));
  });

  app.get("/api/disposable/depot", async (req, reply) => {
    deps.requireAdmin(req, reply);
    try {
      return { base: deps.depotBase(), items: await listDepotBases(deps.depotBase(), nodeBaseArch()) };
    } catch (error) {
      return reply.status(502).send({ error: error instanceof Error ? error.message : "Depot unreachable" });
    }
  });

  app.post("/api/disposable/depot/import", async (req, reply) => {
    deps.requireAdmin(req, reply);
    const parsed = ImportDepotBaseSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: zodError(parsed.error.issues) });
    // Only a file the depot actually lists (never a caller-supplied URL).
    const items = await listDepotBases(deps.depotBase(), nodeBaseArch()).catch(() => [] as DepotBaseEntry[]);
    const item = items.find((entry) => entry.name === parsed.data.name);
    if (!item) return reply.status(404).send({ error: "This .vmtmp is not on the depot for this node's architecture" });
    const actor = deps.actorOf(req);
    const ip = actor.ip;
    const task = deps.createTask(actor, { kind: "url-download", action: "disposable.base.import", label: `Import disposable base ${item.name}`, message: "Downloading from depot", detail: item.name });
    void deps.runTrackedTask(task, ip, async ({ update }) => {
      await fs.promises.mkdir(deps.scratchDir, { recursive: true });
      const carrier = path.join(deps.scratchDir, `.base-${randomUUID()}.vmtmp`);
      try {
        await deps.downloadToFile(task.id, item.url, carrier);
        update({ message: "Unpacking and checking the base", progressPercent: 96 });
        return await callRunner("qemu_base_import", { archivePath: carrier }, LONG_TIMEOUT_MS);
      } finally {
        // The archive is only a carrier: the base now lives on the node.
        await fs.promises.unlink(carrier).catch(() => {});
      }
    });
    return reply.status(202).send(deps.publicTask(task));
  });

  app.post("/api/disposable/launch", async (req, reply) => {
    deps.requireAuth(req, reply);
    return sendServiceResult(reply, () => service.launch(deps.actorOf(req), req.body));
  });

  // What to do with a stopped disposable VM: discard / reset / keep / convert.
  app.post("/api/vms/:name/disposable/:action", async (req, reply) => {
    deps.requireAuth(req, reply);
    const { name, action } = req.params as { name: string; action: string };
    return sendServiceResult(reply, () => service.action(deps.actorOf(req), name, action));
  });
}

/** Run a service call and answer it; an ApiError becomes `{ error }` with its status. */
export async function sendServiceResult(reply: FastifyReply, fn: () => Promise<ServiceResult>) {
  try {
    const result = await fn();
    return reply.status(result.status).send(result.body);
  } catch (error) {
    if (error instanceof ApiError) return reply.status(error.statusCode).send({ error: error.message });
    throw error;
  }
}

export type DisposableService = ReturnType<typeof createDisposableService>;

/**
 * Disposable VM operations for any caller (web session, Virtua Desktop):
 * validation, RBAC/quota, task + audit, runner call and ownership rows.
 * Refusals throw ApiError; runner failures propagate as-is.
 */
export function createDisposableService(deps: Omit<DisposableRouteDeps, "requireAuth" | "requireAdmin" | "actorOf">) {
  const { db, callRunner } = deps;

  return {
    listBases: () => callRunner<BaseInfo[]>("qemu_bases_list"),

    /** `body` follows LaunchDisposableSchema. Returns the runner result ({ ok, name, baseId }). */
    async launch(actor: ApiActor, body: unknown): Promise<ServiceResult<{ ok: boolean; name: string; baseId: string }>> {
      const parsed = LaunchDisposableSchema.safeParse(body);
      if (!parsed.success) throw new ApiError(400, zodError(parsed.error.issues));
      const allowed = deps.checkVmCreateAllowed(actor);
      if (!allowed.ok) throw new ApiError(403, allowed.reason ?? "Forbidden");
      const pool = deps.resolveVmDiskPool(parsed.data.storagePool);
      if (!pool) throw new ApiError(400, "Storage pool not found or not allowed to hold VM disks");
      const task = deps.createTask(actor, { kind: "create", action: "vm.disposable.launch", label: `Launch disposable VM from ${parsed.data.baseId}`, resourceType: "vm", resourceName: parsed.data.name, message: parsed.data.strict ? "Strict sandbox" : "Disposable VM" });
      const result = await deps.runInstantTask(task, actor.ip, async () => {
        const launched = await callRunner<{ ok: boolean; name: string; baseId: string }>("qemu_disposable_launch", { ...parsed.data, storagePool: pool.path }, 5 * 60_000);
        db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, tags = excluded.tags, node_name = excluded.node_name")
          .run(launched.name, actor.userId, `Jetable · ${parsed.data.baseId}`, JSON.stringify(["jetable"]), deps.localNodeName());
        return launched;
      });
      return { status: 200, body: result };
    },

    /** discard / reset / keep (200, runner result) or convert (202, public task). */
    async action(actor: ApiActor, name: string, rawAction: string): Promise<ServiceResult> {
      const action = DisposableActionSchema.safeParse(rawAction);
      if (!action.success) throw new ApiError(400, `Invalid action. Allowed: ${DisposableActionSchema.options.join(", ")}`);
      const requirePermission = (permission: "view" | "modify" | "delete", flag?: "allow_vm_delete" | "allow_vm_modify") => {
        if (!deps.hasVmPermission(actor, name, permission)) throw new ApiError(403, "Forbidden");
        if (flag) {
          const perm = deps.checkPermission(actor, flag);
          if (!perm.ok) throw new ApiError(403, perm.reason ?? "Forbidden");
        }
      };
      if (action.data === "discard") requirePermission("delete", "allow_vm_delete");
      else if (action.data === "keep") requirePermission("view");
      else requirePermission("modify", "allow_vm_modify");
      if (!(await deps.isLocalVm(name))) throw new ApiError(400, "Disposable VMs are managed on their own node");
      const labels = { discard: "Discard", reset: "Reset from base", keep: "Keep", convert: "Convert to an ordinary VM" } as const;
      const task = deps.createTask(actor, { kind: action.data === "discard" ? "delete" : "action", action: `vm.disposable.${action.data}`, label: `${labels[action.data]}: ${name}`, resourceType: "vm", resourceName: name, message: labels[action.data] });
      if (action.data === "convert") {
        // Flattening base + overlay copies the whole disk: tracked, not held open.
        void deps.runTrackedTask(task, actor.ip, async () => {
          const result = await callRunner("qemu_disposable_action", { name, action: "convert" }, LONG_TIMEOUT_MS);
          db.prepare("UPDATE qemu_vms SET tags = ?, description = CASE WHEN description LIKE 'Jetable · %' THEN NULL ELSE description END WHERE vm_name = ?").run("[]", name);
          return result;
        });
        return { status: 202, body: deps.publicTask(task) };
      }
      const result = await deps.runInstantTask(task, actor.ip, async () => {
        const out = await callRunner("qemu_disposable_action", { name, action: action.data }, 5 * 60_000);
        if (action.data === "discard") await deps.forgetVm(name);
        return out;
      });
      return { status: 200, body: result };
    },
  };
}
