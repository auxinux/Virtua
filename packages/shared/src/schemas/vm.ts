import { z } from "zod";

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
  bridge: z.string().default("virbr0"),
  mac: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
  arch: z.enum(["x86_64", "aarch64"]).default("x86_64"),
  machine: z.string().default("q35"),
  uefi: z.boolean().default(false),
  secureBoot: z.boolean().default(false),
  bootDevice: z.enum(["hd", "cdrom", "network"]).default("hd"),
  tpmEnabled: z.boolean().default(false),
  qemuAgentEnabled: z.boolean().default(true),
  videoModel: z.enum(["vga", "virtio", "qxl"]).default("vga"),
  autostart: z.boolean().default(false),
  description: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
}).refine((value) => !(value.diskGb !== undefined && value.existingPath), {
  message: "diskGb and existingPath cannot be used together",
});

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
  bootDevice: z.enum(["hd", "cdrom", "network"]).optional(),
  tpmEnabled: z.boolean().optional(),
  qemuAgentEnabled: z.boolean().optional(),
  videoModel: z.enum(["vga", "virtio", "qxl"]).optional(),
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
  model: z.enum(["virtio", "e1000", "rtl8139"]).default("virtio"),
  mac: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
});

export const UpdateNetworkSchema = z.object({
  bridge: z.string().min(1).optional(),
  model: z.enum(["virtio", "e1000", "rtl8139"]).optional(),
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
  // zstd level for the tar.gz (archive) format; 9 is the balanced default.
  compressionLevel: z.number().int().min(1).max(19).default(9),
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
