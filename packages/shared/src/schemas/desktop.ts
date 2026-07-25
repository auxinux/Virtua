import { z } from "zod";

// =============================================================================
//  Desktop Client API — request/response schemas (shared, browser-safe)
//  Used by the Virtua Desktop client and validated server-side. NEVER trust the
//  client for resourceId/nodeId — the server resolves opaque UUID handles to the
//  real resource and re-checks permissions on every call.
// =============================================================================

export const DESKTOP_DEVICE_NAME_MAX = 64;

// ── Auth ─────────────────────────────────────────────────────────────────────
// Stable identifier the desktop app persists across restarts so the same
// installation is recognised as one device (no new authorization per launch).
export const DESKTOP_INSTALLATION_ID_MAX = 128;
const desktopInstallationId = z.string().min(1).max(DESKTOP_INSTALLATION_ID_MAX).regex(/^[A-Za-z0-9._:-]+$/, "Invalid installation id");

export const DesktopLoginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  deviceName: z.string().min(1).max(DESKTOP_DEVICE_NAME_MAX),
  // Stable per-installation id. Optional for backward compat with older clients.
  installationId: desktopInstallationId.optional(),
  // Optional client-generated public key fingerprint for device-cert binding.
  deviceFingerprint: z.string().max(256).optional(),
});
export type DesktopLoginInput = z.infer<typeof DesktopLoginSchema>;

export const DesktopPairSchema = z.object({
  // Short pairing code generated from the web panel.
  pairingCode: z.string().min(6).max(32),
  deviceName: z.string().min(1).max(DESKTOP_DEVICE_NAME_MAX),
  installationId: desktopInstallationId.optional(),
  deviceFingerprint: z.string().max(256).optional(),
});
export type DesktopPairInput = z.infer<typeof DesktopPairSchema>;

export const DesktopRefreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
  installationId: desktopInstallationId.optional(),
});
export type DesktopRefreshInput = z.infer<typeof DesktopRefreshSchema>;

export const DesktopLogoutSchema = z.object({
  refreshToken: z.string().min(20).max(512),
  installationId: desktopInstallationId.optional(),
});
export type DesktopLogoutInput = z.infer<typeof DesktopLogoutSchema>;

// ── Actions ──────────────────────────────────────────────────────────────────
export const DESKTOP_ACTIONS = ["start", "stop", "restart", "snapshot"] as const;
export type DesktopAction = (typeof DESKTOP_ACTIONS)[number];

export const DesktopSnapshotSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Invalid snapshot name"),
  description: z.string().max(512).optional(),
});
export type DesktopSnapshotInput = z.infer<typeof DesktopSnapshotSchema>;

// Opaque resource handle = UUID. Validated to a strict UUID shape so a caller
// can never inject a name/path here.
export const DesktopResourceIdSchema = z
  .string()
  .uuid("resource id must be an opaque UUID handle");

// ── Resource lifecycle (create / update) ──────────────────────────────────────
export const DESKTOP_RESOURCE_TYPES = ["vm", "lxc", "docker"] as const;

// Names: must start with a letter, alnum + - _ (same policy as VM/LXC). For
// docker the server tolerates the registry/container-name rules separately.
const desktopNameRegex = /^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/;

export const DESKTOP_RESTART_POLICIES = ["no", "unless-stopped", "always", "on-failure"] as const;

// Port mappings as a compact string the desktop sends, e.g. "8080:80,443:443/udp".
// Validated loosely here; parsed/strictly validated server-side.
const desktopPortsRegex = /^(\s*\d{1,5}\s*:\s*\d{1,5}(\s*\/\s*(tcp|udp))?\s*)(,\s*\d{1,5}\s*:\s*\d{1,5}(\s*\/\s*(tcp|udp))?\s*)*$/i;

export const DesktopCreateResourceSchema = z.object({
  type: z.enum(DESKTOP_RESOURCE_TYPES),
  name: z.string().regex(desktopNameRegex, "Invalid resource name"),
  node: z.string().min(1).max(128).optional(),
  /** VM: ISO file name • LXC: "<dist>/<release>" or "<dist>:<release>" • Docker: image ref */
  image: z.string().min(1).max(256).optional(),
  /** network handle/name (VM/LXC: bridge • Docker: network name) */
  network: z.string().min(1).max(128).optional(),
  /** vCPU cores */
  cpu: z.number().int().min(1).max(256).optional(),
  /** memory in MB */
  memory: z.number().int().min(64).max(2097152).optional(),
  /** disk in GB */
  disk: z.number().int().min(1).max(65536).optional(),

  // VM-specific
  tpm2: z.boolean().optional(),
  secureBoot: z.boolean().optional(),
  qemuGuestAgent: z.boolean().optional(),
  autostart: z.boolean().optional(),

  // LXC-specific
  privileged: z.boolean().optional(),
  nesting: z.boolean().optional(),

  // Docker-specific
  restartPolicy: z.enum(DESKTOP_RESTART_POLICIES).optional(),
  ports: z.string().max(512).regex(desktopPortsRegex, "Ports must look like \"8080:80,443:443/udp\"").optional(),
});
export type DesktopCreateResourceInput = z.infer<typeof DesktopCreateResourceSchema>;

export const DesktopUpdateResourceSchema = z.object({
  name: z.string().regex(desktopNameRegex).optional(),
  displayName: z.string().max(128).optional(),
  image: z.string().min(1).max(256).optional(),
  network: z.string().min(1).max(128).optional(),
  cpu: z.number().int().min(1).max(256).optional(),
  memory: z.number().int().min(64).max(2097152).optional(),
  disk: z.number().int().min(1).max(65536).optional(),

  tpm2: z.boolean().optional(),
  secureBoot: z.boolean().optional(),
  qemuGuestAgent: z.boolean().optional(),
  autostart: z.boolean().optional(),

  privileged: z.boolean().optional(),
  nesting: z.boolean().optional(),

  restartPolicy: z.enum(DESKTOP_RESTART_POLICIES).optional(),
  ports: z.string().max(512).regex(desktopPortsRegex).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: "At least one field must be provided",
});
export type DesktopUpdateResourceInput = z.infer<typeof DesktopUpdateResourceSchema>;

// ── Create options (catalog for the desktop's "new resource" form) ─────────────
export interface DesktopCreateOptionItem {
  id: string;
  name: string;
  label?: string;
  type?: string;
  node?: string;
}
export interface DesktopCreateOptions {
  nodes: DesktopCreateOptionItem[];
  images: DesktopCreateOptionItem[];
  networks: DesktopCreateOptionItem[];
  defaults: {
    cpu?: number;
    memory?: number;
    disk?: number;
    network?: string;
  };
}

// ── Response payloads (types only) ────────────────────────────────────────────
export interface DesktopTokenResponse {
  accessToken: string;
  /** seconds until the access token expires */
  expiresIn: number;
  refreshToken: string;
  /** seconds until the refresh token expires */
  refreshExpiresIn: number;
  device: DesktopDeviceInfo;
}

export interface DesktopDeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export type DesktopResourceType = "vm" | "lxc" | "docker";

export type DesktopGuestAgentStatus = "running" | "stopped" | "not-installed" | "unknown";

export interface DesktopGuestAgent {
  /** the agent channel is provisioned on the VM (and presumed present in-guest) */
  installed: boolean;
  /** the in-guest agent actually answered a live ping */
  running: boolean;
  status: DesktopGuestAgentStatus;
}

export interface DesktopResourcePermissions {
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canSnapshot: boolean;
  canModify: boolean;
  canDelete: boolean;
  /** create is a per-user/per-type capability, surfaced on each visible resource for convenience */
  canCreate: boolean;
}

export interface DesktopMeResponse {
  user: { id: number; username: string; displayName: string | null; role: "ADMIN" | "USER" };
  device: DesktopDeviceInfo;
  capabilities: {
    isAdmin: boolean;
    /** whether this user may create each resource type (quota + policy aware) */
    canCreate: { vm: boolean; lxc: boolean; docker: boolean };
  };
}

export interface DesktopResource {
  /** opaque, non-guessable UUID handle (NOT the real name) */
  id: string;
  type: DesktopResourceType;
  /** canonical key (vm/lxc: name; docker: container id) — used server-side for RBAC */
  name: string;
  /** human-friendly label for display (e.g. docker container name) */
  displayName?: string;
  state: string;
  node: string;

  /** live metrics (0–100) when the resource is running and reachable */
  cpuPercent?: number;
  memoryPercent?: number;
  ipAddress?: string;
  ipAddresses?: string[];
  uptimeSeconds?: number;
  uptime?: string;
  /** docker image / VM ISO / LXC template, when applicable */
  image?: string;

  /** owning username, if known */
  owner?: string;
  /** usernames with an explicit ACL grant on this resource */
  assignedUsers?: string[];

  /** VM qemu-guest-agent state (VMs only; recomputed live each call) */
  guestAgent?: DesktopGuestAgent;
  qemuGuestAgentEnabled?: boolean;
  qemuGuestAgentRunning?: boolean;
  qemuGuestAgentStatus?: DesktopGuestAgentStatus;

  permissions: DesktopResourcePermissions;
}

export interface DesktopTaskInfo {
  id: string;
  label: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  /** 0–100 */
  progress: number;
  createdAt: string;
}

export interface DesktopConsoleTicketResponse {
  ticket: string;
  /** Full wss:// URL the client connects to (one-time, short-lived). */
  url: string;
  /** ms until the ticket expires */
  expiresInMs: number;
  kind: "text" | "graphical" | "spice";
}
