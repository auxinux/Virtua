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

export interface DisposableRouteDeps {
  db: Database.Database;
  callRunner: <T = unknown>(action: string, params?: unknown, timeoutMs?: number, onProgress?: (p: RunnerProgress) => void) => Promise<T>;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => void;
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => void;
  requireResourcePermission: (req: FastifyRequest, type: "vm", name: string, permission: "view" | "power" | "modify" | "delete") => void;
  checkVmCreateAllowed: (req: FastifyRequest) => { ok: boolean; reason?: string };
  checkPermission: (req: FastifyRequest, action: "allow_vm_delete" | "allow_vm_modify") => { ok: boolean; reason?: string };
  replyQuotaError: (reply: FastifyReply, result: { ok: boolean; reason?: string }) => unknown;
  getClientIp: (req: FastifyRequest) => string;
  /** Pool name → path, only when the pool may hold VM disks. */
  resolveVmDiskPool: (name: string) => { path: string } | undefined;
  /** Whether the VM is hosted by this node (disposables are local-only). */
  isLocalVm: (name: string) => Promise<boolean>;
  localNodeName: () => string;
  /** Same cleanup as DELETE /api/vms/:name once the domain is gone. */
  forgetVm: (name: string) => Promise<void>;
  createTask: (req: FastifyRequest, options: { kind: "create" | "delete" | "action" | "url-download"; action: string; label: string; resourceType?: string; resourceName?: string; message?: string; detail?: string }) => Task;
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
  const { db, callRunner } = deps;

  app.get("/api/disposable/bases", async (req, reply) => {
    deps.requireAuth(req, reply);
    return callRunner<BaseInfo[]>("qemu_bases_list");
  });

  // Base from a stopped VM: a flattened copy of its disk (long: task-tracked).
  app.post("/api/disposable/bases", async (req, reply) => {
    deps.requireAdmin(req, reply);
    const parsed = CreateBaseSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: zodError(parsed.error.issues) });
    const { vmName, label, os, removeSource } = parsed.data;
    if (!(await deps.isLocalVm(vmName))) return reply.status(400).send({ error: "Bases are made from VMs of this node" });
    const ip = deps.getClientIp(req);
    const task = deps.createTask(req, { kind: "create", action: "disposable.base.create", label: `Make a disposable base from ${vmName}`, resourceType: "vm", resourceName: vmName, message: "Copying the system disk" });
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
    const ip = deps.getClientIp(req);
    const task = deps.createTask(req, { kind: "delete", action: "disposable.base.delete", label: `Delete disposable base ${id}`, message: id });
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
    const ip = deps.getClientIp(req);
    const task = deps.createTask(req, { kind: "url-download", action: "disposable.base.import", label: `Import disposable base ${item.name}`, message: "Downloading from depot", detail: item.name });
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
    const parsed = LaunchDisposableSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: zodError(parsed.error.issues) });
    const allowed = deps.checkVmCreateAllowed(req);
    if (!allowed.ok) return deps.replyQuotaError(reply, allowed);
    const pool = deps.resolveVmDiskPool(parsed.data.storagePool);
    if (!pool) return reply.status(400).send({ error: "Storage pool not found or not allowed to hold VM disks" });
    const ip = deps.getClientIp(req);
    const task = deps.createTask(req, { kind: "create", action: "vm.disposable.launch", label: `Launch disposable VM from ${parsed.data.baseId}`, resourceType: "vm", resourceName: parsed.data.name, message: parsed.data.strict ? "Strict sandbox" : "Disposable VM" });
    return deps.runInstantTask(task, ip, async () => {
      const result = await callRunner<{ ok: boolean; name: string; baseId: string }>("qemu_disposable_launch", { ...parsed.data, storagePool: pool.path }, 5 * 60_000);
      db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, tags = excluded.tags, node_name = excluded.node_name")
        .run(result.name, req.session.userId!, `Jetable · ${parsed.data.baseId}`, JSON.stringify(["jetable"]), deps.localNodeName());
      return result;
    });
  });

  // What to do with a stopped disposable VM: discard / reset / keep / convert.
  app.post("/api/vms/:name/disposable/:action", async (req, reply) => {
    deps.requireAuth(req, reply);
    const { name, action: rawAction } = req.params as { name: string; action: string };
    const action = DisposableActionSchema.safeParse(rawAction);
    if (!action.success) return reply.status(400).send({ error: `Invalid action. Allowed: ${DisposableActionSchema.options.join(", ")}` });
    if (action.data === "discard") {
      deps.requireResourcePermission(req, "vm", name, "delete");
      const perm = deps.checkPermission(req, "allow_vm_delete");
      if (!perm.ok) return deps.replyQuotaError(reply, perm);
    } else if (action.data === "keep") {
      deps.requireResourcePermission(req, "vm", name, "view");
    } else {
      deps.requireResourcePermission(req, "vm", name, "modify");
      const perm = deps.checkPermission(req, "allow_vm_modify");
      if (!perm.ok) return deps.replyQuotaError(reply, perm);
    }
    if (!(await deps.isLocalVm(name))) return reply.status(400).send({ error: "Disposable VMs are managed on their own node" });
    const ip = deps.getClientIp(req);
    const labels = { discard: "Discard", reset: "Reset from base", keep: "Keep", convert: "Convert to an ordinary VM" } as const;
    const task = deps.createTask(req, { kind: action.data === "discard" ? "delete" : "action", action: `vm.disposable.${action.data}`, label: `${labels[action.data]}: ${name}`, resourceType: "vm", resourceName: name, message: labels[action.data] });
    if (action.data === "convert") {
      // Flattening base + overlay copies the whole disk: tracked, not held open.
      void deps.runTrackedTask(task, ip, async () => {
        const result = await callRunner("qemu_disposable_action", { name, action: "convert" }, LONG_TIMEOUT_MS);
        db.prepare("UPDATE qemu_vms SET tags = ?, description = CASE WHEN description LIKE 'Jetable · %' THEN NULL ELSE description END WHERE vm_name = ?").run("[]", name);
        return result;
      });
      return reply.status(202).send(deps.publicTask(task));
    }
    return deps.runInstantTask(task, ip, async () => {
      const result = await callRunner("qemu_disposable_action", { name, action: action.data }, 5 * 60_000);
      if (action.data === "discard") await deps.forgetVm(name);
      return result;
    });
  });
}
