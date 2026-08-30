import { execFile } from "child_process";
import { createHash, randomBytes } from "crypto";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { resolveCompressor, resolveCompressorForFilename, retargetArchiveExt, decompressorFor, runTarPipeline } from "./compression.js";
import type { ProgressEmitter } from "../runner.js";

const execFileAsync = promisify(execFile);

const LXC_DIR = process.env.LXC_DIR ?? "/var/lib/lxc";
const AUXINUX_DATA_DIR = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinuxvirtual";
const TEMPLATE_CACHE_FILE = "/var/tmp/auxinux-lxc-templates.json";
const TEMPLATE_CACHE_TTL = 6 * 60 * 60 * 1000;
const LXC_IMAGE_SERVER = (process.env.LXC_IMAGE_SERVER ?? "https://images.linuxcontainers.org").replace(/\/+$/, "");
const LXC_DOWNLOAD_CACHE_DIR = process.env.LXC_DOWNLOAD_CACHE_DIR ?? "/var/cache/lxc/download";
const LXC_TEMPLATE_CONFIG_DIR = process.env.LXC_TEMPLATE_CONFIG_DIR ?? "/usr/share/lxc/config";
const LXC_SNAPSHOT_DIR = process.env.LXC_SNAPSHOT_DIR ?? path.join(path.dirname(LXC_DIR), "lxcsnaps");
const LXC_MANUAL_SNAPSHOT_DIR = process.env.LXC_MANUAL_SNAPSHOT_DIR ?? path.join(AUXINUX_DATA_DIR, "snapshots", "lxc");
const LXC_SNAPSHOT_MODE = (process.env.LXC_SNAPSHOT_MODE ?? "manual").toLowerCase();
const STABLE_USB_DIR = path.join(AUXINUX_DATA_DIR, "usb");

interface LxcTemplateSpec {
  dist: string;
  release: string;
  arch: string;
  variant: string;
}

interface LxcImageIndexEntry extends LxcTemplateSpec {
  build: string;
  path: string;
}

interface CachedLxcTemplate {
  entry: LxcImageIndexEntry;
  cacheDir: string;
  metaPath: string;
  rootfsPath: string;
}

interface ManualLxcSnapshotMetadata {
  format: "auxinux-lxc-snapshot-v1";
  containerName: string;
  snapshotName: string;
  createdAt: string;
  description?: string;
}

export async function handleLxc(action: string, params: unknown, emit?: ProgressEmitter): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case "lxc_containers": return listContainers();
    case "lxc_create": return createContainer(p);
    case "lxc_delete": return deleteContainer(p.name as string);
    case "lxc_action": return containerAction(p.name as string, p.action as string);
    case "lxc_info": return getContainerInfo(p.name as string);
    case "lxc_stats": return getContainerStats(p.name as string);
    case "lxc_logs": return getContainerLogs(p.name as string, (p.tail as number) ?? 100);
    case "lxc_update_config": return updateContainerConfig(p);
    case "lxc_net_list": return listLxcNics(p.name as string);
    case "lxc_net_add": return addLxcNic(p);
    case "lxc_net_update": return updateLxcNic(p);
    case "lxc_net_delete": return deleteLxcNic(p.name as string, p.index as number);
    case "lxc_rename": return renameContainer(p.name as string, p.newName as string);
    case "lxc_templates": return getTemplates((p.refresh as boolean) ?? false);
    case "lxc_cache_template": return cacheTemplate(p);
    case "lxc_cache_list": return listCache();
    case "lxc_cache_delete": return clearCache();
    case "lxc_cache_delete_entry": return deleteCacheEntry(p.dist as string, p.release as string);
    case "lxc_snapshot_create": return createSnapshot(p.name as string, p.snapName as string, p.description as string | undefined, p.freeze === true);
    case "lxc_snapshot_list": return listSnapshots(p.name as string);
    case "lxc_snapshot_rollback": return rollbackSnapshot(p.name as string, p.snapName as string);
    case "lxc_snapshot_delete": return deleteSnapshot(p.name as string, p.snapName as string);
    case "lxc_backup": return backupContainer(p, emit);
    case "lxc_restore_backup": return restoreContainerBackup(p);
    case "lxc_usb_attach": return attachUsbDevice(p);
    case "lxc_usb_detach": return detachUsbDevice(p);
    case "lxc_gpu_attach": return attachGpuDevice(p);
    case "lxc_gpu_detach": return detachGpuDevice(p);
    default: throw new Error(`Unknown lxc action: ${action}`);
  }
}

async function lxcCmd(cmd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 5 * 1024 * 1024 });
  return stdout;
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSafePart(value: string, field: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid LXC ${field}: ${value}`);
  }
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

async function resolveUsbBusDevice(vendorId: string, productId: string, bus?: string, device?: string) {
  if (bus && device) return { bus, device };
  const { stdout } = await execFileAsync("lsusb", [], { maxBuffer: 1024 * 1024 });
  const matches = stdout.split("\n").map((line) => {
    const match = line.match(/^Bus\s+(\d{3})\s+Device\s+(\d{3}):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s*/i);
    if (!match) return null;
    return { bus: match[1], device: match[2], vendorId: match[3].toLowerCase(), productId: match[4].toLowerCase() };
  }).filter((entry): entry is { bus: string; device: string; vendorId: string; productId: string } => !!entry)
    .filter((entry) => entry.vendorId === vendorId && entry.productId === productId);
  if (matches.length === 0) throw new Error(`USB device ${vendorId}:${productId} not found on host`);
  if (matches.length > 1) throw new Error(`Multiple USB devices match ${vendorId}:${productId}; provide bus and device`);
  return { bus: matches[0].bus, device: matches[0].device };
}

function stableUsbHostPath(vendorId: string, productId: string) {
  return path.join(STABLE_USB_DIR, `${vendorId}-${productId}`);
}

async function ensureStableUsbLink(vendorId: string, productId: string, bus?: string, device?: string) {
  const resolved = await resolveUsbBusDevice(vendorId, productId, bus, device);
  const currentHostPath = `/dev/bus/usb/${resolved.bus}/${resolved.device}`;
  await fs.access(currentHostPath);
  await fs.mkdir(STABLE_USB_DIR, { recursive: true });
  const stablePath = stableUsbHostPath(vendorId, productId);
  await fs.rm(stablePath, { force: true });
  await fs.symlink(currentHostPath, stablePath);
  return { ...resolved, currentHostPath, stablePath };
}

function parseLxcUsbDevices(cfg: string) {
  return [...cfg.matchAll(/^#\s*auxinux\.usb\s+([0-9a-f]{4}):([0-9a-f]{4})(?:\s+bus=(\d{3})\s+device=(\d{3}))?(?:\s+persistent=(true|false))?/gim)].map((match) => {
    const [, vendorId, productId, bus, device, persistentRaw] = match;
    const persistent = persistentRaw !== "false";
    if (persistent) ensureStableUsbLink(vendorId, productId).catch(() => {});
    return {
      type: "usb" as const,
      id: `${vendorId}:${productId}${bus && device ? `:${bus}:${device}` : ""}`,
      vendorId,
      productId,
      label: `${vendorId}:${productId}`,
      bus,
      device,
      devPath: persistent ? "/dev/bus/usb" : `/dev/bus/usb/${bus}/${device}`,
      persistent,
    };
  });
}

function normalizeGpuId(value: unknown): "dri" | "nvidia" {
  if (value === "dri" || value === "nvidia") return value;
  throw new Error("Invalid GPU device id");
}

function parseLxcGpuDevices(cfg: string) {
  return [...cfg.matchAll(/^#\s*auxinux\.gpu\s+(dri|nvidia)\b/gim)].map((match) => {
    const id = match[1].toLowerCase() as "dri" | "nvidia";
    return {
      type: "gpu" as const,
      id,
      label: id === "dri" ? "DRI render GPU (/dev/dri)" : "NVIDIA GPU (/dev/nvidia*)",
      devPaths: id === "dri" ? ["/dev/dri"] : ["/dev/nvidia*"],
    };
  });
}

function normalizeTemplateSpec(distRaw: unknown, releaseRaw: unknown, archRaw?: unknown, variantRaw?: unknown): LxcTemplateSpec {
  if (typeof distRaw !== "string" || typeof releaseRaw !== "string") {
    throw new Error("LXC dist and release are required");
  }

  let dist = distRaw.trim().toLowerCase();
  let release = releaseRaw.trim().toLowerCase();
  const arch = (typeof archRaw === "string" && archRaw.trim() ? archRaw.trim().toLowerCase() : "amd64");
  const variant = (typeof variantRaw === "string" && variantRaw.trim() ? variantRaw.trim().toLowerCase() : "default");

  const distAliases: Record<string, string> = {
    rocky: "rockylinux",
    "rocky-linux": "rockylinux",
  };
  dist = distAliases[dist] ?? dist;

  const ubuntuReleaseAliases: Record<string, string> = {
    "18.04": "bionic",
    "20.04": "focal",
    "22.04": "jammy",
    "24.04": "noble",
    "26.04": "resolute",
  };
  if (dist === "ubuntu") {
    release = ubuntuReleaseAliases[release] ?? release;
  }

  validateSafePart(dist, "distribution");
  validateSafePart(release, "release");
  validateSafePart(arch, "architecture");
  validateSafePart(variant, "variant");
  return { dist, release, arch, variant };
}

function templateKey(spec: LxcTemplateSpec) {
  return `${spec.dist}/${spec.release}/${spec.arch}/${spec.variant}`;
}

function buildImageUrl(entry: LxcImageIndexEntry, filename: string) {
  if (!entry.path.startsWith("/images/") || entry.path.includes("..")) {
    throw new Error(`Invalid LXC image path in remote index: ${entry.path}`);
  }
  return `${LXC_IMAGE_SERVER}${entry.path}${filename}`;
}

async function fetchTextWithFallback(url: string, timeoutMs = 20_000): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "AuxiNux-LXC/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  try {
    const { stdout } = await execFileAsync("curl", ["-fsSL", "--retry", "2", "--connect-timeout", "15", url], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs + 10_000,
    });
    return stdout;
  } catch (curlError) {
    throw new Error(`Failed to download ${url}: ${errorMessage(curlError)}; fetch fallback: ${errorMessage(lastError)}`);
  }
}

async function downloadFileWithFallback(url: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  let lastError: unknown;

  try {
    const response = await fetch(url, {
      headers: { "user-agent": "AuxiNux-LXC/1.0" },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Remote response had no body");
    }

    const file = await fs.open(temporary, "w");
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await file.write(value);
      }
    } finally {
      await file.close();
    }
    await fs.rename(temporary, destination);
    return;
  } catch (error) {
    lastError = error;
    await fs.rm(temporary, { force: true }).catch(() => {});
  }

  try {
    await execFileAsync("curl", ["-fL", "--retry", "3", "--connect-timeout", "15", "-o", temporary, url], {
      maxBuffer: 1024 * 1024,
      timeout: 15 * 60_000,
    });
    await fs.rename(temporary, destination);
  } catch (curlError) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Failed to download ${url}: ${errorMessage(curlError)}; fetch fallback: ${errorMessage(lastError)}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await fs.open(filePath, "r");
  try {
    for await (const chunk of file.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

function parseSha256Sums(content: string) {
  const sums = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) {
      sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
    }
  }
  return sums;
}

async function ensureChecksum(filePath: string, expected?: string) {
  if (!expected) {
    throw new Error(`Missing SHA256 checksum for ${path.basename(filePath)}`);
  }
  const actual = await sha256File(filePath);
  if (actual !== expected.toLowerCase()) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
  }
}

async function fileMatchesChecksum(filePath: string, expected?: string) {
  if (!expected) return false;
  try {
    return (await sha256File(filePath)) === expected.toLowerCase();
  } catch {
    return false;
  }
}

function parseLxcImageIndex(content: string): LxcImageIndexEntry[] {
  const entries: LxcImageIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [dist, release, arch, variant, build, imagePath] = trimmed.split(";");
    if (!dist || !release || !arch || !variant || !build || !imagePath) continue;
    if (!imagePath.startsWith("/images/") || imagePath.includes("..")) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(build)) continue;
    entries.push({
      dist,
      release,
      arch,
      variant,
      build,
      path: imagePath.endsWith("/") ? imagePath : `${imagePath}/`,
    });
  }
  return entries;
}

async function fetchLxcImageIndex() {
  const indexText = await fetchTextWithFallback(`${LXC_IMAGE_SERVER}/meta/1.0/index-system`);
  const entries = parseLxcImageIndex(indexText);
  if (entries.length === 0) {
    throw new Error("LXC image index is empty or malformed");
  }
  return entries;
}

async function resolveLxcImageEntry(spec: LxcTemplateSpec): Promise<LxcImageIndexEntry> {
  const entries = await fetchLxcImageIndex();
  const match = entries.find((entry) =>
    entry.dist === spec.dist &&
    entry.release === spec.release &&
    entry.arch === spec.arch &&
    entry.variant === spec.variant
  );
  if (match) return match;

  const alternatives = entries
    .filter((entry) => entry.dist === spec.dist && entry.arch === spec.arch)
    .slice(0, 12)
    .map((entry) => `${entry.release}:${entry.variant}`)
    .join(", ");
  throw new Error(`LXC template ${spec.dist}:${spec.release}:${spec.arch}:${spec.variant} was not found${alternatives ? `. Available for ${spec.dist}/${spec.arch}: ${alternatives}` : ""}`);
}

function cacheDirForEntry(entry: LxcImageIndexEntry) {
  return path.join(LXC_DOWNLOAD_CACHE_DIR, entry.dist, entry.release, entry.arch, entry.variant, entry.build);
}

async function readCachedTemplateEntry(spec: LxcTemplateSpec): Promise<CachedLxcTemplate | null> {
  const variantDir = path.join(LXC_DOWNLOAD_CACHE_DIR, spec.dist, spec.release, spec.arch, spec.variant);
  const directMetaPath = path.join(variantDir, "meta.tar.xz");
  const directRootfsPath = path.join(variantDir, "rootfs.tar.xz");
  try {
    await Promise.all([fs.access(directMetaPath), fs.access(directRootfsPath)]);
    return {
      entry: { ...spec, build: "cached", path: "" },
      cacheDir: variantDir,
      metaPath: directMetaPath,
      rootfsPath: directRootfsPath,
    };
  } catch {}

  const builds = await fs.readdir(variantDir).catch(() => []);
  const sortedBuilds = builds.filter((build) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(build)).sort().reverse();
  for (const build of sortedBuilds) {
    const cacheDir = path.join(variantDir, build);
    const metaPath = path.join(cacheDir, "meta.tar.xz");
    const rootfsPath = path.join(cacheDir, "rootfs.tar.xz");
    const markerPath = path.join(cacheDir, "index.json");
    try {
      await Promise.all([fs.access(metaPath), fs.access(rootfsPath)]);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8").catch(() => "{}")) as Partial<LxcImageIndexEntry>;
      return {
        entry: {
          dist: spec.dist,
          release: spec.release,
          arch: spec.arch,
          variant: spec.variant,
          build,
          path: typeof marker.path === "string" ? marker.path : "",
        },
        cacheDir,
        metaPath,
        rootfsPath,
      };
    } catch {}
  }
  return null;
}

async function ensureCachedLxcTemplate(spec: LxcTemplateSpec): Promise<CachedLxcTemplate> {
  let entry: LxcImageIndexEntry;
  try {
    entry = await resolveLxcImageEntry(spec);
  } catch (error) {
    const cached = await readCachedTemplateEntry(spec);
    if (cached) return cached;
    throw error;
  }

  const cacheDir = cacheDirForEntry(entry);
  const metaPath = path.join(cacheDir, "meta.tar.xz");
  const rootfsPath = path.join(cacheDir, "rootfs.tar.xz");
  const sumsPath = path.join(cacheDir, "SHA256SUMS");
  await fs.mkdir(cacheDir, { recursive: true });

  const sumsText = await fetchTextWithFallback(buildImageUrl(entry, "SHA256SUMS"));
  const sums = parseSha256Sums(sumsText);
  await fs.writeFile(sumsPath, sumsText);

  const downloads: Array<{ filename: string; filePath: string }> = [
    { filename: "meta.tar.xz", filePath: metaPath },
    { filename: "rootfs.tar.xz", filePath: rootfsPath },
  ];
  for (const download of downloads) {
    const expected = sums.get(download.filename);
    if (!(await fileMatchesChecksum(download.filePath, expected))) {
      await downloadFileWithFallback(buildImageUrl(entry, download.filename), download.filePath);
      await ensureChecksum(download.filePath, expected);
    }
  }

  await fs.writeFile(path.join(cacheDir, "index.json"), JSON.stringify(entry, null, 2));
  await fs.unlink(TEMPLATE_CACHE_FILE).catch(() => {});
  return { entry, cacheDir, metaPath, rootfsPath };
}

async function metaConfigIncludesExist(content: string) {
  const includes = [...content.matchAll(/^lxc\.include\s*=\s*(.+)$/gim)].map((match) => match[1].trim());
  if (includes.length === 0) return true;
  for (const include of includes) {
    if (include.startsWith("/") && !(await fs.stat(include).then(() => true).catch(() => false))) {
      return false;
    }
  }
  return true;
}

async function readBestMetaConfig(metaDir: string) {
  const candidates = ["config.4", "config.3", "config.2", "config.1", "config"];
  let fallback = "";
  for (const candidate of candidates) {
    const candidatePath = path.join(metaDir, candidate);
    const raw = await fs.readFile(candidatePath, "utf8").catch(() => "");
    if (!raw.trim()) continue;
    const normalized = raw.replace(/LXC_TEMPLATE_CONFIG/g, LXC_TEMPLATE_CONFIG_DIR).trim();
    fallback ||= normalized;
    if (await metaConfigIncludesExist(normalized)) {
      return normalized;
    }
  }
  return fallback || `lxc.include = ${path.join(LXC_TEMPLATE_CONFIG_DIR, "common.conf")}`;
}

/**
 * Resolve the container's rootfs path from its config (`lxc.rootfs.path`),
 * falling back to the legacy `/var/lib/lxc/<name>/rootfs` location. This is the
 * single source of truth so a container whose rootfs was relocated onto a
 * dedicated storage pool is still found by every host-side write (hostname,
 * DNS, network, OS detection, apt sources).
 */
async function containerRootfsPath(name: string): Promise<string> {
  try {
    const cfg = await readConfig(name);
    const raw = getCfgValue(cfg, "lxc.rootfs.path");
    if (raw) {
      // Only a `dir:` rootfs is a plain host path we can write to directly.
      // Other backings (zfs:, btrfs:, lvm:, overlayfs:…) are mounted by LXC at
      // the legacy /var/lib/lxc/<name>/rootfs mountpoint, so we must fall back
      // to that path rather than treat the backing spec as a filesystem path.
      if (raw.startsWith("dir:")) {
        const cleaned = raw.slice("dir:".length).trim();
        if (cleaned) return cleaned;
      }
    }
  } catch {
    /* fall through to legacy path */
  }
  return path.join(LXC_DIR, name, "rootfs");
}

/**
 * SÉCURITÉ — écritures host-root dans un rootfs de conteneur.
 * Le contenu du rootfs est contrôlé par le root du conteneur : il peut
 * remplacer `etc` (ou un fichier cible) par un symlink vers un chemin de
 * l'hôte. `fs.writeFile`/`fs.readFile` suivent les symlinks, ce qui
 * transformerait ces écritures (rename, restore, MAJ DNS/réseau) en
 * écrasement de fichiers arbitraires de l'hôte. On refuse donc tout composant
 * symlink et on ouvre les fichiers finaux avec O_EXCL / O_NOFOLLOW.
 */
async function resolveRootfsDir(name: string, relDir: string): Promise<string> {
  let current = await containerRootfsPath(name);
  await fs.mkdir(current, { recursive: true });
  for (const segment of relDir.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) {
      await fs.mkdir(current);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refus d'écrire dans ${current} : symlink ou non-répertoire dans le rootfs du conteneur`);
    }
  }
  return current;
}

async function writeRootfsFile(dir: string, fileName: string, content: string, mode = 0o644) {
  const filePath = path.join(dir, fileName);
  // Retire un éventuel symlink existant (ex: stub systemd-resolved) ; O_EXCL
  // refuse ensuite d'ouvrir à travers un lien recréé entre-temps.
  await fs.rm(filePath, { force: true }).catch(() => {});
  const handle = await fs.open(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function readRootfsFile(dir: string, fileName: string): Promise<string | null> {
  try {
    const handle = await fs.open(path.join(dir, fileName), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function writeContainerHostname(name: string, hostname = name) {
  const rootfsEtc = await resolveRootfsDir(name, "etc");
  await writeRootfsFile(rootfsEtc, "hostname", `${hostname}\n`);

  const fallbackHosts = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";
  let hosts = (await readRootfsFile(rootfsEtc, "hosts")) ?? fallbackHosts;
  if (/^127\.0\.1\.1\s+/m.test(hosts)) {
    hosts = hosts.replace(/^127\.0\.1\.1\s+.*$/m, `127.0.1.1\t${hostname}`);
  } else {
    hosts = `${hosts.trimEnd()}\n127.0.1.1\t${hostname}\n`;
  }
  await writeRootfsFile(rootfsEtc, "hosts", hosts);
}

async function createContainerFromDownloadedTemplate(name: string, spec: LxcTemplateSpec) {
  const containerDir = path.join(LXC_DIR, name);
  const rootfsDir = path.join(containerDir, "rootfs");
  const cached = await ensureCachedLxcTemplate(spec);
  const metaDir = await fs.mkdtemp(path.join(os.tmpdir(), "auxinux-lxc-meta-"));

  await fs.rm(containerDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(rootfsDir, { recursive: true });

  try {
    await execFileAsync("tar", ["-xJf", cached.metaPath, "-C", metaDir], { maxBuffer: 5 * 1024 * 1024 });
    await execFileAsync("tar", ["--numeric-owner", "-xJf", cached.rootfsPath, "-C", rootfsDir], { maxBuffer: 5 * 1024 * 1024 });

    let config = await readBestMetaConfig(metaDir);
    config = config
      .replace(/^lxc\.rootfs\.path\s*=.*$/gim, "")
      .replace(/^lxc\.uts\.name\s*=.*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    await fs.writeFile(
      path.join(containerDir, "config"),
      `${config}\nlxc.rootfs.path = dir:${rootfsDir}\nlxc.uts.name = ${name}\n`,
    );
    await writeContainerHostname(name, name);
  } catch (error) {
    await fs.rm(containerDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(metaDir, { recursive: true, force: true }).catch(() => {});
  }
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

async function ensureLxcNetDefaults() {
  const configPath = "/etc/default/lxc-net";
  const defaults = new Map<string, string>([
    ["USE_LXC_BRIDGE", '"true"'],
    ["LXC_BRIDGE", '"lxcbr0"'],
    ["LXC_ADDR", '"10.0.3.1"'],
    ["LXC_NETMASK", '"255.255.255.0"'],
    ["LXC_NETWORK", '"10.0.3.0/24"'],
    ["LXC_DHCP_RANGE", '"10.0.3.2,10.0.3.254"'],
    ["LXC_DHCP_MAX", '"253"'],
  ]);

  let content = await fs.readFile(configPath, "utf8").catch(() => "");
  for (const [key, value] of defaults.entries()) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `${content.endsWith("\n") || !content ? "" : "\n"}${key}=${value}\n`;
    }
  }
  await fs.writeFile(configPath, content);
}

async function ensureLxcBridgeReady() {
  if (await interfaceExists("lxcbr0")) {
    return;
  }

  await ensureLxcNetDefaults();
  try {
    await execFileAsync("systemctl", ["enable", "lxc-net.service"]).catch(() => {});
    await execFileAsync("systemctl", ["restart", "lxc-net.service"]);
  } catch {
    await execFileAsync("systemctl", ["start", "lxc-net.service"]).catch(() => {});
  }

  if (await waitForInterface("lxcbr0")) {
    return;
  }

  throw new Error("Bridge lxcbr0 is unavailable. Ensure lxc-net is installed and running.");
}

async function ensureVirbrBridgeReady() {
  if (await interfaceExists("virbr0")) {
    return;
  }

  await execFileAsync("virsh", ["net-autostart", "default"]).catch(() => {});
  await execFileAsync("virsh", ["net-start", "default"]).catch(() => {});

  if (await waitForInterface("virbr0")) {
    return;
  }

  throw new Error("Bridge virbr0 is unavailable. Ensure the libvirt default network is active.");
}

async function ensureHostBridgeReady(bridge: string) {
  const normalized = bridge.trim();
  if (!normalized) {
    throw new Error("A bridge name is required for LXC networking");
  }

  if (normalized === "lxcbr0") {
    await ensureLxcBridgeReady();
    return;
  }
  if (normalized === "virbr0") {
    await ensureVirbrBridgeReady();
    return;
  }
  if (!(await interfaceExists(normalized))) {
    throw new Error(`Bridge ${normalized} does not exist on the host`);
  }
}

/** Generates a random locally-administered unicast MAC address (02:xx:xx:xx:xx:xx style). */
function generateRandomMac(): string {
  // Use a cryptographically secure RNG (not Math.random) so MAC addresses are
  // unpredictable — important on shared L2 segments and to avoid collisions.
  const bytes = Array.from(randomBytes(6));
  // Set locally administered (bit 1) and clear multicast (bit 0) on the first byte
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

// ── OVH / off-link gateway helpers ───────────────────────────────────────────
// OVH "IP failover" addresses are routed to the host as /32 and the gateway
// (the block's .254, or the host's own bridge IP in routed mode) is OUTSIDE the
// guest's subnet. Standard "iface inet static + gateway" then fails with
// "Network is unreachable" because the kernel can't reach the gateway. The fix
// is an on-link / point-to-point route: first pin a host route to the gateway
// via the device, then add the default route through it.

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function prefixToMask(prefix: number): string {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join(".");
}

/**
 * Returns true when `gateway` is reachable on-link given `ipCidr` (e.g.
 * "203.0.113.5/32"). When false, the caller must add an explicit on-link route
 * to the gateway before the default route (OVH failover / routed mode).
 */
function gatewayIsOnLink(ipCidr: string | undefined, gateway: string | undefined): boolean {
  if (!ipCidr || !gateway || gateway === "auto" || gateway === "dev") return true;
  const [ipStr, prefixStr] = ipCidr.split("/");
  const prefix = Number(prefixStr ?? "32");
  const ipInt = ipv4ToInt(ipStr);
  const gwInt = ipv4ToInt(gateway);
  if (ipInt === null || gwInt === null || !Number.isInteger(prefix)) return true;
  if (prefix >= 31) return false; // /31 and /32 can never contain a distinct gateway
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & maskInt) === (gwInt & maskInt);
}

function normalizeIpv4Cidr(value: string | undefined, defaultPrefix = 32): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "dhcp") return undefined;
  if (/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/.test(trimmed)) {
    return `${trimmed}/${defaultPrefix}`;
  }
  return trimmed;
}

function replaceIfupdownEth0Config(existing: string, block: string) {
  const withoutManaged = existing.replace(
    /^\s*# AuxiNux Virtua eth0 start\s*$[\s\S]*?^\s*# AuxiNux Virtua eth0 end\s*$/gim,
    "",
  );
  const withoutEth0 = withoutManaged
    .replace(/^\s*(?:auto|allow-hotplug)\s+eth0\s*\n/gi, "")
    .replace(/^\s*iface\s+eth0\s+inet\s+\S+\s*\n(?:^[ \t].*\n?)*/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const managedBlock = ["# AuxiNux Virtua eth0 start", block.trim(), "# AuxiNux Virtua eth0 end"].join("\n");
  return `${withoutEth0 ? `${withoutEth0}\n\n` : ""}${managedBlock}\n`;
}

/** Tries to read the runtime MAC that LXC actually assigned to the container interface. */
async function runtimeMac(name: string): Promise<string | null> {
  try {
    const out = await lxcCmd("lxc-attach", "-n", name, "--", "cat", "/sys/class/net/eth0/address");
    const mac = out.trim().toLowerCase();
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseField(text: string, field: string): string | null {
  const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : null;
}

/**
 * Returns the best IPv4 address from `lxc-info` output.
 * lxc-info can print multiple `IP:` lines (IPv4 + IPv6).
 * We always prefer a dotted-decimal IPv4 and skip fe80:: link-local addresses.
 */
function parseContainerIP(infoText: string): string | null {
  const all = [...infoText.matchAll(/^IP:\s*(.+)$/gim)].map((m) => m[1].trim());
  return (
    all.find((ip) => /^\d{1,3}(\.\d{1,3}){3}/.test(ip)) ??
    all.find((ip) => !ip.startsWith("fe80")) ??
    null
  );
}

function normalizeState(state: string): "running" | "stopped" | "frozen" | "unknown" {
  const s = state.toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("stopped")) return "stopped";
  if (s.includes("frozen")) return "frozen";
  return "unknown";
}

async function readConfig(name: string): Promise<string> {
  return fs.readFile(path.join(LXC_DIR, name, "config"), "utf8");
}

async function hasUsableContainer(name: string) {
  try {
    await lxcCmd("lxc-info", "-n", name);
    return true;
  } catch {
    return false;
  }
}

function stripInvalidDhcpAutoLines(cfg: string) {
  return cfg
    .replace(/^lxc\.net\.0\.ipv4\.address\s*=\s*auto\s*$/gim, "")
    .replace(/^lxc\.net\.0\.ipv4\.gateway\s*=\s*auto\s*$/gim, "")
    .replace(/^lxc\.network\.dns\.nameserver\s*=.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function findDirectoryContaining(root: string, needle: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === needle) {
      return fullPath;
    }
    const nested = await findDirectoryContaining(fullPath, needle);
    if (nested) return nested;
  }
  return null;
}

async function findFileRecursive(root: string, matcher: (fullPath: string) => boolean): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(fullPath, matcher);
      if (nested) return nested;
      continue;
    }
    if (matcher(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sanitizeInvalidDhcpConfig(name: string) {
  const cfgPath = path.join(LXC_DIR, name, "config");
  try {
    const cfg = await fs.readFile(cfgPath, "utf8");
    const sanitized = stripInvalidDhcpAutoLines(cfg);
    if (sanitized !== cfg.trim()) {
      await fs.writeFile(cfgPath, `${sanitized}\n`);
      return true;
    }
  } catch {}
  return false;
}

async function cleanupContainerArtifacts(name: string) {
  try { await lxcCmd("lxc-stop", "-n", name, "-k"); } catch {}
  try { await lxcCmd("lxc-destroy", "-n", name); } catch {}
  // If the rootfs was relocated onto a storage pool, lxc-destroy normally removes
  // it (it reads lxc.rootfs.path), but a failed destroy leaves it behind. Read the
  // config first and remove the relocated rootfs explicitly so no orphan data
  // stays on the pool. Only paths OUTSIDE /var/lib/lxc are treated as relocated.
  try {
    const cfg = await readConfig(name);
    const raw = getCfgValue(cfg, "lxc.rootfs.path");
    // Only a `dir:` rootfs is a real host path we relocated; other backings
    // (zfs:, btrfs:, …) are managed by LXC itself and must not be rm'd here.
    const rootfs = raw?.startsWith("dir:") ? raw.slice("dir:".length).trim() : undefined;
    if (rootfs && !rootfs.startsWith(`${LXC_DIR}${path.sep}`)) {
      await fs.rm(rootfs, { recursive: true, force: true }).catch(() => {});
      // Also remove the now-empty pool container dir (e.g. <pool>/<name>).
      await fs.rm(path.dirname(rootfs), { recursive: true, force: true }).catch(() => {});
    }
  } catch {}
  await fs.rm(path.join(LXC_DIR, name), { recursive: true, force: true }).catch(() => {});
}

function getCfgValue(cfg: string, key: string): string | null {
  const matches = [...cfg.matchAll(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=\\s*(.+)$`, "img"))];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

async function getHostDnsServers() {
  try {
    const resolvConf = await fs.readFile("/etc/resolv.conf", "utf8");
    const servers = resolvConf
      .split("\n")
      .map((line) => line.match(/^\s*nameserver\s+(\S+)\s*$/)?.[1] ?? null)
      .filter((value): value is string => !!value)
      .filter((value) => !value.startsWith("127.") && value !== "::1");
    return [...new Set(servers)];
  } catch {
    return [];
  }
}

async function readContainerDns(name: string) {
  const resolvPath = path.join(await containerRootfsPath(name), "etc", "resolv.conf");
  try {
    const resolvConf = await fs.readFile(resolvPath, "utf8");
    return resolvConf
      .split("\n")
      .map((line) => line.match(/^\s*nameserver\s+(\S+)\s*$/)?.[1] ?? null)
      .filter((value): value is string => !!value);
  } catch {
    return [];
  }
}

async function writeContainerDns(name: string, dnsServers?: string[]) {
  // N'accepte que des adresses IP littérales : évite l'injection de directives
  // arbitraires dans resolv.conf via une entrée contenant espace/nouvelle ligne.
  const requested = (dnsServers ?? []).map((server) => String(server).trim()).filter((server) => net.isIP(server) !== 0);
  const effectiveDns = (requested.length > 0 ? requested : await getHostDnsServers()).filter((server) => net.isIP(server) !== 0);
  if (effectiveDns.length === 0) return;

  const rootfsEtc = await resolveRootfsDir(name, "etc");
  const content = `${effectiveDns.map((server) => `nameserver ${server}`).join("\n")}\n`;
  // writeRootfsFile retire un éventuel symlink (ex: stub systemd-resolved) avant d'écrire.
  await writeRootfsFile(rootfsEtc, "resolv.conf", content);
}

/**
 * Writes network configuration files directly into the container rootfs so that
 * every major init system (systemd-networkd, NetworkManager, ifupdown) will
 * automatically configure eth0 via DHCP (or static) on first boot — regardless
 * of whether the distro is Fedora, Debian, Ubuntu, Alpine, etc.
 */
// Stable UUID shared by every eth0 profile we write (keyfile + ifcfg).
// Same UUID → NM sees ONE connection, not two competing auto-connect profiles.
const ETH0_CONN_UUID = "00000000-0000-4000-a000-000000000001";

/** Maps a Debian release (version or codename) to its apt suite codename. */
function debianSuite(release: string): string | null {
  const r = release.trim().toLowerCase();
  const byVersion: Record<string, string> = { "11": "bullseye", "12": "bookworm", "13": "trixie", "14": "forky" };
  if (byVersion[r]) return byVersion[r];
  if (["bullseye", "bookworm", "trixie", "forky", "sid"].includes(r)) return r;
  return null;
}

/**
 * Replaces the container's apt sources with the AuxiNux DEB mirror and adds the
 * VIRTUA KERNEL repo. Debian only — the DEB mirror is a full Debian archive
 * (dists/<suite>, pool/). The kernel repo is treated as a flat, trusted repo
 * ("deb [trusted=yes] URL ./"), suitable for an unsigned single-component repo.
 */
async function overwriteAptSources(name: string, dist: string, release: string, debRepoUrl?: string, kernelRepoUrl?: string): Promise<void> {
  if (dist.trim().toLowerCase() !== "debian") return; // only Debian is supported for now
  const suite = debianSuite(release);
  if (!debRepoUrl || !suite) return;
  const aptDir = await resolveRootfsDir(name, "etc/apt");
  const aptSourcesDir = await resolveRootfsDir(name, "etc/apt/sources.list.d");

  const base = debRepoUrl.replace(/\/*$/, "/");
  const components = "main contrib non-free non-free-firmware";
  const sources = [
    "# Managed by AuxiNux Virtua",
    `deb ${base} ${suite} ${components}`,
    `deb ${base} ${suite}-updates ${components}`,
    "",
  ].join("\n");
  await writeRootfsFile(aptDir, "sources.list", sources);

  // Debian 12+ may also ship a deb822 file that would shadow sources.list — clear it.
  await writeRootfsFile(aptSourcesDir, "debian.sources", "").catch(() => {});

  if (kernelRepoUrl) {
    // Flat, unsigned repo: "deb [trusted=yes] <url> ./" (no trailing slash on URL).
    const kbase = kernelRepoUrl.replace(/\/+$/, "");
    await writeRootfsFile(
      aptSourcesDir,
      "virtua-kernel.list",
      `# Managed by AuxiNux Virtua\ndeb [trusted=yes] ${kbase} ./\n`,
    ).catch(() => {});
  }
}

async function configureContainerNetwork(name: string, ipv4?: string, gateway?: string) {
  // Écritures best-effort (comme avant), mais via les helpers anti-symlink :
  // si un répertoire du rootfs est un symlink, on n'écrit simplement pas.
  const tryWriteRootfs = async (relDir: string, fileName: string, content: string, mode?: number) => {
    try {
      const dir = await resolveRootfsDir(name, relDir);
      await writeRootfsFile(dir, fileName, content, mode);
    } catch { /* best-effort */ }
  };
  const normalizedIpv4 = normalizeIpv4Cidr(ipv4);
  const isDhcp = !normalizedIpv4;
  // When the gateway is outside the guest's subnet (OVH "IP failover" uses /32
  // addresses whose gateway is the block's .254 or the host bridge IP), it is
  // NOT reachable on-link. We then emit explicit on-link / point-to-point routes
  // for each init system instead of a plain default gateway.
  const onLink = gatewayIsOnLink(normalizedIpv4, gateway);

  // ── 1. NetworkManager global conf.d ───────────────────────────────────────
  // CRITICAL: "[main] managed=true" is NOT a valid NM key — NM silently ignores
  // it. The correct keys are:
  //   plugins=keyfile,ifcfg-rh  → read both profile formats (Fedora ≤35 uses
  //                               ifcfg-rh; Fedora ≥36 / Debian use keyfile)
  //   no-auto-default=           → empty means ALL interfaces get auto-default
  //                               DHCP, overriding any "no-auto-default=eth0"
  //                               in the template's NetworkManager.conf
  //   [connectivity] enabled=0  → disable portal-check to avoid NM stalling
  await tryWriteRootfs(
    "etc/NetworkManager/conf.d",
    "auxinux.conf",
    "[main]\nplugins=keyfile,ifcfg-rh\nno-auto-default=\n\n[connectivity]\nenabled=0\n",
  );

  // ── 2. NetworkManager keyfile (Fedora ≥36, Debian/Ubuntu with NM) ─────────
  // [ipv6] method=disabled: avoids 30-second RA-timeout stall before IPv4 is
  // considered "done", which was causing the container to stay IPv6-only.
  const nmContent = isDhcp
    ? [
        "[connection]", `id=eth0`, `uuid=${ETH0_CONN_UUID}`,
        "type=ethernet", "interface-name=eth0", "autoconnect=true",
        "", "[ethernet]",
        "", "[ipv4]", "method=auto",
        "", "[ipv6]", "method=disabled",
      ].join("\n") + "\n"
    : [
        "[connection]", `id=eth0`, `uuid=${ETH0_CONN_UUID}`,
        "type=ethernet", "interface-name=eth0", "autoconnect=true",
        "", "[ethernet]",
        "", "[ipv4]", "method=manual",
        // On-link gateway → inline gateway. Off-link (OVH failover) → omit the
        // inline gateway and add an explicit on-link default route instead.
        gateway && onLink ? `address1=${normalizedIpv4},${gateway}` : `address1=${normalizedIpv4}`,
        ...(gateway && !onLink ? [`route1=0.0.0.0/0,${gateway}`, "route1_options=onlink=true"] : []),
        "", "[ipv6]", "method=disabled",
      ].join("\n") + "\n";
  await tryWriteRootfs("etc/NetworkManager/system-connections", "eth0.nmconnection", nmContent, 0o600);

  // ── 3. ifcfg (Fedora ≤35, RHEL 8, CentOS — same UUID → NM deduplicates) ──
  // Without the shared UUID, NM would load BOTH this ifcfg AND the keyfile
  // above as two separate auto-connect profiles → race condition → DHCP fails.
  const ifcfgLines = isDhcp
    ? [
        "DEVICE=eth0", "TYPE=Ethernet", `UUID=${ETH0_CONN_UUID}`,
        "BOOTPROTO=dhcp", "ONBOOT=yes", "NM_CONTROLLED=yes", "IPV6INIT=no",
      ]
    : [
        "DEVICE=eth0", "TYPE=Ethernet", `UUID=${ETH0_CONN_UUID}`,
        "BOOTPROTO=none", "ONBOOT=yes", "NM_CONTROLLED=yes",
        `IPADDR=${normalizedIpv4?.split("/")[0] ?? ""}`,
        `PREFIX=${normalizedIpv4?.split("/")[1] ?? "24"}`,
        gateway && onLink ? `GATEWAY=${gateway}` : null,
        "IPV6INIT=no",
      ].filter(Boolean) as string[];
  try {
    const ifcfgDir = await resolveRootfsDir(name, "etc/sysconfig/network-scripts");
    await writeRootfsFile(ifcfgDir, "ifcfg-eth0", ifcfgLines.join("\n") + "\n");
    if (!isDhcp && gateway && !onLink) {
      await writeRootfsFile(ifcfgDir, "route-eth0", `${gateway}/32 dev eth0\ndefault via ${gateway} dev eth0\n`);
    } else {
      await fs.rm(path.join(ifcfgDir, "route-eth0"), { force: true }).catch(() => {});
    }
  } catch { /* best-effort */ }

  // ── 4. ifupdown (Debian/Ubuntu without NM, Alpine) ────────────────────────
  // For OVH "IP failover" the address is a /32 and the gateway is OUTSIDE the
  // guest subnet. A plain "gateway X" then fails ("Network is unreachable"), so
  // when the gateway is off-link we add a point-to-point route to the gateway
  // first, then the default route through it.
  let block: string;
  if (isDhcp) {
    block = "auto eth0\niface eth0 inet dhcp\n";
  } else {
    const addr = normalizedIpv4?.split("/")[0] ?? "";
    const prefix = normalizedIpv4?.split("/")[1] ?? "24";
    const netmask = prefixToMask(Number(prefix) || 24);
    const lines = [
      "auto eth0", "iface eth0 inet static",
      `    address ${addr}`,
      `    netmask ${netmask}`,
    ];
    if (gateway) {
      if (onLink) {
        lines.push(`    gateway ${gateway}`);
      } else {
        // off-link gateway (OVH failover): point-to-point route then default
        lines.push(`    post-up ip route add ${gateway} dev eth0`);
        lines.push(`    post-up ip route add default via ${gateway} dev eth0`);
        lines.push(`    pre-down ip route del default via ${gateway} dev eth0`);
        lines.push(`    pre-down ip route del ${gateway} dev eth0`);
      }
    }
    block = lines.join("\n") + "\n";
  }
  try {
    const netIfacesDir = await resolveRootfsDir(name, "etc/network");
    const existingIfaces = (await readRootfsFile(netIfacesDir, "interfaces")) ?? "";
    await writeRootfsFile(netIfacesDir, "interfaces", replaceIfupdownEth0Config(existingIfaces, block));
  } catch { /* best-effort */ }

  // ── 5. systemd-networkd (Ubuntu Server / Debian without NM) ──────────────
  // DHCP=ipv4 (not "yes") + IPv6AcceptRA=no → only request IPv4.
  // NM always takes priority over networkd for interfaces it has a profile for,
  // so this file is a no-op on Fedora/NM containers.
  let networkdContent: string;
  if (isDhcp) {
    networkdContent = "[Match]\nName=eth0\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\n";
  } else {
    const lines = ["[Match]", "Name=eth0", "", "[Network]", `Address=${normalizedIpv4}`];
    if (gateway) {
      if (onLink) {
        lines.push(`Gateway=${gateway}`);
      } else {
        // off-link gateway (OVH failover): on-link route to gw, then default via gw
        lines.push("", "[Route]", `Destination=${gateway}/32`, "Scope=link");
        lines.push("", "[Route]", `Gateway=${gateway}`, "GatewayOnLink=yes");
      }
    }
    networkdContent = lines.join("\n") + "\n";
  }
  await tryWriteRootfs("etc/systemd/network", "10-eth0.network", networkdContent);

  // ── 6. netplan (Ubuntu 20.04+ Server) ─────────────────────────────────────
  let netplanContent: string;
  if (isDhcp) {
    netplanContent = "network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n      dhcp6: false\n";
  } else {
    let routes = "";
    if (gateway) {
      if (onLink) {
        routes = `      routes:\n        - to: default\n          via: ${gateway}\n`;
      } else {
        // off-link gateway (OVH failover): on-link route to gw, then default on-link
        routes =
          `      routes:\n` +
          `        - to: ${gateway}/32\n          scope: link\n` +
          `        - to: default\n          via: ${gateway}\n          on-link: true\n`;
      }
    }
    netplanContent = `network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: false\n      addresses:\n        - ${normalizedIpv4}\n${routes}`;
  }
  await tryWriteRootfs("etc/netplan", "10-eth0.yaml", netplanContent);

  // ── 7. Boot-time fallback for DHCP inside systemd-based containers ───────
  try {
    const systemdDir = await resolveRootfsDir(name, "etc/systemd/system");
    const servicePath = path.join(systemdDir, "auxinux-eth0-bootstrap.service");

    if (isDhcp) {
      const binDir = await resolveRootfsDir(name, "usr/local/sbin");
      const wantsDir = await resolveRootfsDir(name, "etc/systemd/system/multi-user.target.wants");
      const wantsLink = path.join(wantsDir, "auxinux-eth0-bootstrap.service");
      await writeRootfsFile(binDir, "auxinux-eth0-bootstrap.sh", `#!/bin/sh
set -eu
[ -e /sys/class/net/eth0 ] || exit 0
ip link set eth0 up || true
if ip -4 -o addr show dev eth0 scope global | grep -q . 2>/dev/null; then
  exit 0
fi
if command -v nmcli >/dev/null 2>&1; then
  nmcli connection up eth0 >/dev/null 2>&1 || nmcli dev connect eth0 >/dev/null 2>&1 || true
fi
if ip -4 -o addr show dev eth0 scope global | grep -q . 2>/dev/null; then
  exit 0
fi
if command -v networkctl >/dev/null 2>&1; then
  networkctl reload >/dev/null 2>&1 || true
  networkctl renew eth0 >/dev/null 2>&1 || true
fi
if ip -4 -o addr show dev eth0 scope global | grep -q . 2>/dev/null; then
  exit 0
fi
if command -v dhclient >/dev/null 2>&1; then
  dhclient -4 -1 eth0 >/dev/null 2>&1 || true
fi
if ip -4 -o addr show dev eth0 scope global | grep -q . 2>/dev/null; then
  exit 0
fi
if command -v udhcpc >/dev/null 2>&1; then
  udhcpc -i eth0 -q -n >/dev/null 2>&1 || true
fi
exit 0
`, 0o755);
      await writeRootfsFile(systemdDir, "auxinux-eth0-bootstrap.service", `[Unit]
Description=AuxiNux LXC eth0 DHCP bootstrap
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/auxinux-eth0-bootstrap.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`);
      await fs.rm(wantsLink, { force: true }).catch(() => {});
      await fs.symlink("../auxinux-eth0-bootstrap.service", wantsLink).catch(() => {});
    } else {
      const wantsDir = await resolveRootfsDir(name, "etc/systemd/system/multi-user.target.wants");
      const binDir = await resolveRootfsDir(name, "usr/local/sbin");
      await fs.rm(path.join(wantsDir, "auxinux-eth0-bootstrap.service"), { force: true }).catch(() => {});
      await fs.rm(servicePath, { force: true }).catch(() => {});
      await fs.rm(path.join(binDir, "auxinux-eth0-bootstrap.sh"), { force: true }).catch(() => {});
    }
  } catch { /* best-effort */ }
}

function parseContainerConfig(cfg: string, name?: string) {
  const cpuMax = getCfgValue(cfg, "lxc.cgroup2.cpu.max");
  const cpuQuota = cpuMax?.split(/\s+/)[0];
  const cpus = cpuQuota && cpuQuota !== "max" ? Math.max(1, Math.round(parseInt(cpuQuota, 10) / 100000)) : 1;

  const memMax = getCfgValue(cfg, "lxc.cgroup2.memory.max");
  const memoryMiB = memMax && memMax !== "max" ? parseInt(memMax.replace(/[^\d]/g, ""), 10) || 512 : 512;

  const diskOpt = getCfgValue(cfg, "lxc.rootfs.options") ?? "";
  const diskGb = parseInt(diskOpt.match(/size=(\d+)G/i)?.[1] ?? "8", 10);

  const ipv4 = getCfgValue(cfg, "lxc.net.0.ipv4.address");
  const ipAddress = ipv4 && ipv4 !== "auto" ? ipv4 : undefined;
  const gateway = getCfgValue(cfg, "lxc.net.0.ipv4.gateway");
  const bridge = getCfgValue(cfg, "lxc.net.0.link") ?? "lxcbr0";
  const macAddress = getCfgValue(cfg, "lxc.net.0.hwaddr") ?? undefined;
  const autostart = getCfgValue(cfg, "lxc.start.auto") === "1";
  const usbDevices = parseLxcUsbDevices(cfg);
  const gpuDevices = parseLxcGpuDevices(cfg);
  const arch = getCfgValue(cfg, "lxc.arch") ?? "amd64";

  return {
    cpus,
    memoryMiB,
    memoryMb: memoryMiB,
    diskGb,
    rootfsSizeGb: diskGb,
    arch,
    ipAddress,
    gateway: gateway && gateway !== "auto" ? gateway : undefined,
    bridge,
    macAddress,
    usbDevices,
    gpuDevices,
    autostart,
  };
}

// ── Multi-NIC management (lxc.net.0, lxc.net.1, …) ──────────────────────────
interface LxcNic {
  index: number;
  type: string;       // veth, macvlan, …
  link: string;       // host bridge
  flags: string;      // up
  hwaddr?: string;    // MAC
  ipv4?: string;      // CIDR or undefined (DHCP)
  ipv4Gateway?: string;
  name?: string;      // in-guest interface name (eth0, eth1, …)
}

/** Parse every lxc.net.N.* block from a container config into ordered NICs. */
function parseLxcNics(cfg: string): LxcNic[] {
  const indices = new Set<number>();
  for (const m of cfg.matchAll(/^\s*lxc\.net\.(\d+)\./gim)) indices.add(parseInt(m[1], 10));
  const nics: LxcNic[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const get = (k: string) => getCfgValue(cfg, `lxc.net.${i}.${k}`);
    const ipv4 = get("ipv4.address");
    const gw = get("ipv4.gateway");
    nics.push({
      index: i,
      type: get("type") ?? "veth",
      link: get("link") ?? "lxcbr0",
      flags: get("flags") ?? "up",
      hwaddr: get("hwaddr") ?? undefined,
      ipv4: ipv4 && ipv4 !== "auto" ? ipv4 : undefined,
      ipv4Gateway: gw && gw !== "auto" ? gw : undefined,
      name: get("name") ?? undefined,
    });
  }
  return nics;
}

function renderLxcNic(i: number, nic: LxcNic): string {
  const lines = [
    `lxc.net.${i}.type = ${nic.type || "veth"}`,
    `lxc.net.${i}.link = ${nic.link}`,
    `lxc.net.${i}.flags = ${nic.flags || "up"}`,
  ];
  if (nic.name) lines.push(`lxc.net.${i}.name = ${nic.name}`);
  if (nic.hwaddr) lines.push(`lxc.net.${i}.hwaddr = ${nic.hwaddr}`);
  if (nic.ipv4) {
    lines.push(`lxc.net.${i}.ipv4.address = ${nic.ipv4}`);
    // The PRIMARY NIC's gateway is kept verbatim: it is metadata read back by
    // parseContainerConfig() and fed to configureContainerNetwork() to build the
    // guest's default route — including the OFF-LINK OVH failover case, which the
    // guest handles with an on-link route. Stripping it would leave the guest
    // with no default route after a restart.
    //
    // SECONDARY NICs get NO gateway: a second gateway would be an off-link /32
    // route that LXC can't set up at start (silently dropping the whole
    // interface), and would also create a default-route conflict with eth0.
    if (i === 0) {
      lines.push(`lxc.net.${i}.ipv4.gateway = ${nic.ipv4Gateway ?? "auto"}`);
    }
  }
  return lines.join("\n");
}

/** Replace ALL net.* lines with a contiguously re-indexed (0..n-1) set. */
async function writeLxcNics(name: string, nics: LxcNic[]): Promise<void> {
  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = await fs.readFile(cfgPath, "utf8");
  cfg = cfg.replace(/^\s*lxc\.net\.\d+\..*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  const section = nics.map((n, idx) => renderLxcNic(idx, n)).join("\n");
  await fs.writeFile(cfgPath, `${cfg}\n${section}\n`);
}

async function listLxcNics(name: string) {
  const cfg = await readConfig(name);
  return parseLxcNics(cfg).map((n, idx) => ({ ...n, index: idx, primary: idx === 0 }));
}

async function addLxcNic(p: Record<string, unknown>) {
  const name = p.name as string;
  const link = ((p.bridge as string) || "lxcbr0").trim();
  // Secondary NICs are internal LAN interfaces: a bare IP defaults to /24 (a
  // connected subnet) rather than /32, so the guest can actually reach its peers.
  const ipv4 = normalizeIpv4Cidr(p.ipv4 as string | undefined, 24);
  const gateway = (p.ipv4Gateway as string | undefined)?.trim() || undefined;
  const hwaddr = (p.macAddress as string | undefined)?.trim() || generateRandomMac();
  await ensureHostBridgeReady(link);
  const nics = parseLxcNics(await readConfig(name));
  nics.push({ index: nics.length, type: "veth", link, flags: "up", hwaddr, ipv4: ipv4 || undefined, ipv4Gateway: gateway });
  await writeLxcNics(name, nics);
  return { ok: true, index: nics.length - 1 };
}

async function updateLxcNic(p: Record<string, unknown>) {
  const name = p.name as string;
  const index = p.index as number;
  const nics = parseLxcNics(await readConfig(name));
  const nic = nics.find((n) => n.index === index);
  if (!nic) throw new Error(`Network interface #${index} not found`);
  if (p.bridge !== undefined) { nic.link = String(p.bridge).trim() || nic.link; await ensureHostBridgeReady(nic.link); }
  if (p.macAddress !== undefined) nic.hwaddr = String(p.macAddress).trim() || undefined;
  if (p.ipv4 !== undefined) {
    const cidr = normalizeIpv4Cidr(p.ipv4 as string | undefined, 24);
    nic.ipv4 = cidr || undefined;
  }
  if (p.ipv4Gateway !== undefined) nic.ipv4Gateway = String(p.ipv4Gateway).trim() || undefined;
  await writeLxcNics(name, nics);
  return { ok: true };
}

async function deleteLxcNic(name: string, index: number) {
  if (index === 0) throw new Error("The primary network interface (#0) cannot be removed");
  const nics = parseLxcNics(await readConfig(name));
  if (!nics.some((n) => n.index === index)) throw new Error(`Network interface #${index} not found`);
  const remaining = nics.filter((n) => n.index !== index);
  await writeLxcNics(name, remaining); // re-indexes contiguously
  return { ok: true };
}

// Reads the guest OS name from the container's rootfs os-release (best-effort).
async function readContainerOs(name: string): Promise<string | undefined> {
  try {
    const etcDir = await resolveRootfsDir(name, "etc");
    const content = await readRootfsFile(etcDir, "os-release");
    if (!content) return undefined;
    const pretty = content.match(/^PRETTY_NAME\s*=\s*"?(.+?)"?\s*$/im)?.[1];
    const nameMatch = content.match(/^NAME\s*=\s*"?(.+?)"?\s*$/im)?.[1];
    return pretty ?? nameMatch ?? undefined;
  } catch {
    return undefined;
  }
}

async function listContainers() {
  const out = await lxcCmd("lxc-ls", "-1").catch(() => "");
  const names = out.trim().split("\n").filter(Boolean);
  return Promise.all(names.map(async (name) => {
    try {
      const [info, cfg] = await Promise.all([lxcCmd("lxc-info", "-n", name), readConfig(name)]);
      const parsed = parseContainerConfig(cfg);
      const dns = await readContainerDns(name);
      const runtimeIp = parseContainerIP(info);
      const state = normalizeState(parseField(info, "State") ?? "unknown");
      const os = await readContainerOs(name);

      // For running containers, read the live MAC and persist if it differs from config
      let effectiveMac = parsed.macAddress;
      if (state === "running") {
        const liveMac = await runtimeMac(name);
        if (liveMac) {
          effectiveMac = liveMac;
          if (liveMac !== parsed.macAddress) {
            const cfgPath = path.join(LXC_DIR, name, "config");
            let rawCfg = await fs.readFile(cfgPath, "utf8");
            if (/^lxc\.net\.0\.hwaddr\s*=/im.test(rawCfg)) {
              rawCfg = rawCfg.replace(/^lxc\.net\.0\.hwaddr\s*=.*$/im, `lxc.net.0.hwaddr = ${liveMac}`);
            } else {
              rawCfg += `\nlxc.net.0.hwaddr = ${liveMac}\n`;
            }
            await fs.writeFile(cfgPath, rawCfg).catch(() => {});
          }
        }
      }

      return {
        name,
        state,
        ...parsed,
        os,
        ipAddress: runtimeIp ?? parsed.ipAddress,
        macAddress: effectiveMac,
        dns,
      };
    } catch {
      return {
        name,
        state: "unknown",
        cpus: 1,
        memoryMiB: 512,
        diskGb: 8,
        autostart: false,
      };
    }
  }));
}

async function createContainer(p: Record<string, unknown>) {
  const name = p.name as string;
  const template = normalizeTemplateSpec(p.dist, p.release, p.arch, p.variant);
  const { dist, release, arch, variant } = template;
  const password = p.password as string;
  const cpuCores = (p.cpuCores as number) ?? 1;
  const memoryMb = (p.memoryMb as number) ?? 512;
  const diskGb = (p.diskGb as number) ?? 8;
  const bridge = (p.bridge as string) ?? "lxcbr0";
  const overwriteSources = (p.overwriteSources as boolean | undefined) ?? false;
  const debRepoUrl = (p.debRepoUrl as string | undefined)?.trim() || undefined;
  const kernelRepoUrl = (p.kernelRepoUrl as string | undefined)?.trim() || undefined;
  const macAddress = (p.macAddress as string | undefined)?.trim() || undefined;
  const ipv4 = normalizeIpv4Cidr(p.ipv4 as string | undefined);
  const gateway = (p.ipv4Gateway as string | undefined)?.trim() || undefined;
  const dns = (p.dnsServers as string[]) ?? [];
  const autostart = (p.autostart as boolean) ?? false;
  const nesting = (p.nesting as boolean | undefined) ?? false;
  // Optional storage pool path (already resolved by the API from the pool name).
  // When set, the container's rootfs is relocated there so its data lives on the
  // dedicated pool instead of the boot disk. The config stays in /var/lib/lxc.
  const storagePoolPath = (p.storagePool as string | undefined)?.trim() || undefined;
  if (storagePoolPath && !path.isAbsolute(storagePoolPath)) {
    throw new Error("Invalid storagePool: must be an absolute path");
  }
  const containerDir = path.join(LXC_DIR, name);

  await ensureHostBridgeReady(bridge);

  // The lxc-download template shipped in Debian 13's lxc-templates package no
  // longer exposes a --no-validate flag (it never validates GPG signatures in
  // that version, so the flag is gone). Passing it would make getopt fail
  // with "unrecognized option" before any download is attempted.
  // On a ZFS host, back the new container on its own dataset so the disk size is
  // a REAL quota (otherwise the rootfs is a plain dir and the guest sees the whole
  // pool). Falls back to a directory rootfs on non-ZFS hosts. NEW containers only.
  // When an explicit storage pool path is requested, we always use a directory
  // rootfs on that pool (generic, works everywhere) and skip the ZFS dataset.
  const zfsRoot = storagePoolPath ? null : await detectZfsLxcRoot();
  const backingArgs: string[] = [];
  if (zfsRoot) {
    await execFileAsync("zfs", ["create", "-p", zfsRoot]).catch(() => {});
    backingArgs.push("-B", "zfs", "--zfsroot", zfsRoot);
  }
  const createArgs = ["-n", name, ...backingArgs, "-t", "download", "--", "-d", dist, "-r", release, "-a", arch];
  if (variant && variant !== "default") {
    createArgs.push("--variant", variant);
  }

  try {
    await fs.access(containerDir);
    if (await hasUsableContainer(name)) {
      throw new Error(`Container ${name} already exists`);
    }
    await cleanupContainerArtifacts(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof Error && error.message === `Container ${name} already exists`)) {
      throw error;
    }
    if (error instanceof Error && error.message === `Container ${name} already exists`) {
      throw error;
    }
  }

  try {
    await execFileAsync("lxc-create", createArgs, { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 });
  } catch (error) {
    const sanitized = await sanitizeInvalidDhcpConfig(name);
    if (!sanitized || !(await hasUsableContainer(name))) {
      await cleanupContainerArtifacts(name);
      try {
        await createContainerFromDownloadedTemplate(name, template);
      } catch (directError) {
        throw new Error(`LXC template download failed. Native lxc-create: ${errorMessage(error)}. Direct downloader: ${errorMessage(directError)}`);
      }
    }
  }

  // Apply the disk size as a REAL ZFS quota — only if the container was actually
  // created on its own dataset (guarded by existence so a dir fallback is a no-op).
  if (zfsRoot && diskGb > 0) {
    const dataset = `${zfsRoot}/${name}`;
    const exists = await execFileAsync("zfs", ["list", "-H", "-o", "name", dataset]).then(() => true).catch(() => false);
    if (exists) {
      await execFileAsync("zfs", ["set", `quota=${diskGb}G`, dataset]).catch(() => {});
      await execFileAsync("zfs", ["set", `refquota=${diskGb}G`, dataset]).catch(() => {});
    }
  }

  // Relocate the rootfs onto the requested storage pool. lxc-create placed it at
  // /var/lib/lxc/<name>/rootfs; move it to <pool>/<name>/rootfs and point
  // lxc.rootfs.path there so the container's data lives on the dedicated pool
  // instead of the boot disk. The config stays in /var/lib/lxc/<name>/config.
  let relocatedRootfsPath: string | undefined;
  if (storagePoolPath) {
    const legacyRootfs = path.join(containerDir, "rootfs");
    const poolContainerDir = path.join(storagePoolPath, name);
    const poolRootfs = path.join(poolContainerDir, "rootfs");
    await fs.mkdir(poolContainerDir, { recursive: true });
    // Use `mv` (not fs.rename): the pool is typically on a DIFFERENT filesystem
    // than /var/lib/lxc (that's the whole point), and fs.rename fails with EXDEV
    // across devices. `mv` transparently copies+deletes in that case.
    await execFileAsync("mv", [legacyRootfs, poolRootfs]);
    relocatedRootfsPath = poolRootfs;
  }

  const cfgPath = path.join(LXC_DIR, name, "config");
  await sanitizeInvalidDhcpConfig(name);

  // Always persist a MAC so config and runtime stay in sync across restarts.
  const effectiveMac = macAddress || generateRandomMac();

  const netSection = ipv4
    ? `lxc.net.0.ipv4.address = ${ipv4}\nlxc.net.0.ipv4.gateway = ${gateway ?? "auto"}`
    : "";
  const extraConfig = [
    `lxc.cgroup2.cpu.max = ${cpuCores * 100000} 100000`,
    `lxc.cgroup2.memory.max = ${memoryMb}M`,
    `lxc.cgroup2.memory.swap.max = 0`,
    `lxc.net.0.type = veth`,
    `lxc.net.0.link = ${bridge}`,
    `lxc.net.0.flags = up`,
    `lxc.net.0.hwaddr = ${effectiveMac}`,
    netSection,
    `lxc.rootfs.options = size=${diskGb}G`,
    relocatedRootfsPath ? `lxc.rootfs.path = dir:${relocatedRootfsPath}` : "",
    autostart ? "lxc.start.auto = 1" : "",
    // Container nesting (run Docker/LXC inside this container) — opt-in, NEW containers only.
    nesting ? "lxc.apparmor.allow_nesting = 1" : "",
  ].filter(Boolean).join("\n");

  // Remove keys we are about to rewrite — lxc-create copies /etc/lxc/default.conf
  // which often already defines lxc.net.0.{type,link,flags,...}.  Duplicate keys
  // cause LXC to create a second veth interface (eth1) instead of configuring eth0
  // properly, which is why DHCP never gets an IP.
  let existingCfg = stripInvalidDhcpAutoLines(await fs.readFile(cfgPath, "utf8"));
  existingCfg = existingCfg
    .replace(/^lxc\.net\.\d+\.[^\n]*$/gim, "")
    .replace(/^lxc\.cgroup2?\.[^\n]*$/gim, "")
    .replace(/^lxc\.rootfs\.options\s*=.*$/gim, "")
    .replace(/^lxc\.rootfs\.path\s*=.*$/gim, "")
    .replace(/^lxc\.start\.auto\s*=.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  await fs.writeFile(cfgPath, `${existingCfg}\n${extraConfig}\n`);
  await writeContainerHostname(name, name);

  // Écrire les fichiers de config réseau dans le rootfs AVANT le premier démarrage
  // → NetworkManager / systemd-networkd / ifupdown / netplan configurent eth0 automatiquement
  await configureContainerNetwork(name, ipv4, gateway);

  // Optionally repoint apt at the AuxiNux DEB mirror + VIRTUA KERNEL repo (Debian).
  if (overwriteSources) {
    await overwriteAptSources(name, dist, release, debRepoUrl, kernelRepoUrl).catch(() => {});
  }

  let startedForBootstrap = false;
  try {
    await lxcCmd("lxc-start", "-n", name, "-d");
    startedForBootstrap = true;

    // Attendre que le conteneur soit RUNNING
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = (await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim().toUpperCase();
      if (state === "RUNNING") break;
      await sleep(500);
    }

    // Pour le mode DHCP, attendre jusqu'à 20s qu'une IP v4 soit assignée.
    // Si au bout de 5s rien n'est arrivé, déclencher le client DHCP manuellement
    // comme filet de sécurité (dhclient, dhcpcd, ou nmcli selon la distro).
    if (!ipv4) {
      let hasIpv4 = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const info = await lxcCmd("lxc-info", "-n", name).catch(() => "");
        const runtimeIp = parseContainerIP(info);
        if (runtimeIp) {
          hasIpv4 = true;
          break;
        }
        if (attempt === 4) {
          // Tentatives de secours — ignorer les erreurs, la distro peut ne pas avoir ces commandes
          await lxcCmd("lxc-attach", "-n", name, "--", "dhclient", "-4", "-1", "eth0").catch(() => {});
          await lxcCmd("lxc-attach", "-n", name, "--", "dhcpcd", "-4", "eth0").catch(() => {});
          await lxcCmd("lxc-attach", "-n", name, "--", "udhcpc", "-i", "eth0", "-f", "-q").catch(() => {});
          await lxcCmd("lxc-attach", "-n", name, "--", "ip", "link", "set", "eth0", "up").catch(() => {});
          await lxcCmd("lxc-attach", "-n", name, "--", "systemctl", "restart", "NetworkManager").catch(() => {});
          await lxcCmd("lxc-attach", "-n", name, "--", "systemctl", "restart", "systemd-networkd").catch(() => {});
        }
        await sleep(1000);
      }
      // Même sans IPv4 on continue — l'utilisateur peut la réassigner manuellement
      void hasIpv4;
    }

    const encodedPassword = Buffer.from(`root:${password}\n`, "utf8").toString("base64");
    await lxcCmd("lxc-attach", "-n", name, "--", "sh", "-lc", `printf '%s' '${encodedPassword}' | base64 -d | chpasswd`);
    await writeContainerDns(name, dns);

    // Persist the actual runtime MAC in case LXC overrode our value
    const actualMac = await runtimeMac(name);
    if (actualMac && actualMac !== effectiveMac) {
      let cfg = await fs.readFile(cfgPath, "utf8");
      cfg = cfg.replace(/^lxc\.net\.0\.hwaddr\s*=.*$/im, `lxc.net.0.hwaddr = ${actualMac}`);
      await fs.writeFile(cfgPath, cfg);
    }
  } finally {
    if (startedForBootstrap) {
      try {
        await lxcCmd("lxc-stop", "-n", name);
      } catch {}
    }
  }

  // Si autostart demandé, redémarrer le conteneur maintenant qu'il est configuré
  if (autostart) {
    await lxcCmd("lxc-start", "-n", name, "-d").catch(() => {});
  }

  return { ok: true, name };
}

/**
 * Rename an LXC container (must be stopped). Uses `lxc-copy -R` which moves the
 * container (incl. its rootfs / ZFS dataset). Throws coded errors → 400/404/409.
 */
async function renameContainer(name: string, newName: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(newName)) {
    throw Object.assign(new Error("Invalid container name"), { code: "INVALID_NAME" });
  }
  if (name === newName) return { ok: true, name };
  if (!(await hasUsableContainer(name))) throw Object.assign(new Error("Container not found"), { code: "NOT_FOUND" });
  if (await hasUsableContainer(newName)) throw Object.assign(new Error(`A container named '${newName}' already exists`), { code: "EXISTS" });
  const state = normalizeState((await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim());
  if (state === "running" || state === "frozen") {
    throw Object.assign(new Error("Container must be stopped before rename"), { code: "RUNNING" });
  }
  try {
    // lxc-copy -R renames (moves) the container in place.
    await execFileAsync("lxc-copy", ["-n", name, "-N", newName, "-R"], { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 });
  } catch (err) {
    throw Object.assign(new Error(`lxc-copy rename failed: ${errorMessage(err)}`), { code: "RENAME_FAILED" });
  }
  if (!(await hasUsableContainer(newName)) || (await hasUsableContainer(name))) {
    throw Object.assign(new Error("Rename did not take effect cleanly"), { code: "RENAME_FAILED" });
  }
  await writeContainerHostname(newName, newName).catch(() => {});
  return { ok: true, name: newName };
}

async function deleteContainer(name: string) {
  try {
    try {
      await lxcCmd("lxc-stop", "-n", name, "-k");
    } catch {}
    await lxcCmd("lxc-destroy", "-n", name);
  } catch {
    await cleanupContainerArtifacts(name);
  }

  // Force-clean any leftover artifacts (config dir, ZFS dataset, snapshots).
  await cleanupContainerArtifacts(name);

  // CRITICAL: verify the container is really gone before reporting success.
  const stillRegistered = await hasUsableContainer(name);
  const dirStillThere = await fs.access(path.join(LXC_DIR, name)).then(() => true).catch(() => false);
  if (stillRegistered || dirStillThere) {
    throw new Error(`Failed to delete LXC container '${name}': it still exists after lxc-destroy`);
  }

  return { ok: true };
}

async function containerAction(name: string, action: string) {
  if (action === "start" || action === "restart" || action === "reboot") {
    const cfg = await readConfig(name).catch(() => "");
    const parsed = parseContainerConfig(cfg);
    const bridge = parsed.bridge ?? "lxcbr0";
    await ensureHostBridgeReady(bridge);
    await configureContainerNetwork(name, parsed.ipAddress, parsed.gateway);
  }
  switch (action) {
    case "start": await lxcCmd("lxc-start", "-n", name, "-d"); break;
    case "stop": await lxcCmd("lxc-stop", "-n", name); break;
    case "restart":
    case "reboot":
      try { await lxcCmd("lxc-stop", "-n", name); } catch {}
      await lxcCmd("lxc-start", "-n", name, "-d");
      break;
    case "freeze":
    case "pause": await lxcCmd("lxc-freeze", "-n", name); break;
    case "unfreeze":
    case "resume": await lxcCmd("lxc-unfreeze", "-n", name); break;
    default: throw new Error(`Unknown LXC action: ${action}`);
  }
  return { ok: true };
}

async function getContainerInfo(name: string) {
  const [info, cfg] = await Promise.all([lxcCmd("lxc-info", "-n", name), readConfig(name)]);
  const parsed = parseContainerConfig(cfg);
  const dns = await readContainerDns(name);
  const runtimeIp = parseContainerIP(info);
  const state = normalizeState(parseField(info, "State") ?? "unknown");
  const os = await readContainerOs(name);

  // If the container is running, read the actual runtime MAC from inside the container
  // and persist it to config if it differs (keeps UI in sync)
  let effectiveMac = parsed.macAddress;
  if (state === "running") {
    const liveMac = await runtimeMac(name);
    if (liveMac) {
      effectiveMac = liveMac;
      if (liveMac !== parsed.macAddress) {
        const cfgPath = path.join(LXC_DIR, name, "config");
        let rawCfg = await fs.readFile(cfgPath, "utf8");
        if (/^lxc\.net\.0\.hwaddr\s*=/im.test(rawCfg)) {
          rawCfg = rawCfg.replace(/^lxc\.net\.0\.hwaddr\s*=.*$/im, `lxc.net.0.hwaddr = ${liveMac}`);
        } else {
          rawCfg += `\nlxc.net.0.hwaddr = ${liveMac}\n`;
        }
        await fs.writeFile(cfgPath, rawCfg).catch(() => {});
      }
    }
  }

  return {
    name,
    state,
    ...parsed,
    os,
    ipAddress: runtimeIp ?? parsed.ipAddress,
    macAddress: effectiveMac,
    dns,
  };
}

/**
 * If LXC_DIR lives on a ZFS pool, return the dataset under which new containers
 * should be created (e.g. "zp0/lxc"). Returns null on non-ZFS hosts → callers
 * fall back to the classic directory rootfs (no behavior change). This is only
 * ever used for NEW containers; existing dir-backed containers are untouched.
 */
async function detectZfsLxcRoot(): Promise<string | null> {
  try {
    const { stdout: fstype } = await execFileAsync("df", ["--output=fstype", LXC_DIR]);
    if (!/\bzfs\b/i.test(fstype)) return null;
    const { stdout: source } = await execFileAsync("df", ["--output=source", LXC_DIR]);
    const dataset = source.split("\n")[1]?.trim();
    if (!dataset || !dataset.includes("/") && !/^[a-zA-Z0-9._-]+$/.test(dataset)) return null;
    const pool = dataset.split("/")[0];
    if (!pool) return null;
    return `${pool}/lxc`;
  } catch {
    return null;
  }
}

async function readCgroupPath(pid: number): Promise<string | null> {
  try {
    const content = await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
    const line = content.split("\n").find((entry) => entry.startsWith("0::"));
    return line ? line.split("::")[1] : null;
  } catch {
    return null;
  }
}

async function getContainerStats(name: string) {
  try {
    const info = await lxcCmd("lxc-info", "-n", name);
    const state = normalizeState(parseField(info, "State") ?? "unknown");
    const pid = parseInt(parseField(info, "PID") ?? "0", 10);
    if (!pid) {
      return { cpuPercent: 0, memUsedBytes: 0, memTotalBytes: 0, diskRdBytes: 0, diskWrBytes: 0, netRxBytes: 0, netTxBytes: 0 };
    }

    // The init pid's cgroup (v2) is usually the container's `.../init.scope`
    // leaf, which only accounts the init process (~3 MB) and has no memory.max.
    // Walk up to the CONTAINER cgroup (parent of init.scope) which aggregates
    // ALL container processes and carries the limits we set (memory.max/cpu.max).
    const cgPath = await readCgroupPath(pid);
    let containerCg = cgPath;
    if (containerCg && containerCg.endsWith("/init.scope")) {
      containerCg = containerCg.slice(0, -"/init.scope".length);
    }
    const cgBase = containerCg ? path.join("/sys/fs/cgroup", containerCg) : null;

    const readCgRaw = async (file: string): Promise<string | null> => {
      if (!cgBase) return null;
      try {
        return (await fs.readFile(path.join(cgBase, file), "utf8")).trim();
      } catch {
        return null;
      }
    };
    const readCgNumber = async (file: string) => {
      const value = await readCgRaw(file);
      if (value === null || value === "max") return 0;
      return parseInt(value, 10) || 0;
    };

    // ── CPU% : sample cpu.stat usage_usec twice, normalize to allocated cores ──
    const parseUsageUsec = (raw: string | null): number => {
      if (!raw) return 0;
      return parseInt(raw.match(/usage_usec\s+(\d+)/)?.[1] ?? "0", 10) || 0;
    };
    const cpuMaxRaw = await readCgRaw("cpu.max"); // "<quota> <period>" or "max <period>"
    let allowedCores = 1;
    if (cpuMaxRaw) {
      const [quota, period] = cpuMaxRaw.split(/\s+/);
      if (quota && quota !== "max") {
        const q = parseInt(quota, 10);
        const p = parseInt(period ?? "100000", 10) || 100000;
        if (q > 0) allowedCores = Math.max(1, q / p);
      } else {
        allowedCores = os.cpus().length || 1; // unlimited → host cores
      }
    }
    const u1 = parseUsageUsec(await readCgRaw("cpu.stat"));
    const t1 = Date.now();
    await sleep(250);
    const u2 = parseUsageUsec(await readCgRaw("cpu.stat"));
    const t2 = Date.now();
    const wallUsec = Math.max(1, (t2 - t1) * 1000);
    const cpuPercent = u2 > u1
      ? Math.min(100, Math.round(((u2 - u1) / wallUsec) * 100 / allowedCores * 10) / 10)
      : 0;

    const [memoryCurrent, memoryMax] = await Promise.all([
      readCgNumber("memory.current"),
      readCgNumber("memory.max"),
    ]);

    let diskRdBytes = 0;
    let diskWrBytes = 0;
    try {
      const ioContent = await fs.readFile(`/proc/${pid}/io`, "utf8");
      diskRdBytes = parseInt(ioContent.match(/^read_bytes:\s+(\d+)/m)?.[1] ?? "0", 10);
      diskWrBytes = parseInt(ioContent.match(/^write_bytes:\s+(\d+)/m)?.[1] ?? "0", 10);
    } catch {}

    let netRxBytes = 0;
    let netTxBytes = 0;
    try {
      const netContent = await fs.readFile(`/proc/${pid}/net/dev`, "utf8");
      for (const line of netContent.split("\n").slice(2)) {
        const parts = line.trim().split(/\s+/);
        if (!parts[0] || parts[0].startsWith("lo:")) continue;
        netRxBytes += parseInt(parts[1] ?? "0", 10) || 0;
        netTxBytes += parseInt(parts[9] ?? "0", 10) || 0;
      }
    } catch {}

    const uptimeSeconds = state === "running" ? await processUptimeSeconds(pid) : undefined;

    return {
      state,
      cpuPercent,
      memUsedBytes: memoryCurrent,
      memTotalBytes: memoryMax,
      uptimeSeconds,
      diskRdBytes,
      diskWrBytes,
      netRxBytes,
      netTxBytes,
    };
  } catch {
    return { cpuPercent: 0, memUsedBytes: 0, memTotalBytes: 0, diskRdBytes: 0, diskWrBytes: 0, netRxBytes: 0, netTxBytes: 0 };
  }
}

async function getContainerLogs(name: string, tail: number) {
  const logPath = `/var/log/lxc/${name}.log`;
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content.split("\n").slice(-tail).join("\n");
  } catch {
    return "";
  }
}

async function updateContainerConfig(p: Record<string, unknown>) {
  const name = p.name as string;
  if (p.bridge !== undefined) {
    await ensureHostBridgeReady(String(p.bridge));
  }
  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = stripInvalidDhcpAutoLines(await fs.readFile(cfgPath, "utf8"));

  const setOrAdd = (key: string, value: string) => {
    // Use 'g' flag to replace ALL occurrences (lxc-create may add duplicates via default.conf)
    const reAll = new RegExp(`^${key.replace(/\./g, "\\\.")}\\s*=.*$`, "img");
    if (reAll.test(cfg)) {
      reAll.lastIndex = 0;
      cfg = cfg.replace(reAll, `${key} = ${value}`);
    } else {
      cfg += `\n${key} = ${value}`;
    }
  };

  const replaceMany = (key: string, values: string[]) => {
    cfg = cfg.replace(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=.*$`, "img"), "").replace(/\n{3,}/g, "\n\n");
    if (values.length) {
      cfg += `\n${values.map((value) => `${key} = ${value}`).join("\n")}`;
    }
  };

  const removeKey = (key: string) => {
    cfg = cfg.replace(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=.*$`, "img"), "").replace(/\n{3,}/g, "\n\n");
  };

  // Always ensure net type/flags are correct — also deduplicates legacy configs
  // created before the fix where lxc-create duplicated these from default.conf
  setOrAdd("lxc.net.0.type", "veth");
  setOrAdd("lxc.net.0.flags", "up");

  if (p.cpuCores !== undefined) setOrAdd("lxc.cgroup2.cpu.max", `${(p.cpuCores as number) * 100000} 100000`);
  if (p.memoryMb !== undefined) setOrAdd("lxc.cgroup2.memory.max", `${p.memoryMb}M`);
  if (p.diskGb !== undefined) setOrAdd("lxc.rootfs.options", `size=${p.diskGb}G`);
  if (p.bridge !== undefined) setOrAdd("lxc.net.0.link", p.bridge as string);
  if (p.macAddress !== undefined) {
    const macAddress = String(p.macAddress).trim();
    if (!macAddress) removeKey("lxc.net.0.hwaddr");
    else setOrAdd("lxc.net.0.hwaddr", macAddress);
  }
  if (p.ipv4 !== undefined) {
    const ipv4 = normalizeIpv4Cidr(String(p.ipv4));
    if (!ipv4) {
      removeKey("lxc.net.0.ipv4.address");
      removeKey("lxc.net.0.ipv4.gateway");
    } else {
      setOrAdd("lxc.net.0.ipv4.address", ipv4);
    }
  }
  if (p.ipv4Gateway !== undefined) {
    const gateway = String(p.ipv4Gateway).trim();
    if (!gateway) removeKey("lxc.net.0.ipv4.gateway");
    else setOrAdd("lxc.net.0.ipv4.gateway", gateway);
  }
  if (p.autostart !== undefined) setOrAdd("lxc.start.auto", p.autostart ? "1" : "0");

  await fs.writeFile(cfgPath, `${cfg.trim()}\n`);
  if (p.dnsServers !== undefined) {
    await writeContainerDns(name, p.dnsServers as string[]);
  }

  // Si des paramètres réseau ont changé, réécrire les fichiers de config réseau
  // dans le rootfs (pour les conteneurs existants qui n'ont pas ces fichiers)
  if (p.ipv4 !== undefined || p.ipv4Gateway !== undefined || p.bridge !== undefined || p.macAddress !== undefined) {
    const effectiveIpv4 = normalizeIpv4Cidr(getCfgValue(cfg, "lxc.net.0.ipv4.address") ?? undefined);
    const rawGateway = getCfgValue(cfg, "lxc.net.0.ipv4.gateway") ?? undefined;
    const effectiveGateway = rawGateway && rawGateway !== "auto" ? rawGateway : undefined;
    await configureContainerNetwork(name, effectiveIpv4, effectiveGateway);
  }

  return { ok: true };
}

async function existingCharacterDevices(dir: string, pattern: RegExp) {
  const names = await fs.readdir(dir).catch(() => []);
  const devices: string[] = [];
  for (const entry of names.filter((name) => pattern.test(name))) {
    const devPath = path.join(dir, entry);
    const isChar = await fs.stat(devPath).then((stat) => stat.isCharacterDevice()).catch(() => false);
    if (isChar) devices.push(devPath);
  }
  return devices.sort();
}

async function charDeviceMajor(devPath: string) {
  const { stdout } = await execFileAsync("stat", ["-c", "%t", devPath], { timeout: 5000 });
  const major = parseInt(stdout.trim(), 16);
  return Number.isFinite(major) ? major : undefined;
}

async function gpuConfigLines(id: "dri" | "nvidia") {
  if (id === "dri") {
    await fs.access("/dev/dri");
    return [
      "# auxinux.gpu dri",
      "lxc.cgroup2.devices.allow = c 226:* rwm",
      "lxc.mount.entry = /dev/dri dev/dri none bind,optional,create=dir 0 0",
    ];
  }

  const rootDevices = await existingCharacterDevices("/dev", /^nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/);
  const capDevices = await existingCharacterDevices("/dev/nvidia-caps", /^nvidia-cap\d+$/);
  const allDevices = [...rootDevices, ...capDevices];
  if (allDevices.length === 0) {
    throw new Error("No NVIDIA character devices found on host");
  }

  const majors = new Set<number>();
  for (const devPath of allDevices) {
    const major = await charDeviceMajor(devPath).catch(() => undefined);
    if (major !== undefined) majors.add(major);
  }

  const lines = ["# auxinux.gpu nvidia"];
  for (const major of [...majors].sort((a, b) => a - b)) {
    lines.push(`lxc.cgroup2.devices.allow = c ${major}:* rwm`);
  }
  for (const devPath of rootDevices) {
    lines.push(`lxc.mount.entry = ${devPath} ${devPath.replace(/^\//, "")} none bind,optional,create=file 0 0`);
  }
  if (capDevices.length > 0) {
    lines.push("lxc.mount.entry = /dev/nvidia-caps dev/nvidia-caps none bind,optional,create=dir 0 0");
  }
  return lines;
}

async function restartLxcIfRunning(name: string) {
  const state = normalizeState((await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim());
  if (state === "running") {
    await lxcCmd("lxc-stop", "-n", name);
    await lxcCmd("lxc-start", "-n", name, "-d");
  }
}

async function attachGpuDevice(p: Record<string, unknown>) {
  const name = p.name as string;
  validateSafePart(name, "name");
  const id = normalizeGpuId(p.id);
  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = await fs.readFile(cfgPath, "utf8");
  const lines = await gpuConfigLines(id);
  if (!new RegExp(`^#\\s*auxinux\\.gpu\\s+${id}\\b`, "im").test(cfg)) {
    await fs.writeFile(cfgPath, `${cfg.trim()}\n${lines.join("\n")}\n`);
  }
  await restartLxcIfRunning(name);
  return { ok: true, id };
}

async function detachGpuDevice(p: Record<string, unknown>) {
  const name = p.name as string;
  validateSafePart(name, "name");
  const id = normalizeGpuId(p.id);
  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = await fs.readFile(cfgPath, "utf8");
  const before = cfg;
  const markerRe = new RegExp(`^#\\s*auxinux\\.gpu\\s+${id}\\b\\n(?:lxc\\.cgroup2\\.devices\\.allow\\s*=\\s*c\\s+\\d+:\\*\\s+rwm\\n)*(?:lxc\\.mount\\.entry\\s*=.*\\n)*`, "gim");
  cfg = cfg.replace(markerRe, "");
  if (cfg === before) throw new Error(`GPU ${id} is not attached to LXC ${name}`);
  await fs.writeFile(cfgPath, `${cfg.trim()}\n`);
  await restartLxcIfRunning(name);
  return { ok: true };
}

async function attachUsbDevice(p: Record<string, unknown>) {
  const name = p.name as string;
  validateSafePart(name, "name");
  const vendorId = normalizeUsbId(p.vendorId, "vendorId");
  const productId = normalizeUsbId(p.productId, "productId");
  const requestedBus = normalizeUsbAddress(p.bus, "bus");
  const requestedDevice = normalizeUsbAddress(p.device, "device");
  const persistent = p.persistent !== false;
  const { bus, device, currentHostPath, stablePath } = persistent
    ? await ensureStableUsbLink(vendorId, productId, requestedBus, requestedDevice)
    : { ...(await resolveUsbBusDevice(vendorId, productId, requestedBus, requestedDevice)), currentHostPath: "", stablePath: "" };
  const hostPath = persistent ? "/dev/bus/usb" : `/dev/bus/usb/${bus}/${device}`;
  await fs.access(persistent ? currentHostPath : hostPath);

  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = await fs.readFile(cfgPath, "utf8");
  const marker = persistent
    ? `# auxinux.usb ${vendorId}:${productId} persistent=true`
    : `# auxinux.usb ${vendorId}:${productId} bus=${bus} device=${device} persistent=false`;
  if (!cfg.includes(marker)) {
    cfg = cfg.replace(new RegExp(`^#\\s*auxinux\\.usb\\s+${vendorId}:${productId}.*\\n(?:lxc\\.cgroup2\\.devices\\.allow\\s*=\\s*c\\s+189:\\*\\s+rwm\\n)?(?:lxc\\.mount\\.entry\\s*=.*\\n)?`, "gim"), "");
    const entry = [
      marker,
      `lxc.cgroup2.devices.allow = c 189:* rwm`,
      persistent
        ? `lxc.mount.entry = ${hostPath} dev/bus/usb none bind,optional,create=dir 0 0`
        : `lxc.mount.entry = ${hostPath} dev/bus/usb/${bus}/${device} none bind,optional,create=file 0 0`,
    ].join("\n");
    await fs.writeFile(cfgPath, `${cfg.trim()}\n${entry}\n`);
  }

  const state = normalizeState((await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim());
  if (state === "running") {
    await lxcCmd("lxc-stop", "-n", name);
    await lxcCmd("lxc-start", "-n", name, "-d");
  }
  return { ok: true, devPath: hostPath, currentDevPath: `/dev/bus/usb/${bus}/${device}`, stablePath, persistent };
}

async function detachUsbDevice(p: Record<string, unknown>) {
  const name = p.name as string;
  validateSafePart(name, "name");
  const vendorId = normalizeUsbId(p.vendorId, "vendorId");
  const productId = normalizeUsbId(p.productId, "productId");
  const bus = normalizeUsbAddress(p.bus, "bus");
  const device = normalizeUsbAddress(p.device, "device");
  const cfgPath = path.join(LXC_DIR, name, "config");
  let cfg = await fs.readFile(cfgPath, "utf8");
  const before = cfg;
  const busDeviceRe = bus && device ? `\\s+bus=${bus}\\s+device=${device}` : `(?:\\s+bus=\\d{3}\\s+device=\\d{3})?`;
  const markerRe = new RegExp(`^#\\s*auxinux\\.usb\\s+${vendorId}:${productId}${busDeviceRe}(?:\\s+persistent=(?:true|false))?\\n(?:lxc\\.cgroup2\\.devices\\.allow\\s*=\\s*c\\s+189:\\*\\s+rwm\\n)?lxc\\.mount\\.entry\\s*=\\s+\\S+\\s+dev/bus/usb(?:/\\d{3}/\\d{3})?\\s+none\\s+bind,optional,create=(?:file|dir)\\s+0\\s+0\\n?`, "gim");
  cfg = cfg.replace(markerRe, "");
  if (cfg === before) throw new Error(`USB device ${vendorId}:${productId} is not attached to LXC ${name}`);
  if (!new RegExp(`^#\\s*auxinux\\.usb\\s+${vendorId}:${productId}\\b`, "im").test(cfg)) {
    await fs.rm(stableUsbHostPath(vendorId, productId), { force: true }).catch(() => {});
  }
  if (!/^#\s*auxinux\.usb\s+/im.test(cfg)) {
    cfg = cfg.replace(/^lxc\.cgroup2\.devices\.allow\s*=\s*c\s+189:\*\s+rwm\s*$/gim, "");
  }
  await fs.writeFile(cfgPath, `${cfg.trim()}\n`);

  const state = normalizeState((await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim());
  if (state === "running") {
    await lxcCmd("lxc-stop", "-n", name);
    await lxcCmd("lxc-start", "-n", name, "-d");
  }
  return { ok: true };
}

/** Returns the LXC arch names that are compatible with the host CPU architecture. */
function getAllowedLxcArchs(): string[] {
  const nodeArch = os.arch(); // "x64" | "arm64" | "arm" | "ia32" | ...
  if (nodeArch === "arm64" || nodeArch === "arm") {
    return ["arm64", "armhf", "armel", "arm"];
  }
  // Default: x86_64 host → only amd64 / i386
  return ["amd64", "i386"];
}

async function getTemplates(refresh: boolean) {
  const allowedArchs = getAllowedLxcArchs();

  if (!refresh) {
    try {
      const stat = await fs.stat(TEMPLATE_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < TEMPLATE_CACHE_TTL) {
        const all = JSON.parse(await fs.readFile(TEMPLATE_CACHE_FILE, "utf8")) as Array<{ arch: string }>;
        return all.filter((t) => allowedArchs.includes(t.arch));
      }
    } catch {}
  }

  try {
    const cached = new Set(await listCache());
    const templates = (await fetchLxcImageIndex()).map((entry) => ({
      name: `${entry.dist}:${entry.release}:${entry.arch}:${entry.variant}`,
      dist: entry.dist,
      release: entry.release,
      arch: entry.arch,
      variant: entry.variant,
      description: `${entry.dist} ${entry.release} on ${entry.arch} (${entry.variant})`,
      cached: cached.has(templateKey(entry)) || cached.has(`${entry.dist}/${entry.release}`),
    })).sort((a, b) => a.name.localeCompare(b.name));
    // Cache all architectures; filtering happens at read time based on current arch
    await fs.writeFile(TEMPLATE_CACHE_FILE, JSON.stringify(templates));
    return templates.filter((t) => allowedArchs.includes(t.arch));
  } catch (error) {
    const cached = await listCache();
    const cachedTemplates = cached
      .map((key) => {
        const [dist, release, arch, variant] = key.split("/");
        if (!dist || !release || !arch || !variant) return null;
        return {
          name: `${dist}:${release}:${arch}:${variant}`,
          dist,
          release,
          arch,
          variant,
          description: `${dist} ${release} on ${arch} (${variant}) - cached`,
          cached: true,
        };
      })
      .filter((entry): entry is { name: string; dist: string; release: string; arch: string; variant: string; description: string; cached: boolean } => !!entry);

    const fallback = [
      { name: "debian:trixie:amd64:default", dist: "debian", release: "trixie", arch: "amd64", variant: "default", description: `debian trixie on amd64 (default) - catalog unavailable: ${errorMessage(error)}`, cached: false },
      { name: "debian:bookworm:amd64:default", dist: "debian", release: "bookworm", arch: "amd64", variant: "default", description: "debian bookworm on amd64 (default)", cached: false },
      { name: "ubuntu:noble:amd64:default", dist: "ubuntu", release: "noble", arch: "amd64", variant: "default", description: "ubuntu noble on amd64 (default)", cached: false },
      { name: "ubuntu:jammy:amd64:default", dist: "ubuntu", release: "jammy", arch: "amd64", variant: "default", description: "ubuntu jammy on amd64 (default)", cached: false },
      { name: "alpine:3.21:amd64:default", dist: "alpine", release: "3.21", arch: "amd64", variant: "default", description: "alpine 3.21 on amd64 (default)", cached: false },
      { name: "rockylinux:10:amd64:default", dist: "rockylinux", release: "10", arch: "amd64", variant: "default", description: "rockylinux 10 on amd64 (default)", cached: false },
      { name: "debian:trixie:arm64:default", dist: "debian", release: "trixie", arch: "arm64", variant: "default", description: "debian trixie on arm64 (default)", cached: false },
      { name: "ubuntu:noble:arm64:default", dist: "ubuntu", release: "noble", arch: "arm64", variant: "default", description: "ubuntu noble on arm64 (default)", cached: false },
      { name: "alpine:3.21:arm64:default", dist: "alpine", release: "3.21", arch: "arm64", variant: "default", description: "alpine 3.21 on arm64 (default)", cached: false },
      { name: "rockylinux:10:arm64:default", dist: "rockylinux", release: "10", arch: "arm64", variant: "default", description: "rockylinux 10 on arm64 (default)", cached: false },
    ];
    const byName = new Map([...fallback, ...cachedTemplates].map((entry) => [entry.name, entry]));
    return [...byName.values()].filter((t) => allowedArchs.includes(t.arch));
  }
}

async function listCache() {
  const cacheDir = LXC_DOWNLOAD_CACHE_DIR;
  try {
    const entries = new Set<string>();
    const dists = await fs.readdir(cacheDir);
    for (const dist of dists) {
      const releases = await fs.readdir(path.join(cacheDir, dist)).catch(() => []);
      for (const release of releases) {
        const releaseDir = path.join(cacheDir, dist, release);
        const archs = await fs.readdir(releaseDir).catch(() => []);
        for (const arch of archs) {
          const archDir = path.join(releaseDir, arch);
          const variants = await fs.readdir(archDir).catch(() => []);
          for (const variant of variants) {
            const variantDir = path.join(archDir, variant);
            const hasVariantFiles = await Promise.all([
              fs.access(path.join(variantDir, "meta.tar.xz")).then(() => true).catch(() => false),
              fs.access(path.join(variantDir, "rootfs.tar.xz")).then(() => true).catch(() => false),
            ]);
            if (hasVariantFiles.every(Boolean)) {
              entries.add(`${dist}/${release}/${arch}/${variant}`);
            }

            const builds = await fs.readdir(variantDir).catch(() => []);
            for (const build of builds) {
              const buildDir = path.join(variantDir, build);
              const hasFiles = await Promise.all([
                fs.access(path.join(buildDir, "meta.tar.xz")).then(() => true).catch(() => false),
                fs.access(path.join(buildDir, "rootfs.tar.xz")).then(() => true).catch(() => false),
              ]);
              if (hasFiles.every(Boolean)) {
                entries.add(`${dist}/${release}/${arch}/${variant}`);
              }
            }
          }
        }

        const hasLegacyFiles = await Promise.all([
          fs.access(path.join(releaseDir, "meta.tar.xz")).then(() => true).catch(() => false),
          fs.access(path.join(releaseDir, "rootfs.tar.xz")).then(() => true).catch(() => false),
        ]);
        if (hasLegacyFiles.every(Boolean)) {
          entries.add(`${dist}/${release}`);
        }
      }
    }
    return [...entries];
  } catch {
    return [];
  }
}

async function cacheTemplate(p: Record<string, unknown>) {
  const spec = normalizeTemplateSpec(p.dist, p.release, p.arch, p.variant);
  await ensureCachedLxcTemplate(spec);
  return { ok: true, ...spec };
}

async function clearCache() {
  await fs.rm(LXC_DOWNLOAD_CACHE_DIR, { recursive: true, force: true });
  await fs.unlink(TEMPLATE_CACHE_FILE).catch(() => {});
  return { ok: true };
}

async function deleteCacheEntry(dist: string, release: string) {
  if (!dist || !release) throw new Error("dist and release are required");
  // Prevent path traversal: only allow safe distribution/release name characters
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dist) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(release)) {
    throw new Error("Invalid dist or release format");
  }
  const target = path.join(LXC_DOWNLOAD_CACHE_DIR, dist, release);
  // Ensure resolved path stays inside the expected base directory
  const baseDir = LXC_DOWNLOAD_CACHE_DIR;
  if (!target.startsWith(baseDir + "/")) {
    throw new Error("Path traversal detected");
  }
  await fs.rm(target, { recursive: true, force: true });
  const distDir = path.join(LXC_DOWNLOAD_CACHE_DIR, dist);
  const remaining = await fs.readdir(distDir).catch(() => []);
  if (remaining.length === 0) {
    await fs.rm(distDir, { recursive: true, force: true }).catch(() => {});
  }
  await fs.unlink(TEMPLATE_CACHE_FILE).catch(() => {});
  return { ok: true };
}

function validateSnapshotName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error("Invalid snapshot name: use 1-64 alphanumeric, dot, hyphen or underscore characters");
  }
  return value;
}

function normalizeSnapshotCreatedAt(value?: string | null) {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function firstValidSnapshotDate(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = normalizeSnapshotCreatedAt(value);
    if (normalized) return normalized;
  }
  return "";
}

async function getLxcState(name: string) {
  return (await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim().toUpperCase();
}

async function stopForSnapshot(name: string) {
  await lxcCmd("lxc-stop", "-n", name, "-t", "30").catch(async () => {
    await lxcCmd("lxc-stop", "-n", name, "-k");
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await getLxcState(name);
    if (state && state !== "RUNNING") return;
    await sleep(1000);
  }
  throw new Error(`Container ${name} did not stop before snapshot`);
}

function manualSnapshotDir(name: string, snapName: string) {
  return path.join(LXC_MANUAL_SNAPSHOT_DIR, name, snapName);
}

function manualSnapshotMetadataPath(name: string, snapName: string) {
  return path.join(manualSnapshotDir(name, snapName), "metadata.json");
}

function manualSnapshotContainerDir(name: string, snapName: string) {
  return path.join(manualSnapshotDir(name, snapName), "container");
}

async function readManualSnapshotMetadata(name: string, snapName: string): Promise<ManualLxcSnapshotMetadata | null> {
  try {
    const raw = await fs.readFile(manualSnapshotMetadataPath(name, snapName), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManualLxcSnapshotMetadata>;
    if (parsed.format !== "auxinux-lxc-snapshot-v1" || parsed.containerName !== name || parsed.snapshotName !== snapName) {
      return null;
    }
    return parsed as ManualLxcSnapshotMetadata;
  } catch {
    return null;
  }
}

async function hasManualSnapshot(name: string, snapName: string) {
  if (!await readManualSnapshotMetadata(name, snapName)) return false;
  return fs.stat(manualSnapshotContainerDir(name, snapName)).then((stat) => stat.isDirectory()).catch(() => false);
}

async function readSnapshotEntries(name: string) {
  const candidates = [
    path.join(LXC_DIR, name, "snaps"),
    path.join(LXC_SNAPSHOT_DIR, name),
    path.join(LXC_MANUAL_SNAPSHOT_DIR, name),
  ];
  const snapshots = new Map<string, { name: string; createdAt: string; description: string }>();
  for (const snapshotsDir of candidates) {
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith(".tmp-"))
      .map(async (entry) => {
        const fullPath = path.join(snapshotsDir, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        const manual = await readManualSnapshotMetadata(name, entry.name);
        const existing = snapshots.get(entry.name);
        snapshots.set(entry.name, {
          name: entry.name,
          createdAt: firstValidSnapshotDate(existing?.createdAt, manual?.createdAt, stat?.mtime.toISOString()),
          description: existing?.description || manual?.description || "",
        });
      }));
  }
  return [...snapshots.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function createManualSnapshot(name: string, snapName: string, description?: string) {
  const safeSnapName = validateSnapshotName(snapName);
  const sourceDir = path.join(LXC_DIR, name);
  const finalDir = manualSnapshotDir(name, safeSnapName);
  const parentDir = path.dirname(finalDir);
  const tmpDir = path.join(parentDir, `.tmp-${safeSnapName}-${Date.now()}`);

  if (await hasManualSnapshot(name, safeSnapName)) {
    throw new Error(`Snapshot ${safeSnapName} already exists`);
  }

  await fs.mkdir(parentDir, { recursive: true });
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});

  try {
    const copiedContainerDir = path.join(tmpDir, "container");
    await fs.mkdir(tmpDir, { recursive: true });
    await execFileAsync("cp", ["-a", sourceDir, copiedContainerDir]);
    const metadata: ManualLxcSnapshotMetadata = {
      format: "auxinux-lxc-snapshot-v1",
      containerName: name,
      snapshotName: safeSnapName,
      createdAt: new Date().toISOString(),
      description: description?.trim() || undefined,
    };
    await fs.writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await fs.rename(tmpDir, finalDir);
    return { ok: true, fallback: "manual" };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function createSnapshot(name: string, snapName: string, description?: string, freeze = false) {
  const safeSnapName = validateSnapshotName(snapName);
  const wasRunning = (await getLxcState(name)) === "RUNNING";
  // Hot snapshot by default: production containers keep running. We only stop
  // the container when the caller explicitly asks for an app-consistent
  // snapshot (freeze). The crash-consistent copy of a synced rootfs is the
  // same guarantee as a live VM snapshot.
  const stopDuringSnapshot = freeze && wasRunning;

  // Flush dirty pages before copying the live rootfs.
  await execFileAsync("sync").catch(() => {});

  try {
    if (stopDuringSnapshot) {
      await stopForSnapshot(name);
    }

    if (LXC_SNAPSHOT_MODE === "native") {
      let nativeError: unknown;
      try {
        await lxcCmd("lxc-snapshot", "-n", name, "-N", safeSnapName);
        const snapshots = await listSnapshots(name);
        if (snapshots.some((snapshot) => snapshot.name === safeSnapName)) {
          return { ok: true };
        }
        nativeError = new Error(`lxc-snapshot completed but ${safeSnapName} was not listed`);
      } catch (error) {
        nativeError = error;
      }

      const result = await createManualSnapshot(name, safeSnapName, description);
      return { ...result, nativeError: errorMessage(nativeError) };
    }

    return createManualSnapshot(name, safeSnapName, description);
  } finally {
    if (stopDuringSnapshot) {
      await lxcCmd("lxc-start", "-n", name, "-d").catch(() => {});
    }
  }
}

async function listSnapshots(name: string) {
  const out = await lxcCmd("lxc-snapshot", "-n", name, "-L").catch(() => "");
  const snaps = new Map<string, { name: string; createdAt: string; description: string }>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower === "no snapshots" || lower.startsWith("no snapshot")) continue;
    const snapshotName = trimmed.split(/\s+/)[0];
    if (!snapshotName || snapshotName.toLowerCase().includes("snapshot")) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(snapshotName)) continue;
    const rest = trimmed.slice(snapshotName.length).trim();
    const parentheticalValues = [...rest.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
    const createdAt = firstValidSnapshotDate(rest.replace(/\([^)]*\)/g, " "), ...parentheticalValues);
    snaps.set(snapshotName, { name: snapshotName, createdAt, description: "" });
  }
  for (const entry of await readSnapshotEntries(name)) {
    const existing = snaps.get(entry.name);
    snaps.set(entry.name, existing ? { ...existing, createdAt: firstValidSnapshotDate(existing.createdAt, entry.createdAt) } : entry);
  }
  return [...snaps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function rollbackSnapshot(name: string, snapName: string) {
  const safeSnapName = validateSnapshotName(snapName);
  const wasRunning = (await getLxcState(name)) === "RUNNING";
  try {
    if (wasRunning) {
      await stopForSnapshot(name);
    }
    if (await hasManualSnapshot(name, safeSnapName)) {
      const currentDir = path.join(LXC_DIR, name);
      const snapshotContainerDir = manualSnapshotContainerDir(name, safeSnapName);
      const rollbackBackupDir = path.join(LXC_DIR, `.rollback-${name}-${Date.now()}`);
      await fs.rename(currentDir, rollbackBackupDir);
      try {
        await execFileAsync("cp", ["-a", snapshotContainerDir, currentDir]);
        await fs.rm(rollbackBackupDir, { recursive: true, force: true });
      } catch (error) {
        await fs.rm(currentDir, { recursive: true, force: true }).catch(() => {});
        await fs.rename(rollbackBackupDir, currentDir).catch(() => {});
        throw error;
      }
      return { ok: true };
    }
    await lxcCmd("lxc-snapshot", "-n", name, "-r", safeSnapName);
  } finally {
    if (wasRunning) {
      await lxcCmd("lxc-start", "-n", name, "-d").catch(() => {});
    }
  }
  return { ok: true };
}

async function deleteSnapshot(name: string, snapName: string) {
  const safeSnapName = validateSnapshotName(snapName);
  if (await hasManualSnapshot(name, safeSnapName)) {
    await fs.rm(manualSnapshotDir(name, safeSnapName), { recursive: true, force: true });
    return { ok: true };
  }
  const existing = await listSnapshots(name);
  if (!existing.some((snapshot) => snapshot.name === safeSnapName)) {
    return { ok: true };
  }
  await lxcCmd("lxc-snapshot", "-n", name, "-d", safeSnapName).catch(async () => {
    await fs.rm(path.join(LXC_DIR, name, "snaps", safeSnapName), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(LXC_SNAPSHOT_DIR, name, safeSnapName), { recursive: true, force: true }).catch(() => {});
  });
  return { ok: true };
}

async function backupContainer(p: Record<string, unknown>, emit?: ProgressEmitter) {
  const name = p.name as string;
  const storagePool = p.storagePool as string;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // When the caller names the file, match the compressor to its extension so
  // contents and name agree; otherwise pick the best available compressor.
  // Reconcile the extension in case zstd was requested but unavailable (fallback).
  const level = typeof p.compressionLevel === "number" ? (p.compressionLevel as number) : undefined;
  const compressor = p.filename
    ? await resolveCompressorForFilename(p.filename as string, level)
    : await resolveCompressor(level);
  const filename = p.filename
    ? retargetArchiveExt(p.filename as string, compressor.ext)
    : `lxc-${name}-${timestamp}.${compressor.ext}`;
  const destDir = path.join(storagePool, "backups");
  await fs.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);
  const state = (await lxcCmd("lxc-info", "-n", name, "-sH").catch(() => "")).trim().toUpperCase();
  // Hot backup by default: a running production container must keep serving.
  // Opt-in `freeze` gives an application-consistent snapshot at the cost of a
  // brief pause. Without it we take a crash-consistent backup of the live
  // rootfs (the same guarantee you get from a power-loss / VM live backup).
  const wantsFreeze = p.freeze === true;
  const isRunning = state === "RUNNING";
  let frozen = false;

  // Flush dirty pages so the on-disk image is as consistent as possible before
  // we start reading it while the container keeps writing.
  await execFileAsync("sync").catch(() => {});

  const containerDir = path.join(LXC_DIR, name);
  // Uncompressed source size → lets pv report a REAL progress percentage
  // (bytes archived / total), instead of a fictional ticking bar.
  const totalBytes = await directorySizeBytes(containerDir);
  // tar streams the archive to stdout (`-cf -`); it tolerates files that change
  // while a running container is read (otherwise it exits 1 and "fails").
  const tarArgs = [
    "--warning=no-file-changed",
    "--warning=no-file-removed",
    "-cf",
    "-",
    containerDir,
  ];

  try {
    if (wantsFreeze && isRunning) {
      await lxcCmd("lxc-freeze", "-n", name);
      frozen = true;
    }
    await runTarPipeline({ tarArgs, compressor, destPath, totalBytes, emit, tolerateTarExit1: true });
  } catch (err) {
    await fs.unlink(destPath).catch(() => {});
    throw err;
  } finally {
    if (frozen) {
      await lxcCmd("lxc-unfreeze", "-n", name).catch(() => {});
    }
  }

  const stat = await fs.stat(destPath);
  return { ok: true, filename, sizeBytes: stat.size, destPath };
}

/** Sum of file sizes under a directory (best-effort, for backup progress totals). */
async function directorySizeBytes(dir: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", dir]);
    const bytes = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function restoreContainerBackup(p: Record<string, unknown>) {
  const sourcePath = p.sourcePath as string;
  const name = p.name as string;
  const bridge = (p.bridge as string | undefined) ?? "lxcbr0";
  const macAddress = (p.macAddress as string | undefined)?.trim() || undefined;
  const ipv4 = (p.ipv4 as string | undefined)?.trim() || undefined;
  const ipv4Gateway = (p.ipv4Gateway as string | undefined)?.trim() || undefined;
  const dnsServers = ((p.dnsServers as string[] | undefined) ?? []).filter(Boolean);
  const autostart = (p.autostart as boolean | undefined) ?? false;

  await ensureHostBridgeReady(bridge);

  if (await hasUsableContainer(name)) {
    throw new Error(`LXC container ${name} already exists`);
  }

  // Extract under LXC_DIR (same filesystem as the destination) rather than
  // /tmp, so full container rootfs images don't hit a small tmpfs limit.
  const tempDir = await fs.mkdtemp(path.join(LXC_DIR, ".auxinux-lxc-restore-"));
  const destDir = path.join(LXC_DIR, name);
  await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});

  try {
    // Decompress by extension so both legacy .tar.gz and new .tar.zst restore.
    await execFileAsync("tar", ["--use-compress-program", decompressorFor(sourcePath), "-xf", sourcePath, "-C", tempDir]);
    const extractedDir = await findFileRecursive(tempDir, (fullPath) => path.basename(fullPath) === "config")
      .then((configFile) => configFile ? path.dirname(configFile) : null);
    const sourceDir = extractedDir ?? await findDirectoryContaining(tempDir, path.basename(destDir));
    if (!sourceDir) {
      throw new Error("Unable to locate extracted LXC container data");
    }

    await execFileAsync("cp", ["-a", sourceDir, destDir]);
    let cfg = await fs.readFile(path.join(destDir, "config"), "utf8");
    const originalName = path.basename(sourceDir);

    cfg = cfg.replace(new RegExp(`/var/lib/lxc/${escapeRegExp(originalName)}/rootfs`, "g"), `/var/lib/lxc/${name}/rootfs`);
    cfg = cfg.replace(/^lxc\.uts\.name\s*=.*$/gim, `lxc.uts.name = ${name}`);
    await writeContainerHostname(name, name);

    const setOrRemove = (key: string, value?: string) => {
      const regex = new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=.*$`, "gim");
      if (value) {
        cfg = regex.test(cfg) ? cfg.replace(regex, `${key} = ${value}`) : `${cfg.trim()}\n${key} = ${value}\n`;
      } else {
        cfg = cfg.replace(regex, "");
      }
    };

    setOrRemove("lxc.net.0.link", bridge);
    setOrRemove("lxc.net.0.hwaddr", macAddress);
    if (ipv4) {
      setOrRemove("lxc.net.0.ipv4.address", ipv4);
      setOrRemove("lxc.net.0.ipv4.gateway", ipv4Gateway);
    } else {
      setOrRemove("lxc.net.0.ipv4.address");
      setOrRemove("lxc.net.0.ipv4.gateway");
    }
    setOrRemove("lxc.start.auto", autostart ? "1" : "0");
    // Optional resource overrides — only when the restore explicitly modifies
    // them; otherwise the container keeps its original CPU/RAM limits.
    if (p.cpuCores !== undefined) {
      setOrRemove("lxc.cgroup2.cpu.max", `${(p.cpuCores as number) * 100000} 100000`);
    }
    if (p.memoryMb !== undefined) {
      setOrRemove("lxc.cgroup2.memory.max", `${p.memoryMb as number}M`);
    }
    cfg = `${stripInvalidDhcpAutoLines(cfg)}\n`;
    await fs.writeFile(path.join(destDir, "config"), cfg);
    await configureContainerNetwork(name, ipv4, ipv4Gateway);
    await writeContainerDns(name, dnsServers);
    return { ok: true, name };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
