export type LxcState = "running" | "stopped" | "frozen" | "unknown";

export interface LxcContainer {
  name: string;
  /** Optional UI label overriding `name`; does not rename the container. */
  displayName?: string;
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

/** Trace left in a container rootfs by the recursive permission changes of Virtua <= 0.8.2. */
export type LxcRootfsIssueCode = "qemu-group" | "setgid-2775" | "sticky-missing" | "shadow-readable" | "setuid-missing";

export interface LxcRootfsIssue {
  code: LxcRootfsIssueCode;
  /** Path as seen from inside the container, e.g. "/etc/sudoers.d". */
  path: string;
  /** Octal permission bits, e.g. "2775". */
  mode: string;
  gid?: number;
}

export interface LxcRootfsAuditEntry {
  container: string;
  /** Set when the damaged tree is a Virtua snapshot rather than the live rootfs. */
  snapshot?: string;
  /** Found on a pool without a container config on this host. */
  unregistered?: boolean;
  rootfsPath: string;
  issues: LxcRootfsIssue[];
}

export interface LxcRootfsAuditReport {
  checkedAt: string;
  qemuGroup: string | null;
  qemuGid: number | null;
  checked: number;
  affected: LxcRootfsAuditEntry[];
}
