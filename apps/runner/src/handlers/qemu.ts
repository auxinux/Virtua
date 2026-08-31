import { execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { parseVirtuaConfig, isUnsafeArchivePath } from "@auxinux/shared";
import { resolveCompressor, resolveCompressorForFilename, retargetArchiveExt, decompressorFor, runTarPipeline } from "./compression.js";
import type { ProgressEmitter } from "../runner.js";

const execFileAsync = promisify(execFile);

/** Elapsed running time (seconds) of a host process, via `ps -o etimes=`. */
async function processUptimeSeconds(pid: number): Promise<number | undefined> {
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "etimes=", "-p", String(pid)]);
    const secs = parseInt(stdout.trim(), 10);
    return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the domain XML provisions the org.qemu.guest_agent.0 virtio channel. */
function hasGuestAgentChannel(xml: string): boolean {
  return /<channel\b[\s\S]*?<target[^>]*name=['"]org\.qemu\.guest_agent\.0['"]/i.test(xml);
}

/** Live, uncached test that the in-guest qemu-guest-agent answers a ping. */
async function pingGuestAgent(name: string): Promise<boolean> {
  try {
    await execFileAsync(
      "virsh",
      ["qemu-agent-command", name, '{"execute":"guest-ping"}', "--timeout", "3"],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Discover a running domain's IPv4 addresses, agent first then DHCP lease then ARP. */
async function getVmIpAddresses(name: string, agentRunning: boolean): Promise<string[]> {
  const sources = agentRunning ? ["agent", "lease", "arp"] : ["lease", "arp"];
  for (const source of sources) {
    try {
      const { stdout } = await execFileAsync("virsh", ["domifaddr", name, "--source", source, "--full"], { timeout: 5000 });
      const ips: string[] = [];
      for (const line of stdout.split("\n")) {
        // Columns: Name MAC Protocol Address(CIDR). Keep IPv4, drop loopback/link-local.
        const m = line.match(/\s(ipv4)\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/i);
        if (m && m[2] !== "127.0.0.1") ips.push(m[2]);
      }
      if (ips.length > 0) return [...new Set(ips)];
    } catch {
      /* try next source */
    }
  }
  return [];
}

/** Resolve a running domain's QEMU pid from libvirt's pidfile. */
async function getVmPid(name: string): Promise<number | undefined> {
  for (const file of [`/run/libvirt/qemu/${name}.pid`, `/var/run/libvirt/qemu/${name}.pid`]) {
    try {
      const pid = parseInt((await fs.readFile(file, "utf8")).trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

const IMAGES_DIR = process.env.QEMU_IMAGES_DIR ?? "/var/lib/libvirt/images";
const ISOS_DIR = path.join(IMAGES_DIR, "isos");
const vmCpuSamples = new Map<string, { cpuTimeNs: number; sampledAtMs: number }>();

// ── Input sanitization helpers ──────────────────────────────────────────────
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validateVmName(value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$/.test(value)) {
    throw new Error("Invalid VM name: only alphanumerics, dot, hyphen, underscore are allowed (max 63 chars)");
  }
  return value;
}

function validateMac(value: string): string {
  if (!/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(value)) {
    throw new Error("Invalid MAC address");
  }
  return value;
}

function validateBridge(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,15}$/.test(value)) {
    throw new Error("Invalid bridge name");
  }
  return value;
}

function validateArch(value: string): string {
  const allowed = ["x86_64", "i686", "aarch64", "armv7l", "ppc64le", "s390x"];
  if (!allowed.includes(value)) {
    throw new Error(`Invalid architecture: must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function validateMachine(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value)) {
    throw new Error("Invalid machine type");
  }
  return value;
}

function validatePath(value: string, field: string): string {
  // Reject newlines, nulls, and control chars. Require absolute path.
  if (!value.startsWith("/") || /[\n\r\0<>"&]/.test(value)) {
    throw new Error(`Invalid ${field}: must be an absolute path without control characters or XML/shell metachars`);
  }
  return value;
}

function normalizeUsbId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{4}$/i.test(value.trim())) {
    throw new Error(`Invalid ${field}: must be 4 hexadecimal digits`);
  }
  return value.trim().toLowerCase().replace(/^0x/, "");
}

function normalizeUsbAddress(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  if (!/^\d{1,3}$/.test(raw)) throw new Error(`Invalid USB ${field}: must be 1-3 digits`);
  return raw.padStart(3, "0");
}

let libvirtQemuIdentity: Promise<{ uid: number; gid: number } | null> | null = null;

async function getLibvirtQemuIdentity(): Promise<{ uid: number; gid: number } | null> {
  if (!libvirtQemuIdentity) {
    libvirtQemuIdentity = (async () => {
      for (const user of ["libvirt-qemu", "qemu"]) {
        try {
          const [uidOut, gidOut] = await Promise.all([
            execFileAsync("id", ["-u", user]),
            execFileAsync("id", ["-g", user]),
          ]);
          const uid = parseInt(uidOut.stdout.trim(), 10);
          const gid = parseInt(gidOut.stdout.trim(), 10);
          if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
        } catch {
          /* try next common libvirt account */
        }
      }
      return null;
    })();
  }
  return libvirtQemuIdentity;
}

async function ensureLibvirtStorageDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const dataDir = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinuxvirtual";
  if (dirPath === dataDir || dirPath.startsWith(`${dataDir}${path.sep}`)) {
    // QEMU/libvirt runs as libvirt-qemu/qemu and must be able to traverse the
    // Virtua data root to reach pool files. Execute-only for "others" is enough
    // and avoids making DB/SSL directories listable.
    await fs.chmod(dataDir, 0o711).catch(() => {});
    await fs.chmod(path.join(dataDir, "pools"), 0o755).catch(() => {});
  }
  const identity = await getLibvirtQemuIdentity();
  if (identity) {
    await fs.chown(dirPath, 0, identity.gid).catch(() => {});
    // setgid keeps new qemu-img outputs in the libvirt-readable group.
    await fs.chmod(dirPath, 0o2775).catch(() => {});
  } else {
    await fs.chmod(dirPath, 0o755).catch(() => {});
  }
}

async function ensureLibvirtDiskAccess(filePath: string): Promise<void> {
  await ensureLibvirtStorageDir(path.dirname(filePath));
  const identity = await getLibvirtQemuIdentity();
  if (identity) {
    await fs.chown(filePath, identity.uid, identity.gid).catch(() => {});
    await fs.chmod(filePath, 0o660).catch(() => {});
  } else {
    await fs.chmod(filePath, 0o666).catch(() => {});
  }
}

async function ensureLibvirtIsoDirAccess(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  if (dirPath === IMAGES_DIR || dirPath.startsWith(`${IMAGES_DIR}${path.sep}`)) {
    await fs.chmod(IMAGES_DIR, 0o755).catch(() => {});
  }
  await fs.chmod(dirPath, 0o755).catch(() => {});
}

async function ensureLibvirtIsoAccess(filePath: string): Promise<void> {
  await ensureLibvirtIsoDirAccess(path.dirname(filePath));
  const identity = await getLibvirtQemuIdentity();
  if (identity) {
    await fs.chown(filePath, identity.uid, identity.gid).catch(() => {});
    await fs.chmod(filePath, 0o640).catch(() => {});
  } else {
    await fs.chmod(filePath, 0o644).catch(() => {});
  }
}

function validatePositiveInt(value: unknown, field: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${field}: must be an integer between ${min} and ${max}`);
  }
  return n;
}

export async function handleQemu(action: string, params: unknown, emit?: ProgressEmitter): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case "qemu_vms": return listVms();
    case "qemu_create": return createVm(p);
    case "qemu_delete": return deleteVm(p.name as string, (p.deleteDisks as boolean) ?? true);
    case "qemu_action": return vmAction(p.name as string, p.action as string);
    case "qemu_info": return getVmInfo(p.name as string);
    case "qemu_ensure_spice": return ensureSpiceConsole(p.name as string);
    case "qemu_vnc_password": return { password: await ensureVncPassword(p.name as string) };
    case "qemu_rdp_console_info": return getRdpConsoleInfo(p.name as string);
    case "qemu_rdp_prepare": return prepareRdpConsole(p.name as string);
    case "qemu_update_config": return updateVmConfig(p);
    case "qemu_stats": return getVmStats(p.name as string);
    case "qemu_logs": return getVmLogs(p.name as string, (p.tail as number) ?? 100);
    case "qemu_attach_disk": return attachDisk(p);
    case "qemu_detach_disk": return detachDisk(p.name as string, p.device as string);
    case "qemu_resize_disk": return resizeDisk(p.name as string, p.device as string, p.sizeGb as number);
    case "qemu_attach_network": return attachNetwork(p);
    case "qemu_detach_network": return detachNetwork(p.name as string, p.mac as string);
    case "qemu_update_network": return updateNetwork(p);
    case "qemu_attach_iso": return attachIso(p.name as string, p.isoPath as string);
    case "qemu_eject_iso": return ejectIso(p.name as string);
    case "qemu_usb_attach": return attachUsbDevice(p);
    case "qemu_usb_detach": return detachUsbDevice(p);
    case "qemu_snapshot_create": return createSnapshot(p.name as string, p.snapName as string, p.description as string);
    case "qemu_snapshot_list": return listSnapshots(p.name as string);
    case "qemu_snapshot_rollback": return rollbackSnapshot(p.name as string, p.snapName as string);
    case "qemu_snapshot_delete": return deleteSnapshot(p.name as string, p.snapName as string);
    case "qemu_backup": return backupVm(p, emit);
    case "qemu_restore_backup": return restoreVmBackup(p);
    case "qemu_create_from_template": return createVmFromTemplate(p);
    case "qemu_repair_disk": return repairVmDisk(p);
    case "qemu_rename": return renameVm(p.name as string, p.newName as string);
    case "qemu_clone": return cloneVm(p.name as string, p.newName as string);
    case "qemu_export_template": return exportVmAsTemplate(p.name as string, p.templateName as string, (p.description as string) ?? "", p.outputDir as string, emit);
    case "qemu_bridges": return listBridges();
    case "qemu_machine_types": return listMachineTypes(p.arch as string);
    case "qemu_isos_list": return listIsos();
    case "qemu_iso_delete": return deleteIso(p.filename as string);
    default: throw new Error(`Unknown qemu action: ${action}`);
  }
}

async function virsh(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("virsh", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Serializes "dumpxml -> modify -> virsh define" read-modify-write cycles per
// VM. Without this, concurrent callers (e.g. the VNC and SPICE tabs both
// ensuring their console password around the same time) race: each reads the
// same base XML, and whichever `virsh define` finishes last silently drops
// the other's change (lost update). Every function that redefines a domain
// after reading its current XML must go through this lock.
const vmDefineLocks = new Map<string, Promise<unknown>>();
function withVmDefineLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = vmDefineLocks.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  vmDefineLocks.set(name, tail);
  void tail.then(() => {
    if (vmDefineLocks.get(name) === tail) vmDefineLocks.delete(name);
  });
  return run;
}

async function getDomainState(name: string) {
  try {
    return normalizeState((await virsh("domstate", name)).trim());
  } catch {
    return "unknown";
  }
}

async function resumeIfUnexpectedlyPaused(name: string, initialState: string) {
  if (initialState !== "running") return;
  const currentState = await getDomainState(name);
  if (currentState === "paused") {
    await virsh("resume", name).catch(() => {});
  }
}

async function listVms() {
  const out = await virsh("list", "--all", "--name");
  const names = out.trim().split("\n").filter(Boolean);
  const vms = await Promise.all(names.map(async (name) => {
    try {
      const [info, xml] = await Promise.all([virsh("dominfo", name), virsh("dumpxml", name)]);
      const state = parseField(info, "State") ?? "unknown";
      const vcpus = parseXmlNumberTag(xml, "vcpu") || parseInt(parseField(info, "CPU(s)") ?? "0", 10);
      const maxMem = parseMemoryKiB(xml, "memory") || parseInt(parseField(info, "Max memory") ?? "0", 10);
      const usedMem = parseMemoryKiB(xml, "currentMemory") || parseInt(parseField(info, "Used memory") ?? "0", 10);
      const uuid = parseField(info, "UUID") ?? "";
      const autostart = parseField(info, "Autostart") === "enable";
      const qemuAgentEnabled = hasGuestAgentChannel(xml);
      return {
        name, state: normalizeState(state), vcpus,
        maxMemoryKiB: maxMem, usedMemoryKiB: usedMem,
        memoryMb: Math.round(maxMem / 1024), usedMemoryMb: Math.round(usedMem / 1024),
        uuid, autostart, qemuAgentEnabled,
      };
    } catch {
      return { name, state: "unknown", vcpus: 0, maxMemoryKiB: 0, usedMemoryKiB: 0, memoryMb: 0, usedMemoryMb: 0, uuid: "", autostart: false, qemuAgentEnabled: false };
    }
  }));
  return vms;
}

function parseField(text: string, field: string): string | null {
  const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : null;
}

function normalizeState(s: string): string {
  if (s.includes("running")) return "running";
  if (s.includes("shut")) return "stopped";
  if (s.includes("paus")) return "paused";
  if (s.includes("suspend")) return "suspended";
  return "unknown";
}

function parseXmlNumberTag(xml: string, tag: string): number {
  const match = xml.match(new RegExp(`<${tag}(?:\\s+[^>]*)?>(\\d+)</${tag}>`, "i"));
  return match ? parseInt(match[1], 10) : 0;
}

function parseMemoryKiB(xml: string, tag: "memory" | "currentMemory"): number {
  const match = xml.match(new RegExp(`<${tag}(?:\\s+unit=['"]([^'"]+)['"])?(?:\\s+[^>]*)?>(\\d+)</${tag}>`, "i"));
  if (!match) return 0;
  const unit = (match[1] ?? "KiB").toLowerCase();
  const value = parseInt(match[2], 10);
  if (unit === "kib") return value;
  if (unit === "mib") return value * 1024;
  if (unit === "gib") return value * 1024 * 1024;
  if (unit === "b") return Math.floor(value / 1024);
  return value;
}

function parseDiskBlocks(xml: string) {
  return [...xml.matchAll(/<disk\b[\s\S]*?<\/disk>/g)]
    .map((match) => {
      const block = match[0];
      const deviceType = block.match(/device=['"]([^'"]+)['"]/)?.[1] ?? "";
      const source = block.match(/<source[^>]*file=['"]([^'"]+)['"]/)?.[1] ?? "";
      const device = block.match(/<target[^>]*dev=['"]([^'"]+)['"]/)?.[1] ?? "";
      const bus = block.match(/bus=['"]([^'"]+)['"]/)?.[1] ?? "virtio";
      const format = block.match(/<driver[^>]*type=['"]([^'"]+)['"]/)?.[1] ?? (deviceType === "cdrom" ? "raw" : "qcow2");
      const readonly = /<readonly\s*\/?>/i.test(block) || deviceType === "cdrom";
      return { deviceType, source, device, bus, format, readonly };
    })
    .filter((disk) => disk.device && (disk.deviceType === "disk" || disk.deviceType === "cdrom"));
}

function parseDiskXmlBlocks(xml: string) {
  return [...xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)]
    .map((match) => {
      const block = match[0];
      const deviceType = block.match(/device=['"]([^'"]+)['"]/)?.[1] ?? "";
      const source = block.match(/<source[^>]*file=['"]([^'"]+)['"]/)?.[1] ?? "";
      const device = block.match(/<target[^>]*dev=['"]([^'"]+)['"]/)?.[1] ?? "";
      const readonly = /<readonly\s*\/?>/i.test(block) || deviceType === "cdrom";
      return { block, deviceType, source, device, readonly };
    })
    .filter((disk) => disk.device);
}

function nextDiskTarget(usedDevices: string[], bus: "sata" | "ide" = "sata") {
  const prefix = bus === "ide" ? "hd" : "sd";
  const used = new Set(usedDevices);
  for (let i = 0; i < 26; i += 1) {
    const dev = `${prefix}${String.fromCharCode(97 + i)}`;
    if (!used.has(dev)) return dev;
  }
  throw new Error(`No available ${bus.toUpperCase()} target device`);
}

function parseInterfaceBlocks(xml: string) {
  return [...xml.matchAll(/<interface\b[\s\S]*?<\/interface>/gi)].map((match) => {
    const block = match[0];
    return {
      block,
      mac: block.match(/<mac[^>]*address=['"]([^'"]+)['"]/i)?.[1]?.toLowerCase() ?? "",
      bridge: block.match(/<source[^>]*bridge=['"]([^'"]+)['"]/i)?.[1] ?? "",
      network: block.match(/<source[^>]*network=['"]([^'"]+)['"]/i)?.[1] ?? "",
      model: block.match(/<model[^>]*type=['"]([^'"]+)['"]/i)?.[1] ?? "virtio",
    };
  });
}

function parseUsbHostdevBlocks(xml: string) {
  return [...xml.matchAll(/<hostdev\b[\s\S]*?<\/hostdev>/gi)]
    .map((match) => {
      const block = match[0];
      if (!/type=['"]usb['"]/i.test(block)) return null;
      const vendorId = block.match(/<vendor[^>]*id=['"](?:0x)?([0-9a-f]{4})['"]/i)?.[1]?.toLowerCase() ?? "";
      const productId = block.match(/<product[^>]*id=['"](?:0x)?([0-9a-f]{4})['"]/i)?.[1]?.toLowerCase() ?? "";
      const bus = block.match(/<address[^>]*bus=['"](\d+)['"]/i)?.[1]?.padStart(3, "0");
      const device = block.match(/<address[^>]*device=['"](\d+)['"]/i)?.[1]?.padStart(3, "0");
      if (!vendorId || !productId) return null;
      return {
        block,
        type: "usb" as const,
        id: `${vendorId}:${productId}${bus && device ? `:${bus}:${device}` : ""}`,
        vendorId,
        productId,
        label: `${vendorId}:${productId}`,
        bus,
        device,
        persistent: !(bus && device),
      };
    })
    .filter(Boolean) as Array<{ block: string; type: "usb"; id: string; vendorId: string; productId: string; label: string; bus?: string; device?: string; persistent?: boolean }>;
}

function extractSnapshotDescription(xml: string) {
  return xml.match(/<description>([\s\S]*?)<\/description>/i)?.[1]?.trim() ?? "";
}

function parseSnapshotDiskSources(xml: string) {
  return [...xml.matchAll(/<disk\b[\s\S]*?<\/disk>/g)].map((match) => {
    const block = match[0];
    const name = block.match(/name=['"]([^'"]+)['"]/)?.[1] ?? "";
    const snapshot = block.match(/snapshot=['"]([^'"]+)['"]/)?.[1] ?? "";
    const source = block.match(/<source[^>]*file=['"]([^'"]+)['"]/)?.[1] ?? "";
    return { name, snapshot, source };
  }).filter((disk) => disk.name);
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interfaceExists(name: string) {
  try {
    await execFileAsync("ip", ["link", "show", "dev", name]);
    return true;
  } catch {
    return false;
  }
}

async function waitForInterface(name: string, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await interfaceExists(name)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function ensureInterfaceUp(name: string) {
  await execFileAsync("ip", ["link", "set", "dev", name, "up"]).catch(() => {});
}

async function ensureDefaultLibvirtNetworkDefined() {
  try {
    await execFileAsync("virsh", ["net-info", "default"]);
    return;
  } catch {
    // Define the standard libvirt default NAT network if the host does not have it yet.
  }

  const xml = [
    `<network>`,
    `  <name>default</name>`,
    `  <forward mode="nat"/>`,
    `  <bridge name="virbr0" stp="on" delay="0"/>`,
    `  <ip address="192.168.122.1" netmask="255.255.255.0">`,
    `    <dhcp>`,
    `      <range start="192.168.122.2" end="192.168.122.254"/>`,
    `    </dhcp>`,
    `  </ip>`,
    `</network>`,
  ].join("\n");

  const tmp = `/tmp/auxinux-libvirt-default-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    await execFileAsync("virsh", ["net-define", tmp]);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function ensureLibvirtNetworkReady(networkName: string) {
  const normalized = networkName.trim();
  if (!normalized) {
    throw new Error("A libvirt network name is required");
  }

  if (normalized === "default") {
    await ensureDefaultLibvirtNetworkDefined();
  }

  await execFileAsync("systemctl", ["enable", "virtnetworkd.service"]).catch(() => {});
  await execFileAsync("systemctl", ["start", "virtnetworkd.service"]).catch(() => {});
  await execFileAsync("systemctl", ["start", "libvirtd.service"]).catch(() => {});
  await execFileAsync("virsh", ["net-autostart", normalized]).catch(() => {});
  await execFileAsync("virsh", ["net-start", normalized]).catch(() => {});

  if (normalized === "default") {
    if (await interfaceExists("virbr0")) {
      await ensureInterfaceUp("virbr0");
      return;
    }
    if (await waitForInterface("virbr0")) {
      await ensureInterfaceUp("virbr0");
      return;
    }
    throw new Error("Bridge virbr0 is unavailable. Ensure the libvirt default network is active.");
  }
}

/** Best-effort repair of an AuxiNux-managed bridge (missing, or uplink unenslaved). */
async function tryBridgeHeal(bridge: string) {
  await execFileAsync("/usr/local/sbin/virtua-bridge-heal", [bridge], { timeout: 60_000 }).catch(() => {});
}

/** True when the bridge has at least one enslaved port (uplink or guest veth). */
async function bridgeHasAnyPort(bridge: string) {
  const ports = await fs.readdir(`/sys/class/net/${bridge}/brif`).catch(() => null);
  return ports !== null && ports.length > 0;
}

async function ensureVmBridgeReady(bridge: string) {
  const normalized = bridge.trim();
  if (!normalized) {
    throw new Error("A bridge name is required for VM networking");
  }

  if (normalized === "virbr0") {
    await ensureLibvirtNetworkReady("default");
    return;
  }

  if (!(await interfaceExists(normalized))) {
    // A reboot/update may have torn the managed bridge down — self-heal first.
    await tryBridgeHeal(normalized);
    if (!(await interfaceExists(normalized))) {
      throw new Error(`Bridge ${normalized} does not exist on the host`);
    }
  } else if (!(await bridgeHasAnyPort(normalized))) {
    // Bridge exists but is port-less: if it is one of ours with a configured
    // uplink, re-enslave it so the guest actually gets connectivity. Harmless
    // no-op for unmanaged or intentionally isolated bridges.
    await tryBridgeHeal(normalized);
  }
  await ensureInterfaceUp(normalized);
}

async function ensureVmInterfacesReady(xml: string) {
  for (const iface of parseInterfaceBlocks(xml)) {
    if (iface.bridge) {
      await ensureVmBridgeReady(iface.bridge);
      continue;
    }
    if (iface.network) {
      await ensureLibvirtNetworkReady(iface.network);
    }
  }
}

async function getQemuImgInfo(filePath: string): Promise<{ format?: string; backingFile?: string; fullBackingFile?: string } | null> {
  try {
    const { stdout } = await execFileAsync("qemu-img", ["info", "--output=json", filePath]);
    const parsed = JSON.parse(stdout) as {
      format?: string;
      "backing-filename"?: string;
      "full-backing-filename"?: string;
    };
    return {
      format: parsed.format,
      backingFile: parsed["backing-filename"],
      fullBackingFile: parsed["full-backing-filename"],
    };
  } catch {
    return null;
  }
}

function replaceDiskSource(xml: string, device: string, nextSource: string) {
  const targetDisk = parseDiskXmlBlocks(xml).find((disk) => disk.device === device);
  if (!targetDisk?.block) {
    return xml;
  }

  let diskXml = targetDisk.block;
  if (/<source\b[^>]*file=['"][^'"]+['"][^>]*\/?>/i.test(diskXml)) {
    diskXml = diskXml.replace(/(<source\b[^>]*file=['"])[^'"]+(['"][^>]*\/?>)/i, `$1${nextSource}$2`);
  } else if (/<driver\b[^>]*\/>/i.test(diskXml)) {
    diskXml = diskXml.replace(/(<driver\b[^>]*\/>)/i, `$1\n      <source file="${nextSource}"/>`);
  } else {
    diskXml = diskXml.replace(/<disk\b([^>]*)>/i, `<disk$1>\n      <source file="${nextSource}"/>`);
  }

  return xml.replace(targetDisk.block, diskXml);
}

function replaceXmlTag(xml: string, tag: string, value: string, attrs = "") {
  const replacement = `<${tag}${attrs}>${value}</${tag}>`;
  const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>[^<]*</${tag}>`, "i");
  return regex.test(xml) ? xml.replace(regex, replacement) : xml.replace("</domain>", `  ${replacement}\n</domain>`);
}

function ensureSerialConsole(xml: string) {
  let updated = xml;
  if (!/<serial\b/i.test(updated)) {
    updated = updated.replace("</devices>", `    <serial type="pty"><target port="0"/></serial>\n  </devices>`);
  }
  if (!/<console\b/i.test(updated)) {
    updated = updated.replace("</devices>", `    <console type="pty"><target type="serial" port="0"/></console>\n  </devices>`);
  }
  return updated;
}

function ensureGuestAgentChannel(xml: string, enabled: boolean) {
  const withoutAgent = xml.replace(/\s*<channel\b[\s\S]*?<target[^>]*name=['"]org\.qemu\.guest_agent\.0['"][\s\S]*?<\/channel>\n?/i, "\n");
  if (!enabled) return withoutAgent;
  if (/<channel\b[\s\S]*?<target[^>]*name=['"]org\.qemu\.guest_agent\.0['"][\s\S]*?<\/channel>/i.test(xml)) {
    return xml;
  }
  return withoutAgent.replace(
    "</devices>",
    `    <channel type="unix"><source mode="bind"/><target type="virtio" name="org.qemu.guest_agent.0"/></channel>\n  </devices>`
  );
}

function buildVideoBlock(model: "vga" | "virtio" | "qxl") {
  if (model === "virtio") {
    // virtio-gpu WITHOUT 3D acceleration. Enabling accel3d="yes" makes
    // libvirt instantiate `virtio-vga-gl` on the QEMU side, which only
    // works if the display backend has OpenGL turned on (SPICE+gl, or
    // -display egl-headless). VNC — the default we expose via noVNC —
    // does not support GL, and QEMU refuses to start with:
    //   "The display backend does not have OpenGL support enabled"
    // VirGL acceleration belongs to a future SPICE-graphics code path,
    // not the default headless-server experience.
    return `    <video><model type="virtio" heads="1" primary="yes" vram="65536"/></video>`;
  }
  if (model === "qxl") {
    // vgamem bounds the primary surface: 16M tops out around 1920x1080, which
    // silently breaks SPICE auto-resize above that. 64M covers 4K (3840x2160x4).
    return `    <video><model type="qxl" ram="131072" vram="131072" vgamem="65536" heads="1" primary="yes"/></video>`;
  }
  return `    <video><model type="vga" vram="16384" heads="1" primary="yes"/></video>`;
}

function buildSpiceGraphicsBlock(indent = "    ") {
  return [
    `${indent}<graphics type="spice" port="-1" autoport="yes" listen="127.0.0.1">`,
    `${indent}  <listen type="address" address="127.0.0.1"/>`,
    `${indent}  <playback compression="on"/>`,
    `${indent}  <clipboard copypaste="no"/>`,
    `${indent}  <filetransfer enable="no"/>`,
    `${indent}</graphics>`,
  ].join("\n");
}

function buildSpiceAudioBlocks(indent = "    ", id = 1) {
  return [
    `${indent}<sound model="ich9">`,
    `${indent}  <codec type="duplex"/>`,
    `${indent}  <audio id="${id}"/>`,
    `${indent}</sound>`,
    `${indent}<audio id="${id}" type="spice"/>`,
  ].join("\n");
}

function parseSpiceGraphics(xml: string): { enabled: boolean; host: string; port?: number; tlsPort?: number } {
  const block = xml.match(/<graphics\b[^>]*type=['"]spice['"][\s\S]*?(?:<\/graphics>|\/>)/i)?.[0];
  if (!block) return { enabled: false, host: "127.0.0.1" };
  const portRaw = block.match(/\bport=['"](-?\d+)['"]/i)?.[1];
  const tlsPortRaw = block.match(/\btlsPort=['"](-?\d+)['"]/i)?.[1];
  const listen =
    block.match(/<listen[^>]*address=['"]([^'"]+)['"]/i)?.[1]
    ?? block.match(/\blisten=['"]([^'"]+)['"]/i)?.[1]
    ?? "127.0.0.1";
  const port = portRaw ? parseInt(portRaw, 10) : undefined;
  const tlsPort = tlsPortRaw ? parseInt(tlsPortRaw, 10) : undefined;
  return {
    enabled: true,
    host: listen || "127.0.0.1",
    port: port && port > 0 ? port : undefined,
    tlsPort: tlsPort && tlsPort > 0 ? tlsPort : undefined,
  };
}

function parseVncGraphicsBlock(xml: string): string | undefined {
  return xml.match(/<graphics\b[^>]*type=['"]vnc['"][\s\S]*?(?:<\/graphics>|\/>)/i)?.[0];
}

function parseVncPassword(xml: string): string | undefined {
  const block = parseVncGraphicsBlock(xml);
  return block?.match(/\bpasswd=['"]([^'"]+)['"]/i)?.[1];
}

function setVncPasswordInXml(xml: string, password: string) {
  const block = parseVncGraphicsBlock(xml);
  if (!block) throw new Error("VM has no VNC graphics device");
  let nextBlock = block;
  if (/\bpasswd=['"][^'"]*['"]/i.test(nextBlock)) {
    nextBlock = nextBlock.replace(/\bpasswd=['"][^'"]*['"]/i, `passwd='${xmlEscape(password)}'`);
  } else {
    nextBlock = nextBlock.replace(/<graphics\b/i, `<graphics passwd='${xmlEscape(password)}'`);
  }
  return xml.replace(block, nextBlock);
}

function generateVncPassword(): string {
  // libvirt/QEMU VNC passwords are limited to 8 bytes.
  return randomBytes(4).toString("hex");
}

// Dump domain XML for a read-modify-write "virsh define" cycle. MUST include
// --security-info: without it libvirt redacts the <graphics passwd='...'>
// attribute (VNC and SPICE), so the following define silently wipes the console
// password. QEMU then starts the display with ticketing enabled but no password
// and refuses every client with "Permission denied". Falls back to the plain
// dump only if this libvirt build rejects the flag.
async function dumpDomainXmlForDefine(name: string, inactive: boolean): Promise<string> {
  const args = inactive ? ["dumpxml", name, "--inactive"] : ["dumpxml", name];
  return virsh(...args, "--security-info").catch(() => virsh(...args));
}

async function ensureVncPassword(name: string): Promise<string> {
  const password = await withVmDefineLock(name, async () => {
    // --security-info is required or libvirt redacts the passwd attribute
    // entirely from dumpxml output, making the "is there already a password"
    // check below always see nothing and regenerate (and redefine!) a brand
    // new password on every single call.
    const inactiveXml = await virsh("dumpxml", name, "--inactive", "--security-info").catch(() => virsh("dumpxml", name, "--security-info"));
    const existing = parseVncPassword(inactiveXml);
    const pw = existing && existing.length > 0 && existing.length <= 8 ? existing : generateVncPassword();
    if (!existing || existing !== pw) {
      const updated = setVncPasswordInXml(inactiveXml, pw);
      const tmp = path.join("/tmp", `virtua-${process.pid}-${Date.now()}-${name}-vnc.xml`);
      await fs.writeFile(tmp, updated, "utf8");
      try {
        await virsh("define", tmp);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    return pw;
  });

  const state = await getDomainState(name);
  if (state === "running" || state === "paused") {
    const setPassword = {
      execute: "set_password",
      arguments: { protocol: "vnc", password, connected: "keep" },
    };
    const expirePassword = {
      execute: "expire_password",
      arguments: { protocol: "vnc", time: "never" },
    };
    await execFileAsync("virsh", ["qemu-monitor-command", name, JSON.stringify(setPassword)], { timeout: 5000 }).catch(async () => {
      await execFileAsync("virsh", ["qemu-monitor-command", name, "--hmp", `set_password vnc ${password}`], { timeout: 5000 });
    });
    await execFileAsync("virsh", ["qemu-monitor-command", name, JSON.stringify(expirePassword)], { timeout: 5000 }).catch(async () => {
      await execFileAsync("virsh", ["qemu-monitor-command", name, "--hmp", "expire_password vnc never"], { timeout: 5000 }).catch(() => {});
    });
  }
  return password;
}

function parseSpiceGraphicsBlock(xml: string): string | undefined {
  return xml.match(/<graphics\b[^>]*type=['"]spice['"][\s\S]*?(?:<\/graphics>|\/>)/i)?.[0];
}

function parseSpicePassword(xml: string): string | undefined {
  const block = parseSpiceGraphicsBlock(xml);
  return block?.match(/\bpasswd=['"]([^'"]+)['"]/i)?.[1];
}

function setSpicePasswordInXml(xml: string, password: string) {
  const block = parseSpiceGraphicsBlock(xml);
  if (!block) throw new Error("VM has no SPICE graphics device");
  let nextBlock = block;
  if (/\bpasswd=['"][^'"]*['"]/i.test(nextBlock)) {
    nextBlock = nextBlock.replace(/\bpasswd=['"][^'"]*['"]/i, `passwd='${xmlEscape(password)}'`);
  } else {
    nextBlock = nextBlock.replace(/<graphics\b/i, `<graphics passwd='${xmlEscape(password)}'`);
  }
  return xml.replace(block, nextBlock);
}

async function ensureSpicePassword(name: string): Promise<string> {
  const password = await withVmDefineLock(name, async () => {
    // Same libvirt redaction caveat as ensureVncPassword: without
    // --security-info the passwd attribute is stripped from dumpxml output.
    const inactiveXml = await virsh("dumpxml", name, "--inactive", "--security-info").catch(() => virsh("dumpxml", name, "--security-info"));
    const existing = parseSpicePassword(inactiveXml);
    // No hard length cap for SPICE (unlike VNC's 8-byte limit); keep it short
    // anyway for consistency and to match what's shown/copied in the UI.
    const pw = existing && existing.length > 0 && existing.length <= 16 ? existing : generateVncPassword();
    if (!existing || existing !== pw) {
      const updated = setSpicePasswordInXml(inactiveXml, pw);
      const tmp = path.join("/tmp", `virtua-${process.pid}-${Date.now()}-${name}-spice.xml`);
      await fs.writeFile(tmp, updated, "utf8");
      try {
        await virsh("define", tmp);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    return pw;
  });

  const state = await getDomainState(name);
  const liveXml = state === "running" || state === "paused"
    ? await virsh("dumpxml", name).catch(() => "")
    : "";
  // A newly-added SPICE device exists only in the inactive XML until the VM
  // restarts. Do not send QMP password commands before the live device exists;
  // ensureSpiceConsole() will report requiresRestart to the caller instead.
  if ((state === "running" || state === "paused") && parseSpiceGraphicsBlock(liveXml)) {
    const setPassword = {
      execute: "set_password",
      arguments: { protocol: "spice", password, connected: "keep" },
    };
    const expirePassword = {
      execute: "expire_password",
      arguments: { protocol: "spice", time: "never" },
    };
    await execFileAsync("virsh", ["qemu-monitor-command", name, JSON.stringify(setPassword)], { timeout: 5000 }).catch(async () => {
      await execFileAsync("virsh", ["qemu-monitor-command", name, "--hmp", `set_password spice ${password}`], { timeout: 5000 });
    });
    await execFileAsync("virsh", ["qemu-monitor-command", name, JSON.stringify(expirePassword)], { timeout: 5000 }).catch(async () => {
      await execFileAsync("virsh", ["qemu-monitor-command", name, "--hmp", "expire_password spice never"], { timeout: 5000 }).catch(() => {});
    });
  }
  return password;
}

function ensureSpiceGraphics(xml: string) {
  let updated = xml;
  let changed = false;
  if (!/<graphics\b[^>]*type=['"]spice['"]/i.test(updated)) {
    updated = updated.replace("</devices>", `${buildSpiceGraphicsBlock()}\n  </devices>`);
    changed = true;
  } else {
    const graphicsBlock = updated.match(/<graphics\b[^>]*type=['"]spice['"][\s\S]*?<\/graphics>/i)?.[0];
    if (graphicsBlock) {
      const playback = graphicsBlock.match(/<playback\b[^>]*\/?\s*>/i)?.[0];
      const nextGraphics = !playback
        ? graphicsBlock.replace("</graphics>", `  <playback compression="on"/>\n    </graphics>`)
        : /\bcompression=['"]on['"]/i.test(playback)
          ? graphicsBlock
          : graphicsBlock.replace(
              playback,
              /\bcompression=['"][^'"]*['"]/i.test(playback)
                ? playback.replace(/\bcompression=['"][^'"]*['"]/i, `compression="on"`)
                : playback.replace(/\/?\s*>$/, ` compression="on"/>`),
            );
      if (nextGraphics !== graphicsBlock) {
        updated = updated.replace(graphicsBlock, nextGraphics);
        changed = true;
      }
    }
  }

  const spiceAudio = updated.match(/<audio\b[^>]*\btype=['"]spice['"][^>]*\/?\s*>/i)?.[0];
  let audioId = spiceAudio?.match(/\bid=['"](\d+)['"]/i)?.[1];
  if (!audioId) {
    const usedIds = [...updated.matchAll(/<audio\b[^>]*\bid=['"](\d+)['"]/gi)].map((match) => parseInt(match[1], 10));
    audioId = String(Math.max(0, ...usedIds) + 1);
    updated = updated.replace("</devices>", `    <audio id="${audioId}" type="spice"/>\n  </devices>`);
    changed = true;
  }

  const soundBlock = updated.match(/<sound\b[\s\S]*?<\/sound>/i)?.[0];
  const soundSelfClosing = updated.match(/<sound\b[^>]*\/>/i)?.[0];
  if (soundBlock) {
    const currentSoundAudioId = soundBlock.match(/<audio\b[^>]*\bid=['"](\d+)['"][^>]*\/>/i)?.[1];
    const nextSound = currentSoundAudioId === audioId
      ? soundBlock
      : currentSoundAudioId
        ? soundBlock.replace(/<audio\b[^>]*\bid=['"]\d+['"][^>]*\/>/i, `<audio id="${audioId}"/>`)
        : soundBlock.replace("</sound>", `  <audio id="${audioId}"/>\n    </sound>`);
    if (nextSound !== soundBlock) {
      updated = updated.replace(soundBlock, nextSound);
      changed = true;
    }
  } else if (soundSelfClosing) {
    const openSound = soundSelfClosing.replace(/\s*\/>$/, ">") + `<audio id="${audioId}"/></sound>`;
    updated = updated.replace(soundSelfClosing, openSound);
    changed = true;
  } else {
    updated = updated.replace("</devices>", `${buildSpiceAudioBlocks("    ", parseInt(audioId, 10)).split("\n").slice(0, 4).join("\n")}\n  </devices>`);
    changed = true;
  }

  return { xml: updated, changed };
}

function ensureVideoModel(xml: string, model: "vga" | "virtio" | "qxl") {
  const videoBlock = buildVideoBlock(model);
  if (/<video\b[\s\S]*?<\/video>/i.test(xml)) {
    return xml.replace(/<video\b[\s\S]*?<\/video>/i, videoBlock);
  }
  return xml.replace("</devices>", `${videoBlock}\n  </devices>`);
}

function buildCpuBlock(vcpus: number) {
  const cores = Math.max(1, Math.floor(vcpus));
  return `<cpu mode="host-passthrough" check="none" migratable="on"><topology sockets="1" cores="${cores}" threads="1"/></cpu>`;
}

function ensurePerformanceDefaults(xml: string) {
  let updated = xml;
  const vcpus = parseXmlNumberTag(updated, "vcpu") || 1;
  const cpuBlock = buildCpuBlock(vcpus);

  if (/<cpu\b[\s\S]*?<\/cpu>/i.test(updated)) {
    updated = updated.replace(/<cpu\b[\s\S]*?<\/cpu>/i, cpuBlock);
  } else if (/<cpu\b[^>]*\/>/i.test(updated)) {
    updated = updated.replace(/<cpu\b[^>]*\/>/i, cpuBlock);
  } else {
    updated = updated.replace(/(<features>[\s\S]*?<\/features>)/i, `$1\n  ${cpuBlock}`);
  }

  // One IOThread per virtio-blk disk gives it its own I/O thread instead of
  // sharing the main vCPU event loop, which cuts I/O latency under load.
  // (virtio-scsi disks get their iothread on the <controller>, not here —
  // left untouched to avoid disturbing existing scsi controller definitions.)
  const ioThreadCount = [...updated.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)]
    .filter((m) => /device=['"]disk['"]/i.test(m[0]) && /bus=['"]virtio['"]/i.test(m[0])).length;

  let diskIndex = 0;
  updated = updated.replace(/<disk\b[\s\S]*?<\/disk>/gi, (block) => {
    if (!/device=['"]disk['"]/i.test(block)) return block;
    return block.replace(
      /<driver\s+name=['"]qemu['"]\s+type=['"]([^'"]+)['"][^>]*\/>/i,
      (_driverTag, type) => {
        if (/bus=['"]virtio['"]/i.test(block)) {
          diskIndex += 1;
          return `<driver name="qemu" type="${type}" cache="none" io="native" discard="unmap" iothread="${diskIndex}"/>`;
        }
        return `<driver name="qemu" type="${type}" cache="none" io="native" discard="unmap"/>`;
      }
    );
  });

  // Declare the iothread pool the disk drivers above reference, and drop it
  // again if no eligible (virtio/scsi) disk remains — keeps the XML consistent.
  updated = updated.replace(/\s*<iothreads>\d+<\/iothreads>\n?/i, "\n");
  if (ioThreadCount > 0) {
    updated = updated.replace(/(<vcpu\b[^>]*>[^<]*<\/vcpu>)/i, `$1\n  <iothreads>${ioThreadCount}</iothreads>`);
  }

  // Multiqueue virtio-net: one queue per vCPU (capped) so a single vCPU isn't
  // a network throughput bottleneck on multi-core guests.
  const netQueues = Math.min(8, Math.max(1, vcpus));
  updated = updated.replace(/<interface\b[\s\S]*?<\/interface>/gi, (block) => {
    if (!/<model\s+type=['"]virtio['"]/i.test(block)) return block;
    let next = block.replace(/\s*<driver\b[^>]*\/>\s*/i, "");
    next = next.replace(/(<model\s+type=['"]virtio['"]\s*\/>)/i, `<driver name="vhost" queues="${netQueues}"/>\n      $1`);
    return next;
  });

  return updated;
}

/**
 * The SPICE guest agent (vdagent / vdservice on Windows, shipped by the guest
 * tools) talks to the host over a spicevmc virtio-serial channel. Without the
 * channel device the agent is installed but MUTE: no display auto-resize, no
 * clipboard sync. The web console's ResizeObserver → resize_window() messages
 * land nowhere.
 */
function ensureSpiceAgentChannel(xml: string) {
  if (/<channel\b[^>]*type=['"]spicevmc['"]/i.test(xml) || /name=['"]com\.redhat\.spice\.0['"]/i.test(xml)) return xml;
  return xml.replace("</devices>", `    <channel type="spicevmc"><target type="virtio" name="com.redhat.spice.0"/></channel>\n  </devices>`);
}

/**
 * Guests must not be able to put the VM to sleep: Windows' default power plan
 * S3-suspends after ~30 min idle, leaving the domain "pmsuspended" — looks
 * dead from the panel and no console answers. Removing S3/S4 from the virtual
 * hardware makes the guest OS hide its sleep options entirely.
 */
function ensureGuestPmDisabled(xml: string) {
  const pmBlock = `  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>`;
  const withoutPm = xml.replace(/\s*<pm\b[\s\S]*?<\/pm>/i, "").replace(/\s*<pm\b[^>]*\/>/i, "");
  return withoutPm.replace(/(\n\s*<devices>)/i, `\n${pmBlock}$1`);
}

/**
 * Graphical consoles (noVNC / SPICE web) need an absolute-coordinate pointer:
 * with the default PS/2 relative mouse the guest cursor drifts away from the
 * browser cursor and "escapes" the canvas edges. A USB tablet reports absolute
 * positions, so the cursor tracks 1:1 without any capture, on every guest OS.
 */
function ensureUsbTabletInput(xml: string) {
  if (/<input\b[^>]*type=['"]tablet['"]/i.test(xml)) return xml;
  return xml.replace("</devices>", `    <input type="tablet" bus="usb"/>\n  </devices>`);
}

function ensureTpm(xml: string, enabled: boolean) {
  const withoutTpm = xml.replace(/\s*<tpm\b[\s\S]*?<\/tpm>\n?/i, "\n");
  if (!enabled) return withoutTpm;
  return withoutTpm.replace("</devices>", `    <tpm model="tpm-crb"><backend type="emulator" version="2.0"/></tpm>\n  </devices>`);
}

function applyBootOrder(xml: string, primary: "hd" | "cdrom" | "network") {
  const rest = ["hd", "cdrom", "network"].filter((entry) => entry !== primary);
  const bootLines = [primary, ...rest].map((device) => `    <boot dev="${device}"/>`).join("\n");
  const cleaned = xml.replace(/\s*<boot dev=['"][^'"]+['"]\s*\/>\n?/g, "\n");
  return cleaned.replace(/<os\b([^>]*)>([\s\S]*?)<\/os>/i, (_full, attrs, inner) => {
    return `<os${attrs}>${inner.replace(/\n\s*\n/g, "\n")}\n${bootLines}\n  </os>`;
  });
}

async function defineBootOrder(name: string, primary: "hd" | "cdrom" | "network") {
  const xml = await dumpDomainXmlForDefine(name, true);
  const updated = applyBootOrder(xml, primary);
  const tmp = `/tmp/auxinux-boot-order-${name}-${Date.now()}.xml`;
  await fs.writeFile(tmp, updated);
  try {
    await virsh("define", tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function findFilesRecursive(root: string, matcher: (fullPath: string) => boolean, results: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await findFilesRecursive(fullPath, matcher, results);
      continue;
    }
    if (matcher(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDomainIdentity(xml: string) {
  return xml
    .replace(/\s*<uuid>[\s\S]*?<\/uuid>\n?/i, "\n")
    .replace(/\s*<seclabel\b[\s\S]*?<\/seclabel>\n?/gi, "\n");
}

function updateInterfaceBridge(xml: string, bridge?: string, mac?: string) {
  const interfaceMatch = xml.match(/<interface\b[\s\S]*?<\/interface>/i);
  if (!interfaceMatch) return xml;
  let block = interfaceMatch[0];
  if (bridge) {
    if (/<source\b[^>]*bridge=['"][^'"]+['"]/i.test(block)) {
      block = block.replace(/(<source\b[^>]*bridge=['"])[^'"]+(['"][^>]*>)/i, `$1${bridge}$2`);
    } else {
      block = block.replace(/<interface\b([^>]*)>/i, `<interface$1><source bridge="${bridge}"/>`);
    }
  }
  if (mac) {
    if (/<mac\b[^>]*address=['"][^'"]+['"]/i.test(block)) {
      block = block.replace(/(<mac\b[^>]*address=['"])[^'"]+(['"][^>]*\/>)/i, `$1${mac}$2`);
    } else {
      block = block.replace(/<interface\b([^>]*)>/i, `<interface$1><mac address="${mac}"/>`);
    }
  }
  return xml.replace(interfaceMatch[0], block);
}

function buildImportedVmXml(options: {
  name: string;
  arch: string;
  machine: string;
  uefi: boolean;
  loader?: string;
  vcpus: number;
  memoryMb: number;
  diskPath: string;
  bridge: string;
  mac?: string;
  bootDevice: "hd" | "cdrom" | "network";
  qemuAgentEnabled: boolean;
  videoModel: "vga" | "virtio" | "qxl";
}) {
  const xmlLines = [
    `<domain type="kvm">`,
    `  <name>${options.name}</name>`,
    `  <memory unit="MiB">${options.memoryMb}</memory>`,
    `  <currentMemory unit="MiB">${options.memoryMb}</currentMemory>`,
    `  <vcpu>${options.vcpus}</vcpu>`,
    `  <os>`,
    `    <type arch="${options.arch}" machine="${options.machine}">hvm</type>`,
    options.uefi && options.loader ? `    <loader readonly="yes" type="pflash">${options.loader}</loader>` : "",
    `    <boot dev="${options.bootDevice}"/>`,
    ...["hd", "cdrom", "network"].filter((entry) => entry !== options.bootDevice).map((entry) => `    <boot dev="${entry}"/>`),
    `  </os>`,
    `  <features><acpi/><apic/></features>`,
    `  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>`,
    `  ${buildCpuBlock(options.vcpus)}`,
    `  <devices>`,
    `    <emulator>/usr/bin/qemu-system-${options.arch}</emulator>`,
    `    <disk type="file" device="disk">`,
    `      <driver name="qemu" type="qcow2" cache="none" io="native" discard="unmap"/>`,
    `      <source file="${options.diskPath}"/>`,
    `      <target dev="vda" bus="virtio"/>`,
    `    </disk>`,
    `    <interface type="bridge">`,
    options.mac ? `      <mac address="${options.mac}"/>` : "",
    `      <source bridge="${options.bridge}"/>`,
    `      <model type="virtio"/>`,
    `    </interface>`,
    `    <graphics type="vnc" autoport="yes" listen="127.0.0.1"><listen type="address" address="127.0.0.1"/></graphics>`,
    buildSpiceGraphicsBlock(),
    buildSpiceAudioBlocks(),
    buildVideoBlock(options.videoModel),
    `    <input type="tablet" bus="usb"/>`,
    `    <channel type="spicevmc"><target type="virtio" name="com.redhat.spice.0"/></channel>`,
    options.qemuAgentEnabled ? `    <channel type="unix"><source mode="bind"/><target type="virtio" name="org.qemu.guest_agent.0"/></channel>` : "",
    `    <memballoon model="virtio"/>`,
    `    <rng model="virtio"><backend model="random">/dev/urandom</backend></rng>`,
    `  </devices>`,
    `</domain>`,
  ];
  return ensureGuestAgentChannel(ensureSerialConsole(xmlLines.filter(Boolean).join("\n")), options.qemuAgentEnabled);
}

interface UefiFirmware {
  loader: string;
  /** VARS template the per-VM NVRAM is initialized from (Secure Boot only). */
  nvramTemplate?: string;
}

async function resolveUefiFirmware(arch: string, secureBoot: boolean): Promise<UefiFirmware> {
  if (secureBoot) {
    if (arch !== "x86_64") {
      throw new Error(`Secure Boot firmware is not available for architecture ${arch}`);
    }
    // CODE and VARS sizes must match (4M with 4M). The .ms VARS templates ship
    // with Microsoft's keys enrolled, so Windows 11's Secure Boot check passes
    // without manual key enrollment in the OVMF setup screens.
    const pairs: Array<[string, string]> = [
      ["/usr/share/OVMF/OVMF_CODE_4M.ms.fd", "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"],
      ["/usr/share/OVMF/OVMF_CODE_4M.secboot.fd", "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"],
      ["/usr/share/OVMF/OVMF_CODE.secboot.fd", "/usr/share/OVMF/OVMF_VARS.ms.fd"],
      ["/usr/share/edk2/ovmf/OVMF_CODE.secboot.fd", "/usr/share/edk2/ovmf/OVMF_VARS.secboot.fd"],
    ];
    for (const [code, vars] of pairs) {
      try {
        await fs.access(code);
        await fs.access(vars);
        return { loader: code, nvramTemplate: vars };
      } catch {
        continue;
      }
    }
    throw new Error("Secure Boot UEFI firmware not found (ovmf package with OVMF_CODE_4M.ms.fd + OVMF_VARS_4M.ms.fd required)");
  }
  const candidates = arch === "aarch64"
    ? ["/usr/share/AAVMF/AAVMF_CODE.fd", "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd"]
    : ["/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_CODE_4M.fd"];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { loader: candidate };
    } catch {
      continue;
    }
  }
  throw new Error(`UEFI firmware not found for architecture ${arch}`);
}

async function resolveUefiLoader(arch: string) {
  return (await resolveUefiFirmware(arch, false)).loader;
}

function buildUefiLoaderLines(firmware: UefiFirmware, secureBoot: boolean) {
  const secureAttr = secureBoot ? ` secure="yes"` : "";
  const lines = [`    <loader readonly="yes"${secureAttr} type="pflash">${xmlEscape(firmware.loader)}</loader>`];
  if (secureBoot && firmware.nvramTemplate) {
    lines.push(`    <nvram template="${xmlEscape(firmware.nvramTemplate)}"/>`);
  }
  return lines.join("\n");
}

/** Secure Boot needs SMM (the secboot OVMF stores variables in SMM-protected flash). */
function ensureSmmFeature(xml: string, enabled: boolean) {
  let out = xml.replace(/\s*<smm\b[^>]*\/>/gi, "").replace(/\s*<smm\b[^>]*>[\s\S]*?<\/smm>/gi, "");
  if (!enabled) return out;
  if (/<\/features>/i.test(out)) return out.replace(/<\/features>/i, `<smm state="on"/></features>`);
  if (/<features\s*\/>/i.test(out)) return out.replace(/<features\s*\/>/i, `<features><smm state="on"/></features>`);
  return out.replace(/(<\/os>)/i, `$1\n  <features><smm state="on"/></features>`);
}

function requireQ35ForSecureBoot(machine: string) {
  if (!machine.includes("q35")) {
    throw new Error(`Secure Boot requires the q35 machine type (current: ${machine || "unknown"})`);
  }
}

async function createVm(p: Record<string, unknown>) {
  const name = validateVmName(p.name as string);
  const vcpus = validatePositiveInt(p.vcpus, "vcpus", 1, 512);
  const memoryMb = validatePositiveInt(p.memoryMb, "memoryMb", 64, 1024 * 1024);
  const diskGb = p.diskGb != null ? validatePositiveInt(p.diskGb, "diskGb", 1, 65536) : undefined;
  const storagePool = p.storagePool ? validatePath(p.storagePool as string, "storagePool") : undefined;
  const isoFileRaw = (p.isoFile as string | undefined)?.trim();
  const isoFile = isoFileRaw ? validatePath(isoFileRaw, "isoFile") : undefined;
  const bridge = validateBridge((p.bridge as string) ?? "virbr0");
  const macRaw = (p.mac as string | undefined)?.trim();
  const mac = macRaw ? validateMac(macRaw) : undefined;
  const arch = validateArch((p.arch as string) ?? "x86_64");
  const machine = validateMachine((p.machine as string) ?? (arch === "aarch64" ? "virt" : "q35"));
  const secureBoot = (p.secureBoot as boolean) ?? false;
  if (secureBoot) requireQ35ForSecureBoot(machine);
  // secureBoot implies UEFI: SeaBIOS has no Secure Boot at all.
  const uefi = ((p.uefi as boolean) ?? (arch === "aarch64")) || secureBoot;
  const bootDeviceRaw = ((p.bootDevice as string | undefined) ?? (isoFile ? "cdrom" : "hd"));
  if (!["hd", "cdrom", "network"].includes(bootDeviceRaw)) {
    throw new Error("Invalid bootDevice: must be hd, cdrom, or network");
  }
  const bootDevice = bootDeviceRaw as "hd" | "cdrom" | "network";
  const tpmEnabled = (p.tpmEnabled as boolean) ?? false;
  const qemuAgentEnabled = (p.qemuAgentEnabled as boolean) ?? true;
  const requestedVideoModel = p.videoModel as string | undefined;
  const osType = ((p.os as string | undefined) ?? "linux").toLowerCase();
  // Windows + SPICE: dynamic resize only works with the QXL DOD driver (the
  // Windows virtio-gpu driver has a fixed mode list); Linux is best on virtio.
  const videoModelRaw = (requestedVideoModel ?? (osType === "windows" ? "qxl" : "virtio"));
  if (!["vga", "virtio", "qxl"].includes(videoModelRaw)) {
    throw new Error("Invalid videoModel: must be vga, virtio, or qxl");
  }
  const videoModel = videoModelRaw as "vga" | "virtio" | "qxl";
  const autostart = (p.autostart as boolean) ?? false;
  const loaderLine = uefi
    ? buildUefiLoaderLines(await resolveUefiFirmware(arch, secureBoot), secureBoot)
    : "";

  await ensureVmBridgeReady(bridge);
  const diskBusRaw = (p.diskBus as string | undefined) ?? (osType === "windows" ? "sata" : "virtio");
  const diskBus = ["virtio", "sata", "ide", "scsi"].includes(diskBusRaw) ? diskBusRaw : "virtio";
  const diskDevName = diskBus === "virtio" ? "vda" : diskBus === "ide" ? "hda" : "sda";
  const existingPathRaw = (p.existingPath as string | undefined)?.trim();
  const existingPath = existingPathRaw ? validatePath(existingPathRaw, "existingPath") : undefined;

  let diskPath: string | undefined;
  if (diskGb && storagePool) {
    diskPath = `${storagePool}/${name}.qcow2`;
    await ensureLibvirtStorageDir(storagePool);
    await execFileAsync("qemu-img", ["create", "-f", "qcow2", diskPath, `${diskGb}G`]);
    await ensureLibvirtDiskAccess(diskPath);
  } else if (existingPath) {
    diskPath = existingPath;
    await ensureLibvirtDiskAccess(diskPath);
  }

  const xmlLines = [
    `<domain type="kvm">`,
    `  <name>${xmlEscape(name)}</name>`,
    `  <memory unit="MiB">${memoryMb}</memory>`,
    `  <currentMemory unit="MiB">${memoryMb}</currentMemory>`,
    `  <vcpu>${vcpus}</vcpu>`,
    `  <os>`,
    uefi
      ? `    <type arch="${xmlEscape(arch)}" machine="${xmlEscape(machine)}">hvm</type>\n${loaderLine}`
      : `    <type arch="${xmlEscape(arch)}" machine="${xmlEscape(machine)}">hvm</type>`,
    `    <boot dev="${bootDevice}"/>`,
    ...["hd", "cdrom", "network"].filter((entry) => entry !== bootDevice).map((entry) => `    <boot dev="${entry}"/>`),
    `  </os>`,
    `  <features><acpi/><apic/>${secureBoot ? `<smm state="on"/>` : ""}</features>`,
    `  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>`,
    `  ${buildCpuBlock(vcpus)}`,
    `  <devices>`,
    `    <emulator>/usr/bin/qemu-system-${xmlEscape(arch)}</emulator>`,
    diskPath ? [
      `    <disk type="file" device="disk">`,
      `      <driver name="qemu" type="qcow2" cache="none" io="native" discard="unmap"/>`,
      `      <source file="${xmlEscape(diskPath)}"/>`,
      `      <target dev="${diskDevName}" bus="${diskBus}"/>`,
      `    </disk>`,
    ].join("\n") : "",
    isoFile ? (() => {
      // Pick a CD-ROM device name that cannot conflict with the primary disk.
      // virtio disk = vda  → cdrom: sda/sata (no conflict)
      // sata disk   = sda  → cdrom: sdb/sata
      // ide disk    = hda  → cdrom: hdb/ide
      // scsi/none         → cdrom: sda/sata
      const cdBus = diskBus === "ide" ? "ide" : "sata";
      const cdDev = diskBus === "sata" ? "sdb" : diskBus === "ide" ? "hdb" : "sda";
      return [
        `    <disk type="file" device="cdrom">`,
        `      <driver name="qemu" type="raw"/>`,
        `      <source file="${xmlEscape(isoFile)}"/>`,
        `      <target dev="${cdDev}" bus="${cdBus}"/>`,
        `      <readonly/>`,
        `    </disk>`,
      ].join("\n");
    })() : "",
    `    <interface type="bridge">`,
    mac ? `      <mac address="${xmlEscape(mac)}"/>` : "",
    `      <source bridge="${xmlEscape(bridge)}"/>`,
    `      <model type="virtio"/>`,
    `    </interface>`,
    `    <graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1">`,
    `      <listen type="address" address="127.0.0.1"/>`,
    `    </graphics>`,
    buildSpiceGraphicsBlock(),
    buildSpiceAudioBlocks(),
    tpmEnabled ? `    <tpm model="tpm-crb"><backend type="emulator" version="2.0"/></tpm>` : "",
    buildVideoBlock(videoModel),
    `    <input type="tablet" bus="usb"/>`,
    `    <channel type="spicevmc"><target type="virtio" name="com.redhat.spice.0"/></channel>`,
    `    <serial type="pty">`,
    `      <target port="0"/>`,
    `    </serial>`,
    `    <console type="pty">`,
    `      <target type="serial" port="0"/>`,
    `    </console>`,
    qemuAgentEnabled ? `    <channel type="unix">\n      <source mode="bind"/>\n      <target type="virtio" name="org.qemu.guest_agent.0"/>\n    </channel>` : "",
    `    <memballoon model="virtio"/>`,
    `    <rng model="virtio"><backend model="random">/dev/urandom</backend></rng>`,
    `  </devices>`,
    `</domain>`,
  ].filter(Boolean).join("\n");

  const tmpFile = `/tmp/auxinux-vm-${name}-${Date.now()}.xml`;
  await fs.writeFile(tmpFile, xmlLines);
  try {
    await virsh("define", tmpFile);
    if (autostart) await virsh("autostart", name);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
  return { ok: true, name };
}

/** True if a libvirt domain (still) exists. */
async function domainExists(name: string): Promise<boolean> {
  try {
    await virsh("dominfo", name);
    return true;
  } catch {
    return false;
  }
}

async function deleteVm(name: string, deleteDisks: boolean) {
  await removeRdpGateway(name).catch(() => {});
  if (!(await domainExists(name))) {
    return { ok: true, alreadyGone: true };
  }

  // Capture disk paths from the CURRENT definition before we undefine it.
  // Only writable device="disk" sources qualify: a mounted ISO is a shared
  // library file and must never be deleted with the VM. (virsh dumpxml quotes
  // attributes with single quotes, so parseDiskBlocks — not a "…" regex.)
  let diskPaths: string[] = [];
  try {
    const xml = await virsh("dumpxml", name);
    diskPaths = parseDiskBlocks(xml)
      .filter((disk) => disk.deviceType === "disk" && !disk.readonly && disk.source)
      .map((disk) => disk.source);
  } catch { /* domain may have no inspectable XML */ }

  // Force the domain off (no-op error if already stopped).
  try { await virsh("destroy", name); } catch { /* not running */ }
  // A managed-save image blocks undefine unless explicitly removed.
  try { await virsh("managedsave-remove", name); } catch { /* none */ }

  // Undefine with every blocker-clearing flag, degrading gracefully if a flag
  // is unsupported by this libvirt build. Each attempt's failure is recorded so
  // we can surface a real error if the domain survives all of them.
  const undefineVariants = [
    ["undefine", name, "--managed-save", "--snapshots-metadata", "--checkpoints-metadata", "--nvram"],
    ["undefine", name, "--managed-save", "--snapshots-metadata", "--nvram"],
    ["undefine", name, "--snapshots-metadata", "--nvram"],
    ["undefine", name, "--snapshots-metadata"],
    ["undefine", name, "--nvram"],
    ["undefine", name],
  ];
  let lastError: unknown;
  for (const args of undefineVariants) {
    try {
      await virsh(...args);
      break;
    } catch (err) {
      lastError = err;
    }
    if (!(await domainExists(name))) break; // already gone after a partial attempt
  }

  // CRITICAL: verify the domain is really gone. Never report success otherwise.
  if (await domainExists(name)) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(`Failed to delete VM '${name}': libvirt still reports the domain after undefine (${detail})`);
  }

  // Only now (deletion confirmed) remove the backing disk files if requested.
  const deletedDisks: string[] = [];
  const failedDisks: string[] = [];
  if (deleteDisks) {
    for (const dp of diskPaths) {
      try {
        await fs.unlink(dp);
        deletedDisks.push(dp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") failedDisks.push(dp);
      }
    }
  }
  if (failedDisks.length > 0) {
    throw new Error(`VM '${name}' deleted, but some disk files could not be removed: ${failedDisks.join(", ")}`);
  }
  return { ok: true, deletedDisks };
}

async function vmAction(name: string, action: string) {
  switch (action) {
    case "start": {
      // A paused/suspended domain is still ACTIVE: `virsh start` fails with
      // "Domain is already active" and the user is stuck (can neither start
      // nor resume from UIs that don't expose resume). Starting a paused VM
      // means resuming it.
      const rawState = (await virsh("domstate", name).catch(() => "")).trim().toLowerCase();
      if (rawState.includes("pmsuspended")) {
        // Guest-initiated sleep (e.g. Windows idle S3): only a PM wakeup works.
        await virsh("dompmwakeup", name);
        await refreshRdpGatewayIfPrepared(name);
        break;
      }
      if (rawState.includes("paus")) {
        await virsh("resume", name);
        await refreshRdpGatewayIfPrepared(name);
        break;
      }
      const xml = ensureSpiceAgentChannel(ensureGuestPmDisabled(ensureUsbTabletInput(ensurePerformanceDefaults(ensureSerialConsole(await dumpDomainXmlForDefine(name, false))))));
      await ensureVmInterfacesReady(xml);
      const tmp = `/tmp/auxinux-start-vm-${name}-${Date.now()}.xml`;
      await fs.writeFile(tmp, xml);
      try {
        await virsh("define", tmp);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      await virsh("start", name);
      await refreshRdpGatewayIfPrepared(name);
      break;
    }
    // "stop" sends an ACPI shutdown to the guest (`virsh shutdown`). That only
    // works if the guest has an ACPI handler running (acpid on Linux, native
    // handler on Windows) or qemu-guest-agent installed. On a freshly created
    // VM that hasn't been installed yet — or that runs a bare-metal initrd —
    // the signal is silently ignored and the button "does nothing". To match
    // user expectation, we wait up to STOP_GRACE_SECONDS and then escalate
    // to `virsh destroy` (equivalent to pulling the power cable). The user
    // can still pick "forceStop" explicitly to skip the grace period.
    case "stop": await gracefulStop(name); break;
    case "shutdown": await gracefulStop(name); break;
    case "forceStop": await virsh("destroy", name); break;
    case "reboot": await gracefulReboot(name); break;
    case "pause":
    case "suspend": await virsh("suspend", name); break;
    case "resume": {
      const raw = (await virsh("domstate", name).catch(() => "")).trim().toLowerCase();
      if (raw.includes("pmsuspended")) await virsh("dompmwakeup", name);
      else await virsh("resume", name);
      break;
    }
    case "reset": await virsh("reset", name); break;
    default: throw new Error(`Unknown VM action: ${action}`);
  }
  return { ok: true };
}

const STOP_GRACE_SECONDS = 30;
const REBOOT_GRACE_SECONDS = 60;

async function waitForState(name: string, target: "running" | "stopped", timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await getDomainState(name);
    if (target === "stopped" && state !== "running" && state !== "paused" && state !== "suspended") return true;
    if (target === "running" && state === "running") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function gracefulStop(name: string) {
  // A paused or sleeping guest never processes ACPI: wake/resume it first so
  // the shutdown is clean. If it cannot be brought back (e.g. QEMU paused on a
  // disk error), don't make the user wait through the ACPI grace period —
  // power it off now.
  const raw = (await virsh("domstate", name).catch(() => "")).trim().toLowerCase();
  if (raw.includes("pmsuspended") || raw.includes("paus")) {
    if (raw.includes("pmsuspended")) await virsh("dompmwakeup", name).catch(() => {});
    else await virsh("resume", name).catch(() => {});
    if ((await getDomainState(name)) !== "running") {
      await virsh("destroy", name);
      return;
    }
  }
  await virsh("shutdown", name).catch(() => {});
  const stopped = await waitForState(name, "stopped", STOP_GRACE_SECONDS);
  if (!stopped) {
    // Guest never responded to ACPI within the grace period — power it off.
    await virsh("destroy", name);
  }
}

async function gracefulReboot(name: string) {
  // virsh reboot sends ACPI; if the guest never handles it the VM stays up.
  // Fall back to a hard `reset` (cold-boot through the hypervisor) after the
  // grace period — but only if the VM is still in `running` state, so we
  // don't restart a VM the user simultaneously stopped.
  await virsh("reboot", name).catch(() => {});
  const stopped = await waitForState(name, "stopped", REBOOT_GRACE_SECONDS);
  if (stopped) return; // ACPI reboot proceeded normally (state transitions through stopped→running on its own)
  const state = await getDomainState(name);
  if (state === "running") {
    await virsh("reset", name);
  }
}

async function getVmInfo(name: string) {
  const [info, liveXml, inactiveXml] = await Promise.all([
    virsh("dominfo", name),
    virsh("dumpxml", name),
    virsh("dumpxml", name, "--inactive").catch(() => ""),
  ]);
  const xml = inactiveXml || liveXml;
  const state = normalizeState(parseField(info, "State") ?? "unknown");
  const vcpus = parseXmlNumberTag(xml, "vcpu") || parseInt(parseField(info, "CPU(s)") ?? "0", 10);
  const maxMem = parseMemoryKiB(xml, "memory") || parseInt(parseField(info, "Max memory") ?? "0", 10);
  const curMem = parseMemoryKiB(xml, "currentMemory") || parseInt(parseField(info, "Used memory") ?? "0", 10);
  const uuid = parseField(info, "UUID") ?? "";
  const autostart = parseField(info, "Autostart") === "enable";
  const machine = xml.match(/machine=['"]([^'"]+)['"]/)?.[1] ?? "";
  const arch = xml.match(/arch=['"]([^'"]+)['"]/)?.[1] ?? "";
  const bootOrder = [...xml.matchAll(/<boot dev=['"]([^'"]+)['"]\s*\/>/g)].map((match) => match[1]) as Array<"hd" | "cdrom" | "network">;
  const tpmEnabled = /<tpm\b/i.test(xml);
  const qemuAgentEnabled = /<channel\b[\s\S]*?<target[^>]*name=['"]org\.qemu\.guest_agent\.0['"]/i.test(xml);
  const videoModel = (xml.match(/<video\b[\s\S]*?<model[^>]*type=['"]([^'"]+)['"]/i)?.[1] ?? "vga") as "vga" | "virtio" | "qxl";

  const disks = parseDiskBlocks(xml).map((disk) => ({
    device: disk.device,
    // Kept so callers can tell a data disk from the CD drive: the list mixes
    // both, and only `disk` entries are resizable/detachable.
    deviceType: disk.deviceType,
    bus: disk.bus,
    source: disk.source,
    format: disk.format,
    sizeBytes: 0,
    readonly: disk.readonly,
  }));

  await Promise.all(disks.map(async (disk) => {
    try {
      if (disk.source) {
        const stat = await fs.stat(disk.source);
        disk.sizeBytes = stat.size;
      }
    } catch {}
  }));

  const networks = [...xml.matchAll(/<interface\b[\s\S]*?<\/interface>/g)].map((m, i) => {
    const block = m[0];
    const mac = block.match(/<mac[^>]*address=['"]([0-9a-f:]+)['"]/i)?.[1] ?? "";
    const src = block.match(/<source[^>]*bridge=['"]([^'"]+)['"]/)?.[1]
      ?? block.match(/<source[^>]*network=['"]([^'"]+)['"]/)?.[1]
      ?? "";
    const model = block.match(/<model[^>]*type=['"]([^'"]+)['"]/)?.[1] ?? "virtio";
    const type = block.match(/<interface[^>]*type=['"]([^'"]+)['"]/)?.[1] ?? "bridge";
    return { index: i, mac, model, source: src, type, ipAddresses: [] };
  });
  const usbDevices = parseUsbHostdevBlocks(xml).map(({ block: _block, ...device }) => device);

  let vncPort: number | undefined;
  try {
    const display = (await virsh("vncdisplay", name)).trim();
    const displayMatch = display.match(/(?::|\.)(\d+)$/);
    if (displayMatch) vncPort = 5900 + parseInt(displayMatch[1], 10);
  } catch {
    const vncM = liveXml.match(/type=['"]vnc['"][^>]*port=['"](\d+)['"]/);
    if (vncM) vncPort = parseInt(vncM[1], 10);
  }
  const spice = parseSpiceGraphics(liveXml);

  // Surface the currently-mounted ISO (cdrom with a source) for the resource API.
  const cdrom = parseDiskBlocks(xml).find((d) => d.deviceType === "cdrom" && !!d.source);
  const mountedIso = cdrom?.source ? path.basename(cdrom.source) : null;

  const uefi = /<loader\b/i.test(xml);
  const secureBoot = /<loader[^>]*\bsecure=['"]yes['"]/i.test(xml);
  return {
    name, state, vcpus,
    currentMemoryKiB: curMem, maxMemoryKiB: maxMem,
    memoryMb: Math.round(maxMem / 1024), usedMemoryMb: Math.round(curMem / 1024),
    uuid, autostart, machine, arch, uefi, secureBoot, bootOrder, tpmEnabled, qemuAgentEnabled, videoModel, disks, networks, usbDevices, mountedIso, vncPort, vncHost: "127.0.0.1", spicePort: spice.port, spiceTlsPort: spice.tlsPort, spiceHost: spice.host, spiceEnabled: spice.enabled, os: "Unknown",
  };
}

async function ensureSpiceConsole(name: string) {
  validateVmName(name);
  const ensured = await withVmDefineLock(name, async () => {
    const beforeXml = await dumpDomainXmlForDefine(name, true);
    const result = ensureSpiceGraphics(beforeXml);
    if (result.changed) {
      const tmp = path.join("/tmp", `virtua-${process.pid}-${Date.now()}-${name}.xml`);
      await fs.writeFile(tmp, result.xml, "utf8");
      try {
        await virsh("define", tmp);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    return result;
  });

  // Always enforce a SPICE password: reachability of the (loopback-only,
  // WS-proxied) port is not meant to be sufficient on its own.
  const spicePassword = await ensureSpicePassword(name);

  const [state, liveXml] = await Promise.all([
    getDomainState(name),
    virsh("dumpxml", name).catch(() => virsh("dumpxml", name, "--inactive")),
  ]);
  const spice = parseSpiceGraphics(liveXml);
  const activePort = spice.port ?? spice.tlsPort;
  return {
    ok: true,
    enabled: spice.enabled,
    active: state === "running" && !!activePort,
    requiresStart: state !== "running",
    requiresRestart: state === "running" && ensured.changed,
    spiceHost: spice.host || "127.0.0.1",
    spicePort: spice.port,
    spiceTlsPort: spice.tlsPort,
    spicePassword,
  };
}

const XRDP_INI = "/etc/xrdp/xrdp.ini";
const XRDP_PROFILE_BEGIN = "; BEGIN AUXINUX VIRTUA VM CONSOLES";
const XRDP_PROFILE_END = "; END AUXINUX VIRTUA VM CONSOLES";
const RDP_PORT_MIN = 3390;
const RDP_PORT_MAX = 3489;
const RDP_UNIT_TEMPLATE_PATH = "/etc/systemd/system/virtua-rdp@.service";

function rdpBaseDir(): string {
  return path.join(process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinuxvirtual", "rdp");
}

function rdpVmDir(name: string): string {
  return path.join(rdpBaseDir(), name);
}

function rdpUnitName(name: string): string {
  return `virtua-rdp@${name}.service`;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("command", ["-v", command]);
    return true;
  } catch {
    try {
      await execFileAsync("which", [command]);
      return true;
    } catch {
      return false;
    }
  }
}

async function findXrdpVncLibrary(): Promise<string | undefined> {
  const candidates = [
    "/usr/lib/xrdp/libxrdp-vnc.so",
    "/usr/lib64/xrdp/libxrdp-vnc.so",
    "/usr/lib/x86_64-linux-gnu/xrdp/libxrdp-vnc.so",
    "/usr/lib/xrdp/libvnc.so",
    "/usr/lib64/xrdp/libvnc.so",
    "/usr/lib/x86_64-linux-gnu/xrdp/libvnc.so",
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return path.basename(candidate);
  }
  try {
    const { stdout } = await execFileAsync("find", ["/usr", "-type", "f", "(", "-name", "libvnc.so", "-o", "-name", "libxrdp-vnc.so", ")", "-path", "*xrdp*"], { timeout: 5000 });
    const found = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const preferred = found.find((line) => path.basename(line) === "libxrdp-vnc.so") ?? found[0];
    if (preferred) return path.basename(preferred);
  } catch {
    /* xrdp VNC module not present or find unavailable */
  }
  return undefined;
}

function xrdpProfileDisplayName(name: string): string {
  return `Virtua VM Console - ${name}`;
}

async function xrdpIsActive(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", "xrdp"], { timeout: 5000 });
    return stdout.trim() === "active";
  } catch {
    return false;
  }
}

async function findXrdpBinary(): Promise<string | undefined> {
  for (const candidate of ["/usr/sbin/xrdp", "/usr/local/sbin/xrdp", "/usr/bin/xrdp"]) {
    if (await fileExists(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync("which", ["xrdp"], { timeout: 5000 });
    const found = stdout.trim();
    if (found) return found;
  } catch { /* xrdp not installed */ }
  return undefined;
}

async function loadRdpPorts(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(path.join(rdpBaseDir(), "ports.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, number>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function saveRdpPorts(ports: Record<string, number>): Promise<void> {
  await fs.mkdir(rdpBaseDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(rdpBaseDir(), "ports.json"), JSON.stringify(ports, null, 2), { mode: 0o600 });
}

async function allocateRdpPort(name: string): Promise<number> {
  const ports = await loadRdpPorts();
  if (ports[name]) return ports[name];
  const used = new Set(Object.values(ports));
  for (let port = RDP_PORT_MIN; port <= RDP_PORT_MAX; port++) {
    if (!used.has(port)) {
      ports[name] = port;
      await saveRdpPorts(ports);
      return port;
    }
  }
  throw new Error(`No free RDP port available in range ${RDP_PORT_MIN}-${RDP_PORT_MAX}`);
}

async function ensureRdpCertificate(dir: string): Promise<{ cert: string; key: string }> {
  // Reuse the host xrdp certificate when the distro package generated one.
  if (await fileExists("/etc/xrdp/cert.pem") && await fileExists("/etc/xrdp/key.pem")) {
    return { cert: "/etc/xrdp/cert.pem", key: "/etc/xrdp/key.pem" };
  }
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  if (!(await fileExists(cert)) || !(await fileExists(key))) {
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
      "-keyout", key, "-out", cert, "-subj", "/CN=virtua-rdp",
    ], { timeout: 30_000 });
    await fs.chmod(key, 0o600).catch(() => {});
  }
  return { cert, key };
}

function buildVmXrdpIni(args: {
  rdpPort: number;
  cert: string;
  key: string;
  lib: string;
  vncPort: number;
  vncPassword: string;
  displayName: string;
  logFile: string;
}): string {
  return [
    "[Globals]",
    "ini_version=1",
    "fork=true",
    `port=${args.rdpPort}`,
    "use_vsock=false",
    "tcp_nodelay=true",
    "tcp_keepalive=true",
    // Force TLS: the legacy RDP-standard encryption path is a known source of
    // "data encryption error" (0x407) disconnects with macOS/Windows App
    // clients on xrdp 0.10, and TLS is stronger anyway.
    "security_layer=tls",
    // Mandatory with security_layer=tls: xrdp enables NO TLS protocol when
    // ssl_protocols is missing from the ini (zero-initialized bitmask in
    // xrdp_rdp_read_config), which rejects every handshake with client error
    // 0x204.
    "ssl_protocols=TLSv1.2, TLSv1.3",
    "crypt_level=high",
    `certificate=${args.cert}`,
    `key_file=${args.key}`,
    // Prefer stability for the long-lived VNC proxy stream. macOS and some
    // Windows clients report 0x407 when compressed bitmap state desynchronizes.
    "bitmap_compression=false",
    // Bulk (MPPC) compression corrupts streams with some clients (another
    // known 0x407 trigger) and buys nothing for a loopback VNC gateway.
    "bulk_compression=false",
    "max_bpp=32",
    "allow_channels=true",
    // xrdp's VNC proxy cannot resize the QEMU server framebuffer. The client
    // scales the fixed framebuffer instead (smart sizing in the .rdp file).
    "enable_dynamic_resizing=false",
    // Auto-select the single VM session; the patched VirtuaOS xrdp skips the
    // login screen entirely when autorun is set (stock xrdp still needs the
    // client to send autologon credentials, any value works).
    "autorun=vm",
    "",
    "[Logging]",
    `LogFile=${args.logFile}`,
    "LogLevel=INFO",
    "EnableSyslog=false",
    "",
    "[vm]",
    `name=${args.displayName}`,
    `lib=${args.lib}`,
    // IPv4-mapped loopback: IPv6-enabled xrdp builds (Debian) silently rewrite
    // the literal string "127.0.0.1" to "::1", where QEMU does not listen, so
    // the VNC connect loops on ECONNREFUSED. "::ffff:127.0.0.1" escapes that
    // rewrite and the kernel routes it to 127.0.0.1 over IPv4.
    "ip=::ffff:127.0.0.1",
    `port=${args.vncPort}`,
    "username=na",
    // Feed the protected per-VM VNC secret directly to the gateway. Some RDP
    // clients do not forward their credential field unchanged to libvnc,
    // which makes a valid QEMU password fail during VNC security negotiation.
    `password=${args.vncPassword}`,
    // Keep server-side resize negotiation disabled for the VNC proxy.
    "",
  ].join("\n");
}

async function ensureRdpUnitTemplate(xrdpBin: string): Promise<void> {
  const unit = [
    "[Unit]",
    "Description=Virtua RDP console gateway for VM %i",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${xrdpBin} --nodaemon --config ${rdpBaseDir()}/%i/xrdp.ini`,
    "Restart=on-failure",
    "RestartSec=2",
    // Isolated /run/xrdp so per-VM instances never collide with the system
    // xrdp pid file or with each other.
    "TemporaryFileSystem=/run/xrdp",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  const existing = await fs.readFile(RDP_UNIT_TEMPLATE_PATH, "utf8").catch(() => "");
  if (existing !== unit) {
    await fs.writeFile(RDP_UNIT_TEMPLATE_PATH, unit, "utf8");
    await execFileAsync("systemctl", ["daemon-reload"], { timeout: 15_000 });
  }
}

async function rdpUnitIsActive(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", rdpUnitName(name)], { timeout: 5000 });
    return stdout.trim() === "active";
  } catch {
    return false;
  }
}

/**
 * Current guest console geometry, read from a QEMU screendump header (PNG on
 * recent libvirt, PPM on older ones). The .rdp file must request exactly this
 * size: QEMU cannot resize its VNC framebuffer on request, and xrdp 0.10's
 * fallback "resize client to server" path crashes (SIGSEGV) when dynamic
 * resizing is disabled.
 */
async function getVmConsoleGeometry(name: string): Promise<{ width: number; height: number } | null> {
  const tmp = path.join(rdpBaseDir(), `.console-geom-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(rdpBaseDir(), { recursive: true, mode: 0o700 });
    await execFileAsync("virsh", ["screenshot", name, tmp], { timeout: 15_000 });
    const buf = await fs.readFile(tmp);
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    const ppm = buf.subarray(0, 64).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)/);
    if (ppm) return { width: parseInt(ppm[1], 10), height: parseInt(ppm[2], 10) };
    return null;
  } catch {
    return null;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function getRdpConsoleInfo(name: string) {
  validateVmName(name);
  const info = await getVmInfo(name) as {
    state: string;
    vncHost?: string;
    vncPort?: number;
  };
  const xrdpBin = await findXrdpBinary();
  const xrdpLibVnc = await findXrdpVncLibrary();
  const ports = await loadRdpPorts();
  const rdpPort = ports[name];
  const vmIni = await fs.readFile(path.join(rdpVmDir(name), "xrdp.ini"), "utf8").catch(() => "");
  const profilePresent = vmIni.length > 0 && !!rdpPort;
  const unitActive = profilePresent ? await rdpUnitIsActive(name) : false;
  const geometry = info.state === "running" ? await getVmConsoleGeometry(name) : null;
  const iniVncPort = parseInt(vmIni.match(/^\s*port\s*=\s*(\d+)\s*$/im)?.[1] ?? "", 10);
  // The [Globals] port= comes first in the generated file; the VNC target port
  // is the second port= occurrence (inside [vm]).
  const iniPorts = [...vmIni.matchAll(/^\s*port\s*=\s*(\d+)\s*$/gim)].map((m) => parseInt(m[1], 10));
  const profileVncPort = iniPorts.length > 1 ? iniPorts[1] : iniVncPort;
  const profileStale = profilePresent && !!info.vncPort && Number.isInteger(profileVncPort) && profileVncPort !== info.vncPort;
  const warnings: string[] = [];
  if (info.state !== "running") warnings.push("La VM doit être en marche pour exposer sa console RDP.");
  if (!info.vncPort) warnings.push("La console VNC QEMU de cette VM n'est pas active.");
  if (!xrdpBin) warnings.push("xrdp n'est pas installé sur le host.");
  if (!xrdpLibVnc) warnings.push("Le module xrdp VNC est introuvable.");
  if (!profilePresent) warnings.push("La passerelle RDP de cette VM n'est pas encore préparée.");
  if (profilePresent && !unitActive) warnings.push("La passerelle RDP de cette VM n'est pas active. Relancer « Prepare RDP profile ».");
  if (profileStale) warnings.push(`La passerelle RDP pointe sur l'ancien port VNC ${profileVncPort} (actuel : ${info.vncPort}). Relancer « Prepare RDP profile ».`);
  return {
    ok: true,
    vmName: name,
    state: info.state,
    vncHost: info.vncHost ?? "127.0.0.1",
    vncPort: info.vncPort,
    xrdpInstalled: !!xrdpBin,
    xrdpActive: unitActive,
    xrdpPort: rdpPort ?? 0,
    xrdpLibVnc,
    profileName: xrdpProfileDisplayName(name),
    profileSection: "vm",
    profilePresent,
    consoleWidth: geometry?.width,
    consoleHeight: geometry?.height,
    ready: info.state === "running" && !!info.vncPort && !!xrdpBin && !!xrdpLibVnc && profilePresent && unitActive && !profileStale,
    warnings,
  };
}

/** Remove the legacy managed section block Virtua <= 0.7.6 wrote into the system xrdp.ini. */
async function cleanupLegacySharedXrdpProfiles(): Promise<void> {
  try {
    const ini = await fs.readFile(XRDP_INI, "utf8");
    const escBegin = XRDP_PROFILE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escEnd = XRDP_PROFILE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const managedRe = new RegExp(`\\n?${escBegin}\\n[\\s\\S]*?\\n${escEnd}\\n?`, "m");
    if (!managedRe.test(ini)) return;
    await fs.copyFile(XRDP_INI, `${XRDP_INI}.auxinux.bak`).catch(() => {});
    await fs.writeFile(XRDP_INI, ini.replace(managedRe, "\n"), "utf8");
    if (await xrdpIsActive()) {
      await execFileAsync("systemctl", ["restart", "xrdp"], { timeout: 15_000 }).catch(() => {});
    }
  } catch { /* system xrdp.ini absent or unreadable — nothing to clean */ }
}

async function prepareRdpConsole(name: string) {
  validateVmName(name);
  const info = await getVmInfo(name) as { state: string; vncPort?: number };
  if (info.state !== "running" || !info.vncPort) {
    throw new Error("RDP console requires a running VM with an active QEMU VNC console");
  }
  const xrdpBin = await findXrdpBinary();
  if (!xrdpBin) {
    throw new Error("xrdp is not installed. Install package 'xrdp' on the host, then retry.");
  }
  const xrdpLibVnc = await findXrdpVncLibrary();
  if (!xrdpLibVnc) {
    throw new Error("xrdp VNC backend library is missing. Install an xrdp build/package with VNC forwarding support.");
  }
  // Always enforce a VNC password on the VM console: the RDP gateway forwards
  // the client-supplied password ("ask"), so possession of the .rdp file or
  // network reachability of the port is never enough on its own.
  const vncPassword = await ensureVncPassword(name);

  const dir = rdpVmDir(name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const rdpPort = await allocateRdpPort(name);
  const { cert, key } = await ensureRdpCertificate(dir);
  const iniPath = path.join(dir, "xrdp.ini");
  const nextIni = buildVmXrdpIni({
    rdpPort,
    cert,
    key,
    lib: xrdpLibVnc,
    vncPort: info.vncPort,
    vncPassword,
    displayName: xrdpProfileDisplayName(name),
    logFile: path.join(dir, "xrdp.log"),
  });
  const currentIni = await fs.readFile(iniPath, "utf8").catch(() => "");
  if (currentIni !== nextIni) {
    await fs.writeFile(iniPath, nextIni, { mode: 0o600 });
  }
  await ensureRdpUnitTemplate(xrdpBin);
  await execFileAsync("systemctl", ["enable", "--now", rdpUnitName(name)], { timeout: 15_000 });
  if (currentIni && currentIni !== nextIni) {
    await execFileAsync("systemctl", ["restart", rdpUnitName(name)], { timeout: 15_000 });
  }
  await cleanupLegacySharedXrdpProfiles();
  const result = await getRdpConsoleInfo(name);
  // Only the prepare response carries the console password (the info endpoint
  // never does); the API exposes it solely to users with console permission.
  return { ...result, consolePassword: vncPassword };
}

/** Re-sync the per-VM RDP gateway after a VM (re)start: the QEMU VNC port may have changed. */
async function refreshRdpGatewayIfPrepared(name: string): Promise<void> {
  try {
    const iniPath = path.join(rdpVmDir(name), "xrdp.ini");
    await fs.access(iniPath);
  } catch {
    return; // RDP never prepared for this VM
  }
  try {
    await prepareRdpConsole(name);
  } catch { /* best effort — the console panel will surface a stale-profile warning */ }
}

/** Tear down the per-VM RDP gateway (VM deletion/rename). */
async function removeRdpGateway(name: string): Promise<void> {
  await execFileAsync("systemctl", ["disable", "--now", rdpUnitName(name)], { timeout: 15_000 }).catch(() => {});
  await fs.rm(rdpVmDir(name), { recursive: true, force: true }).catch(() => {});
  const ports = await loadRdpPorts();
  if (ports[name]) {
    delete ports[name];
    await saveRdpPorts(ports).catch(() => {});
  }
}

async function updateVmConfig(p: Record<string, unknown>) {
  const name = p.name as string;
  const currentXml = await dumpDomainXmlForDefine(name, true);
  let xml = ensureSpiceAgentChannel(ensureGuestPmDisabled(ensureUsbTabletInput(ensurePerformanceDefaults(ensureSerialConsole(currentXml)))));

  if (typeof p.vcpus === "number") {
    xml = replaceXmlTag(xml, "vcpu", String(p.vcpus));
    xml = ensurePerformanceDefaults(xml);
  }

  if (typeof p.memoryMb === "number") {
    xml = replaceXmlTag(xml, "memory", String(p.memoryMb), ` unit="MiB"`);
    xml = replaceXmlTag(xml, "currentMemory", String(p.memoryMb), ` unit="MiB"`);
  }

  if (typeof p.bootDevice === "string") {
    xml = applyBootOrder(xml, p.bootDevice as "hd" | "cdrom" | "network");
  }

  if (typeof p.tpmEnabled === "boolean") {
    xml = ensureTpm(xml, p.tpmEnabled);
  }

  if (typeof p.qemuAgentEnabled === "boolean") {
    xml = ensureGuestAgentChannel(xml, p.qemuAgentEnabled);
  }

  if (typeof p.videoModel === "string") {
    xml = ensureVideoModel(xml, p.videoModel as "vga" | "virtio" | "qxl");
  }

  let staleNvramPath: string | undefined;
  if (typeof p.uefi === "boolean" || typeof p.secureBoot === "boolean") {
    const currentlyUefi = /<loader\b/i.test(xml);
    const currentlySecure = /<loader[^>]*\bsecure=['"]yes['"]/i.test(xml);
    const wantSecure = typeof p.secureBoot === "boolean" ? p.secureBoot : currentlySecure;
    // secureBoot implies UEFI: SeaBIOS has no Secure Boot at all.
    const wantUefi = (typeof p.uefi === "boolean" ? p.uefi : currentlyUefi) || wantSecure;
    if (wantUefi !== currentlyUefi || wantSecure !== currentlySecure) {
      const arch = xml.match(/arch=['"]([^'"]+)['"]/)?.[1] ?? "x86_64";
      if (wantSecure) {
        requireQ35ForSecureBoot(xml.match(/machine=['"]([^'"]+)['"]/)?.[1] ?? "");
      }
      // The existing per-VM NVRAM was initialized from the previous firmware's
      // VARS template (wrong size and/or no Microsoft keys). Drop it so libvirt
      // re-creates it from the new template on next start.
      staleNvramPath = xml.match(/<nvram[^>]*>([^<]+)<\/nvram>/i)?.[1]?.trim();
      xml = xml.replace(/<loader[^>]*>[^<]*<\/loader>\s*/gi, "");
      xml = xml.replace(/<nvram[^>]*>[^<]*<\/nvram>\s*/gi, "");
      xml = xml.replace(/<nvram[^>]*\/>\s*/gi, "");
      if (wantUefi) {
        const firmware = await resolveUefiFirmware(arch, wantSecure);
        xml = xml.replace(/(<type[^>]*>hvm<\/type>)/, `$1\n${buildUefiLoaderLines(firmware, wantSecure)}`);
      }
    }
    xml = ensureSmmFeature(xml, wantSecure);
  }

  const tmp = `/tmp/auxinux-update-vm-${name}-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    await virsh("define", tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }

  if (staleNvramPath && staleNvramPath.startsWith("/var/lib/libvirt/qemu/nvram/")) {
    await fs.unlink(staleNvramPath).catch(() => {});
  }

  if (typeof p.autostart === "boolean") {
    if (p.autostart) await virsh("autostart", name);
    else await virsh("autostart", "--disable", name);
  }

  return { ok: true };
}

async function getVmStats(name: string) {
  try {
    const out = await virsh("domstats", "--raw", name);
    const kv: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const m = line.match(/^\s+(.+)=(.+)$/);
      if (m) kv[m[1].trim()] = m[2].trim();
    }
    const cpuTimeNs = parseInt(kv["cpu.time"] ?? "0");
    const vcpuCurrent = Math.max(1, parseInt(kv["vcpu.current"] ?? "1"));
    const balloonCur = parseInt(kv["balloon.current"] ?? "0");
    const balloonMax = parseInt(kv["balloon.maximum"] ?? "1");
    const balloonUsable = parseInt(kv["balloon.usable"] ?? "0");
    const netRx = parseInt(kv["net.0.rx.bytes"] ?? "0");
    const netTx = parseInt(kv["net.0.tx.bytes"] ?? "0");
    const blkRd = parseInt(kv["block.0.rd.bytes"] ?? "0");
    const blkWr = parseInt(kv["block.0.wr.bytes"] ?? "0");
    const stateStr = await virsh("domstate", name);
    const nowMs = Date.now();
    const previous = vmCpuSamples.get(name);
    vmCpuSamples.set(name, { cpuTimeNs, sampledAtMs: nowMs });

    let cpuPercent = 0;
    if (previous && nowMs > previous.sampledAtMs && cpuTimeNs >= previous.cpuTimeNs) {
      const cpuDelta = cpuTimeNs - previous.cpuTimeNs;
      const wallDeltaNs = (nowMs - previous.sampledAtMs) * 1_000_000;
      cpuPercent = Math.max(0, Math.min(100, (cpuDelta / (wallDeltaNs * vcpuCurrent)) * 100));
    }

    const memoryUsedKiB = Math.max(0, balloonCur - Math.min(balloonCur, balloonUsable || 0));
    const memPercent = balloonCur > 0
      ? Math.max(0, Math.min(100, Math.round((memoryUsedKiB / balloonCur) * 100)))
      : 0;

    const state = normalizeState(stateStr);

    // Live (uncached) extras for running VMs: uptime, guest-agent reachability, IPs.
    let uptimeSeconds: number | undefined;
    let guestAgentEnabled = false;
    let guestAgentConnected = false;
    let guestAgentRunning = false;
    let spiceAgentPresent = false;
    let spiceAgentConnected = false;
    let ipAddresses: string[] = [];
    if (state === "running") {
      const xml = await virsh("dumpxml", name).catch(() => "");
      guestAgentEnabled = xml ? hasGuestAgentChannel(xml) : false;
      // Live XML carries state="connected"/"disconnected" on virtio channel
      // targets: "connected" means the guest side has the channel OPEN — the
      // transport-level truth for "is the agent actually talking to us".
      const gaChannel = xml.match(/<channel\b[\s\S]*?org\.qemu\.guest_agent\.0[\s\S]*?<\/channel>/i)?.[0] ?? "";
      guestAgentConnected = /state=['"]connected['"]/i.test(gaChannel);
      const spiceChannel = xml.match(/<channel\b[^>]*type=['"]spicevmc['"][\s\S]*?<\/channel>/i)?.[0] ?? "";
      spiceAgentPresent = !!spiceChannel;
      spiceAgentConnected = /state=['"]connected['"]/i.test(spiceChannel);
      const [pid, agentOk] = await Promise.all([
        getVmPid(name),
        guestAgentEnabled ? pingGuestAgent(name) : Promise.resolve(false),
      ]);
      guestAgentRunning = agentOk;
      uptimeSeconds = pid ? await processUptimeSeconds(pid) : undefined;
      ipAddresses = await getVmIpAddresses(name, agentOk);
    }
    const guestAgentStatus: "running" | "stopped" | "not-installed" | "unknown" = !guestAgentEnabled
      ? "not-installed"
      : guestAgentRunning ? "running" : "stopped";

    return {
      state,
      cpuTimeNs,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryUsedKiB,
      balloonCurrentKiB: balloonCur, balloonMaxKiB: balloonMax,
      memPercent,
      uptimeSeconds,
      guestAgentEnabled,
      guestAgentConnected,
      guestAgentRunning,
      guestAgentStatus,
      spiceAgentPresent,
      spiceAgentConnected,
      ipAddresses,
      netRxBytes: netRx, netTxBytes: netTx,
      blockRdBytes: blkRd, blockWrBytes: blkWr,
    };
  } catch {
    return {
      state: "unknown",
      cpuTimeNs: 0,
      cpuPercent: 0,
      memoryUsedKiB: 0,
      balloonCurrentKiB: 0,
      balloonMaxKiB: 0,
      memPercent: 0,
      uptimeSeconds: undefined,
      guestAgentEnabled: false,
      guestAgentRunning: false,
      guestAgentStatus: "unknown" as const,
      ipAddresses: [],
      netRxBytes: 0,
      netTxBytes: 0,
      blockRdBytes: 0,
      blockWrBytes: 0,
    };
  }
}

async function getVmLogs(name: string, tail: number) {
  const logPath = `/var/log/libvirt/qemu/${name}.log`;
  try {
    const content = await fs.readFile(logPath, "utf8");
    const lines = content.split("\n");
    return lines.slice(-tail).join("\n");
  } catch {
    return "";
  }
}

async function attachDisk(p: Record<string, unknown>) {
  const name = p.name as string;
  const sizeGb = p.sizeGb as number | undefined;
  const existingPathRaw = (p.existingPath as string | undefined)?.trim();
  const existingPath = existingPathRaw ? validatePath(existingPathRaw, "existingPath") : undefined;
  const bus = (p.bus as string) ?? "virtio";
  const storagePool = (p.storagePool as string) ?? IMAGES_DIR;

  let diskPath = existingPath;
  if (!diskPath && sizeGb) {
    const suffix = Date.now();
    await ensureLibvirtStorageDir(storagePool);
    diskPath = path.join(storagePool, `${name}-disk-${suffix}.qcow2`);
    await execFileAsync("qemu-img", ["create", "-f", "qcow2", diskPath, `${sizeGb}G`]);
  }
  if (!diskPath) throw new Error("Must provide sizeGb or existingPath");
  await ensureLibvirtDiskAccess(diskPath);

  const xml = `<disk type="file" device="disk">\n  <driver name="qemu" type="qcow2" cache="none" discard="unmap"/>\n  <source file="${diskPath}"/>\n  <target bus="${bus}"/>\n</disk>`;
  const tmp = `/tmp/auxinux-disk-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    const state = await getDomainState(name);
    const args = ["attach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true, path: diskPath };
}

async function detachDisk(name: string, device: string) {
  const xml = await virsh("dumpxml", name);
  const diskM = xml.match(new RegExp(`<disk[^>]*>[\\s\\S]*?<target dev="${device}"[\\s\\S]*?</disk>`));
  if (!diskM) throw new Error(`Disk ${device} not found`);
  const tmp = `/tmp/auxinux-detach-${Date.now()}.xml`;
  await fs.writeFile(tmp, diskM[0]);
  try {
    await virsh("detach-device", name, tmp, "--config");
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function resizeDisk(name: string, device: string, sizeGb: number) {
  await virsh("blockresize", name, device, `${sizeGb}G`);
  return { ok: true };
}

async function attachNetwork(p: Record<string, unknown>) {
  const name = p.name as string;
  const bridge = p.bridge as string;
  const model = (p.model as string) ?? "virtio";
  const mac = p.mac as string | undefined;
  await ensureVmBridgeReady(bridge);
  const macAttr = mac ? `<mac address="${mac}"/>` : "";
  const xml = `<interface type="bridge"><source bridge="${bridge}"/>${macAttr}<model type="${model}"/></interface>`;
  const tmp = `/tmp/auxinux-nic-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    const state = await getDomainState(name);
    const args = ["attach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function detachNetwork(name: string, mac: string) {
  const xml = await virsh("dumpxml", name);
  const nic = parseInterfaceBlocks(xml).find((entry) => entry.mac === mac.toLowerCase());
  if (!nic) throw new Error(`NIC with MAC ${mac} not found`);
  const tmp = `/tmp/auxinux-detach-nic-${Date.now()}.xml`;
  await fs.writeFile(tmp, nic.block);
  try {
    const state = await getDomainState(name);
    const args = ["detach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function updateNetwork(p: Record<string, unknown>) {
  const name = p.name as string;
  const mac = p.mac as string;
  const newBridge = p.bridge as string | undefined;
  const newModel = p.model as string | undefined;
  const newMac = p.newMac as string | undefined;
  const xml = await virsh("dumpxml", name);
  const nic = parseInterfaceBlocks(xml).find((entry) => entry.mac === mac.toLowerCase());
  if (!nic) throw new Error(`NIC with MAC ${mac} not found`);
  let nicXml = nic.block;
  if (newBridge) {
    await ensureVmBridgeReady(newBridge);
    if (/<source\b[^>]*bridge=['"][^'"]+['"]/i.test(nicXml)) {
      nicXml = nicXml.replace(/(<source\b[^>]*bridge=['"])[^'"]+(['"][^>]*\/?>)/i, `$1${newBridge}$2`);
    } else if (/<source\b[^>]*network=['"][^'"]+['"]/i.test(nicXml)) {
      nicXml = nicXml.replace(/<source\b[^>]*network=['"][^'"]+['"][^>]*\/?>/i, `<source bridge="${newBridge}"/>`);
    } else {
      nicXml = nicXml.replace(/<interface\b([^>]*)>/i, `<interface$1><source bridge="${newBridge}"/>`);
    }
  }
  if (newModel) {
    if (/<model\b[^>]*type=['"][^'"]+['"]/i.test(nicXml)) {
      nicXml = nicXml.replace(/(<model\b[^>]*type=['"])[^'"]+(['"][^>]*\/?>)/i, `$1${newModel}$2`);
    } else {
      nicXml = nicXml.replace(/<\/interface>/i, `  <model type="${newModel}"/>\n</interface>`);
    }
  }
  if (newMac) {
    if (/<mac\b[^>]*address=['"][^'"]+['"]/i.test(nicXml)) {
      nicXml = nicXml.replace(/(<mac\b[^>]*address=['"])[^'"]+(['"][^>]*\/?>)/i, `$1${newMac}$2`);
    } else {
      nicXml = nicXml.replace(/(<source\b[^>]*\/?>)/i, `$1\n      <mac address="${newMac}"/>`);
    }
  }
  const tmp = `/tmp/auxinux-update-nic-${Date.now()}.xml`;
  await fs.writeFile(tmp, nicXml);
  try {
    const state = await getDomainState(name);
    const args = ["update-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function attachUsbDevice(p: Record<string, unknown>) {
  const name = validateVmName(p.name as string);
  const vendorId = normalizeUsbId(p.vendorId, "vendorId");
  const productId = normalizeUsbId(p.productId, "productId");
  const bus = normalizeUsbAddress(p.bus, "bus");
  const device = normalizeUsbAddress(p.device, "device");
  const addressXml = bus && device ? `    <address bus="${parseInt(bus, 10)}" device="${parseInt(device, 10)}"/>\n` : "";
  const xml = `<hostdev mode="subsystem" type="usb" managed="yes">\n  <source>\n    <vendor id="0x${vendorId}"/>\n    <product id="0x${productId}"/>\n${addressXml}  </source>\n</hostdev>\n`;
  const tmp = `/tmp/auxinux-usb-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    const state = await getDomainState(name);
    const args = ["attach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function detachUsbDevice(p: Record<string, unknown>) {
  const name = validateVmName(p.name as string);
  const vendorId = normalizeUsbId(p.vendorId, "vendorId");
  const productId = normalizeUsbId(p.productId, "productId");
  const bus = normalizeUsbAddress(p.bus, "bus");
  const device = normalizeUsbAddress(p.device, "device");
  const xml = await virsh("dumpxml", name);
  const usb = parseUsbHostdevBlocks(xml).find((entry) =>
    entry.vendorId === vendorId &&
    entry.productId === productId &&
    (!bus || entry.bus === bus) &&
    (!device || entry.device === device)
  );
  if (!usb) throw new Error(`USB device ${vendorId}:${productId} not attached to VM ${name}`);
  const tmp = `/tmp/auxinux-detach-usb-${Date.now()}.xml`;
  await fs.writeFile(tmp, usb.block);
  try {
    const state = await getDomainState(name);
    const args = ["detach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function attachIso(name: string, isoPath: string) {
  const safeIsoPath = validatePath(isoPath, "isoPath");
  await ensureLibvirtIsoAccess(safeIsoPath);
  const domainXml = await virsh("dumpxml", name);
  const existingCdrom = parseDiskXmlBlocks(domainXml).find((disk) => disk.readonly && disk.deviceType === "cdrom");
  const state = await getDomainState(name);
  const liveArgs = state === "running" || state === "paused" ? ["--live", "--config"] : ["--config"];
  if (existingCdrom?.device && existingCdrom.block) {
    let cdromXml = existingCdrom.block;
    if (/<source\b[^>]*file=['"][^'"]+['"][^>]*\/?>/i.test(cdromXml)) {
      cdromXml = cdromXml.replace(/(<source\b[^>]*file=['"])[^'"]+(['"][^>]*\/?>)/i, `$1${safeIsoPath}$2`);
    } else if (/<driver\b[^>]*\/>/i.test(cdromXml)) {
      cdromXml = cdromXml.replace(/(<driver\b[^>]*\/>)/i, `$1\n      <source file="${safeIsoPath}"/>`);
    } else {
      cdromXml = cdromXml.replace(/<disk\b([^>]*)>/i, `<disk$1>\n      <source file="${safeIsoPath}"/>`);
    }
    const tmp = `/tmp/auxinux-iso-update-${Date.now()}.xml`;
    await fs.writeFile(tmp, cdromXml);
    try {
      try {
        await virsh("update-device", name, tmp, ...liveArgs);
      } catch {
        await virsh("change-media", name, existingCdrom.device, "--insert", safeIsoPath, "--force", ...liveArgs);
      }
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    await defineBootOrder(name, "cdrom");
    return { ok: true };
  }

  const usedDevices = parseDiskXmlBlocks(domainXml).map((disk) => disk.device);
  const cdDev = nextDiskTarget(usedDevices, "sata");
  const xml = `<disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="${xmlEscape(safeIsoPath)}"/><target dev="${cdDev}" bus="sata"/><readonly/></disk>`;
  const tmp = `/tmp/auxinux-iso-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    const args = ["attach-device", name, tmp, "--config"];
    if (state === "running" || state === "paused") args.push("--live");
    await virsh(...args);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await defineBootOrder(name, "cdrom");
  return { ok: true };
}

async function ejectIso(name: string) {
  const domainXml = await virsh("dumpxml", name);
  const existingCdrom = parseDiskXmlBlocks(domainXml).find((disk) => disk.readonly && disk.deviceType === "cdrom");
  if (!existingCdrom?.device || !existingCdrom.block) return { ok: true };
  const state = await getDomainState(name);
  const args = state === "running" || state === "paused" ? ["--live", "--config"] : ["--config"];
  const cdromXml = existingCdrom.block.replace(/\s*<source\b[^>]*file=['"][^'"]+['"][^>]*\/?>\n?/i, "\n");
  const tmp = `/tmp/auxinux-iso-eject-${Date.now()}.xml`;
  await fs.writeFile(tmp, cdromXml);
  try {
    try {
      await virsh("update-device", name, tmp, ...args);
    } catch {
      await virsh("change-media", name, existingCdrom.device, "--eject", "--force", ...args);
    }
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function createSnapshot(name: string, snapName: string, description: string) {
  const initialState = await getDomainState(name);
  const safeDescription = description?.trim();
  if (initialState === "running" || initialState === "paused") {
    const xml = await virsh("dumpxml", name);
    const writableDisks = parseDiskBlocks(xml).filter((disk) => disk.deviceType === "disk" && !disk.readonly && disk.source && disk.device);
    if (writableDisks.length === 0) {
      throw new Error("No writable disk found for live snapshot");
    }

    const timestamp = Date.now();
    const args = [
      "snapshot-create-as",
      name,
      snapName,
      "--disk-only",
      "--atomic",
    ];

    if (safeDescription) {
      args.splice(3, 0, safeDescription);
    }

    for (const disk of writableDisks) {
      const overlayPath = path.join(
        path.dirname(disk.source),
        `${path.basename(disk.source)}.auxinux-snapshot-${snapName}-${timestamp}.qcow2`
      );
      await fs.unlink(overlayPath).catch(() => {});
      args.push("--diskspec", `${disk.device},snapshot=external,file=${overlayPath}`);
    }

    try {
      await virsh(...args);
      await resumeIfUnexpectedlyPaused(name, initialState);
    } catch (error) {
      await resumeIfUnexpectedlyPaused(name, initialState);
      throw error;
    }
    return { ok: true };
  }

  const descriptionBlock = safeDescription ? `<description>${safeDescription}</description>` : "";
  const xml = `<domainsnapshot><name>${snapName}</name>${descriptionBlock}</domainsnapshot>`;
  const tmp = `/tmp/auxinux-snap-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    await virsh("snapshot-create", name, "--xmlfile", tmp);
    await resumeIfUnexpectedlyPaused(name, initialState);
  } catch (error) {
    await resumeIfUnexpectedlyPaused(name, initialState);
    throw error;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function listSnapshots(name: string) {
  const out = await virsh("snapshot-list", name, "--name");
  const snapshotNames = out.split("\n").map((line) => line.trim()).filter(Boolean);
  const currentName = await virsh("snapshot-current", "--name", name).then((value) => value.trim()).catch(() => "");

  const snapshots = await Promise.all(snapshotNames.map(async (snapshotName) => {
    let createdAt = "";
    let state = "unknown";
    let description = "";

    try {
      const info = await virsh("snapshot-info", name, snapshotName);
      createdAt = parseField(info, "Creation Time") ?? "";
      state = parseField(info, "State") ?? "unknown";
    } catch {}

    try {
      const snapshotXml = await virsh("snapshot-dumpxml", name, snapshotName);
      description = extractSnapshotDescription(snapshotXml);
    } catch {}

    return {
      name: snapshotName,
      description,
      createdAt,
      state,
      isCurrent: snapshotName === currentName,
    };
  }));

  return snapshots;
}

async function rollbackSnapshot(name: string, snapName: string) {
  const initialState = await getDomainState(name);
  try {
    await virsh("snapshot-revert", name, snapName);
    await resumeIfUnexpectedlyPaused(name, initialState);
  } catch (error) {
    try {
      const snapshotXml = await virsh("snapshot-dumpxml", name, snapName).catch(() => "");
      const snapshotDisks = parseSnapshotDiskSources(snapshotXml).filter((disk) => disk.snapshot === "external" && disk.source);
      if (snapshotDisks.length === 0) {
        await resumeIfUnexpectedlyPaused(name, initialState);
        throw error;
      }

      const domainXml = await virsh("dumpxml", name);
      const wasActive = initialState === "running" || initialState === "paused";

      if (wasActive) {
        await virsh("destroy", name).catch(() => {});
      }

      let updatedXml = domainXml;
      const rollbackOverlays: string[] = [];

      for (const snapshotDisk of snapshotDisks) {
        const exists = await pathExists(snapshotDisk.source);
        if (!exists) {
          throw new Error(`Snapshot source disk is missing: ${snapshotDisk.source}`);
        }

        const diskInfo = await getQemuImgInfo(snapshotDisk.source);
        const resolvedBacking = diskInfo?.fullBackingFile
          ?? (diskInfo?.backingFile ? path.resolve(path.dirname(snapshotDisk.source), diskInfo.backingFile) : undefined);
        if (resolvedBacking && !(await pathExists(resolvedBacking))) {
          throw new Error(`Snapshot backing chain is broken: ${snapshotDisk.source} requires ${resolvedBacking}`);
        }

        const rollbackOverlay = `${snapshotDisk.source}.auxinux-rollback-${snapName}-${Date.now()}.qcow2`;
        await fs.unlink(rollbackOverlay).catch(() => {});
        const createArgs = ["create", "-f", "qcow2", "-o"];
        const options = [
          `backing_fmt=${diskInfo?.format ?? "qcow2"}`,
          `backing_file=${snapshotDisk.source}`,
        ];
        createArgs.push(options.join(","), rollbackOverlay);
        await execFileAsync("qemu-img", createArgs);
        await ensureLibvirtDiskAccess(rollbackOverlay);
        rollbackOverlays.push(rollbackOverlay);
        updatedXml = replaceDiskSource(updatedXml, snapshotDisk.name, rollbackOverlay);
      }

      const tmp = `/tmp/auxinux-rollback-${name}-${Date.now()}.xml`;
      await fs.writeFile(tmp, updatedXml);
      try {
        await virsh("define", tmp);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }

      if (wasActive) {
        await virsh("start", name);
      }

      return { ok: true, fallback: "manual-external-rollback" };
    } catch (fallbackError) {
      await resumeIfUnexpectedlyPaused(name, initialState);
      throw fallbackError instanceof Error ? fallbackError : error;
    }
  }
  return { ok: true };
}

async function deleteSnapshot(name: string, snapName: string) {
  const initialState = await getDomainState(name);
  const snapshotExists = async () => {
    try {
      await virsh("snapshot-info", name, snapName);
      return true;
    } catch {
      return false;
    }
  };

  try {
    await virsh("snapshot-delete", name, snapName);
    await resumeIfUnexpectedlyPaused(name, initialState);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    try {
      const [snapshotXml, domainXml, currentName] = await Promise.all([
        virsh("snapshot-dumpxml", name, snapName).catch(() => ""),
        virsh("dumpxml", name).catch(() => ""),
        virsh("snapshot-current", "--name", name).then((value) => value.trim()).catch(() => ""),
      ]);

      const snapshotDisks = parseSnapshotDiskSources(snapshotXml).filter((disk) => disk.snapshot === "external" && disk.source);
      const domainDisks = parseDiskBlocks(domainXml);

      if (currentName === snapName || snapshotDisks.length > 0) {
        for (const snapshotDisk of snapshotDisks) {
          const currentDisk = domainDisks.find((disk) => disk.device === snapshotDisk.name);
          if (!currentDisk?.device) continue;
          if (currentDisk.source && currentDisk.source === snapshotDisk.source) {
            try {
              await virsh("blockcommit", name, currentDisk.device, "--active", "--verbose", "--pivot");
            } catch {}
          }
        }
      }

      try {
        await virsh("snapshot-delete", name, snapName, "--metadata");
      } catch (metadataError) {
        if (!(await snapshotExists())) {
          await resumeIfUnexpectedlyPaused(name, initialState);
          return { ok: true };
        }
        const metadataMessage = metadataError instanceof Error ? metadataError.message : String(metadataError);
        throw new Error(`${originalMessage}\n${metadataMessage}`);
      }
      await resumeIfUnexpectedlyPaused(name, initialState);
      return { ok: true };
    } catch (fallbackError) {
      await resumeIfUnexpectedlyPaused(name, initialState);
      throw fallbackError instanceof Error ? fallbackError : error;
    }
  }
  return { ok: true };
}

/**
 * Run `qemu-img` with `-p`, parsing its `(NN.NN/100%)` progress output and
 * streaming a REAL percentage via `emit`. Rejects on non-zero exit.
 */
async function qemuImgWithProgress(args: string[], emit?: ProgressEmitter): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("qemu-img", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      const matches = text.match(/\(\s*([\d.]+)\/100%\)/g);
      if (matches && emit) {
        const last = matches[matches.length - 1];
        const pct = parseFloat(last.replace(/[^\d.]/g, ""));
        if (Number.isFinite(pct)) emit({ percent: Math.round(pct), message: "Writing disk image" });
      }
    };
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); onChunk(c); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`qemu-img exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function backupVm(p: Record<string, unknown>, emit?: ProgressEmitter) {
  const name = p.name as string;
  const storagePool = p.storagePool as string;
  const format = (p.format as string) ?? "qcow2";
  const compress = (p.compress as boolean | undefined) ?? true;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // For the multi-disk archive format we use the best available compressor
  // (zstd → pigz → gzip); the qcow2 single-file format compresses internally.
  // If the caller named the file, match the compressor to its extension.
  const isArchiveFormat = format !== "qcow2";
  const level = typeof p.compressionLevel === "number" ? (p.compressionLevel as number) : undefined;
  const archiveCompressor = isArchiveFormat
    ? (p.filename ? await resolveCompressorForFilename(p.filename as string, level) : await resolveCompressor(level))
    : null;
  const archiveExt = archiveCompressor?.ext ?? "tar.gz";
  // Reconcile a caller-supplied archive name to the actual compressor extension
  // (zstd may have fallen back to gzip), so contents and name always agree.
  const filename = p.filename
    ? (isArchiveFormat ? retargetArchiveExt(p.filename as string, archiveExt) : (p.filename as string))
    : `${name}-${timestamp}.${format === "qcow2" ? "qcow2" : archiveExt}`;
  const destPath = path.join(storagePool, "backups", filename);

  await fs.mkdir(path.join(storagePool, "backups"), { recursive: true });
  const state = await getDomainState(name);
  const xml = await virsh("dumpxml", name);

  // Collect ALL writable disks (not just the primary)
  const writableDisks = parseDiskBlocks(xml).filter(
    (disk) => disk.deviceType === "disk" && !disk.readonly && disk.source,
  );
  if (writableDisks.length === 0) throw new Error("No writable disk found for VM");
  const primaryDisk = writableDisks[0];

  const liveBackup = state === "running" || state === "paused";

  // For live backup: create external snapshots for ALL writable disks atomically
  const overlays: Array<{ disk: (typeof writableDisks)[0]; overlayPath: string }> = [];
  if (liveBackup) {
    const diskSpecs: string[] = [];
    for (const disk of writableDisks) {
      const overlayPath = path.join(
        path.dirname(disk.source!),
        `${path.basename(disk.source!)}.auxinux-backup-${timestamp}.qcow2`,
      );
      await fs.unlink(overlayPath).catch(() => {});
      diskSpecs.push("--diskspec", `${disk.device},snapshot=external,file=${overlayPath}`);
      overlays.push({ disk, overlayPath });
    }
    await virsh(
      "snapshot-create-as",
      name,
      `auxinux-live-backup-${timestamp}`,
      "--disk-only",
      "--atomic",
      "--no-metadata",
      ...diskSpecs,
    );
  }

  try {
    if (format === "qcow2") {
      // qcow2 is a single-file format: back up primary disk only. `-p` streams a
      // REAL progress percentage. Prefer zstd compression inside the qcow2;
      // fall back to plain `-c` (zlib) on older qemu-img that lacks zstd.
      const base = ["convert", "-p", "-O", "qcow2"];
      const src = primaryDisk.source!;
      if (compress) {
        try {
          await qemuImgWithProgress([...base, "-c", "-o", "compression_type=zstd", src, destPath], emit);
        } catch {
          await fs.unlink(destPath).catch(() => {});
          await qemuImgWithProgress([...base, "-c", src, destPath], emit);
        }
      } else {
        await qemuImgWithProgress([...base, src, destPath], emit);
      }
    } else {
      // archive format: include ALL writable disk files + VM XML definition,
      // compressed with the best available compressor (zstd preferred), with a
      // real progress percentage via pv.
      const xmlPath = `/tmp/${name}-${timestamp}.xml`;
      await fs.writeFile(xmlPath, xml);
      try {
        const diskPaths = writableDisks.map((d) => d.source!);
        let totalBytes = 0;
        for (const dp of diskPaths) {
          totalBytes += await fs.stat(dp).then((s) => s.size).catch(() => 0);
        }
        await runTarPipeline({
          tarArgs: ["-cf", "-", ...diskPaths, xmlPath],
          compressor: archiveCompressor!,
          destPath,
          totalBytes: totalBytes > 0 ? totalBytes : undefined,
          emit,
        });
      } finally {
        await fs.unlink(xmlPath).catch(() => {});
      }
    }
  } finally {
    // Pivot ALL disks back from their overlays (live backup cleanup).
    // CRITICAL: only delete the overlay when the pivot SUCCEEDED. If blockcommit
    // fails, the domain is still pointing at the overlay — deleting it would
    // leave the VM referencing a missing file and it could never start again
    // ("Cannot access storage file ... No such file or directory").
    const pivotFailures: string[] = [];
    for (const { disk, overlayPath } of overlays) {
      let pivoted = false;
      try {
        await virsh("blockcommit", name, disk.device, "--active", "--verbose", "--pivot");
        pivoted = true;
      } catch (err) {
        pivotFailures.push(`${disk.device}: ${(err as Error).message}`);
        console.error(`[backup] blockcommit --pivot failed for disk ${disk.device} — keeping overlay ${overlayPath} (it is still the live disk):`, (err as Error).message);
      }
      if (pivoted) {
        await fs.unlink(overlayPath).catch(() => {});
      }
    }
    if (pivotFailures.length > 0) {
      // Surface the problem instead of silently leaving the VM on a temp overlay.
      throw new Error(
        `Backup file was created, but the live disk could not be pivoted back to its base for: ${pivotFailures.join("; ")}. ` +
        `The temporary overlay was kept so the VM stays bootable; commit it manually with: virsh blockcommit ${name} <disk> --active --pivot`,
      );
    }
  }

  const stat = await fs.stat(destPath);
  return { ok: true, filename, sizeBytes: stat.size, destPath };
}

/**
 * Rename a libvirt domain (inactive only). Disks are untouched. Throws coded
 * errors the API maps to 409 (running / exists) or 400 (invalid).
 */
async function renameVm(name: string, newName: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(newName)) {
    throw Object.assign(new Error("Invalid VM name"), { code: "INVALID_NAME" });
  }
  if (name === newName) return { ok: true, name };
  if (!(await domainExists(name))) throw Object.assign(new Error("VM not found"), { code: "NOT_FOUND" });
  if (await domainExists(newName)) throw Object.assign(new Error(`A VM named '${newName}' already exists`), { code: "EXISTS" });
  const state = await getDomainState(name);
  if (state === "running" || state === "paused") {
    throw Object.assign(new Error("VM must be stopped before rename"), { code: "RUNNING" });
  }
  await removeRdpGateway(name).catch(() => {});
  try {
    await virsh("domrename", name, newName);
  } catch (err) {
    throw Object.assign(new Error(`libvirt rename failed: ${(err as Error).message}`), { code: "RENAME_FAILED" });
  }
  if (!(await domainExists(newName))) {
    throw Object.assign(new Error("Rename did not take effect"), { code: "RENAME_FAILED" });
  }
  return { ok: true, name: newName };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a path that may be a compounded auxinux overlay/backup file
 * (e.g. `disk.qcow2.auxinux-snapshot-X-<ts>.qcow2.auxinux-backup-<ts>.qcow2`),
 * return the immediate parent in the chain by stripping the LAST overlay
 * segment, or null if there is no auxinux overlay suffix left.
 */
function auxinuxChainParent(p: string): string | null {
  const idx = p.lastIndexOf(".auxinux-");
  if (idx === -1) return null;
  const tail = p.slice(idx);
  if (!/^\.auxinux-(?:snapshot|backup)-.*\.qcow2$/.test(tail)) return null;
  return p.slice(0, idx);
}

/**
 * Detects QEMU/KVM domains whose disk <source> points at a file that no longer
 * exists — typically a temporary auxinux snapshot/backup overlay that was
 * deleted after a failed pivot — and repoints the domain to the most recent
 * STILL-EXISTING and valid file in its chain so the VM can boot again.
 *
 * Safe by design: only acts on a shut-off domain, never deletes anything,
 * keeps a timestamped backup of the previous XML, and validates each candidate
 * with `qemu-img check` (which also verifies the backing chain) before using it.
 */
async function repairVmDisk(p: Record<string, unknown>) {
  const name = p.name as string;
  if (!name) throw new Error("name is required");

  const state = await getDomainState(name);
  if (state === "running" || state === "paused") {
    throw new Error("La VM est en cours d'exécution — arrête-la d'abord avant de réparer le disque.");
  }

  const xml = await virsh("dumpxml", name);
  const disks = parseDiskBlocks(xml).filter(
    (d) => d.deviceType === "disk" && !d.readonly && d.source,
  );
  if (disks.length === 0) throw new Error("Aucun disque inscriptible trouvé pour cette VM");

  const repairs: Array<{ device: string; from: string; to: string }> = [];
  let newXml = xml;

  for (const disk of disks) {
    const source = disk.source!;
    if (await fileExists(source)) continue; // disk is fine

    // Walk up the auxinux overlay chain to the most recent existing+valid file.
    let candidate: string | null = auxinuxChainParent(source);
    let resolved: string | null = null;
    const tried: string[] = [];
    while (candidate) {
      tried.push(candidate);
      if (await fileExists(candidate)) {
        try {
          await execFileAsync("qemu-img", ["check", candidate]); // validates backing chain too
          resolved = candidate;
          break;
        } catch {
          // file exists but its own chain is broken — keep walking up
        }
      }
      candidate = auxinuxChainParent(candidate);
    }

    if (!resolved) {
      throw new Error(
        `Impossible de réparer le disque ${disk.device} de ${name} : aucun fichier valide trouvé dans la chaîne. ` +
        `Fichier manquant : ${source}. Candidats testés : ${tried.join(", ") || "(aucun)"}.`,
      );
    }

    // Replace the missing source path with the resolved one in the XML.
    newXml = newXml.split(source).join(resolved);
    repairs.push({ device: disk.device, from: source, to: resolved });
  }

  if (repairs.length === 0) {
    return { ok: true, repaired: false, message: "Aucune réparation nécessaire — tous les disques pointent sur des fichiers existants." };
  }

  // Backup the current definition, then redefine the domain.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupXmlPath = `/tmp/${name}-broken-${ts}.xml`;
  await fs.writeFile(backupXmlPath, xml);

  const tmpXml = `/tmp/${name}-repaired-${ts}.xml`;
  await fs.writeFile(tmpXml, newXml);
  try {
    await virsh("define", tmpXml);
  } finally {
    await fs.unlink(tmpXml).catch(() => {});
  }

  return {
    ok: true,
    repaired: true,
    repairs,
    backupXmlPath,
    message: `Disque(s) réparé(s) : ${repairs.map((r) => `${r.device} → ${path.basename(r.to)}`).join(", ")}. Ancienne définition sauvegardée dans ${backupXmlPath}.`,
  };
}

async function restoreVmBackup(p: Record<string, unknown>) {
  const sourcePath = p.sourcePath as string;
  const storagePool = p.storagePool as string;
  const name = p.name as string;
  const bridge = (p.bridge as string | undefined) ?? "virbr0";
  const mac = (p.mac as string | undefined)?.trim() || undefined;
  const vcpus = (p.vcpus as number | undefined) ?? 2;
  const memoryMb = (p.memoryMb as number | undefined) ?? 2048;
  const arch = (p.arch as string | undefined) ?? "x86_64";
  const machine = (p.machine as string | undefined) ?? "q35";
  const bootDevice = ((p.bootDevice as string | undefined) ?? "hd") as "hd" | "cdrom" | "network";
  const qemuAgentEnabled = (p.qemuAgentEnabled as boolean | undefined) ?? true;
  const videoModel = ((p.videoModel as string | undefined) ?? "virtio") as "vga" | "virtio" | "qxl";
  const autostart = (p.autostart as boolean | undefined) ?? false;
  const uefi = (p.uefi as boolean | undefined) ?? false;
  await ensureVmBridgeReady(bridge);

  try {
    await virsh("dominfo", name);
    throw new Error(`VM ${name} already exists`);
  } catch (error) {
    if (!(error instanceof Error) || !/failed to get domain/i.test(error.message)) {
      throw error;
    }
  }

  await ensureLibvirtStorageDir(storagePool);
  const diskPath = path.join(storagePool, `${name}.qcow2`);
  // Extract inside the destination pool (same filesystem as the final disk),
  // NOT /tmp: /tmp is commonly a small tmpfs and full VM disk images don't fit
  // there, aborting the restore with "No space left on device".
  const tempDir = await fs.mkdtemp(path.join(storagePool, ".auxinux-vm-restore-"));

  try {
    let xmlToDefine = "";
    const lowerSrc = sourcePath.toLowerCase();
    const isArchive = lowerSrc.endsWith(".tar.gz") || lowerSrc.endsWith(".tar.zst") || lowerSrc.endsWith(".tgz") || lowerSrc.endsWith(".tzst");
    if (isArchive) {
      // Decompress by extension so legacy .tar.gz and new .tar.zst both restore.
      await execFileAsync("tar", ["--use-compress-program", decompressorFor(sourcePath), "-xf", sourcePath, "-C", tempDir]);
      const xmlFiles = await findFilesRecursive(tempDir, (fullPath) => fullPath.endsWith(".xml"));
      const diskCandidates = await findFilesRecursive(tempDir, (fullPath) => /\.(qcow2|img|raw|vmdk)$/i.test(fullPath));
      if (diskCandidates.length === 0) {
        throw new Error("No disk image found in VM backup archive");
      }

      let extractedDisk = diskCandidates[0];
      if (xmlFiles[0]) {
        const originalXml = await fs.readFile(xmlFiles[0], "utf8");
        const originalPrimary = parseDiskBlocks(originalXml).find((disk) => disk.deviceType === "disk" && !disk.readonly);
        if (originalPrimary?.source) {
          const sameBasename = diskCandidates.find((candidate) => path.basename(candidate) === path.basename(originalPrimary.source));
          if (sameBasename) extractedDisk = sameBasename;
        }
        await execFileAsync("qemu-img", ["convert", "-O", "qcow2", extractedDisk, diskPath]);
        await ensureLibvirtDiskAccess(diskPath);
        xmlToDefine = stripDomainIdentity(originalXml)
          .replace(/<name>[\s\S]*?<\/name>/i, `<name>${name}</name>`);
        if (originalPrimary?.source) {
          xmlToDefine = xmlToDefine.replace(
            new RegExp(`(<source\\s+file=['"])${escapeRegExp(originalPrimary.source)}(['"][^>]*>)`, "i"),
            `$1${diskPath}$2`
          );
        }
        xmlToDefine = updateInterfaceBridge(xmlToDefine, bridge, mac);
        xmlToDefine = ensurePerformanceDefaults(ensureGuestAgentChannel(ensureVideoModel(ensureSerialConsole(xmlToDefine), videoModel), qemuAgentEnabled));
        xmlToDefine = applyBootOrder(xmlToDefine, bootDevice);
        // Optional resource overrides — only when the restore explicitly modifies
        // CPU/RAM; otherwise keep the VM's original vcpu/memory from the backup.
        if (typeof p.vcpus === "number") {
          xmlToDefine = replaceXmlTag(xmlToDefine, "vcpu", String(p.vcpus));
          xmlToDefine = ensurePerformanceDefaults(xmlToDefine);
        }
        if (typeof p.memoryMb === "number") {
          xmlToDefine = replaceXmlTag(xmlToDefine, "memory", String(p.memoryMb), ` unit="MiB"`);
          xmlToDefine = replaceXmlTag(xmlToDefine, "currentMemory", String(p.memoryMb), ` unit="MiB"`);
        }
      } else {
        await execFileAsync("qemu-img", ["convert", "-O", "qcow2", extractedDisk, diskPath]);
        await ensureLibvirtDiskAccess(diskPath);
      }
    } else {
      await execFileAsync("qemu-img", ["convert", "-O", "qcow2", sourcePath, diskPath]);
      await ensureLibvirtDiskAccess(diskPath);
    }

    if (!xmlToDefine) {
      xmlToDefine = buildImportedVmXml({
        name,
        arch,
        machine,
        uefi,
        loader: uefi ? await resolveUefiLoader(arch) : undefined,
        vcpus,
        memoryMb,
        diskPath,
        bridge,
        mac,
        bootDevice,
        qemuAgentEnabled,
        videoModel,
      });
    }

    const xmlPath = path.join(tempDir, `${name}.xml`);
    await fs.writeFile(xmlPath, xmlToDefine);
    await virsh("define", xmlPath);
    if (autostart) {
      await virsh("autostart", name);
    }
    return { ok: true, name, diskPath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Template-based VM creation ────────────────────────────────────────────────

/**
 * Lists a .tar.gz and rejects anything dangerous BEFORE extraction: absolute
 * paths, `..` traversal, and any non regular-file / non-directory member
 * (symlinks, hardlinks, devices, fifos). `tar -tzvf` prints a permissions
 * column whose first character encodes the entry type ('-' file, 'd' dir,
 * 'l' symlink, 'h' hardlink, etc.).
 */
async function assertSafeArchive(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["--use-compress-program", decompressorFor(archivePath), "-tvf", archivePath], { maxBuffer: 16 * 1024 * 1024 });
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const typeChar = line[0];
    if (typeChar !== "-" && typeChar !== "d") {
      throw new Error("Template archive contains a non-regular file (symlink/hardlink/device) — refused");
    }
    // The member name is everything after the "date time " column. Strip a
    // possible "name -> target" suffix defensively (only present for links,
    // which are already rejected above).
    const arrow = line.indexOf(" -> ");
    const tail = arrow >= 0 ? line.slice(0, arrow) : line;
    const name = tail.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, "").trim();
    if (name && isUnsafeArchivePath(name)) {
      throw new Error("Template archive contains an unsafe path (absolute or traversal) — refused");
    }
  }
}

async function createVmFromTemplate(p: Record<string, unknown>) {
  const archivePath = p.archivePath as string;
  const storagePool = p.storagePool as string;
  const name = p.name as string;
  const bridge = (p.bridge as string | undefined) ?? "virbr0";
  const mac = (p.mac as string | undefined)?.trim() || undefined;
  const arch = (p.arch as string | undefined) ?? "x86_64";
  const machine = (p.machine as string | undefined) ?? "q35";
  const uefi = (p.uefi as boolean | undefined) ?? false;
  const videoModel = ((p.videoModel as string | undefined) ?? "virtio") as "vga" | "virtio" | "qxl";
  const qemuAgentEnabled = (p.qemuAgentEnabled as boolean | undefined) ?? true;
  const autostart = (p.autostart as boolean | undefined) ?? false;
  const expectedDisk = (p.expectedDisk as string | undefined) || undefined;

  if (!archivePath || !storagePool || !name) {
    throw new Error("archivePath, storagePool and name are required");
  }

  // Refuse to clobber an existing domain.
  try {
    await virsh("dominfo", name);
    throw new Error(`VM ${name} already exists`);
  } catch (error) {
    if (!(error instanceof Error) || !/failed to get domain/i.test(error.message)) throw error;
  }

  await assertSafeArchive(archivePath);

  await ensureLibvirtStorageDir(storagePool);
  const diskPath = path.join(storagePool, `${name}.qcow2`);
  const tempDir = await fs.mkdtemp("/tmp/auxinux-vm-template-");

  try {
    // --no-same-owner / -p kept off: extract as the runner user, no setuid bits.
    await execFileAsync("tar", ["--use-compress-program", decompressorFor(archivePath), "-xf", archivePath, "-C", tempDir, "--no-same-owner"]);

    // Validate config.virtua (best-effort: a template without it still works as
    // a raw disk import, but we surface a clear error if it's malformed).
    const configCandidates = await findFilesRecursive(tempDir, (fp) => path.basename(fp).toLowerCase() === "config.virtua");
    let vcpus = (p.vcpus as number | undefined) ?? 2;
    let memoryMb = (p.memoryMb as number | undefined) ?? 2048;
    if (configCandidates[0]) {
      const cfg = parseVirtuaConfig(await fs.readFile(configCandidates[0], "utf8"));
      if (!cfg.name) throw new Error("config.virtua is invalid: missing Name");
      // Caller-provided overrides win; otherwise fall back to template defaults.
      if (p.vcpus === undefined && cfg.cpu) vcpus = cfg.cpu;
      if (p.memoryMb === undefined && cfg.ram) memoryMb = cfg.ram;
    }

    // Locate the disk image. Prefer the name declared by the template metadata.
    const diskCandidates = await findFilesRecursive(tempDir, (fp) => /\.(qcow2|img|raw|vmdk)$/i.test(fp));
    if (diskCandidates.length === 0) throw new Error("No disk image found in VM template archive");
    let sourceDisk = diskCandidates[0];
    if (expectedDisk) {
      const match = diskCandidates.find((c) => path.basename(c) === path.basename(expectedDisk));
      if (match) sourceDisk = match;
    }

    // Validate the disk (also checks the qcow2 backing chain) before importing.
    await execFileAsync("qemu-img", ["check", sourceDisk]).catch((err) => {
      throw new Error(`Template disk failed integrity check: ${err instanceof Error ? err.message : String(err)}`);
    });
    await execFileAsync("qemu-img", ["convert", "-O", "qcow2", sourceDisk, diskPath]);
    await ensureLibvirtDiskAccess(diskPath);

    await ensureVmBridgeReady(bridge);
    const xml = buildImportedVmXml({
      name,
      arch,
      machine,
      uefi,
      loader: uefi ? await resolveUefiLoader(arch) : undefined,
      vcpus,
      memoryMb,
      diskPath,
      bridge,
      mac,
      bootDevice: "hd",
      qemuAgentEnabled,
      videoModel,
    });
    const xmlPath = path.join(tempDir, `${name}.xml`);
    await fs.writeFile(xmlPath, xml);
    await virsh("define", xmlPath);
    if (autostart) await virsh("autostart", name);
    return { ok: true, name, diskPath, vcpus, memoryMb };
  } catch (error) {
    await fs.rm(diskPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cloneVm(name: string, newName: string) {
  await execFileAsync("virt-clone", ["--original", name, "--name", newName, "--auto-clone"]);
  return { ok: true, newName };
}

async function exportVmAsTemplate(
  vmName: string,
  templateName: string,
  description: string,
  outputDir: string,
  emit?: ProgressEmitter,
): Promise<{ ok: boolean; filename: string; jsonFilename: string; sizeBytes: number }> {
  await fs.mkdir(outputDir, { recursive: true });

  const xml = await virsh("dumpxml", vmName);
  const vcpus = parseXmlNumberTag(xml, "vcpu") || 1;
  const maxMemKiB = parseMemoryKiB(xml, "memory") || 512 * 1024;
  const arch = xml.match(/arch=['"]([^'"]+)['"]/)?.[1] ?? "x86_64";

  const primaryDisk = parseDiskBlocks(xml).find((d) => d.deviceType === "disk" && !d.readonly && d.source);
  if (!primaryDisk?.source) throw new Error("No writable disk found for VM");

  const diskSizeBytes = await fs.stat(primaryDisk.source).then((s) => s.size).catch(() => 0);
  const diskGb = Math.ceil(diskSizeBytes / (1024 ** 3)) || 10;
  const ramMb = Math.round(maxMemKiB / 1024);

  const safeName = templateName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const qcow2Name = `${safeName}.qcow2`;
  const jsonName = `${safeName}.json`;
  const archiveName = `${safeName}.tar.gz`;
  const tmpDir = path.join(outputDir, `.tmp-export-${safeName}-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const tmpQcow2 = path.join(tmpDir, qcow2Name);
    emit?.({ percent: 5, message: "Converting disk to flat qcow2" });
    await qemuImgWithProgress(["convert", "-p", "-O", "qcow2", primaryDisk.source, tmpQcow2], emit);

    const sidecar = { Name: templateName, Desc: description, CPU: vcpus, RAM: ramMb, DISK: diskGb, ARCH: arch };
    await fs.writeFile(path.join(tmpDir, jsonName), JSON.stringify(sidecar, null, 2));

    emit?.({ percent: 95, message: "Creating archive" });
    const archivePath = path.join(outputDir, archiveName);
    await execFileAsync("tar", ["-czf", archivePath, "-C", tmpDir, qcow2Name, jsonName]);

    const stat = await fs.stat(archivePath);
    emit?.({ percent: 100, message: "Export complete" });
    return { ok: true, filename: archiveName, jsonFilename: jsonName, sizeBytes: stat.size };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function listBridges() {
  try {
    await ensureLibvirtNetworkReady("default").catch(() => {});
    const { stdout } = await execFileAsync("ip", ["-j", "link", "show", "type", "bridge"]);
    const bridges = JSON.parse(stdout) as Array<{ ifname: string }>;
    return bridges.map((b) => b.ifname);
  } catch {
    return ["virbr0"];
  }
}

async function listMachineTypes(arch = "x86_64") {
  try {
    const { stdout } = await execFileAsync(`qemu-system-${arch}`, ["-machine", "help"]);
    const types = stdout.split("\n").slice(1, 20).map((l) => l.split(/\s+/)[0]).filter(Boolean);
    return types;
  } catch {
    return ["pc", "q35"];
  }
}

async function listIsos() {
  try {
    await ensureLibvirtIsoDirAccess(ISOS_DIR);
    const files = await fs.readdir(ISOS_DIR);
    const isos = await Promise.all(files.filter((f) => f.match(/\.(iso|img)$/i)).map(async (f) => {
      const isoPath = path.join(ISOS_DIR, f);
      await ensureLibvirtIsoAccess(isoPath).catch(() => {});
      const stat = await fs.stat(isoPath);
      return { filename: f, sizeBytes: stat.size, path: isoPath };
    }));
    return isos;
  } catch {
    return [];
  }
}

async function deleteIso(filename: string) {
  const safeName = path.basename(filename);
  const fullPath = path.join(ISOS_DIR, safeName);
  const realPath = await fs.realpath(fullPath).catch(() => null);
  if (!realPath || !realPath.startsWith(ISOS_DIR)) throw new Error("Invalid path");
  await fs.unlink(realPath);
  return { ok: true };
}
