// =============================================================================
//  Virtua Desktop API for the VDM  (/api/desktop/*)
//
//  The Desktop Client speaks one protocol. A Virtua node serves it from
//  apps/api; this module serves the SAME contract from the Datacenter Manager,
//  so pointing the client at a VDM gives it every node the manager knows about
//  instead of a single host.
//
//  Differences from the node implementation, all deliberate:
//   - Identity comes from `vdm_users` (argon2), and the VDM has no per-resource
//     ACL: an `admin` may do everything, a `viewer` may look and open consoles.
//     The desktop therefore never grants more than the VDM web panel does.
//   - Resources are aggregated from every enabled node through the node client.
//   - Console tickets wrap the node's ticket in a VDM ticket, exactly like the
//     web console, and the client connects to /api/vdm/ws/console.
//
//  Security properties kept identical to the node API: argon2 password
//  verification, short-lived HMAC access tokens, rotating refresh tokens hashed
//  at rest, instant device revocation, opaque resource handles, one-time
//  console tickets, rate limits on the credential endpoints.
// =============================================================================
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import * as argon2 from "argon2";
import { randomBytes, randomUUID } from "crypto";
import {
  DESKTOP_RESOURCE_TYPES,
  DesktopCreateResourceSchema,
  DesktopLoginSchema,
  DesktopLogoutSchema,
  DesktopPairSchema,
  DesktopRefreshSchema,
  DesktopResourceIdSchema,
  DesktopSnapshotSchema,
  DesktopUpdateResourceSchema,
  type DesktopCreateOptions,
  type DesktopResourcePermissions,
  type DesktopResourceType,
  type DesktopTaskInfo,
} from "@auxinux/shared";
import {
  generatePairingCode,
  generateRefreshToken,
  hashRefreshToken,
  hashRefreshToken as sha256,
  signAccessToken,
  verifyAccessToken,
} from "@auxinux/shared/dist/desktop/token.js";
import { NodeRequestError, type VdmNodeRow } from "./nodeClient.js";

type Role = "ADMIN" | "USER";

export interface VdmDesktopDeps {
  app: FastifyInstance;
  db: Database.Database;
  getClientIp: (req: FastifyRequest) => string;
  /** Every enabled node, in a stable order. */
  enabledNodes: () => VdmNodeRow[];
  /** Throws 404/400 like the web routes do. */
  getEnabledNode: (name: string) => VdmNodeRow;
  fetchNode: <T>(node: VdmNodeRow, pathname: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  tryFetchNode: <T>(node: VdmNodeRow, pathname: string, fallback: T) => Promise<T>;
  /** Wraps a node console ticket in a one-time VDM ticket. */
  relayConsoleTicket: (node: VdmNodeRow, internalPath: string, kind: "term" | "vnc" | "spice")
    => Promise<{ ticket: string; kind: "term" | "vnc" | "spice"; password?: string }>;
  /** Browser session behind the VDM panel, for minting pairing codes. */
  getWebSessionUser: (req: FastifyRequest) => { userId: number; role: Role; username: string } | null;
  /** Persisted VDM setting accessors (used for the token signing secret). */
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  /** VDM operational log, so desktop activity is visible on the LOGS page. */
  log: (level: "info" | "warn" | "error", message: string) => void;
}

const ACCESS_TTL_SEC = Math.max(60, Number.parseInt(process.env.AUXINUX_DESKTOP_ACCESS_TTL ?? "900", 10) || 900);
const REFRESH_TTL_DAYS = Math.max(1, Number.parseInt(process.env.AUXINUX_DESKTOP_REFRESH_TTL_DAYS ?? "14", 10) || 14);
const DEVICE_IDLE_DAYS = Math.max(1, Number.parseInt(process.env.AUXINUX_DESKTOP_DEVICE_IDLE_DAYS ?? "14", 10) || 14);
const PAIRING_TTL_MS = Math.max(60_000, Number.parseInt(process.env.AUXINUX_DESKTOP_PAIRING_TTL_MS ?? "600000", 10) || 600_000);
const TOKEN_SECRET_KEY = "desktop.tokenSecret";

interface VdmUserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  display_name: string | null;
  must_change_password: number;
}
interface DeviceRow {
  id: string;
  user_id: number;
  name: string;
  installation_id: string | null;
  revoked: number;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string | null;
}
interface RefreshRow { id: string; device_id: string; expires_at: string; revoked: number }
interface AuthContext { userId: number; role: Role; username: string; displayName: string | null; deviceId: string }

interface ResourceRow {
  type: DesktopResourceType;
  node: string;
  /** VM/LXC: name. Docker: container id (its stable key). */
  name: string;
  displayName?: string;
  state: string;
  cpuPercent?: number;
  memoryPercent?: number;
  cpuCores?: number;
  memoryMib?: number;
  diskGib?: number;
  ipAddress?: string;
  ipAddresses?: string[];
  uptimeSeconds?: number;
  image?: string;
  qemuGuestAgentEnabled?: boolean;
  qemuGuestAgentRunning?: boolean;
  qemuGuestAgentStatus?: "running" | "stopped" | "not-installed" | "unknown";
}

/** The VDM role model: `admin` does everything, everyone else looks. */
export function vdmRoleToDesktopRole(role: string): Role {
  return role === "admin" ? "ADMIN" : "USER";
}

/**
 * The VDM has no per-resource ACL, so the desktop mirrors the web panel: an
 * admin may act, a viewer may view and open a console (`requireAuth` is all
 * the web console-ticket routes ask for).
 */
export function permissionsForRole(role: Role): DesktopResourcePermissions {
  const admin = role === "ADMIN";
  return {
    canView: true,
    canConsole: true,
    canPower: admin,
    canSnapshot: admin,
    canModify: admin,
    canDelete: admin,
    canCreate: admin,
  };
}

export function formatUptime(seconds?: number): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** VDM task states → the four the Desktop Client knows. */
export function taskStatusForDesktop(status: string): DesktopTaskInfo["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "recovery-required") return "failed";
  if (status === "running") return "running";
  return "queued";
}

/** Docker's `status` string ("Up 3 hours") is the only uptime a list gives us. */
export function parseDockerUptimeSeconds(status?: string): number | undefined {
  if (!status) return undefined;
  const match = /^Up\s+(?:About\s+)?(\d+)\s+(second|minute|hour|day|week|month)s?/i.exec(status.trim());
  if (!match) return undefined;
  const unit = match[2].toLowerCase();
  const scale: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000 };
  return Number(match[1]) * (scale[unit] ?? 0) || undefined;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status, desktopError: true });
}

export function registerVdmDesktopApi(deps: VdmDesktopDeps): void {
  const { app, db } = deps;

  const DEVICE_COLS = "id, user_id, name, installation_id, revoked, revoked_at, created_at, last_seen_at";
  const USER_COLS = "id, username, password_hash, role, display_name, must_change_password";
  const getUserById = db.prepare(`SELECT ${USER_COLS} FROM vdm_users WHERE id = ?`);
  const getUserByName = db.prepare(`SELECT ${USER_COLS} FROM vdm_users WHERE username = ?`);
  const getDevice = db.prepare(`SELECT ${DEVICE_COLS} FROM vdm_desktop_devices WHERE id = ?`);
  const getDeviceByInstallation = db.prepare(`SELECT ${DEVICE_COLS} FROM vdm_desktop_devices WHERE user_id = ? AND installation_id = ?`);
  const touchDevice = db.prepare("UPDATE vdm_desktop_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?");

  /** Signing secret for access tokens, generated once and persisted. */
  function tokenSecret(): string {
    const existing = deps.getSetting(TOKEN_SECRET_KEY);
    if (existing && existing.length >= 32) return existing;
    const secret = randomBytes(32).toString("hex");
    deps.setSetting(TOKEN_SECRET_KEY, secret);
    return secret;
  }

  function revokeDevice(deviceId: string): void {
    db.prepare("UPDATE vdm_desktop_devices SET revoked = 1, revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(deviceId);
    db.prepare("UPDATE vdm_desktop_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(deviceId);
  }

  function isDeviceExpired(device: DeviceRow): boolean {
    if (device.revoked) return true;
    if (!device.last_seen_at) return false;
    const lastSeen = Date.parse(`${device.last_seen_at.replace(" ", "T")}Z`);
    if (!Number.isFinite(lastSeen)) return false;
    return Date.now() - lastSeen > DEVICE_IDLE_DAYS * 86_400_000;
  }

  /**
   * One device per installation: a re-login from the same install reuses (and
   * reactivates) its authorization instead of piling up duplicate entries.
   */
  function resolveDeviceForAuth(userId: number, installationId: string | undefined, name: string, fingerprint: string | undefined, ip: string): { deviceId: string; created: boolean } {
    if (installationId) {
      const existing = getDeviceByInstallation.get(userId, installationId) as DeviceRow | undefined;
      if (existing) {
        const wasInactive = !!existing.revoked || isDeviceExpired(existing);
        db.prepare("UPDATE vdm_desktop_devices SET name = ?, fingerprint = COALESCE(?, fingerprint), revoked = 0, revoked_at = NULL, last_seen_at = datetime('now'), last_ip = ? WHERE id = ?")
          .run(name, fingerprint ?? null, ip, existing.id);
        if (wasInactive) db.prepare("UPDATE vdm_desktop_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(existing.id);
        return { deviceId: existing.id, created: wasInactive };
      }
    }
    const deviceId = randomUUID();
    db.prepare("INSERT INTO vdm_desktop_devices (id, user_id, name, installation_id, fingerprint, last_ip) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deviceId, userId, name, installationId ?? null, fingerprint ?? null, ip);
    return { deviceId, created: true };
  }

  function issueTokensForDevice(deviceId: string, user: VdmUserRow, ip: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const role = vdmRoleToDesktopRole(user.role);
    const accessToken = signAccessToken(
      { v: 1, did: deviceId, uid: user.id, role, iat: nowSec, exp: nowSec + ACCESS_TTL_SEC },
      tokenSecret(),
    );
    const refreshRaw = generateRefreshToken();
    db.prepare("INSERT INTO vdm_desktop_refresh_tokens (id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), deviceId, hashRefreshToken(refreshRaw), new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000).toISOString());
    touchDevice.run(ip, deviceId);
    const device = getDevice.get(deviceId) as DeviceRow;
    return {
      accessToken,
      expiresIn: ACCESS_TTL_SEC,
      refreshToken: refreshRaw,
      refreshExpiresIn: REFRESH_TTL_DAYS * 86_400,
      device: { id: device.id, name: device.name, createdAt: device.created_at, lastSeenAt: device.last_seen_at },
    };
  }

  function authDesktop(req: FastifyRequest): AuthContext {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match) fail(401, "Missing bearer token");
    const payload = verifyAccessToken(match[1].trim(), tokenSecret());
    if (!payload) fail(401, "Invalid or expired token");
    const device = getDevice.get(payload.did) as DeviceRow | undefined;
    if (!device || device.revoked) fail(401, "Device revoked");
    if (isDeviceExpired(device)) {
      revokeDevice(device.id);
      fail(401, "Device expired");
    }
    const user = getUserById.get(payload.uid) as VdmUserRow | undefined;
    if (!user) fail(401, "Account unavailable");
    // A password change pending in the web panel must happen there first: the
    // Desktop Client has no screen for it, and the default admin password is
    // exactly the case this protects.
    if (user.must_change_password) fail(403, "Change this account's password in the VDM web panel first");
    // The client polls every few seconds; only record activity once a minute so
    // this is not a database write on every request.
    const lastSeen = device.last_seen_at ? Date.parse(`${device.last_seen_at.replace(" ", "T")}Z`) : 0;
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60_000) {
      touchDevice.run(deps.getClientIp(req), device.id);
    }
    return {
      userId: user.id,
      role: vdmRoleToDesktopRole(user.role),
      username: user.username,
      displayName: user.display_name,
      deviceId: device.id,
    };
  }

  function requireAdminContext(ctx: AuthContext): void {
    if (ctx.role !== "ADMIN") fail(403, "Forbidden");
  }

  // ── Opaque resource handles ────────────────────────────────────────────────
  function handleFor(type: DesktopResourceType, node: string, name: string): string {
    const existing = db.prepare("SELECT id FROM vdm_desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?")
      .get(type, node, name) as { id: string } | undefined;
    if (existing) return existing.id;
    db.prepare("INSERT OR IGNORE INTO vdm_desktop_resource_handles (id, resource_type, node_name, resource_name) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), type, node, name);
    const row = db.prepare("SELECT id FROM vdm_desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?")
      .get(type, node, name) as { id: string };
    return row.id;
  }

  function resolveHandle(id: string): { type: DesktopResourceType; node: string; name: string } | null {
    const row = db.prepare("SELECT resource_type, node_name, resource_name FROM vdm_desktop_resource_handles WHERE id = ?")
      .get(id) as { resource_type: DesktopResourceType; node_name: string; resource_name: string } | undefined;
    return row ? { type: row.resource_type, node: row.node_name, name: row.resource_name } : null;
  }

  function requireResource(ctx: AuthContext, rawId: unknown, perm: keyof DesktopResourcePermissions) {
    const parsed = DesktopResourceIdSchema.safeParse(rawId);
    if (!parsed.success) fail(400, "Invalid resource id");
    const resolved = resolveHandle(parsed.data);
    if (!resolved) fail(404, "Resource not found");
    if (!permissionsForRole(ctx.role)[perm]) fail(403, "Forbidden");
    return resolved;
  }

  // ── Inventory across every enabled node ───────────────────────────────────
  // A full sweep is 3 list calls plus one stats call per running resource, per
  // node, over the network. The client polls every 3 s and several endpoints
  // need the same snapshot, so share one for a moment and drop it as soon as
  // something changes.
  const INVENTORY_TTL_MS = 2_000;
  let inventoryCache: { at: number; rows: ResourceRow[] } | null = null;
  let inventoryInFlight: Promise<ResourceRow[]> | null = null;

  function invalidateInventory(): void {
    inventoryCache = null;
  }

  async function listResources(): Promise<ResourceRow[]> {
    if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.rows;
    // Concurrent callers join the sweep already running instead of starting one.
    if (inventoryInFlight) return inventoryInFlight;
    inventoryInFlight = collectResources()
      .then((rows) => {
        inventoryCache = { at: Date.now(), rows };
        return rows;
      })
      .finally(() => { inventoryInFlight = null; });
    return inventoryInFlight;
  }

  async function collectResources(): Promise<ResourceRow[]> {
    const out: ResourceRow[] = [];
    const enrich: Array<Promise<void>> = [];

    await Promise.all(deps.enabledNodes().map(async (node) => {
      const [vms, lxc, docker] = await Promise.all([
        deps.tryFetchNode<Array<Record<string, unknown>>>(node, "/api/internal/vms", []),
        deps.tryFetchNode<Array<Record<string, unknown>>>(node, "/api/internal/lxc", []),
        deps.tryFetchNode<Array<Record<string, unknown>>>(node, "/api/internal/docker/containers", []),
      ]);

      for (const vm of vms) {
        const name = String(vm.name);
        const state = String(vm.state ?? "unknown");
        const agentEnabled = vm.qemuAgentEnabled === true;
        const row: ResourceRow = {
          type: "vm", node: node.name, name, state,
          displayName: typeof vm.displayName === "string" ? vm.displayName : undefined,
          cpuCores: typeof vm.vcpus === "number" ? vm.vcpus : undefined,
          memoryMib: typeof vm.memoryMb === "number" ? vm.memoryMb : undefined,
          qemuGuestAgentEnabled: agentEnabled,
          qemuGuestAgentRunning: false,
          qemuGuestAgentStatus: agentEnabled ? (state === "running" ? "unknown" : "stopped") : "not-installed",
        };
        out.push(row);
        if (state === "running") {
          enrich.push((async () => {
            type VmStats = {
              cpuPercent?: number; memPercent?: number; uptimeSeconds?: number;
              guestAgentEnabled?: boolean; guestAgentRunning?: boolean;
              guestAgentStatus?: ResourceRow["qemuGuestAgentStatus"]; ipAddresses?: string[];
            };
            const stats = await deps.tryFetchNode<VmStats>(node, `/api/internal/vms/${encodeURIComponent(name)}/stats`, {});
            if (typeof stats.cpuPercent === "number") row.cpuPercent = Math.round(stats.cpuPercent * 10) / 10;
            if (typeof stats.memPercent === "number") row.memoryPercent = stats.memPercent;
            if (typeof stats.uptimeSeconds === "number") row.uptimeSeconds = stats.uptimeSeconds;
            if (typeof stats.guestAgentEnabled === "boolean") row.qemuGuestAgentEnabled = stats.guestAgentEnabled;
            if (typeof stats.guestAgentRunning === "boolean") row.qemuGuestAgentRunning = stats.guestAgentRunning;
            if (stats.guestAgentStatus) row.qemuGuestAgentStatus = stats.guestAgentStatus;
            if (Array.isArray(stats.ipAddresses) && stats.ipAddresses.length > 0) {
              row.ipAddresses = stats.ipAddresses;
              row.ipAddress = stats.ipAddresses[0];
            }
          })());
        }
      }

      for (const container of lxc) {
        const name = String(container.name);
        const ip = typeof container.ipAddress === "string" ? container.ipAddress.split("/")[0] : undefined;
        const row: ResourceRow = {
          type: "lxc", node: node.name, name, state: String(container.state ?? "unknown"),
          displayName: typeof container.displayName === "string" ? container.displayName : undefined,
          ipAddress: ip || undefined,
          ipAddresses: ip ? [ip] : undefined,
          cpuCores: typeof container.cpus === "number" ? container.cpus : undefined,
          memoryMib: typeof container.memoryMb === "number" ? container.memoryMb : undefined,
          diskGib: typeof container.diskGb === "number" ? container.diskGb : undefined,
        };
        out.push(row);
        if (row.state === "running") {
          enrich.push((async () => {
            const stats = await deps.tryFetchNode<{ cpuPercent?: number; memUsedBytes?: number; memTotalBytes?: number; uptimeSeconds?: number }>(
              node, `/api/internal/lxc/${encodeURIComponent(name)}/stats`, {},
            );
            if (typeof stats.cpuPercent === "number") row.cpuPercent = Math.round(stats.cpuPercent * 10) / 10;
            if (stats.memTotalBytes && stats.memUsedBytes !== undefined) {
              row.memoryPercent = Math.round((stats.memUsedBytes / stats.memTotalBytes) * 100);
            }
            if (typeof stats.uptimeSeconds === "number") row.uptimeSeconds = stats.uptimeSeconds;
          })());
        }
      }

      for (const container of docker) {
        const id = String(container.id);
        const row: ResourceRow = {
          type: "docker", node: node.name, name: id,
          displayName: String(container.name ?? id),
          state: String(container.state ?? "unknown"),
          image: typeof container.image === "string" ? container.image : undefined,
          uptimeSeconds: parseDockerUptimeSeconds(typeof container.status === "string" ? container.status : undefined),
        };
        out.push(row);
        if (row.state === "running") {
          enrich.push((async () => {
            const stats = await deps.tryFetchNode<{ cpuPercent?: number; memPercent?: number; uptimeSeconds?: number }>(
              node, `/api/internal/docker/containers/${encodeURIComponent(id)}/stats`, {},
            );
            if (typeof stats.cpuPercent === "number") row.cpuPercent = Math.round(stats.cpuPercent * 10) / 10;
            if (typeof stats.memPercent === "number") row.memoryPercent = stats.memPercent;
            if (typeof stats.uptimeSeconds === "number") row.uptimeSeconds = stats.uptimeSeconds;
          })());
        }
      }
    }));

    await Promise.all(enrich);
    return out;
  }

  function serializeResource(ctx: AuthContext, row: ResourceRow) {
    const guestAgent = row.type === "vm"
      ? {
        guestAgent: {
          installed: (row.qemuGuestAgentStatus ?? "unknown") !== "not-installed",
          running: row.qemuGuestAgentRunning ?? false,
          status: row.qemuGuestAgentStatus ?? "unknown",
        },
        qemuGuestAgentEnabled: row.qemuGuestAgentEnabled ?? false,
        qemuGuestAgentRunning: row.qemuGuestAgentRunning ?? false,
        qemuGuestAgentStatus: row.qemuGuestAgentStatus ?? "unknown",
      }
      : {};
    return {
      id: handleFor(row.type, row.node, row.name),
      type: row.type,
      name: row.name,
      displayName: row.displayName ?? row.name,
      state: row.state,
      node: row.node,
      cpuPercent: row.cpuPercent,
      memoryPercent: row.memoryPercent,
      cpuCores: row.cpuCores,
      memoryMib: row.memoryMib,
      diskGib: row.diskGib,
      ipAddress: row.ipAddress,
      ipAddresses: row.ipAddresses,
      uptimeSeconds: row.uptimeSeconds,
      uptime: formatUptime(row.uptimeSeconds),
      image: row.image,
      ...guestAgent,
      permissions: permissionsForRole(ctx.role),
    };
  }

  // ── Create-options catalog, aggregated per node ───────────────────────────
  async function createOptions(type: DesktopResourceType): Promise<DesktopCreateOptions> {
    const nodes = deps.enabledNodes();
    const nodeItems = nodes.map((node) => ({ id: node.name, name: node.name, label: node.display_name ?? node.name }));
    type Item = { id: string; name: string; label?: string; type?: string; node?: string };
    const images: Item[] = [];
    const networks: Item[] = [];
    const seen = new Set<string>();
    const push = (list: Item[], item: Item) => {
      const key = `${list === images ? "i" : "n"}:${item.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(item);
    };

    await Promise.all(nodes.map(async (node) => {
      if (type === "vm") {
        const [files, templates, bridges] = await Promise.all([
          deps.tryFetchNode<Array<{ filename?: string; name?: string; displayName?: string; type?: string }>>(node, "/api/internal/storage/isos", []),
          deps.tryFetchNode<Array<{ id?: string; name?: string; displayName?: string; type?: string }>>(node, "/api/internal/templates", []),
          deps.tryFetchNode<Array<{ name: string }>>(node, "/api/internal/network/bridges", []),
        ]);
        for (const file of files) {
          if ((file.type ?? "iso") !== "iso") continue;
          const id = file.filename ?? file.name;
          if (!id) continue;
          push(images, { id, name: id, label: file.displayName ?? id, type: "iso", node: node.name });
        }
        for (const template of templates) {
          const id = template.id ?? template.name;
          if (!id) continue;
          push(images, { id, name: template.name ?? id, label: template.displayName ?? template.name ?? id, type: "vm", node: node.name });
        }
        for (const bridge of bridges) push(networks, { id: bridge.name, name: bridge.name, label: bridge.name, type: "bridge", node: node.name });
        return;
      }
      if (type === "lxc") {
        const [templates, bridges] = await Promise.all([
          deps.tryFetchNode<Array<{ dist?: string; release?: string; arch?: string; description?: string; cached?: boolean }>>(node, "/api/internal/lxc/templates", []),
          deps.tryFetchNode<Array<{ name: string }>>(node, "/api/internal/network/bridges", []),
        ]);
        const cached = templates.filter((template) => template.cached);
        for (const template of (cached.length > 0 ? cached : templates.slice(0, 60))) {
          if (!template.dist || !template.release) continue;
          const id = `${template.dist}/${template.release}`;
          push(images, {
            id, name: id,
            label: template.description ?? `${template.dist} ${template.release}${template.arch ? ` (${template.arch})` : ""}`,
            type: template.cached ? "template-cached" : "template",
            node: node.name,
          });
        }
        for (const bridge of bridges) push(networks, { id: bridge.name, name: bridge.name, label: bridge.name, type: "bridge", node: node.name });
        return;
      }
      const [dockerImages, dockerNetworks] = await Promise.all([
        deps.tryFetchNode<Array<{ id: string; repoTags?: string[] }>>(node, "/api/internal/docker/images", []),
        deps.tryFetchNode<Array<{ name: string; driver?: string }>>(node, "/api/internal/docker/networks", []),
      ]);
      for (const image of dockerImages) {
        const tags = (image.repoTags ?? []).filter((tag) => tag && !tag.startsWith("<none>"));
        if (tags.length === 0) {
          push(images, { id: image.id, name: image.id.slice(0, 19), label: image.id.slice(0, 19), type: "image", node: node.name });
          continue;
        }
        for (const tag of tags) push(images, { id: tag, name: tag, label: tag, type: "image", node: node.name });
      }
      for (const network of dockerNetworks) {
        push(networks, { id: network.name, name: network.name, label: network.driver ? `${network.name} (${network.driver})` : network.name, type: network.driver ?? "docker", node: node.name });
      }
    }));

    const defaults = type === "vm"
      ? { cpu: 2, memory: 2048, disk: 20 }
      : type === "lxc"
        ? { cpu: 2, memory: 1024, disk: 8 }
        : { cpu: 1, memory: 512, network: "bridge" };
    return { nodes: nodeItems, images, networks, defaults };
  }

  // ── Node relays for the lifecycle verbs ───────────────────────────────────
  const VM_ACTIONS = { start: "start", stop: "shutdown", restart: "reboot" } as const;

  async function runAction(type: DesktopResourceType, nodeName: string, name: string, action: "start" | "stop" | "restart") {
    const node = deps.getEnabledNode(nodeName);
    if (type === "vm") {
      return deps.fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/${VM_ACTIONS[action]}`, { method: "POST" });
    }
    if (type === "lxc") {
      return deps.fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    }
    return deps.fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  }

  /**
   * The NIC bridge and model live on an existing interface, not in the create
   * payload, so they are applied through the node's per-MAC network route —
   * the same one the VDM web panel uses.
   */
  async function applyVmNetwork(node: VdmNodeRow, name: string, network?: string, networkModel?: string): Promise<void> {
    if (network === undefined && networkModel === undefined) return;
    const info = await deps.tryFetchNode<{ networks?: Array<{ mac?: string }> }>(node, `/api/internal/vms/${encodeURIComponent(name)}`, {});
    const mac = info.networks?.[0]?.mac;
    if (!mac) fail(400, "This VM has no network interface to update");
    await deps.fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/network/${encodeURIComponent(mac)}`, {
      method: "PUT",
      body: JSON.stringify({ bridge: network, model: networkModel }),
    });
  }

  async function createSnapshot(type: DesktopResourceType, nodeName: string, name: string, input: { name: string; description?: string }) {
    if (type === "docker") fail(400, "Snapshots are not supported for Docker containers");
    const node = deps.getEnabledNode(nodeName);
    const base = type === "vm" ? "vms" : "lxc";
    return deps.fetchNode(node, `/api/internal/${base}/${encodeURIComponent(name)}/snapshot/create`, {
      method: "POST",
      timeoutMs: 15 * 60_000,
      body: JSON.stringify(input),
    });
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/desktop/")) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "DENY");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  const handle = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (error) {
        // A node rejecting the manager's own token is a 502, never a 401: a 401
        // would send the client into a pointless token-refresh loop.
        if (error instanceof NodeRequestError) {
          const upstream = error.failure === "unauthorized" || error.failure === "timeout" || error.failure === "network"
            ? 502
            : error.statusCode ?? 502;
          req.log.warn({ node: error.nodeName, failure: error.failure }, "vdm desktop node request failed");
          return reply.status(upstream).send({ error: `Nœud ${error.nodeName} : ${error.message}` });
        }
        const status = (error as { statusCode?: number }).statusCode ?? 500;
        const message = (error as { desktopError?: boolean }).desktopError
          ? (error as Error).message
          : status < 500 ? (error as Error).message : "Internal error";
        if (status >= 500) req.log.error({ err: error }, "vdm desktop api error");
        return reply.status(status).send({ error: message });
      }
    };

  const sensitiveRateLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };

  app.post("/api/desktop/auth/login", sensitiveRateLimit, handle(async (req, reply) => {
    const parsed = DesktopLoginSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const { username, password, deviceName, deviceFingerprint, installationId } = parsed.data;
    const user = getUserByName.get(username) as VdmUserRow | undefined;
    // Always run a hash/verify so a missing username and a wrong password cost
    // the same time.
    const ok = user
      ? await argon2.verify(user.password_hash, password).catch(() => false)
      : await argon2.hash("dummy").then(() => false);
    if (!user || !ok) {
      deps.log("warn", `Desktop login refused for "${username}" from ${deps.getClientIp(req)}`);
      fail(401, "Invalid credentials");
    }
    if (user.must_change_password) {
      fail(403, "Change this account's password in the VDM web panel before connecting a Desktop client");
    }
    const ip = deps.getClientIp(req);
    const { deviceId, created } = resolveDeviceForAuth(user.id, installationId, deviceName, deviceFingerprint, ip);
    const tokens = issueTokensForDevice(deviceId, user, ip);
    deps.log("info", `Desktop client ${created ? "registered" : "reconnected"} for ${user.username} (${deviceName})`);
    return reply.send(tokens);
  }));

  app.post("/api/desktop/devices/pair", sensitiveRateLimit, handle(async (req, reply) => {
    const parsed = DesktopPairSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const { pairingCode, deviceName, deviceFingerprint, installationId } = parsed.data;
    const row = db.prepare("SELECT id, user_id, expires_at, used_at FROM vdm_desktop_pairing_codes WHERE code_hash = ?")
      .get(sha256(pairingCode.trim().toUpperCase())) as { id: string; user_id: number; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      deps.log("warn", `Desktop pairing refused (invalid or expired code) from ${deps.getClientIp(req)}`);
      fail(401, "Invalid or expired pairing code");
    }
    const user = getUserById.get(row.user_id) as VdmUserRow | undefined;
    if (!user) fail(401, "Account unavailable");
    if (user.must_change_password) fail(403, "Change this account's password in the VDM web panel first");
    db.prepare("UPDATE vdm_desktop_pairing_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
    const ip = deps.getClientIp(req);
    const { deviceId, created } = resolveDeviceForAuth(user.id, installationId, deviceName, deviceFingerprint, ip);
    const tokens = issueTokensForDevice(deviceId, user, ip);
    deps.log("info", `Desktop client ${created ? "paired" : "re-paired"} for ${user.username} (${deviceName})`);
    return reply.send(tokens);
  }));

  app.post("/api/desktop/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const parsed = DesktopRefreshSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const row = db.prepare("SELECT id, device_id, expires_at, revoked FROM vdm_desktop_refresh_tokens WHERE token_hash = ?")
      .get(hashRefreshToken(parsed.data.refreshToken)) as RefreshRow | undefined;
    if (!row || row.revoked || new Date(row.expires_at).getTime() < Date.now()) fail(401, "Invalid refresh token");
    const device = getDevice.get(row.device_id) as DeviceRow | undefined;
    if (!device || device.revoked) fail(401, "Device revoked");
    if (parsed.data.installationId && device.installation_id && parsed.data.installationId !== device.installation_id) {
      fail(401, "Installation mismatch");
    }
    if (isDeviceExpired(device)) {
      revokeDevice(device.id);
      fail(401, "Device expired");
    }
    const user = getUserById.get(device.user_id) as VdmUserRow | undefined;
    if (!user) fail(401, "Account unavailable");
    if (user.must_change_password) fail(403, "Change this account's password in the VDM web panel first");
    // Rotate: the presented token dies, a fresh pair is minted.
    db.prepare("UPDATE vdm_desktop_refresh_tokens SET revoked = 1 WHERE id = ?").run(row.id);
    return reply.send(issueTokensForDevice(device.id, user, deps.getClientIp(req)));
  }));

  app.post("/api/desktop/auth/logout", handle(async (req, reply) => {
    const parsed = DesktopLogoutSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const row = db.prepare("SELECT id, device_id FROM vdm_desktop_refresh_tokens WHERE token_hash = ?")
      .get(hashRefreshToken(parsed.data.refreshToken)) as { id: string; device_id: string } | undefined;
    // An installationId alone is never enough to disconnect a device: only the
    // refresh token proves the caller owns this one.
    if (row) revokeDevice(row.device_id);
    return reply.send({ ok: true });
  }));

  // ── Pairing codes and device management (VDM web session) ─────────────────
  // This is the "pair a Desktop client" flow the VDM panel was missing.
  app.post("/api/desktop/pairing-codes", { config: { rateLimit: { max: 20, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const session = deps.getWebSessionUser(req);
    if (!session) fail(401, "Authentication required");
    db.prepare("DELETE FROM vdm_desktop_pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL")
      .run(new Date().toISOString());
    const code = generatePairingCode();
    db.prepare("INSERT INTO vdm_desktop_pairing_codes (id, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), sha256(code), session.userId, new Date(Date.now() + PAIRING_TTL_MS).toISOString());
    deps.log("info", `Desktop pairing code issued for ${session.username}`);
    return reply.send({ code, expiresInMs: PAIRING_TTL_MS });
  }));

  app.get("/api/desktop/my-devices", handle(async (req, reply) => {
    const session = deps.getWebSessionUser(req);
    if (!session) fail(401, "Authentication required");
    const rows = db.prepare(`SELECT ${DEVICE_COLS}, last_ip FROM vdm_desktop_devices WHERE user_id = ? ORDER BY created_at DESC`)
      .all(session.userId) as Array<DeviceRow & { last_ip: string | null }>;
    return reply.send(rows.map((row) => ({
      id: row.id,
      name: row.name,
      installationId: row.installation_id,
      revoked: !!row.revoked,
      status: row.revoked ? "revoked" : "active",
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      lastSeenAt: row.last_seen_at,
      lastIp: row.last_ip,
    })));
  }));

  app.post("/api/desktop/my-devices/revoke-all", handle(async (req, reply) => {
    const session = deps.getWebSessionUser(req);
    if (!session) fail(401, "Authentication required");
    const devices = db.prepare("SELECT id FROM vdm_desktop_devices WHERE user_id = ? AND revoked = 0").all(session.userId) as Array<{ id: string }>;
    for (const device of devices) revokeDevice(device.id);
    deps.log("info", `Revoked ${devices.length} desktop device(s) for ${session.username}`);
    return reply.send({ ok: true, revoked: devices.length });
  }));

  app.post("/api/desktop/my-devices/purge-revoked", handle(async (req, reply) => {
    const session = deps.getWebSessionUser(req);
    if (!session) fail(401, "Authentication required");
    const info = db.prepare("DELETE FROM vdm_desktop_devices WHERE user_id = ? AND revoked = 1").run(session.userId);
    return reply.send({ ok: true, removed: info.changes });
  }));

  app.delete("/api/desktop/my-devices/:id", handle(async (req, reply) => {
    const session = deps.getWebSessionUser(req);
    if (!session) fail(401, "Authentication required");
    const id = (req.params as { id: string }).id;
    const owned = db.prepare("SELECT id, revoked FROM vdm_desktop_devices WHERE id = ? AND user_id = ?")
      .get(id, session.userId) as { id: string; revoked: number } | undefined;
    if (!owned) fail(404, "Device not found");
    // Already revoked → remove it from the list for good.
    if (owned.revoked) db.prepare("DELETE FROM vdm_desktop_devices WHERE id = ?").run(id);
    else revokeDevice(id);
    return reply.send({ ok: true });
  }));

  // ── Session ───────────────────────────────────────────────────────────────
  app.get("/api/desktop/me", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const device = getDevice.get(ctx.deviceId) as DeviceRow;
    const canCreate = ctx.role === "ADMIN";
    return reply.send({
      user: { id: ctx.userId, username: ctx.username, displayName: ctx.displayName, role: ctx.role },
      device: { id: device.id, name: device.name, createdAt: device.created_at, lastSeenAt: device.last_seen_at },
      capabilities: {
        isAdmin: ctx.role === "ADMIN",
        // The VDM is a manager, not a hypervisor: "server" tells the client it
        // is talking to a datacenter, which is why nodes are selectable.
        manager: "vdm",
        canCreate: { vm: canCreate, lxc: canCreate, docker: canCreate },
      },
    });
  }));

  // ── Resources ─────────────────────────────────────────────────────────────
  app.get("/api/desktop/resources", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const rows = await listResources();
    return reply.send(rows.map((row) => serializeResource(ctx, row)));
  }));

  // Static route, declared before /:id so it is matched first.
  app.get("/api/desktop/resources/create-options", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const rawType = (req.query as { type?: string }).type;
    if (!rawType || !(DESKTOP_RESOURCE_TYPES as readonly string[]).includes(rawType)) {
      fail(400, "Query param 'type' must be one of: vm, lxc, docker");
    }
    requireAdminContext(ctx);
    return reply.send(await createOptions(rawType as DesktopResourceType));
  }));

  app.get("/api/desktop/resources/:id", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canView");
    const rows = await listResources();
    const live = rows.find((row) => row.type === res.type && row.node === res.node && row.name === res.name);
    const row: ResourceRow = live ?? { type: res.type, node: res.node, name: res.name, state: "unknown" };
    return reply.send({ ...serializeResource(ctx, row), id: (req.params as { id: string }).id });
  }));

  const lifecycleRateLimit = { config: { rateLimit: { max: 20, timeWindow: 60_000 } } };

  app.post("/api/desktop/resources", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    requireAdminContext(ctx);
    const parsed = DesktopCreateResourceSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const input = parsed.data;
    const nodes = deps.enabledNodes();
    if (nodes.length === 0) fail(409, "No enabled node in this datacenter");
    // A manager has no implicit "local" node: without an explicit choice, take
    // the first enabled one so a single-node cluster just works.
    const node = deps.getEnabledNode(input.node?.trim() || nodes[0].name);

    if (input.type === "vm") {
      const payload: Record<string, unknown> = {
        name: input.name,
        vcpus: input.cpu ?? 2,
        memoryMb: input.memory ?? 2048,
        diskGb: input.disk ?? 20,
        os: "linux",
        ...(input.image ? { isoFile: input.image } : {}),
        ...(input.network ? { bridge: input.network } : {}),
        ...(input.architecture ? { arch: input.architecture === "arm64" ? "aarch64" : "x86_64", machine: input.architecture === "arm64" ? "virt" : "q35" } : {}),
        ...(input.secureBoot !== undefined ? { secureBoot: input.secureBoot } : {}),
        ...(input.secureBoot || input.architecture === "arm64" ? { uefi: true } : {}),
        ...(input.tpm2 !== undefined ? { tpmEnabled: input.tpm2 } : {}),
        ...(input.qemuGuestAgent !== undefined ? { qemuAgentEnabled: input.qemuGuestAgent } : {}),
        ...(input.autostart !== undefined ? { autostart: input.autostart } : {}),
        ...(input.gpuModel ? { videoModel: input.gpuModel } : {}),
      };
      await deps.fetchNode(node, "/api/internal/vms", { method: "POST", timeoutMs: 15 * 60_000, body: JSON.stringify(payload) });
      if (input.networkModel) {
        // The VM exists by now, so a NIC-model mismatch must not fail creation.
        await applyVmNetwork(node, input.name, undefined, input.networkModel).catch(() => undefined);
      }
      invalidateInventory();
      const id = handleFor("vm", node.name, input.name);
      deps.log("info", `Desktop created VM ${input.name} on ${node.name} (${ctx.username})`);
      return reply.send({ ok: true, resource: { id, type: "vm", name: input.name, displayName: input.name, node: node.name, state: "unknown", permissions: permissionsForRole(ctx.role) } });
    }

    if (input.type === "lxc") {
      const [dist, release] = (input.image ?? "debian/13").split("/");
      const payload: Record<string, unknown> = {
        name: input.name,
        dist: dist || "debian",
        release: release || "13",
        cpuCores: input.cpu ?? 1,
        memoryMb: input.memory ?? 512,
        diskGb: input.disk ?? 8,
        // The desktop never carries a root password to a manager; the node
        // gets a random one, which the operator resets from the console.
        password: `Vx${randomBytes(15).toString("base64url")}`,
        ...(input.network ? { bridge: input.network } : {}),
        ...(input.autostart !== undefined ? { autostart: input.autostart } : {}),
        ...(input.nesting !== undefined ? { nesting: input.nesting } : {}),
      };
      await deps.fetchNode(node, "/api/internal/lxc", { method: "POST", timeoutMs: 15 * 60_000, body: JSON.stringify(payload) });
      invalidateInventory();
      const id = handleFor("lxc", node.name, input.name);
      deps.log("info", `Desktop created LXC ${input.name} on ${node.name} (${ctx.username})`);
      return reply.send({ ok: true, resource: { id, type: "lxc", name: input.name, displayName: input.name, node: node.name, state: "unknown", permissions: permissionsForRole(ctx.role) } });
    }

    if (!input.image) fail(400, "An image is required to create a Docker container");
    const ports = (input.ports ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [host, container] = entry.split(":");
        return { hostPort: Number(host), containerPort: Number(container ?? host) };
      })
      .filter((entry) => Number.isFinite(entry.hostPort) && Number.isFinite(entry.containerPort));
    const payload: Record<string, unknown> = {
      name: input.name,
      image: input.image,
      ...(input.cpu !== undefined ? { cpuLimit: input.cpu } : {}),
      ...(input.memory !== undefined ? { memoryMb: input.memory } : {}),
      ...(input.network ? { network: input.network } : {}),
      ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
      ...(input.privileged !== undefined ? { privileged: input.privileged } : {}),
      ...(ports.length > 0 ? { ports } : {}),
    };
    const created = await deps.fetchNode<{ id: string }>(node, "/api/internal/docker/containers", {
      method: "POST", timeoutMs: 15 * 60_000, body: JSON.stringify(payload),
    });
    invalidateInventory();
    const id = handleFor("docker", node.name, created.id);
    deps.log("info", `Desktop created Docker ${input.name} on ${node.name} (${ctx.username})`);
    return reply.send({ ok: true, resource: { id, type: "docker", name: created.id, displayName: input.name, node: node.name, state: "unknown", permissions: permissionsForRole(ctx.role) } });
  }));

  app.patch("/api/desktop/resources/:id", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canModify");
    const parsed = DesktopUpdateResourceSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const patch = parsed.data;
    if (patch.image !== undefined) fail(400, "Changing the image of an existing resource is not supported");
    if (patch.name !== undefined && patch.name !== res.name) {
      fail(400, "Renaming from the Desktop client is not supported through a manager");
    }
    const node = deps.getEnabledNode(res.node);
    const config: Record<string, unknown> = {};
    if (res.type === "vm") {
      if (patch.disk !== undefined) fail(400, "Disk resize is not available from the desktop for VMs");
      if (patch.cpu !== undefined) config.vcpus = patch.cpu;
      if (patch.memory !== undefined) config.memoryMb = patch.memory;
      if (patch.tpm2 !== undefined) config.tpmEnabled = patch.tpm2;
      if (patch.secureBoot !== undefined) config.secureBoot = patch.secureBoot;
      if (patch.qemuGuestAgent !== undefined) config.qemuAgentEnabled = patch.qemuGuestAgent;
      if (patch.autostart !== undefined) config.autostart = patch.autostart;
      if (patch.gpuModel !== undefined) config.videoModel = patch.gpuModel;
      if (Object.keys(config).length > 0) {
        await deps.fetchNode(node, `/api/internal/vms/${encodeURIComponent(res.name)}/config`, { method: "PUT", body: JSON.stringify(config) });
      }
      await applyVmNetwork(node, res.name, patch.network, patch.networkModel);
    } else if (res.type === "lxc") {
      if (patch.cpu !== undefined) config.cpuCores = patch.cpu;
      if (patch.memory !== undefined) config.memoryMb = patch.memory;
      if (patch.disk !== undefined) config.diskGb = patch.disk;
      if (patch.network !== undefined) config.bridge = patch.network;
      if (patch.autostart !== undefined) config.autostart = patch.autostart;
      if (Object.keys(config).length > 0) {
        await deps.fetchNode(node, `/api/internal/lxc/${encodeURIComponent(res.name)}/config`, { method: "PUT", body: JSON.stringify(config) });
      }
    } else {
      if (patch.disk !== undefined) fail(400, "Docker containers have no resizable disk");
      if (patch.cpu !== undefined) config.cpuLimit = patch.cpu;
      if (patch.memory !== undefined) config.memoryMb = patch.memory;
      if (patch.restartPolicy !== undefined) config.restartPolicy = patch.restartPolicy;
      if (Object.keys(config).length > 0) {
        await deps.fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(res.name)}/config`, { method: "PUT", body: JSON.stringify(config) });
      }
    }
    invalidateInventory();
    const rows = await listResources();
    const live = rows.find((row) => row.type === res.type && row.node === res.node && row.name === res.name);
    const row: ResourceRow = live ?? { type: res.type, node: res.node, name: res.name, state: "unknown" };
    return reply.send({ ok: true, resource: { ...serializeResource(ctx, row), id: (req.params as { id: string }).id } });
  }));

  app.delete("/api/desktop/resources/:id", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canDelete");
    const node = deps.getEnabledNode(res.node);
    if (res.type === "vm") {
      await deps.fetchNode(node, `/api/internal/vms/${encodeURIComponent(res.name)}?deleteDisks=true`, { method: "DELETE", timeoutMs: 10 * 60_000 });
    } else if (res.type === "lxc") {
      await deps.fetchNode(node, `/api/internal/lxc/${encodeURIComponent(res.name)}`, { method: "DELETE", timeoutMs: 10 * 60_000 });
    } else {
      await deps.fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(res.name)}`, { method: "DELETE", timeoutMs: 5 * 60_000 });
    }
    db.prepare("DELETE FROM vdm_desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?")
      .run(res.type, res.node, res.name);
    invalidateInventory();
    deps.log("info", `Desktop deleted ${res.type} ${res.name} on ${res.node} (${ctx.username})`);
    return reply.send({ ok: true });
  }));

  // ── Actions ───────────────────────────────────────────────────────────────
  const powerAction = (action: "start" | "stop" | "restart") => handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canPower");
    const result = await runAction(res.type, res.node, res.name, action);
    invalidateInventory();
    return reply.send({ ok: true, result });
  });
  app.post("/api/desktop/resources/:id/actions/start", powerAction("start"));
  app.post("/api/desktop/resources/:id/actions/stop", powerAction("stop"));
  app.post("/api/desktop/resources/:id/actions/restart", powerAction("restart"));

  app.post("/api/desktop/resources/:id/actions/snapshot", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canSnapshot");
    const parsed = DesktopSnapshotSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid snapshot request");
    const result = await createSnapshot(res.type, res.node, res.name, parsed.data);
    deps.log("info", `Desktop snapshot "${parsed.data.name}" of ${res.type} ${res.name} on ${res.node} (${ctx.username})`);
    return reply.send({ ok: true, result });
  }));

  // ── Tasks (the manager's own long operations) ─────────────────────────────
  app.get("/api/desktop/tasks", handle(async (req, reply) => {
    authDesktop(req);
    const rows = db.prepare("SELECT id, label, target_node, resource_name, status, progress, created_at FROM vdm_tasks ORDER BY created_at DESC LIMIT 50")
      .all() as Array<{ id: string; label: string; target_node: string | null; resource_name: string | null; status: string; progress: number; created_at: string }>;
    return reply.send(rows.map((row): DesktopTaskInfo => ({
      id: row.id,
      label: row.label,
      target: row.resource_name ?? row.target_node ?? "cluster",
      status: taskStatusForDesktop(row.status),
      progress: row.progress,
      createdAt: row.created_at,
    })));
  }));

  app.get("/api/desktop/tasks/:taskId", handle(async (req, reply) => {
    authDesktop(req);
    const row = db.prepare("SELECT id, label, target_node, resource_name, status, progress, created_at FROM vdm_tasks WHERE id = ?")
      .get((req.params as { taskId: string }).taskId) as { id: string; label: string; target_node: string | null; resource_name: string | null; status: string; progress: number; created_at: string } | undefined;
    if (!row) fail(404, "Task not found");
    return reply.send({
      id: row.id,
      label: row.label,
      target: row.resource_name ?? row.target_node ?? "cluster",
      status: taskStatusForDesktop(row.status),
      progress: row.progress,
      createdAt: row.created_at,
    });
  }));

  // ── Console tickets ───────────────────────────────────────────────────────
  // A relative URL: the client rewrites it onto the endpoint it is connected
  // to, so this works behind a reverse proxy and over https alike.
  const consoleUrl = (ticket: string) => `/api/vdm/ws/console?ticket=${encodeURIComponent(ticket)}`;
  const consoleRateLimit = { config: { rateLimit: { max: 30, timeWindow: 60_000 } } };

  app.post("/api/desktop/resources/:id/console/text-ticket", consoleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canConsole");
    const node = deps.getEnabledNode(res.node);
    const internalPath = res.type === "vm"
      ? `/api/internal/vms/${encodeURIComponent(res.name)}/console-ticket`
      : res.type === "lxc"
        ? `/api/internal/lxc/${encodeURIComponent(res.name)}/console-ticket`
        : `/api/internal/docker/containers/${encodeURIComponent(res.name)}/console-ticket`;
    const relayed = await deps.relayConsoleTicket(node, internalPath, "term");
    return reply.send({ ticket: relayed.ticket, url: consoleUrl(relayed.ticket), expiresInMs: 30_000, kind: "text" });
  }));

  app.post("/api/desktop/resources/:id/console/graphical-ticket", consoleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canConsole");
    if (res.type !== "vm") fail(400, "Graphical console is only available for VMs");
    const node = deps.getEnabledNode(res.node);
    const relayed = await deps.relayConsoleTicket(node, `/api/internal/vms/${encodeURIComponent(res.name)}/vnc-ticket`, "vnc");
    return reply.send({ ticket: relayed.ticket, url: consoleUrl(relayed.ticket), expiresInMs: 30_000, kind: "graphical" });
  }));

  app.post("/api/desktop/resources/:id/console/spice-ticket", consoleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResource(ctx, (req.params as { id: string }).id, "canConsole");
    if (res.type !== "vm") fail(400, "SPICE console is only available for VMs");
    const node = deps.getEnabledNode(res.node);
    const relayed = await deps.relayConsoleTicket(node, `/api/internal/vms/${encodeURIComponent(res.name)}/spice-ticket`, "spice");
    return reply.send({
      ticket: relayed.ticket,
      url: consoleUrl(relayed.ticket),
      expiresInMs: 30_000,
      kind: "spice",
      ...(relayed.password ? { password: relayed.password } : {}),
    });
  }));
}
