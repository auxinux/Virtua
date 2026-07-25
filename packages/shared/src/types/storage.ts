export type DiskType = "hdd" | "ssd" | "nvme" | "unknown";
export type PoolContentType = "iso" | "vm" | "backup" | "template" | "container" | "disk";
export type RaidLevel = 0 | 1 | 5 | 10;
export type RaidState = "active" | "degraded" | "rebuilding" | "inactive" | "failed";
export type FilesystemType = "ext4" | "xfs" | "btrfs" | "ntfs" | "vfat" | "swap" | "unknown";

export interface PhysicalDisk {
  name: string;          // sda, sdb, nvme0n1...
  path: string;          // /dev/sda
  size: number;          // bytes
  type: DiskType;
  model: string;
  vendor: string;
  serial?: string;
  rotational: boolean;
  partitions: DiskPartition[];
  inUse: boolean;        // mounted or part of RAID
  inRaid?: string;       // /dev/md0 if member of RAID
}

export interface DiskPartition {
  name: string;          // sda1, sda2...
  path: string;          // /dev/sda1
  size: number;
  fstype: FilesystemType;
  mountpoint?: string;
  label?: string;
  uuid?: string;
}

export interface RaidArray {
  id?: number;
  device: string;        // /dev/md0
  name: string;
  level: RaidLevel;
  state: RaidState;
  size: number;
  members: RaidMember[];
  mountpoints?: string[];
  inUse?: boolean;
  rebuildPercent?: number;
  chunkSizeKb?: number;
  createdAt?: string;
}

export interface RaidMember {
  device: string;        // /dev/sdb
  role: "active" | "spare" | "failed" | "rebuilding";
  errors: number;
}

export interface StoragePool {
  id?: number;
  name: string;
  path: string;
  type: "directory" | "lvm" | "nfs" | "cifs";
  content: PoolContentType[];
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  enabled: boolean;
  mountSource?: string;
  fstype?: "ext4" | "xfs" | "btrfs" | "nfs" | "cifs";
  mountOptions?: string;
  smbUsername?: string;
  smbDomain?: string;
  raidDevice?: string;   // if backed by RAID
  createdAt?: string;
}

export interface MountedFilesystem {
  mountpoint: string;
  source: string;
  fstype: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  isRoot: boolean;
}

export interface IsoFile {
  id?: number;
  filename: string;
  displayName?: string;
  type: "iso" | "lxc_template" | "docker_image" | "vm_disk";
  sizeBytes: number;
  ownerId?: number;
  ownerUsername?: string;
  isPublic: boolean;
  storagePool?: string;
  createdAt?: string;
}

export interface DownloadJob {
  jobId: string;
  url: string;
  filename: string;
  status: "pending" | "downloading" | "done" | "error";
  bytesDownloaded: number;
  totalBytes?: number;
  error?: string;
}
