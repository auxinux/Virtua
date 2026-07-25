import type { ResourceCounts, SystemInfo, SystemStats } from "./system";

export type DatacenterMode = "standalone" | "datacenter";
export type DatacenterNodeRole = "primary" | "secondary";
export type DatacenterNodeStatus = "local" | "unknown" | "offline" | "online";

export interface DatacenterConfig {
  mode: DatacenterMode;
  name: string;
  primaryNodeName: string;
  primaryApiUrl?: string | null;
}

export interface DatacenterNode {
  name: string;
  displayName?: string | null;
  role: DatacenterNodeRole;
  apiUrl?: string | null;
  authToken?: string | null;
  enabled: boolean;
  isLocal: boolean;
  status: DatacenterNodeStatus;
  notes?: string | null;
  lastSeenAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatacenterJoinToken {
  id: number;
  token: string;
  note?: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface JoinDatacenterResult {
  ok: true;
  config: DatacenterConfig;
  node: DatacenterNode;
}

export interface DatacenterResourceEntry {
  resourceType: "vm" | "lxc" | "docker";
  resourceName: string;
  displayName: string;
  nodeName: string;
  state?: string;
}

export interface DatacenterStorageEntry {
  kind: "pool";
  name: string;
  displayName: string;
  nodeName?: string | null;
  scope: "node" | "datacenter";
  path?: string;
  content?: string[];
  enabled?: boolean;
  type?: string;
  fstype?: string | null;
  mountSource?: string | null;
  mountOptions?: string | null;
}

export interface DatacenterNodeSummary {
  node: DatacenterNode;
  virtuaVersion?: string;
  systemInfo?: SystemInfo;
  systemStats?: SystemStats;
  resources: ResourceCounts;
  totalResources: number;
}

export interface DatacenterSummary {
  config: DatacenterConfig;
  nodes: DatacenterNodeSummary[];
  totals: {
    nodes: number;
    cpuCores: number;
    memoryBytes: number;
    memoryUsedBytes: number;
    diskBytes: number;
    diskUsedBytes: number;
    vms: number;
    lxc: number;
    docker: number;
    storagePools: number;
  };
  resources: DatacenterResourceEntry[];
  storages: DatacenterStorageEntry[];
}
