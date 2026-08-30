import { z } from "zod";

const lxcNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
const macRegex = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export const CreateLxcSchema = z.object({
  name: z.string().regex(lxcNameRegex),
  dist: z.string().min(1),
  release: z.string().min(1),
  arch: z.string().default("amd64"),
  variant: z.string().optional(),
  cpuCores: z.number().int().min(1).max(128),
  memoryMb: z.number().int().min(64).max(524288),
  diskGb: z.number().int().min(1).max(65536),
  bridge: z.string().default("lxcbr0"),
  macAddress: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
  ipv4: z.string().optional(),
  ipv4Gateway: z.string().optional(),
  dnsServers: z.array(z.string()).default([]),
  password: z.string().min(6).max(128),
  autostart: z.boolean().default(false),
  description: z.string().max(500).optional(),
  // Storage pool (by name) that should host the container's rootfs. When set,
  // the API resolves it to a path and the runner points lxc.rootfs.path there
  // instead of the default /var/lib/lxc/<name>/rootfs. Optional for backward
  // compatibility: existing callers that omit it keep the legacy location.
  storagePool: z.string().optional(),
  // Debian only: replace the container's apt sources with the AuxiNux DEB mirror
  // and add the VIRTUA KERNEL repo. The server injects the actual repo URLs.
  overwriteSources: z.boolean().default(false),
});

export const UpdateLxcConfigSchema = z.object({
  cpuCores: z.number().int().min(1).max(128).optional(),
  memoryMb: z.number().int().min(64).max(524288).optional(),
  diskGb: z.number().int().min(1).max(65536).optional(),
  bridge: z.string().optional(),
  macAddress: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
  ipv4: z.string().optional(),
  ipv4Gateway: z.string().optional(),
  dnsServers: z.array(z.string()).optional(),
  autostart: z.boolean().optional(),
  description: z.string().max(500).optional(),
  portForwards: z.array(z.object({
    hostPort: z.number().int().min(1).max(65535),
    containerPort: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]),
  })).optional(),
});

// A single LXC network interface (multi-NIC management).
export const LxcNicSchema = z.object({
  bridge: z.string().min(1).max(64),
  macAddress: z.string().regex(macRegex, "MAC address must use aa:bb:cc:dd:ee:ff format").optional(),
  ipv4: z.string().optional(),          // CIDR or "dhcp"/empty for DHCP
  ipv4Gateway: z.string().optional(),
});
export type LxcNicInput = z.infer<typeof LxcNicSchema>;

export const BackupLxcSchema = z.object({
  storagePool: z.string().min(1).default("local"),
  format: z.enum(["tar.gz", "archive"]).default("tar.gz"),
  compress: z.boolean().default(true),
  // zstd compression level (1 fastest … 19 max ratio); 9 is the balanced default.
  compressionLevel: z.number().int().min(1).max(19).default(9),
});

export const GpuDeviceAssignmentSchema = z.object({
  id: z.enum(["dri", "nvidia"]),
});

export type CreateLxcInput = z.infer<typeof CreateLxcSchema>;
export type UpdateLxcConfigInput = z.infer<typeof UpdateLxcConfigSchema>;
export type BackupLxcInput = z.infer<typeof BackupLxcSchema>;
export type GpuDeviceAssignmentInput = z.infer<typeof GpuDeviceAssignmentSchema>;
