import { z } from "zod";
import { archSupportsFloppy, isFloppyFilename } from "./floppy";
import { CpuModelSchema, NetworkModelSchema, X86_MACHINE_TYPES, isVintageCpu, refineHardware } from "./hardware";

/** Boot devices: "fd" = floppy first (BIOS/SeaBIOS only; OVMF cannot boot a floppy). */
export const VmBootDeviceSchema = z.enum(["hd", "cdrom", "network", "fd"]);
export type VmBootDevice = z.infer<typeof VmBootDeviceSchema>;

const vmNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
const macRegex = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export const CreateVmSchema = z.object({
  name: z.string().regex(vmNameRegex, "VM name must start with a letter and contain only letters, digits, hyphens, underscores"),
  vcpus: z.number().int().min(1).max(256),
  memoryMb: z.number().int().min(128).max(2097152),
  diskGb: z.number().int().min(1).max(65536).optional(),
  existingPath: z.string().optional(),
  diskBus: z.enum(["virtio", "sata", "ide", "scsi"]).default("virtio"),
  storagePool: z.string().optional(),
  os: z.string().min(1),
  isoFile: z.string().optional(),
  /** Floppy image (drive A:) from the library; x86 only. */
  floppyFile: z.string().max(255).refine(isFloppyFilename, { message: "floppyFile must be a .img, .ima, .vfd or .flp image" }).optional(),
  bridge: z.string().default("virbr0"),
  mac: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
  arch: z.enum(["x86_64", "aarch64"]).default("x86_64"),
  machine: z.string().default("q35"),
  /** CPU model (see hardware.ts); `auto` = host-passthrough as before. */
  cpuModel: CpuModelSchema.default("auto"),
  /** Run a period CPU (286 … Pentium 4) at roughly its own speed (TCG + icount). */
  periodSpeed: z.boolean().default(false),
  /** Model of the first NIC. */
  networkModel: NetworkModelSchema.default("virtio"),
  uefi: z.boolean().default(false),
  secureBoot: z.boolean().default(false),
  bootDevice: VmBootDeviceSchema.default("hd"),
  tpmEnabled: z.boolean().default(false),
  qemuAgentEnabled: z.boolean().default(true),
  videoModel: z.enum(["vga", "virtio", "qxl"]).default("vga"),
  autostart: z.boolean().default(false),
  description: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
}).refine((value) => !(value.diskGb !== undefined && value.existingPath), {
  message: "diskGb and existingPath cannot be used together",
}).refine((value) => !value.floppyFile || archSupportsFloppy(value.arch), {
  message: "Floppy drives are only available on x86 VMs (aarch64 machines have no floppy controller)",
  path: ["floppyFile"],
}).refine((value) => value.bootDevice !== "fd" || !!value.floppyFile, {
  message: "bootDevice fd requires a floppy image",
  path: ["bootDevice"],
}).refine((value) => value.bootDevice !== "fd" || (!value.uefi && !value.secureBoot), {
  message: "UEFI firmware cannot boot from a floppy: use BIOS (uefi off) to boot from drive A:",
  path: ["bootDevice"],
}).superRefine((value, ctx) => refineHardware({
  arch: value.arch,
  machine: value.machine,
  cpuModel: value.cpuModel,
  periodSpeed: value.periodSpeed,
  // A diskless VM has no disk bus to check.
  diskBus: value.diskGb !== undefined || value.existingPath ? value.diskBus : undefined,
  networkModel: value.networkModel,
  secureBoot: value.secureBoot,
}, ctx));

export const UpdateVmConfigSchema = z.object({
  vcpus: z.number().int().min(1).max(256).optional(),
  memoryMb: z.number().int().min(128).max(2097152).optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
  autostart: z.boolean().optional(),
  // null remet la VM sur le défaut global du nœud.
  restartOnCrash: z.boolean().nullable().optional(),
  uefi: z.boolean().optional(),
  secureBoot: z.boolean().optional(),
  bootDevice: VmBootDeviceSchema.optional(),
  tpmEnabled: z.boolean().optional(),
  qemuAgentEnabled: z.boolean().optional(),
  videoModel: z.enum(["vga", "virtio", "qxl"]).optional(),
  /**
   * x86 chipset. Changing it re-addresses every PCI device (libvirt rebuilds
   * the topology): applies at the next start, refused while an IDE disk would
   * land on q35 or Secure Boot on i440FX (checked by the runner on the real XML).
   */
  machine: z.enum(X86_MACHINE_TYPES).optional(),
  cpuModel: CpuModelSchema.optional(),
  periodSpeed: z.boolean().optional(),
}).refine((value) => !(value.periodSpeed === true && value.cpuModel !== undefined && !isVintageCpu(value.cpuModel)), {
  message: "Period speed needs a period CPU (286, 386, 486, Pentium … Pentium 4)",
  path: ["periodSpeed"],
});

export const AttachDiskSchema = z.object({
  sizeGb: z.number().int().min(1).max(65536).optional(),
  existingPath: z.string().optional(),
  bus: z.enum(["virtio", "ide", "sata", "scsi"]).default("virtio"),
  format: z.enum(["qcow2", "raw"]).default("qcow2"),
  storagePool: z.string().optional(),
});

export const AttachNetworkSchema = z.object({
  bridge: z.string().min(1),
  model: NetworkModelSchema.default("virtio"),
  mac: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
});

export const UpdateNetworkSchema = z.object({
  bridge: z.string().min(1).optional(),
  model: NetworkModelSchema.optional(),
  mac: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
});

export const UsbDeviceAssignmentSchema = z.object({
  vendorId: z.string().regex(/^[0-9a-f]{4}$/i, "USB vendor ID must be 4 hex digits"),
  productId: z.string().regex(/^[0-9a-f]{4}$/i, "USB product ID must be 4 hex digits"),
  bus: z.string().regex(/^\d{1,3}$/).optional(),
  device: z.string().regex(/^\d{1,3}$/).optional(),
  persistent: z.boolean().default(true),
});

export const CreateSnapshotSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(500).optional(),
  liveSnapshot: z.boolean().default(false),
});

export const BackupVmSchema = z.object({
  storagePool: z.string().min(1),
  format: z.enum(["tar.gz", "qcow2"]),
  compress: z.boolean().default(true),
  // zstd level for the tar.gz (archive) format; 3 is the default: multi-threaded
  // it runs at disk speed, while 9 made large backups CPU-bound.
  compressionLevel: z.number().int().min(1).max(19).default(3),
  notes: z.string().max(500).optional(),
});

export type CreateVmInput = z.infer<typeof CreateVmSchema>;
export type UpdateVmConfigInput = z.infer<typeof UpdateVmConfigSchema>;
export type AttachDiskInput = z.infer<typeof AttachDiskSchema>;
export type AttachNetworkInput = z.infer<typeof AttachNetworkSchema>;
export type UpdateNetworkInput = z.infer<typeof UpdateNetworkSchema>;
export type UsbDeviceAssignmentInput = z.infer<typeof UsbDeviceAssignmentSchema>;
export type CreateSnapshotInput = z.infer<typeof CreateSnapshotSchema>;
export type BackupVmInput = z.infer<typeof BackupVmSchema>;
