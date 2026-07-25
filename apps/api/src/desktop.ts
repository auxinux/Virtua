// =============================================================================
//  Virtua Desktop API  (/api/desktop/*)
//
//  Secure API for the Virtua Desktop client. Reuses the panel's RBAC, audit log
//  and one-time WebSocket console tickets. Auth is bearer-token based (the web
//  UI uses cookies; the desktop uses short access tokens + rotating refresh
//  tokens bound to a registered, revocable device).
//
//  Security properties:
//   - Argon2id password hashing (reuses the users table).
//   - Short-lived HMAC access tokens; rotating, hashed-at-rest refresh tokens.
//   - Instant revocation: every request re-checks the device + user are active.
//   - Server-side permission check on EVERY endpoint (ADMIN=all, USER=assigned).
//   - Opaque UUID resource handles: the client never sends a real name/node.
//   - One-time, short-lived console tickets (text + graphical), permission-gated.
//   - Rate limiting on login/pair/refresh; strict input validation (zod).
//   - Full audit trail (user, ip, device, resource, action, result, timestamp).
//   - Security headers + no permissive CORS on the desktop surface.
// =============================================================================
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import * as argon2 from "argon2";
import { randomUUID } from "crypto";
import {
  DesktopLoginSchema,
  DesktopPairSchema,
  DesktopRefreshSchema,
  DesktopLogoutSchema,
  DesktopSnapshotSchema,
  DesktopResourceIdSchema,
  DesktopCreateResourceSchema,
  DesktopUpdateResourceSchema,
  DESKTOP_RESOURCE_TYPES,
  type DesktopResourceType,
  type DesktopResourcePermissions,
  type DesktopTaskInfo,
  type DesktopCreateResourceInput,
  type DesktopUpdateResourceInput,
  type DesktopCreateOptions,
} from "@auxinux/shared";
import { auditLog } from "./db.js";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generatePairingCode,
  hashRefreshToken as sha256, // alias: same SHA-256 used for pairing codes
} from "@auxinux/shared/dist/desktop/token.js";

type Role = "ADMIN" | "USER";

export interface DesktopConsoleTicket {
  ticketId: string;
  url: string;
  ttlMs: number;
}

export interface DesktopResourceRow {
  type: DesktopResourceType;
  node: string;
  /** RBAC key (vm/lxc: name; docker: container id) */
  name: string;
  displayName?: string;
  state: string;
  /** live CPU usage 0–100 */
  cpuPercent?: number;
  /** live memory usage 0–100 */
  memoryPercent?: number;
  ipAddress?: string;
  ipAddresses?: string[];
  uptimeSeconds?: number;
  image?: string;
  owner?: string;
  assignedUsers?: string[];
  /** VM qemu-guest-agent live state (VMs only) */
  qemuGuestAgentEnabled?: boolean;
  qemuGuestAgentRunning?: boolean;
  qemuGuestAgentStatus?: "running" | "stopped" | "not-installed" | "unknown";
}

export type DesktopPerm = "view" | "console" | "power" | "snapshot" | "modify" | "delete";

export interface DesktopDeps {
  app: FastifyInstance;
  db: Database.Database;
  /** Stable secret for signing access tokens (server-managed). */
  getTokenSecret: () => string;
  getClientIp: (req: FastifyRequest) => string;
  /** RBAC — the SAME functions the web panel uses. */
  hasResourcePermission: (userId: number, role: string, type: DesktopResourceType, name: string, perm: DesktopPerm) => boolean;
  /** Whether this user may create a resource of `type` (quota + policy aware). */
  userCanCreate: (userId: number, role: string, type: DesktopResourceType) => boolean;
  /** All resources across enabled nodes (already de-duplicated, with live metrics). */
  listResourcesForDesktop: () => Promise<DesktopResourceRow[]>;
  /** Node-aware power action. */
  runResourceAction: (type: DesktopResourceType, node: string, name: string, action: "start" | "stop" | "restart") => Promise<unknown>;
  /** Node-aware snapshot creation (VM/LXC). */
  createSnapshotForResource: (type: DesktopResourceType, node: string, name: string, input: { name: string; description?: string }) => Promise<unknown>;
  /** Create a resource. Returns the canonical identity so a handle can be minted. */
  createResource: (ctx: { userId: number; role: Role; username: string }, input: DesktopCreateResourceInput)
    => Promise<{ node: string; name: string; displayName?: string }>;
  /** Apply a partial update to a resource (fields filtered per type server-side). */
  updateResource: (res: { type: DesktopResourceType; node: string; name: string }, patch: DesktopUpdateResourceInput, ctx: { userId: number; role: Role; username: string })
    => Promise<{ node: string; name: string }>;
  /** Delete a resource cleanly per type. */
  deleteResource: (res: { type: DesktopResourceType; node: string; name: string }, ctx: { userId: number; role: Role }) => Promise<void>;
  /** Catalog for the desktop's "new resource" form (nodes/images/networks/defaults). */
  getCreateOptions: (type: DesktopResourceType) => Promise<DesktopCreateOptions>;
  /** Recent server-side operations the caller is allowed to see. */
  listRecentTasks: (userId: number, role: Role) => DesktopTaskInfo[];
  /** A single task by id (ownership-scoped); null if absent or not visible. */
  getTask: (userId: number, role: Role, taskId: string) => DesktopTaskInfo | null;
  /** Issue a one-time console ticket (kind/route resolved centrally). */
  issueConsoleTicket: (req: FastifyRequest, args: { type: DesktopResourceType; node: string; name: string; mode: "text" | "graphical" | "spice"; userId: number; deviceId: string }) => Promise<DesktopConsoleTicket>;
  /** Current web-session user (for minting pairing codes from the panel). */
  getWebSessionUser: (req: FastifyRequest) => { userId: number; role: Role; username: string } | null;
}

const ACCESS_TTL_SEC = Math.max(60, parseInt(process.env.AUXINUX_DESKTOP_ACCESS_TTL ?? "900", 10) || 900);
// Refresh tokens live 14 days and are rolled forward on every successful refresh.
const REFRESH_TTL_DAYS = Math.max(1, parseInt(process.env.AUXINUX_DESKTOP_REFRESH_TTL_DAYS ?? "14", 10) || 14);
// An active device with no activity for this long is auto-revoked.
const DEVICE_IDLE_DAYS = Math.max(1, parseInt(process.env.AUXINUX_DESKTOP_DEVICE_IDLE_DAYS ?? "14", 10) || 14);
const PAIRING_TTL_MS = Math.max(60_000, parseInt(process.env.AUXINUX_DESKTOP_PAIRING_TTL_MS ?? "600000", 10) || 600_000);

interface UserRow { id: number; username: string; password_hash: string; role: Role; display_name: string | null; suspended: number; }
interface DeviceRow { id: string; user_id: number; name: string; installation_id: string | null; revoked: number; revoked_at: string | null; created_at: string; last_seen_at: string | null; }
interface RefreshRow { id: string; device_id: string; token_hash: string; expires_at: string; revoked: number; }

interface DesktopAuthContext { userId: number; role: Role; username: string; displayName: string | null; deviceId: string; }

/** Map a forbidden/unauthorized error without leaking internals. */
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status, desktopError: true });
}

export function registerDesktopApi(deps: DesktopDeps): void {
  const { app, db } = deps;

  const DEVICE_COLS = "id, user_id, name, installation_id, revoked, revoked_at, created_at, last_seen_at";
  const getUserById = db.prepare("SELECT id, username, password_hash, role, display_name, suspended FROM users WHERE id = ?");
  const getUserByName = db.prepare("SELECT id, username, password_hash, role, display_name, suspended FROM users WHERE username = ?");
  const getDevice = db.prepare(`SELECT ${DEVICE_COLS} FROM desktop_devices WHERE id = ?`);
  const getDeviceByInstallation = db.prepare(`SELECT ${DEVICE_COLS} FROM desktop_devices WHERE user_id = ? AND installation_id = ?`);
  const touchDevice = db.prepare("UPDATE desktop_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?");

  // ── Per-account "Allow Virtua Desktop" switch ──────────────────────────────
  // Stored as a per-user setting. Default = enabled (absent key ⇒ allowed).
  function isDesktopEnabledForUser(userId: number): boolean {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`desktop.enabled.${userId}`) as { value?: string } | undefined;
    return row?.value !== "0";
  }
  function setDesktopEnabledForUser(userId: number, enabled: boolean) {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(`desktop.enabled.${userId}`, enabled ? "1" : "0");
  }

  /** Mark a device revoked (idempotent) and kill all its refresh tokens. */
  function revokeDevice(deviceId: string) {
    db.prepare("UPDATE desktop_devices SET revoked = 1, revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(deviceId);
    db.prepare("UPDATE desktop_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(deviceId);
  }

  /**
   * Auto-revoke an active device that has been idle for > DEVICE_IDLE_DAYS.
   * Returns true if the device is (now) revoked.
   */
  function isDeviceExpired(device: DeviceRow): boolean {
    if (device.revoked) return true;
    if (!device.last_seen_at) return false; // brand-new device, never seen yet
    const lastSeenMs = Date.parse(device.last_seen_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(lastSeenMs)) return false;
    return Date.now() - lastSeenMs > DEVICE_IDLE_DAYS * 86_400_000;
  }

  /**
   * Resolve the device to (re)use for a login/pair with an installationId.
   * Reuses the existing per-installation device (never creates a duplicate),
   * reactivating it if it was revoked. Returns the device id + whether it is new.
   */
  function resolveDeviceForAuth(userId: number, installationId: string | undefined, deviceName: string, fingerprint: string | undefined, ip: string): { deviceId: string; created: boolean } {
    if (installationId) {
      const existing = getDeviceByInstallation.get(userId, installationId) as DeviceRow | undefined;
      if (existing) {
        // Same installation → reuse the SAME authorization. Reactivate if revoked
        // or idle-expired (a fresh credential/pairing check just succeeded).
        const wasInactive = !!existing.revoked || isDeviceExpired(existing);
        db.prepare("UPDATE desktop_devices SET name = ?, fingerprint = COALESCE(?, fingerprint), revoked = 0, revoked_at = NULL, last_seen_at = datetime('now'), last_ip = ? WHERE id = ?")
          .run(deviceName, fingerprint ?? null, ip, existing.id);
        // A reactivated device starts a clean token lineage.
        if (wasInactive) db.prepare("UPDATE desktop_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(existing.id);
        return { deviceId: existing.id, created: wasInactive };
      }
    }
    const deviceId = randomUUID();
    db.prepare("INSERT INTO desktop_devices (id, user_id, name, installation_id, fingerprint, last_ip) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deviceId, userId, deviceName, installationId ?? null, fingerprint ?? null, ip);
    return { deviceId, created: true };
  }

  // ── Security headers on the whole desktop surface (no permissive CORS) ──────
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/desktop/")) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "DENY");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cache-Control", "no-store");
      // No Access-Control-Allow-Origin → browsers can't call this cross-origin;
      // the native desktop client is unaffected.
    }
    return payload;
  });

  // ── Token + device helpers ──────────────────────────────────────────────────
  function issueTokensForDevice(deviceId: string, user: UserRow, ip: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const accessToken = signAccessToken(
      { v: 1, did: deviceId, uid: user.id, role: user.role, iat: nowSec, exp: nowSec + ACCESS_TTL_SEC },
      deps.getTokenSecret(),
    );
    const refreshRaw = generateRefreshToken();
    const refreshId = randomUUID();
    const refreshExpires = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000).toISOString();
    db.prepare("INSERT INTO desktop_refresh_tokens (id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(refreshId, deviceId, hashRefreshToken(refreshRaw), refreshExpires);
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

  /** Authenticate a request via the Bearer access token; enforce revocation. */
  function authDesktop(req: FastifyRequest): DesktopAuthContext {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) fail(401, "Missing bearer token");
    const payload = verifyAccessToken(m[1].trim(), deps.getTokenSecret());
    if (!payload) fail(401, "Invalid or expired token");
    const device = getDevice.get(payload.did) as DeviceRow | undefined;
    if (!device || device.revoked) fail(401, "Device revoked");
    // Auto-revoke a device that has gone idle beyond the allowed window.
    if (isDeviceExpired(device)) {
      revokeDevice(device.id);
      fail(401, "Device expired");
    }
    const user = getUserById.get(payload.uid) as UserRow | undefined;
    if (!user || user.suspended) fail(401, "Account unavailable");
    // Account-level kill switch: blocks all desktop activity for this user.
    if (!isDesktopEnabledForUser(user.id)) fail(403, "Virtua Desktop is disabled for this account");
    return { userId: user.id, role: user.role, username: user.username, displayName: user.display_name, deviceId: device.id };
  }

  // ── Resource handle (opaque UUID) helpers ──────────────────────────────────
  function handleFor(type: DesktopResourceType, node: string, name: string): string {
    const existing = db.prepare("SELECT id FROM desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?").get(type, node, name) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    db.prepare("INSERT OR IGNORE INTO desktop_resource_handles (id, resource_type, node_name, resource_name) VALUES (?, ?, ?, ?)").run(id, type, node, name);
    const row = db.prepare("SELECT id FROM desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?").get(type, node, name) as { id: string };
    return row.id;
  }
  function resolveHandle(id: string): { type: DesktopResourceType; node: string; name: string } | null {
    const row = db.prepare("SELECT resource_type, node_name, resource_name FROM desktop_resource_handles WHERE id = ?").get(id) as { resource_type: DesktopResourceType; node_name: string; resource_name: string } | undefined;
    return row ? { type: row.resource_type, node: row.node_name, name: row.resource_name } : null;
  }

  /** Build the full permission set for a resource for the calling user. */
  function permsFor(ctx: DesktopAuthContext, type: DesktopResourceType, name: string): DesktopResourcePermissions {
    const can = (perm: DesktopPerm) => deps.hasResourcePermission(ctx.userId, ctx.role, type, name, perm);
    return {
      canView: true,
      canConsole: can("console"),
      canPower: can("power"),
      canSnapshot: can("snapshot"),
      canModify: can("modify"),
      canDelete: can("delete"),
      canCreate: deps.userCanCreate(ctx.userId, ctx.role, type),
    };
  }

  function formatUptime(seconds?: number): string | undefined {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}j ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Resolve an opaque :id to a resource the caller may use at `perm`, else fail. */
  function requireResourceByHandle(ctx: DesktopAuthContext, rawId: unknown, perm: DesktopPerm) {
    const parsed = DesktopResourceIdSchema.safeParse(rawId);
    if (!parsed.success) fail(400, "Invalid resource id");
    const resolved = resolveHandle(parsed.data);
    // 404-as-403 obfuscation: don't reveal whether the handle exists.
    if (!resolved) fail(404, "Resource not found");
    if (!deps.hasResourcePermission(ctx.userId, ctx.role, resolved.type, resolved.name, perm)) {
      fail(403, "Forbidden");
    }
    return resolved;
  }

  const audit = (ctx: { userId?: number; username?: string } | null, req: FastifyRequest, action: string, opts: { resourceType?: string; resourceName?: string; result?: "success" | "error"; details?: string } = {}) => {
    auditLog(db, {
      userId: ctx?.userId ?? null,
      username: ctx?.username ?? null,
      ip: deps.getClientIp(req),
      action,
      resourceType: opts.resourceType,
      resourceName: opts.resourceName,
      result: opts.result ?? "success",
      details: opts.details,
    });
  };

  // Wrap a handler so thrown {statusCode} errors become clean JSON without leaks.
  const handle = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        const message = (err as { desktopError?: boolean }).desktopError ? (err as Error).message : "Internal error";
        if (status >= 500) req.log.error({ err }, "desktop api error");
        return reply.status(status).send({ error: message });
      }
    };

  const sensitiveRateLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };

  // ── AUTH ────────────────────────────────────────────────────────────────────
  app.post("/api/desktop/auth/login", sensitiveRateLimit, handle(async (req, reply) => {
    const parsed = DesktopLoginSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const { username, password, deviceName, deviceFingerprint, installationId } = parsed.data;
    const user = getUserByName.get(username) as UserRow | undefined;
    // Constant-ish path: always run a verify to reduce username enumeration timing.
    const ok = user && !user.suspended ? await argon2.verify(user.password_hash, password).catch(() => false) : await argon2.hash("dummy").then(() => false);
    if (!user || user.suspended || !ok) {
      audit(user ? { userId: user.id, username } : { username }, req, "desktop.login", { result: "error", details: "bad credentials" });
      fail(401, "Invalid credentials");
    }
    if (!isDesktopEnabledForUser(user.id)) {
      audit({ userId: user.id, username }, req, "desktop.login", { result: "error", details: "desktop disabled" });
      fail(403, "Virtua Desktop is disabled for this account");
    }
    const ip = deps.getClientIp(req);
    const { deviceId, created } = resolveDeviceForAuth(user.id, installationId, deviceName, deviceFingerprint, ip);
    const tokens = issueTokensForDevice(deviceId, user, ip);
    audit({ userId: user.id, username }, req, created ? "desktop.device.created" : "desktop.device.reused", { details: `device=${deviceId}${installationId ? " install=" + installationId : ""}` });
    return reply.send(tokens);
  }));

  app.post("/api/desktop/devices/pair", sensitiveRateLimit, handle(async (req, reply) => {
    const parsed = DesktopPairSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const { pairingCode, deviceName, deviceFingerprint, installationId } = parsed.data;
    const codeHash = sha256(pairingCode.trim().toUpperCase());
    const row = db.prepare("SELECT id, user_id, expires_at, used_at FROM desktop_pairing_codes WHERE code_hash = ?").get(codeHash) as { id: string; user_id: number; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      audit(null, req, "desktop.pair", { result: "error", details: "invalid or expired code" });
      fail(401, "Invalid or expired pairing code");
    }
    const user = getUserById.get(row.user_id) as UserRow | undefined;
    if (!user || user.suspended) fail(401, "Account unavailable");
    if (!isDesktopEnabledForUser(user.id)) fail(403, "Virtua Desktop is disabled for this account");
    db.prepare("UPDATE desktop_pairing_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
    const ip = deps.getClientIp(req);
    const { deviceId, created } = resolveDeviceForAuth(user.id, installationId, deviceName, deviceFingerprint, ip);
    const tokens = issueTokensForDevice(deviceId, user, ip);
    audit({ userId: user.id, username: user.username }, req, created ? "desktop.device.created" : "desktop.device.reused", { details: `device=${deviceId} via=pair${installationId ? " install=" + installationId : ""}` });
    return reply.send(tokens);
  }));

  app.post("/api/desktop/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const parsed = DesktopRefreshSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    const row = db.prepare("SELECT id, device_id, token_hash, expires_at, revoked FROM desktop_refresh_tokens WHERE token_hash = ?").get(tokenHash) as RefreshRow | undefined;
    if (!row || row.revoked || new Date(row.expires_at).getTime() < Date.now()) fail(401, "Invalid refresh token");
    const device = getDevice.get(row.device_id) as DeviceRow | undefined;
    if (!device || device.revoked) fail(401, "Device revoked");
    // If the client supplies an installationId, it must match the bound device.
    if (parsed.data.installationId && device.installation_id && parsed.data.installationId !== device.installation_id) {
      fail(401, "Installation mismatch");
    }
    // Idle beyond the window → auto-revoke and refuse.
    if (isDeviceExpired(device)) {
      revokeDevice(device.id);
      audit({ userId: device.user_id }, req, "desktop.device.revoked", { details: `device=${device.id} reason=idle-expired` });
      fail(401, "Device expired");
    }
    const user = getUserById.get(device.user_id) as UserRow | undefined;
    if (!user || user.suspended) fail(401, "Account unavailable");
    if (!isDesktopEnabledForUser(user.id)) fail(403, "Virtua Desktop is disabled for this account");
    // Rotate: revoke the presented token, mint a fresh pair (refresh TTL rolls to
    // 14 days from now) and renew last_seen_at (issueTokensForDevice touches it).
    db.prepare("UPDATE desktop_refresh_tokens SET revoked = 1 WHERE id = ?").run(row.id);
    const tokens = issueTokensForDevice(device.id, user, deps.getClientIp(req));
    audit({ userId: user.id, username: user.username }, req, "desktop.device.refreshed", { details: `device=${device.id}` });
    return reply.send(tokens);
  }));

  app.post("/api/desktop/auth/logout", handle(async (req, reply) => {
    const parsed = DesktopLogoutSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    const row = db.prepare("SELECT id, device_id FROM desktop_refresh_tokens WHERE token_hash = ?").get(tokenHash) as { id: string; device_id: string } | undefined;
    // Resolve the device from the token, or (fallback) from installationId if the
    // token is already gone but the client still wants to disconnect this device.
    let deviceId = row?.device_id;
    if (!deviceId && parsed.data.installationId) {
      // We don't know the user here (no bearer required for logout), so only act
      // when the refresh token resolves a device; an installationId alone is not
      // enough to revoke someone else's device.
      deviceId = undefined;
    }
    if (deviceId) {
      const device = getDevice.get(deviceId) as DeviceRow | undefined;
      // Logout = disconnect THIS device: revoke the device + all its refresh tokens.
      if (device && parsed.data.installationId && device.installation_id && parsed.data.installationId !== device.installation_id) {
        // Token/installation mismatch → don't revoke; just drop the presented token.
        if (row) db.prepare("UPDATE desktop_refresh_tokens SET revoked = 1 WHERE id = ?").run(row.id);
      } else {
        revokeDevice(deviceId);
        audit(device ? { userId: device.user_id } : null, req, "desktop.device.revoked", { details: `device=${deviceId} reason=logout` });
      }
    }
    return reply.send({ ok: true });
  }));

  // Mint a pairing code FROM THE WEB PANEL (uses the existing browser session).
  app.post("/api/desktop/pairing-codes", { config: { rateLimit: { max: 20, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const code = generatePairingCode();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    db.prepare("INSERT INTO desktop_pairing_codes (id, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, sha256(code), sessionUser.userId, expiresAt);
    audit({ userId: sessionUser.userId, username: sessionUser.username }, req, "desktop.pairing-code.create");
    return reply.send({ code, expiresInMs: PAIRING_TTL_MS });
  }));

  // List the web-session user's paired desktop devices (for the panel UI).
  app.get("/api/desktop/my-devices", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const rows = db.prepare(
      "SELECT id, name, installation_id, revoked, revoked_at, created_at, last_seen_at, last_ip FROM desktop_devices WHERE user_id = ? ORDER BY created_at DESC",
    ).all(sessionUser.userId) as Array<{ id: string; name: string; installation_id: string | null; revoked: number; revoked_at: string | null; created_at: string; last_seen_at: string | null; last_ip: string | null }>;
    return reply.send(rows.map((r) => ({
      id: r.id, name: r.name, installationId: r.installation_id, revoked: !!r.revoked,
      status: r.revoked ? "revoked" : "active",
      createdAt: r.created_at, revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at, lastIp: r.last_ip,
    })));
  }));

  // ── Account settings (per-user "Allow Virtua Desktop") ─────────────────────
  app.get("/api/desktop/account", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    return reply.send({ desktopEnabled: isDesktopEnabledForUser(sessionUser.userId) });
  }));

  app.put("/api/desktop/account", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const body = req.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") fail(400, "Body must include { enabled: boolean }");
    setDesktopEnabledForUser(sessionUser.userId, body.enabled);
    audit({ userId: sessionUser.userId, username: sessionUser.username }, req, body.enabled ? "desktop.account.enabled" : "desktop.account.disabled");
    return reply.send({ desktopEnabled: body.enabled });
  }));

  // Revoke ALL of the session user's desktop devices in one click (+ their tokens).
  app.post("/api/desktop/my-devices/revoke-all", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const devices = db.prepare("SELECT id FROM desktop_devices WHERE user_id = ? AND revoked = 0").all(sessionUser.userId) as Array<{ id: string }>;
    for (const d of devices) revokeDevice(d.id);
    audit({ userId: sessionUser.userId, username: sessionUser.username }, req, "desktop.device.revoked", { details: `revoke-all count=${devices.length}` });
    return reply.send({ ok: true, revoked: devices.length });
  }));

  // Hard-delete all REVOKED devices of the session user (clean up the list).
  app.post("/api/desktop/my-devices/purge-revoked", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const info = db.prepare("DELETE FROM desktop_devices WHERE user_id = ? AND revoked = 1").run(sessionUser.userId);
    audit({ userId: sessionUser.userId, username: sessionUser.username }, req, "desktop.device.purge", { details: `removed=${info.changes}` });
    return reply.send({ ok: true, removed: info.changes });
  }));

  // Revoke one of the session user's devices (instant cut-off + token revocation).
  app.delete("/api/desktop/my-devices/:id", handle(async (req, reply) => {
    const sessionUser = deps.getWebSessionUser(req);
    if (!sessionUser) fail(401, "Authentication required");
    const id = (req.params as { id: string }).id;
    const owned = db.prepare("SELECT id, revoked FROM desktop_devices WHERE id = ? AND user_id = ?").get(id, sessionUser.userId) as { id: string; revoked: number } | undefined;
    if (!owned) fail(404, "Device not found");
    if (owned.revoked) {
      // Already revoked → hard-delete it (removes it from the list + its tokens via cascade).
      db.prepare("DELETE FROM desktop_devices WHERE id = ?").run(id);
      audit({ userId: sessionUser.userId, username: sessionUser.username }, req, "desktop.device.delete", { details: `device=${id}` });
    } else {
      revokeDevice(id);
      audit({ userId: sessionUser.userId, username: sessionUser.username }, req, "desktop.device.revoked", { details: `device=${id}` });
    }
    return reply.send({ ok: true });
  }));

  // ── ME ────────────────────────────────────────────────────────────────────
  app.get("/api/desktop/me", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    touchDevice.run(deps.getClientIp(req), ctx.deviceId);
    const device = getDevice.get(ctx.deviceId) as DeviceRow;
    return reply.send({
      user: { id: ctx.userId, username: ctx.username, displayName: ctx.displayName, role: ctx.role },
      device: { id: device.id, name: device.name, createdAt: device.created_at, lastSeenAt: device.last_seen_at },
      capabilities: {
        isAdmin: ctx.role === "ADMIN",
        canCreate: {
          vm: deps.userCanCreate(ctx.userId, ctx.role, "vm"),
          lxc: deps.userCanCreate(ctx.userId, ctx.role, "lxc"),
          docker: deps.userCanCreate(ctx.userId, ctx.role, "docker"),
        },
      },
    });
  }));

  // ── RESOURCES ───────────────────────────────────────────────────────────────
  const serializeResource = (ctx: DesktopAuthContext, r: DesktopResourceRow) => {
    // qemu-guest-agent block — VMs only (recomputed live in listResourcesForDesktop).
    const guestAgent = r.type === "vm"
      ? {
          guestAgent: {
            installed: (r.qemuGuestAgentStatus ?? "unknown") !== "not-installed",
            running: r.qemuGuestAgentRunning ?? false,
            status: r.qemuGuestAgentStatus ?? "unknown",
          },
          qemuGuestAgentEnabled: r.qemuGuestAgentEnabled ?? false,
          qemuGuestAgentRunning: r.qemuGuestAgentRunning ?? false,
          qemuGuestAgentStatus: r.qemuGuestAgentStatus ?? "unknown",
        }
      : {};
    return {
      id: handleFor(r.type, r.node, r.name),
      type: r.type,
      name: r.name,
      displayName: r.displayName ?? r.name,
      state: r.state,
      node: r.node,
      cpuPercent: r.cpuPercent,
      memoryPercent: r.memoryPercent,
      ipAddress: r.ipAddress,
      ipAddresses: r.ipAddresses,
      uptimeSeconds: r.uptimeSeconds,
      uptime: formatUptime(r.uptimeSeconds),
      image: r.image,
      owner: r.owner,
      assignedUsers: r.assignedUsers,
      ...guestAgent,
      permissions: permsFor(ctx, r.type, r.name),
    };
  };

  app.get("/api/desktop/resources", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const all = await deps.listResourcesForDesktop();
    // Never expose a resource the caller can't view.
    const visible = all.filter((r) => deps.hasResourcePermission(ctx.userId, ctx.role, r.type, r.name, "view"));
    return reply.send(visible.map((r) => serializeResource(ctx, r)));
  }));

  // Catalog for the "new resource" form. Static route → matched before /:id.
  app.get("/api/desktop/resources/create-options", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const rawType = (req.query as { type?: string }).type;
    if (!rawType || !(DESKTOP_RESOURCE_TYPES as readonly string[]).includes(rawType)) {
      fail(400, "Query param 'type' must be one of: vm, lxc, docker");
    }
    const type = rawType as DesktopResourceType;
    // Only users who may create this type get a (useful) catalog.
    if (!deps.userCanCreate(ctx.userId, ctx.role, type)) fail(403, "Forbidden");
    const options = await deps.getCreateOptions(type);
    return reply.send(options);
  }));

  app.get("/api/desktop/resources/:id", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "view");
    const all = await deps.listResourcesForDesktop();
    const live = all.find((r) => r.type === res.type && r.node === res.node && r.name === res.name);
    const row: DesktopResourceRow = live ?? { type: res.type, node: res.node, name: res.name, state: "unknown" };
    return reply.send({ ...serializeResource(ctx, row), id: (req.params as { id: string }).id });
  }));

  // ── RESOURCE LIFECYCLE (create / update / delete) ───────────────────────────
  const lifecycleRateLimit = { config: { rateLimit: { max: 20, timeWindow: 60_000 } } };

  app.post("/api/desktop/resources", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const parsed = DesktopCreateResourceSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    const input = parsed.data;
    if (!deps.userCanCreate(ctx.userId, ctx.role, input.type)) {
      audit(ctx, req, `desktop.${input.type}.create`, { resourceType: input.type, resourceName: input.name, result: "error", details: "forbidden" });
      fail(403, "Forbidden");
    }
    try {
      const created = await deps.createResource(
        { userId: ctx.userId, role: ctx.role, username: ctx.username },
        input,
      );
      const id = handleFor(input.type, created.node, created.name);
      audit(ctx, req, `desktop.${input.type}.create`, { resourceType: input.type, resourceName: created.name });
      return reply.send({
        ok: true,
        resource: {
          id, type: input.type, name: created.name, displayName: created.displayName ?? created.name,
          node: created.node, state: "unknown", permissions: permsFor(ctx, input.type, created.name),
        },
      });
    } catch (err) {
      audit(ctx, req, `desktop.${input.type}.create`, { resourceType: input.type, resourceName: input.name, result: "error" });
      fail(502, (err as { desktopError?: boolean }).desktopError ? (err as Error).message : "Create failed");
    }
  }));

  app.patch("/api/desktop/resources/:id", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "modify");
    const parsed = DesktopUpdateResourceSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid request");
    try {
      const updated = await deps.updateResource(res, parsed.data, { userId: ctx.userId, role: ctx.role, username: ctx.username });
      // Keep the SAME opaque id stable across a rename: re-point the handle row
      // (renameDesktopResource already repointed it) and reuse the caller's id.
      const id = handleFor(res.type, updated.node, updated.name);
      audit(ctx, req, `desktop.${res.type}.update`, { resourceType: res.type, resourceName: updated.name, details: Object.keys(parsed.data).join(",") });
      const all = await deps.listResourcesForDesktop();
      const live = all.find((r) => r.type === res.type && r.node === updated.node && r.name === updated.name);
      const row: DesktopResourceRow = live ?? { type: res.type, node: updated.node, name: updated.name, state: "unknown" };
      return reply.send({ ok: true, resource: { ...serializeResource(ctx, row), id } });
    } catch (err) {
      audit(ctx, req, `desktop.${res.type}.update`, { resourceType: res.type, resourceName: res.name, result: "error" });
      const status = (err as { statusCode?: number }).statusCode ?? 502;
      fail(status, (err as { desktopError?: boolean }).desktopError ? (err as Error).message : "Update failed");
    }
  }));

  app.delete("/api/desktop/resources/:id", lifecycleRateLimit, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "delete");
    try {
      await deps.deleteResource(res, { userId: ctx.userId, role: ctx.role });
      audit(ctx, req, `desktop.${res.type}.delete`, { resourceType: res.type, resourceName: res.name });
      return reply.send({ ok: true });
    } catch (err) {
      audit(ctx, req, `desktop.${res.type}.delete`, { resourceType: res.type, resourceName: res.name, result: "error" });
      fail(502, (err as { desktopError?: boolean }).desktopError ? (err as Error).message : "Delete failed");
    }
  }));

  // ── TASKS (recent server-side operations) ───────────────────────────────────
  app.get("/api/desktop/tasks", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    return reply.send(deps.listRecentTasks(ctx.userId, ctx.role));
  }));

  // Single task by id (for clients that poll an async operation to completion).
  app.get("/api/desktop/tasks/:taskId", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const task = deps.getTask(ctx.userId, ctx.role, (req.params as { taskId: string }).taskId);
    if (!task) fail(404, "Task not found");
    return reply.send(task);
  }));

  // ── ACTIONS ───────────────────────────────────────────────────────────────
  const powerAction = (action: "start" | "stop" | "restart") => handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "power");
    try {
      const result = await deps.runResourceAction(res.type, res.node, res.name, action);
      audit(ctx, req, `desktop.${res.type}.${action}`, { resourceType: res.type, resourceName: res.name });
      return reply.send({ ok: true, result });
    } catch (err) {
      audit(ctx, req, `desktop.${res.type}.${action}`, { resourceType: res.type, resourceName: res.name, result: "error" });
      fail(502, "Action failed");
    }
  });
  app.post("/api/desktop/resources/:id/actions/start", powerAction("start"));
  app.post("/api/desktop/resources/:id/actions/stop", powerAction("stop"));
  app.post("/api/desktop/resources/:id/actions/restart", powerAction("restart"));

  app.post("/api/desktop/resources/:id/actions/snapshot", handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "snapshot");
    if (res.type === "docker") fail(400, "Snapshots are not supported for Docker containers");
    const parsed = DesktopSnapshotSchema.safeParse(req.body);
    if (!parsed.success) fail(400, "Invalid snapshot request");
    try {
      const result = await deps.createSnapshotForResource(res.type, res.node, res.name, parsed.data);
      audit(ctx, req, `desktop.${res.type}.snapshot`, { resourceType: res.type, resourceName: res.name, details: parsed.data.name });
      return reply.send({ ok: true, result });
    } catch (err) {
      audit(ctx, req, `desktop.${res.type}.snapshot`, { resourceType: res.type, resourceName: res.name, result: "error" });
      fail(502, "Snapshot failed");
    }
  }));

  // ── CONSOLE TICKETS (one-time, short-lived) ─────────────────────────────────
  app.post("/api/desktop/resources/:id/console/text-ticket", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "console");
    const ticket = await deps.issueConsoleTicket(req, { type: res.type, node: res.node, name: res.name, mode: "text", userId: ctx.userId, deviceId: ctx.deviceId });
    audit(ctx, req, `desktop.${res.type}.console.text`, { resourceType: res.type, resourceName: res.name });
    return reply.send({ ticket: ticket.ticketId, url: ticket.url, expiresInMs: ticket.ttlMs, kind: "text" });
  }));

  app.post("/api/desktop/resources/:id/console/graphical-ticket", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "console");
    if (res.type !== "vm") fail(400, "Graphical console is only available for VMs");
    const ticket = await deps.issueConsoleTicket(req, { type: res.type, node: res.node, name: res.name, mode: "graphical", userId: ctx.userId, deviceId: ctx.deviceId });
    audit(ctx, req, `desktop.${res.type}.console.graphical`, { resourceType: res.type, resourceName: res.name });
    return reply.send({ ticket: ticket.ticketId, url: ticket.url, expiresInMs: ticket.ttlMs, kind: "graphical" });
  }));

  app.post("/api/desktop/resources/:id/console/spice-ticket", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, handle(async (req, reply) => {
    const ctx = authDesktop(req);
    const res = requireResourceByHandle(ctx, (req.params as { id: string }).id, "console");
    if (res.type !== "vm") fail(400, "SPICE console is only available for VMs");
    const ticket = await deps.issueConsoleTicket(req, { type: res.type, node: res.node, name: res.name, mode: "spice", userId: ctx.userId, deviceId: ctx.deviceId });
    audit(ctx, req, `desktop.${res.type}.console.spice`, { resourceType: res.type, resourceName: res.name });
    return reply.send({ ticket: ticket.ticketId, url: ticket.url, expiresInMs: ticket.ttlMs, kind: "spice" });
  }));
}
