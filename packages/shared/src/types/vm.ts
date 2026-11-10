export type VmState = "running" | "stopped" | "paused" | "suspended" | "unknown";

export interface QemuVm {
  name: string;
  /** Optional UI label overriding `name`; does not rename the domain. */
  displayName?: string;
  id: string;
  state: VmState;
  vcpus: number;
  maxMemoryKiB: number;
  usedMemoryKiB: number;
  autostart: boolean;
  uuid: string;
  description?: string;
  tags?: string[];
  userId?: number;
  disposable?: VmDisposableInfo | null;
}

export interface VmDisk {
  device: string;       // vda, vdb, sda...
  bus: "virtio" | "ide" | "sata" | "scsi";
  source: string;       // path to qcow2/raw
  format: "qcow2" | "raw";
  sizeBytes: number;
  readonly: boolean;
  boot?: boolean;
}

export interface VmNetworkInterface {
  index: number;
  mac: string;
  model: "virtio" | "e1000" | "rtl8139" | "ne2k_pci" | "pcnet";
  source: string;       // bridge name
  type: "bridge" | "network" | "direct";
  ipAddresses?: string[];
}

export interface VmUsbDevice {
  type: "usb";
  id: string;
  vendorId: string;
  productId: string;
  label: string;
  bus?: string;
  device?: string;
  persistent?: boolean;
}

export interface VmInfo {
  name: string;
  /** Optional UI label overriding `name`; does not rename the domain. */
  displayName?: string;
  nodeName?: string;
  state: VmState;
  vcpus: number;
  currentMemoryKiB: number;
  maxMemoryKiB: number;
  uuid: string;
  os: string;
  machine: string;
  arch: string;
  uefi?: boolean;
  secureBoot?: boolean;
  bootOrder?: Array<"hd" | "cdrom" | "network" | "fd">;
  /** Basename of the image in floppy drive A:, null when the drive is empty or absent. */
  mountedFloppy?: string | null;
  /** True when the VM has a floppy drive (fda), even if empty. */
  floppyDrive?: boolean;
  /** Write-protect state of drive A: (null when there is no drive). */
  floppyReadonly?: boolean | null;
  tpmEnabled?: boolean;
  qemuAgentEnabled?: boolean;
  videoModel?: "vga" | "virtio" | "qxl";
  /** CPU model chosen for the VM (`auto` = host-passthrough). */
  cpuModel?: string;
  /** Period CPU emulated at roughly its own speed (TCG + icount). */
  periodSpeed?: boolean;
  /** Set when the VM is a disposable overlay on a base. */
  disposable?: VmDisposableInfo | null;
  /** Unattended installation still in progress (quick create). */
  autoInstall?: VmAutoInstallInfo | null;
  autostart: boolean;
  /** Redémarrage automatique après une panne (null = défaut global du nœud). */
  restartOnCrash?: boolean | null;
  disks: VmDisk[];
  networks: VmNetworkInterface[];
  usbDevices?: VmUsbDevice[];
  vncPort?: number;
  vncHost?: string;
  spicePort?: number;
  spiceTlsPort?: number;
  spiceHost?: string;
  spiceEnabled?: boolean;
  description?: string;
  tags?: string[];
}

export interface VmDisposableInfo {
  baseId: string;
  baseLabel: string;
  /** Strict sandbox: every write is dropped when the VM stops. */
  strict: boolean;
}

export interface VmAutoInstallInfo {
  os: "windows11" | "debian13";
  /** The installed system becomes a disposable base when done. */
  makeBase: boolean;
  phase: string;
}

export interface VmRdpConsoleInfo {
  ok: boolean;
  vmName: string;
  state: VmState;
  vncHost: string;
  vncPort?: number;
  xrdpInstalled: boolean;
  xrdpActive: boolean;
  xrdpPort: number;
  xrdpLibVnc?: string;
  profileName: string;
  profileSection: string;
  profilePresent: boolean;
  /** Current guest console size; the .rdp file must request exactly this. */
  consoleWidth?: number;
  consoleHeight?: number;
  ready: boolean;
  warnings: string[];
  /** Per-VM console password; only present in the prepare response. */
  consolePassword?: string;
}

export interface VmStats {
  state: VmState;
  cpuTimeNs: number;
  cpuPercent: number;
  memoryUsedKiB: number;
  balloonCurrentKiB: number;
  balloonMaxKiB: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockRdBytes: number;
  blockWrBytes: number;
  uptimeSeconds?: number;
  /** QEMU guest agent: channel defined in the VM hardware. */
  guestAgentEnabled?: boolean;
  /** QEMU guest agent: guest side has the virtio channel open. */
  guestAgentConnected?: boolean;
  /** QEMU guest agent: responded to guest-ping. */
  guestAgentRunning?: boolean;
  guestAgentStatus?: "running" | "stopped" | "not-installed" | "unknown";
  /** SPICE agent (vdagent): spicevmc channel defined in the VM hardware. */
  spiceAgentPresent?: boolean;
  /** SPICE agent (vdagent): guest side has the channel open (resize/clipboard work). */
  spiceAgentConnected?: boolean;
  /** Guest IPv4 addresses (agent, DHCP lease, or ARP discovery). */
  ipAddresses?: string[];
}

export interface VmSnapshot {
  name: string;
  description: string;
  createdAt: string;
  state: string;
  parent?: string;
  isCurrent: boolean;
}

export interface VmBackup {
  id: string;
  nodeName?: string;
  resourceName: string;
  filename: string;
  storagePool: string | null;
  sizeBytes: number;
  format: "tar.gz" | "qcow2";
  createdAt: string;
}
