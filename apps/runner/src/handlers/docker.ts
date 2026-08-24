import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";

const execFileAsync = promisify(execFile);

// ── Input validation helpers ────────────────────────────────────────────────

function validateDockerName(value: unknown, field = "container name"): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  // Docker container names: alphanumeric + _ - ., must start with alphanumeric or _
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: 1-128 alphanumeric/underscore/dot/hyphen chars`);
  }
  return trimmed;
}

function validateDockerImage(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid image: must be a string");
  const trimmed = value.trim();
  // Registry/name:tag — permit ., /, :, @, alphanumeric, -, _
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9./_:@-]{0,255})?$/.test(trimmed)) {
    throw new Error("Invalid image: invalid Docker image reference format");
  }
  return trimmed;
}

function validateDockerNetworkName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid network name");
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("Invalid network name: 1-64 alphanumeric/dot/hyphen/underscore");
  }
  return trimmed;
}

function validateComposeProject(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid compose project name");
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(trimmed)) {
    throw new Error("Invalid compose project name: 1-63 lowercase alphanumeric/underscore/hyphen");
  }
  return trimmed;
}

const ALLOWED_RESTART_POLICIES = new Set(["no", "always", "on-failure", "unless-stopped"]);
function validateRestartPolicy(value: unknown): string {
  const v = typeof value === "string" ? value : "unless-stopped";
  if (!ALLOWED_RESTART_POLICIES.has(v)) {
    throw new Error(`Invalid restartPolicy: must be one of ${[...ALLOWED_RESTART_POLICIES].join(", ")}`);
  }
  return v;
}

function validateDockerTag(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid tag");
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9./_:@-]{0,127})?$/.test(trimmed)) {
    throw new Error("Invalid Docker tag: must be a valid image reference");
  }
  return trimmed;
}

function validateHostPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || /[\n\r\0\t]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid ${field}: must be an absolute path without traversal`);
  }
  return trimmed;
}

function validateContainerPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || /[\n\r\0\t]/.test(trimmed)) {
    throw new Error(`Invalid ${field}: must be an absolute path`);
  }
  return trimmed;
}

function validateVolumeMode(value: unknown): string {
  const v = typeof value === "string" ? value : "rw";
  if (!["rw", "ro", "z", "Z", "shared", "slave", "private", "delegated", "cached", "consistent"].includes(v)) {
    return "rw";
  }
  return v;
}

function validatePortNumber(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${field}: port must be 1-65535`);
  }
  return value;
}

function validateProtocol(value: unknown): "tcp" | "udp" {
  return value === "udp" ? "udp" : "tcp";
}

function validateEnvVar(entry: string): string {
  // Allow KEY=VALUE or KEY (no value) — reject newlines and null bytes
  if (/[\n\r\0]/.test(entry)) {
    throw new Error(`Invalid env entry: control characters not allowed`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(entry)) {
    throw new Error(`Invalid env entry: "${entry}" — must be KEY or KEY=VALUE`);
  }
  return entry;
}

const ALLOWED_NETWORK_DRIVERS = new Set(["bridge", "host", "overlay", "macvlan", "ipvlan", "none"]);
function validateNetworkDriver(value: unknown): string {
  const v = typeof value === "string" ? value : "bridge";
  if (!ALLOWED_NETWORK_DRIVERS.has(v)) {
    throw new Error(`Invalid driver: must be one of ${[...ALLOWED_NETWORK_DRIVERS].join(", ")}`);
  }
  return v;
}

function validateSubnet(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\/(?:[0-9]|[12]\d|3[0-2])$/.test(value)) {
    throw new Error("Invalid subnet: must be CIDR notation (e.g. 172.20.0.0/16)");
  }
  return value;
}

function validateIpv4Address(value: unknown, field = "IPv4 address"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  if (!/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: must be a valid IPv4 address`);
  }
  return trimmed;
}

function validateMacAddress(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid MAC address: must be a string");
  const trimmed = value.trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(trimmed)) {
    throw new Error("Invalid MAC address: must use aa:bb:cc:dd:ee:ff format");
  }
  return trimmed;
}

function validateParentInterface(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid parent interface: must be a string");
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(trimmed)) {
    throw new Error("Invalid parent interface: expected an interface name such as eth0, eno1, vmbr0, or eth0.400");
  }
  return trimmed;
}

/** Split a command string into argv tokens respecting quoted strings. */
function splitCommandArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (char === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (char === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (char === " " && !inSingle && !inDouble) {
      if (current) { args.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export async function handleDocker(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case "docker_containers": return listContainers();
    case "docker_run": return runContainer(p);
    case "docker_delete": return deleteContainer(p.id as string);
    case "docker_action": return containerAction(p.id as string, p.action as string);
    case "docker_stats": return getStats(p.id as string);
    case "docker_logs": return getLogs(p.id as string, (p.tail as number) ?? 100);
    case "docker_inspect": return inspectContainer(p.id as string);
    case "docker_update_config": return updateConfig(p);
    case "docker_recreate": return recreateContainer(p);
    case "docker_pull": return pullImage(p.image as string);
    case "docker_build": return buildImage(p);
    case "docker_compose_up": return composeUp(p);
    case "docker_compose_down": return composeDown(p);
    case "docker_compose_ps": return composePs(p);
    case "docker_compose_logs": return composeLogs(p);
    case "docker_compose_config": return composeConfig(p);
    case "docker_compose_restart": return composeRestart(p);
    case "docker_compose_list": return composeList();
    case "docker_compose_save": return composeSave(p);
    case "docker_compose_delete": return composeDelete(p);
    case "docker_volumes": return listVolumes();
    case "docker_volume_create": return createVolume(p);
    case "docker_volume_delete": return deleteVolume(p.id as string);
    case "docker_exec": return execInContainer(p);
    case "docker_prune": return prune(p);
    case "docker_images": return listImages();
    case "docker_image_delete": return deleteImage(p.id as string);
    case "docker_search": return searchHub(p.query as string, (p.limit as number) ?? 25);
    case "docker_hub_detail": return fetchHubDetail(p.image as string);
    case "docker_networks": return listNetworks();
    case "docker_network_create": return createNetwork(p);
    case "docker_network_delete": return deleteNetwork(p.id as string);
    case "docker_container_networks": return listContainerNetworks(p.id as string);
    case "docker_network_connect": return connectContainerNetwork(p);
    case "docker_network_disconnect": return disconnectContainerNetwork(p.id as string, p.network as string);
    case "docker_rename": return renameContainer(p.id as string, p.newName as string);
    default: throw new Error(`Unknown docker action: ${action}`);
  }
}

async function docker(...args: string[]): Promise<string> {
  await ensureDockerDaemonReady();
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function dockerRaw(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interfaceExists(name: string) {
  try {
    await execFileAsync("ip", ["link", "show", "dev", name]);
    return true;
  } catch {
    return false;
  }
}

async function waitForInterface(name: string, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await interfaceExists(name)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function ensureInterfaceUp(name: string) {
  await execFileAsync("ip", ["link", "set", "dev", name, "up"]).catch(() => {});
}

async function ensureDockerDaemonReady() {
  try {
    await dockerRaw("info");
    return;
  } catch {
    // Try to recover the daemon on minimal hosts or after a bad reboot.
  }

  await execFileAsync("systemctl", ["enable", "containerd.service"]).catch(() => {});
  await execFileAsync("systemctl", ["enable", "docker.service"]).catch(() => {});
  await execFileAsync("systemctl", ["start", "containerd.service"]).catch(() => {});
  await execFileAsync("systemctl", ["start", "docker.service"]).catch(() => {});

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      await dockerRaw("info");
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error("Docker daemon is unavailable. Ensure docker.service is running.");
}

async function ensureDockerDefaultBridgeReady() {
  await ensureDockerDaemonReady();
  const defaultBridgePresent = await dockerRaw("network", "inspect", "bridge").then(() => true).catch(() => false);
  if (defaultBridgePresent && await interfaceExists("docker0")) {
    await ensureInterfaceUp("docker0");
    return;
  }

  await execFileAsync("systemctl", ["restart", "docker.service"]).catch(() => {});
  await ensureDockerDaemonReady();
  const bridgeAfterRestart = await dockerRaw("network", "inspect", "bridge").then(() => true).catch(() => false);
  if (bridgeAfterRestart && (await interfaceExists("docker0") || await waitForInterface("docker0"))) {
    await ensureInterfaceUp("docker0");
    return;
  }

  throw new Error("Docker default bridge is unavailable. Ensure docker.service networking initialized docker0.");
}

async function ensureDockerNetworkReady(network?: string) {
  const normalized = network?.trim();
  if (!normalized || normalized === "bridge") {
    await ensureDockerDefaultBridgeReady();
    return;
  }
  if (normalized === "host" || normalized === "none") {
    await ensureDockerDaemonReady();
    return;
  }

  await ensureDockerDaemonReady();
  const exists = await dockerRaw("network", "inspect", normalized).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(`Docker network ${normalized} does not exist`);
  }
}

async function ensureImageAvailable(image: string) {
  await ensureDockerDaemonReady();
  const exists = await dockerRaw("image", "inspect", image).then(() => true).catch(() => false);
  if (exists) return;

  try {
    await dockerRaw("pull", "--quiet", image);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to pull Docker image ${image}: ${detail}`);
  }
}

async function ensureContainerNetworksReady(id: string) {
  await ensureDockerDaemonReady();
  const inspectOut = await dockerRaw("inspect", id);
  const inspect = JSON.parse(inspectOut)[0] as Record<string, unknown>;
  const networks = Object.keys((((inspect.NetworkSettings as Record<string, unknown>)?.Networks as Record<string, unknown>) ?? {}));
  if (networks.length === 0) {
    await ensureDockerDefaultBridgeReady();
    return;
  }
  for (const network of networks) {
    await ensureDockerNetworkReady(network);
  }
}

function normalizeState(s: string): "running" | "stopped" | "paused" | "exited" | "created" | "restarting" | "unknown" {
  const state = s.toLowerCase();
  if (state === "running") return "running";
  if (state === "paused") return "paused";
  if (state === "exited") return "exited";
  if (state === "created") return "created";
  if (state === "restarting") return "restarting";
  if (state === "stopped") return "stopped";
  return "unknown";
}

function parseBytes(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB|KB)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  const map: Record<string, number> = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1048576, GB: 1e9, GIB: 1073741824 };
  return Math.round(n * (map[unit] ?? 1));
}

function parsePorts(portsStr: string) {
  const ports: Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp"; hostIp?: string }> = [];
  if (!portsStr) return ports;
  for (const entry of portsStr.split(",")) {
    const m = entry.trim().match(/^(?:([^:]+):)?(\d+)->(\d+)\/(\w+)$/);
    if (m) {
      ports.push({
        hostIp: m[1],
        hostPort: parseInt(m[2], 10),
        containerPort: parseInt(m[3], 10),
        protocol: (m[4].toLowerCase() as "tcp" | "udp") || "tcp",
      });
    }
  }
  return ports;
}

async function listContainers() {
  const out = await docker("ps", "-a", "--no-trunc", "--format", "{{json .}}");
  return out.trim().split("\n").filter(Boolean).map((line) => {
    try {
      const c = JSON.parse(line) as Record<string, string>;
      return {
        id: c.ID,
        name: (c.Names ?? "").replace(/^\//, ""),
        image: c.Image,
        state: normalizeState(c.State ?? ""),
        status: c.Status,
        ports: parsePorts(c.Ports ?? ""),
        createdAt: c.CreatedAt ? new Date(c.CreatedAt).toISOString() : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function runContainer(p: Record<string, unknown>) {
  const name = validateDockerName(p.name);
  const image = validateDockerImage(p.image);
  const rawPorts = (p.ports as Array<{ hostPort: number; containerPort: number; protocol: string }>) ?? [];
  const rawVolumes = (p.volumes as Array<{ hostPath: string; containerPath: string; mode: string }>) ?? [];
  const rawEnv = (p.env as string[]) ?? [];
  const cpuLimit = p.cpuLimit !== undefined ? Number(p.cpuLimit) : undefined;
  const memoryMb = p.memoryMb !== undefined ? Number(p.memoryMb) : undefined;
  const restartPolicy = validateRestartPolicy(p.restartPolicy);
  const command = p.command as string | undefined;
  const network = p.network ? validateDockerNetworkName(p.network) : undefined;
  const ipAddress = validateIpv4Address(p.ipAddress, "Docker static IP");
  const macAddress = validateMacAddress(p.macAddress);
  const privileged = (p.privileged as boolean) ?? false;

  if (cpuLimit !== undefined && (cpuLimit < 0 || cpuLimit > 1024)) throw new Error("Invalid cpuLimit: must be 0–1024");
  if (memoryMb !== undefined && (memoryMb < 4 || memoryMb > 1_048_576)) throw new Error("Invalid memoryMb: must be 4–1048576");

  const ports = rawPorts.map((port) => ({
    hostPort: validatePortNumber(port.hostPort, "hostPort"),
    containerPort: validatePortNumber(port.containerPort, "containerPort"),
    protocol: validateProtocol(port.protocol),
  }));
  const volumes = rawVolumes.map((vol) => ({
    hostPath: validateHostPath(vol.hostPath, "volume hostPath"),
    containerPath: validateContainerPath(vol.containerPath, "volume containerPath"),
    mode: validateVolumeMode(vol.mode),
  }));
  const env = rawEnv.map((entry) => validateEnvVar(entry));
  if (ipAddress && (!network || network === "bridge" || network === "host" || network === "none")) {
    throw new Error("Docker static IP requires a user-defined Docker network");
  }

  await ensureDockerNetworkReady(network);
  await ensureImageAvailable(image);

  const args = ["run", "-d", "--name", name, `--restart=${restartPolicy}`];
  if (privileged) args.push("--privileged");
  for (const port of ports) args.push("-p", `${port.hostPort}:${port.containerPort}/${port.protocol}`);
  for (const vol of volumes) args.push("-v", `${vol.hostPath}:${vol.containerPath}:${vol.mode}`);
  for (const value of env) args.push("-e", value);
  if (cpuLimit) args.push("--cpus", String(cpuLimit));
  if (memoryMb) args.push("-m", `${memoryMb}m`);
  if (network) args.push("--network", network);
  if (ipAddress) args.push("--ip", ipAddress);
  if (macAddress) args.push("--mac-address", macAddress);
  args.push(image);
  if (command) args.push(...splitCommandArgs(command));

  const id = (await docker(...args)).trim();
  return { ok: true, id };
}

/** Rename a Docker container (works whether running or stopped). 400/404/409 coded. */
async function renameContainer(id: string, newName: string) {
  const cid = validateDockerName(id, "container id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(newName)) {
    throw Object.assign(new Error("Invalid container name"), { code: "INVALID_NAME" });
  }
  // Collision: a different container already using this name?
  const existing = await docker("ps", "-a", "--filter", `name=^/${newName}$`, "--format", "{{.ID}}").catch(() => "");
  const ids = existing.trim().split("\n").filter(Boolean);
  if (ids.some((other) => !cid.startsWith(other) && !other.startsWith(cid.slice(0, 12)))) {
    throw Object.assign(new Error(`A container named '${newName}' already exists`), { code: "EXISTS" });
  }
  try {
    await docker("rename", cid, newName);
  } catch (err) {
    const msg = (err as Error).message;
    if (/already in use|conflict/i.test(msg)) throw Object.assign(new Error(`A container named '${newName}' already exists`), { code: "EXISTS" });
    throw Object.assign(new Error(`docker rename failed: ${msg}`), { code: "RENAME_FAILED" });
  }
  return { ok: true, name: newName };
}

async function deleteContainer(id: string) {
  try { await docker("stop", id); } catch { /* already stopped */ }
  try { await docker("rm", "-f", id); } catch { /* may already be gone */ }
  // CRITICAL: verify removal — `docker inspect` must fail once it is deleted.
  const stillExists = await docker("inspect", id).then(() => true).catch(() => false);
  if (stillExists) {
    throw new Error(`Failed to delete Docker container '${id}': it still exists after docker rm`);
  }
  return { ok: true };
}

async function containerAction(id: string, action: string) {
  switch (action) {
    case "start":
      await ensureContainerNetworksReady(id);
      await docker("start", id);
      break;
    case "stop": await docker("stop", id); break;
    case "restart":
      await ensureContainerNetworksReady(id);
      await docker("restart", id);
      break;
    case "kill": await docker("kill", id); break;
    case "pause": await docker("pause", id); break;
    case "unpause": await docker("unpause", id); break;
    default: throw new Error(`Unknown Docker action: ${action}`);
  }
  return { ok: true };
}

async function getStats(id: string) {
  const out = await docker("stats", "--no-stream", "--format", "{{json .}}", id);
  try {
    const s = JSON.parse(out.trim()) as Record<string, string>;
    const memParts = (s.MemUsage ?? "0B / 0B").split(" / ");
    const netParts = (s.NetIO ?? "0B / 0B").split(" / ");
    const blockParts = (s.BlockIO ?? "0B / 0B").split(" / ");
    const memUsedBytes = parseBytes(memParts[0]);
    const memLimitBytes = parseBytes(memParts[1] ?? "0");
    // Accurate uptime from State.StartedAt (preferred over parsing "Up 3 hours").
    let uptimeSeconds: number | undefined;
    try {
      const startedAt = (await docker("inspect", "-f", "{{.State.StartedAt}}", id)).trim();
      const startedMs = Date.parse(startedAt);
      if (Number.isFinite(startedMs) && startedMs > 0) {
        uptimeSeconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
      }
    } catch { /* best-effort */ }
    return {
      cpuPercent: parseFloat(s.CPUPerc) || 0,
      memUsedBytes,
      memLimitBytes,
      memPercent: memLimitBytes > 0 ? Math.round((memUsedBytes / memLimitBytes) * 100) : 0,
      uptimeSeconds,
      netRxBytes: parseBytes(netParts[0]),
      netTxBytes: parseBytes(netParts[1] ?? "0"),
      blockRdBytes: parseBytes(blockParts[0]),
      blockWrBytes: parseBytes(blockParts[1] ?? "0"),
      pids: parseInt(s.PIDs ?? "0", 10) || 0,
    };
  } catch {
    return { cpuPercent: 0, memUsedBytes: 0, memLimitBytes: 0, memPercent: 0, netRxBytes: 0, netTxBytes: 0, blockRdBytes: 0, blockWrBytes: 0, pids: 0 };
  }
}

async function getLogs(id: string, tail: number) {
  return docker("logs", "--tail", String(tail), "--timestamps", id);
}

function parseInspectPorts(networkSettings: Record<string, unknown>) {
  const ports = networkSettings.Ports as Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined;
  if (!ports) return [];
  const result: Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp"; hostIp?: string }> = [];
  for (const [key, bindings] of Object.entries(ports)) {
    const [containerPort, protocol] = key.split("/");
    for (const binding of bindings ?? []) {
      result.push({
        hostIp: binding.HostIp,
        hostPort: parseInt(binding.HostPort, 10),
        containerPort: parseInt(containerPort, 10),
        protocol: (protocol as "tcp" | "udp") ?? "tcp",
      });
    }
  }
  return result;
}

async function inspectContainer(id: string) {
  const out = await docker("inspect", id);
  const data = JSON.parse(out)[0] as Record<string, unknown>;
  const cfg = data.Config as Record<string, unknown>;
  const hostCfg = data.HostConfig as Record<string, unknown>;
  const netCfg = data.NetworkSettings as Record<string, unknown>;
  const mounts = ((data.Mounts as Array<Record<string, unknown>>) ?? []).map((mount) => ({
    source: String(mount.Source ?? ""),
    destination: String(mount.Destination ?? ""),
    mode: String(mount.Mode ?? "rw"),
    type: (mount.Type as "bind" | "volume" | "tmpfs") ?? "bind",
  }));

  return {
    id: String(data.Id ?? ""),
    name: String(data.Name ?? "").replace(/^\//, ""),
    image: String(cfg.Image ?? ""),
    state: normalizeState(String((data.State as Record<string, unknown>)?.Status ?? "")),
    status: String((data.State as Record<string, unknown>)?.Status ?? ""),
    ports: parseInspectPorts(netCfg),
    createdAt: String(data.Created ?? new Date().toISOString()),
    env: ((cfg.Env as string[]) ?? []),
    mounts,
    networks: Object.keys((netCfg.Networks as Record<string, unknown>) ?? {}),
    privileged: Boolean(hostCfg.Privileged),
    restartPolicy: String((hostCfg.RestartPolicy as Record<string, unknown>)?.Name ?? "no"),
    command: ((cfg.Cmd as string[]) ?? []).join(" "),
    entrypoint: Array.isArray(cfg.Entrypoint) ? (cfg.Entrypoint as string[]).join(" ") : String(cfg.Entrypoint ?? ""),
  };
}

async function updateConfig(p: Record<string, unknown>) {
  const id = p.id as string;
  const args = ["update", id];
  if (p.cpuLimit !== undefined) args.push("--cpus", String(p.cpuLimit));
  if (p.memoryMb !== undefined) args.push("--memory", `${p.memoryMb}m`);
  if (p.restartPolicy !== undefined) args.push(`--restart=${p.restartPolicy}`);
  await docker(...args);
  return { ok: true };
}

// ── Full container editing (recreate) ────────────────────────────────────────
// Docker cannot mutate ports/volumes/env/image/command on a live container, so
// "editing" means: capture the current config, merge the requested changes, then
// stop + remove + re-run the container. Named volumes and bind mounts are
// preserved (we never `rm -v`), so container data survives the recreate.

interface RecreateInput {
  id: string;
  name?: string;
  image?: string;
  command?: string;
  ports?: Array<{ hostPort: number; containerPort: number; protocol: string }>;
  volumes?: Array<{ hostPath: string; containerPath: string; mode: string }>;
  env?: string[];
  network?: string;
  ipAddress?: string;
  macAddress?: string;
  cpuLimit?: number;
  memoryMb?: number;
  restartPolicy?: string;
  privileged?: boolean;
}

async function recreateContainer(p: Record<string, unknown>) {
  const id = validateDockerName(p.id as string, "container id");
  const input = p as unknown as RecreateInput;

  // 1. Capture the current container config so unspecified fields are preserved.
  const current = await inspectContainer(id);

  // 2. Merge: requested value wins, otherwise keep the current one.
  const name = input.name !== undefined ? validateDockerName(input.name) : current.name;
  const image = input.image !== undefined ? validateDockerImage(input.image) : current.image;
  const command = input.command !== undefined ? input.command : current.command;
  const restartPolicy = input.restartPolicy !== undefined
    ? validateRestartPolicy(input.restartPolicy)
    : (current.restartPolicy ?? "unless-stopped");
  const privileged = input.privileged !== undefined ? Boolean(input.privileged) : Boolean(current.privileged);
  const cpuLimit = input.cpuLimit !== undefined ? Number(input.cpuLimit) : undefined;
  const memoryMb = input.memoryMb !== undefined ? Number(input.memoryMb) : undefined;

  // Ports: if provided, replace the whole set; otherwise keep current.
  const ports = input.ports !== undefined
    ? input.ports.map((port) => ({
        hostPort: validatePortNumber(port.hostPort, "hostPort"),
        containerPort: validatePortNumber(port.containerPort, "containerPort"),
        protocol: validateProtocol(port.protocol),
      }))
    : (current.ports ?? []).map((port) => ({
        hostPort: port.hostPort,
        containerPort: port.containerPort,
        protocol: port.protocol,
      }));

  // Volumes: if provided, replace; otherwise keep current bind mounts.
  const volumes = input.volumes !== undefined
    ? input.volumes.map((vol) => ({
        hostPath: validateHostPath(vol.hostPath, "volume hostPath"),
        containerPath: validateContainerPath(vol.containerPath, "volume containerPath"),
        mode: validateVolumeMode(vol.mode),
      }))
    : (current.mounts ?? [])
        .filter((m) => m.type === "bind")
        .map((m) => ({
          hostPath: m.source,
          containerPath: m.destination,
          mode: m.mode ?? "rw",
        }));

  // Env: if provided, replace; otherwise keep current.
  const env = input.env !== undefined
    ? input.env.map((entry) => validateEnvVar(entry))
    : (current.env ?? []);

  // Network: if provided, use it; otherwise keep the first (primary) network.
  const network = input.network !== undefined
    ? (input.network ? validateDockerNetworkName(input.network) : undefined)
    : (current.networks?.[0] ?? undefined);

  const ipAddress = validateIpv4Address(input.ipAddress, "Docker static IP");
  const macAddress = validateMacAddress(input.macAddress);

  if (cpuLimit !== undefined && (cpuLimit < 0 || cpuLimit > 1024)) throw new Error("Invalid cpuLimit: must be 0–1024");
  if (memoryMb !== undefined && (memoryMb < 4 || memoryMb > 1_048_576)) throw new Error("Invalid memoryMb: must be 4–1048576");
  if (ipAddress && (!network || network === "bridge" || network === "host" || network === "none")) {
    throw new Error("Docker static IP requires a user-defined Docker network");
  }

  await ensureDockerNetworkReady(network);
  await ensureImageAvailable(image);

  // 3. Stop + remove the old container (keep volumes: no `-v`).
  await docker("stop", id).catch(() => {});
  await docker("rm", id).catch(() => {});

  // 4. Re-run with the merged config.
  const args = ["run", "-d", "--name", name, `--restart=${restartPolicy}`];
  if (privileged) args.push("--privileged");
  for (const port of ports) args.push("-p", `${port.hostPort}:${port.containerPort}/${port.protocol}`);
  for (const vol of volumes) args.push("-v", `${vol.hostPath}:${vol.containerPath}:${vol.mode}`);
  for (const value of env) args.push("-e", value);
  if (cpuLimit) args.push("--cpus", String(cpuLimit));
  if (memoryMb) args.push("-m", `${memoryMb}m`);
  if (network) args.push("--network", network);
  if (ipAddress) args.push("--ip", ipAddress);
  if (macAddress) args.push("--mac-address", macAddress);
  args.push(image);
  if (command) args.push(...splitCommandArgs(command));

  const newId = (await docker(...args)).trim();
  return { ok: true, id: newId, name };
}

async function pullImage(image: string) {
  const normalized = validateDockerImage(image);
  await docker("pull", "--quiet", normalized);
  return { ok: true };
}

async function buildImage(p: Record<string, unknown>) {
  const tag = validateDockerTag(p.tag);
  const dockerfile = p.dockerfile as string;
  // Use mkdtemp to avoid predictable path + TOCTOU race
  const tmpDir = await fs.mkdtemp("/tmp/auxinux-build-");
  await fs.writeFile(`${tmpDir}/Dockerfile`, dockerfile);
  try {
    await docker("build", "-t", tag, tmpDir);
  } finally {
    await execFileAsync("rm", ["-rf", tmpDir]).catch(() => {});
  }
  return { ok: true };
}

// ── Docker Compose (persistent .yml projects) ────────────────────────────────
// Compose files are stored under a stable directory so they can be edited and
// re-deployed later, instead of being written to a throwaway tmpdir and deleted.

const COMPOSE_DIR = process.env.AUXINUX_COMPOSE_DIR ?? "/var/lib/auxinuxvirtual/compose";

async function ensureComposeDir() {
  await fs.mkdir(COMPOSE_DIR, { recursive: true });
}

function composeProjectPath(name: string): string {
  return `${COMPOSE_DIR}/${name}`;
}

function composeFilePath(name: string): string {
  return `${composeProjectPath(name)}/docker-compose.yml`;
}

async function composeProjectExists(name: string): Promise<boolean> {
  try {
    await fs.access(composeFilePath(name));
    return true;
  } catch {
    return false;
  }
}

/** Write (or overwrite) a project's docker-compose.yml, creating its directory. */
async function composeSave(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  const composeYaml = p.composeYaml as string;
  if (!composeYaml || typeof composeYaml !== "string") throw new Error("composeYaml is required");
  await ensureComposeDir();
  await fs.mkdir(composeProjectPath(name), { recursive: true });
  await fs.writeFile(composeFilePath(name), composeYaml);
  return { ok: true, name, path: composeFilePath(name) };
}

/** Read a project's compose file, or throw if it does not exist. */
async function composeRead(name: string): Promise<string> {
  if (!(await composeProjectExists(name))) {
    throw new Error(`Compose project '${name}' does not exist`);
  }
  return fs.readFile(composeFilePath(name), "utf8");
}

async function composeUp(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  const composeYaml = p.composeYaml as string;
  await ensureDockerDaemonReady();
  // Persist the file first (so `up` and later `down`/`ps` share the same source),
  // then deploy from the stable path.
  if (composeYaml) {
    await composeSave({ name, composeYaml });
  } else if (!(await composeProjectExists(name))) {
    throw new Error(`Compose project '${name}' does not exist and no composeYaml was provided`);
  }
  await execFileAsync("docker", ["compose", "-p", name, "-f", composeFilePath(name), "up", "-d"]);
  return { ok: true, name };
}

async function composeDown(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  await composeRead(name);
  const removeVolumes = Boolean(p.removeVolumes);
  const args = ["compose", "-p", name, "-f", composeFilePath(name), "down"];
  if (removeVolumes) args.push("-v");
  await execFileAsync("docker", args);
  return { ok: true, name };
}

async function composePs(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  await composeRead(name);
  const { stdout } = await execFileAsync("docker", ["compose", "-p", name, "-f", composeFilePath(name), "ps", "--format", "{{json .}}"], { maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, string>;
      return {
        name: entry.Name ?? "",
        service: entry.Service ?? "",
        state: normalizeState(entry.State ?? ""),
        status: entry.Status ?? "",
        ports: entry.Ports ?? "",
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function composeLogs(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  await composeRead(name);
  const tail = Number(p.tail ?? 100);
  const args = ["compose", "-p", name, "-f", composeFilePath(name), "logs", "--tail", String(tail), "--timestamps"];
  if (p.service) args.push(String(p.service));
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function composeConfig(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  await composeRead(name);
  const { stdout } = await execFileAsync("docker", ["compose", "-p", name, "-f", composeFilePath(name), "config"], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function composeRestart(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  await composeRead(name);
  const args = ["compose", "-p", name, "-f", composeFilePath(name), "restart"];
  if (p.service) args.push(String(p.service));
  await execFileAsync("docker", args);
  return { ok: true, name };
}

/** List all persisted compose projects with their file path and last-modified time. */
async function composeList() {
  await ensureComposeDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(COMPOSE_DIR);
  } catch {
    return [];
  }
  const projects: Array<{ name: string; path: string; modifiedAt: string }> = [];
  for (const entry of entries) {
    const filePath = composeFilePath(entry);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        projects.push({ name: entry, path: filePath, modifiedAt: stat.mtime.toISOString() });
      }
    } catch { /* not a project dir */ }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function composeDelete(p: Record<string, unknown>) {
  const name = validateComposeProject(p.name);
  await ensureDockerDaemonReady();
  if (await composeProjectExists(name)) {
    // Bring the stack down first (best-effort), then remove the persisted file.
    await execFileAsync("docker", ["compose", "-p", name, "-f", composeFilePath(name), "down"]).catch(() => {});
    await fs.rm(composeProjectPath(name), { recursive: true, force: true });
  }
  return { ok: true, name };
}

// ── Docker volumes ────────────────────────────────────────────────────────────
async function listVolumes() {
  const out = await docker("volume", "ls", "--format", "{{json .}}");
  return out.trim().split("\n").filter(Boolean).map((line) => {
    try {
      const v = JSON.parse(line) as Record<string, string>;
      return { name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function createVolume(p: Record<string, unknown>) {
  const name = validateDockerName(p.name as string, "volume name");
  const driver = typeof p.driver === "string" && p.driver ? p.driver : "local";
  const args = ["volume", "create", "--driver", driver];
  if (p.label) args.push("--label", String(p.label));
  args.push(name);
  const id = (await docker(...args)).trim();
  return { ok: true, name: id };
}

async function deleteVolume(name: string) {
  await docker("volume", "rm", name);
  return { ok: true };
}

// ── docker exec ────────────────────────────────────────────────────────────────
async function execInContainer(p: Record<string, unknown>) {
  const id = validateDockerName(p.id as string, "container id");
  const command = p.command as string;
  if (!command || typeof command !== "string") throw new Error("command is required");
  const args = ["exec", id, ...splitCommandArgs(command)];
  const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
  return { stdout, stderr };
}

// ── prune ─────────────────────────────────────────────────────────────────────
async function prune(p: Record<string, unknown>) {
  const target = typeof p.target === "string" ? p.target : "all";
  const results: Record<string, string> = {};
  const run = async (label: string, args: string[]) => {
    const { stdout } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
    results[label] = stdout.trim();
  };
  if (target === "all" || target === "containers") await run("containers", ["container", "prune", "-f"]);
  if (target === "all" || target === "images") await run("images", ["image", "prune", "-f"]);
  if (target === "all" || target === "volumes") await run("volumes", ["volume", "prune", "-f"]);
  if (target === "all" || target === "networks") await run("networks", ["network", "prune", "-f"]);
  return { ok: true, results };
}

async function listImages() {
  const out = await docker("images", "--format", "{{json .}}");
  return out.trim().split("\n").filter(Boolean).map((line) => {
    try {
      const img = JSON.parse(line) as Record<string, string>;
      return {
        id: img.ID,
        repoTags: [`${img.Repository ?? ""}:${img.Tag ?? "latest"}`],
        size: parseBytes(img.Size ?? "0"),
        created: Date.now(),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function deleteImage(id: string) {
  await docker("rmi", "-f", id);
  return { ok: true };
}

async function searchHub(query: string, limit: number) {
  // Try Docker Hub API v2 first — richer data (description, pull count)
  try {
    const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(query)}&page_size=${Math.min(limit, 100)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) {
      const data = await resp.json() as { results?: Array<Record<string, unknown>> };
      const results = (data.results ?? []).map((r) => ({
        name: String(r.repo_name ?? ""),
        description: String(r.short_description ?? ""),
        stars: Number(r.star_count ?? 0),
        pulls: Number(r.pull_count ?? 0),
        isOfficial: Boolean(r.is_official),
        isAutomated: Boolean(r.is_automated),
      })).filter((r) => r.name);
      if (results.length > 0) return results;
    }
  } catch { /* fallback to docker CLI */ }

  // Fallback: docker search CLI
  const out = await docker("search", "--limit", String(Math.min(limit, 100)), "--format", "{{json .}}", query);
  return out.trim().split("\n").filter(Boolean).map((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, string | number>;
      return {
        name: String(entry.Name ?? ""),
        description: String(entry.Description ?? ""),
        stars: Number(entry.StarCount ?? entry.Stars ?? 0),
        pulls: 0,
        isOfficial: String(entry.IsOfficial ?? entry.Official ?? "").toLowerCase() === "ok",
        isAutomated: String(entry.IsAutomated ?? entry.Automated ?? "").toLowerCase() === "ok",
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function fetchHubDetail(imageName: string): Promise<{ exposedPorts: string[]; fullDescription?: string }> {
  // Normalize: official images are under library/
  const parts = imageName.split("/");
  const ns = parts.length === 1 ? "library" : parts[0];
  const repoName = parts.length === 1 ? imageName : parts.slice(1).join("/");
  const repo = `${ns}/${repoName}`;

  const exposedPorts: string[] = [];
  let fullDescription: string | undefined;

  // Fetch full description from Docker Hub API
  try {
    const hubResp = await fetch(`https://hub.docker.com/v2/repositories/${repo}/`, { signal: AbortSignal.timeout(8_000) });
    if (hubResp.ok) {
      const hubData = await hubResp.json() as Record<string, unknown>;
      const desc = String(hubData.full_description ?? "").trim();
      if (desc) fullDescription = desc.substring(0, 3000);
    }
  } catch { /* ignore */ }

  // Fetch exposed ports from Docker Registry API v2 (no pull required)
  try {
    // Get anonymous pull token
    const tokenResp = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!tokenResp.ok) return { fullDescription, exposedPorts };
    const { token } = await tokenResp.json() as { token: string };

    // Fetch manifest (may be a manifest list for multi-arch)
    const manifestResp = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
        ].join(","),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!manifestResp.ok) return { fullDescription, exposedPorts };

    const manifest = await manifestResp.json() as {
      config?: { digest?: string };
      manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>;
    };

    let configDigest = manifest.config?.digest;

    // Multi-arch manifest list: pick amd64 linux first, then arm64, then any linux
    if (!configDigest && manifest.manifests) {
      const pick =
        manifest.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") ??
        manifest.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "arm64") ??
        manifest.manifests.find((m) => m.platform?.os === "linux") ??
        manifest.manifests[0];
      if (pick?.digest) {
        const platformResp = await fetch(
          `https://registry-1.docker.io/v2/${repo}/manifests/${pick.digest}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: [
                "application/vnd.docker.distribution.manifest.v2+json",
                "application/vnd.oci.image.manifest.v1+json",
              ].join(","),
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (platformResp.ok) {
          const pm = await platformResp.json() as { config?: { digest?: string } };
          configDigest = pm.config?.digest;
        }
      }
    }

    if (!configDigest) return { fullDescription, exposedPorts };

    // Fetch config blob — contains ExposedPorts
    const configResp = await fetch(
      `https://registry-1.docker.io/v2/${repo}/blobs/${configDigest}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!configResp.ok) return { fullDescription, exposedPorts };

    const config = await configResp.json() as { config?: { ExposedPorts?: Record<string, unknown> } };
    const ports = config.config?.ExposedPorts;
    if (ports) exposedPorts.push(...Object.keys(ports).sort());
  } catch { /* ignore */ }

  return { fullDescription, exposedPorts };
}

async function listNetworks() {
  await ensureDockerDaemonReady();
  const out = await docker("network", "ls", "--format", "{{json .}}");
  const networks = out.trim().split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as Record<string, string>;
    } catch {
      return null;
    }
  }).filter(Boolean) as Record<string, string>[];

  return Promise.all(networks.map(async (network) => {
    try {
      const inspect = JSON.parse(await docker("network", "inspect", network.ID))[0] as Record<string, unknown>;
      const ipam = (((inspect.IPAM as Record<string, unknown>)?.Config as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const options = (inspect.Options as Record<string, string> | undefined) ?? {};
      const containers = Object.values((inspect.Containers as Record<string, { Name?: string }>) ?? {}).map((entry) => entry.Name ?? "").filter(Boolean);
      return {
        id: network.ID,
        name: network.Name,
        driver: network.Driver,
        subnet: ipam.Subnet as string | undefined,
        gateway: ipam.Gateway as string | undefined,
        ipRange: ipam.IPRange as string | undefined,
        parent: options.parent,
        containers,
      };
    } catch {
      return { id: network.ID, name: network.Name, driver: network.Driver };
    }
  }));
}

async function createNetwork(p: Record<string, unknown>) {
  const name = validateDockerNetworkName(p.name);
  const driver = validateNetworkDriver(p.driver);
  const subnet = validateSubnet(p.subnet as string | undefined);
  const gateway = validateIpv4Address(p.gateway, "Docker network gateway");
  const ipRange = validateSubnet(p.ipRange as string | undefined);
  const parent = validateParentInterface(p.parent);
  if ((driver === "macvlan" || driver === "ipvlan") && !parent) {
    throw new Error(`${driver} Docker networks require a parent interface or bridge`);
  }
  await ensureDockerDaemonReady();
  const args = ["network", "create", "--driver", driver];
  if (subnet) args.push("--subnet", subnet);
  if (gateway) args.push("--gateway", gateway);
  if (ipRange) args.push("--ip-range", ipRange);
  if (parent) args.push("-o", `parent=${parent}`);
  args.push(name);
  const id = (await docker(...args)).trim();
  return { ok: true, id };
}

async function deleteNetwork(id: string) {
  await docker("network", "rm", id);
  return { ok: true };
}

// ── Per-container network attachments (multi-NIC) ───────────────────────────
async function listContainerNetworks(id: string) {
  const cid = validateDockerName(id, "container id");
  const out = await docker("inspect", cid);
  const data = JSON.parse(out)[0] as Record<string, unknown>;
  const netSettings = (data.NetworkSettings as Record<string, unknown>) ?? {};
  const networks = (netSettings.Networks as Record<string, Record<string, unknown>>) ?? {};
  const entries = Object.entries(networks);
  return entries.map(([networkName, info], idx) => ({
    network: networkName,
    primary: idx === 0,                     // first attachment = primary (protected)
    ipAddress: (info.IPAddress as string) || undefined,
    ipPrefixLen: (info.IPPrefixLen as number) || undefined,
    gateway: (info.Gateway as string) || undefined,
    macAddress: (info.MacAddress as string) || undefined,
    aliases: (info.Aliases as string[] | null) ?? [],
    networkId: (info.NetworkID as string) || undefined,
  }));
}

async function connectContainerNetwork(p: Record<string, unknown>) {
  const cid = validateDockerName(p.id, "container id");
  const network = validateDockerNetworkName(p.network);
  const args = ["network", "connect"];
  const ip = (p.ipv4 as string | undefined)?.trim();
  if (ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Invalid IPv4 address");
    args.push("--ip", ip);
  }
  const mac = validateMacAddress(p.macAddress);
  if (mac) args.push("--mac-address", mac);
  args.push(network, cid);
  await docker(...args);
  return { ok: true };
}

async function disconnectContainerNetwork(id: string, network: string) {
  const cid = validateDockerName(id, "container id");
  const net = validateDockerNetworkName(network);
  // Never leave a container with zero networks (protect the last/primary one).
  const current = await listContainerNetworks(cid);
  if (current.length <= 1) throw new Error("Cannot disconnect the only remaining network of a container");
  if (current[0]?.network === net) throw new Error("The primary network cannot be disconnected");
  await docker("network", "disconnect", net, cid);
  return { ok: true };
}
