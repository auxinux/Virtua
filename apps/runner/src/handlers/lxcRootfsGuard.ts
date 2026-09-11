import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import type { LxcRootfsAuditEntry, LxcRootfsAuditReport, LxcRootfsIssue, LxcRootfsIssueCode } from "@auxinux/shared";

const execFileAsync = promisify(execFile);

/**
 * LXC rootfs protection for host-side permission changes.
 *
 * A storage pool can hold container root filesystems: createContainer moves a
 * pool-backed rootfs to <pool>/<name>/rootfs. A rootfs is the guest's "/", so
 * its owners and modes belong to the container. Up to 0.8.2 the installer
 * normalised pool permissions with a recursive walk that went through every
 * rootfs — guests ended up with /etc/sudoers.d owned by libvirt-qemu.
 *
 * Every chown/chmod the runner performs on storage paths goes through
 * assertOutsideLxcRootfs(). INSTALL/storage-permissions.sh applies the same
 * rules to the installer.
 */

function defaultLxcDir(): string {
  return process.env.LXC_DIR ?? "/var/lib/lxc";
}

/** `rootfs` itself, or a copy kept beside it (`rootfs.rollback-<ts>`). */
export function isRootfsName(name: string): boolean {
  return name === "rootfs" || name.startsWith("rootfs.");
}

/**
 * Host directories named by an `lxc.rootfs.path` value. `dir:/x`, `/x` and
 * `btrfs:/x` name one directory, `overlay:/lower:/upper` two; zfs:, lvm: and
 * rbd: specs are not host paths (LXC mounts them at <lxc dir>/<name>/rootfs).
 */
export function rootfsSpecHostPaths(spec: string): string[] {
  const value = spec.trim();
  const body = value.startsWith("/")
    ? value
    : /^[a-z][a-z0-9]*:\//i.test(value) ? value.slice(value.indexOf(":") + 1) : "";
  return body.split(":").filter((part) => part.startsWith("/")).map((part) => path.resolve(part));
}

export interface LxcRootfsLocation {
  container: string;
  paths: string[];
}

/** Every container declared on this host with the directories holding its rootfs. */
export async function listLxcRootfs(lxcDir = defaultLxcDir()): Promise<LxcRootfsLocation[]> {
  const entries = await fs.readdir(lxcDir, { withFileTypes: true }).catch(() => []);
  const result: LxcRootfsLocation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cfg = await fs.readFile(path.join(lxcDir, entry.name, "config"), "utf8").catch(() => null);
    if (cfg === null) continue;
    const specs = [...cfg.matchAll(/^\s*lxc\.rootfs\.path\s*=\s*(.+)$/gm)];
    const declared = specs.length > 0 ? rootfsSpecHostPaths(specs[specs.length - 1][1]) : [];
    result.push({ container: entry.name, paths: [...new Set([path.join(lxcDir, entry.name, "rootfs"), ...declared])] });
  }
  return result;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where chown/chmod would really land: realpath of the deepest existing ancestor plus the rest. */
async function physicalPath(target: string): Promise<string> {
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false);
}

/**
 * A directory holding a Linux root filesystem: etc/ plus usr/, bin/ or sbin/.
 * Catches a rootfs that is neither named "rootfs" nor declared on this host,
 * e.g. a container of another node sharing the pool.
 */
export async function looksLikeLinuxRoot(dir: string): Promise<boolean> {
  if (!(await exists(path.join(dir, "etc")))) return false;
  for (const name of ["usr", "bin", "sbin"]) {
    if (await exists(path.join(dir, name))) return true;
  }
  return false;
}

export interface LxcRootfsGuardOptions {
  lxcDir?: string;
  /** Explicit opt-in for an LXC operation that must change this container's own rootfs. */
  allowRootfsOf?: string;
}

/**
 * Why `target` lies in LXC territory, or null. The physical path and each of
 * its ancestors (except "/") are checked against the declared rootfs of every
 * container, the rootfs naming convention and the shape of a Linux root.
 */
export async function lxcRootfsViolation(target: string, opts: LxcRootfsGuardOptions = {}): Promise<string | null> {
  const physical = await physicalPath(target);
  for (const { container, paths } of await listLxcRootfs(opts.lxcDir)) {
    for (const root of await Promise.all(paths.map(physicalPath))) {
      if (!isInside(root, physical)) continue;
      if (container === opts.allowRootfsOf) return null;
      return `inside the rootfs of LXC container ${container} (${root})`;
    }
  }
  for (let current = physical; current !== path.dirname(current); current = path.dirname(current)) {
    if (isRootfsName(path.basename(current))) return `inside an LXC rootfs (${current})`;
    if (await looksLikeLinuxRoot(current)) return `inside a Linux root filesystem (${current})`;
  }
  return null;
}

export class LxcRootfsGuardError extends Error {}

/** Gate for every host-side chown/chmod on a storage path. */
export async function assertOutsideLxcRootfs(target: string, operation: string, opts: LxcRootfsGuardOptions = {}): Promise<void> {
  const violation = await lxcRootfsViolation(target, opts);
  if (violation) {
    throw new LxcRootfsGuardError(
      `Refusing ${operation} on ${target}: ${violation}. Virtua never changes permissions inside a container filesystem.`,
    );
  }
}

/** Host directories whose owner and mode Virtua must never rewrite (e.g. /dev when a block device is attached). */
const PROTECTED_HOST_DIRS = new Set([
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/media", "/mnt", "/opt",
  "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/usr/bin", "/usr/lib", "/usr/lib64",
  "/usr/local", "/usr/sbin", "/var", "/var/cache", "/var/lib", "/var/log", "/var/tmp",
]);

export function isProtectedHostDir(target: string): boolean {
  return PROTECTED_HOST_DIRS.has(path.resolve(target));
}

// ── Detection of containers damaged by Virtua <= 0.8.2 ─────────────────────

/** Directories whose group and mode the old installer rewrote. */
const AUDITED_DIRS = ["", "etc", "etc/sudoers.d", "usr", "usr/bin", "var", "var/lib", "var/log", "var/tmp", "root", "home", "tmp"];
const STICKY_DIRS = ["tmp", "var/tmp"];
const SETUID_BINARIES = ["usr/bin/sudo", "usr/bin/su", "usr/bin/passwd", "bin/su"];

/**
 * Traces the recursive permission changes of Virtua <= 0.8.2 leave in a rootfs.
 * Detection only: the original owners and modes are gone, so nothing here
 * repairs. lstat throughout — rootfs content is container-controlled.
 * Keep in sync with virtua_rootfs_damage_signs in INSTALL/storage-permissions.sh.
 */
export async function auditRootfsPermissions(rootfs: string, qemuGid: number | null): Promise<LxcRootfsIssue[]> {
  const issues: LxcRootfsIssue[] = [];
  const inspect = (rel: string) => fs.lstat(path.join(rootfs, rel)).catch(() => null);
  const report = (code: LxcRootfsIssueCode, rel: string, mode: number, gid?: number) => {
    issues.push({ code, path: `/${rel}`, mode: (mode & 0o7777).toString(8), ...(gid !== undefined ? { gid } : {}) });
  };

  for (const rel of AUDITED_DIRS) {
    const st = await inspect(rel);
    if (!st?.isDirectory()) continue;
    if (qemuGid !== null && st.gid === qemuGid) report("qemu-group", rel, st.mode, st.gid);
    if ((st.mode & 0o7777) === 0o2775) report("setgid-2775", rel, st.mode);
  }
  for (const rel of STICKY_DIRS) {
    const st = await inspect(rel);
    if (st?.isDirectory() && (st.mode & 0o1000) === 0) report("sticky-missing", rel, st.mode);
  }
  const shadow = await inspect("etc/shadow");
  if (shadow?.isFile() && (shadow.mode & 0o004) !== 0) report("shadow-readable", "etc/shadow", shadow.mode);
  for (const rel of SETUID_BINARIES) {
    const st = await inspect(rel);
    if (st?.isFile() && st.uid === 0 && (st.mode & 0o4000) === 0) report("setuid-missing", rel, st.mode);
  }
  return issues;
}

async function lookupQemuGroup(): Promise<{ name: string; gid: number } | null> {
  for (const name of ["libvirt-qemu", "qemu"]) {
    try {
      const { stdout } = await execFileAsync("getent", ["group", name]);
      const gid = parseInt(stdout.trim().split(":")[2] ?? "", 10);
      if (Number.isInteger(gid)) return { name, gid };
    } catch {
      /* try next common libvirt group */
    }
  }
  return null;
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

export interface LxcRootfsAuditOptions {
  lxcDir?: string;
  /** Virtua manual snapshots: <dir>/<container>/<snapshot>/{rootfs,container/rootfs}. */
  snapshotDir?: string;
  /** Local pools scanned for <pool>/<name>/rootfs not declared on this host. */
  poolPaths?: string[];
  /** Test hook; looked up with getent otherwise. */
  qemu?: { name: string; gid: number } | null;
}

export async function auditLxcRootfsPermissions(opts: LxcRootfsAuditOptions = {}): Promise<LxcRootfsAuditReport> {
  const qemu = opts.qemu !== undefined ? opts.qemu : await lookupQemuGroup();
  const targets: Array<Omit<LxcRootfsAuditEntry, "issues">> = [];
  const seen = new Set<string>();
  const add = async (candidate: string, entry: Omit<LxcRootfsAuditEntry, "issues" | "rootfsPath">) => {
    const rootfsPath = await physicalPath(candidate);
    if (seen.has(rootfsPath)) return;
    const st = await fs.lstat(rootfsPath).catch(() => null);
    if (!st?.isDirectory()) return;
    seen.add(rootfsPath);
    targets.push({ ...entry, rootfsPath });
  };

  for (const { container, paths } of await listLxcRootfs(opts.lxcDir)) {
    for (const candidate of paths) await add(candidate, { container });
  }
  for (const pool of opts.poolPaths ?? []) {
    for (const dir of await subdirectories(pool)) {
      await add(path.join(dir, "rootfs"), { container: path.basename(dir), unregistered: true });
    }
  }
  if (opts.snapshotDir) {
    for (const containerDir of await subdirectories(opts.snapshotDir)) {
      for (const snapshotDir of await subdirectories(containerDir)) {
        const entry = { container: path.basename(containerDir), snapshot: path.basename(snapshotDir) };
        await add(path.join(snapshotDir, "rootfs"), entry);
        await add(path.join(snapshotDir, "container", "rootfs"), entry);
      }
    }
  }

  const affected: LxcRootfsAuditEntry[] = [];
  for (const target of targets) {
    const issues = await auditRootfsPermissions(target.rootfsPath, qemu?.gid ?? null);
    if (issues.length > 0) affected.push({ ...target, issues });
  }
  return {
    checkedAt: new Date().toISOString(),
    qemuGroup: qemu?.name ?? null,
    qemuGid: qemu?.gid ?? null,
    checked: targets.length,
    affected,
  };
}
