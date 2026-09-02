export type LxcState = "running" | "stopped" | "frozen" | "unknown";

export interface LxcContainer {
  name: string;
  nodeName?: string;
  state: LxcState;
  cpus: number;
  memoryMiB: number;
  diskGb: number;
  ipAddress?: string;
  gateway?: string;
  bridge?: string;
  macAddress?: string;
  dns?: string[];
  usbDevices?: Array<{
    type: "usb";
    id: string;
    vendorId: string;
    productId: string;
    label: string;
    bus?: string;
    device?: string;
    devPath?: string;
    persistent?: boolean;
  }>;
  gpuDevices?: Array<{
    type: "gpu";
    id: "dri" | "nvidia";
    label: string;
    devPaths: string[];
  }>;
  autostart: boolean;
  /** Redémarrage automatique après une panne (null = défaut global du nœud). */
  restartOnCrash?: boolean | null;
  userId?: number;
  description?: string;
}

export interface LxcPortForward {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

export interface LxcStats {
  cpuPercent?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskRdBytes?: number;
  diskWrBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

export interface LxcTemplate {
  name: string;
  size?: number;
  dist?: string;
  release?: string;
  arch?: string;
  variant?: string;
  description?: string;
  cached?: boolean;
}

export interface LxcSnapshot {
  name: string;
  description?: string;
  createdAt: string;
}
