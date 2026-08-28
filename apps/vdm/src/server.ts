import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import * as argon2 from "argon2";
import { validatePassword } from "@auxinux/shared";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { getDb, getSetting, setSetting, DATA_DIR } from "./db.js";
import { fetchNode, tryFetchNode, pingNode, type VdmNodeRow } from "./nodeClient.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { parseLogSettings, serializeLogSettings, shouldLog, recordVdmLog, purgeOldLogs, LOG_SETTINGS_KEY, type VdmLogLevel, type VdmLogCategory, type VdmLogSettings } from "./logs.js";

declare module "@fastify/session" {
  interface FastifySessionObject {
    userId?: number;
    username?: string;
    role?: string;
    mustChangePassword?: boolean;
  }
}

const PORT = parseInt(process.env.AUXINUX_VDM_PORT ?? "8440");
const SESSION_SECRET = process.env.AUXINUX_VDM_SESSION_SECRET ?? "auxinux-vdm-dev-secret-change-in-production!";
const APP_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const UI_DIST_DIR = path.join(APP_ROOT, "apps", "vdm-ui", "dist");

if (SESSION_SECRET === "auxinux-vdm-dev-secret-change-in-production!") {
  console.warn("[vdm] WARNING: Using default session secret. Set AUXINUX_VDM_SESSION_SECRET for production!");
}

// ── Types ──────────────────────────────────────────────────────────────────
interface VdmSharedStorageRow {
  id: number;
  name: string;
  display_name: string | null;
  type: string;
  source: string;
  mount_options: string | null;
  smb_domain: string | null;
  smb_username: string | null;
  smb_password: string | null;
  smb_version: string | null;
  nfs_version: string | null;
  s3_endpoint: string | null;
  s3_bucket: string | null;
  s3_region: string | null;
  s3_access_key: string | null;
  s3_secret_key: string | null;
  s3_provider: string | null;
  s3_vfs_cache_mode: string | null;
  local_mount_path: string;
  content: string;
  enabled: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface VdmTaskRow {
  id: string;
  kind: string;
  label: string;
  source_node: string | null;
  target_node: string | null;
  resource_type: string | null;
  resource_name: string | null;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
  result: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  operation_key: string | null;
  attempt: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  recovery_data: string | null;
}

interface VdmJoinTokenRow {
  id: number;
  token: string;
  note: string | null;
  expires_at: string;
  created_at: string;
}

interface VdmBackupRepositoryRow {
  id: number;
  name: string;
  display_name: string | null;
  storage_name: string;
  enabled: number;
  encryption_enabled: number;
  retention_daily: number;
  retention_weekly: number;
  retention_monthly: number;
  quota_bytes: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface VdmBackupItemRow {
  id: string;
  repository_id: number;
  task_id: string | null;
  resource_type: string;
  resource_name: string;
  source_node: string;
  filename: string;
  relative_path: string;
  size_bytes: number;
  format: string;
  compression: string | null;
  checksum_sha256: string | null;
  verified_at: string | null;
  status: string;
  metadata: string | null;
  created_at: string;
}

const app = Fastify({ logger: { level: "info" }, trustProxy: process.env.AUXINUX_VDM_TRUST_PROXY === "1" });
const db = getDb();
const INSTANCE_ID = process.env.AUXINUX_VDM_INSTANCE_ID?.trim() || randomUUID();
const CLUSTER_ID = process.env.AUXINUX_VDM_CLUSTER_ID?.trim() || "standalone";
const INSTANCE_ROLE = process.env.AUXINUX_VDM_ROLE?.trim() || "active";
const MIN_VIRTUA_VERSION = process.env.AUXINUX_VDM_MIN_VIRTUA_VERSION?.trim() || "0.7.33";
const RESOURCE_LOCK_TTL_MS = Math.max(60_000, Number(process.env.AUXINUX_VDM_LOCK_TTL_MS ?? 24 * 60 * 60_000));
const LONG_OPERATION_TIMEOUT_MS = Math.max(60_000, Number(process.env.AUXINUX_VDM_LONG_OPERATION_TIMEOUT_MS ?? 4 * 60 * 60_000));
const TERMINAL_TASK_STATUSES = new Set(["completed", "completed-with-warning", "failed", "cancelled"]);

// ── Ensure default admin user on first boot ────────────────────────────────
const adminCount = (db.prepare("SELECT COUNT(*) as c FROM vdm_users WHERE role = 'admin'").get() as { c: number }).c;
if (adminCount === 0) {
  const hash = await argon2.hash("admin123");
  db.prepare("INSERT INTO vdm_users (username, password_hash, role, display_name, must_change_password) VALUES (?, ?, ?, ?, 1)").run("admin", hash, "admin", "Administrator");
  console.log("[vdm] Default admin user created — username: admin, password: admin123 — CHANGE IMMEDIATELY");
}

// ── Plugins ────────────────────────────────────────────────────────────────
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: SESSION_SECRET,
  cookieName: "vdm_session",
  cookie: {
    secure: process.env.AUXINUX_VDM_SECURE_COOKIE === "1",
    httpOnly: true,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
  saveUninitialized: false,
});
await app.register(fastifyCsrf, { sessionPlugin: "@fastify/session" });
await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: "1 minute" });

// Serve VDM UI static files if dist exists
if (fs.existsSync(UI_DIST_DIR)) {
  await app.register(fastifyStatic, { root: UI_DIST_DIR, wildcard: false });
}

// ── Auth helpers ──────────────────────────────────────────────────────────
function requireAuth(req: FastifyRequest, reply: FastifyReply): void {
  if (!req.session.userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): void {
  requireAuth(req, reply);
  if (req.session.role !== "admin") {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

// ── Task helpers ──────────────────────────────────────────────────────────
function createTask(opts: {
  kind: string;
  label: string;
  sourceNode?: string;
  targetNode?: string;
  resourceType?: string;
  resourceName?: string;
  createdBy?: string;
}): VdmTaskRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  const nodeNames = [...new Set([opts.sourceNode, opts.targetNode].filter((value): value is string => !!value))];
  if (nodeNames.length === 0) nodeNames.push("cluster");
  const operationKeys = opts.resourceType && opts.resourceName ? nodeNames.map((nodeName) => `${opts.resourceType}:${nodeName}:${opts.resourceName}`) : [];
  const operationKey = operationKeys[0] ?? null;
  const expiresAt = new Date(Date.now() + RESOURCE_LOCK_TTL_MS).toISOString();
  db.transaction(() => {
    if (operationKeys.length > 0) {
      db.prepare("DELETE FROM vdm_resource_locks WHERE expires_at <= ?").run(now);
      for (const key of operationKeys) {
        const existing = db.prepare("SELECT operation, task_id FROM vdm_resource_locks WHERE resource_key = ?").get(key) as { operation: string; task_id: string } | undefined;
        if (existing) throw Object.assign(new Error(`Resource busy: ${existing.operation} (${existing.task_id})`), { statusCode: 409 });
      }
    }
    db.prepare(`
      INSERT INTO vdm_tasks (id, kind, label, source_node, target_node, resource_type, resource_name, status, progress, created_by, created_at, updated_at, operation_key, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
    `).run(id, opts.kind, opts.label, opts.sourceNode ?? null, opts.targetNode ?? null, opts.resourceType ?? null, opts.resourceName ?? null, opts.createdBy ?? null, now, now, operationKey, now);
    for (const key of operationKeys) {
      db.prepare("INSERT INTO vdm_resource_locks (resource_key, task_id, operation, owner_instance, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(key, id, opts.kind, INSTANCE_ID, now, expiresAt);
    }
  })();
  return db.prepare("SELECT * FROM vdm_tasks WHERE id = ?").get(id) as VdmTaskRow;
}

function updateTask(id: string, status: string, progress: number, message?: string, error?: string, result?: unknown): void {
  const now = new Date().toISOString();
  const terminal = TERMINAL_TASK_STATUSES.has(status);
  const taskMeta = db.prepare("SELECT kind, source_node, resource_type, resource_name FROM vdm_tasks WHERE id = ?").get(id) as { kind: string; source_node: string | null; resource_type: string | null; resource_name: string | null } | undefined;
  if (terminal && error && taskMeta) {
    const kind = taskMeta.kind ?? "";
    const category: VdmLogCategory = /backup/i.test(kind) ? "backup" : /migrat/i.test(kind) ? "migration" : /storage/i.test(kind) ? "storage" : "system";
    recordVdmLog(db, "error", taskMeta.source_node || "vdm", category, `${kind} ${taskMeta.resource_type ?? ""} ${taskMeta.resource_name ?? ""} failed: ${error}`.replace(/\s+/g, " ").trim());
  }
  db.transaction(() => {
    db.prepare(`UPDATE vdm_tasks SET status = ?, progress = ?, message = ?, error = ?, result = ?, updated_at = ?, heartbeat_at = ?,
      started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
      finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`)
      .run(status, Math.max(0, Math.min(100, progress)), message ?? null, error ?? null, result !== undefined ? JSON.stringify(result) : null, now, now, status, now, terminal ? 1 : 0, now, id);
    if (terminal) db.prepare("DELETE FROM vdm_resource_locks WHERE task_id = ?").run(id);
    else db.prepare("UPDATE vdm_resource_locks SET expires_at = ? WHERE task_id = ?").run(new Date(Date.now() + RESOURCE_LOCK_TTL_MS).toISOString(), id);
  })();
}

function recoverInterruptedTasks(): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE vdm_tasks SET status = 'recovery-required', error = COALESCE(error, 'VDM restarted while this task was active'), updated_at = ?
      WHERE status IN ('pending', 'running')`).run(now);
    db.prepare("DELETE FROM vdm_resource_locks").run();
  })();
}

recoverInterruptedTasks();

function getNode(name: string): VdmNodeRow | undefined {
  return db.prepare("SELECT * FROM vdm_nodes WHERE name = ?").get(name) as VdmNodeRow | undefined;
}

function getEnabledNode(name: string): VdmNodeRow {
  const node = getNode(name);
  if (!node) throw Object.assign(new Error(`Node ${name} not found`), { statusCode: 404 });
  if (!node.enabled) throw Object.assign(new Error(`Node ${name} is disabled`), { statusCode: 400 });
  return node;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function assertNodeApiUrl(value: string): void {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) throw new Error("invalid");
  } catch {
    throw Object.assign(new Error("Node API URL must be an http(s) URL without embedded credentials"), { statusCode: 400 });
  }
}

// ── Console relay: short-lived VDM tickets → upstream node WS ────────────────
interface VdmConsoleTicket { node: string; kind: "term" | "vnc" | "spice"; nodeTicket: string; expiresAt: number; uses?: number; }
const consoleTickets = new Map<string, VdmConsoleTicket>();
const CONSOLE_TICKET_TTL_MS = 30_000;

function issueConsoleTicket(node: string, kind: "term" | "vnc" | "spice", nodeTicket: string): string {
  const id = randomUUID();
  consoleTickets.set(id, { node, kind, nodeTicket, expiresAt: Date.now() + CONSOLE_TICKET_TTL_MS });
  return id;
}
function consumeConsoleTicket(id: string | null): VdmConsoleTicket | null {
  if (!id) return null;
  const t = consoleTickets.get(id);
  if (!t) return null;
  if (Date.now() > t.expiresAt) { consoleTickets.delete(id); return null; }
  // SPICE opens several protocol channels with the same URL. Keep its bounded
  // ticket reusable while terminal and VNC tickets remain strictly one-time.
  if (t.kind === "spice") {
    t.uses = (t.uses ?? 0) + 1;
    if (t.uses >= 16) consoleTickets.delete(id);
  } else {
    consoleTickets.delete(id);
  }
  return t;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of consoleTickets) if (now > t.expiresAt) consoleTickets.delete(id);
}, 60_000).unref();

/** Ask a node for a console/vnc ticket, then wrap it in a one-time VDM ticket. */
async function relayConsoleTicket(node: VdmNodeRow, internalPath: string, kind: "term" | "vnc" | "spice"): Promise<{ ticket: string; kind: "term" | "vnc" | "spice"; password?: string }> {
  const res = await fetchNode<{ ticket: string; password?: string }>(node, internalPath, { method: "POST", body: JSON.stringify({}) });
  if (!res?.ticket) throw new Error("Node did not return a console ticket");
  return { ticket: issueConsoleTicket(node.name, kind, res.ticket), kind, ...(res.password ? { password: res.password } : {}) };
}

function shouldReplaceNodeDisplayName(currentDisplayName: string | null, nodeName: string): boolean {
  if (!currentDisplayName) return true;
  if (currentDisplayName === nodeName) return true;
  return /^node\s+\d+$/i.test(currentDisplayName);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function syncNodeState(node: VdmNodeRow): Promise<boolean> {
  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const summary = await fetchNode<Record<string, unknown>>(node, "/api/internal/node/summary");
    const summaryNode = (summary.node ?? {}) as Record<string, unknown>;
    const remoteDisplayName = `${summaryNode.displayName ?? ""}`.trim() || `${summaryNode.name ?? ""}`.trim() || null;
    const virtuaVersion = `${summary.virtuaVersion ?? summaryNode.version ?? ""}`.trim() || null;
    const compatibility = virtuaVersion && compareVersions(virtuaVersion, MIN_VIRTUA_VERSION) >= 0 ? "compatible" : virtuaVersion ? "incompatible" : "unknown";

    const newStatus = compatibility === "incompatible" ? "degraded" : "online";
    db.prepare("UPDATE vdm_nodes SET status = ?, last_seen_at = ?, display_name = COALESCE(?, display_name), virtua_version = ?, compatibility = ?, last_error = NULL, failure_count = 0, latency_ms = ?, updated_at = ? WHERE id = ?")
      .run(
        newStatus,
        now,
        shouldReplaceNodeDisplayName(node.display_name, node.name) ? remoteDisplayName : null,
        virtuaVersion,
        compatibility,
        Date.now() - startedAt,
        now,
        node.id,
      );
    if (node.status !== "online" && newStatus === "online") {
      recordVdmLog(db, "info", node.name, "nodes", `Node back online (v${virtuaVersion ?? "?"})`);
    }
    return true;
  } catch (error) {
    const failures = (node.failure_count ?? 0) + 1;
    const status = failures >= 2 ? "offline" : "degraded";
    const message = error instanceof Error ? error.message : "Node request failed";
    db.prepare("UPDATE vdm_nodes SET status = ?, last_error = ?, failure_count = ?, latency_ms = ?, updated_at = ? WHERE id = ?")
      .run(status, message, failures, Date.now() - startedAt, now, node.id);
    // Log transitions only, so a persistently offline node doesn't flood the log.
    if (node.status !== status) {
      recordVdmLog(db, status === "offline" ? "error" : "warn", node.name, "nodes", `Node ${status}: ${message}`);
    }
    return false;
  }
}

async function syncEnabledNodes(): Promise<void> {
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1").all() as VdmNodeRow[];
  const concurrency = Math.max(1, Math.min(10, Number(process.env.AUXINUX_VDM_HEARTBEAT_CONCURRENCY ?? 4)));
  for (let index = 0; index < nodes.length; index += concurrency) {
    await Promise.allSettled(nodes.slice(index, index + concurrency).map((node) => syncNodeState(node)));
  }
}

function mapStorageRow(row: VdmSharedStorageRow) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    source: row.source,
    mountOptions: row.mount_options,
    smbDomain: row.smb_domain,
    smbUsername: row.smb_username,
    smbVersion: row.smb_version,
    nfsVersion: row.nfs_version,
    s3Endpoint: row.s3_endpoint,
    s3Bucket: row.s3_bucket,
    s3Region: row.s3_region,
    s3Provider: row.s3_provider,
    s3VfsCacheMode: row.s3_vfs_cache_mode,
    // Secrets are never returned to the client; only an indicator that they're set.
    s3Configured: !!(row.s3_access_key && row.s3_secret_key),
    localMountPath: row.local_mount_path,
    content: JSON.parse(row.content || "[]"),
    enabled: !!row.enabled,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNodeRow(row: VdmNodeRow) {
  return {
    id: row.id, name: row.name, displayName: row.display_name ?? row.name, apiUrl: row.api_url,
    enabled: !!row.enabled, status: row.status, lastSeenAt: row.last_seen_at,
    virtuaVersion: row.virtua_version ?? null, compatibility: row.compatibility ?? "unknown",
    lastError: row.last_error ?? null, failureCount: row.failure_count ?? 0, latencyMs: row.latency_ms ?? null,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapTaskRow(row: VdmTaskRow) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    sourceNode: row.source_node,
    targetNode: row.target_node,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    operationKey: row.operation_key,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    recoveryData: row.recovery_data ? JSON.parse(row.recovery_data) : undefined,
  };
}

function mapJoinTokenRow(row: VdmJoinTokenRow) {
  return {
    id: row.id,
    token: row.token,
    note: row.note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ── Ensure shared storage is mounted on a node ────────────────────────────
async function ensureStorageMountedOnNode(node: VdmNodeRow, storage: VdmSharedStorageRow): Promise<string> {
  if (!storage.enabled) throw new Error(`Shared storage ${storage.name} is disabled`);
  // Check if a pool with this name already exists on the node
  const localPools = await fetchNode<Array<{ name: string; path?: string; type?: string; mountSource?: string; mounted?: boolean }>>(node, "/api/internal/storage/pools");
  const existing = localPools.find((p) => p.name === storage.name);
  if (existing) {
    if (existing.path && existing.path !== storage.local_mount_path) throw new Error(`Storage ${storage.name} path mismatch on ${node.name}`);
    // Network/FUSE pools (NFS/SMB/GlusterFS/S3) can be registered in the node DB
    // while their mount died (rclone daemon gone, NFS timeout). If the node
    // reports the actual mount state and it is down, recreate the pool to remount.
    const networkTypes = new Set(["nfs", "nfs4", "cifs", "smbfs", "glusterfs", "s3"]);
    if (networkTypes.has(existing.type ?? "") && existing.mounted === false) {
      recordVdmLog(db, "warn", node.name, "storage", `Storage ${storage.name} registered but not mounted on ${node.name} — remounting`);
      await fetchNode(node, `/api/internal/storage/pools/${encodeURIComponent(storage.name)}`, { method: "DELETE" });
    } else {
      return storage.name;
    }
  }

  // Mount it by creating a storage pool on the node
  const nodeStorageType = storage.type === "smb" ? "cifs" : storage.type;
  const isS3 = nodeStorageType === "s3";
  // S3 safety: vfs-cache-mode "off" mounts read-only (rclone forbids seek),
  // which breaks any backup write (qemu-img seeks the output file). Backup
  // pools must use at least "writes" — escalate transparently and log it.
  const contents = JSON.parse(storage.content || "[]") as string[];
  let s3VfsCacheMode = storage.s3_vfs_cache_mode ?? undefined;
  if (isS3 && contents.includes("backup") && (!s3VfsCacheMode || s3VfsCacheMode === "off")) {
    s3VfsCacheMode = "writes";
    // Persist the escalation so the warning is not re-emitted on every remount.
    db.prepare("UPDATE vdm_shared_storage SET s3_vfs_cache_mode = 'writes', updated_at = ? WHERE name = ?")
      .run(new Date().toISOString(), storage.name);
    recordVdmLog(db, "warn", "vdm", "storage", `S3 storage ${storage.name}: VFS cache "off" cannot store backups — switched to "writes" (edit the storage to change this)`);
  }
  try {
    await fetchNode(node, "/api/internal/storage/pools", {
    method: "POST",
    timeoutMs: 120_000,
    body: JSON.stringify({
      name: storage.name,
      path: storage.local_mount_path,
      type: nodeStorageType,
      content: JSON.parse(storage.content),
      // S3 pools mount via rclone: no fstab source/fstype (rejected by the node schema).
      mountSource: isS3 ? undefined : (storage.source ?? undefined),
      fstype: isS3 ? undefined : nodeStorageType,
      mountOptions: storage.mount_options ?? undefined,
      smbDomain: storage.smb_domain ?? undefined,
      smbUsername: storage.smb_username ?? undefined,
      smbPassword: storage.smb_password ? decryptSecret(storage.smb_password) : undefined,
      smbVersion: storage.smb_version ?? undefined,
      nfsVersion: storage.nfs_version ?? undefined,
      s3Endpoint: storage.s3_endpoint ?? undefined,
      s3Bucket: storage.s3_bucket ?? undefined,
      s3Region: storage.s3_region ?? undefined,
      s3AccessKey: storage.s3_access_key ? decryptSecret(storage.s3_access_key) : undefined,
      s3SecretKey: storage.s3_secret_key ? decryptSecret(storage.s3_secret_key) : undefined,
      s3Provider: storage.s3_provider ?? undefined,
      s3VfsCacheMode,
    }),
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mount request failed";
    recordVdmLog(db, "error", node.name, "storage", `Mount failed for ${storage.name} (${storage.type}) on ${node.name}: ${message}`);
    throw error;
  }
  return storage.name;
}

function getOrCreateBackupRepository(storageName: string): VdmBackupRepositoryRow {
  const storage = db.prepare("SELECT name, display_name FROM vdm_shared_storage WHERE name = ? AND enabled = 1").get(storageName) as { name: string; display_name: string | null } | undefined;
  if (!storage) throw Object.assign(new Error("Enabled shared storage not found"), { statusCode: 404 });
  db.prepare(`INSERT OR IGNORE INTO vdm_backup_repositories (name, display_name, storage_name)
    VALUES (?, ?, ?)`)
    .run(storage.name, storage.display_name ?? `${storage.name} backups`, storage.name);
  const repository = db.prepare("SELECT * FROM vdm_backup_repositories WHERE storage_name = ? ORDER BY id LIMIT 1").get(storage.name) as VdmBackupRepositoryRow;
  if (!repository.enabled) throw new Error(`Backup repository ${repository.name} is disabled`);
  if (repository.quota_bytes) {
    const used = (db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM vdm_backup_items WHERE repository_id = ? AND status != 'deleted'").get(repository.id) as { bytes: number }).bytes;
    if (used >= repository.quota_bytes) throw new Error(`Backup repository ${repository.name} quota reached`);
  }
  return repository;
}

function mapBackupRepository(row: VdmBackupRepositoryRow) {
  return {
    id: row.id, name: row.name, displayName: row.display_name ?? row.name, storageName: row.storage_name,
    enabled: !!row.enabled, encryptionEnabled: !!row.encryption_enabled,
    retentionDaily: row.retention_daily, retentionWeekly: row.retention_weekly, retentionMonthly: row.retention_monthly,
    quotaBytes: row.quota_bytes, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapBackupItem(row: VdmBackupItemRow) {
  return {
    id: row.id, repositoryId: row.repository_id, taskId: row.task_id, resourceType: row.resource_type,
    resourceName: row.resource_name, sourceNode: row.source_node, filename: row.filename,
    relativePath: row.relative_path, sizeBytes: row.size_bytes, format: row.format,
    compression: row.compression, checksumSha256: row.checksum_sha256, verifiedAt: row.verified_at,
    status: row.status, metadata: row.metadata ? JSON.parse(row.metadata) : undefined, createdAt: row.created_at,
  };
}

async function recordBackupItem(opts: {
  repository: VdmBackupRepositoryRow;
  taskId: string;
  resourceType: "vm" | "lxc";
  resourceName: string;
  sourceNode: VdmNodeRow;
  filename: string;
  sizeBytes?: number;
  format: string;
  compression?: string;
}): Promise<VdmBackupItemRow> {
  const remote = await tryFetchNode<Array<{ id: string; filename: string; sizeBytes: number; createdAt: string }>>(
    opts.sourceNode,
    `/api/internal/backups?resourceType=${opts.resourceType}&resourceName=${encodeURIComponent(opts.resourceName)}`,
    [],
  );
  const remoteBackup = remote.find((entry) => entry.filename === opts.filename);
  const id = randomUUID();
  const metadata = JSON.stringify({ remoteBackupId: remoteBackup?.id ?? null, virtuaVersion: opts.sourceNode.virtua_version ?? null });
  db.prepare(`INSERT INTO vdm_backup_items
    (id, repository_id, task_id, resource_type, resource_name, source_node, filename, relative_path, size_bytes, format, compression, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`)
    .run(id, opts.repository.id, opts.taskId, opts.resourceType, opts.resourceName, opts.sourceNode.name, opts.filename,
      `backups/${opts.filename}`, opts.sizeBytes ?? remoteBackup?.sizeBytes ?? 0, opts.format, opts.compression ?? null, metadata);
  return db.prepare("SELECT * FROM vdm_backup_items WHERE id = ?").get(id) as VdmBackupItemRow;
}

async function validateRestoredResource(node: VdmNodeRow, resourceType: "vm" | "lxc", name: string): Promise<void> {
  await fetchNode(node, `/api/internal/${resourceType === "vm" ? "vms" : "lxc"}/${encodeURIComponent(name)}`, { timeoutMs: 30_000, retries: 2 });
}

async function runScheduledBackup(job: { id: string; repository_id: number; resource_type: string; resource_name: string; source_node: string; compress: number }): Promise<void> {
  const repository = db.prepare("SELECT * FROM vdm_backup_repositories WHERE id = ? AND enabled = 1").get(job.repository_id) as VdmBackupRepositoryRow | undefined;
  if (!repository) throw new Error("Backup repository unavailable");
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ? AND enabled = 1").get(repository.storage_name) as VdmSharedStorageRow | undefined;
  if (!storage) throw new Error("Shared storage unavailable");
  const node = getEnabledNode(job.source_node);
  const resourceType = job.resource_type as "vm" | "lxc";
  const task = createTask({ kind: "backup", label: `Scheduled backup ${resourceType.toUpperCase()} ${job.resource_name}`, sourceNode: node.name, resourceType, resourceName: job.resource_name, createdBy: "scheduler" });
  try {
    updateTask(task.id, "running", 10, "Mounting backup repository...");
    const pool = await ensureStorageMountedOnNode(node, storage);
    updateTask(task.id, "running", 30, "Running scheduled backup...");
    const endpoint = resourceType === "vm" ? "vms" : "lxc";
    const result = await fetchNode<{ filename: string; sizeBytes: number }>(node, `/api/internal/${endpoint}/${encodeURIComponent(job.resource_name)}/backup`, {
      method: "POST", timeoutMs: 4 * 60 * 60_000,
      body: JSON.stringify({ storagePool: pool, format: "tar.gz", compress: !!job.compress }),
    });
    const item = await recordBackupItem({ repository, taskId: task.id, resourceType, resourceName: job.resource_name, sourceNode: node, filename: result.filename, sizeBytes: result.sizeBytes, format: "tar.gz", compression: job.compress ? "automatic" : "none" });
    updateTask(task.id, "completed", 100, "Scheduled backup complete", undefined, { item: mapBackupItem(item), jobId: job.id });
    await pruneBackupRepository(repository.id).catch((error) => app.log.warn({ err: error, repository: repository.name }, "backup retention prune failed"));
  } catch (error) {
    updateTask(task.id, "failed", 0, undefined, error instanceof Error ? error.message : "Scheduled backup failed");
  }
}

function retentionBucket(date: Date, kind: "daily" | "weekly" | "monthly"): string {
  if (kind === "daily") return date.toISOString().slice(0, 10);
  if (kind === "monthly") return date.toISOString().slice(0, 7);
  const firstDay = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - firstDay.getTime()) / 86_400_000) + firstDay.getUTCDay() + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function pruneBackupRepository(repositoryId: number): Promise<{ deleted: number; failed: number; kept: number }> {
  const repository = db.prepare("SELECT * FROM vdm_backup_repositories WHERE id = ?").get(repositoryId) as VdmBackupRepositoryRow | undefined;
  if (!repository) throw new Error("Repository not found");
  const items = db.prepare("SELECT * FROM vdm_backup_items WHERE repository_id = ? AND status != 'deleted' ORDER BY created_at DESC").all(repositoryId) as VdmBackupItemRow[];
  const keep = new Set<string>();
  const selectBuckets = (kind: "daily" | "weekly" | "monthly", limit: number) => {
    const buckets = new Set<string>();
    for (const item of items) {
      if (buckets.size >= limit) break;
      const key = retentionBucket(new Date(item.created_at), kind);
      if (buckets.has(key)) continue;
      buckets.add(key);
      keep.add(item.id);
    }
  };
  selectBuckets("daily", repository.retention_daily);
  selectBuckets("weekly", repository.retention_weekly);
  selectBuckets("monthly", repository.retention_monthly);
  let deleted = 0;
  let failed = 0;
  for (const item of items) {
    if (keep.has(item.id)) continue;
    try {
      const metadata = item.metadata ? JSON.parse(item.metadata) as { remoteBackupId?: string | null } : {};
      const remoteId = metadata.remoteBackupId?.split(":").pop();
      if (!remoteId) throw new Error("Remote backup identifier unavailable");
      await fetchNode(getEnabledNode(item.source_node), `/api/internal/backups/${encodeURIComponent(remoteId)}`, { method: "DELETE", timeoutMs: 60_000 });
      db.prepare("DELETE FROM vdm_backup_items WHERE id = ?").run(item.id);
      deleted += 1;
    } catch (error) {
      db.prepare("UPDATE vdm_backup_items SET status = 'delete-failed', metadata = ? WHERE id = ?")
        .run(JSON.stringify({ ...(item.metadata ? JSON.parse(item.metadata) : {}), retentionError: error instanceof Error ? error.message : "Delete failed" }), item.id);
      failed += 1;
    }
  }
  return { deleted, failed, kept: keep.size };
}

async function runDueBackupJobs(): Promise<void> {
  if (INSTANCE_ROLE !== "active") return;
  const now = new Date();
  const jobs = db.prepare("SELECT * FROM vdm_backup_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 10")
    .all(now.toISOString()) as Array<{ id: string; repository_id: number; resource_type: string; resource_name: string; source_node: string; compress: number; schedule: string | null }>;
  for (const job of jobs) {
    let intervalMinutes = 1440;
    try { intervalMinutes = Math.max(5, Math.min(10080, Number((JSON.parse(job.schedule ?? "{}") as { intervalMinutes?: number }).intervalMinutes ?? 1440))); } catch { /* default */ }
    const next = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
    const claimed = db.prepare("UPDATE vdm_backup_jobs SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at <= ?")
      .run(now.toISOString(), next, now.toISOString(), job.id, now.toISOString());
    if (claimed.changes > 0) void runScheduledBackup(job);
  }
}

setInterval(() => { void runDueBackupJobs(); }, 30_000).unref();

// ── Background heartbeat ──────────────────────────────────────────────────
void syncEnabledNodes();
setInterval(() => { void syncEnabledNodes(); }, 30_000).unref();
if (CLUSTER_ID !== "standalone" && INSTANCE_ROLE === "active") {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const otherLeader = db.prepare("SELECT instance_id FROM vdm_instances WHERE cluster_id = ? AND role = 'active' AND instance_id != ? AND last_heartbeat >= ? LIMIT 1")
    .get(CLUSTER_ID, INSTANCE_ID, cutoff) as { instance_id: string } | undefined;
  if (otherLeader) throw new Error(`Refusing active role: VDM instance ${otherLeader.instance_id} is already active in cluster ${CLUSTER_ID}`);
}
const updateInstanceHeartbeat = () => {
  db.prepare(`INSERT INTO vdm_instances (instance_id, cluster_id, role, leader_epoch, last_heartbeat, metadata)
    VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET role = excluded.role, last_heartbeat = excluded.last_heartbeat, metadata = excluded.metadata`)
    .run(INSTANCE_ID, CLUSTER_ID, INSTANCE_ROLE, new Date().toISOString(), JSON.stringify({ version: "0.7.54", pid: process.pid }));
};
updateInstanceHeartbeat();
setInterval(updateInstanceHeartbeat, 10_000).unref();

// ── Error handler ─────────────────────────────────────────────────────────
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const code = err.statusCode ?? 500;
  if (code >= 500) app.log.error(err);
  const pathname = req.url.split("?")[0];
  // Only 5xx are operational incidents worth logging. 4xx (401 Unauthorized on
  // /auth/me before login, 403, 404, validation) are normal client states and
  // would otherwise flood the LOGS page with noise.
  if (code >= 500) {
    const category: VdmLogCategory = pathname.includes("/storage") ? "storage"
      : pathname.includes("/backup") ? "backup"
      : pathname.includes("/migrat") ? "migration"
      : pathname.includes("/node") ? "nodes"
      : "system";
    recordVdmLog(db, "error", "vdm", category, `${req.method} ${pathname} → ${code}: ${err.message}`.slice(0, 2000));
  }
  const isProduction = process.env.NODE_ENV === "production";
  const clientMessage = code >= 500 && isProduction ? "Internal Server Error" : err.message;
  return reply.status(code).send({ error: clientMessage });
});

app.addHook("preHandler", async (req, reply) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const pathname = req.url.split("?")[0];
  if (pathname === "/api/vdm/join") return;
  if (pathname === "/api/vdm/auth/login" || pathname === "/api/vdm/auth/logout") {
    await app.csrfProtection(req, reply, () => {});
    return;
  }
  if (INSTANCE_ROLE !== "active") return reply.status(503).send({ error: "VDM standby instance is read-only", role: INSTANCE_ROLE });
  if (req.session.mustChangePassword && !pathname.startsWith("/api/vdm/auth/")) return reply.status(403).send({ error: "Password change required" });
  const resourceMatch = pathname.match(/^\/api\/vdm\/(vms|lxc|docker)\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (resourceMatch && !["console-ticket", "vnc-ticket"].includes(resourceMatch[4] ?? "")) {
    const type = resourceMatch[1] === "vms" ? "vm" : resourceMatch[1];
    const key = `${type}:${decodeURIComponent(resourceMatch[2])}:${decodeURIComponent(resourceMatch[3])}`;
    const lock = db.prepare("SELECT operation, task_id FROM vdm_resource_locks WHERE resource_key = ? AND expires_at > ?").get(key, new Date().toISOString()) as { operation: string; task_id: string } | undefined;
    if (lock) return reply.status(409).send({ error: `Resource busy: ${lock.operation}`, taskId: lock.task_id });
  }
  await app.csrfProtection(req, reply, () => {});
});

app.addHook("onResponse", async (req, reply) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  db.prepare("INSERT INTO vdm_audit_log (username, method, path, status_code, remote_address) VALUES (?, ?, ?, ?, ?)")
    .run(req.session.username ?? null, req.method, req.url.split("?")[0], reply.statusCode, req.ip);
});

app.get("/api/vdm/health", async (_req, reply) => {
  const nodes = db.prepare("SELECT status, COUNT(*) AS count FROM vdm_nodes WHERE enabled = 1 GROUP BY status").all() as Array<{ status: string; count: number }>;
  const recoveryRequired = (db.prepare("SELECT COUNT(*) AS count FROM vdm_tasks WHERE status = 'recovery-required'").get() as { count: number }).count;
  const unhealthy = nodes.some((row) => row.status === "offline") || recoveryRequired > 0;
  return reply.status(unhealthy ? 503 : 200).send({
    ok: !unhealthy,
    version: "0.7.54",
    role: INSTANCE_ROLE,
    clusterId: CLUSTER_ID,
    database: "sqlite",
    nodes: Object.fromEntries(nodes.map((row) => [row.status, row.count])),
    recoveryRequired,
  });
});

app.get("/api/vdm/audit", async (req, reply) => {
  requireAdmin(req, reply);
  const limit = parseBoundedInt((req.query as { limit?: unknown }).limit, 200, 1, 1000);
  return db.prepare("SELECT id, username, method, path, status_code AS statusCode, remote_address AS remoteAddress, created_at AS createdAt FROM vdm_audit_log ORDER BY id DESC LIMIT ?").all(limit);
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/auth/csrf", async (req, reply) => {
  return { token: await reply.generateCsrf() };
});

app.post("/api/vdm/auth/login", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (req, reply) => {
  const { username, password } = req.body as { username: string; password: string };
  if (!username || !password) return reply.status(400).send({ error: "Missing credentials" });

  const row = db.prepare("SELECT * FROM vdm_users WHERE username = ?").get(username) as { id: number; username: string; password_hash: string; role: string; display_name: string | null; must_change_password: number } | undefined;
  if (!row) {
    await argon2.hash("dummy"); // timing safety
    return reply.status(401).send({ error: "Invalid credentials" });
  }
  const valid = await argon2.verify(row.password_hash, password);
  if (!valid) return reply.status(401).send({ error: "Invalid credentials" });

  req.session.userId = row.id;
  req.session.username = row.username;
  req.session.role = row.role;
  req.session.mustChangePassword = !!row.must_change_password;
  await req.session.save();
  return { ok: true, user: { id: row.id, username: row.username, role: row.role, displayName: row.display_name, mustChangePassword: !!row.must_change_password } };
});

app.post("/api/vdm/auth/logout", async (req) => {
  req.session.destroy();
  return { ok: true };
});

app.get("/api/vdm/auth/me", async (req, reply) => {
  requireAuth(req, reply);
  const row = db.prepare("SELECT id, username, role, display_name, must_change_password FROM vdm_users WHERE id = ?").get(req.session.userId!) as { id: number; username: string; role: string; display_name: string | null; must_change_password: number } | undefined;
  if (!row) return reply.status(401).send({ error: "Session invalid" });
  req.session.mustChangePassword = !!row.must_change_password;
  return { id: row.id, username: row.username, role: row.role, displayName: row.display_name, mustChangePassword: !!row.must_change_password };
});

// Change own password
app.post("/api/vdm/auth/change-password", async (req, reply) => {
  requireAuth(req, reply);
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  const pwCheck = validatePassword(newPassword);
  if (!pwCheck.ok) return reply.status(400).send({ error: pwCheck.error });
  const row = db.prepare("SELECT password_hash FROM vdm_users WHERE id = ?").get(req.session.userId!) as { password_hash: string } | undefined;
  if (!row) return reply.status(404).send({ error: "User not found" });
  if (!await argon2.verify(row.password_hash, currentPassword)) return reply.status(401).send({ error: "Wrong current password" });
  db.prepare("UPDATE vdm_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?").run(await argon2.hash(newPassword), new Date().toISOString(), req.session.userId!);
  req.session.mustChangePassword = false;
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGER JOIN TOKENS
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/join-tokens", async (req, reply) => {
  requireAdmin(req, reply);
  const rows = db.prepare("SELECT * FROM vdm_join_tokens WHERE expires_at >= datetime('now') ORDER BY created_at DESC").all() as VdmJoinTokenRow[];
  return rows.map(mapJoinTokenRow);
});

app.post("/api/vdm/join-tokens", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { note?: string; expiresInMinutes?: number };
  const note = body.note?.trim() || null;
  const expiresInMinutes = Math.min(Math.max(Math.trunc(body.expiresInMinutes ?? 60), 5), 7 * 24 * 60);
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
  const result = db.prepare("INSERT INTO vdm_join_tokens (token, note, expires_at) VALUES (?, ?, ?)").run(token, note, expiresAt);
  const row = db.prepare("SELECT * FROM vdm_join_tokens WHERE id = ?").get(result.lastInsertRowid) as VdmJoinTokenRow;
  return reply.status(201).send(mapJoinTokenRow(row));
});

app.delete("/api/vdm/join-tokens/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const id = Number((req.params as { id: string }).id);
  const result = db.prepare("DELETE FROM vdm_join_tokens WHERE id = ?").run(id);
  if (result.changes === 0) return reply.status(404).send({ error: "Join token not found" });
  return { ok: true };
});

app.post("/api/vdm/join", {
  config: { csrfProtection: false },
}, async (req, reply) => {
  const body = (req.body ?? {}) as {
    token?: string;
    name?: string;
    displayName?: string;
    apiUrl?: string;
    authToken?: string;
  };
  const token = body.token?.trim() || "";
  const name = body.name?.trim() || "";
  const displayNameInput = body.displayName?.trim() || null;
  const apiUrl = body.apiUrl?.trim() || "";
  const authToken = body.authToken?.trim() || "";

  if (!token || !name || !apiUrl || !authToken) {
    return reply.status(400).send({ error: "token, name, apiUrl and authToken are required" });
  }
  assertNodeApiUrl(apiUrl);
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return reply.status(400).send({ error: "Invalid node name" });
  }

  const joinToken = db.prepare("SELECT * FROM vdm_join_tokens WHERE token = ? AND expires_at >= datetime('now')").get(token) as VdmJoinTokenRow | undefined;
  if (!joinToken) {
    return reply.status(403).send({ error: "Invalid or expired join token" });
  }

  const testNode: VdmNodeRow = {
    id: 0,
    name,
    display_name: displayNameInput,
    api_url: apiUrl,
    auth_token: authToken,
    enabled: 1,
    status: "unknown",
    last_seen_at: null,
    notes: null,
    created_at: "",
    updated_at: "",
  };

  let remoteDisplayName = displayNameInput;
  try {
    const summary = await fetchNode<Record<string, unknown>>(testNode, "/api/internal/node/summary");
    const summaryNode = (summary.node ?? {}) as Record<string, unknown>;
    remoteDisplayName = `${summaryNode.displayName ?? ""}`.trim() || `${summaryNode.name ?? ""}`.trim() || displayNameInput;
  } catch {
    return reply.status(400).send({ error: "Unable to reach node internal API with provided URL/token" });
  }

  db.prepare(`
    INSERT INTO vdm_nodes (name, display_name, api_url, auth_token, enabled, status, last_seen_at, notes, updated_at)
    VALUES (?, ?, ?, ?, 1, 'online', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      api_url = excluded.api_url,
      auth_token = excluded.auth_token,
      enabled = 1,
      status = 'online',
      last_seen_at = excluded.last_seen_at,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    name,
    remoteDisplayName,
    apiUrl,
    encryptSecret(authToken),
    new Date().toISOString(),
    "Joined from Node settings",
    new Date().toISOString(),
  );

  const saved = getNode(name);
  if (saved) await syncNodeState(saved);
  db.prepare("DELETE FROM vdm_join_tokens WHERE id = ?").run(joinToken.id);
  return { ok: true, node: saved ? mapNodeRow(saved) : null };
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/summary", async (req, reply) => {
  requireAuth(req, reply);
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1").all() as VdmNodeRow[];
  const summaries = await Promise.all(
    nodes.map(async (node) => {
      const summary = await tryFetchNode<Record<string, unknown>>(node, "/api/internal/node/summary", {});
      const remoteNode = (summary.node ?? {}) as Record<string, unknown>;
      const info = (summary.systemInfo ?? {}) as Record<string, unknown>;
      const stats = (summary.systemStats ?? {}) as Record<string, unknown>;
      const memory = (stats.mem ?? {}) as Record<string, unknown>;
      const remoteResources = (summary.resources ?? {}) as Record<string, unknown>;
      const count = (value: unknown) => typeof value === "number" ? value : Number((value as { total?: number } | undefined)?.total ?? 0);
      return {
        ...summary,
        node: { ...remoteNode, name: node.name, displayName: node.display_name ?? node.name, status: node.status, lastSeenAt: node.last_seen_at },
        systemInfo: {
          ...info,
          hostname: String(info.hostname ?? node.name),
          os: String(info.os ?? ""),
          kernel: String(info.kernel ?? ""),
          cpuModel: String(info.cpuModel ?? ""),
          cpuCores: Number(stats.cpuCount ?? info.cpuCores ?? 0),
          memoryTotal: Number(memory.total ?? info.memoryTotal ?? 0),
        },
        systemStats: {
          cpuUsagePercent: Number(stats.cpuUsage ?? stats.cpuUsagePercent ?? 0),
          memoryUsedBytes: Number(memory.used ?? stats.memoryUsedBytes ?? 0),
          memoryTotalBytes: Number(memory.total ?? stats.memoryTotalBytes ?? 0),
          loadAvg: (stats.loadavg ?? stats.loadAvg ?? []) as number[],
        },
        resources: { vms: count(remoteResources.vms), lxc: count(remoteResources.lxc), docker: count(remoteResources.docker) },
      };
    }),
  );
  const totalTasks = (db.prepare("SELECT COUNT(*) as c FROM vdm_tasks WHERE status IN ('pending','running')").get() as { c: number }).c;
  return { nodes: summaries, activeTasks: totalTasks };
});

// ═══════════════════════════════════════════════════════════════════════════
// NODE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/nodes", async (req, reply) => {
  requireAuth(req, reply);
  const rows = db.prepare("SELECT * FROM vdm_nodes ORDER BY name ASC").all() as VdmNodeRow[];
  return rows.map(mapNodeRow);
});

app.post("/api/vdm/nodes", async (req, reply) => {
  requireAdmin(req, reply);
  const { name, displayName, apiUrl, authToken, notes } = req.body as {
    name: string; displayName?: string; apiUrl: string; authToken: string; notes?: string;
  };
  if (!name || !apiUrl || !authToken) return reply.status(400).send({ error: "name, apiUrl, authToken required" });
  assertNodeApiUrl(apiUrl);
  if (!/^[a-z0-9_-]+$/.test(name)) return reply.status(400).send({ error: "Name must be lowercase alphanumeric with - or _" });

  // Probe the node before saving
  const testNode: VdmNodeRow = { id: 0, name, display_name: null, api_url: apiUrl, auth_token: authToken, enabled: 1, status: "unknown", last_seen_at: null, notes: null, created_at: "", updated_at: "" };
  const alive = await pingNode(testNode);

  try {
    db.prepare(`
      INSERT INTO vdm_nodes (name, display_name, api_url, auth_token, status, last_seen_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, displayName ?? null, apiUrl, encryptSecret(authToken), alive ? "online" : "offline", alive ? new Date().toISOString() : null, notes ?? null);
  } catch {
    return reply.status(409).send({ error: "Node name already registered" });
  }
  if (alive) {
    const saved = getNode(name);
    if (saved) await syncNodeState(saved);
  }
  return reply.status(201).send(mapNodeRow(getNode(name)!));
});

app.get("/api/vdm/nodes/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = getNode(name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  return { name: node.name, displayName: node.display_name ?? node.name, apiUrl: node.api_url, status: node.status, lastSeenAt: node.last_seen_at, notes: node.notes, enabled: !!node.enabled };
});

app.put("/api/vdm/nodes/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const { displayName, apiUrl, authToken, enabled, notes } = req.body as { displayName?: string; apiUrl?: string; authToken?: string; enabled?: boolean; notes?: string };
  const node = getNode(name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (apiUrl) assertNodeApiUrl(apiUrl);
  db.prepare("UPDATE vdm_nodes SET display_name = COALESCE(?, display_name), api_url = COALESCE(?, api_url), auth_token = COALESCE(?, auth_token), enabled = COALESCE(?, enabled), notes = COALESCE(?, notes), updated_at = ? WHERE name = ?")
    .run(displayName ?? null, apiUrl ?? null, authToken ? encryptSecret(authToken) : null, enabled !== undefined ? (enabled ? 1 : 0) : null, notes ?? null, new Date().toISOString(), name);
  return { ok: true };
});

app.delete("/api/vdm/nodes/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const result = db.prepare("DELETE FROM vdm_nodes WHERE name = ?").run(name);
  if (result.changes === 0) return reply.status(404).send({ error: "Node not found" });
  return { ok: true };
});

app.post("/api/vdm/nodes/:name/ping", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  const alive = await syncNodeState(node);
  return { online: alive };
});

app.get("/api/vdm/nodes/:name/summary", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return fetchNode(node, "/api/internal/node/summary");
});

app.get("/api/vdm/nodes/:name/system", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return fetchNode(node, "/api/internal/system/info");
});

app.get("/api/vdm/nodes/:name/storage", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return fetchNode(node, "/api/internal/storage/pools");
});

// ── Per-node catalogs (used by the create wizards) ──────────────────────────
app.get("/api/vdm/nodes/:name/isos", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return tryFetchNode(node, "/api/internal/storage/isos", []);
});
app.get("/api/vdm/nodes/:name/lxc-templates", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return tryFetchNode(node, "/api/internal/lxc/templates", []);
});
app.get("/api/vdm/nodes/:name/docker-images", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return tryFetchNode(node, "/api/internal/docker/images", []);
});
app.get("/api/vdm/nodes/:name/bridges", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return tryFetchNode(node, "/api/internal/network/bridges", []);
});
app.get("/api/vdm/nodes/:name/docker-networks", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  return tryFetchNode(node, "/api/internal/docker/networks", []);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES (Cloud) — the node is the source of truth. VDM only lists & uses
// them; it NEVER uploads, edits or deletes templates (admin does that per-node).
// ═══════════════════════════════════════════════════════════════════════════

function templateQueryString(req: FastifyRequest): string {
  const { type, arch } = req.query as { type?: string; arch?: string };
  const params = new URLSearchParams();
  if (type === "iso" || type === "vm") params.set("type", type);
  if (arch === "amd64" || arch === "arm64") params.set("arch", arch);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Restricted templates are admin-only in Cloud mode; public ones list for all. */
function filterTemplatesForRole(list: Array<Record<string, unknown>>, role: string | undefined) {
  if (role === "admin") return list;
  return list.filter((t) => t.visibility === "public");
}

// Aggregate templates across all enabled nodes (tagged with nodeName).
app.get("/api/vdm/templates", async (req, reply) => {
  requireAuth(req, reply);
  const qs = templateQueryString(req);
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 ORDER BY name ASC").all() as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const templates = await fetchNode<Array<Record<string, unknown>>>(node, `/api/internal/templates${qs}`);
      return templates.map((t) => ({ ...t, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  const flat = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return filterTemplatesForRole(flat, req.session.role);
});

app.get("/api/vdm/nodes/:name/templates", async (req, reply) => {
  requireAuth(req, reply);
  const node = getEnabledNode((req.params as { name: string }).name);
  const list = await tryFetchNode<Array<Record<string, unknown>>>(node, `/api/internal/templates${templateQueryString(req)}`, []);
  return filterTemplatesForRole(list, req.session.role);
});

// Create a VM from a template/ISO on a specific node (task-tracked on the node).
app.post("/api/vdm/resources/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const node = getEnabledNode((req.params as { node: string }).node);
  return fetchNode(node, "/api/internal/resources", {
    method: "POST",
    headers: { "x-auxinux-actor": req.session.username ?? "vdm" },
    body: JSON.stringify(req.body ?? {}),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VMs — list all nodes + per-node detail
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/vms", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeFilter } = req.query as { node?: string };
  const nodes = db.prepare(`SELECT * FROM vdm_nodes WHERE enabled = 1 ${nodeFilter ? "AND name = ?" : ""} ORDER BY name ASC`).all(...(nodeFilter ? [nodeFilter] : [])) as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const vms = await fetchNode<unknown[]>(node, "/api/internal/vms");
      return (vms as Record<string, unknown>[]).map((vm) => ({ ...vm, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
});

app.get("/api/vdm/vms/:node/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}`);
});

app.get("/api/vdm/vms/:node/:name/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  const raw = await fetchNode<Record<string, unknown>>(node, `/api/internal/vms/${encodeURIComponent(name)}/stats`);
  return {
    ...raw,
    cpuUsagePercent: Number(raw.cpuPercent ?? 0),
    memoryUsedMb: Number(raw.memoryUsedKiB ?? 0) / 1024,
    memoryTotalMb: Number(raw.balloonCurrentKiB ?? raw.balloonMaxKiB ?? 0) / 1024,
    diskReadBytes: Number(raw.blockRdBytes ?? 0),
    diskWriteBytes: Number(raw.blockWrBytes ?? 0),
    netRxBytes: Number(raw.netRxBytes ?? 0),
    netTxBytes: Number(raw.netTxBytes ?? 0),
  };
});

app.get("/api/vdm/vms/:node/:name/snapshots", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshots`);
});

const VM_ALLOWED_ACTIONS = new Set(["start", "stop", "reboot", "pause", "resume", "shutdown", "reset", "suspend", "forceStop"]);

app.post("/api/vdm/vms/:node/:name/action", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { action } = req.body as { action: string };
  if (!action) return reply.status(400).send({ error: "action required" });
  if (!VM_ALLOWED_ACTIONS.has(action)) return reply.status(400).send({ error: `Invalid action. Allowed: ${[...VM_ALLOWED_ACTIONS].join(", ")}` });
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: "POST" });
});

app.post("/api/vdm/vms/:node/:name/snapshot", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/create`, {
    method: "POST",
    body: JSON.stringify(req.body),
  });
});

app.post("/api/vdm/vms/:node/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, snap } = req.params as { node: string; name: string; snap: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}/rollback`, { method: "POST" });
});

app.delete("/api/vdm/vms/:node/:name/snapshot/:snap", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, snap } = req.params as { node: string; name: string; snap: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}`, { method: "DELETE" });
});

// Backup to shared storage
app.post("/api/vdm/vms/:node/:name/backup", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { sharedStorageName, format = "tar.gz", compress = true } = req.body as { sharedStorageName: string; format?: string; compress?: boolean };
  if (!sharedStorageName) return reply.status(400).send({ error: "sharedStorageName required" });

  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(sharedStorageName) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Shared storage not found" });

  const node = getEnabledNode(nodeName);
  const task = createTask({ kind: "backup", label: `Backup VM ${name} → ${sharedStorageName}`, sourceNode: nodeName, resourceType: "vm", resourceName: name, createdBy: req.session.username });

  // Run async
  void (async () => {
    try {
      updateTask(task.id, "running", 10, "Mounting shared storage on source node...");
      const poolName = await ensureStorageMountedOnNode(node, storage);
      updateTask(task.id, "running", 30, "Backing up VM disk...");
      const result = await fetchNode<{ filename: string; sizeBytes: number }>(node, `/api/internal/vms/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({ storagePool: poolName, format, compress }),
      });
      const repository = getOrCreateBackupRepository(sharedStorageName);
      const item = await recordBackupItem({ repository, taskId: task.id, resourceType: "vm", resourceName: name, sourceNode: node, filename: result.filename, sizeBytes: result.sizeBytes, format, compression: compress ? "automatic" : "none" });
      updateTask(task.id, "completed", 100, "Backup complete and catalogued", undefined, { backup: result, item: mapBackupItem(item) });
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Backup failed");
    }
  })();

  return reply.status(202).send(mapTaskRow(task));
});

// Clone VM (same or different node)
app.post("/api/vdm/vms/:node/:name/clone", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { newName, targetNode: targetNodeName } = req.body as { newName: string; targetNode?: string };
  if (!newName) return reply.status(400).send({ error: "newName required" });

  const sourceNode = getEnabledNode(nodeName);
  const task = createTask({ kind: "clone", label: `Clone VM ${name} → ${newName}`, sourceNode: nodeName, targetNode: targetNodeName ?? nodeName, resourceType: "vm", resourceName: name, createdBy: req.session.username });

  void (async () => {
    try {
      if (!targetNodeName || targetNodeName === nodeName) {
        // Same-node clone
        updateTask(task.id, "running", 20, "Cloning VM on same node...");
        const result = await fetchNode(sourceNode, `/api/internal/vms/${encodeURIComponent(name)}/clone`, {
          method: "POST",
          timeoutMs: LONG_OPERATION_TIMEOUT_MS,
          body: JSON.stringify({ newName }),
        });
        updateTask(task.id, "completed", 100, "Clone complete", undefined, result);
      } else {
        // Cross-node clone via shared storage — requires shared storage
        updateTask(task.id, "failed", 0, undefined, "Cross-node clone requires a shared storage — use backup+restore workflow");
      }
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Clone failed");
    }
  })();

  return reply.status(202).send(mapTaskRow(task));
});

// Migrate VM (offline, via shared storage)
app.post("/api/vdm/vms/:node/:name/migrate", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: sourceNodeName, name } = req.params as { node: string; name: string };
  const { targetNode: targetNodeName, sharedStorageName, deleteSource = true } = req.body as { targetNode: string; sharedStorageName: string; deleteSource?: boolean };
  if (!targetNodeName) return reply.status(400).send({ error: "targetNode required" });
  if (!sharedStorageName) return reply.status(400).send({ error: "sharedStorageName required — VDM migration requires shared network storage (NFS/SMB)" });
  if (sourceNodeName === targetNodeName) return reply.status(400).send({ error: "Source and target nodes must be different" });

  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(sharedStorageName) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Shared storage not found" });

  const sourceNode = getEnabledNode(sourceNodeName);
  const targetNode = getEnabledNode(targetNodeName);
  const task = createTask({ kind: "migrate", label: `Migrate VM ${name}: ${sourceNodeName} → ${targetNodeName}`, sourceNode: sourceNodeName, targetNode: targetNodeName, resourceType: "vm", resourceName: name, createdBy: req.session.username });

  void (async () => {
    try {
      updateTask(task.id, "running", 5, "Mounting shared storage on source node...");
      const sourcePoolName = await ensureStorageMountedOnNode(sourceNode, storage);

      updateTask(task.id, "running", 15, "Mounting shared storage on target node...");
      const targetPoolName = await ensureStorageMountedOnNode(targetNode, storage);

      updateTask(task.id, "running", 20, "Creating backup on source node...");
      const backupResult = await fetchNode<{ filename: string; sizeBytes: number }>(sourceNode, `/api/internal/vms/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({ storagePool: sourcePoolName, format: "tar.gz", compress: false }),
      });
      const repository = getOrCreateBackupRepository(sharedStorageName);
      await recordBackupItem({ repository, taskId: task.id, resourceType: "vm", resourceName: name, sourceNode, filename: backupResult.filename, sizeBytes: backupResult.sizeBytes, format: "tar.gz", compression: "none" });

      updateTask(task.id, "running", 55, "Restoring VM on target node...");
      await fetchNode(targetNode, `/api/internal/vms/${encodeURIComponent(name)}/restore-backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({
          sourcePath: `${storage.local_mount_path}/backups/${backupResult.filename}`,
          storagePool: targetPoolName,
          name,
        }),
      });

      updateTask(task.id, "running", 80, "Validating restored VM on target node...");
      await validateRestoredResource(targetNode, "vm", name);

      if (deleteSource) {
        updateTask(task.id, "running", 90, "Removing VM from source node...");
        try {
          await fetchNode(sourceNode, `/api/internal/vms/${encodeURIComponent(name)}?deleteDisks=true`, { method: "DELETE" });
        } catch (error) {
          updateTask(task.id, "completed-with-warning", 100, `VM restored on ${targetNodeName}, but source cleanup failed`, error instanceof Error ? error.message : "Source cleanup failed", { targetNode: targetNodeName, sourceRetained: true });
          return;
        }
      }

      updateTask(task.id, "completed", 100, `Migration complete. VM ${name} is now on ${targetNodeName}`);
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Migration failed");
    }
  })();

  return reply.status(202).send(mapTaskRow(task));
});

// Delete VM
app.delete("/api/vdm/vms/:node/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { deleteDisks = true } = req.query as { deleteDisks?: boolean };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}?deleteDisks=${deleteDisks}`, { method: "DELETE" });
});

// Create a VM on a node (task-tracked — template/disk provisioning is slow).
app.post("/api/vdm/vms/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  const body = req.body as { name?: string };
  const task = createTask({ kind: "create", label: `Create VM ${body?.name ?? ""} on ${nodeName}`, targetNode: nodeName, resourceType: "vm", resourceName: body?.name, createdBy: req.session.username });
  void (async () => {
    try {
      updateTask(task.id, "running", 20, "Creating virtual machine...");
      const result = await fetchNode(node, "/api/internal/vms", { method: "POST", timeoutMs: LONG_OPERATION_TIMEOUT_MS, body: JSON.stringify(req.body) });
      updateTask(task.id, "completed", 100, "VM created", undefined, result);
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Create failed");
    }
  })();
  return reply.status(202).send(mapTaskRow(task));
});

app.get("/api/vdm/vms/:node/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { tail: rawTail = 200 } = req.query as { tail?: number | string };
  const tail = parseBoundedInt(rawTail, 200, 1, 5000);
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/logs?tail=${encodeURIComponent(String(tail))}`);
});

app.put("/api/vdm/vms/:node/:name/config", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/config`, { method: "PUT", body: JSON.stringify(req.body) });
});

app.post("/api/vdm/vms/:node/:name/iso/:op", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, op } = req.params as { node: string; name: string; op: string };
  if (op !== "attach" && op !== "eject") return reply.status(400).send({ error: "op must be attach or eject" });
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/iso/${op}`, { method: "POST", body: JSON.stringify(req.body ?? {}) });
});

app.post("/api/vdm/vms/:node/:name/repair-disk", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/vms/${encodeURIComponent(name)}/repair-disk`, { method: "POST" });
});

// Console relay tickets (text serial + graphical VNC for VMs)
app.post("/api/vdm/vms/:node/:name/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return relayConsoleTicket(node, `/api/internal/vms/${encodeURIComponent(name)}/console-ticket`, "term");
});
app.post("/api/vdm/vms/:node/:name/vnc-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return relayConsoleTicket(node, `/api/internal/vms/${encodeURIComponent(name)}/vnc-ticket`, "vnc");
});
app.post("/api/vdm/vms/:node/:name/spice-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return relayConsoleTicket(node, `/api/internal/vms/${encodeURIComponent(name)}/spice-ticket`, "spice");
});

app.get("/api/vdm/vms/:node/:name/rdp-info", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  return fetchNode(getEnabledNode(nodeName), `/api/internal/vms/${encodeURIComponent(name)}/rdp-info`);
});
app.post("/api/vdm/vms/:node/:name/rdp-prepare", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  return fetchNode(getEnabledNode(nodeName), `/api/internal/vms/${encodeURIComponent(name)}/rdp-prepare`, { method: "POST", body: JSON.stringify({}) });
});
app.get("/api/vdm/vms/:node/:name/rdp-file", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  const info = await fetchNode<{ ready?: boolean; xrdpPort?: number; consoleWidth?: number; consoleHeight?: number; warnings?: string[] }>(node, `/api/internal/vms/${encodeURIComponent(name)}/rdp-info`);
  if (!info.ready || !info.xrdpPort) return reply.status(409).send({ error: "RDP console is not ready", warnings: info.warnings ?? [] });
  const host = new URL(node.api_url).hostname;
  const address = `${host}:${info.xrdpPort}`;
  const body = [
    `full address:s:${address}`, "screen mode id:i:1", "use multimon:i:0",
    `desktopwidth:i:${info.consoleWidth ?? 1440}`, `desktopheight:i:${info.consoleHeight ?? 900}`,
    "dynamic resolution:i:0", "smart sizing:i:1", "session bpp:i:32", "compression:i:0",
    "keyboardhook:i:2", "audiomode:i:2", "redirectclipboard:i:1", "redirectprinters:i:0",
    "redirectsmartcards:i:0", "authentication level:i:2", "enablecredsspsupport:i:1",
    "prompt for credentials:i:1", "username:s:na", "",
  ].join("\r\n");
  return reply.header("Content-Type", "application/x-rdp")
    .header("Content-Disposition", `attachment; filename="virtua-${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.rdp"`)
    .send(body);
});

// ═══════════════════════════════════════════════════════════════════════════
// LXC — list all nodes + per-node detail
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/lxc", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeFilter } = req.query as { node?: string };
  const nodes = db.prepare(`SELECT * FROM vdm_nodes WHERE enabled = 1 ${nodeFilter ? "AND name = ?" : ""} ORDER BY name ASC`).all(...(nodeFilter ? [nodeFilter] : [])) as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const containers = await fetchNode<unknown[]>(node, "/api/internal/lxc");
      return (containers as Record<string, unknown>[]).map((ct) => ({ ...ct, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
});

app.get("/api/vdm/lxc/:node/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}`);
});

app.get("/api/vdm/lxc/:node/:name/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/stats`);
});

app.get("/api/vdm/lxc/:node/:name/snapshots", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshots`);
});

const LXC_ALLOWED_ACTIONS = new Set(["start", "stop", "restart", "reboot", "pause", "resume", "freeze", "unfreeze"]);

app.post("/api/vdm/lxc/:node/:name/action", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { action } = req.body as { action: string };
  if (!action) return reply.status(400).send({ error: "action required" });
  if (!LXC_ALLOWED_ACTIONS.has(action)) return reply.status(400).send({ error: `Invalid action. Allowed: ${[...LXC_ALLOWED_ACTIONS].join(", ")}` });
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: "POST" });
});

app.post("/api/vdm/lxc/:node/:name/snapshot", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/create`, {
    method: "POST",
    body: JSON.stringify(req.body),
  });
});

app.post("/api/vdm/lxc/:node/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, snap } = req.params as { node: string; name: string; snap: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}/rollback`, { method: "POST" });
});

app.delete("/api/vdm/lxc/:node/:name/snapshot/:snap", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, snap } = req.params as { node: string; name: string; snap: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}`, { method: "DELETE" });
});

app.post("/api/vdm/lxc/:node/:name/backup", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { sharedStorageName, compress = true } = req.body as { sharedStorageName: string; compress?: boolean };
  if (!sharedStorageName) return reply.status(400).send({ error: "sharedStorageName required" });

  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(sharedStorageName) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Shared storage not found" });

  const node = getEnabledNode(nodeName);
  const task = createTask({ kind: "backup", label: `Backup LXC ${name} → ${sharedStorageName}`, sourceNode: nodeName, resourceType: "lxc", resourceName: name, createdBy: req.session.username });

  void (async () => {
    try {
      updateTask(task.id, "running", 10, "Mounting shared storage...");
      const poolName = await ensureStorageMountedOnNode(node, storage);
      updateTask(task.id, "running", 30, "Backing up container rootfs...");
      const result = await fetchNode<{ filename: string; sizeBytes: number }>(node, `/api/internal/lxc/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({ storagePool: poolName, compress }),
      });
      const repository = getOrCreateBackupRepository(sharedStorageName);
      const item = await recordBackupItem({ repository, taskId: task.id, resourceType: "lxc", resourceName: name, sourceNode: node, filename: result.filename, sizeBytes: result.sizeBytes, format: "tar.gz", compression: compress ? "automatic" : "none" });
      updateTask(task.id, "completed", 100, "Backup complete and catalogued", undefined, { backup: result, item: mapBackupItem(item) });
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Backup failed");
    }
  })();

  return reply.status(202).send(mapTaskRow(task));
});

app.post("/api/vdm/lxc/:node/:name/migrate", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: sourceNodeName, name } = req.params as { node: string; name: string };
  const { targetNode: targetNodeName, sharedStorageName, deleteSource = true } = req.body as { targetNode: string; sharedStorageName: string; deleteSource?: boolean };
  if (!targetNodeName) return reply.status(400).send({ error: "targetNode required" });
  if (!sharedStorageName) return reply.status(400).send({ error: "sharedStorageName required" });
  if (sourceNodeName === targetNodeName) return reply.status(400).send({ error: "Source and target nodes must be different" });

  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(sharedStorageName) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Shared storage not found" });

  const sourceNode = getEnabledNode(sourceNodeName);
  const targetNode = getEnabledNode(targetNodeName);
  const task = createTask({ kind: "migrate", label: `Migrate LXC ${name}: ${sourceNodeName} → ${targetNodeName}`, sourceNode: sourceNodeName, targetNode: targetNodeName, resourceType: "lxc", resourceName: name, createdBy: req.session.username });

  void (async () => {
    try {
      updateTask(task.id, "running", 5, "Mounting shared storage on source...");
      const sourcePool = await ensureStorageMountedOnNode(sourceNode, storage);
      updateTask(task.id, "running", 15, "Mounting shared storage on target...");
      const targetPool = await ensureStorageMountedOnNode(targetNode, storage);

      updateTask(task.id, "running", 20, "Creating backup on source...");
      const backupResult = await fetchNode<{ filename: string; sizeBytes: number }>(sourceNode, `/api/internal/lxc/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({ storagePool: sourcePool, compress: false }),
      });
      const repository = getOrCreateBackupRepository(sharedStorageName);
      await recordBackupItem({ repository, taskId: task.id, resourceType: "lxc", resourceName: name, sourceNode, filename: backupResult.filename, sizeBytes: backupResult.sizeBytes, format: "tar.gz", compression: "none" });

      updateTask(task.id, "running", 60, "Restoring on target...");
      await fetchNode(targetNode, `/api/internal/lxc/${encodeURIComponent(name)}/restore-backup`, {
        method: "POST",
        timeoutMs: LONG_OPERATION_TIMEOUT_MS,
        body: JSON.stringify({
          sourcePath: `${storage.local_mount_path}/backups/${backupResult.filename}`,
          storagePool: targetPool,
          name,
        }),
      });

      updateTask(task.id, "running", 80, "Validating restored LXC on target node...");
      await validateRestoredResource(targetNode, "lxc", name);

      if (deleteSource) {
        updateTask(task.id, "running", 90, "Removing from source...");
        try {
          await fetchNode(sourceNode, `/api/internal/lxc/${encodeURIComponent(name)}`, { method: "DELETE" });
        } catch (error) {
          updateTask(task.id, "completed-with-warning", 100, `LXC restored on ${targetNodeName}, but source cleanup failed`, error instanceof Error ? error.message : "Source cleanup failed", { targetNode: targetNodeName, sourceRetained: true });
          return;
        }
      }

      updateTask(task.id, "completed", 100, `LXC ${name} migrated to ${targetNodeName}`);
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Migration failed");
    }
  })();

  return reply.status(202).send(mapTaskRow(task));
});

app.delete("/api/vdm/lxc/:node/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}`, { method: "DELETE" });
});

// Create an LXC on a node (task-tracked — template download is slow).
app.post("/api/vdm/lxc/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  const body = req.body as { name?: string };
  const task = createTask({ kind: "create", label: `Create LXC ${body?.name ?? ""} on ${nodeName}`, targetNode: nodeName, resourceType: "lxc", resourceName: body?.name, createdBy: req.session.username });
  void (async () => {
    try {
      updateTask(task.id, "running", 20, "Creating container...");
      const result = await fetchNode(node, "/api/internal/lxc", { method: "POST", timeoutMs: LONG_OPERATION_TIMEOUT_MS, body: JSON.stringify(req.body) });
      updateTask(task.id, "completed", 100, "Container created", undefined, result);
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Create failed");
    }
  })();
  return reply.status(202).send(mapTaskRow(task));
});

app.get("/api/vdm/lxc/:node/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const { tail: rawTail = 200 } = req.query as { tail?: number | string };
  const tail = parseBoundedInt(rawTail, 200, 1, 5000);
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/logs?tail=${encodeURIComponent(String(tail))}`);
});

app.put("/api/vdm/lxc/:node/:name/config", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/config`, { method: "PUT", body: JSON.stringify(req.body) });
});

// LXC multi-NIC
app.get("/api/vdm/lxc/:node/:name/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks`);
});
app.post("/api/vdm/lxc/:node/:name/networks", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks`, { method: "POST", body: JSON.stringify(req.body) });
});
app.put("/api/vdm/lxc/:node/:name/networks/:index", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, index } = req.params as { node: string; name: string; index: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks/${encodeURIComponent(index)}`, { method: "PUT", body: JSON.stringify(req.body) });
});
app.delete("/api/vdm/lxc/:node/:name/networks/:index", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name, index } = req.params as { node: string; name: string; index: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks/${encodeURIComponent(index)}`, { method: "DELETE" });
});

app.post("/api/vdm/lxc/:node/:name/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return relayConsoleTicket(node, `/api/internal/lxc/${encodeURIComponent(name)}/console-ticket`, "term");
});

// ═══════════════════════════════════════════════════════════════════════════
// DOCKER — list all nodes + per-node detail
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/docker", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeFilter } = req.query as { node?: string };
  const nodes = db.prepare(`SELECT * FROM vdm_nodes WHERE enabled = 1 ${nodeFilter ? "AND name = ?" : ""} ORDER BY name ASC`).all(...(nodeFilter ? [nodeFilter] : [])) as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const containers = await fetchNode<unknown[]>(node, "/api/internal/docker/containers");
      return (containers as Record<string, unknown>[]).map((ct) => ({ ...ct, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
});

app.get("/api/vdm/docker/:node/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/details`);
});

app.get("/api/vdm/docker/:node/:id/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/stats`);
});

const DOCKER_ALLOWED_ACTIONS = new Set(["start", "stop", "restart", "pause", "unpause", "kill"]);

app.post("/api/vdm/docker/:node/:id/action", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const { action } = req.body as { action: string };
  if (!action) return reply.status(400).send({ error: "action required" });
  if (!DOCKER_ALLOWED_ACTIONS.has(action)) return reply.status(400).send({ error: `Invalid action. Allowed: ${[...DOCKER_ALLOWED_ACTIONS].join(", ")}` });
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: "POST" });
});

app.delete("/api/vdm/docker/:node/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}`, { method: "DELETE" });
});

// Create (run) a Docker container on a node (task-tracked — image pull is slow).
app.post("/api/vdm/docker/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  const body = req.body as { name?: string };
  const task = createTask({ kind: "create", label: `Create container ${body?.name ?? ""} on ${nodeName}`, targetNode: nodeName, resourceType: "docker", resourceName: body?.name, createdBy: req.session.username });
  void (async () => {
    try {
      updateTask(task.id, "running", 20, "Pulling image and creating container...");
      const result = await fetchNode(node, "/api/internal/docker/containers", { method: "POST", timeoutMs: LONG_OPERATION_TIMEOUT_MS, body: JSON.stringify(req.body) });
      updateTask(task.id, "completed", 100, "Container created", undefined, result);
    } catch (err) {
      updateTask(task.id, "failed", 0, undefined, err instanceof Error ? err.message : "Create failed");
    }
  })();
  return reply.status(202).send(mapTaskRow(task));
});

app.get("/api/vdm/docker/:node/:id/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const { tail: rawTail = 200 } = req.query as { tail?: number | string };
  const tail = parseBoundedInt(rawTail, 200, 1, 5000);
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/logs?tail=${encodeURIComponent(String(tail))}`);
});

app.put("/api/vdm/docker/:node/:id/config", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/config`, { method: "PUT", body: JSON.stringify(req.body) });
});

// Docker multi-NIC
app.get("/api/vdm/docker/:node/:id/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks`);
});
app.post("/api/vdm/docker/:node/:id/networks", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks`, { method: "POST", body: JSON.stringify(req.body) });
});
app.delete("/api/vdm/docker/:node/:id/networks/:network", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id, network } = req.params as { node: string; id: string; network: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks/${encodeURIComponent(network)}`, { method: "DELETE" });
});

app.post("/api/vdm/docker/:node/:id/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return relayConsoleTicket(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/console-ticket`, "term");
});

// ── VDM Docker: advanced actions (edit/recreate, exec) relayed to remote nodes ──
app.put("/api/vdm/docker/:node/:id/recreate", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/recreate`, { method: "PUT", body: JSON.stringify(req.body) });
});

app.post("/api/vdm/docker/:node/:id/exec", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, id } = req.params as { node: string; id: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/exec`, { method: "POST", body: JSON.stringify(req.body) });
});

// ── VDM Docker Compose (relayed to each node's persistent .yml store) ──
app.get("/api/vdm/docker/compose", async (req, reply) => {
  requireAuth(req, reply);
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 ORDER BY name ASC").all() as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const projects = await fetchNode<unknown[]>(node, "/api/internal/docker/compose");
      return (projects as Record<string, unknown>[]).map((p) => ({ ...p, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
});

app.get("/api/vdm/docker/compose/:node/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}`);
});

app.post("/api/vdm/docker/compose/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, "/api/internal/docker/compose", { method: "POST", body: JSON.stringify(req.body) });
});

app.put("/api/vdm/docker/compose/:node/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(req.body) });
});

app.delete("/api/vdm/docker/compose/:node/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}`, { method: "DELETE" });
});

app.post("/api/vdm/docker/compose/:node/:name/up", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}/up`, { method: "POST" });
});

app.post("/api/vdm/docker/compose/:node/:name/down", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}/down`, { method: "POST", body: JSON.stringify(req.body ?? {}) });
});

app.post("/api/vdm/docker/compose/:node/:name/restart", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}/restart`, { method: "POST", body: JSON.stringify(req.body ?? {}) });
});

app.get("/api/vdm/docker/compose/:node/:name/ps", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}/ps`);
});

app.get("/api/vdm/docker/compose/:node/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/compose/${encodeURIComponent(name)}/logs?tail=200`);
});

// ── VDM Docker volumes ──
app.get("/api/vdm/docker/volumes", async (req, reply) => {
  requireAuth(req, reply);
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 ORDER BY name ASC").all() as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const volumes = await fetchNode<unknown[]>(node, "/api/internal/docker/volumes");
      return (volumes as Record<string, unknown>[]).map((v) => ({ ...v, nodeName: node.name, nodeDisplayName: node.display_name ?? node.name }));
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
});

app.post("/api/vdm/docker/volumes/:node", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, "/api/internal/docker/volumes", { method: "POST", body: JSON.stringify(req.body) });
});

app.delete("/api/vdm/docker/volumes/:node/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName, name } = req.params as { node: string; name: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, `/api/internal/docker/volumes/${encodeURIComponent(name)}`, { method: "DELETE" });
});

// ── VDM Docker prune ──
app.post("/api/vdm/docker/:node/prune", async (req, reply) => {
  requireAdmin(req, reply);
  const { node: nodeName } = req.params as { node: string };
  const node = getEnabledNode(nodeName);
  return fetchNode(node, "/api/internal/docker/prune", { method: "POST", body: JSON.stringify(req.body ?? {}) });
});

// ═══════════════════════════════════════════════════════════════════════════
// SHARED STORAGE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/storage", async (req, reply) => {
  requireAuth(req, reply);
  const rows = db.prepare("SELECT * FROM vdm_shared_storage ORDER BY name ASC").all() as VdmSharedStorageRow[];
  return rows.map(mapStorageRow);
});

const SMB_VALID_VERSIONS = new Set(["default", "1.0", "2.0", "2.1", "3", "3.0", "3.02", "3.11", "3.1.1"]);
const NFS_VALID_VERSIONS = new Set(["3", "4", "4.0", "4.1", "4.2"]);

app.post("/api/vdm/storage", async (req, reply) => {
  requireAdmin(req, reply);
  const { name, displayName, type, source, mountOptions, smbDomain, smbUsername, smbPassword, smbVersion, nfsVersion, localMountPath, content, notes,
    s3Endpoint, s3Bucket, s3Region, s3AccessKey, s3SecretKey, s3Provider, s3VfsCacheMode } = req.body as {
    name: string; displayName?: string; type: string; source: string;
    mountOptions?: string; smbDomain?: string; smbUsername?: string; smbPassword?: string;
    smbVersion?: string; nfsVersion?: string;
    localMountPath: string; content?: string[]; notes?: string;
    s3Endpoint?: string; s3Bucket?: string; s3Region?: string; s3AccessKey?: string; s3SecretKey?: string;
    s3Provider?: string; s3VfsCacheMode?: string;
  };
  if (!name || !type || !localMountPath) return reply.status(400).send({ error: "name, type, localMountPath required" });
  if (type !== "s3" && !source) return reply.status(400).send({ error: "source required for this storage type" });
  if (!/^[a-z0-9_-]+$/.test(name)) return reply.status(400).send({ error: "Name must be lowercase alphanumeric with - or _" });
  if (!["nfs", "smb", "cifs", "glusterfs", "s3"].includes(type)) return reply.status(400).send({ error: "type must be nfs, smb, cifs, glusterfs, or s3" });
  if (smbVersion && !SMB_VALID_VERSIONS.has(smbVersion)) return reply.status(400).send({ error: `smbVersion must be one of: ${[...SMB_VALID_VERSIONS].join(", ")}` });
  if (nfsVersion && !NFS_VALID_VERSIONS.has(nfsVersion)) return reply.status(400).send({ error: `nfsVersion must be one of: ${[...NFS_VALID_VERSIONS].join(", ")}` });
  if (type === "s3") {
    if (!s3Bucket) return reply.status(400).send({ error: "s3Bucket required for S3 storage" });
    if (!s3AccessKey || !s3SecretKey) return reply.status(400).send({ error: "s3AccessKey and s3SecretKey required for S3 storage" });
  }

  try {
    db.prepare(`
      INSERT INTO vdm_shared_storage (name, display_name, type, source, mount_options, smb_domain, smb_username, smb_password, smb_version, nfs_version, local_mount_path, content, notes, s3_endpoint, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_provider, s3_vfs_cache_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, displayName ?? null, type, source ?? "", mountOptions ?? null, smbDomain ?? null, smbUsername ?? null, smbPassword ? encryptSecret(smbPassword) : null, smbVersion ?? null, nfsVersion ?? null, localMountPath, JSON.stringify(content ?? ["iso", "backup", "disk"]), notes ?? null,
      s3Endpoint ?? null, s3Bucket ?? null, s3Region ?? null, s3AccessKey ? encryptSecret(s3AccessKey) : null, s3SecretKey ? encryptSecret(s3SecretKey) : null, s3Provider ?? null, s3VfsCacheMode ?? null);
  } catch {
    return reply.status(409).send({ error: "Storage name already exists" });
  }
  const row = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(name) as VdmSharedStorageRow;
  return reply.status(201).send(mapStorageRow(row));
});

app.put("/api/vdm/storage/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const { displayName, mountOptions, smbDomain, smbUsername, smbPassword, smbVersion, nfsVersion, enabled, notes,
    s3Endpoint, s3Bucket, s3Region, s3AccessKey, s3SecretKey, s3Provider, s3VfsCacheMode } = req.body as { displayName?: string; mountOptions?: string; smbDomain?: string; smbUsername?: string; smbPassword?: string; smbVersion?: string; nfsVersion?: string; enabled?: boolean; notes?: string; s3Endpoint?: string; s3Bucket?: string; s3Region?: string; s3AccessKey?: string; s3SecretKey?: string; s3Provider?: string; s3VfsCacheMode?: string };
  const existing = db.prepare("SELECT id FROM vdm_shared_storage WHERE name = ?").get(name);
  if (!existing) return reply.status(404).send({ error: "Storage not found" });
  if (smbVersion && !SMB_VALID_VERSIONS.has(smbVersion)) return reply.status(400).send({ error: `smbVersion must be one of: ${[...SMB_VALID_VERSIONS].join(", ")}` });
  if (nfsVersion && !NFS_VALID_VERSIONS.has(nfsVersion)) return reply.status(400).send({ error: `nfsVersion must be one of: ${[...NFS_VALID_VERSIONS].join(", ")}` });
  db.prepare("UPDATE vdm_shared_storage SET display_name = COALESCE(?, display_name), mount_options = COALESCE(?, mount_options), smb_domain = COALESCE(?, smb_domain), smb_username = COALESCE(?, smb_username), smb_password = COALESCE(?, smb_password), smb_version = COALESCE(?, smb_version), nfs_version = COALESCE(?, nfs_version), s3_endpoint = COALESCE(?, s3_endpoint), s3_bucket = COALESCE(?, s3_bucket), s3_region = COALESCE(?, s3_region), s3_access_key = COALESCE(?, s3_access_key), s3_secret_key = COALESCE(?, s3_secret_key), s3_provider = COALESCE(?, s3_provider), s3_vfs_cache_mode = COALESCE(?, s3_vfs_cache_mode), enabled = COALESCE(?, enabled), notes = COALESCE(?, notes), updated_at = ? WHERE name = ?")
    .run(displayName ?? null, mountOptions ?? null, smbDomain ?? null, smbUsername ?? null, smbPassword ? encryptSecret(smbPassword) : null, smbVersion ?? null, nfsVersion ?? null, s3Endpoint ?? null, s3Bucket ?? null, s3Region ?? null, s3AccessKey ? encryptSecret(s3AccessKey) : null, s3SecretKey ? encryptSecret(s3SecretKey) : null, s3Provider ?? null, s3VfsCacheMode ?? null, enabled !== undefined ? (enabled ? 1 : 0) : null, notes ?? null, new Date().toISOString(), name);
  return { ok: true };
});

app.delete("/api/vdm/storage/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const result = db.prepare("DELETE FROM vdm_shared_storage WHERE name = ?").run(name);
  if (result.changes === 0) return reply.status(404).send({ error: "Storage not found" });
  return { ok: true };
});

// Mount shared storage on all enabled nodes
app.post("/api/vdm/storage/:name/mount", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(name) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Storage not found" });

  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1").all() as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      await ensureStorageMountedOnNode(node, storage);
      return { node: node.name, ok: true };
    }),
  );
  return results.map((r) => r.status === "fulfilled" ? r.value : { ok: false, error: (r.reason as Error).message });
});

// Mount shared storage on one specific node
app.post("/api/vdm/storage/:name/mount/:nodeName", async (req, reply) => {
  requireAdmin(req, reply);
  const { name, nodeName } = req.params as { name: string; nodeName: string };
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(name) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Storage not found" });
  const node = getEnabledNode(nodeName);
  await ensureStorageMountedOnNode(node, storage);
  return { ok: true };
});

// Cluster mount status — returns per-node mount status for a storage
app.get("/api/vdm/storage/:name/cluster-status", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(name) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Storage not found" });

  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 ORDER BY name ASC").all() as VdmNodeRow[];
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      if (node.status === "offline") return { node: node.name, nodeDisplayName: node.display_name ?? node.name, mounted: false, error: "Node offline" };
      try {
        const pools = await fetchNode<Array<{ name: string; mounted?: boolean }>>(node, "/api/internal/storage/pools");
        const pool = pools.find((p) => p.name === storage.name);
        // New nodes report the actual mount state; old nodes only list pools.
        const mounted = pool ? (pool.mounted !== undefined ? pool.mounted : true) : false;
        return { node: node.name, nodeDisplayName: node.display_name ?? node.name, mounted, error: pool ? null : "Pool not registered on node" };
      } catch (err) {
        return { node: node.name, nodeDisplayName: node.display_name ?? node.name, mounted: false, error: err instanceof Error ? err.message : "Unknown error" };
      }
    }),
  );
  return results.map((r) => r.status === "fulfilled" ? r.value : { node: "unknown", nodeDisplayName: "unknown", mounted: false, error: (r.reason as Error).message });
});

// List files in shared storage
app.get("/api/vdm/storage/:name/content", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(name) as VdmSharedStorageRow | undefined;
  if (!storage) return reply.status(404).send({ error: "Storage not found" });

  // Ask any online node for content (they all see the same share)
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 AND status = 'online' ORDER BY name ASC LIMIT 1").all() as VdmNodeRow[];
  if (nodes.length === 0) return { files: [] };
  const node = nodes[0];
  try {
    return await fetchNode(node, `/api/internal/storage/pools/${encodeURIComponent(name)}/content`);
  } catch {
    return { files: [] };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CENTRAL BACKUP CATALOG
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/backup-repositories", async (req, reply) => {
  requireAuth(req, reply);
  const rows = db.prepare("SELECT * FROM vdm_backup_repositories ORDER BY name").all() as VdmBackupRepositoryRow[];
  return rows.map(mapBackupRepository);
});

app.post("/api/vdm/backup-repositories", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { name?: string; displayName?: string; storageName?: string; retentionDaily?: number; retentionWeekly?: number; retentionMonthly?: number; quotaBytes?: number; notes?: string };
  const name = body.name?.trim() ?? "";
  const storageName = body.storageName?.trim() ?? "";
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) return reply.status(400).send({ error: "Invalid repository name" });
  if (!db.prepare("SELECT id FROM vdm_shared_storage WHERE name = ? AND enabled = 1").get(storageName)) return reply.status(404).send({ error: "Enabled shared storage not found" });
  try {
    const result = db.prepare(`INSERT INTO vdm_backup_repositories
      (name, display_name, storage_name, retention_daily, retention_weekly, retention_monthly, quota_bytes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, body.displayName?.trim() || null, storageName,
        Math.max(0, Math.min(365, Math.trunc(body.retentionDaily ?? 7))),
        Math.max(0, Math.min(104, Math.trunc(body.retentionWeekly ?? 4))),
        Math.max(0, Math.min(120, Math.trunc(body.retentionMonthly ?? 6))),
        body.quotaBytes && body.quotaBytes > 0 ? Math.trunc(body.quotaBytes) : null, body.notes?.trim() || null);
    return reply.status(201).send(mapBackupRepository(db.prepare("SELECT * FROM vdm_backup_repositories WHERE id = ?").get(result.lastInsertRowid) as VdmBackupRepositoryRow));
  } catch {
    return reply.status(409).send({ error: "Repository name or storage is already in use" });
  }
});

app.post("/api/vdm/backup-repositories/:id/prune", async (req, reply) => {
  requireAdmin(req, reply);
  const id = Number.parseInt((req.params as { id: string }).id, 10);
  if (!Number.isInteger(id)) return reply.status(400).send({ error: "Invalid repository id" });
  return pruneBackupRepository(id);
});

app.get("/api/vdm/backups", async (req, reply) => {
  requireAuth(req, reply);
  const query = req.query as { resourceType?: string; resourceName?: string; node?: string; repositoryId?: string };
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.resourceType) { clauses.push("resource_type = ?"); args.push(query.resourceType); }
  if (query.resourceName) { clauses.push("resource_name = ?"); args.push(query.resourceName); }
  if (query.node) { clauses.push("source_node = ?"); args.push(query.node); }
  if (query.repositoryId) { clauses.push("repository_id = ?"); args.push(Number.parseInt(query.repositoryId, 10)); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM vdm_backup_items ${where} ORDER BY created_at DESC LIMIT 1000`).all(...args) as VdmBackupItemRow[];
  return rows.map(mapBackupItem);
});

app.post("/api/vdm/backups/:id/verify", async (req, reply) => {
  requireAdmin(req, reply);
  const item = db.prepare("SELECT * FROM vdm_backup_items WHERE id = ?").get((req.params as { id: string }).id) as VdmBackupItemRow | undefined;
  if (!item) return reply.status(404).send({ error: "Backup not found" });
  const repository = db.prepare("SELECT * FROM vdm_backup_repositories WHERE id = ?").get(item.repository_id) as VdmBackupRepositoryRow;
  const node = getEnabledNode(item.source_node);
  const content = await fetchNode<Array<{ name: string; path: string; size: number }>>(node, `/api/internal/storage/pools/${encodeURIComponent(repository.storage_name)}/content`, { timeoutMs: 60_000 });
  const found = content.find((entry) => entry.name === item.filename || entry.path.endsWith(`/${item.relative_path}`) || entry.path.endsWith(`/${item.filename}`));
  if (!found || (item.size_bytes > 0 && found.size !== item.size_bytes)) {
    db.prepare("UPDATE vdm_backup_items SET status = 'missing', verified_at = NULL WHERE id = ?").run(item.id);
    return reply.status(409).send({ error: found ? "Backup size mismatch" : "Backup file missing", found });
  }
  const checksum = await fetchNode<{ algorithm: string; checksum: string; sizeBytes: number }>(node, `/api/internal/storage/pools/${encodeURIComponent(repository.storage_name)}/content/checksum`, {
    method: "POST", timeoutMs: LONG_OPERATION_TIMEOUT_MS, body: JSON.stringify({ itemPath: found.path }),
  });
  const now = new Date().toISOString();
  db.prepare("UPDATE vdm_backup_items SET status = 'available', verified_at = ?, size_bytes = ?, checksum_sha256 = ? WHERE id = ?").run(now, found.size, checksum.checksum, item.id);
  return { ok: true, verifiedAt: now, sizeBytes: found.size, checksumSha256: checksum.checksum };
});

app.post("/api/vdm/backups/:id/restore", async (req, reply) => {
  requireAdmin(req, reply);
  const item = db.prepare("SELECT * FROM vdm_backup_items WHERE id = ?").get((req.params as { id: string }).id) as VdmBackupItemRow | undefined;
  if (!item) return reply.status(404).send({ error: "Backup not found" });
  if (item.status !== "available") return reply.status(409).send({ error: `Backup is ${item.status}; verify it before restore` });
  const body = (req.body ?? {}) as { targetNode?: string; name?: string; storagePool?: string };
  const targetNodeName = body.targetNode?.trim() ?? item.source_node;
  const restoredName = body.name?.trim() ?? item.resource_name;
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(restoredName)) return reply.status(400).send({ error: "Invalid restore name" });
  const repository = db.prepare("SELECT * FROM vdm_backup_repositories WHERE id = ?").get(item.repository_id) as VdmBackupRepositoryRow;
  const storage = db.prepare("SELECT * FROM vdm_shared_storage WHERE name = ?").get(repository.storage_name) as VdmSharedStorageRow;
  const targetNode = getEnabledNode(targetNodeName);
  const task = createTask({ kind: "restore", label: `Restore ${item.resource_type.toUpperCase()} ${restoredName} on ${targetNodeName}`, targetNode: targetNodeName, resourceType: item.resource_type, resourceName: restoredName, createdBy: req.session.username });
  void (async () => {
    try {
      updateTask(task.id, "running", 10, "Mounting backup repository on target node...");
      const poolName = await ensureStorageMountedOnNode(targetNode, storage);
      updateTask(task.id, "running", 30, "Restoring backup...");
      const endpoint = item.resource_type === "vm" ? "vms" : "lxc";
      await fetchNode(targetNode, `/api/internal/${endpoint}/${encodeURIComponent(restoredName)}/restore-backup`, {
        method: "POST", timeoutMs: 4 * 60 * 60_000,
        body: JSON.stringify({ sourcePath: `${storage.local_mount_path}/${item.relative_path}`, storagePool: body.storagePool ?? poolName, name: restoredName }),
      });
      updateTask(task.id, "running", 90, "Validating restored resource...");
      await validateRestoredResource(targetNode, item.resource_type as "vm" | "lxc", restoredName);
      updateTask(task.id, "completed", 100, "Restore completed", undefined, { backupId: item.id, targetNode: targetNodeName, name: restoredName });
    } catch (error) {
      updateTask(task.id, "failed", 0, undefined, error instanceof Error ? error.message : "Restore failed");
    }
  })();
  return reply.status(202).send(mapTaskRow(task));
});

app.delete("/api/vdm/backups/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const item = db.prepare("SELECT * FROM vdm_backup_items WHERE id = ?").get((req.params as { id: string }).id) as VdmBackupItemRow | undefined;
  if (!item) return reply.status(404).send({ error: "Backup not found" });
  const metadata = item.metadata ? JSON.parse(item.metadata) as { remoteBackupId?: string | null } : {};
  const remoteId = metadata.remoteBackupId?.split(":").pop();
  if (remoteId) {
    const node = getEnabledNode(item.source_node);
    await fetchNode(node, `/api/internal/backups/${encodeURIComponent(remoteId)}`, { method: "DELETE", timeoutMs: 60_000 });
  }
  db.prepare("DELETE FROM vdm_backup_items WHERE id = ?").run(item.id);
  return { ok: true };
});

app.get("/api/vdm/backup-jobs", async (req, reply) => {
  requireAuth(req, reply);
  return (db.prepare("SELECT * FROM vdm_backup_jobs ORDER BY name").all() as Array<Record<string, unknown>>).map((row) => ({
    id: row.id, name: row.name, repositoryId: row.repository_id, resourceType: row.resource_type, resourceName: row.resource_name,
    sourceNode: row.source_node, schedule: row.schedule ? JSON.parse(String(row.schedule)) : null, enabled: !!row.enabled,
    compress: !!row.compress, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
  }));
});

app.post("/api/vdm/backup-jobs", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { name?: string; repositoryId?: number; resourceType?: string; resourceName?: string; sourceNode?: string; intervalMinutes?: number; compress?: boolean };
  const name = body.name?.trim() ?? "";
  const intervalMinutes = Math.max(5, Math.min(10080, Math.trunc(body.intervalMinutes ?? 1440)));
  if (!/^[a-zA-Z][a-zA-Z0-9 _.-]{0,62}$/.test(name)) return reply.status(400).send({ error: "Invalid job name" });
  if (body.resourceType !== "vm" && body.resourceType !== "lxc") return reply.status(400).send({ error: "resourceType must be vm or lxc" });
  if (!body.resourceName || !body.sourceNode || !body.repositoryId) return reply.status(400).send({ error: "repositoryId, sourceNode and resourceName are required" });
  getEnabledNode(body.sourceNode);
  if (!db.prepare("SELECT id FROM vdm_backup_repositories WHERE id = ? AND enabled = 1").get(body.repositoryId)) return reply.status(404).send({ error: "Repository not found" });
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO vdm_backup_jobs
      (id, name, repository_id, resource_type, resource_name, source_node, schedule, compress, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, body.repositoryId, body.resourceType, body.resourceName, body.sourceNode, JSON.stringify({ intervalMinutes }), body.compress === false ? 0 : 1, new Date(Date.now() + intervalMinutes * 60_000).toISOString());
    return reply.status(201).send({ id, name, intervalMinutes });
  } catch {
    return reply.status(409).send({ error: "Backup job name already exists" });
  }
});

app.delete("/api/vdm/backup-jobs/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const result = db.prepare("DELETE FROM vdm_backup_jobs WHERE id = ?").run((req.params as { id: string }).id);
  if (!result.changes) return reply.status(404).send({ error: "Backup job not found" });
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════

const TASK_VALID_STATUSES = new Set(["pending", "running", "completed", "completed-with-warning", "failed", "cancelled", "recovery-required"]);

app.get("/api/vdm/tasks", async (req, reply) => {
  requireAuth(req, reply);
  const { limit: rawLimit = 50, status } = req.query as { limit?: number | string; status?: string };
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(rawLimit), 10) || 50));
  if (status && !TASK_VALID_STATUSES.has(status)) return reply.status(400).send({ error: `Invalid status. Allowed: ${[...TASK_VALID_STATUSES].join(", ")}` });
  const rows = db.prepare(`
    SELECT * FROM vdm_tasks ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?
  `).all(...(status ? [status, limit] : [limit])) as VdmTaskRow[];
  return rows.map(mapTaskRow);
});

app.get("/api/vdm/tasks/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const row = db.prepare("SELECT * FROM vdm_tasks WHERE id = ?").get(id) as VdmTaskRow | undefined;
  if (!row) return reply.status(404).send({ error: "Task not found" });
  return mapTaskRow(row);
});

app.post("/api/vdm/tasks/:id/resolve", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const row = db.prepare("SELECT * FROM vdm_tasks WHERE id = ?").get(id) as VdmTaskRow | undefined;
  if (!row) return reply.status(404).send({ error: "Task not found" });
  if (row.status !== "recovery-required") return reply.status(409).send({ error: "Task does not require recovery" });
  const { resolution, message } = (req.body ?? {}) as { resolution?: string; message?: string };
  if (resolution !== "completed" && resolution !== "failed") return reply.status(400).send({ error: "resolution must be completed or failed" });
  updateTask(id, resolution, resolution === "completed" ? 100 : 0, message ?? `Manually resolved as ${resolution}`, resolution === "failed" ? (message ?? "Interrupted task failed") : undefined);
  return mapTaskRow(db.prepare("SELECT * FROM vdm_tasks WHERE id = ?").get(id) as VdmTaskRow);
});

// ═══════════════════════════════════════════════════════════════════════════
// LOGS (operational log, LOGS page)
// ═══════════════════════════════════════════════════════════════════════════

const LOG_LEVELS = new Set(["warn", "error", "info"]);
const LOG_CATEGORIES = new Set(["storage", "backup", "migration", "nodes", "system"]);

function getLogSettings(): VdmLogSettings {
  return parseLogSettings(getSetting(db, LOG_SETTINGS_KEY));
}

// GET /api/vdm/logs?level=&category=&source=&since=&limit=
app.get("/api/vdm/logs", async (req, reply) => {
  requireAuth(req, reply);
  const query = req.query as { level?: string; category?: string; source?: string; since?: string; limit?: string };
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.level && LOG_LEVELS.has(query.level)) { clauses.push("level = ?"); args.push(query.level); }
  if (query.category && LOG_CATEGORIES.has(query.category)) { clauses.push("category = ?"); args.push(query.category); }
  if (query.source) { clauses.push("source = ?"); args.push(query.source); }
  if (query.since && /^\d{4}-\d{2}-\d{2}T/.test(query.since)) { clauses.push("ts >= ?"); args.push(query.since); }
  const limit = Math.max(1, Math.min(1000, Number.parseInt(query.limit ?? "200", 10) || 200));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT id, ts, level, source, category, message, meta FROM vdm_logs ${where} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit) as Array<{ id: number; ts: string; level: string; source: string; category: string; message: string; meta: string | null }>;
  return rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : undefined }));
});

// GET/PUT config LOGS (admin) — persistée dans vdm_settings
app.get("/api/vdm/logs/config", async (req, reply) => {
  requireAdmin(req, reply);
  return parseLogSettings(getSetting(db, LOG_SETTINGS_KEY));
});

app.put("/api/vdm/logs/config", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { enabled?: unknown; minLevel?: unknown; retentionDays?: unknown; categories?: unknown };
  const current = parseLogSettings(getSetting(db, LOG_SETTINGS_KEY));
  const minLevel = typeof body.minLevel === "string" && LOG_LEVELS.has(body.minLevel) ? body.minLevel as VdmLogLevel : current.minLevel;
  const retentionDays = Number.isFinite(body.retentionDays) ? Math.max(1, Math.min(365, Math.trunc(body.retentionDays as number))) : current.retentionDays;
  const categories = Array.isArray(body.categories)
    ? (body.categories as string[]).filter((c) => LOG_CATEGORIES.has(c)) as VdmLogCategory[]
    : current.categories;
  const next: VdmLogSettings = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    minLevel,
    retentionDays,
    categories: categories.length ? categories : current.categories,
  };
  setSetting(db, LOG_SETTINGS_KEY, serializeLogSettings(next));
  return next;
});

// DELETE /api/vdm/logs — vide le journal (admin)
app.delete("/api/vdm/logs", async (req, reply) => {
  requireAdmin(req, reply);
  db.prepare("DELETE FROM vdm_logs").run();
  return { ok: true };
});

// Poll node local logs (warn/error) and merge them into the central log.
// Dedupe via unique index (source, ts, message) so re-polls are idempotent.
const NODE_LOG_POLL_MS = 60_000;
async function pollNodeLogs(): Promise<void> {
  const settings = parseLogSettings(getSetting(db, LOG_SETTINGS_KEY));
  if (!settings.enabled) return;
  const nodes = db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 AND status = 'online'").all() as VdmNodeRow[];
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  await Promise.allSettled(nodes.map(async (node) => {
    const entries = await fetchNode<Array<{ ts: string; level: string; category: string; message: string }>>(node, `/api/internal/logs/recent?since=${encodeURIComponent(since)}`, { timeoutMs: 15_000 });
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry.ts !== "string" || typeof entry.message !== "string") continue;
      if (entry.level !== "warn" && entry.level !== "error") continue;
      if (!LOG_CATEGORIES.has(entry.category)) continue;
      recordVdmLog(db, entry.level, node.name, entry.category as VdmLogCategory, entry.message, entry);
    }
  }));
}
let nodeLogPollRunning = false;
setInterval(() => {
  if (nodeLogPollRunning) return;
  nodeLogPollRunning = true;
  pollNodeLogs().catch(() => {}).finally(() => { nodeLogPollRunning = false; });
}, NODE_LOG_POLL_MS).unref();

// Retention purge (hourly) — uses the configured retentionDays.
setInterval(() => {
  const settings = parseLogSettings(getSetting(db, LOG_SETTINGS_KEY));
  purgeOldLogs(db, settings.retentionDays);
}, 60 * 60_000).unref();

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/vdm/settings", async (req, reply) => {
  requireAdmin(req, reply);
  const rows = db.prepare("SELECT key, value FROM vdm_settings").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.key === "allowSelfSigned" ? r.value === "true" : r.value]));
});

app.put("/api/vdm/settings", async (req, reply) => {
  requireAdmin(req, reply);
  const settings = req.body as Record<string, unknown>;
  const allowed = new Set(["vdmName", "allowSelfSigned"]);
  const stmt = db.prepare("INSERT OR REPLACE INTO vdm_settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) return reply.status(400).send({ error: `Unknown setting: ${key}` });
    stmt.run(key, String(value));
  }
  return { ok: true };
});

// LOGS config via le canal settings générique (UI Settings → section LOGS)
app.put("/api/vdm/logs-config", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("logs")) return reply.status(400).send({ error: `Unknown setting: ${key}` });
    setSetting(db, key, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
  }
  return { ok: true };
});

app.get("/api/vdm/ha", async (req, reply) => {
  requireAdmin(req, reply);
  const configuredNode = getSetting(db, "haControlNode");
  const node = configuredNode ? getNode(configuredNode) : db.prepare("SELECT * FROM vdm_nodes WHERE enabled = 1 ORDER BY id LIMIT 1").get() as VdmNodeRow | undefined;
  if (!node) return { enabled: false, available: false, controlNode: null, sharedPath: getSetting(db, "haSharedPath"), error: "No enabled control node" };
  try {
    const status = await fetchNode<{ enabled: boolean; output: string }>(node, "/api/internal/vdm-ha");
    return { ...status, available: true, controlNode: node.name, sharedPath: getSetting(db, "haSharedPath") };
  } catch (error) {
    return { enabled: false, available: false, controlNode: node.name, sharedPath: getSetting(db, "haSharedPath"), error: error instanceof Error ? error.message : "HA status unavailable" };
  }
});

app.put("/api/vdm/ha", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { enabled?: unknown; controlNode?: unknown; sharedPath?: unknown };
  if (typeof body.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be boolean" });
  const controlNode = typeof body.controlNode === "string" ? body.controlNode.trim() : (getSetting(db, "haControlNode") || "");
  const sharedPath = typeof body.sharedPath === "string" ? body.sharedPath.trim() : (getSetting(db, "haSharedPath") || "");
  const node = getNode(controlNode);
  if (!node || !node.enabled) return reply.status(400).send({ error: "An enabled control node is required" });
  if (body.enabled && (!sharedPath.startsWith("/") || sharedPath.includes("..") || /\s/.test(sharedPath))) {
    return reply.status(400).send({ error: "A safe absolute cluster storage path is required" });
  }
  try {
    const result = await fetchNode<{ ok: boolean; enabled: boolean; output: string }>(node, "/api/internal/vdm-ha", {
      method: "PUT",
      timeoutMs: 15 * 60_000,
      body: JSON.stringify({ enabled: body.enabled, sharedPath }),
    });
    setSetting(db, "haControlNode", node.name);
    if (sharedPath) setSetting(db, "haSharedPath", sharedPath);
    return { ...result, controlNode: node.name, sharedPath };
  } catch (error) {
    return reply.status(409).send({ error: error instanceof Error ? error.message : "HA operation failed" });
  }
});

// User management (admin only)
app.get("/api/vdm/users", async (req, reply) => {
  requireAdmin(req, reply);
  return db.prepare("SELECT id, username, role, display_name AS displayName, created_at AS createdAt FROM vdm_users ORDER BY username ASC").all();
});

app.post("/api/vdm/users", async (req, reply) => {
  requireAdmin(req, reply);
  const { username, password, role = "viewer", displayName } = req.body as { username: string; password: string; role?: string; displayName?: string };
  if (!username) return reply.status(400).send({ error: "username required" });
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return reply.status(400).send({ error: pwCheck.error });
  if (!["admin", "viewer"].includes(role)) return reply.status(400).send({ error: "role must be admin or viewer" });
  try {
    const hash = await argon2.hash(password);
    db.prepare("INSERT INTO vdm_users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)").run(username, hash, role, displayName ?? null);
    return reply.status(201).send({ ok: true });
  } catch {
    return reply.status(409).send({ error: "Username already exists" });
  }
});

app.delete("/api/vdm/users/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  if (parseInt(id) === req.session.userId) return reply.status(400).send({ error: "Cannot delete your own account" });
  db.prepare("DELETE FROM vdm_users WHERE id = ?").run(parseInt(id));
  return { ok: true };
});

// ── SPA Fallback ──────────────────────────────────────────────────────────
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
  if (fs.existsSync(path.join(UI_DIST_DIR, "index.html"))) {
    return reply.sendFile("index.html");
  }
  return reply.status(404).send("VDM UI not built yet. Run: npm run build --workspace=apps/vdm-ui");
});

// ── Console WebSocket relay (browser ↔ VDM ↔ node) ─────────────────────────
const consoleWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

function bridgeConsole(clientWs: WebSocket, node: VdmNodeRow, ticket: VdmConsoleTicket) {
  const base = node.api_url.replace(/^http/i, "ws").replace(/\/+$/, "");
  const wsPath = ticket.kind === "vnc" ? "/api/ws/vnc" : ticket.kind === "spice" ? "/api/ws/spice" : "/api/ws/term";
  const upstreamUrl = `${base}${wsPath}?ticket=${encodeURIComponent(ticket.nodeTicket)}`;
  // Nodes are explicitly registered/trusted (token-authenticated); accept their
  // TLS cert even if self-signed. The WS itself is gated by the one-time ticket.
  const upstream = new WebSocket(upstreamUrl, { rejectUnauthorized: false, perMessageDeflate: false });

  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  let upstreamOpen = false;
  const closeBoth = () => { try { clientWs.close(); } catch { /* */ } try { upstream.close(); } catch { /* */ } };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const m of pending) { try { upstream.send(m.data, { binary: m.binary }); } catch { /* */ } }
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary }); });
  upstream.on("close", closeBoth);
  upstream.on("error", (err) => { app.log.warn({ err: err.message, node: node.name }, "console upstream error"); closeBoth(); });

  clientWs.on("message", (data, isBinary) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push({ data, binary: isBinary });
  });
  clientWs.on("close", closeBoth);
  clientWs.on("error", closeBoth);
}

app.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const parsed = new URL(req.url ?? "/", "http://localhost");
  if (parsed.pathname !== "/api/vdm/ws/console") { socket.destroy(); return; }
  const ticket = consumeConsoleTicket(parsed.searchParams.get("ticket"));
  if (!ticket) { socket.destroy(); return; }
  const node = getNode(ticket.node);
  if (!node || !node.enabled) { socket.destroy(); return; }
  consoleWss.handleUpgrade(req, socket, head, (clientWs) => bridgeConsole(clientWs, node, ticket));
});

// ── Start ─────────────────────────────────────────────────────────────────
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[vdm] Virtua Datacenter Manager running on port ${PORT}`);
