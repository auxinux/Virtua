import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);
const LXC_DIR = process.env.LXC_DIR ?? "/var/lib/lxc";
const AUXINUX_DATA_DIR = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinuxvirtual";
const STABLE_USB_DIR = path.join(AUXINUX_DATA_DIR, "usb");

export async function handleSystem(action: string, params: unknown): Promise<unknown> {
  switch (action) {
    case "system_ping": return { pong: true, time: Date.now() };
    case "system_stats": return getSystemStats();
    case "system_info": return getSystemInfo();
    case "system_disk_io": return getDiskIo();
    case "system_services": return getServiceStatuses();
    case "system_updates": return getUpdateStatus();
    case "system_usb_devices": return getUsbDevices();
    case "system_gpu_devices": return getGpuDevices();
    case "system_reboot_safety": return getRebootSafety();
    case "system_ssh_status": return getSshAccessStatus();
    case "system_ssh_set_mode": return setSshAccessMode(params as Record<string, unknown>);
    case "system_ssh_generate_key": return generateSshAccessKey();
    case "system_ssh_private_key": return getSshPrivateKey();
    case "system_reboot": return rebootHost();
    case "system_shutdown": return shutdownHost();
    default: throw new Error(`Unknown system action: ${action}`);
  }
}

function normalizeUsbId(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "").padStart(4, "0");
}

function usbAssignmentKey(vendorId: string, productId: string, bus?: string, device?: string) {
  const base = `${normalizeUsbId(vendorId)}:${normalizeUsbId(productId)}`;
  return bus && device ? `${base}:${bus}:${device}` : base;
}

function stableUsbHostPath(vendorId: string, productId: string) {
  return path.join(STABLE_USB_DIR, `${normalizeUsbId(vendorId)}-${normalizeUsbId(productId)}`);
}

async function ensureStableUsbLink(vendorId: string, productId: string, bus: string, device: string) {
  const currentHostPath = `/dev/bus/usb/${bus}/${device}`;
  await fs.access(currentHostPath);
  await fs.mkdir(STABLE_USB_DIR, { recursive: true });
  const stablePath = stableUsbHostPath(vendorId, productId);
  await fs.rm(stablePath, { force: true });
  await fs.symlink(currentHostPath, stablePath);
}

async function collectAssignedUsbDevices() {
  const assignments = new Map<string, { type: "vm" | "lxc"; name: string }>();

  try {
    const { stdout } = await execFileAsync("virsh", ["list", "--all", "--name"], { timeout: 5000 });
    for (const name of stdout.trim().split("\n").filter(Boolean)) {
      const { stdout: xml } = await execFileAsync("virsh", ["dumpxml", name], { timeout: 5000 });
      for (const match of xml.matchAll(/<hostdev\b[\s\S]*?<\/hostdev>/gi)) {
        const block = match[0];
        if (!/type=['"]usb['"]/i.test(block)) continue;
        const vendorId = block.match(/<vendor[^>]*id=['"](?:0x)?([0-9a-f]{4})['"]/i)?.[1];
        const productId = block.match(/<product[^>]*id=['"](?:0x)?([0-9a-f]{4})['"]/i)?.[1];
        const bus = block.match(/<address[^>]*bus=['"](\d+)['"]/i)?.[1]?.padStart(3, "0");
        const device = block.match(/<address[^>]*device=['"](\d+)['"]/i)?.[1]?.padStart(3, "0");
        if (vendorId && productId) {
          assignments.set(usbAssignmentKey(vendorId, productId), { type: "vm", name });
          if (bus && device) assignments.set(usbAssignmentKey(vendorId, productId, bus, device), { type: "vm", name });
        }
      }
    }
  } catch {
    /* libvirt may be unavailable on hosts used only for containers */
  }

  try {
    const names = await fs.readdir(LXC_DIR);
    for (const name of names) {
      const configPath = path.join(LXC_DIR, name, "config");
      const cfg = await fs.readFile(configPath, "utf8").catch(() => "");
      for (const match of cfg.matchAll(/^#\s*auxinux\.usb\s+([0-9a-f]{4}):([0-9a-f]{4})(?:\s+bus=(\d{3})\s+device=(\d{3}))?/gim)) {
        const [, vendorId, productId, bus, device] = match;
        assignments.set(usbAssignmentKey(vendorId, productId), { type: "lxc", name });
        if (bus && device) assignments.set(usbAssignmentKey(vendorId, productId, bus, device), { type: "lxc", name });
      }
    }
  } catch {
    /* LXC may be unavailable on VM-only hosts */
  }

  return assignments;
}

async function getUsbDevices() {
  const { stdout } = await execFileAsync("lsusb", [], { maxBuffer: 1024 * 1024 });
  const assignments = await collectAssignedUsbDevices();
  const devices = stdout.split("\n").map((line) => {
    const match = line.match(/^Bus\s+(\d{3})\s+Device\s+(\d{3}):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i);
    if (!match) return null;
    const [, bus, device, vendorRaw, productRaw, labelRaw] = match;
    const vendorId = normalizeUsbId(vendorRaw);
    const productId = normalizeUsbId(productRaw);
    const label = labelRaw.trim() || `${vendorId}:${productId}`;
    const assignedTo = assignments.get(usbAssignmentKey(vendorId, productId, bus, device)) ?? assignments.get(usbAssignmentKey(vendorId, productId));
    return {
      type: "usb",
      id: `${vendorId}:${productId}:${bus}:${device}`,
      vendorId,
      productId,
      label,
      bus,
      device,
      devPath: `/dev/bus/usb/${bus}/${device}`,
      assignedTo,
    };
  }).filter(Boolean);
  await Promise.all(devices.map(async (entry) => {
    if (!entry) return;
    const assigned = assignments.get(usbAssignmentKey(entry.vendorId, entry.productId));
    if (assigned?.type === "lxc" && entry.bus && entry.device) {
      await ensureStableUsbLink(entry.vendorId, entry.productId, entry.bus, entry.device).catch(() => {});
    }
  }));
  return devices;
}

async function collectAssignedGpuDevices() {
  const assignments = new Map<string, { type: "lxc"; name: string }>();
  try {
    const names = await fs.readdir(LXC_DIR);
    for (const name of names) {
      const cfg = await fs.readFile(path.join(LXC_DIR, name, "config"), "utf8").catch(() => "");
      for (const match of cfg.matchAll(/^#\s*auxinux\.gpu\s+(dri|nvidia)\b/gim)) {
        assignments.set(match[1].toLowerCase(), { type: "lxc", name });
      }
    }
  } catch {
    /* LXC may be unavailable on VM-only hosts */
  }
  return assignments;
}

async function listExistingDevPaths(dir: string, pattern: RegExp) {
  const entries = await fs.readdir(dir).catch(() => []);
  const paths = entries.filter((entry) => pattern.test(entry)).map((entry) => path.join(dir, entry));
  const existing: string[] = [];
  for (const devPath of paths) {
    if (await fs.stat(devPath).then((stat) => stat.isCharacterDevice() || stat.isDirectory()).catch(() => false)) {
      existing.push(devPath);
    }
  }
  return existing.sort();
}

async function gpuPciSummary() {
  const { stdout } = await execFileAsync("lspci", ["-D"], { timeout: 5000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" }));
  return stdout.split("\n")
    .filter((line) => /(vga compatible controller|3d controller|display controller)/i.test(line))
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getGpuDevices() {
  const [assignments, pciLines] = await Promise.all([collectAssignedGpuDevices(), gpuPciSummary()]);
  const devices: Array<{
    type: "gpu";
    id: "dri" | "nvidia";
    label: string;
    vendor: "intel" | "amd" | "nvidia" | "unknown";
    mode: "shared-lxc";
    devPaths: string[];
    assignedTo?: { type: "lxc"; name: string };
  }> = [];

  const driPaths = await listExistingDevPaths("/dev/dri", /^(card\d+|renderD\d+)$/);
  if (driPaths.length > 0) {
    const pciLabel = pciLines.find((line) => /intel|amd|advanced micro devices|ati/i.test(line));
    const vendor = /intel/i.test(pciLabel ?? "") ? "intel" : /amd|advanced micro devices|ati/i.test(pciLabel ?? "") ? "amd" : "unknown";
    devices.push({
      type: "gpu",
      id: "dri",
      label: pciLabel ? `DRI render GPU · ${pciLabel}` : "DRI render GPU (/dev/dri)",
      vendor,
      mode: "shared-lxc",
      devPaths: driPaths,
      assignedTo: assignments.get("dri"),
    });
  }

  const nvidiaRootPaths = await listExistingDevPaths("/dev", /^nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/);
  const nvidiaCaps = await listExistingDevPaths("/dev/nvidia-caps", /^nvidia-cap\d+$/);
  const nvidiaPaths = [...nvidiaRootPaths, ...nvidiaCaps];
  if (nvidiaPaths.length > 0) {
    const pciLabel = pciLines.find((line) => /nvidia/i.test(line));
    devices.push({
      type: "gpu",
      id: "nvidia",
      label: pciLabel ? `NVIDIA GPU · ${pciLabel}` : "NVIDIA GPU (/dev/nvidia*)",
      vendor: "nvidia",
      mode: "shared-lxc",
      devPaths: nvidiaPaths,
      assignedTo: assignments.get("nvidia"),
    });
  }

  return devices;
}

const HEALTH_SERVICES = [
  "auxinuxvirtual-api.service",
  "auxinuxvirtual-runner.service",
  "docker.service",
  "containerd.service",
  "libvirtd.service",
  "virtlogd.service",
  "virtlockd.service",
  "lxcfs.service",
  "nftables.service",
];

interface RebootSafetyCheck {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

interface RebootSafetyReport {
  ok: boolean;
  checks: RebootSafetyCheck[];
}

async function readProcStat(): Promise<number[]> {
  const content = await fs.readFile("/proc/stat", "utf8");
  const line = content.split("\n")[0];
  return line.split(/\s+/).slice(1).map(Number);
}

async function getCpuUsage(): Promise<number> {
  const s1 = await readProcStat();
  await new Promise((r) => setTimeout(r, 200));
  const s2 = await readProcStat();

  const idle1 = s1[3] + s1[4];
  const idle2 = s2[3] + s2[4];
  const total1 = s1.reduce((a, b) => a + b, 0);
  const total2 = s2.reduce((a, b) => a + b, 0);

  const totalDelta = total2 - total1;
  const idleDelta = idle2 - idle1;
  if (totalDelta === 0) return 0;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 100 * 10) / 10;
}

async function getMemInfo(): Promise<{ total: number; free: number; used: number; cached: number; buffers: number }> {
  const content = await fs.readFile("/proc/meminfo", "utf8");
  const map: Record<string, number> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) map[m[1]] = parseInt(m[2]) * 1024;
  }
  const total = map["MemTotal"] ?? 0;
  const free = map["MemFree"] ?? 0;
  const cached = map["Cached"] ?? 0;
  const buffers = map["Buffers"] ?? 0;
  const used = total - free - cached - buffers;
  return { total, free, used, cached, buffers };
}

async function getNetworkStats(): Promise<{ rxBytes: number; txBytes: number }> {
  const content = await fs.readFile("/proc/net/dev", "utf8");
  let rx = 0, tx = 0;
  for (const line of content.split("\n").slice(2)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || parts[0].startsWith("lo:")) continue;
    rx += parseInt(parts[1]) || 0;
    tx += parseInt(parts[9]) || 0;
  }
  return { rxBytes: rx, txBytes: tx };
}

async function getDiskUsage(): Promise<{ total: number; used: number; free: number }> {
  try {
    const { stdout } = await execFileAsync("df", ["-B1", "--output=size,used,avail", "/"]);
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return { total: 0, used: 0, free: 0 };
    const parts = lines[1].trim().split(/\s+/);
    return {
      total: parseInt(parts[0]) || 0,
      used: parseInt(parts[1]) || 0,
      free: parseInt(parts[2]) || 0,
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

async function getSystemStats() {
  const [cpuUsage, mem, net, disk] = await Promise.all([
    getCpuUsage(),
    getMemInfo(),
    getNetworkStats(),
    getDiskUsage(),
  ]);

  const uptime = os.uptime();
  const loadavg = os.loadavg() as [number, number, number];
  const cpuCount = os.cpus().length;

  return {
    uptime,
    loadavg,
    cpuCount,
    cpuUsage,
    mem,
    disk,
    network: { rxBytes: net.rxBytes, txBytes: net.txBytes, rxRate: 0, txRate: 0 },
  };
}

async function getSystemInfo() {
  const hostname = os.hostname();
  const kernel = os.release();
  const arch = os.arch();
  const uptime = os.uptime();

  let os_name = "Linux";
  try {
    const content = await fs.readFile("/etc/os-release", "utf8");
    const m = content.match(/^PRETTY_NAME="(.+)"/m);
    if (m) os_name = m[1];
  } catch {}

  // The PRIMARY/public IP is the source address the kernel uses to reach the
  // Internet — i.e. the IP on the default-route interface (vmbr0 with the public
  // IP), NOT lxcbr0/docker0/virbr0 private gateways. Detecting it via the route
  // table avoids the bug where the panel showed a private bridge IP (10.0.3.1).
  let primaryIp: string | undefined;
  try {
    const { stdout } = await execFileAsync("ip", ["-j", "route", "get", "1.1.1.1"]);
    const routes = JSON.parse(stdout) as Array<{ prefsrc?: string; dev?: string }>;
    primaryIp = routes[0]?.prefsrc;
  } catch {}

  // Interfaces we never want to advertise as the node's address.
  const isPrivateInfraIp = (ip: string) =>
    ip.startsWith("10.0.3.") ||      // lxcbr0 default
    ip.startsWith("172.17.") ||      // docker0 default
    ip.startsWith("192.168.122.");   // libvirt virbr0 default

  let allIps: string[] = [];
  try {
    const { stdout } = await execFileAsync("ip", ["-j", "addr", "show"]);
    const ifaces = JSON.parse(stdout) as Array<{ ifname: string; addr_info: Array<{ family: string; local: string }> }>;
    for (const iface of ifaces) {
      if (iface.ifname === "lo") continue;
      for (const addr of iface.addr_info || []) {
        if (addr.family === "inet") allIps.push(addr.local);
      }
    }
  } catch {}

  // publicIps: primary first, then any other non-infra IPs. Always a sane order
  // so the UI's publicIps[0] is the real reachable address.
  const ordered: string[] = [];
  if (primaryIp) ordered.push(primaryIp);
  for (const ip of allIps) {
    if (ip === primaryIp) continue;
    if (isPrivateInfraIp(ip)) continue;
    ordered.push(ip);
  }
  const publicIps = ordered.length > 0 ? ordered : allIps;

  return { hostname, primaryIp, publicIps, allIps, os: os_name, kernel, arch, uptime };
}

async function getDiskIo() {
  try {
    const content = await fs.readFile("/proc/diskstats", "utf8");
    const result: Array<{ name: string; readBytes: number; writeBytes: number }> = [];
    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;
      const name = parts[2];
      if (!name || name.match(/^(loop|ram|sr)/)) continue;
      const readSectors = parseInt(parts[5]) || 0;
      const writeSectors = parseInt(parts[9]) || 0;
      result.push({ name, readBytes: readSectors * 512, writeBytes: writeSectors * 512 });
    }
    return result;
  } catch {
    return [];
  }
}

async function getServiceStatuses() {
  const results = await Promise.all(HEALTH_SERVICES.map(async (unit) => {
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "show",
        unit,
        "--no-page",
        "--property=Id,Description,ActiveState,SubState,UnitFileState,Result,ExecMainStatus",
      ]);
      const fields = Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [key, ...rest] = line.split("=");
        return [key, rest.join("=")];
      }));
      const activeState = String(fields.ActiveState ?? "unknown");
      const result = String(fields.Result ?? "");
      const status =
        activeState === "active" ? "running" :
        activeState === "failed" ? "failed" :
        activeState === "inactive" ? "inactive" :
        activeState === "activating" ? "running" :
        "unknown";
      return {
        name: String(fields.Id ?? unit),
        description: String(fields.Description ?? unit),
        activeState,
        subState: String(fields.SubState ?? ""),
        unitFileState: String(fields.UnitFileState ?? ""),
        result,
        execMainStatus: Number(fields.ExecMainStatus ?? 0),
        status,
        errorReason: status === "failed" ? `${activeState}/${fields.SubState ?? "unknown"} (${result || "error"})` : undefined,
      };
    } catch (error) {
      return {
        name: unit,
        description: unit,
        activeState: "unknown",
        subState: "unknown",
        unitFileState: "unknown",
        result: "unknown",
        execMainStatus: 0,
        status: "unknown",
        errorReason: error instanceof Error ? error.message : "Unable to read service state",
      };
    }
  }));
  return results;
}

async function getUpdateStatus() {
  let upgradableCount = 0;
  let packages: string[] = [];
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", "apt list --upgradable 2>/dev/null || true"]);
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("Listing..."));
    packages = lines.map((line) => line.split("/")[0]).filter(Boolean);
    upgradableCount = packages.length;
  } catch {}

  const cacheUpdatedAt = await fs.stat("/var/cache/apt/pkgcache.bin")
    .then((stat) => stat.mtime.toISOString())
    .catch(async () => fs.stat("/var/lib/apt/periodic/update-success-stamp").then((stat) => stat.mtime.toISOString()).catch(() => undefined));
  const rebootRequired = await fs.access("/var/run/reboot-required").then(() => true).catch(() => false);

  return {
    upgradableCount,
    packages,
    cacheUpdatedAt,
    rebootRequired,
  };
}

async function execText(command: string, args: string[], timeout = 4000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout });
  return stdout.trim();
}

async function execSshd(args: string[], timeout = 5000): Promise<string> {
  let lastError: unknown;
  for (const command of ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "sshd"]) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout });
      return stdout.trim();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("sshd command not found");
}

async function getSystemdUnitState(unit: string) {
  const output = await execText("systemctl", [
    "show",
    unit,
    "--no-page",
    "--property=LoadState,ActiveState,UnitFileState",
  ]).catch(() => "");
  const fields = Object.fromEntries(output.split("\n").filter(Boolean).map((line) => {
    const [key, ...rest] = line.split("=");
    return [key, rest.join("=")];
  }));
  return {
    loadState: String(fields.LoadState ?? "not-found"),
    activeState: String(fields.ActiveState ?? "unknown"),
    unitFileState: String(fields.UnitFileState ?? "unknown"),
  };
}

async function findSshUnit() {
  const candidates = ["ssh.service", "sshd.service"];
  for (const unit of candidates) {
    const state = await getSystemdUnitState(unit);
    if (state.loadState !== "not-found") return { unit, ...state };
  }
  return { unit: "ssh.service/sshd.service", loadState: "not-found", activeState: "unknown", unitFileState: "unknown" };
}

type SshAccessMode = "key-only" | "key-and-password" | "password-only";

const SSH_DROPIN_DIR = "/etc/ssh/sshd_config.d";
const SSH_DROPIN_FILE = path.join(SSH_DROPIN_DIR, "90-auxinux-virtua.conf");
const SSH_KEY_DIR = "/root/.ssh";
const SSH_KEY_PATH = path.join(SSH_KEY_DIR, "auxinux-virtua-admin_ed25519");
const SSH_AUTHORIZED_KEYS = path.join(SSH_KEY_DIR, "authorized_keys");
const SSH_KEY_MARKER = "auxinux-virtua-managed-admin-key";

function normalizeSshMode(value: unknown): SshAccessMode {
  if (value === "key-only" || value === "key-and-password" || value === "password-only") return value;
  throw new Error("Invalid SSH mode");
}

function renderSshAccessConfig(mode: SshAccessMode) {
  const settings = {
    "key-only": {
      pubkey: "yes",
      password: "no",
      keyboard: "no",
      root: "prohibit-password",
    },
    "key-and-password": {
      pubkey: "yes",
      password: "yes",
      keyboard: "yes",
      root: "yes",
    },
    "password-only": {
      pubkey: "no",
      password: "yes",
      keyboard: "yes",
      root: "yes",
    },
  }[mode];
  return [
    "# Managed by AuxiNux Virtua. Do not edit manually unless you remove this file.",
    `# AuxiNuxSSHMode ${mode}`,
    `PubkeyAuthentication ${settings.pubkey}`,
    `PasswordAuthentication ${settings.password}`,
    `KbdInteractiveAuthentication ${settings.keyboard}`,
    `PermitRootLogin ${settings.root}`,
    "",
  ].join("\n");
}

async function readSshDropinMode(): Promise<SshAccessMode | null> {
  const content = await fs.readFile(SSH_DROPIN_FILE, "utf8").catch(() => "");
  const raw = content.match(/^#\s*AuxiNuxSSHMode\s+(\S+)/m)?.[1];
  return raw === "key-only" || raw === "key-and-password" || raw === "password-only" ? raw : null;
}

async function getSshEffectiveConfig() {
  const output = await execSshd(["-T"], 5000).catch(() => "");
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key) map.set(key.toLowerCase(), rest.join(" "));
  }
  return {
    pubkeyAuthentication: map.get("pubkeyauthentication") ?? "",
    passwordAuthentication: map.get("passwordauthentication") ?? "",
    kbdInteractiveAuthentication: map.get("kbdinteractiveauthentication") ?? "",
    permitRootLogin: map.get("permitrootlogin") ?? "",
  };
}

async function reloadSshService() {
  const ssh = await findSshUnit();
  if (ssh.loadState === "not-found") throw new Error("SSH service is not installed");
  await execSshd(["-t"], 5000);
  await execFileAsync("systemctl", ["reload", ssh.unit], { timeout: 10_000 }).catch(async () => {
    await execFileAsync("systemctl", ["restart", ssh.unit], { timeout: 15_000 });
  });
}

// A usable authorized key is any non-empty, non-comment line in root's
// authorized_keys (the managed Virtua key or one the admin installed manually).
async function rootHasUsableAuthorizedKey(): Promise<boolean> {
  const content = await fs.readFile(SSH_AUTHORIZED_KEYS, "utf8").catch(() => "");
  return content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
}

async function setSshAccessMode(params: Record<string, unknown>) {
  const mode = normalizeSshMode(params.mode);
  // Anti-lockout guard: "key-only" disables password auth. Refuse to apply it
  // unless root already has at least one authorized public key, otherwise the
  // admin can lock themselves out of SSH (console-only recovery).
  if (mode === "key-only" && !(await rootHasUsableAuthorizedKey())) {
    throw new Error(
      "Cannot enable key-only SSH: no authorized public key exists for root. Generate the Virtua SSH key first, or install a key in /root/.ssh/authorized_keys.",
    );
  }
  await fs.mkdir(SSH_DROPIN_DIR, { recursive: true });
  await fs.writeFile(SSH_DROPIN_FILE, renderSshAccessConfig(mode), { mode: 0o644 });
  await reloadSshService();
  return getSshAccessStatus();
}

async function ensureManagedAuthorizedKey(publicKey: string) {
  await fs.mkdir(SSH_KEY_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SSH_KEY_DIR, 0o700).catch(() => {});
  const managedLine = `${publicKey.trim()} ${SSH_KEY_MARKER}`;
  const existing = await fs.readFile(SSH_AUTHORIZED_KEYS, "utf8").catch(() => "");
  const lines = existing
    .split("\n")
    .filter((line) => line.trim() && !line.includes(SSH_KEY_MARKER));
  lines.push(managedLine);
  await fs.writeFile(SSH_AUTHORIZED_KEYS, `${lines.join("\n")}\n`, { mode: 0o600 });
  await fs.chmod(SSH_AUTHORIZED_KEYS, 0o600).catch(() => {});
}

async function keyFingerprint(publicKeyPath: string) {
  const stdout = await execText("ssh-keygen", ["-lf", publicKeyPath], 5000).catch(() => "");
  return stdout.trim() || undefined;
}

async function generateSshAccessKey() {
  await fs.mkdir(SSH_KEY_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SSH_KEY_DIR, 0o700).catch(() => {});
  await fs.rm(SSH_KEY_PATH, { force: true }).catch(() => {});
  await fs.rm(`${SSH_KEY_PATH}.pub`, { force: true }).catch(() => {});
  const hostname = os.hostname() || "virtua";
  await execFileAsync("ssh-keygen", [
    "-t", "ed25519",
    "-N", "",
    "-C", `auxinux-virtua-admin@${hostname}`,
    "-f", SSH_KEY_PATH,
  ], { timeout: 10_000 });
  await fs.chmod(SSH_KEY_PATH, 0o600).catch(() => {});
  await fs.chmod(`${SSH_KEY_PATH}.pub`, 0o644).catch(() => {});
  const publicKey = await fs.readFile(`${SSH_KEY_PATH}.pub`, "utf8");
  await ensureManagedAuthorizedKey(publicKey);
  return getSshAccessStatus();
}

async function getSshPrivateKey() {
  const privateKey = await fs.readFile(SSH_KEY_PATH, "utf8").catch(() => null);
  if (!privateKey) throw new Error("No managed SSH key exists. Generate one first.");
  return {
    filename: path.basename(SSH_KEY_PATH),
    privateKey,
  };
}

async function getSshAccessStatus() {
  const ssh = await findSshUnit();
  const [mode, effective, privateKeyStat, publicKeyStat, fingerprint] = await Promise.all([
    readSshDropinMode(),
    getSshEffectiveConfig(),
    fs.stat(SSH_KEY_PATH).catch(() => null),
    fs.stat(`${SSH_KEY_PATH}.pub`).catch(() => null),
    keyFingerprint(`${SSH_KEY_PATH}.pub`),
  ]);
  const authorizedKeys = await fs.readFile(SSH_AUTHORIZED_KEYS, "utf8").catch(() => "");
  return {
    mode: mode ?? "key-only",
    dropinPath: SSH_DROPIN_FILE,
    service: ssh,
    effective,
    key: {
      privateKeyExists: !!privateKeyStat,
      publicKeyExists: !!publicKeyStat,
      authorized: authorizedKeys.includes(SSH_KEY_MARKER),
      fingerprint,
      privateKeyPath: SSH_KEY_PATH,
    },
  };
}

function unitEnabledForBoot(unitFileState: string) {
  return ["enabled", "enabled-runtime", "static", "generated", "indirect"].includes(unitFileState);
}

async function getDefaultRouteSummary() {
  const route = await execText("ip", ["route", "show", "default"]).catch(() => "");
  return route.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function getGlobalIpSummary() {
  const ipv4 = await execText("ip", ["-o", "-4", "addr", "show", "scope", "global"]).catch(() => "");
  const ipv6 = await execText("ip", ["-o", "-6", "addr", "show", "scope", "global"]).catch(() => "");
  return [ipv4, ipv6].join("\n").split("\n").map((line) => line.trim()).filter(Boolean);
}

async function getRebootSafety(): Promise<RebootSafetyReport> {
  const checks: RebootSafetyCheck[] = [];

  const defaultRoutes = await getDefaultRouteSummary();
  checks.push({
    id: "default-route",
    label: "Default network route",
    ok: defaultRoutes.length > 0,
    blocking: true,
    detail: defaultRoutes[0] ?? "No default route is currently visible",
  });

  const globalIps = await getGlobalIpSummary();
  checks.push({
    id: "global-ip",
    label: "Routable host IP",
    ok: globalIps.length > 0,
    blocking: true,
    detail: globalIps[0] ?? "No non-loopback global IP is currently visible",
  });

  const ssh = await findSshUnit();
  const sshReady = ssh.loadState !== "not-found" && ssh.activeState === "active" && unitEnabledForBoot(ssh.unitFileState);
  checks.push({
    id: "ssh-service",
    label: "SSH service",
    ok: sshReady,
    blocking: true,
    detail: `${ssh.unit}: active=${ssh.activeState}, enabled=${ssh.unitFileState}`,
  });

  for (const unit of ["auxinuxvirtual-runner.service", "auxinuxvirtual-api.service"]) {
    const state = await getSystemdUnitState(unit);
    const ready = state.loadState !== "not-found" && state.activeState === "active" && unitEnabledForBoot(state.unitFileState);
    checks.push({
      id: unit.replace(".service", ""),
      label: unit,
      ok: ready,
      blocking: true,
      detail: `active=${state.activeState}, enabled=${state.unitFileState}`,
    });
  }

  const firewall = await execText("iptables", ["-S", "AUXINUX_INPUT"]).catch(() => "");
  const sshPort = await fs.readFile("/etc/ssh/sshd_config", "utf8")
    .then((content) => Number(content.match(/^\s*Port\s+(\d+)\s*$/m)?.[1] ?? 22))
    .catch(() => 22);
  const firewallEnabled = firewall.includes("-j DROP");
  const sshProtected = !firewallEnabled || firewall.includes(`--dport ${sshPort} -j ACCEPT`);
  checks.push({
    id: "firewall-ssh",
    label: "Firewall SSH protection",
    ok: sshProtected,
    blocking: true,
    detail: firewallEnabled
      ? `AuxiNux firewall enabled; SSH port ${sshPort} ${sshProtected ? "is allowed" : "is not allowed"}`
      : "AuxiNux firewall is disabled or not enforcing DROP",
  });

  const systemState = await execText("systemctl", ["is-system-running"]).catch((error) => (
    error instanceof Error && "stdout" in error ? String((error as { stdout?: string }).stdout).trim() : "unknown"
  ));
  checks.push({
    id: "systemd-state",
    label: "Systemd state",
    ok: ["running", "degraded"].includes(systemState),
    blocking: false,
    detail: systemState || "unknown",
  });

  return {
    ok: checks.every((check) => !check.blocking || check.ok),
    checks,
  };
}

function schedulePowerAction(command: string, args: string[]) {
  // Delay the action ~2s so the HTTP response can reach the caller before the host goes down.
  // Spawn the command directly — no shell interpolation — to avoid shell metacharacter hazards.
  setTimeout(() => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }, 2000).unref();
  return { ok: true, scheduled: true };
}

async function rebootHost() {
  return schedulePowerAction("systemctl", ["reboot"]);
}

async function shutdownHost() {
  return schedulePowerAction("systemctl", ["poweroff"]);
}
