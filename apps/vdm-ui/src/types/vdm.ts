// VDM types

export type NodeStatus = "online" | "degraded" | "offline" | "unknown";
export type ResourceState = "running" | "stopped" | "paused" | "suspended" | "crashed" | "unknown";
export type TaskStatus = "pending" | "running" | "completed" | "completed-with-warning" | "failed" | "cancelled" | "recovery-required";
export type TaskKind = "migrate" | "clone" | "backup" | "restore" | "action" | "storage" | "other";
export type StorageType = "nfs" | "smb" | "cifs" | "glusterfs" | "s3";

export interface VdmUser {
  id: number;
  username: string;
  role: "admin" | "viewer";
  displayName: string | null;
  mustChangePassword?: boolean;
}

export interface VdmNode {
  id: number;
  name: string;
  displayName: string;
  apiUrl: string;
  enabled: boolean;
  status: NodeStatus;
  lastSeenAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  virtuaVersion?: string | null;
  compatibility?: "compatible" | "incompatible" | "unknown";
  lastError?: string | null;
  failureCount?: number;
  latencyMs?: number | null;
}

export interface VdmJoinToken {
  id: number;
  token: string;
  note: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface VdmNodeSummary {
  node: {
    name: string;
    displayName: string;
    status: NodeStatus;
    lastSeenAt: string | null;
  };
  systemInfo?: {
    hostname: string;
    os: string;
    kernel: string;
    cpuModel: string;
    cpuCores: number;
    memoryTotal: number;
  };
  systemStats?: {
    cpuUsagePercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    loadAvg: number[];
  };
  resources?: {
    vms: number;
    lxc: number;
    docker: number;
  };
}

export interface VdmVm {
  name: string;
  state: ResourceState;
  vcpus?: number;
  memoryMb?: number;
  autostart?: boolean;
  nodeName: string;
  nodeDisplayName: string;
  description?: string | null;
  tags?: string[];
  userId?: number | null;
}

export interface VdmVmStats {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  uptimeSeconds?: number;
  guestAgentEnabled?: boolean;
  guestAgentConnected?: boolean;
  guestAgentRunning?: boolean;
  guestAgentStatus?: "running" | "stopped" | "not-installed" | "unknown";
  spiceAgentPresent?: boolean;
  spiceAgentConnected?: boolean;
  ipAddresses?: string[];
}

export interface VdmVmInfo extends VdmVm {
  arch?: string;
  machine?: string;
  uefi?: boolean;
  tpmEnabled?: boolean;
  qemuAgentEnabled?: boolean;
  videoModel?: string;
  bootDevice?: string;
  disks?: Array<{ device: string; path: string; sizeBytes: number; format: string; readonly: boolean }>;
  networks?: Array<{ mac: string; bridge: string; model: string }>;
}

export interface VdmSnapshot {
  name: string;
  description?: string;
  createdAt: string;
  state?: string;
}

export interface VdmLxc {
  name: string;
  state: ResourceState;
  os?: string;
  arch?: string;
  cpus?: number;
  memoryMb?: number;
  rootfsSizeGb?: number;
  nodeName: string;
  nodeDisplayName: string;
  description?: string | null;
  userId?: number | null;
}

export interface VdmDockerPort {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
  hostIp?: string;
}

export interface VdmDocker {
  id: string;
  name: string;
  image: string;
  state: ResourceState;
  status: string;
  created?: string;
  createdAt?: string;
  ports?: VdmDockerPort[] | string;
  nodeName: string;
  nodeDisplayName: string;
  userId?: number | null;
}

export interface VdmComposeProject {
  name: string;
  modifiedAt: string;
  nodeName: string;
  nodeDisplayName: string;
}

export interface VdmComposeService {
  service: string;
  name: string;
  state: string;
  ports?: string;
}

export interface VdmDockerVolume {
  name: string;
  driver: string;
  mountpoint?: string;
  nodeName: string;
  nodeDisplayName: string;
}

export interface VdmSharedStorage {
  id: number;
  name: string;
  displayName: string;
  type: StorageType;
  source: string;
  mountOptions: string | null;
  smbDomain: string | null;
  smbUsername: string | null;
  smbVersion: string | null;
  nfsVersion: string | null;
  s3Endpoint: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Provider: string | null;
  s3VfsCacheMode: string | null;
  s3Configured: boolean;
  localMountPath: string;
  content: string[];
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VdmStorageNodeStatus {
  node: string;
  nodeDisplayName: string;
  mounted: boolean;
  error: string | null;
}

export interface VdmStorageContentItem {
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt?: string | null;
  linkedResourceType?: string;
  linkedResourceName?: string;
  relation?: string;
  synthetic?: boolean;
  isLinked?: boolean;
  deletable?: boolean;
}

export interface VdmNodePool {
  name: string;
  path?: string;
  type?: string;
  mountSource?: string;
  mounted?: boolean;
  capacity?: number;
  allocation?: number;
  available?: number;
}

export interface VdmTask {
  id: string;
  kind: TaskKind;
  label: string;
  sourceNode: string | null;
  targetNode: string | null;
  resourceType: string | null;
  resourceName: string | null;
  status: TaskStatus;
  progress: number;
  message: string | null;
  error: string | null;
  result?: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VdmSummary {
  nodes: VdmNodeSummary[];
  activeTasks: number;
}

export interface VdmBackupRepository {
  id: number;
  name: string;
  displayName: string;
  storageName: string;
  enabled: boolean;
  encryptionEnabled: boolean;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  quotaBytes: number | null;
}

export interface VdmBackupItem {
  id: string;
  repositoryId: number;
  taskId: string | null;
  resourceType: "vm" | "lxc";
  resourceName: string;
  sourceNode: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  format: string;
  compression: string | null;
  checksumSha256: string | null;
  verifiedAt: string | null;
  status: "available" | "missing" | "deleted";
  createdAt: string;
}

export interface VdmBackupJob {
  id: string;
  name: string;
  repositoryId: number;
  resourceType: "vm" | "lxc";
  resourceName: string;
  sourceNode: string;
  schedule: { intervalMinutes: number } | null;
  enabled: boolean;
  compress: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}
