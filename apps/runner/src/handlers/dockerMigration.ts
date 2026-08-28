export interface DockerMigrationPort {
  hostPort: number;
  containerPort: number;
  protocol: string;
  hostIp?: string;
}

export interface DockerMigrationInspect {
  name?: string;
  state?: string;
  ports?: DockerMigrationPort[];
  env?: string[];
  mounts?: Array<{ type: string; source: string; destination: string; mode?: string }>;
  networks?: string[];
  privileged?: boolean;
  restartPolicy?: string;
  command?: string;
  cpuLimit?: number;
  memoryMb?: number;
}

export interface DockerMigrationManifest {
  name: string;
  wasRunning: boolean;
  ports: DockerMigrationPort[];
  env: string[];
  network?: string;
  privileged: boolean;
  restartPolicy: string;
  command?: string;
  cpuLimit?: number;
  memoryMb?: number;
}

/** Build a portable run manifest; mounted data is rejected until transactional volume transfer exists. */
export function buildDockerMigrationManifest(current: DockerMigrationInspect, targetName: string): DockerMigrationManifest {
  if ((current.mounts ?? []).length > 0) {
    throw new Error("Docker migration with volumes or bind mounts is not supported yet; detach or migrate mounted data explicitly to avoid data loss");
  }
  return {
    name: targetName,
    wasRunning: current.state === "running",
    ports: (current.ports ?? []).map((port) => ({
      hostPort: port.hostPort,
      containerPort: port.containerPort,
      protocol: port.protocol,
      hostIp: port.hostIp,
    })),
    env: current.env ?? [],
    network: current.networks?.[0],
    privileged: Boolean(current.privileged),
    restartPolicy: current.restartPolicy || "unless-stopped",
    command: current.command || undefined,
    cpuLimit: current.cpuLimit,
    memoryMb: current.memoryMb,
  };
}
