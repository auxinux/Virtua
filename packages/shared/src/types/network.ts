export interface NetworkBridge {
  name: string;
  state?: "up" | "down" | "unknown";
  ipAddress?: string;
  gateway?: string;
  macAddress?: string;
  interfaces?: string[];  // enslaved interfaces
  uplinkInterface?: string;
  hostIpMode?: "none" | "dhcp" | "static" | "copy" | "unknown";
  stpEnabled?: boolean;
  mtu?: number;
  persistent?: boolean;
}

export interface LibvirtNetwork {
  name: string;
  active: boolean;
  autostart?: boolean;
  persistent?: boolean;
  bridge?: string;
  mode?: "nat" | "route" | "bridge" | "isolated";
  subnet?: string;
  gateway?: string;
  dhcpStart?: string;
  dhcpEnd?: string;
}

export interface NetworkInterface {
  name: string;
  state?: "UP" | "DOWN" | "UNKNOWN";
  macAddress?: string;
  addresses?: string[];
  mtu?: number;
  type?: "physical" | "bridge" | "vlan" | "loopback" | "virtual";
  speed?: number; // Mbps
}
