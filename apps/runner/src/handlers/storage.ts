import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { probePoolAlive } from "./storageLiveness";

const execFileAsync = promisify(execFile);

let libvirtQemuGroup: Promise<number | null> | null = null;

async function getLibvirtQemuGroup(): Promise<number | null> {
  if (!libvirtQemuGroup) {
    libvirtQemuGroup = (async () => {
      for (const group of ["libvirt-qemu", "qemu"]) {
        try {
          const { stdout } = await execFileAsync("getent", ["group", group]);
          const gid = parseInt(stdout.trim().split(":")[2] ?? "", 10);
          if (Number.isInteger(gid)) return gid;
        } catch {
          /* try next common libvirt group */
        }
      }
      return null;
    })();
  }
  return libvirtQemuGroup;
}

/** execFile bounded by a wall-clock timeout. A FUSE mount whose connection is
 * stuck (daemon gone, kernel connection not aborted yet) can hang otherwise
 * innocuous commands — `umount`, `fusermount`, `df`, `findmnt`, even reading
 * /proc/self/mountinfo — indefinitely, which would pin the privileged runner
 * until the API's 120s call timeout. */
function execWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(cmd, args, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

/** True when a syscall failed because the FUSE transport is gone. */
function isNotConnectedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTCONN" || code === "ESTALE" || code === "EIO" || code === "EHOSTDOWN";
}

/** Release any stale FUSE mountpoint before touching the path. Every
 * filesystem operation — even `mkdir` — on a dead FUSE mountpoint fails with
 * ENOTCONN ("socket is not connected"), and hangs forever when the kernel
 * FUSE connection has not been aborted yet. A lazy unmount (-uz) releases the
 * mountpoint and aborts the connection in both cases, which is what makes a
 * reconciliation remount possible after the rclone daemon died. */
async function clearStaleFuseMount(poolPath: string): Promise<void> {
  for (const cmd of ["fusermount3", "fusermount"]) {
    await execWithTimeout(cmd, ["-uz", poolPath], 10_000).catch(() => {});
  }
}

/** Kill any rclone daemon still running for this pool's config. A previous
 * daemon that half-died (endpoint down, stuck reconnecting) can hold the FUSE
 * connection open and make the new `rclone mount` hang; SIGTERM it before
 * remounting so the fresh daemon owns the mountpoint cleanly. */
async function killStaleRcloneDaemon(remoteName: string): Promise<void> {
  await execWithTimeout("pkill", ["-f", `rclone.*${remoteName}`], 5_000).catch(() => {});
  // Give the daemon a moment to tear down its FUSE connection.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** Race a promise against a wall-clock timeout. Raw fs syscalls (mkdir/stat)
 * on a wedged FUSE connection block in uninterruptible sleep and can't be
 * killed the way execFile children can — this bounds them so the runner never
 * hits the API's 120s timeout while the kernel syscall stays stuck. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Launch a daemon detached from the runner and DON'T wait for it. `rclone
 * mount --daemon` does not return until the initial FUSE handshake (which does
 * a network listing) completes; waiting on it and then killing the parent on a
 * timeout leaves a half-mounted daemon (df shows the mount, but the runner
 * already reported failure, so the pool is never registered). Detach + unref
 * so the daemon outlives the runner call, then poll the mountpoint instead. */
function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

/** True once the path is a real, readable mountpoint (findmnt + readdir). */
async function isMountpointReadable(mountPath: string): Promise<boolean> {
  try {
    await execWithTimeout("findmnt", ["-n", "-o", "TARGET", mountPath], 5_000);
  } catch {
    return false;
  }
  try {
    await withTimeout(fs.readdir(mountPath), 3_000, `readdir ${mountPath}`);
    return true;
  } catch {
    return false;
  }
}

/** Serialize mount/umount operations per mountpoint. The 60s reconciliation
 * and a manual mount/unmount can overlap on the same path; without a lock the
 * second caller lazily unmounts what the first just mounted (or vice versa),
 * which manifests as endless mount-fail loops in the logs. */
const poolOpLocks = new Map<string, Promise<unknown>>();
async function withPoolOpLock<T>(poolPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(poolPath);
  const previous = poolOpLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tracked = next.catch(() => {});
  poolOpLocks.set(key, tracked);
  tracked.finally(() => {
    if (poolOpLocks.get(key) === tracked) poolOpLocks.delete(key);
  });
  return next;
}

async function ensureLibvirtPoolAccess(poolPath: string): Promise<void> {
  // Bound the mkdir: on a wedged FUSE connection the syscall can block in
  // uninterruptible sleep and pin the runner for the full 120s API timeout.
  await withTimeout(fs.mkdir(poolPath, { recursive: true }), 15_000, `mkdir ${poolPath}`);
  const dataDir = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinuxvirtual";
  if (poolPath === dataDir || poolPath.startsWith(`${dataDir}${path.sep}`)) {
    await fs.chmod(dataDir, 0o711).catch(() => {});
    await fs.chmod(path.join(dataDir, "pools"), 0o755).catch(() => {});
  }
  const gid = await getLibvirtQemuGroup();
  if (gid !== null) {
    await fs.chown(poolPath, 0, gid).catch(() => {});
    await fs.chmod(poolPath, 0o2775).catch(() => {});
  } else {
    await fs.chmod(poolPath, 0o755).catch(() => {});
  }
}

// `rclone mount --allow-other` (and any FUSE mount with allow_other) requires
// `user_allow_other` in /etc/fuse.conf. Without it the daemon dies right after
// mounting. The runner runs as root, so it can guarantee this on the fly.
async function ensureFuseAllowOther(): Promise<void> {
  const fuseConf = "/etc/fuse.conf";
  try {
    const existing = await fs.readFile(fuseConf, "utf8").catch(() => "");
    const lines = existing.split("\n").map((l) => l.trim());
    if (lines.some((l) => l === "user_allow_other")) return;
    const filtered = lines.filter((l) => l && !l.startsWith("#") && l !== "user_allow_other");
    filtered.push("user_allow_other");
    await fs.writeFile(fuseConf, `${filtered.join("\n")}\n`, { mode: 0o644 });
  } catch {
    // Non-fatal: if we can't write fuse.conf, rclone will surface the error.
  }
}

const ALLOWED_FSTAB_MOUNT_TYPES = new Set([
  "ext4", "xfs", "btrfs", "ext3", "ext2", "f2fs",
  "nfs", "nfs4", "cifs", "smbfs", "glusterfs",
  "bind", "auto",
]);

const ALLOWED_FS_FORMATS = new Set(["ext4", "xfs", "btrfs"]);

function assertNoFstabMetachars(value: string, field: string): string {
  if (/[\t\n\r\0]/.test(value)) {
    throw new Error(`Invalid ${field}: control characters (tab/newline/null) are not allowed`);
  }
  // Prevent line-based injection via multi-space tricks is less critical, but keep backslashes out (mount escapes).
  if (/\\/.test(value)) {
    throw new Error(`Invalid ${field}: backslashes are not allowed`);
  }
  return value;
}

function validateDevicePath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  // Must be an absolute path under /dev/ with a safe name — no whitespace, no shell metas, no traversal
  if (!/^\/dev\/[a-zA-Z0-9._\/-]{1,128}$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: must be an absolute path under /dev/ with safe characters only`);
  }
  if (trimmed.includes("..")) {
    throw new Error(`Invalid ${field}: path traversal is not allowed`);
  }
  return trimmed;
}

export function validateMountPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Invalid ${field}: must be an absolute path`);
  }
  if (trimmed.length > 512) {
    throw new Error(`Invalid ${field}: path too long`);
  }
  assertNoFstabMetachars(trimmed, field);
  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  // Reject obviously dangerous mount targets
  const forbidden = ["/", "/boot", "/etc", "/proc", "/sys", "/dev", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/root"];
  if (forbidden.includes(normalized)) {
    throw new Error(`Invalid ${field}: cannot mount over system directory ${normalized}`);
  }
  // …and anything *inside* the kernel-managed trees. A pool path of /dev/sda1
  // is a block device node, not a mountpoint: the previous check only matched
  // "/dev" exactly, so the path slipped through and failed much later with a
  // bare `EEXIST: mkdir /dev/sda1`, which says nothing useful.
  const forbiddenTrees = ["/dev", "/proc", "/sys", "/run"];
  const tree = forbiddenTrees.find((root) => normalized.startsWith(`${root}/`));
  if (tree) {
    const hint = tree === "/dev"
      ? ` — "${normalized}" is a block device, not a directory. Give a mountpoint (e.g. /mnt/${path.basename(normalized)}) and pass the device as the pool's source so Virtua mounts it there.`
      : "";
    throw new Error(`Invalid ${field}: ${tree} is managed by the kernel and cannot hold a storage pool${hint}`);
  }
  return normalized;
}

function validateMountSource(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) {
    throw new Error(`Invalid ${field}: empty or too long`);
  }
  assertNoFstabMetachars(trimmed, field);
  return trimmed;
}

function validateMountType(value: string): string {
  if (!ALLOWED_FSTAB_MOUNT_TYPES.has(value)) {
    throw new Error(`Invalid mount type: ${value}`);
  }
  return value;
}

function sanitizeMountOptions(value: string): string {
  assertNoFstabMetachars(value, "mountOptions");
  // Options may include quotes via credentials paths; disallow anyway to be safe.
  if (/["']/.test(value)) {
    throw new Error("Invalid mountOptions: quotes are not allowed");
  }
  if (value.length > 1024) {
    throw new Error("Invalid mountOptions: too long");
  }
  return value;
}

function validateSmbVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid smbVersion");
  // CIFS accepts 1.0, 2.0, 2.1, 3.0, 3.02, 3.11, or "default" / "3"
  if (!/^(?:default|1\.0|2\.0|2\.1|3|3\.0|3\.02|3\.11)$/.test(value)) {
    throw new Error("Invalid smbVersion: must be one of default, 1.0, 2.0, 2.1, 3, 3.0, 3.02, 3.11");
  }
  return value;
}

function validateNfsVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid nfsVersion");
  if (!/^(?:3|4|4\.0|4\.1|4\.2)$/.test(value)) {
    throw new Error("Invalid nfsVersion: must be one of 3, 4, 4.0, 4.1, 4.2");
  }
  return value;
}

export async function handleStorage(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case "storage_disks_list": return listDisks();
    case "storage_mounts_list": return listMounts();
    case "storage_disk_format": return formatDisk(p.device as string, p.fstype as string, p.label as string | undefined, p.force as boolean);
    case "storage_disk_wipe": return wipeDisk(p.device as string);
    case "storage_raid_list": return listRaid();
    case "storage_raid_create": return createRaid(p);
    case "storage_raid_detail": return getRaidDetail(p.device as string);
    case "storage_raid_stop": return stopRaid(p.device as string);
    case "storage_raid_add": return addRaidMember(p.device as string, p.member as string);
    case "storage_raid_remove": return removeRaidMember(p.device as string, p.member as string);
    case "storage_pool_df": return getPoolDf(p.path as string);
    case "storage_pool_alive": return isPoolAlive(p.path as string);
    case "storage_pool_mount": return mountPool(p);
    case "storage_pool_umount": return umountPool(p);
    default: throw new Error(`Unknown storage action: ${action}`);
  }
}

async function listMounts() {
  try {
    const { stdout } = await execFileAsync("findmnt", ["-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"]);
    const data = JSON.parse(stdout) as { filesystems?: Array<{ target: string; source?: string; fstype?: string; size?: string; used?: string; avail?: string }> };
    return (data.filesystems ?? [])
      .filter((fs) => fs.target && !fs.target.startsWith("/snap"))
      .map((fs) => ({
        mountpoint: fs.target,
        source: fs.source ?? "unknown",
        fstype: fs.fstype ?? "unknown",
        totalBytes: parseInt(fs.size ?? "0", 10) || 0,
        usedBytes: parseInt(fs.used ?? "0", 10) || 0,
        freeBytes: parseInt(fs.avail ?? "0", 10) || 0,
        isRoot: fs.target === "/",
      }))
      .sort((a, b) => {
        if (a.isRoot) return -1;
        if (b.isRoot) return 1;
        return a.mountpoint.localeCompare(b.mountpoint);
      });
  } catch {
    return [];
  }
}

async function listDisks() {
  const { stdout } = await execFileAsync("lsblk", ["--json", "-b", "-o", "NAME,SIZE,TYPE,MODEL,VENDOR,SERIAL,ROTA,MOUNTPOINT,FSTYPE,LABEL,UUID,PKNAME"]);
  const data = JSON.parse(stdout) as { blockdevices: LsblkDevice[] };

  const mdadmDevices = await getMdadmDevices();

  return data.blockdevices.filter((d) => d.type === "disk").map((disk) => {
    const partitions = (disk.children ?? []).map((p) => ({
      name: p.name,
      path: `/dev/${p.name}`,
      size: parseInt(p.size ?? "0"),
      fstype: (p.fstype ?? "unknown") as string,
      mountpoint: p.mountpoint ?? undefined,
      label: p.label ?? undefined,
      uuid: p.uuid ?? undefined,
    }));

    const inRaid = mdadmDevices.get(`/dev/${disk.name}`);
    const inUse = !!disk.mountpoint || partitions.some((p) => p.mountpoint) || !!inRaid;

    return {
      name: disk.name,
      path: `/dev/${disk.name}`,
      size: parseInt(disk.size ?? "0"),
      type: detectDiskType(disk),
      model: disk.model ?? "",
      vendor: disk.vendor ?? "",
      serial: disk.serial ?? undefined,
      rotational: disk.rota !== "0",
      partitions,
      inUse,
      inRaid: inRaid ?? undefined,
    };
  });
}

interface LsblkDevice {
  name: string;
  size?: string;
  type: string;
  model?: string;
  vendor?: string;
  serial?: string;
  rota?: string;
  mountpoint?: string;
  fstype?: string;
  label?: string;
  uuid?: string;
  pkname?: string;
  children?: LsblkDevice[];
}

function detectDiskType(disk: LsblkDevice): string {
  const name = disk.name.toLowerCase();
  if (name.startsWith("nvme")) return "nvme";
  if (disk.rota === "0") return "ssd";
  return "hdd";
}

async function getMdadmDevices(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync("mdadm", ["--detail", "--scan"]);
    const arrays = stdout.trim().split("\n").filter((l) => l.startsWith("ARRAY"));
    for (const arr of arrays) {
      const dev = arr.match(/ARRAY\s+(\S+)/)?.[1];
      if (!dev) continue;
      try {
        const { stdout: detail } = await execFileAsync("mdadm", ["--detail", dev]);
        const members = [...detail.matchAll(/\/dev\/[a-z]+[0-9]*/g)].map((m) => m[0]).filter((d) => d !== dev);
        for (const m of members) map.set(m, dev);
      } catch {}
    }
  } catch {}
  return map;
}

async function getMountedSources(): Promise<Map<string, string[]>> {
  const mounts = new Map<string, string[]>();
  try {
    const { stdout } = await execFileAsync("findmnt", ["-J", "-b", "-o", "SOURCE,TARGET"]);
    const data = JSON.parse(stdout) as { filesystems?: Array<{ source?: string; target?: string }> };
    for (const fsEntry of data.filesystems ?? []) {
      if (!fsEntry.source || !fsEntry.target) continue;
      const current = mounts.get(fsEntry.source) ?? [];
      current.push(fsEntry.target);
      mounts.set(fsEntry.source, current);
    }
  } catch {}
  return mounts;
}

async function resolveDeviceAliases(device: string): Promise<string[]> {
  const aliases = new Set<string>([device]);
  try {
    const { stdout } = await execFileAsync("readlink", ["-f", device]);
    const resolved = stdout.trim();
    if (resolved) aliases.add(resolved);
  } catch {}
  try {
    const { stdout } = await execFileAsync("realpath", [device]);
    const resolved = stdout.trim();
    if (resolved) aliases.add(resolved);
  } catch {}
  return [...aliases];
}

async function assertBlockDevice(device: string) {
  try {
    const { stdout } = await execFileAsync("lsblk", ["-dn", "-o", "TYPE", device]);
    const type = stdout.trim();
    if (!type || !["disk", "part", "raid0", "raid1", "raid5", "raid6", "raid10", "lvm", "crypt"].includes(type)) {
      throw new Error(`Refusing to operate on ${device}: not a block device (type=${type || "unknown"})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    throw new Error(`Cannot inspect ${device}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertDeviceNotMounted(device: string) {
  try {
    const { stdout } = await execFileAsync("findmnt", ["-n", "-S", device]);
    if (stdout.trim()) {
      throw new Error(`Refusing to operate on ${device}: currently mounted`);
    }
  } catch (error) {
    // findmnt returns non-zero if not mounted — good
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }
}

function validateFsLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,16}$/.test(label)) {
    throw new Error("Invalid label: 1-16 alphanumeric/dot/underscore/hyphen characters");
  }
  return label;
}

async function formatDisk(rawDevice: string, fstype: string, rawLabel?: string, force = false) {
  const device = validateDevicePath(rawDevice, "device");
  if (!ALLOWED_FS_FORMATS.has(fstype)) throw new Error(`Unsupported filesystem: ${fstype}`);
  const label = validateFsLabel(rawLabel);
  await assertBlockDevice(device);
  await assertDeviceNotMounted(device);

  const args: string[] = [];
  if (fstype === "ext4") {
    args.push("mkfs.ext4");
    if (force) args.push("-F");
    if (label) args.push("-L", label);
    args.push(device);
  } else if (fstype === "xfs") {
    args.push("mkfs.xfs");
    if (force) args.push("-f");
    if (label) args.push("-L", label);
    args.push(device);
  } else if (fstype === "btrfs") {
    args.push("mkfs.btrfs");
    if (force) args.push("-f");
    if (label) args.push("-L", label);
    args.push(device);
  }

  await execFileAsync(args[0], args.slice(1));
  return { ok: true };
}

async function wipeDisk(rawDevice: string) {
  const device = validateDevicePath(rawDevice, "device");
  await assertBlockDevice(device);
  await assertDeviceNotMounted(device);
  await execFileAsync("wipefs", ["-a", device]);
  await execFileAsync("dd", ["if=/dev/zero", `of=${device}`, "bs=1M", "count=10"]).catch(() => {});
  return { ok: true };
}

async function listRaid() {
  try {
    const { stdout } = await execFileAsync("mdadm", ["--detail", "--scan"]);
    const arrays = stdout.trim().split("\n").filter((l) => l.startsWith("ARRAY"));
    const result = [];
    for (const arr of arrays) {
      const dev = arr.match(/ARRAY\s+(\S+)/)?.[1];
      if (!dev) continue;
      try {
        result.push(await getRaidDetail(dev));
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

async function getRaidDetail(device: string) {
  const { stdout } = await execFileAsync("mdadm", ["--detail", device]);
  const lines = stdout.split("\n");
  const mountedSources = await getMountedSources();
  const aliases = await resolveDeviceAliases(device);

  const getField = (field: string) => {
    const m = stdout.match(new RegExp(`^\\s+${field}\\s*:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : null;
  };

  const levelStr = getField("Raid Level") ?? "1";
  const level = parseInt(levelStr.replace("raid", "")) as 0 | 1 | 5 | 10;
  const state = getField("State")?.toLowerCase() ?? "unknown";
  const sizeStr = getField("Array Size") ?? "0";
  const size = parseInt(sizeStr.split(" ")[0]) * 1024;

  const members: Array<{ device: string; role: string; errors: number }> = [];
  for (const line of lines) {
    const m = line.match(/^\s+\d+\s+\d+\s+\d+\s+\d+\s+(\w+)\s+(\/dev\/\S+)\s*/);
    if (m) members.push({ device: m[2], role: m[1].toLowerCase() as "active" | "spare" | "failed", errors: 0 });
  }

  const rebuildM = stdout.match(/Rebuild Status : (\d+)%/);
  const rebuildPercent = rebuildM ? parseInt(rebuildM[1]) : undefined;

  let raidState: "active" | "degraded" | "rebuilding" | "inactive" | "failed" = "active";
  if (state.includes("degraded")) raidState = "degraded";
  else if (state.includes("recovering") || state.includes("resync")) raidState = "rebuilding";
  else if (state.includes("inactive")) raidState = "inactive";
  else if (state.includes("failed")) raidState = "failed";

  const mountpoints = aliases.flatMap((alias) => mountedSources.get(alias) ?? []);
  return {
    device,
    level,
    state: raidState,
    size,
    members,
    mountpoints,
    inUse: mountpoints.length > 0,
    rebuildPercent,
    name: device.replace("/dev/", ""),
  };
}

async function createRaid(p: Record<string, unknown>) {
  const level = p.level as number;
  const devices = ((p.devices as string[]) ?? (p.members as string[]) ?? []);
  const spares = (p.spareDevices as string[]) ?? [];
  const chunkKb = (p.chunkSizeKb as number) ?? 512;

  const allDevices = [...devices, ...spares];
  const { stdout: scan } = await execFileAsync("mdadm", ["--detail", "--scan"]).catch(() => ({ stdout: "" }));
  const existingNums = [...scan.matchAll(/\/dev\/md(\d+)/g)].map((m) => parseInt(m[1]));
  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 0;
  const device = `/dev/md${nextNum}`;

  const args = [
    "--create", device,
    `--level=${level}`,
    `--raid-devices=${devices.length}`,
    "--force",
  ];
  if (level !== 1) args.push(`--chunk=${chunkKb}`);
  if (spares.length > 0) args.push(`--spare-devices=${spares.length}`);
  args.push(...allDevices);

  await execFileAsync("mdadm", args);

  try {
    const { stdout: detail } = await execFileAsync("mdadm", ["--detail", "--scan", device]);
    const mdadmConf = "/etc/mdadm/mdadm.conf";
    const existing = await fs.readFile(mdadmConf, "utf8").catch(() => "");
    if (!existing.includes(detail.trim())) {
      await fs.appendFile(mdadmConf, "\n" + detail.trim());
    }
  } catch {}

  return { ok: true, device };
}

async function stopRaid(device: string) {
  const detail = await getRaidDetail(device);
  if (detail.inUse) {
    throw new Error(`RAID array is mounted or used by the system: ${(detail.mountpoints ?? []).join(", ")}`);
  }
  await execFileAsync("mdadm", ["--stop", device]);
  return { ok: true };
}

async function addRaidMember(device: string, member: string) {
  await execFileAsync("mdadm", [device, "--add", member]);
  return { ok: true };
}

async function removeRaidMember(device: string, member: string) {
  await execFileAsync("mdadm", [device, "--fail", member]);
  await execFileAsync("mdadm", [device, "--remove", member]);
  return { ok: true };
}

async function getPoolDf(poolPath: string) {
  // A dead FUSE mount (rclone daemon crashed) makes `df` fail with ENOTCONN
  // ("Transport endpoint is not connected"). Report zeros instead of throwing,
  // so a dead mount surfaces as 0 bytes rather than a 500 on every status poll.
  // Bounded: on a stuck kernel FUSE connection `df` itself can hang forever.
  try {
    const { stdout } = await execWithTimeout("df", ["-B1", "--output=size,used,avail", poolPath], 5_000);
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
    const parts = lines[1].trim().split(/\s+/);
    return { totalBytes: parseInt(parts[0]) || 0, usedBytes: parseInt(parts[1]) || 0, freeBytes: parseInt(parts[2]) || 0 };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

// Liveness probe for a storage pool mount. Two failure modes must be caught:
//   1. NOT mounted at all — the path is just an empty directory (created by
//      ensureLibvirtPoolAccess). `stat` succeeds here, so it is NOT enough.
//   2. FUSE mount whose daemon died — `findmnt` still lists the kernel entry,
//      but any real access (readdir) fails with ENOTCONN.
// A pool is alive only if it is BOTH a real mountpoint (findmnt) AND readable
// (readdir). This distinguishes "mounted and healthy" from "empty dir" and
// "dead FUSE".
async function isPoolAlive(poolPath: string): Promise<{ alive: boolean }> {
  return probePoolAlive(poolPath, {
    isMountpoint: async (candidate) => {
      // `findmnt` reads kernel mount state, but on a stuck FUSE connection even
      // reading mountinfo can hang — bound it so the probe never pins the runner.
      await execWithTimeout("findmnt", ["-n", "-o", "TARGET", candidate], 5_000);
      return true;
    },
    readDirectory: (candidate) => fs.readdir(candidate),
    accessTimeoutMs: 2_000,
  });
}

function fstabEscape(value: string): string {
  // fstab uses octal \0xx for tab, space, backslash, and special chars.
  return value
    .replace(/\\/g, "\\134")
    .replace(/ /g, "\\040")
    .replace(/\t/g, "\\011");
}

function dedupeOptions(options: string): string {
  const seen = new Set<string>();
  return options.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false;
      const key = entry.split("=")[0].toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(",");
}

function injectMountOption(options: string, key: string, value: string): string {
  const parts = options.split(",").map((entry) => entry.trim()).filter(Boolean);
  const filtered = parts.filter((entry) => entry.split("=")[0].toLowerCase() !== key.toLowerCase());
  filtered.push(`${key}=${value}`);
  return filtered.join(",");
}

async function mountPool(p: Record<string, unknown>) {
  const mountPath = validateMountPath(p.path, "path");
  // Serialize mount/umount per mountpoint: the VDM reconciliation loop and
  // manual actions can otherwise interleave and unmount each other's work.
  return withPoolOpLock(mountPath, () => mountPoolLocked(p, mountPath));
}

async function mountPoolLocked(p: Record<string, unknown>, mountPath: string) {
  const name = p.name as string | undefined;
  const rawType = (p.type as string | undefined) ?? "directory";
  if (!["directory", "nfs", "nfs4", "cifs", "smbfs", "glusterfs", "s3"].includes(rawType)) {
    throw new Error(`Invalid pool type: ${rawType}`);
  }
  const type = rawType;
  const source = (p.mountSource as string | undefined) ?? (p.mountDevice as string | undefined);
  const device = p.mountDevice as string | undefined;

  // S3 / object storage pool — handled by rclone mount (FUSE). It does not use
  // fstab or the classic mount() path, so branch before fstype validation.
  if (type === "s3") {
    return mountS3Pool({ name, mountPath, p });
  }

  const rawFstype = (p.fstype as string) ?? "ext4";
  if (!ALLOWED_FSTAB_MOUNT_TYPES.has(rawFstype)) {
    throw new Error(`Invalid fstype: ${rawFstype}`);
  }
  const fstype = rawFstype;
  const requestedOptions = p.mountOptions as string | undefined;
  const smbUsername = (p.smbUsername as string | undefined)?.trim();
  const smbPassword = p.smbPassword as string | undefined;
  const smbDomain = (p.smbDomain as string | undefined)?.trim();
  const smbVersion = validateSmbVersion(p.smbVersion);
  const nfsVersion = validateNfsVersion(p.nfsVersion);

  if (smbUsername && !/^[a-zA-Z0-9._@-]{1,128}$/.test(smbUsername)) {
    throw new Error("Invalid smbUsername");
  }
  if (smbDomain && !/^[a-zA-Z0-9._-]{1,64}$/.test(smbDomain)) {
    throw new Error("Invalid smbDomain");
  }

  let options = requestedOptions
    ?? (type === "nfs" || type === "nfs4"
      ? "defaults,_netdev"
      : type === "cifs" || type === "smbfs"
        ? "rw,iocharset=utf8,_netdev,noperm,uid=0,gid=0,file_mode=0664,dir_mode=0775"
        : "defaults");

  if (typeof options !== "string") {
    throw new Error("Invalid mountOptions");
  }
  options = sanitizeMountOptions(options);

  // Inject protocol version if requested
  if ((type === "cifs" || type === "smbfs") && smbVersion) {
    options = injectMountOption(options, "vers", smbVersion);
  } else if ((type === "cifs" || type === "smbfs") && !/(^|,)\s*vers=/i.test(options)) {
    options = injectMountOption(options, "vers", "3.0");
  }
  if ((type === "nfs" || type === "nfs4") && nfsVersion) {
    // NFS uses nfsvers= or vers=
    options = injectMountOption(options, "nfsvers", nfsVersion);
  }

  await ensureLibvirtPoolAccess(mountPath);
  if (type === "directory" && !source) {
    return { ok: true };
  }

  const mountSource = validateMountSource(source ?? device, "mountSource");
  const mountType = validateMountType(type === "directory" ? fstype : type);

  if (type === "cifs" && smbUsername) {
    const credentialsDir = "/etc/auxinuxvirtual/credentials";
    const credentialsName = `${(name ?? path.basename(mountPath)).replace(/[^a-zA-Z0-9._-]/g, "_")}.cifs`;
    const credentialsPath = path.join(credentialsDir, credentialsName);
    // SMB password may legitimately contain almost anything; keep it as-is but reject newlines (the
    // credentials file is line-based and a newline would enable injection of extra directives).
    if (smbPassword && /[\n\r\0]/.test(smbPassword)) {
      throw new Error("Invalid smbPassword: control characters are not allowed");
    }
    const credentialLines = [
      `username=${smbUsername}`,
      `password=${smbPassword ?? ""}`,
      ...(smbDomain ? [`domain=${smbDomain}`] : []),
    ];
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(credentialsPath, `${credentialLines.join("\n")}\n`, { mode: 0o600 });
    await fs.chmod(credentialsPath, 0o600).catch(() => {});
    options = options
      .split(",")
      .filter((entry) => entry.trim() && !entry.trim().startsWith("username=") && !entry.trim().startsWith("password=") && !entry.trim().startsWith("domain=") && !entry.trim().startsWith("credentials="))
      .join(",");
    options = options ? `${options},credentials=${credentialsPath}` : `credentials=${credentialsPath}`;
  }
  options = dedupeOptions(sanitizeMountOptions(options));
  await execFileAsync("mount", ["-t", mountType, "-o", options, mountSource, mountPath]);

  // Build the fstab line with octal escapes for whitespace/tabs/backslashes so line format stays intact.
  const fstabFields = [
    fstabEscape(mountSource),
    fstabEscape(mountPath),
    mountType,
    options,
    "0",
    "2",
  ].join(" ");
  const existing = await fs.readFile("/etc/fstab", "utf8").catch(() => "");
  const escapedMountPath = fstabEscape(mountPath);
  const filtered = existing
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      // Match existing entries for this mountpoint (field separated by whitespace).
      const parts = line.split(/\s+/);
      return parts[1] !== mountPath && parts[1] !== escapedMountPath;
    });
  filtered.push(fstabFields);
  await fs.writeFile("/etc/fstab", `${filtered.join("\n")}\n`);
  await ensureLibvirtPoolAccess(mountPath);
  return { ok: true };
}

// ── S3 / object storage pool via rclone mount (FUSE) ─────────────────────
async function mountS3Pool(args: { name?: string; mountPath: string; p: Record<string, unknown> }) {
  const { name, mountPath, p } = args;
  const bucket = (p.s3Bucket as string | undefined)?.trim();
  const endpoint = (p.s3Endpoint as string | undefined)?.trim();
  const accessKey = (p.s3AccessKey as string | undefined)?.trim();
  const secretKey = (p.s3SecretKey as string | undefined)?.trim();
  const region = (p.s3Region as string | undefined)?.trim();
  const provider = (p.s3Provider as string | undefined) ?? "generic";
  const vfsCache = (p.s3VfsCacheMode as string | undefined) ?? "off";
  if (!bucket) throw new Error("S3 bucket name is required");
  if (!accessKey || !secretKey) throw new Error("S3 access key and secret key are required");

  // Configure a per-pool rclone remote (isolated config file) to avoid clobbering
  // other rclone configs on the host. Type "s3" works for AWS, MinIO and most S3
  // compatible services; provider selection maps to the rclone provider name.
  const remoteName = `virtua-${(name ?? "s3").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const credsDir = "/etc/auxinuxvirtual/credentials";
  await fs.mkdir(credsDir, { recursive: true });
  // The directory holds S3 keys in plaintext (rclone config) — restrict it to root.
  await fs.chmod(credsDir, 0o700).catch(() => {});
  const configPath = path.join(credsDir, `${remoteName}.conf`);
  const logPath = path.join(credsDir, `${remoteName}.log`);
  const providerMap: Record<string, string> = { aws: "AWS", minio: "Minio", b2: "B2", generic: "Other" };
  const rcloneProvider = providerMap[provider] ?? "Other";

  const lines = [
    `[${remoteName}]`,
    `type = s3`,
    `provider = ${rcloneProvider}`,
    `access_key_id = ${accessKey}`,
    `secret_access_key = ${secretKey}`,
    ...(endpoint ? [`endpoint = ${endpoint}`] : []),
    ...(region ? [`region = ${region}`] : []),
  ];
  await fs.writeFile(configPath, `${lines.join("\n")}\n`, { mode: 0o600 });

  // rclone mount exposes the bucket as a FUSE filesystem at the mount path.
  // Clear any stale FUSE entry from a previous dead mount BEFORE touching the
  // path: any filesystem operation on a dead FUSE mountpoint — including the
  // mkdir in ensureLibvirtPoolAccess — fails with ENOTCONN (or hangs) and was
  // the reason reconciliation remounts failed in a loop on the same error.
  await clearStaleFuseMount(mountPath);
  try {
    await ensureLibvirtPoolAccess(mountPath);
  } catch (error) {
    if (!isNotConnectedError(error)) throw error;
    // The lazy unmount raced a stuck kernel connection; release and retry once.
    await clearStaleFuseMount(mountPath);
    await ensureLibvirtPoolAccess(mountPath);
  }
  // `--allow-other` requires `user_allow_other` in /etc/fuse.conf, otherwise the
  // rclone daemon dies right after mounting (mount registered, then ENOTCONN on
  // any access). Ensure it is present so the mount survives.
  await ensureFuseAllowOther();
  // Defensive second pass: the liveness probe or a concurrent caller may have
  // remounted between the first clear and now.
  await execWithTimeout("fusermount3", ["-uz", mountPath], 10_000).catch(() => {});
  await execWithTimeout("fusermount", ["-uz", mountPath], 10_000).catch(() => {});

  // Network timeouts so an unreachable endpoint / bad credentials fail FAST
  // instead of rclone retrying for minutes and pinning the runner until the
  // API's 120s timeout ("Runner timeout for action: storage_pool_mount").
  const netTimeoutArgs = ["--contimeout", "10s", "--timeout", "30s", "--low-level-retries", "1"];

  // A half-dead daemon from a previous attempt holds the FUSE connection open
  // and makes the new mount hang — kill it so the fresh daemon owns the path.
  await killStaleRcloneDaemon(remoteName);

  // Pre-flight: verify the S3 backend actually answers BEFORE attempting the
  // mount. `rclone mount --daemon` can hang the whole runner call when the
  // endpoint is down; this surfaces the real reason in a few seconds instead.
  try {
    await execWithTimeout("rclone", [
      "--config", configPath, ...netTimeoutArgs,
      "lsd", `${remoteName}:${bucket}`, "--max-depth", "1",
    ], 25_000);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await fs.unlink(configPath).catch(() => {});
    throw new Error(`S3 backend unreachable or credentials invalid: ${reason}`);
  }

  const cacheArg = vfsCache === "off" ? ["--vfs-cache-mode=off"] : [`--vfs-cache-mode=${vfsCache}`];
  // Launch rclone mount DETACHED and do not wait on it. `rclone mount --daemon`
  // blocks until the initial FUSE handshake (network listing) completes; on a
  // slow S3 endpoint killing the parent on a timeout leaves a half-mounted
  // daemon (df shows the mount but the pool is never registered). Instead we
  // fire-and-forget the daemon, then poll the mountpoint for up to ~60s.
  spawnDetached("rclone", [
    "--config", configPath, "mount", `${remoteName}:${bucket}`,
    mountPath, "--daemon", ...cacheArg, ...netTimeoutArgs,
    "--allow-other", "--dir-cache-time", "10m",
    "--log-file", logPath, "--log-level", "INFO",
  ]);

  // Poll until the mountpoint is registered AND readable. The poll window is
  // generous (slow OVH endpoints) but stays well under the API's 120s timeout.
  const deadline = Date.now() + 60_000;
  let mounted = false;
  while (Date.now() < deadline) {
    if (await isMountpointReadable(mountPath)) {
      mounted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!mounted) {
    const logTail = await fs.readFile(logPath, "utf8").catch(() => "");
    const reason = logTail.trim().split("\n").slice(-3).join(" | ") || "rclone mount did not come up within 60s";
    // Clean up the dead attempt so a retry starts fresh (no stale FUSE entry).
    await execWithTimeout("fusermount3", ["-uz", mountPath], 10_000).catch(() => {});
    await execWithTimeout("fusermount", ["-uz", mountPath], 10_000).catch(() => {});
    await fs.unlink(configPath).catch(() => {});
    throw new Error(`S3 mount failed: ${reason}`);
  }
  return { ok: true };
}

async function umountPool(p: Record<string, unknown>) {
  const poolPath = validateMountPath(p.path, "path");
  return withPoolOpLock(poolPath, () => umountPoolLocked(p, poolPath));
}

async function umountPoolLocked(p: Record<string, unknown>, poolPath: string) {
  const poolName = p.name as string | undefined;
  // S3 / rclone mounts also expose a FUSE mountpoint; unmount it with fusermount/rclone.
  // A DEAD FUSE mount (rclone daemon crashed) reports ENOTCONN and refuses a normal
  // unmount — use lazy unmount (-l / -uz) so the stale mountpoint is released and a
  // later remount can succeed instead of looping on a zombie FUSE entry.
  // Every unmount attempt is bounded: a stuck kernel FUSE connection can hang
  // even a lazy unmount, and we must not pin the runner for the 120s call timeout.
  await execWithTimeout("umount", [poolPath], 10_000).catch(() => {});
  await execWithTimeout("umount", ["-l", poolPath], 10_000).catch(() => {});
  await execWithTimeout("fusermount3", ["-u", poolPath], 10_000).catch(() => {});
  await execWithTimeout("fusermount3", ["-uz", poolPath], 10_000).catch(() => {});
  await execWithTimeout("fusermount", ["-u", poolPath], 10_000).catch(() => {});
  await execWithTimeout("fusermount", ["-uz", poolPath], 10_000).catch(() => {});
  const fstab = await fs.readFile("/etc/fstab", "utf8").catch(() => "");
  const escapedMountPath = fstabEscape(poolPath);
  const filtered = fstab.split("\n").filter((line) => {
    if (!line.trim()) return true;
    const parts = line.split(/\s+/);
    return parts[1] !== poolPath && parts[1] !== escapedMountPath;
  }).join("\n");
  await fs.writeFile("/etc/fstab", filtered);
  if (poolName) {
    const safeName = poolName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const credentialsPath = path.join("/etc/auxinuxvirtual/credentials", `${safeName}.cifs`);
    await fs.unlink(credentialsPath).catch(() => {});
    // Remove the rclone S3 credentials file if present
    const s3CredPath = path.join("/etc/auxinuxvirtual/credentials", `${safeName}.s3`);
    await fs.unlink(s3CredPath).catch(() => {});
    // Remove the rclone remote config + log (the config holds the S3 keys in
    // plaintext — it MUST be deleted when the pool is removed).
    const remoteName = `virtua-${safeName}`;
    await fs.unlink(path.join("/etc/auxinuxvirtual/credentials", `${remoteName}.conf`)).catch(() => {});
    await fs.unlink(path.join("/etc/auxinuxvirtual/credentials", `${remoteName}.log`)).catch(() => {});
  }
  return { ok: true };
}
