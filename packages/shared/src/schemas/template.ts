import { z } from "zod";

// ── Public vocabulary ────────────────────────────────────────────────────────
// Templates are described to Desktop/Web in a *portable* architecture vocabulary
// (amd64/arm64). Internally QEMU/libvirt uses x86_64/aarch64. Keep the two worlds
// mapped in exactly one place (archToQemu / qemuToArch) so the rest of the code
// never has to guess.
export const TemplateType = z.enum(["iso", "vm"]);
export type TemplateType = z.infer<typeof TemplateType>;

export const TemplateArch = z.enum(["amd64", "arm64"]);
export type TemplateArch = z.infer<typeof TemplateArch>;

export const TemplateVisibility = z.enum(["public", "restricted"]);
export type TemplateVisibility = z.infer<typeof TemplateVisibility>;

const QEMU_ARCH: Record<TemplateArch, string> = { amd64: "x86_64", arm64: "aarch64" };
const PORTABLE_ARCH: Record<string, TemplateArch> = { x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64" };

/** Portable arch (amd64/arm64) → QEMU/libvirt arch (x86_64/aarch64). */
export function archToQemu(arch: TemplateArch): string {
  return QEMU_ARCH[arch];
}

/** Best-effort QEMU/portable arch string → portable arch. Defaults to amd64. */
export function qemuToArch(value: string | null | undefined): TemplateArch {
  if (!value) return "amd64";
  return PORTABLE_ARCH[value.toLowerCase().trim()] ?? "amd64";
}

// ── Template metadata (the NomTemplate.json sidecar) ──────────────────────────
// The on-disk JSON uses Capitalized keys (Name/Desc/CPU/RAM/DISK/ARCH) to match
// the Virtua Desktop local format. We accept loosely-typed numbers (a few legacy
// tools wrote "2048" as a string) and coerce.
export const TemplateMetaSchema = z.object({
  Name: z.string().min(1).max(200),
  Desc: z.string().max(2000).optional().default(""),
  CPU: z.coerce.number().int().min(1).max(256).optional(),
  RAM: z.coerce.number().int().min(64).max(2097152).optional(),
  DISK: z.string().max(255).optional(),
  ARCH: z.string().max(32).optional(),
});
export type TemplateMeta = z.infer<typeof TemplateMetaSchema>;

/**
 * Parses a `config.virtua` body (the `[CONFIG VM TEMPLATE]` ini-style file
 * shipped inside a VM archive) into normalized, lower-cased fields. Tolerant of
 * comments (`#`/`;`), the section header, blank lines and surrounding spaces.
 */
export interface VirtuaConfig {
  name?: string;
  desc?: string;
  cpu?: number;
  ram?: number;
  disk?: string;
  arch?: string;
}

export function parseVirtuaConfig(raw: string): VirtuaConfig {
  const out: VirtuaConfig = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "name") out.name = value;
    else if (key === "desc") out.desc = value;
    else if (key === "cpu") out.cpu = Number.parseInt(value, 10) || undefined;
    else if (key === "ram") out.ram = Number.parseInt(value, 10) || undefined;
    else if (key === "disk") out.disk = value;
    else if (key === "arch") out.arch = value;
  }
  return out;
}

/**
 * True if a tar member name must be rejected before extraction: absolute paths,
 * home expansion, or any `..` traversal segment. (Symlink/hardlink detection is
 * done separately from the archive listing's type column.)
 */
export function isUnsafeArchivePath(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
  return trimmed.split("/").some((segment) => segment === "..");
}

// ── Admin: edit a stored template ─────────────────────────────────────────────
export const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  visibility: TemplateVisibility.optional(),
  tags: z.array(z.string().max(60)).max(32).optional(),
  arch: TemplateArch.optional(),
  cpu: z.number().int().min(1).max(256).optional(),
  memoryMb: z.number().int().min(64).max(2097152).optional(),
  diskGb: z.number().int().min(1).max(65536).optional(),
}).strict();
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

// ── Unified resource creation (Desktop/Web): VM from template OR from ISO ──────
// This is intentionally separate from CreateVmSchema so existing /api/vms callers
// are never affected. The server maps it onto the low-level VM create payload.
export const CreateResourceSchema = z.object({
  type: z.literal("vm"),
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/, "Invalid VM name"),
  templateId: z.string().min(1).optional(),
  isoId: z.string().min(1).optional(),
  cpu: z.number().int().min(1).max(256).optional(),
  memory: z.number().int().min(64).max(2097152).optional(),
  disk: z.number().int().min(1).max(65536).optional(),
  architecture: TemplateArch.optional(),
  storagePool: z.string().min(1).optional(),
  network: z.string().min(1).optional(),
  gpuModel: z.enum(["vga", "virtio", "qxl"]).optional(),
  networkModel: z.enum(["virtio", "e1000", "rtl8139"]).optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(60)).max(32).optional(),
}).refine((v) => !!v.templateId || !!v.isoId, {
  message: "Either templateId or isoId is required",
});
export type CreateResourceInput = z.infer<typeof CreateResourceSchema>;

// ── Wire shape returned to Desktop Cloud / Web (point 8 of the spec) ──────────
export interface TemplateSummary {
  id: string;
  type: TemplateType;
  name: string;
  description: string;
  architecture: TemplateArch;
  cpu?: number;
  memory?: number;       // MB
  disk?: string;         // disk filename (vm) or undefined (iso)
  diskGb?: number;       // recommended disk size (vm)
  size: number;          // archive/iso size in bytes
  createdAt: string;
  visibility: TemplateVisibility;
  tags: string[];
  filename: string;
  storagePool?: string;
  ownerId?: number;
}
