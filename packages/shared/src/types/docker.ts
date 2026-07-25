export type DockerState = "running" | "stopped" | "paused" | "exited" | "created" | "restarting" | "unknown";

export interface DockerPort {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
  hostIp?: string;
}

export interface DockerMount {
  source: string;
  destination: string;
  mode?: string;
  type?: "bind" | "volume" | "tmpfs";
}

export interface DockerContainer {
  id: string;
  nodeName?: string;
  name: string;
  image: string;
  state: DockerState;
  status?: string;
  ports?: DockerPort[];
  createdAt: string;
  userId?: number;
}

export interface DockerContainerDetail extends DockerContainer {
  env?: string[];
  mounts?: DockerMount[];
  networks?: string[];
  privileged?: boolean;
  restartPolicy?: string;
  command?: string;
  entrypoint?: string;
}

export interface DockerStats {
  cpuPercent?: number;
  memUsedBytes?: number;
  memLimitBytes?: number;
  memPercent?: number;
  netRxBytes?: number;
  netTxBytes?: number;
  blockRdBytes?: number;
  blockWrBytes?: number;
  pids?: number;
}

export interface DockerImage {
  id: string;
  repoTags?: string[];
  size: number;
  created?: number;
  isPublic?: boolean;
  ownerId?: number;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  subnet?: string;
  gateway?: string;
  ipRange?: string;
  parent?: string;
  containers?: string[];
}

export interface DockerRegistryImage {
  name: string;
  description?: string;
  stars: number;
  pulls?: number;
  isOfficial: boolean;
  isAutomated: boolean;
}

export interface DockerHubDetail {
  exposedPorts: string[]; // e.g. ["80/tcp", "443/tcp"]
  fullDescription?: string;
}
