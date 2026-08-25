import { z } from "zod";

const poolNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

export const CreateRaidSchema = z.object({
  name: z.string().regex(poolNameRegex),
  level: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(10)]),
  devices: z.array(z.string().regex(/^\/dev\/[a-z][a-z0-9]+$/)).min(2),
  spareDevices: z.array(z.string().regex(/^\/dev\/[a-z][a-z0-9]+$/)).optional(),
  chunkSizeKb: z.number().int().default(512),
});

export const CreateStoragePoolSchema = z.object({
  name: z.string().regex(poolNameRegex),
  path: z.string().min(1),
  type: z.enum(["directory", "nfs", "cifs", "glusterfs", "s3"]),
  content: z.array(z.enum(["iso", "vm", "backup", "template", "container", "disk"])).min(1),
  mountSource: z.string().min(1).optional(),
  mountDevice: z.string().optional(),
  fstype: z.enum(["ext4", "xfs", "btrfs", "nfs", "cifs", "glusterfs"]).optional(),
  mountOptions: z.string().optional(),
  smbUsername: z.string().optional(),
  smbPassword: z.string().optional(),
  smbDomain: z.string().optional(),
  smbVersion: z.enum(["default", "1.0", "2.0", "2.1", "3", "3.0", "3.02", "3.11", "3.1.1"]).optional(),
  nfsVersion: z.enum(["3", "4", "4.0", "4.1", "4.2"]).optional(),
  // S3 / object storage
  s3Endpoint: z.string().min(1).optional(),
  s3Bucket: z.string().min(1).optional(),
  s3Region: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  s3Provider: z.enum(["aws", "minio", "b2", "generic"]).optional(),
  s3VfsCacheMode: z.enum(["off", "minimal", "writes", "full"]).optional(),
});

export const FormatDiskSchema = z.object({
  device: z.string().regex(/^\/dev\/[a-z][a-z0-9]+$/),
  fstype: z.enum(["ext4", "xfs", "btrfs"]),
  label: z.string().max(16).optional(),
  force: z.boolean().default(false),
});

export type CreateRaidInput = z.infer<typeof CreateRaidSchema>;
export type CreateStoragePoolInput = z.infer<typeof CreateStoragePoolSchema>;
export type FormatDiskInput = z.infer<typeof FormatDiskSchema>;
