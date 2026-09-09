export type ResourceKind = "vm" | "lxc" | "docker";

export type ResourceState = string;

export type VirtuaRole = "ADMIN" | "USER";

export type ConsoleMode = "text" | "graphical" | "spice";

export type UsageMode = "local" | "cloud";

export type PowerAction = "start" | "stop" | "restart" | "shutdown";

export type VmArchitecture = "arm64" | "amd64";

export interface VirtuaUser {
  username: string;
  displayName: string;
  role: VirtuaRole;
  /** Server-declared creation rights, per resource kind. */
  canCreate?: Partial<Record<ResourceKind, boolean>>;
}

export interface VirtuaConnection {
  id: string;
  name: string;
  endpoint: string;
  status: "connected" | "connecting" | "offline";
  username: string;
  lastSync: string;
}

export interface VirtuaNode {
  id: string;
  name: string;
  host: string;
  role: "primary" | "worker" | "storage";
  status: "online" | "offline" | "maintenance";
  cpuUsage: number;
  memoryUsage: number;
  storageUsage: number;
  uptime?: string;
  vmCount: number;
  lxcCount: number;
  dockerCount: number;
  computerName?: string;
  totalCores?: number;
  virtualizationCores?: number;
  totalMemoryGib?: number;
  virtualizationMemoryGib?: number;
}

export interface VirtuaResource {
  id: string;
  kind: ResourceKind;
  source?: UsageMode;
  name: string;
  displayName: string;
  node: string;
  state: ResourceState;
  architecture?: VmArchitecture;
  cpu?: number;
  memory?: number;
  cpuCores?: number;
  memoryMib?: number;
  diskGib?: number;
  ip?: string;
  uptime?: string;
  image?: string;
  network?: string;
  networkModel?: string;
  gpuModel?: string;
  diskBus?: string;
  tpm2?: boolean;
  secureBoot?: boolean;
  /** Features the last local start had to give up on (SPICE, audio, KVM…). */
  startupNotes?: string;
  owner?: string;
  assignedUsers?: string[];
  guestAgent?: {
    installed?: boolean;
    running?: boolean;
    status?: string;
  };
  consoleModes: ConsoleMode[];
  permissions: {
    canView: boolean;
    canConsole: boolean;
    canPower: boolean;
    canSnapshot: boolean;
    canModify?: boolean;
    canDelete?: boolean;
    canCreate?: boolean;
  };
}

export interface VirtuaTask {
  id: string;
  label: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  createdAt: string;
  /** "server" for operations Virtua runs itself, "device" for this client's. */
  source?: "server" | "device";
}

export interface DesktopDeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface DesktopTokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  device: DesktopDeviceInfo;
}

export interface DesktopMeResponse {
  user: { id: number; username: string; displayName: string | null; role: VirtuaRole };
  device: DesktopDeviceInfo;
  capabilities: {
    isAdmin: boolean;
    canCreate?: Partial<Record<ResourceKind, boolean>>;
  };
}

export interface DesktopResourceResponse {
  id: string;
  type: ResourceKind;
  name: string;
  displayName?: string;
  state: string;
  node: string;
  cpu?: number | string | null;
  cpuPercent?: number | string | null;
  cpuUsage?: number | string | null;
  memory?: number | string | null;
  memoryPercent?: number | string | null;
  memPercent?: number | string | null;
  ramPercent?: number | string | null;
  ip?: string | null;
  ipAddress?: string | null;
  ipAddresses?: string[] | null;
  uptime?: string | number | null;
  uptimeSeconds?: number | null;
  image?: string | null;
  cpuCores?: number | string | null;
  vcpu?: number | string | null;
  vcpus?: number | string | null;
  memoryMib?: number | string | null;
  memoryMiB?: number | string | null;
  ramMib?: number | string | null;
  diskGib?: number | string | null;
  diskGiB?: number | string | null;
  tpm2?: boolean | null;
  secureBoot?: boolean | null;
  owner?: string | null;
  assignedUsers?: string[] | null;
  guestAgent?: {
    installed?: boolean | null;
    running?: boolean | null;
    status?: string | null;
  } | null;
  guestAgentStatus?: string | null;
  qemuGuestAgent?: boolean | null;
  qemuGuestAgentEnabled?: boolean | null;
  qemuGuestAgentRunning?: boolean | null;
  qemuGuestAgentStatus?: string | null;
  permissions: VirtuaResource["permissions"];
}

export interface DesktopCreateOptionItem {
  id: string;
  name: string;
  label?: string;
  type?: string;
  kind?: string;
  source?: string;
  node?: string;
  description?: string | null;
  architecture?: VmArchitecture | string | null;
  cpu?: number | null;
  memory?: number | null;
  ram?: number | null;
  disk?: number | string | null;
  size?: number | string | null;
}

export interface DesktopCreateOptionsResponse {
  nodes?: DesktopCreateOptionItem[];
  images?: DesktopCreateOptionItem[];
  networks?: DesktopCreateOptionItem[];
  architectures?: DesktopCreateOptionItem[];
  defaults?: {
    cpu?: number;
    memory?: number;
    disk?: number;
    network?: string;
    architecture?: VmArchitecture;
  };
}

export interface DesktopConsoleTicketResponse {
  ticket: string;
  url: string;
  expiresInMs: number;
  kind: ConsoleMode;
  /** SPICE session password (spice tickets only) — required for protocol auth */
  password?: string;
}

export interface LocalBinaryStatus {
  path?: string | null;
  available: boolean;
}

export interface LocalQemuDiagnostics {
  os: string;
  hostArch: string;
  accelerator?: string | null;
  qemuImg: LocalBinaryStatus;
  qemuSystemArm64: LocalBinaryStatus;
  qemuSystemAmd64: LocalBinaryStatus;
  homebrew: LocalBinaryStatus;
  ready: boolean;
}

export interface LocalStorageConfig {
  vmConfigDir: string;
  diskDir: string;
  isoDir: string;
  snapshotDir: string;
  exportDir: string;
}

export interface LocalStorageFile {
  name: string;
  path: string;
  size: number;
  modifiedAt?: string | null;
}

export interface LocalDockerImage {
  repository: string;
  tag: string;
  imageId: string;
  size: string;
}

export interface LocalStorageInventory {
  iso: LocalStorageFile[];
  templates: LocalStorageFile[];
  disks: LocalStorageFile[];
  snapshots: LocalStorageFile[];
  exports: LocalStorageFile[];
  dockerImages: LocalDockerImage[];
}

export interface LocalSnapshot {
  id: string;
  vmId: string;
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export interface RemoteTemplateItem {
  category: "ISO" | "VM";
  architecture: VmArchitecture;
  name: string;
  url: string;
  size?: string | null;
  modifiedAt?: string | null;
  displayName?: string | null;
  description?: string | null;
  cpu?: number | null;
  ram?: number | null;
  disk?: string | null;
  metadataUrl?: string | null;
}

export interface LocalHostMetrics {
  computerName: string;
  cpuUsage: number;
  memoryUsage: number;
  storageUsage: number;
  uptimeSeconds?: number | null;
  totalCores: number;
  virtualizationCores: number;
  totalMemoryGib: number;
  virtualizationMemoryGib: number;
}

export interface LocalVm {
  id: string;
  name: string;
  architecture: VmArchitecture;
  cpu: number;
  memoryMib: number;
  diskGib: number;
  diskPath: string;
  isoPath?: string | null;
  network: string;
  networkModel?: string | null;
  gpuModel?: string | null;
  diskBus?: string | null;
  tpm2?: boolean | null;
  secureBoot?: boolean | null;
  state: ResourceState;
  pid?: number | null;
  vncPort?: number | null;
  qmpPort?: number | null;
  qgaPort?: number | null;
  guestIp?: string | null;
  guestAgentRunning?: boolean | null;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  uptimeSeconds?: number | null;
  startupNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalContainerResource {
  id: string;
  kind: ResourceKind;
  name: string;
  image?: string | null;
  state: ResourceState;
  ip?: string | null;
  ports?: string | null;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  uptimeSeconds?: number | null;
}
