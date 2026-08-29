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

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;

/** Wildcard bind addresses Docker reports for `-p 8080:80` (all interfaces). */
const WILDCARD_HOST_IPS = new Set(["", "0.0.0.0", "::", "::0"]);

/**
 * Normalize a hostIp coming from `docker inspect` so the target node can
 * re-publish the port. Docker reports "::" (IPv6 wildcard) or "0.0.0.0" when
 * the port was published on all interfaces — the node-side run validation only
 * accepts IPv4, so raw "::" used to abort every migration with
 * "Invalid port hostIp: must be a valid IPv4 address". Wildcards drop the
 * hostIp (bind all interfaces); only explicit valid IPv4 addresses survive.
 */
export function normalizeMigrationHostIp(hostIp: string | undefined): string | undefined {
  if (hostIp === undefined || hostIp === null) return undefined;
  const trimmed = hostIp.trim();
  if (WILDCARD_HOST_IPS.has(trimmed)) return undefined;
  if (IPV4_RE.test(trimmed)) return trimmed;
  // Anything else (IPv6 literal, bracketed form) is not re-publishable by the
  // node runner today — publish on all interfaces rather than failing the
  // whole migration.
  return undefined;
}

/** Dedupe bindings that collapse to the same publish after normalization:
 * a dual-stack wildcard publish yields one 0.0.0.0 and one "::" binding, and
 * re-publishing both would fail with "port is already allocated". */
export function dedupeMigrationPorts(ports: DockerMigrationPort[]): DockerMigrationPort[] {
  const seen = new Set<string>();
  const out: DockerMigrationPort[] = [];
  for (const port of ports) {
    const key = `${port.hostIp ?? ""}:${port.hostPort}:${port.containerPort}/${port.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(port);
  }
  return out;
}

/** Build a portable run manifest; mounted data is rejected until transactional volume transfer exists. */
export function buildDockerMigrationManifest(current: DockerMigrationInspect, targetName: string): DockerMigrationManifest {
  if ((current.mounts ?? []).length > 0) {
    throw new Error("Docker migration with volumes or bind mounts is not supported yet; detach or migrate mounted data explicitly to avoid data loss");
  }
  const ports = (current.ports ?? []).map((port) => ({
    hostPort: port.hostPort,
    containerPort: port.containerPort,
    protocol: port.protocol,
    hostIp: normalizeMigrationHostIp(port.hostIp),
  }));
  return {
    name: targetName,
    wasRunning: current.state === "running",
    ports: dedupeMigrationPorts(ports),
    env: current.env ?? [],
    network: current.networks?.[0],
    privileged: Boolean(current.privileged),
    restartPolicy: current.restartPolicy || "unless-stopped",
    command: current.command || undefined,
    cpuLimit: current.cpuLimit,
    memoryMb: current.memoryMb,
  };
}
