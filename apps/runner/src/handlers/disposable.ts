/**
 * Pure helpers of the disposable VMs (beta): base ids, the `.vmtmp` archive
 * checks, the base manifest of a stopped VM and the XML of a converted VM.
 * The I/O (qemu-img, virsh, files) lives in qemu.ts like the other handlers.
 *
 * Layout on a node: `<images>/bases/<id>/` holds `manifest.json`,
 * `disk.qcow2` (read-only backing file) and optionally `disk.vars.fd` (the
 * UEFI variable store the VM had). A disposable VM's disk is a qcow2 overlay
 * `qemu-img create -f qcow2 -F qcow2 -b <base>/disk.qcow2`.
 */
import { BASE_ID_RE, type BaseManifest } from "@auxinux/shared";
import { machineFamily } from "@auxinux/shared";
import { mergeVirtuaMetadata, readVirtuaMetadata } from "./vmHardware.js";

export const VMTMP_MANIFEST = "manifest.json";
export const VMTMP_DISK = "disk.qcow2";
const VARS_FILE_RE = /^disk\.[A-Za-z0-9_-]{1,40}\.fd$/;

export function assertBaseId(id: string): string {
  if (typeof id !== "string" || !BASE_ID_RE.test(id)) throw new Error("Invalid base id");
  return id;
}

/** `<os>-<arch>-<timestamp>` (Desktop's naming), unique per second. */
export function newBaseId(os: string, architecture: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return assertBaseId(`${os}-${architecture}-${stamp}`);
}

/** Node arch (process.arch) in the base vocabulary. */
export function hostBaseArch(processArch: string): "amd64" | "arm64" | undefined {
  if (processArch === "x64") return "amd64";
  if (processArch === "arm64") return "arm64";
  return undefined;
}

export interface TarEntry {
  type: string;
  name: string;
  size: number;
}

/** Parse `tar -tvf` (GNU) lines: `-rw-r--r-- user/group 1234 2026-01-01 12:00 name`. */
export function parseTarListing(stdout: string): TarEntry[] {
  const entries: TarEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/);
    if (!m) throw new Error(`Unreadable archive listing line: ${line.slice(0, 120)}`);
    const arrow = m[3].indexOf(" -> ");
    entries.push({ type: m[1], size: parseInt(m[2], 10), name: (arrow >= 0 ? m[3].slice(0, arrow) : m[3]).trim() });
  }
  return entries;
}

/**
 * Members of a `.vmtmp` worth extracting: the manifest, the disk and UEFI
 * variable stores, at the archive root. Any link or device refuses the whole
 * archive; other regular files are ignored (as Desktop does).
 */
export function selectVmtmpMembers(entries: TarEntry[]): { manifest: string; disk: string; vars: string[] } {
  let manifest: string | undefined;
  let disk: string | undefined;
  const vars: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error("The .vmtmp contains a link or a special file: refused");
    }
    if (entry.type === "d") continue;
    const bare = entry.name.replace(/^\.\//, "");
    if (bare.includes("/") || bare.includes("..")) continue;
    if (bare === VMTMP_MANIFEST) manifest = entry.name;
    else if (bare === VMTMP_DISK) disk = entry.name;
    else if (VARS_FILE_RE.test(bare)) vars.push(entry.name);
  }
  if (!manifest) throw new Error("The .vmtmp has no manifest.json");
  if (!disk) throw new Error("The .vmtmp has no disk.qcow2");
  return { manifest, disk, vars };
}

/** What `qemu-img info --output=json` must say about a base disk. */
export function assertStandaloneQcow2(info: Record<string, unknown>): void {
  if (info.format !== "qcow2") throw new Error(`Base disk must be qcow2 (found ${String(info.format)})`);
  // A backing file inside an imported image could point anywhere on the host.
  if (info["backing-filename"] || info["full-backing-filename"]) {
    throw new Error("Base disk must not have a backing file");
  }
}

function xmlUnescape(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** First writable `device="disk"` of a domain (the system disk). */
export function primaryWritableDisk(xml: string): { source: string; device: string; bus: string; block: string } | undefined {
  for (const match of xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)) {
    const block = match[0];
    const open = block.match(/<disk\b[^>]*>/i)?.[0] ?? "";
    if (!/\bdevice=['"]disk['"]/i.test(open)) continue;
    if (/<readonly\s*\/?>/i.test(block)) continue;
    const source = block.match(/<source\b[^>]*\bfile=['"]([^'"]+)['"]/i)?.[1];
    if (!source) continue;
    return {
      source: xmlUnescape(source),
      device: block.match(/<target\b[^>]*\bdev=['"]([^'"]+)['"]/i)?.[1] ?? "",
      bus: block.match(/<target\b[^>]*\bbus=['"]([^'"]+)['"]/i)?.[1] ?? "virtio",
      block,
    };
  }
  return undefined;
}

/** The domain's UEFI variable store path (`<nvram>…</nvram>`), if any. */
export function domainNvramPath(xml: string): string | undefined {
  const raw = xml.match(/<nvram\b[^>]*>([^<]+)<\/nvram>/i)?.[1]?.trim();
  return raw ? xmlUnescape(raw) : undefined;
}

/** Base manifest of a stopped VM (hardware read from its inactive XML). */
export function manifestFromDomain(
  xml: string,
  info: { id: string; label: string; os: string; diskGib: number; createdAt: string },
): BaseManifest {
  const typeTag = xml.match(/<type\b[^>]*>/i)?.[0] ?? "";
  const arch = typeTag.match(/\barch=['"]([^'"]+)['"]/)?.[1] ?? "x86_64";
  const machine = machineFamily(typeTag.match(/\bmachine=['"]([^'"]+)['"]/)?.[1]);
  const vcpus = parseInt(xml.match(/<vcpu\b[^>]*>(\d+)<\/vcpu>/i)?.[1] ?? "1", 10);
  const memMatch = xml.match(/<memory(?:\s+unit=['"]([^'"]+)['"])?[^>]*>(\d+)<\/memory>/i);
  const unit = (memMatch?.[1] ?? "KiB").toLowerCase();
  const memValue = parseInt(memMatch?.[2] ?? "1048576", 10);
  const memoryMib = unit === "mib" ? memValue : unit === "gib" ? memValue * 1024 : unit === "b" ? Math.round(memValue / 1048576) : Math.round(memValue / 1024);
  const disk = primaryWritableDisk(xml);
  const nicModel = xml.match(/<interface\b[\s\S]*?<model\b[^>]*\btype=['"]([^'"]+)['"]/i)?.[1] ?? "virtio";
  const video = xml.match(/<video\b[\s\S]*?<model\b[^>]*\btype=['"]([^'"]+)['"]/i)?.[1] ?? "vga";
  const meta = readVirtuaMetadata(xml);
  return {
    id: info.id,
    label: info.label,
    os: info.os,
    architecture: arch === "aarch64" ? "arm64" : "amd64",
    guestOs: info.os === "windows11" ? "windows" : "other",
    cpu: Math.max(1, vcpus),
    memoryMib: Math.max(64, memoryMib),
    diskGib: Math.max(1, info.diskGib),
    diskBus: disk?.bus ?? "virtio",
    networkModel: nicModel,
    // Desktop calls the plain VGA adapter "std".
    gpuModel: video === "vga" ? "std" : video,
    tpm2: /<tpm\b/i.test(xml),
    secureBoot: /<loader[^>]*\bsecure=['"]yes['"]/i.test(xml),
    createdAt: info.createdAt,
    source: "local",
    diskSha256: null,
    format: 1,
    uefi: /<loader\b/i.test(xml),
    machine: machine === "other" ? undefined : machine,
    cpuModel: meta.cpuModel,
    periodSpeed: meta.periodSpeed,
  };
}

/**
 * XML of a disposable VM converted into an ordinary one: its disk now points
 * at the flattened copy, no transient flag, no disposable metadata.
 */
export function convertedDomainXml(xml: string, overlayPath: string, flatPath: string): string {
  const disk = primaryWritableDisk(xml);
  if (!disk || disk.source !== overlayPath) throw new Error("The VM's disk is not the disposable overlay");
  const escaped = flatPath.replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const nextBlock = disk.block
    .replace(/(<source\b[^>]*\bfile=)(['"])[^'"]+\2/i, `$1$2${escaped}$2`)
    .replace(/\s*<transient\b[^>]*\/>/i, "")
    // A libvirt-detected backing chain of the overlay must not survive.
    .replace(/\s*<backingStore\b[\s\S]*?<\/backingStore>/i, "")
    .replace(/\s*<backingStore\s*\/>/i, "");
  return mergeVirtuaMetadata(xml.replace(disk.block, nextBlock), { disposable: undefined });
}
