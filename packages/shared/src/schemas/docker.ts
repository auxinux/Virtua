import { z } from "zod";

const dockerNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const dockerImageRegex = /^[a-zA-Z0-9]([a-zA-Z0-9./_:@-]{0,255})$/;
const dockerNetworkRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const dockerInterfaceRegex = /^[a-zA-Z0-9._:-]{1,64}$/;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\/(?:[0-9]|[12]\d|3[0-2])$/;
const macRegex = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export const RunDockerSchema = z.object({
  name: z.string().regex(dockerNameRegex),
  image: z.string().regex(dockerImageRegex),
  storagePool: z.string().optional(),
  ports: z.array(z.object({
    hostPort: z.number().int().min(1).max(65535),
    containerPort: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).default("tcp"),
  })).optional(),
  volumes: z.array(z.object({
    hostPath: z.string().min(1),
    containerPath: z.string().min(1),
    mode: z.enum(["ro", "rw"]).default("rw"),
  })).optional(),
  env: z.array(z.string()).optional(),
  cpuLimit: z.number().optional(),
  memoryMb: z.number().int().optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  command: z.string().optional(),
  network: z.string().regex(dockerNetworkRegex).optional(),
  ipAddress: z.string().regex(ipv4Regex).optional(),
  macAddress: z.string().regex(macRegex).optional(),
  privileged: z.boolean().default(false),
});

export const CreateDockerNetworkSchema = z.object({
  name: z.string().regex(dockerNetworkRegex),
  driver: z.enum(["bridge", "host", "overlay", "macvlan", "ipvlan", "none"]).default("bridge"),
  parent: z.string().regex(dockerInterfaceRegex).optional(),
  subnet: z.string().regex(ipv4CidrRegex).optional(),
  gateway: z.string().regex(ipv4Regex).optional(),
  ipRange: z.string().regex(ipv4CidrRegex).optional(),
});

export const UpdateDockerConfigSchema = z.object({
  cpuLimit: z.number().optional(),
  memoryMb: z.number().int().optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).optional(),
});

// Full container edit: any subset of fields may be provided; omitted fields are
// preserved from the current container (the runner merges against `docker inspect`).
export const RecreateDockerSchema = z.object({
  name: z.string().regex(dockerNameRegex).optional(),
  image: z.string().regex(dockerImageRegex).optional(),
  command: z.string().optional(),
  ports: z.array(z.object({
    hostPort: z.number().int().min(1).max(65535),
    containerPort: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).default("tcp"),
  })).optional(),
  volumes: z.array(z.object({
    hostPath: z.string().min(1),
    containerPath: z.string().min(1),
    mode: z.enum(["ro", "rw"]).default("rw"),
  })).optional(),
  env: z.array(z.string()).optional(),
  network: z.string().regex(dockerNetworkRegex).optional(),
  ipAddress: z.string().regex(ipv4Regex).optional(),
  macAddress: z.string().regex(macRegex).optional(),
  cpuLimit: z.number().optional(),
  memoryMb: z.number().int().optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).optional(),
  privileged: z.boolean().optional(),
});

// Attach a container to an additional network (multi-NIC).
export const DockerConnectNetworkSchema = z.object({
  network: z.string().regex(dockerNetworkRegex),
  ipv4: z.string().regex(ipv4Regex).optional(),
  macAddress: z.string().regex(macRegex).optional(),
});
export type DockerConnectNetworkInput = z.infer<typeof DockerConnectNetworkSchema>;

export const ComposeDeploySchema = z.object({
  name: z.string().min(1),
  composeYaml: z.string().min(1),
  storagePool: z.string().optional(),
});

// Compose project management. `composeYaml` is required for save/up; optional
// for down/ps/logs/config/restart (which operate on the persisted file).
export const ComposeProjectSchema = z.object({
  name: z.string().min(1),
  composeYaml: z.string().optional(),
  service: z.string().optional(),
  tail: z.number().int().min(1).max(10000).optional(),
  removeVolumes: z.boolean().optional(),
});

export const DockerVolumeCreateSchema = z.object({
  name: z.string().regex(dockerNameRegex),
  driver: z.string().optional(),
  label: z.string().optional(),
});

export const DockerExecSchema = z.object({
  command: z.string().min(1),
});

export const DockerPruneSchema = z.object({
  target: z.enum(["all", "containers", "images", "volumes", "networks"]).default("all"),
});

export type RunDockerInput = z.infer<typeof RunDockerSchema>;
export type CreateDockerNetworkInput = z.infer<typeof CreateDockerNetworkSchema>;
export type UpdateDockerConfigInput = z.infer<typeof UpdateDockerConfigSchema>;
export type RecreateDockerInput = z.infer<typeof RecreateDockerSchema>;
export type ComposeDeployInput = z.infer<typeof ComposeDeploySchema>;
export type ComposeProjectInput = z.infer<typeof ComposeProjectSchema>;
