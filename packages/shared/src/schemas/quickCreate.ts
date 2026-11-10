import { z } from "zod";

/**
 * Quick create: one request gives an unattended Windows 11 or Debian 13 VM
 * (same profiles and account as Virtua Desktop's quickcreate.rs).
 * Account on both systems: virtua / virtua.
 */
export const QUICK_CREATE_USER = "virtua";
export const QUICK_CREATE_PASSWORD = "virtua";

export const QuickCreateOsSchema = z.enum(["windows11", "debian13"]);
export type QuickCreateOs = z.infer<typeof QuickCreateOsSchema>;

export interface QuickCreateProfile {
  os: QuickCreateOs;
  label: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
}

export const QUICK_CREATE_PROFILES: Record<QuickCreateOs, QuickCreateProfile> = {
  windows11: { os: "windows11", label: "Windows 11", vcpus: 4, memoryMb: 4096, diskGb: 80 },
  debian13: { os: "debian13", label: "Debian 13", vcpus: 2, memoryMb: 4096, diskGb: 60 },
};

export const QuickCreateSchema = z.object({
  os: QuickCreateOsSchema,
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/, "VM name must start with a letter and contain only letters, digits, hyphens, underscores").optional(),
  storagePool: z.string().min(1).max(100),
  bridge: z.string().regex(/^[a-zA-Z0-9_-]{1,15}$/, "Invalid bridge name").default("virbr0"),
  /** Build a disposable base: the installed system becomes a base, the builder VM goes away. */
  makeBase: z.boolean().default(false),
});
export type QuickCreateInput = z.infer<typeof QuickCreateSchema>;

/** Never more vCPUs than the host has threads. */
export function effectiveVcpus(wanted: number, hostThreads: number): number {
  return Math.max(1, Math.min(wanted, Math.max(1, hostThreads)));
}

/** `Windows11*.iso` / `Win11*.iso` (AuxiNux depot and Microsoft naming). */
export function isWindows11Iso(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.startsWith("windows11") || lower.startsWith("win11")) && lower.endsWith(".iso");
}

/** Windows setup language from the ISO name. */
export function windowsLanguage(isoName: string): "fr-CA" | "fr-FR" | "en-US" {
  const lower = isoName.toLowerCase().replace(/-/g, "_");
  if (lower.includes("fr_ca") || lower.includes("ca_fr") || lower.includes("frenchcanadian") || lower.includes("french_canadian")) return "fr-CA";
  if (lower.includes("french") || lower.includes("fr_fr")) return "fr-FR";
  return "en-US";
}

/** Hash of `path` in a Debian `SHA256SUMS` file (`<hash>  ./netboot/…`). */
export function sha256For(sums: string, filePath: string): string | undefined {
  const wanted = filePath.replace(/^\.\//, "");
  for (const line of sums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name && hash.length === 64 && /^[0-9a-f]+$/i.test(hash) && name.replace(/^\.\//, "") === wanted) {
      return hash.toLowerCase();
    }
  }
  return undefined;
}

/** Host name / Windows computer name from the VM name (letters, digits, hyphens). */
export function quickCreateHostName(name: string, max: number): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9]/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-");
  const cut = cleaned.slice(0, max).replace(/^-+|-+$/g, "");
  return cut || "virtua";
}

/** Debian architecture name of a QEMU arch. */
export function debianArch(qemuArch: string): "amd64" | "arm64" {
  return qemuArch === "aarch64" ? "arm64" : "amd64";
}

export function debianNetbootUrls(arch: "amd64" | "arm64") {
  const base = `https://deb.debian.org/debian/dists/trixie/main/installer-${arch}/current/images`;
  return {
    sums: `${base}/SHA256SUMS`,
    files: (["linux", "initrd.gz"] as const).map((name) => ({
      name,
      sumsPath: `netboot/debian-installer/${arch}/${name}`,
      url: `${base}/netboot/debian-installer/${arch}/${name}`,
    })),
  };
}
