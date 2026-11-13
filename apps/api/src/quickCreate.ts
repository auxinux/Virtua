/**
 * Quick create (unattended Windows 11 / Debian 13) — API side. Downloads and
 * checks the install media, then hands the runner local file paths only:
 *
 * - Debian 13: the trixie netboot `linux` + `initrd.gz`, each verified
 *   against Debian's SHA256SUMS (re-downloaded only on a new point release).
 * - Windows 11: an ISO already in the library (> 3 GB, "Windows11*"/"Win11*"),
 *   else the largest one on the AuxiNux depot `TEMPLATES/ISO/AMD64/` (size from
 *   the Content-Length *header* of a HEAD), plus the virtio-win driver disc.
 *
 * Local node only, like /api/resources. The runner's autoinstall tick (called
 * periodically from server.ts) finishes the installs.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import {
  QUICK_CREATE_PROFILES,
  QuickCreateSchema,
  debianArch,
  debianNetbootUrls,
  isWindows11Iso,
  sha256For,
  windowsLanguage,
  type QuickCreateOs,
} from "@auxinux/shared";
import { ApiError, sendServiceResult, type ApiActor, type ServiceResult } from "./disposable.js";

type Task = { id: string };

export interface QuickCreateDeps {
  db: Database.Database;
  callRunner: <T = unknown>(action: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => void;
  /** The web session's actor (called after requireAuth). */
  actorOf: (req: FastifyRequest) => ApiActor;
  /** VM quota + `allow_vm_create`. */
  checkVmCreateAllowed: (actor: ApiActor) => { ok: boolean; reason?: string };
  resolveVmDiskPool: (name: string) => { path: string } | undefined;
  localNodeName: () => string;
  createTask: (actor: ApiActor, options: { kind: "create"; action: string; label: string; resourceType?: string; resourceName?: string; message?: string }) => Task;
  runTrackedTask: (task: Task, ip: string, fn: (helpers: { update: (patch: Record<string, unknown>) => void }) => Promise<unknown>) => Promise<void>;
  publicTask: (task: Task) => unknown;
  /** Library ISOs with their absolute path and size. */
  listLibraryIsos: () => Promise<Array<{ filename: string; path: string; sizeBytes: number }>>;
  /** Download an ISO into the library (registered) and return its path. */
  downloadIso: (taskId: string, url: string, filename: string, displayName: string) => Promise<string>;
  /** virtio-win.iso from the library, downloaded first when missing. */
  ensureVirtioWin: (taskId: string) => Promise<string>;
  downloadToFile: (taskId: string, url: string, file: string) => Promise<void>;
  depotBase: () => string;
  /** API-writable directory for the Debian netboot files. */
  netbootDir: string;
  hostArch?: string;
}

const WINDOWS_ISO_MIN_BYTES = 3 * 1024 ** 3;

export function nodeQemuArch(processArch: string = process.arch): "x86_64" | "aarch64" {
  return processArch === "arm64" ? "aarch64" : "x86_64";
}

/**
 * A released Windows build (`…24h2…`, `…25H2…`) rather than an Insider one
 * (`…_26300_9457…`): Insider builds stop the unattended install at the
 * out-of-box "OOBEZDP" error (the zero-day-patch step fails).
 */
export function isReleaseWindowsIso(filename: string): boolean {
  return /(^|[^a-z0-9])\d{2}h\d([^0-9]|$)/i.test(filename);
}

/** Release before Insider, then the largest. */
export function compareWindowsIsos(a: { filename: string; sizeBytes: number }, b: { filename: string; sizeBytes: number }) {
  return Number(isReleaseWindowsIso(b.filename)) - Number(isReleaseWindowsIso(a.filename)) || b.sizeBytes - a.sizeBytes;
}

/** Best local Windows 11 ISO big enough to be a real installer (a release first). */
export function pickLibraryWindowsIso<T extends { filename: string; sizeBytes: number }>(isos: T[], arm: boolean): T | undefined {
  return isos
    .filter((iso) => {
      const lower = iso.filename.toLowerCase();
      const windows11 = lower.endsWith(".iso") && (isWindows11Iso(lower) || (lower.includes("win") && lower.includes("11")));
      return windows11 && lower.includes("arm") === arm && iso.sizeBytes > WINDOWS_ISO_MIN_BYTES;
    })
    .sort(compareWindowsIsos)[0];
}

/** Windows 11 ISO names of a depot autoindex page. */
export function parseWindowsIsoListing(html: string): string[] {
  const names = new Set<string>();
  for (const match of html.matchAll(/href="([^"?#]+)"/g)) {
    let name: string;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (!name.includes("/") && isWindows11Iso(name) && /^[A-Za-z0-9][A-Za-z0-9._ ()+-]*$/.test(name)) names.add(name);
  }
  return [...names];
}

async function headContentLength(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    const size = parseInt(res.headers.get("content-length") ?? "", 10);
    return res.ok && Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Next free name: `wanted`, `wanted-2`, `wanted-3`… */
export function uniqueVmName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${wanted}-${i}`.slice(0, 63);
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("No free VM name");
}

export function registerQuickCreateRoutes(app: FastifyInstance, deps: QuickCreateDeps) {
  const service = createQuickCreateService(deps);
  app.post("/api/vms/quick-create", async (req, reply) => {
    deps.requireAuth(req, reply);
    return sendServiceResult(reply, () => service.quickCreate(deps.actorOf(req), req.body));
  });
}

export type QuickCreateService = ReturnType<typeof createQuickCreateService>;

/**
 * Quick create for any caller (web session, Virtua Desktop): validation,
 * quota/permission, then a tracked task (media download + runner create).
 * Answers 202 with the public task and the VM name actually used.
 */
export function createQuickCreateService(deps: Omit<QuickCreateDeps, "requireAuth" | "actorOf">) {
  const arch = nodeQemuArch(deps.hostArch);

  async function debianNetboot(taskId: string, update: (patch: Record<string, unknown>) => void) {
    const darch = debianArch(arch);
    const urls = debianNetbootUrls(darch);
    const sums = await fetchText(urls.sums).catch((error) => {
      throw new Error(`Debian file list unreachable: ${error instanceof Error ? error.message : error}`);
    });
    const dir = path.join(deps.netbootDir, `debian-13-${darch}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const out: Record<string, string> = {};
    for (const file of urls.files) {
      const expected = sha256For(sums, file.sumsPath);
      if (!expected) throw new Error(`${file.sumsPath} is missing from Debian's SHA256SUMS`);
      const target = path.join(dir, file.name);
      const current = await sha256File(target).catch(() => "");
      if (current !== expected) {
        update({ message: `Downloading Debian 13 installer (${file.name})` });
        const part = `${target}.part`;
        await deps.downloadToFile(taskId, file.url, part);
        if (await sha256File(part) !== expected) {
          await fs.promises.unlink(part).catch(() => {});
          throw new Error(`Checksum mismatch for ${file.sumsPath}`);
        }
        await fs.promises.rename(part, target);
      }
      out[file.name] = target;
    }
    return { kernelPath: out.linux, initrdPath: out["initrd.gz"] };
  }

  async function windowsIso(taskId: string, update: (patch: Record<string, unknown>) => void) {
    const local = pickLibraryWindowsIso(await deps.listLibraryIsos(), arch === "aarch64");
    // A released build in the library wins; an Insider one only if the depot
    // has no release either (it would stop at OOBEZDP).
    if (local && isReleaseWindowsIso(local.filename)) return local.path;
    update({ message: "Looking for a Windows 11 ISO on the AuxiNux depot" });
    const dirUrl = `${deps.depotBase().replace(/\/*$/, "/")}ISO/AMD64/`;
    let names: string[];
    try {
      names = parseWindowsIsoListing(await fetchText(dirUrl));
    } catch (error) {
      if (local) return local.path;
      throw new Error(`AuxiNux depot unreachable: ${error instanceof Error ? error.message : error}`);
    }
    const sized = await Promise.all(names.map(async (name) => ({ filename: name, sizeBytes: await headContentLength(`${dirUrl}${encodeURIComponent(name)}`) ?? 0 })));
    const best = sized.filter((entry) => entry.sizeBytes > WINDOWS_ISO_MIN_BYTES).sort(compareWindowsIsos)[0];
    if (local && (!best || !isReleaseWindowsIso(best.filename))) return local.path;
    if (!best) throw new Error(`No Windows 11 ISO (over 3 GB) on the AuxiNux depot (${dirUrl}) nor in the ISO library`);
    update({ message: `Downloading ${best.filename}` });
    return deps.downloadIso(taskId, `${dirUrl}${encodeURIComponent(best.filename)}`, best.filename, best.filename);
  }

  async function quickCreate(actor: ApiActor, body: unknown): Promise<ServiceResult<Record<string, unknown> & { id: string; name: string }>> {
    const parsed = QuickCreateSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const allowed = deps.checkVmCreateAllowed(actor);
    if (!allowed.ok) throw new ApiError(403, allowed.reason ?? "Forbidden");
    const input = parsed.data;
    const os: QuickCreateOs = input.os;
    if (os === "windows11" && arch !== "x86_64") throw new ApiError(400, "Windows 11 quick create needs an x86-64 node");
    const pool = deps.resolveVmDiskPool(input.storagePool);
    if (!pool) throw new ApiError(400, "Storage pool not found or not allowed to hold VM disks");
    const profile = QUICK_CREATE_PROFILES[os];
    const existing = new Set((await deps.callRunner<Array<{ name: string }>>("qemu_vms").catch(() => [])).map((vm) => vm.name));
    const wanted = input.name ?? (input.makeBase ? `base-${os}` : os === "windows11" ? "windows-11" : "debian-13");
    if (input.name && existing.has(input.name)) throw new ApiError(409, `VM ${input.name} already exists`);
    const name = uniqueVmName(wanted, existing);
    const ip = actor.ip;
    const userId = actor.userId;
    const task = deps.createTask(actor, {
      kind: "create",
      action: "vm.quick-create",
      label: `Quick create ${profile.label}${input.makeBase ? " (disposable base)" : ""}: ${name}`,
      resourceType: "vm",
      resourceName: name,
      message: "Preparing install media",
    });
    void deps.runTrackedTask(task, ip, async ({ update }) => {
      let media: Record<string, unknown>;
      if (os === "debian13") {
        media = await debianNetboot(task.id, update);
      } else {
        const isoPath = await windowsIso(task.id, update);
        update({ message: "Preparing the VirtIO driver disc" });
        const driverIsoPath = await deps.ensureVirtioWin(task.id);
        media = { isoPath, driverIsoPath, language: windowsLanguage(path.basename(isoPath)) };
      }
      update({ message: `Creating ${name}: ${profile.vcpus} vCPU, ${profile.memoryMb} MiB, ${profile.diskGb} GiB`, progressPercent: 97 });
      const result = await deps.callRunner("qemu_quick_create", {
        os,
        name,
        storagePool: pool.path,
        bridge: input.bridge,
        makeBase: input.makeBase,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...media,
      }, 10 * 60_000);
      deps.db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, tags = excluded.tags, node_name = excluded.node_name")
        .run(name, userId, `Création rapide · ${profile.label} (virtua / virtua)`, JSON.stringify(input.makeBase ? ["quick-create", "base-builder"] : ["quick-create"]), deps.localNodeName());
      update({ message: "Unattended installation running (account virtua / virtua)" });
      return result;
    });
    return { status: 202, body: { ...(deps.publicTask(task) as object), id: task.id, name } };
  }

  return { quickCreate, arch };
}
