import { z } from "zod";

/**
 * Disposable VMs (beta): a *base* is an installed, generalized system kept
 * read-only on the node; a disposable VM is a qcow2 overlay on it, created in
 * seconds and thrown away, reset, kept or converted when it stops.
 *
 * The base manifest is the Virtua Desktop format (`manifest.json` of a base
 * directory / `.vmtmp` archive), so a `.vmtmp` from the AuxiNux depot or a
 * Desktop export imports unchanged. The server adds a few optional hardware
 * fields (uefi, machine, cpuModel, periodSpeed) Desktop ignores.
 */

export const BASE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const vmNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

export const BaseIdSchema = z.string().regex(BASE_ID_RE, "Invalid base id");

export const BASE_OS = ["windows11", "debian13", "other"] as const;

export const BaseManifestSchema = z.object({
  id: BaseIdSchema,
  label: z.string().min(1).max(200),
  /** `windows11`, `debian13`… (free-form in Desktop, kept to a safe token). */
  os: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/),
  architecture: z.enum(["amd64", "arm64"]),
  guestOs: z.string().max(40).default("other"),
  cpu: z.coerce.number().int().min(1).max(256),
  memoryMib: z.coerce.number().int().min(64).max(2097152),
  diskGib: z.coerce.number().int().min(1).max(65536),
  diskBus: z.string().max(20).default("virtio"),
  networkModel: z.string().max(20).default("virtio"),
  gpuModel: z.string().max(20).default("virtio"),
  tpm2: z.boolean().default(false),
  secureBoot: z.boolean().default(false),
  createdAt: z.string().max(64).default(""),
  /** `local` (built on this node) or `depot`. */
  source: z.string().max(20).default(""),
  diskSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  format: z.number().int().min(1).max(1).default(1),
  // Server-side extras (optional; Desktop bases do not carry them).
  uefi: z.boolean().optional(),
  machine: z.enum(["q35", "pc", "virt"]).optional(),
  cpuModel: z.string().max(40).optional(),
  periodSpeed: z.boolean().optional(),
});
export type BaseManifest = z.infer<typeof BaseManifestSchema>;

export interface BaseInfo extends BaseManifest {
  sizeBytes: number;
  /** Disposable VMs currently built on this base. */
  inUse: number;
  /** Names of those VMs. */
  usedBy: string[];
}

export interface DepotBaseEntry {
  name: string;
  url: string;
  sizeBytes?: number;
  architecture: "amd64" | "arm64";
}

export const CreateBaseSchema = z.object({
  /** Stopped VM whose disk becomes the base (flattened copy). */
  vmName: z.string().regex(vmNameRegex, "Invalid VM name"),
  label: z.string().trim().min(1).max(200).optional(),
  os: z.enum(BASE_OS).default("other"),
  /** Delete the source VM once the base exists (it was built only for this). */
  removeSource: z.boolean().default(false),
});
export type CreateBaseInput = z.infer<typeof CreateBaseSchema>;

export const LaunchDisposableSchema = z.object({
  baseId: BaseIdSchema,
  /** VM name; generated (jetable-<os>-N) when omitted. */
  name: z.string().regex(vmNameRegex, "VM name must start with a letter and contain only letters, digits, hyphens, underscores").optional(),
  /** Storage pool (name) receiving the overlay. */
  storagePool: z.string().min(1).max(100),
  bridge: z.string().regex(/^[a-zA-Z0-9_-]{1,15}$/, "Invalid bridge name").default("virbr0"),
  /** No network card at all. */
  noNetwork: z.boolean().default(false),
  /** Strict sandbox: every write is dropped when the VM stops. */
  strict: z.boolean().default(false),
  start: z.boolean().default(true),
});
export type LaunchDisposableInput = z.infer<typeof LaunchDisposableSchema>;

/** What to do with a disposable VM once it stopped. */
export const DisposableActionSchema = z.enum(["discard", "reset", "keep", "convert"]);
export type DisposableAction = z.infer<typeof DisposableActionSchema>;

export function isVmtmpFilename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._ ()+-]{0,200}\.vmtmp$/.test(name) && !name.includes("..");
}

export const ImportDepotBaseSchema = z.object({
  name: z.string().max(220).refine(isVmtmpFilename, { message: "Expected a .vmtmp file name from the depot" }),
});

export function baseOsLabel(os: string): string {
  if (os === "windows11") return "Windows 11";
  if (os === "debian13") return "Debian 13";
  return "Système";
}

export interface BaseDomainHardware {
  arch: "x86_64" | "aarch64";
  machine: string;
  diskBus: "virtio" | "sata" | "ide" | "scsi";
  networkModel: string;
  videoModel: "vga" | "virtio" | "qxl";
  uefi: boolean;
  secureBoot: boolean;
  tpm: boolean;
  cpuModel: string;
  periodSpeed: boolean;
}

/**
 * libvirt hardware of a disposable VM from its base manifest. Desktop values
 * that have no libvirt counterpart here are mapped to the closest one
 * (gpu `std`/`cirrus` → VGA, disk `nvme` → SATA on x86 / virtio on ARM64).
 */
export function baseDomainHardware(manifest: BaseManifest, options: { hasUefiVars?: boolean } = {}): BaseDomainHardware {
  const arm = manifest.architecture === "arm64";
  const secureBoot = !arm && manifest.secureBoot;
  const disk = manifest.diskBus.toLowerCase();
  let diskBus: BaseDomainHardware["diskBus"] = "virtio";
  if (disk === "virtio" || disk === "scsi") diskBus = disk;
  else if (disk === "ide" && !arm) diskBus = secureBoot ? "sata" : "ide"; // Secure Boot = q35 = no IDE
  else if (disk === "sata" || disk === "ahci" || disk === "nvme") diskBus = arm ? "virtio" : "sata";
  const gpu = manifest.gpuModel.toLowerCase();
  const videoModel: BaseDomainHardware["videoModel"] = gpu === "qxl" ? "qxl" : gpu === "virtio" ? "virtio" : "vga";
  const nic = manifest.networkModel;
  const networkModel = ["virtio", "e1000", "rtl8139"].includes(nic) || (!arm && ["ne2k_pci", "pcnet"].includes(nic)) ? nic : "virtio";
  let machine = "q35";
  if (arm) machine = "virt";
  else if (diskBus === "ide" || (manifest.machine === "pc" && !secureBoot)) machine = "pc";
  return {
    arch: arm ? "aarch64" : "x86_64",
    machine,
    diskBus,
    networkModel,
    videoModel,
    // ARM64 always boots UEFI; Secure Boot implies UEFI; a base that carries
    // a UEFI variable store (disk.*.fd) was installed under UEFI.
    uefi: arm || secureBoot || manifest.uefi === true || options.hasUefiVars === true || manifest.guestOs === "windows",
    secureBoot,
    tpm: manifest.tpm2,
    cpuModel: arm ? "auto" : manifest.cpuModel ?? "auto",
    periodSpeed: !arm && manifest.periodSpeed === true,
  };
}
