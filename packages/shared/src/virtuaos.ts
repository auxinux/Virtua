/**
 * VirtuaOS channel contract — shared with the `vos` CLI (VirtuaOS repo), which
 * reads and writes the very same /etc/virtuaos/channel file. Keep this module
 * pure (no fs/process): it is imported by the runner, the API and the UI.
 */

export type VirtuaOsChannel = "PROD" | "DEV";

export const VIRTUAOS_CHANNELS: readonly VirtuaOsChannel[] = ["PROD", "DEV"];

/** Host files read by the detection and the channel operations. */
export const VIRTUAOS_FILES = {
  version: "/etc/virtuaos-version",
  release: "/etc/virtuaos-release",
  osRelease: "/etc/os-release",
  channel: "/etc/virtuaos/channel",
  kernelSources: "/etc/apt/sources.list.d/auxinux-kernel.sources",
  keyring: "/usr/share/keyrings/virtua-archive-keyring.asc",
} as const;

/**
 * THE repository table. The client only ever sends PROD|DEV; every URL, suite
 * and package name is resolved here. Never point APT at
 * https://dep.auxinux.ca/VIRTUA/KERNEL-DEV/ — it is a raw folder without index.
 */
export const VIRTUAOS_REPOS = {
  /** release.md + <ver>/upgrade.instruction — read over HTTP, not APT. */
  releases: {
    PROD: "https://dep.auxinux.ca/VIRTUAOS/",
    DEV: "https://dep.auxinux.ca/VIRTUAOS/DEV/",
  },
  kernel: {
    uri: "https://dep.auxinux.ca/VIRTUA",
    suite: { PROD: "kernel", DEV: "kernel-dev" },
    meta: { PROD: "kernel-virtua", DEV: "kernel-virtua-dev" },
  },
  /** Panel packages (auxinux-virtua, virtuaos-cli): no DEV channel. */
  panel: { uri: "https://dep.auxinux.ca/VIRTUA", suite: "virtua" },
} satisfies {
  releases: Record<VirtuaOsChannel, string>;
  kernel: { uri: string; suite: Record<VirtuaOsChannel, string>; meta: Record<VirtuaOsChannel, string> };
  panel: { uri: string; suite: string };
};

export const KERNEL_META_PACKAGES = [VIRTUAOS_REPOS.kernel.meta.PROD, VIRTUAOS_REPOS.kernel.meta.DEV] as const;

export const VIRTUAOS_CHANNEL_KEYS = {
  virtuaos: "VIRTUAOS_CHANNEL",
  kernel: "KERNEL_CHANNEL",
} as const;

export interface VirtuaOsStatus {
  isVirtuaOS: boolean;
  version: string | null;
  virtuaosChannel: VirtuaOsChannel;
  kernelChannel: VirtuaOsChannel;
  runningKernel: string;
  runningKernelChannel: VirtuaOsChannel;
  installedKernelMetas: string[];
  /** Installed -dev kernel packages a switch back to PROD would purge. */
  devKernelPackages: string[];
  mismatch: boolean;
  /** "latest: X.Y.Z" from the release.md of the selected VirtuaOS channel. */
  latestVirtuaOS: string | null;
}

export interface VirtuaOsKernelChannelResult {
  ok: boolean;
  previous: VirtuaOsChannel;
  current: VirtuaOsChannel;
  rebootRequired: boolean;
  log: string;
}

/** Anything other than DEV (case-insensitive) — including nothing — is PROD. */
export function normalizeChannel(value: unknown): VirtuaOsChannel {
  return typeof value === "string" && value.trim().toUpperCase() === "DEV" ? "DEV" : "PROD";
}

/** Strict validation for client input: only PROD or DEV are accepted. */
export function parseChannelInput(value: unknown): VirtuaOsChannel | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return upper === "PROD" || upper === "DEV" ? upper : null;
}

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Parse a KEY=VALUE file (channel file, os-release…). Surrounding quotes are tolerated on read. */
export function parseKeyValueFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(KEY_LINE);
    if (!m) continue;
    values.set(m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return values;
}

export interface ChannelFileState {
  virtuaosChannel: VirtuaOsChannel;
  kernelChannel: VirtuaOsChannel;
}

/** A missing file (null) or a missing key both mean PROD. */
export function readChannelFile(content: string | null): ChannelFileState {
  const values = parseKeyValueFile(content ?? "");
  return {
    virtuaosChannel: normalizeChannel(values.get(VIRTUAOS_CHANNEL_KEYS.virtuaos)),
    kernelChannel: normalizeChannel(values.get(VIRTUAOS_CHANNEL_KEYS.kernel)),
  };
}

/**
 * Set keys in the channel file, keeping every other line (unknown keys,
 * comments) verbatim. Values are written strictly as KEY=VALUE, no quotes.
 */
export function updateChannelFile(content: string | null, updates: Partial<Record<string, VirtuaOsChannel>>): string {
  const pending = new Map(Object.entries(updates).filter((entry): entry is [string, VirtuaOsChannel] => !!entry[1]));
  const lines = (content ?? "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = lines.map((line) => {
    const m = line.match(KEY_LINE);
    if (!m || /^\s*#/.test(line) || !pending.has(m[1])) return line;
    const value = pending.get(m[1])!;
    pending.delete(m[1]);
    return `${m[1]}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

export interface VirtuaOsDetectionInput {
  versionFile: string | null;
  releaseFile: string | null;
  osRelease: string | null;
}

/**
 * Any single signal is enough. /etc/os-release alone is not trusted to say
 * "Debian": a base-files upgrade rewrites it while /etc/virtuaos-version stays.
 */
export function detectVirtuaOs(input: VirtuaOsDetectionInput): { isVirtuaOS: boolean; version: string | null } {
  const osRelease = input.osRelease ? parseKeyValueFile(input.osRelease) : new Map<string, string>();
  const osReleaseSaysVirtuaOs = (osRelease.get("ID") ?? "").toLowerCase() === "virtuaos";
  const isVirtuaOS = input.versionFile !== null || input.releaseFile !== null || osReleaseSaysVirtuaOs;
  if (!isVirtuaOS) return { isVirtuaOS, version: null };

  const fromVersionFile = (() => {
    if (input.versionFile === null) return null;
    const kv = parseKeyValueFile(input.versionFile);
    const keyed = kv.get("VIRTUAOS_VERSION") ?? kv.get("VERSION_ID") ?? kv.get("VERSION");
    if (keyed) return keyed;
    const first = input.versionFile.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    return first || null;
  })();
  const fromReleaseFile = (() => {
    if (input.releaseFile === null) return null;
    const kv = parseKeyValueFile(input.releaseFile);
    return kv.get("VIRTUAOS_VERSION") ?? kv.get("VERSION_ID") ?? kv.get("VERSION") ?? null;
  })();
  const fromOsRelease = osReleaseSaysVirtuaOs ? (osRelease.get("VERSION_ID") ?? osRelease.get("VERSION") ?? null) : null;
  return { isVirtuaOS, version: fromVersionFile ?? fromReleaseFile ?? fromOsRelease };
}

/** uname -r containing "-dev-" is a DEV kernel (e.g. 7.2.9-dev-auxinux-virtua-amd64). */
export function kernelReleaseChannel(release: string): VirtuaOsChannel {
  return release.includes("-dev-") ? "DEV" : "PROD";
}

/** deb822 file for /etc/apt/sources.list.d/auxinux-kernel.sources. */
export function renderKernelSources(channel: VirtuaOsChannel): string {
  return [
    "Types: deb",
    `URIs: ${VIRTUAOS_REPOS.kernel.uri}`,
    `Suites: ${VIRTUAOS_REPOS.kernel.suite[channel]}`,
    "Components: main",
    "Architectures: amd64",
    `Signed-By: ${VIRTUAOS_FILES.keyring}`,
    "",
  ].join("\n");
}

/** The "latest: X.Y.Z" line of a channel's release.md. */
export function parseLatestFromReleaseMd(content: string): string | null {
  const m = content.match(/^\s*[-*]?\s*latest\s*:\s*`?v?([0-9][^\s`]*)`?\s*$/im);
  return m ? m[1] : null;
}

/** Kernel images from /boot that belong to the PROD channel (no "-dev-"). */
export function prodKernelImages(bootEntries: string[]): string[] {
  return bootEntries.filter((name) => /^vmlinuz-.+-auxinux-virtua-amd64$/.test(name) && !name.includes("-dev-"));
}

/** Installed packages to purge when going back to PROD. */
export function devKernelPackages(installed: string[]): string[] {
  return installed.filter((pkg) =>
    pkg === VIRTUAOS_REPOS.kernel.meta.DEV
    || /^linux-image-.+-dev-auxinux-virtua-amd64$/.test(pkg)
    || /^linux-headers-.+-dev-.+$/.test(pkg));
}
