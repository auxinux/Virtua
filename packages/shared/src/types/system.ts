export interface SystemStats {
  uptime: number;
  loadavg: [number, number, number];
  cpuCount: number;
  cpuUsage: number;       // 0-100
  mem: {
    total: number;
    used: number;
    free: number;
    cached: number;
    buffers: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
  };
  network: {
    rxBytes: number;
    txBytes: number;
    rxRate: number;        // bytes/sec
    txRate: number;
  };
}

export interface SystemInfo {
  hostname: string;
  /** Primary/public IP = source address toward the default route (the reachable one). */
  primaryIp?: string;
  publicIps: string[];
  allIps: string[];
  os: string;
  kernel: string;
  arch: string;
  uptime: number;
}

export interface ResourceCounts {
  vms: { total: number; running: number };
  lxc: { total: number; running: number };
  docker: { total: number; running: number };
  storagePoolsTotal: number;
  storageUsedGb: number;
  storageTotalGb: number;
}

export interface HostServiceStatus {
  name: string;
  activeState: string;
  subState?: string;
  unitFileState?: string;
  result?: string;
  execMainStatus?: number;
  description?: string;
  status: "running" | "stopped" | "failed" | "inactive" | "unknown";
  errorReason?: string;
}

export interface AptUpdateStatus {
  upgradableCount: number;
  packages: string[];
  cacheUpdatedAt?: string;
  rebootRequired: boolean;
}

export interface HostUsbDevice {
  type: "usb";
  id: string;
  vendorId: string;
  productId: string;
  label: string;
  manufacturer?: string;
  product?: string;
  bus?: string;
  device?: string;
  devPath?: string;
  persistent?: boolean;
  assignedTo?: {
    type: "vm" | "lxc";
    name: string;
  };
}

export interface HostGpuDevice {
  type: "gpu";
  id: "dri" | "nvidia";
  label: string;
  vendor: "intel" | "amd" | "nvidia" | "unknown";
  mode: "shared-lxc";
  devPaths: string[];
  assignedTo?: {
    type: "lxc";
    name: string;
  };
}
