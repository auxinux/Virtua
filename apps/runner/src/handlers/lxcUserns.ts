/**
 * Unprivileged LXC containers (0.8.13+).
 *
 * Every container runs in a user namespace: container uid/gid 0..65535 map to
 * host ids BASE..BASE+65535, where BASE is root's subordinate range in
 * /etc/subuid and /etc/subgid. Container root is then an ordinary,
 * unprivileged uid on the host.
 *
 * On disk the rootfs is owned by the shifted ids. Converting a privileged
 * rootfs (an older Virtua container, a Proxmox/PBS restore, a local backup of a
 * privileged container) means shifting every file's owner by BASE. The shift
 * runs in place.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";

const execFileAsync = promisify(execFile);

export const IDMAP_SIZE = 65536;
const DEFAULT_BASE = 100000;
const SUBUID_FILE = process.env.LXC_SUBUID_FILE ?? "/etc/subuid";
const SUBGID_FILE = process.env.LXC_SUBGID_FILE ?? "/etc/subgid";

export interface SubIdRange {
  owner: string;
  start: number;
  count: number;
}

export function parseSubIdFile(text: string): SubIdRange[] {
  const ranges: SubIdRange[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([^:#\s]+):(\d+):(\d+)\s*$/.exec(line);
    if (m) ranges.push({ owner: m[1], start: Number(m[2]), count: Number(m[3]) });
  }
  return ranges;
}

/**
 * Pick root's id range. Reuse root's range when both files already give it the
 * same start with at least 65536 ids; otherwise allocate the first 65536-id block
 * (>= 100000) that does not overlap any other user's range, so no host
 * user can create a namespace that reaches container files.
 */
export function planRootSubIds(subuid: string, subgid: string): { base: number; append: boolean } {
  const uids = parseSubIdFile(subuid);
  const gids = parseSubIdFile(subgid);
  const rootU = uids.find((r) => r.owner === "root" || r.owner === "0");
  const rootG = gids.find((r) => r.owner === "root" || r.owner === "0");
  if (rootU && rootG && rootU.start === rootG.start && rootU.count >= IDMAP_SIZE && rootG.count >= IDMAP_SIZE) {
    return { base: rootU.start, append: false };
  }
  const taken = [...uids, ...gids].filter((r) => r.owner !== "root" && r.owner !== "0");
  let base = DEFAULT_BASE;
  for (;;) {
    const end = base + IDMAP_SIZE;
    const clash = taken.find((r) => r.start < end && base < r.start + r.count);
    if (!clash) return { base, append: true };
    base = clash.start + clash.count;
  }
}

let cachedBase: number | undefined;

/** root's id base, writing /etc/subuid + /etc/subgid entries when missing. */
export async function ensureRootSubIds(): Promise<number> {
  if (cachedBase !== undefined) return cachedBase;
  const subuid = await fs.readFile(SUBUID_FILE, "utf8").catch(() => "");
  const subgid = await fs.readFile(SUBGID_FILE, "utf8").catch(() => "");
  const plan = planRootSubIds(subuid, subgid);
  if (plan.append) {
    const entry = `root:${plan.base}:${IDMAP_SIZE}\n`;
    // Drop a partial/mismatched root line before writing ours.
    const strip = (text: string) => text.split("\n").filter((l) => !/^\s*(root|0):/.test(l)).join("\n").replace(/\n*$/, "\n").replace(/^\n$/, "");
    await fs.writeFile(SUBUID_FILE, strip(subuid) + entry);
    await fs.writeFile(SUBGID_FILE, strip(subgid) + entry);
  }
  cachedBase = plan.base;
  return plan.base;
}

export interface Idmap {
  uidBase: number;
  gidBase: number;
  size: number;
}

/** The mapping of container id 0, or null for a privileged container. */
export function parseIdmap(cfg: string): Idmap | null {
  let uidBase: number | undefined;
  let gidBase: number | undefined;
  let size = IDMAP_SIZE;
  for (const m of cfg.matchAll(/^\s*lxc\.(?:idmap|id_map)\s*=\s*([ugb])\s+(\d+)\s+(\d+)\s+(\d+)\s*$/gim)) {
    const [, kind, nsId, hostId, count] = m;
    if (Number(nsId) !== 0) continue;
    if (kind === "u" || kind === "b") uidBase = Number(hostId);
    if (kind === "g" || kind === "b") gidBase = Number(hostId);
    size = Math.min(size, Number(count));
  }
  if (uidBase === undefined || gidBase === undefined) return null;
  return { uidBase, gidBase, size };
}

/**
 * Rewrite a container config for an unprivileged run: one u/g idmap at `base`,
 * plus the userns include (distro flavour when the distro common include is
 * there). Other settings are kept.
 */
export function applyUnprivilegedConfig(cfg: string, base: number, usernsInclude: string): string {
  let out = cfg
    .replace(/^\s*lxc\.(?:idmap|id_map)\s*=.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const hasUserns = /^\s*lxc\.include\s*=\s*\S*userns\.conf\s*$/im.test(out);
  const lines: string[] = [];
  if (!hasUserns) lines.push(`lxc.include = ${usernsInclude}`);
  lines.push(`lxc.idmap = u 0 ${base} ${IDMAP_SIZE}`, `lxc.idmap = g 0 ${base} ${IDMAP_SIZE}`);
  return `${out}\n${lines.join("\n")}\n`;
}

/** userns.conf matching the distro common include of a config. */
export function usernsIncludeFor(cfg: string, configDir: string): string[] {
  const candidates: string[] = [];
  for (const m of cfg.matchAll(/^\s*lxc\.include\s*=\s*(\S+)\.common\.conf\s*$/gim)) {
    const distro = path.basename(m[1]);
    if (/^[a-z0-9-]+$/.test(distro)) candidates.push(path.join(configDir, `${distro}.userns.conf`));
  }
  candidates.push(path.join(configDir, "userns.conf"));
  return candidates;
}

export interface ShiftResult {
  entries: number;
  changed: number;
}

/**
 * Move every owner in [from, from+size) to [to, to+size), in place, without
 * crossing into other filesystems or following symlinks. Ids outside the source
 * range are left alone, so the shift is safe to re-run. chown clears the
 * setuid/setgid bits and the file capabilities: the mode is put back here and
 * capabilities are re-applied from inside the namespace by the caller.
 */
export async function shiftOwnership(root: string, from: { uid: number; gid: number }, to: { uid: number; gid: number }, size = IDMAP_SIZE): Promise<ShiftResult> {
  const result: ShiftResult = { entries: 0, changed: 0 };
  const rootStat = await fs.lstat(root);
  const mapId = (id: number, src: number, dst: number) => (id >= src && id < src + size ? id - src + dst : id);

  const visit = async (full: string, st: Awaited<ReturnType<typeof fs.lstat>>) => {
    result.entries += 1;
    const uid = mapId(Number(st.uid), from.uid, to.uid);
    const gid = mapId(Number(st.gid), from.gid, to.gid);
    if (uid !== Number(st.uid) || gid !== Number(st.gid)) {
      await fs.lchown(full, uid, gid);
      result.changed += 1;
      if (!st.isSymbolicLink() && (Number(st.mode) & 0o6000)) {
        await fs.chmod(full, Number(st.mode) & 0o7777);
      }
    }
  };

  await visit(root, rootStat);
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.pop()!;
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (let i = 0; i < names.length; i += 64) {
      await Promise.all(names.slice(i, i + 64).map(async (n) => {
        const full = path.join(dir, n);
        const st = await fs.lstat(full).catch(() => null);
        if (!st) return;
        if (st.dev !== rootStat.dev) return; // a mount point: not part of this rootfs
        await visit(full, st);
        if (st.isDirectory()) queue.push(full);
      }));
    }
  }
  return result;
}

/** `getcap -r` output → [{path, caps}] (best effort; empty without getcap). */
export async function listFileCaps(root: string): Promise<Array<{ file: string; caps: string }>> {
  const { stdout } = await execFileAsync("getcap", ["-r", root], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 })
    .catch((error: { stdout?: string }) => ({ stdout: error?.stdout ?? "" }));
  return parseGetcap(stdout);
}

export function parseGetcap(text: string): Array<{ file: string; caps: string }> {
  const out: Array<{ file: string; caps: string }> = [];
  for (const line of text.split("\n")) {
    // libcap 2.4x: "/path cap_net_raw=ep"; older: "/path = cap_net_raw+ep"
    const m = /^(\/\S.*?)\s+(?:=\s+)?(cap_\S+)\s*$/.exec(line.trim());
    if (m) out.push({ file: m[1], caps: m[2] });
  }
  return out;
}

/**
 * Re-apply file capabilities from inside the container's namespace, so the
 * kernel writes namespaced (v3) capabilities owned by container root.
 */
export async function restoreFileCaps(caps: Array<{ file: string; caps: string }>, base: number): Promise<number> {
  let restored = 0;
  for (const { file, caps: value } of caps) {
    try {
      await execFileAsync("lxc-usernsexec", ["-m", `b:0:${base}:${IDMAP_SIZE}`, "--", "setcap", value, file], { timeout: 30_000 });
      restored += 1;
    } catch {
      /* best effort: a missing capability only affects that one binary */
    }
  }
  return restored;
}

/** Command prefix to run a host tool as the container's root. */
export function usernsExecPrefix(idmap: Idmap): string[] {
  return [
    "lxc-usernsexec",
    "-m", `u:0:${idmap.uidBase}:${idmap.size}`,
    "-m", `g:0:${idmap.gidBase}:${idmap.size}`,
    "--",
  ];
}
