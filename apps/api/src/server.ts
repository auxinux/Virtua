import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import * as argon2 from "argon2";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import { createHash, createPrivateKey, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "crypto";
import { pipeline } from "stream/promises";
import { Duplex, Readable } from "stream";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as pty from "node-pty";
import { getDb, auditLog, securityLog, startAuditLogPruner } from "./db.js";
import { callRunner, type RunnerProgress } from "./runnerClient.js";
import { registerDesktopApi, type DesktopResourceRow } from "./desktop.js";
import {
  generateNumericCode, maskPhone, maskEmail, isLikelyPhone, isLikelyEmail, normalizePhone,
  sendSms, sendEmail, type TwilioConfig, type SmtpConfig,
} from "./mfa.js";
import { checkQuota, checkPermission, replyQuotaError } from "./quota.js";
import {
  loadTlsOptions,
  getSslStatus,
  provisionCertificate,
  removeCertificate,
  checkAndRenew,
  challengeTokens,
  CERT_PATH,
  KEY_PATH,
} from "./ssl.js";
import {
  LoginSchema, CreateUserSchema, UpdateUserSchema, UpdateUserLimitsSchema, validatePassword,
  CreateVmSchema, UpdateVmConfigSchema, AttachDiskSchema, AttachNetworkSchema, UpdateNetworkSchema, CreateSnapshotSchema, BackupVmSchema,
  UsbDeviceAssignmentSchema,
  CreateLxcSchema, UpdateLxcConfigSchema, BackupLxcSchema, LxcNicSchema, GpuDeviceAssignmentSchema, DockerConnectNetworkSchema,
  RunDockerSchema, CreateDockerNetworkSchema, UpdateDockerConfigSchema, ComposeDeploySchema,
  RecreateDockerSchema, ComposeProjectSchema, DockerVolumeCreateSchema, DockerExecSchema, DockerPruneSchema,
  CreateRaidSchema, CreateStoragePoolSchema, CreateBridgeSchema, FormatDiskSchema,
  FirewallRuleSchema, FirewallSettingsSchema,
  UpdateUserResourceAclSchema,
  CreateJoinTokenSchema,
  CreateDatacenterNodeSchema,
  JoinDatacenterSchema,
  UpdateDatacenterConfigSchema,
  UpdateDatacenterNodeSchema,
  type CreateVmInput,
  type DatacenterConfig,
  type DatacenterJoinToken,
  type DatacenterNode,
  type DatacenterNodeSummary,
  type DatacenterResourceEntry,
  type JoinDatacenterResult,
  type DatacenterSummary,
  type ResourceCounts,
  type RunDockerInput,
  type SystemInfo,
  type SystemStats,
  ResourceTombstones,
  isValidResourceName,
  TemplateMetaSchema,
  UpdateTemplateSchema,
  CreateResourceSchema,
  parseVirtuaConfig,
  archToQemu,
  qemuToArch,
  type TemplateArch,
  type TemplateSummary,
} from "@auxinux/shared";

declare module "@fastify/session" {
  interface FastifySessionObject {
    userId?: number;
    username?: string;
    role?: string;
    mustChangePassword?: boolean;
    // Set after a correct password when the account requires MFA. The session is
    // NOT authenticated until the second factor is verified.
    pendingMfaUserId?: number;
    pendingMfaMethod?: "sms" | "email";
  }
}

const PORT = parseInt(process.env.AUXINUX_PORT ?? "3001");
const HTTP_REDIRECT_PORT = parseInt(process.env.AUXINUX_HTTP_REDIRECT_PORT ?? "80");
const SESSION_SECRET = process.env.AUXINUX_SESSION_SECRET ?? "auxinux-dev-secret-change-in-production-!";
const DATA_DIR = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinux";
const MAX_URL_DOWNLOADS = Math.max(1, Math.min(8, parseInt(process.env.AUXINUX_MAX_URL_DOWNLOADS ?? "3", 10) || 3));
const SESSION_COOKIE_SECURE: boolean | "auto" =
  process.env.AUXINUX_SECURE_COOKIE === "1"
    ? true
    : process.env.AUXINUX_SECURE_COOKIE === "0"
      ? false
      : "auto";

if (SESSION_SECRET === "auxinux-dev-secret-change-in-production-!") {
  console.warn("[security] WARNING: Using default session secret. Set AUXINUX_SESSION_SECRET env var for production!");
}
const APP_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const UI_DIST_DIR = path.join(APP_ROOT, "apps", "ui", "dist");
const LANG_DIR = path.join(APP_ROOT, "lang");
const ISOS_DIR = process.env.QEMU_ISOS_DIR ?? "/var/lib/libvirt/images/isos";
const LXC_TEMPLATES_DIR = process.env.LXC_TEMPLATES_DIR ?? path.join(DATA_DIR, "templates", "lxc");
const DOCKER_ARCHIVES_DIR = process.env.DOCKER_ARCHIVES_DIR ?? path.join(DATA_DIR, "templates", "docker");
const VM_DISKS_DIR = process.env.VM_DISKS_DIR ?? path.join(DATA_DIR, "images", "vm-disks");
const VM_TEMPLATES_DIR = process.env.VM_TEMPLATES_DIR ?? path.join(DATA_DIR, "templates", "vm");
// Hard cap on uploaded template/ISO size (bytes). Configurable for large ISOs.
const TEMPLATE_MAX_BYTES = parseInt(process.env.TEMPLATE_MAX_BYTES ?? `${8 * 1024 * 1024 * 1024}`, 10);
// Backup/restore can run for hours on huge LXC/VM images. These run inside a
// background task that streams progress, so the runner IPC call must not time
// out prematurely (the old 15-min cap killed large container backups).
const BACKUP_TIMEOUT_MS = parseInt(process.env.BACKUP_TIMEOUT_MS ?? `${12 * 60 * 60 * 1000}`, 10);
// Remote template/ISO depot (autoindex). Layout: <base>/{ISO,VM}/{AMD64,ARM}/...
// AuxiNux depots — admin-configurable (stored in settings, env overrides).
const REPO_DEFAULTS = {
  deb: "https://dep.auxinux.ca/debian/",
  templates: "https://dep.auxinux.ca/TEMPLATES/",
  kernel: "https://dep.auxinux.ca/VIRTUA/KERNEL/",
  generic: "https://dep.auxinux.ca/VIRTUA/",
} as const;
type RepoKind = keyof typeof REPO_DEFAULTS;
function getRepoUrl(kind: RepoKind): string {
  const fromSetting = getSetting(`repo.${kind}`)?.trim();
  return (fromSetting || REPO_DEFAULTS[kind]).replace(/\/*$/, "/");
}
function getTemplateDepotBase(): string {
  return (process.env.TEMPLATE_DEPOT_URL?.trim() || getRepoUrl("templates")).replace(/\/*$/, "/");
}
/** When overwriteSources is set, hand the local runner the configured DEB +
 * VIRTUA KERNEL depot URLs so it can rewrite the container's apt sources. */
function lxcPayloadWithRepos<T extends { overwriteSources?: boolean }>(data: T): T & { debRepoUrl?: string; kernelRepoUrl?: string } {
  if (!data.overwriteSources) return data;
  return { ...data, debRepoUrl: getRepoUrl("deb"), kernelRepoUrl: getRepoUrl("kernel") };
}
const WS_TICKET_TTL_MS = 60_000;
const LXC_SNAPSHOT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const LXC_SNAPSHOT_NAME_ERROR = "Invalid snapshot name: use 1-64 alphanumeric, dot, hyphen or underscore characters";

function normalizeLxcSnapshotName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return LXC_SNAPSHOT_NAME_REGEX.test(name) ? name : null;
}

function detectNodeReleaseVersion(): string {
  const releaseVersionPath = path.join(APP_ROOT, ".auxinux-release-version");
  if (fs.existsSync(releaseVersionPath)) {
    return fs.readFileSync(releaseVersionPath, "utf8").trim() || "unknown";
  }

  const packageJsonPath = path.join(APP_ROOT, "apps", "api", "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  return "unknown";
}

const APP_VERSION = detectNodeReleaseVersion();

type ManagedFileType = "iso" | "lxc_template" | "docker_image" | "vm_disk";
interface RebootSafetyCheck {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}
interface RebootSafetyReport {
  ok: boolean;
  checks: RebootSafetyCheck[];
}
type TaskKind =
  | "upload"
  | "url-download"
  | "docker-pull"
  | "lxc-cache"
  | "backup-upload"
  | "backup-delete"
  | "vm-snapshot"
  | "vm-backup"
  | "vm-rollback"
  | "vm-snapshot-delete"
  | "lxc-snapshot"
  | "lxc-backup"
  | "vm-restore"
  | "lxc-restore"
  | "lxc-rollback"
  | "lxc-snapshot-delete"
  | "create"
  | "delete"
  | "action"
  | "config"
  | "clone"
  | "ssl"
  | "storage"
  | "network"
  | "firewall";
type TaskStatus = "pending" | "running" | "completed" | "failed";

type ConsoleTicketKind =
  | "host"
  | "remote-host"
  | "vm-console"
  | "remote-vm-console"
  | "vm-vnc"
  | "remote-vm-vnc"
  | "vm-spice"
  | "remote-vm-spice"
  | "lxc-console"
  | "remote-lxc-console"
  | "docker-console"
  | "remote-docker-console";
type ResourceAclType = "vm" | "lxc" | "docker";
type ResourceAclPermission =
  | "view"
  | "console"
  | "power"
  | "media"
  | "modify"
  | "delete"
  | "backup"
  | "snapshot"
  | "admin";
interface ConsoleTicket {
  id: string;
  kind: ConsoleTicketKind;
  target?: string;
  proxyNode?: string;
  userId: number;
  deviceId?: string;
  resourceType?: ResourceAclType;
  resourceNode?: string;
  resourceName?: string;
  mode?: "text" | "graphical" | "spice";
  initialCommand?: string;
  expiresAt: number;
  uses?: number;
}

const wsTickets = new Map<string, ConsoleTicket>();

interface SpiceConsoleInfo {
  ok?: boolean;
  enabled?: boolean;
  active?: boolean;
  requiresStart?: boolean;
  requiresRestart?: boolean;
  spicePort?: number;
  spiceTlsPort?: number;
  spiceHost?: string;
  spicePassword?: string;
}

interface VmRdpConsoleInfo {
  ok: boolean;
  vmName: string;
  state: string;
  vncHost: string;
  vncPort?: number;
  xrdpInstalled: boolean;
  xrdpActive: boolean;
  xrdpPort: number;
  xrdpLibVnc?: string;
  profileName: string;
  profileSection: string;
  profilePresent: boolean;
  consoleWidth?: number;
  consoleHeight?: number;
  ready: boolean;
  warnings: string[];
  consolePassword?: string;
}

interface VmVncPasswordInfo {
  password: string;
}

// Periodically clean up expired WebSocket tickets to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [id, ticket] of wsTickets.entries()) {
    if (ticket.expiresAt < now) wsTickets.delete(id);
  }
}, 60_000).unref();

interface BackgroundTask {
  id: string;
  ownerUserId: number;
  ownerUsername: string;
  kind: TaskKind;
  action: string;
  label: string;
  resourceType?: string;
  resourceName?: string;
  status: TaskStatus;
  progressPercent: number;
  bytesCurrent?: number;
  bytesTotal?: number;
  message?: string;
  detail?: string;
  activityLog?: string[];
  error?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

const backgroundTasks = new Map<string, BackgroundTask>();
const execFileAsync = promisify(execFile);

// Load TLS options if a valid certificate exists
const tlsOptions = await loadTlsOptions();
if (tlsOptions) {
  console.log("[ssl] TLS certificate found — starting in HTTPS mode");
}

const app = Fastify({
  logger: { level: "info" },
  trustProxy: true,
  ...(tlsOptions ? { https: tlsOptions } : {}),
});
// Keep binary migration uploads as streams; never buffer VM/LXC/Docker images
// in API memory. Routes consuming this type must pipe req.body to disk.
app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
const db = getDb();

// ── Local operational error log (polled by VDM) ────────────────────────────
function recordNodeError(level: "warn" | "error", category: string, message: string): void {
  try {
    db.prepare("INSERT INTO node_error_log (ts, level, category, message) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), level, category, message.slice(0, 2000));
    // Cap the table: keep only the most recent 5000 entries.
    db.prepare("DELETE FROM node_error_log WHERE id NOT IN (SELECT id FROM node_error_log ORDER BY id DESC LIMIT 5000)").run();
  } catch {
    // Logging must never crash an operation.
  }
}

function classifyNodeCategory(url: string): string {
  const pathname = url.split("?")[0];
  if (pathname.includes("/storage")) return "storage";
  if (pathname.includes("/backup")) return "backup";
  if (pathname.includes("/migrat")) return "migration";
  if (pathname.includes("/node") || pathname.includes("/cluster")) return "nodes";
  return "system";
}
startAuditLogPruner(db);
ensureLocalNodeAuthToken();
ensureLocalDatacenterNode();

interface ResourceAclRow {
  id: number;
  user_id: number;
  resource_type: ResourceAclType;
  resource_name: string;
  can_view: number;
  can_console: number;
  can_power: number;
  can_media: number;
  can_modify: number;
  can_delete: number;
  can_backup: number;
  can_snapshot: number;
  can_admin: number;
  created_at: string;
  updated_at: string;
}

interface ResourceOwnerMeta {
  ownerUserId: number | null;
}

interface UserLimitsState {
  maxVms: number;
  maxLxc: number;
  maxDocker: number;
  maxStorageGb: number;
  allowVmCreate: boolean;
  allowVmDelete: boolean;
  allowVmModify: boolean;
  allowLxcCreate: boolean;
  allowLxcDelete: boolean;
  allowDockerCreate: boolean;
  allowDockerDelete: boolean;
  allowIsoUpload: boolean;
  allowIsoDelete: boolean;
  allowStorageManage: boolean;
  allowNetworkManage: boolean;
}

interface ResourcePermissionState {
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canMedia: boolean;
  canModify: boolean;
  canDelete: boolean;
  canBackup: boolean;
  canSnapshot: boolean;
  canAdmin: boolean;
}

type UiSection =
  | "datacenter"
  | "createWizard"
  | "host"
  | "dashboard"
  | "health"
  | "hostShell"
  | "storageOverview"
  | "isoLibrary"
  | "backups"
  | "network"
  | "firewall"
  | "users"
  | "audit"
  | "settings"
  | "vms"
  | "vmCreate"
  | "lxc"
  | "lxcCreate"
  | "docker"
  | "dockerCreate";

interface AuthCapabilitiesResponse {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  displayName: string | null;
  email: string | null;
  mustChangePassword: boolean;
  limits: UserLimitsState;
  sections: Record<UiSection, boolean>;
  resources: {
    vms: Array<{ name: string; nodeName: string; permissions: ResourcePermissionState }>;
    lxc: Array<{ name: string; nodeName: string; permissions: ResourcePermissionState }>;
    docker: Array<{ id: string; nodeName: string; permissions: ResourcePermissionState }>;
  };
  defaultRoute: string;
}

const DEFAULT_USER_LIMITS: UserLimitsState = {
  maxVms: -1,
  maxLxc: -1,
  maxDocker: -1,
  maxStorageGb: -1,
  allowVmCreate: false,
  allowVmDelete: false,
  allowVmModify: false,
  allowLxcCreate: false,
  allowLxcDelete: false,
  allowDockerCreate: false,
  allowDockerDelete: false,
  allowIsoUpload: false,
  allowIsoDelete: false,
  allowStorageManage: false,
  allowNetworkManage: false,
};

interface DatacenterNodeRow {
  id: number;
  name: string;
  display_name: string | null;
  role: "primary" | "secondary";
  api_url: string | null;
  auth_token: string | null;
  enabled: number;
  is_local: number;
  notes: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DatacenterJoinTokenRow {
  id: number;
  token: string;
  note: string | null;
  expires_at: string;
  created_at: string;
}

interface DatacenterStoragePoolRow {
  id: number;
  name: string;
  path: string;
  type: string;
  content: string;
  mount_source: string | null;
  fstype: string | null;
  mount_options: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function getLocalNodeName() {
  return process.env.AUXINUX_NODE_NAME || os.hostname();
}

function getDatacenterConfig(): DatacenterConfig {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('datacenter.mode', 'datacenter.name', 'datacenter.primaryNodeName', 'datacenter.primaryApiUrl')").all() as Array<{ key: string; value: string | null }>;
  const values = new Map(rows.map((row) => [row.key, row.value ?? ""]));
  const primaryNodeName = values.get("datacenter.primaryNodeName") || getLocalNodeName();
  return {
    mode: (values.get("datacenter.mode") as DatacenterConfig["mode"] | undefined) || "standalone",
    name: values.get("datacenter.name") || "Datacenter",
    primaryNodeName,
    primaryApiUrl: values.get("datacenter.primaryApiUrl") || null,
  };
}

function setDatacenterConfig(config: DatacenterConfig) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsert.run("datacenter.mode", config.mode);
  upsert.run("datacenter.name", config.name);
  upsert.run("datacenter.primaryNodeName", config.primaryNodeName);
  upsert.run("datacenter.primaryApiUrl", config.primaryApiUrl ?? null);
}

function ensureLocalDatacenterNode() {
  const localNodeName = getLocalNodeName();
  const config = getDatacenterConfig();
  const localRole: DatacenterNode["role"] = config.mode === "datacenter" && config.primaryNodeName !== localNodeName ? "secondary" : "primary";
  db.prepare(`
    INSERT INTO datacenter_nodes (name, display_name, role, api_url, auth_token, enabled, is_local, notes, last_seen_at)
    VALUES (?, ?, ?, NULL, COALESCE((SELECT value FROM settings WHERE key = 'datacenter.nodeAuthToken'), NULL), 1, 1, 'Local Virtua node', datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      is_local = 1,
      enabled = 1,
      role = excluded.role,
      auth_token = COALESCE((SELECT value FROM settings WHERE key = 'datacenter.nodeAuthToken'), datacenter_nodes.auth_token),
      last_seen_at = datetime('now'),
      updated_at = datetime('now')
  `).run(localNodeName, localNodeName, localRole);

  // Only ONE row may be the local node. A previous hostname (e.g. virtuaos-live
  // before it became srv02) can leave a stale is_local row → the local runner
  // gets queried twice and every resource appears duplicated. Demote any other
  // local rows, and remove a stale phantom local row (no API URL) outright.
  db.prepare("UPDATE datacenter_nodes SET is_local = 0, updated_at = datetime('now') WHERE name != ? AND is_local = 1").run(localNodeName);
  db.prepare("DELETE FROM datacenter_nodes WHERE name != ? AND is_local = 0 AND (api_url IS NULL OR api_url = '') AND notes = 'Local Virtua node'").run(localNodeName);

  const existing = config;
  if (existing.mode === "standalone" && (existing.primaryNodeName !== localNodeName || !existing.name)) {
    setDatacenterConfig({
      mode: existing.mode,
      name: existing.name || "Datacenter",
      primaryNodeName: localNodeName,
      primaryApiUrl: existing.primaryApiUrl ?? null,
    });
  }
}

function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string | null } | undefined;
  return row?.value ?? null;
}

function getLocalNodeAuthToken() {
  return getSetting("datacenter.nodeAuthToken");
}

/**
 * Secret used to sign Desktop client access tokens. Prefers an explicit env var;
 * otherwise mints and persists a strong random secret on first use (stable
 * across restarts so issued tokens stay valid until they expire on their own).
 */
function getDesktopTokenSecret(): string {
  const fromEnv = process.env.AUXINUX_DESKTOP_TOKEN_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const existing = getSetting("desktop.tokenSecret");
  if (existing && existing.length >= 32) return existing;
  const secret = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('desktop.tokenSecret', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(secret);
  return secret;
}

/**
 * Ensure this node has an internal auth token. Without it, VDM (and any
 * federated node) gets 403 on every /api/internal/* call — the token is the
 * shared secret VDM presents via the x-auxinux-node-token header.
 *
 * Historically the token was only ever READ, never generated, so a fresh
 * install left every node tokenless and VDM could never connect. We now mint a
 * strong token on first boot and persist it in settings so it is stable across
 * restarts and discoverable by the VDM installer (datacenter.nodeAuthToken).
 */
function ensureLocalNodeAuthToken() {
  const existing = getSetting("datacenter.nodeAuthToken");
  if (existing && existing.trim().length >= 32) return existing;
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('datacenter.nodeAuthToken', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(token);
  return token;
}

function getNodeRow(name: string) {
  return db.prepare("SELECT * FROM datacenter_nodes WHERE name = ?").get(name) as DatacenterNodeRow | undefined;
}

function getNodeRowByAuthToken(token: string) {
  return db.prepare("SELECT * FROM datacenter_nodes WHERE auth_token = ?").get(token) as DatacenterNodeRow | undefined;
}

function getResourceNodeName(resourceType: "vm" | "lxc" | "docker", resourceName: string) {
  const localNodeName = getLocalNodeName();
  if (resourceType === "vm") {
    const row = db.prepare("SELECT COALESCE(node_name, ?) AS node_name FROM qemu_vms WHERE vm_name = ?").get(localNodeName, resourceName) as { node_name?: string } | undefined;
    return row?.node_name ?? localNodeName;
  }
  if (resourceType === "lxc") {
    const row = db.prepare("SELECT COALESCE(node_name, ?) AS node_name FROM lxc_containers WHERE container_name = ?").get(localNodeName, resourceName) as { node_name?: string } | undefined;
    return row?.node_name ?? localNodeName;
  }
  const rows = db.prepare("SELECT container_id, COALESCE(node_name, ?) AS node_name FROM docker_containers").all(localNodeName) as Array<{ container_id: string; node_name: string }>;
  const match = rows.find((row) => row.container_id === resourceName || row.container_id.startsWith(resourceName) || resourceName.startsWith(row.container_id));
  return match?.node_name ?? localNodeName;
}

function getResourceNode(resourceType: "vm" | "lxc" | "docker", resourceName: string) {
  const nodeName = getResourceNodeName(resourceType, resourceName);
  return listDatacenterNodes().find((node) => node.name === nodeName) ?? listDatacenterNodes().find((node) => node.isLocal);
}

function rememberDiscoveredResourceNode(resourceType: "vm" | "lxc" | "docker", resourceName: string, nodeName: string) {
  if (resourceType === "vm") {
    db.prepare("INSERT INTO qemu_vms (vm_name, node_name) VALUES (?, ?) ON CONFLICT(vm_name) DO UPDATE SET node_name = excluded.node_name")
      .run(resourceName, nodeName);
    return;
  }
  if (resourceType === "lxc") {
    db.prepare("INSERT INTO lxc_containers (container_name, node_name) VALUES (?, ?) ON CONFLICT(container_name) DO UPDATE SET node_name = excluded.node_name")
      .run(resourceName, nodeName);
    return;
  }
  db.prepare("UPDATE docker_containers SET node_name = ? WHERE container_id = ? OR container_id LIKE ? OR ? LIKE container_id")
    .run(nodeName, resourceName, `${resourceName}%`, resourceName);
}

function mapJoinTokenRow(row: DatacenterJoinTokenRow): DatacenterJoinToken {
  return {
    id: row.id,
    token: row.token,
    note: row.note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function listDatacenterStoragePoolRows() {
  return db.prepare(`
    SELECT *
    FROM datacenter_storage_pools
    WHERE enabled = 1
    ORDER BY name
  `).all() as DatacenterStoragePoolRow[];
}

function resolveManagedStoragePool(storagePool: string) {
  const localPool = db.prepare("SELECT path, content FROM storage_pools WHERE name = ?").get(storagePool) as { path: string; content: string } | undefined;
  if (localPool) {
    return {
      path: localPool.path,
      content: JSON.parse(localPool.content || "[]") as string[],
      scope: "local" as const,
    };
  }
  const sharedPool = db.prepare("SELECT path, content FROM datacenter_storage_pools WHERE name = ?").get(storagePool) as { path: string; content: string } | undefined;
  if (sharedPool) {
    return {
      path: sharedPool.path,
      content: JSON.parse(sharedPool.content || "[]") as string[],
      scope: "datacenter" as const,
    };
  }
  return undefined;
}

function sanitizeDockerStoragePathSegment(value: string) {
  const segment = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "container";
}

function normalizeDockerPoolRelativePath(value: string, fallback: string) {
  const raw = value.trim() || fallback;
  if (/[\n\r\0\t:\\]/.test(raw)) {
    throw Object.assign(new Error("Invalid Docker volume path for storage pool"), { statusCode: 400 });
  }
  if (path.isAbsolute(raw)) {
    throw Object.assign(new Error("Storage pool volume path must be relative"), { statusCode: 400 });
  }
  const normalized = path.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw Object.assign(new Error("Storage pool volume path must stay inside the selected pool"), { statusCode: 400 });
  }
  return normalized;
}

async function prepareDockerRunPayload(input: RunDockerInput): Promise<RunDockerInput> {
  const storagePool = input.storagePool?.trim();
  if (!storagePool) return input;

  const pool = resolveManagedStoragePool(storagePool);
  if (!pool) {
    throw Object.assign(new Error("Storage pool not found"), { statusCode: 404 });
  }
  if (!pool.content.includes("container")) {
    throw Object.assign(new Error("Storage pool does not allow container content"), { statusCode: 400 });
  }

  const containerName = sanitizeDockerStoragePathSegment(input.name);
  const volumes = await Promise.all((input.volumes ?? []).map(async (volume, index) => {
    const hostPath = volume.hostPath.trim();
    if (path.isAbsolute(hostPath)) {
      return { ...volume, hostPath };
    }

    const fallback = path.join("docker", containerName, `volume-${index + 1}`);
    const relativeHostPath = normalizeDockerPoolRelativePath(hostPath, fallback);
    const resolvedHostPath = path.join(pool.path, relativeHostPath);
    await fs.promises.mkdir(resolvedHostPath, { recursive: true });
    return { ...volume, hostPath: resolvedHostPath };
  }));

  return { ...input, storagePool, volumes };
}

async function prepareVmCreatePayload(input: CreateVmInput) {
  let poolPath: string | undefined;
  if (input.diskGb && input.existingPath) {
    throw Object.assign(new Error("diskGb and existingPath cannot be used together"), { statusCode: 400 });
  }
  if (input.diskGb && input.storagePool) {
    const pool = resolveManagedStoragePool(input.storagePool);
    if (!pool) throw Object.assign(new Error("Storage pool not found"), { statusCode: 404 });
    if (!pool.content.includes("vm") && !pool.content.includes("disk")) {
      throw Object.assign(new Error("Storage pool does not allow VM disks"), { statusCode: 400 });
    }
    poolPath = pool.path;
  } else if (input.diskGb && !input.storagePool) {
    throw Object.assign(new Error("storagePool is required when diskGb is specified"), { statusCode: 400 });
  }

  return {
    ...input,
    storagePool: poolPath,
    isoFile: input.isoFile ? await resolveManagedIsoPath(input.isoFile) : undefined,
  };
}

function mapDatacenterNodeRow(row: DatacenterNodeRow): DatacenterNode {
  let status: DatacenterNode["status"] = row.is_local ? "local" : "unknown";
  if (!row.is_local && row.last_seen_at) {
    status = (Date.now() - new Date(row.last_seen_at).getTime()) < 90_000 ? "online" : "offline";
  }
  return {
    name: row.name,
    displayName: row.display_name,
    role: row.role,
    apiUrl: row.api_url,
    authToken: row.auth_token,
    enabled: !!row.enabled,
    isLocal: !!row.is_local,
    status,
    notes: row.notes,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listDatacenterNodes(): DatacenterNode[] {
  ensureLocalDatacenterNode();
  const rows = db.prepare("SELECT * FROM datacenter_nodes ORDER BY is_local DESC, name ASC").all() as DatacenterNodeRow[];
  return rows.map(mapDatacenterNodeRow);
}

/**
 * Enabled nodes for resource aggregation, DEDUPLICATED so each physical target
 * is queried exactly once. Without this, a stale duplicate local row (e.g. after
 * a hostname change virtuaos-live → srv02 leaves two is_local rows) makes the
 * local runner be queried twice and every VM/LXC/Docker appears doubled in the
 * UI. We collapse all local rows to a single local query and dedupe remotes by
 * their API URL, skipping phantom remotes that have no API URL.
 */
function enabledResourceNodes(): DatacenterNode[] {
  const out: DatacenterNode[] = [];
  let localAdded = false;
  const seenRemote = new Set<string>();
  for (const node of listDatacenterNodes()) {
    if (!node.enabled) continue;
    if (node.isLocal) {
      if (localAdded) continue;
      localAdded = true;
      out.push(node);
      continue;
    }
    const key = (node.apiUrl ?? "").replace(/\/+$/, "").toLowerCase();
    if (!key) continue;            // phantom remote (no API URL) → skip, can't query
    if (seenRemote.has(key)) continue;
    seenRemote.add(key);
    out.push(node);
  }
  return out;
}

function requireInternalNodeToken(req: FastifyRequest) {
  const token = `${req.headers["x-auxinux-node-token"] ?? ""}`.trim();
  const expected = getLocalNodeAuthToken();
  if (!token || !expected) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  // Use timing-safe comparison to prevent timing-based token leakage
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  const valid = tokenBuf.length === expectedBuf.length &&
    timingSafeEqual(tokenBuf, expectedBuf);
  if (!valid) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

async function fetchRemoteNode<T>(node: DatacenterNode, pathName: string, init?: RequestInit): Promise<T> {
  if (!node.apiUrl || !node.authToken) {
    throw new Error(`Node ${node.name} is missing API URL or auth token`);
  }
  const base = node.apiUrl.replace(/\/+$/, "");
  const headers = new Headers(init?.headers ?? {});
  headers.set("x-auxinux-node-token", node.authToken);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${base}${pathName}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `Remote node HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function findResourceNodeName(resourceType: "vm" | "lxc" | "docker", resourceName: string): Promise<string> {
  const localNodeName = getLocalNodeName();
  const fromDb = getResourceNodeName(resourceType, resourceName);
  if (fromDb !== localNodeName) return fromDb;

  try {
    if (resourceType === "vm") {
      const localVms = await callRunner<Array<{ name: string }>>("qemu_vms");
      if (localVms.some((entry) => entry.name === resourceName)) return localNodeName;
    } else if (resourceType === "lxc") {
      const localLxc = await callRunner<Array<{ name: string }>>("lxc_containers");
      if (localLxc.some((entry) => entry.name === resourceName)) return localNodeName;
    } else {
      const localDocker = await callRunner<Array<{ id: string }>>("docker_containers");
      if (localDocker.some((entry) => entry.id === resourceName || entry.id.startsWith(resourceName) || resourceName.startsWith(entry.id))) {
        return localNodeName;
      }
    }
  } catch {}

  for (const node of listDatacenterNodes().filter((entry) => entry.enabled && !entry.isLocal)) {
    try {
      const resources = await fetchRemoteNode<DatacenterResourceEntry[]>(node, "/api/internal/node/resources");
      if (resources.some((entry) => entry.resourceType === resourceType && entry.resourceName === resourceName)) {
        rememberDiscoveredResourceNode(resourceType, resourceName, node.name);
        return node.name;
      }
    } catch {}
  }

  return fromDb;
}

async function getResourceNodeAsync(resourceType: "vm" | "lxc" | "docker", resourceName: string) {
  const nodeName = await findResourceNodeName(resourceType, resourceName);
  return listDatacenterNodes().find((node) => node.name === nodeName) ?? listDatacenterNodes().find((node) => node.isLocal);
}

app.setErrorHandler((error, req, reply) => {
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : 500;
  const message = error instanceof Error ? error.message : "Internal Server Error";
  const isProduction = process.env.NODE_ENV === "production";
  const isAdmin = req.session?.role === "ADMIN";
  // Node-to-node callers authenticate with the shared node token, not a
  // session — VDM must see the REAL failure reason (rclone log tail, mount
  // error…) to log it and heal, otherwise every 5xx surfaces as a masked
  // "Internal error (ID: …)" in the VDM logs and the root cause is invisible.
  const isInternalNodeCall = `${req.headers["x-auxinux-node-token"] ?? ""}`.trim().length > 0;

  // 4xx errors carry intentional user-facing feedback (validation, auth,
  // permission denied) — pass them through verbatim. Only 5xx errors are
  // potentially leaky.
  if (statusCode < 500) {
    return reply.status(statusCode).send({ error: message });
  }

  // For 5xx we generate a short correlation ID, log the FULL stack server-side
  // with that ID, and return a structured response. Admins see the real
  // message (they wrote it, they can fix it). Non-admins in production see a
  // generic message plus the ID — they can copy it to a support request and
  // the admin can grep the journal: `journalctl -u auxinuxvirtual-api | grep <id>`.
  const errorId = randomUUID().slice(0, 8);
  const stack = error instanceof Error && error.stack ? error.stack : message;
  console.error(`[api][${errorId}] ${req.method} ${req.url} — ${stack}`);
  recordNodeError("error", classifyNodeCategory(req.url ?? ""), `${req.method} ${req.url} — ${message}`.slice(0, 2000));

  let clientMessage: string;
  if (!isProduction || isAdmin || isInternalNodeCall) {
    clientMessage = message;
  } else {
    clientMessage = `Internal error (ID: ${errorId}). Ask an admin to check the API logs for this ID.`;
  }

  return reply.status(statusCode).send({ error: clientMessage, errorId });
});

// ── Plugins ────────────────────────────────────────────────────────────────
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: SESSION_SECRET,
  cookie: {
    // Keep HTTPS cookies secure while still allowing the local HTTP fallback port
    // to preserve sessions. Without "auto", HTTP :8441 loses the CSRF session.
    secure: SESSION_COOKIE_SECURE,
    httpOnly: true,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
  },
  saveUninitialized: false,
});
await app.register(fastifyCsrf, { sessionPlugin: "@fastify/session" });
await app.register(fastifyMultipart, { limits: { fileSize: 8 * 1024 * 1024 * 1024 } });
await app.register(fastifyRateLimit, { max: 1200, timeWindow: 60_000 });
await app.register(fastifyStatic, {
  root: UI_DIST_DIR,
  prefix: "/",
  wildcard: false,
});

// ── Auth helpers ───────────────────────────────────────────────────────────
// Endpoints that a user with `must_change_password=1` is allowed to hit
// before changing their password. Anything else returns 409 to force the flow.
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = new Set([
  "/api/auth/csrf",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/change-password",
  "/api/auth/capabilities",
]);

function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.session.userId) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  if (req.session.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED_PATHS.has((req.routeOptions?.url ?? req.url).split("?")[0])) {
    throw Object.assign(new Error("Password change required"), { statusCode: 409 });
  }
}

function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.session.userId) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  if (req.session.role !== "ADMIN") throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

function mapUserLimitsRow(row?: Record<string, number> | null): UserLimitsState {
  if (!row) return { ...DEFAULT_USER_LIMITS };
  return {
    maxVms: row.max_vms ?? DEFAULT_USER_LIMITS.maxVms,
    maxLxc: row.max_lxc ?? DEFAULT_USER_LIMITS.maxLxc,
    maxDocker: row.max_docker ?? DEFAULT_USER_LIMITS.maxDocker,
    maxStorageGb: row.max_storage_gb ?? DEFAULT_USER_LIMITS.maxStorageGb,
    allowVmCreate: !!row.allow_vm_create,
    allowVmDelete: !!row.allow_vm_delete,
    allowVmModify: !!row.allow_vm_modify,
    allowLxcCreate: !!row.allow_lxc_create,
    allowLxcDelete: !!row.allow_lxc_delete,
    allowDockerCreate: !!row.allow_docker_create,
    allowDockerDelete: !!row.allow_docker_delete,
    allowIsoUpload: !!row.allow_iso_upload,
    allowIsoDelete: !!row.allow_iso_delete,
    allowStorageManage: !!row.allow_storage_manage,
    allowNetworkManage: !!row.allow_network_manage,
  };
}

function mapUserRow(row?: {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  display_name: string | null;
  email: string | null;
  suspended?: number;
  must_change_password?: number;
  permissions?: string | null;
  created_at?: string;
} | null) {
  if (!row) return null;
  let permissions: string[] = [];
  if (row.permissions) {
    try {
      const parsed = JSON.parse(row.permissions);
      if (Array.isArray(parsed)) {
        permissions = parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {}
  }

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
    email: row.email,
    suspended: !!row.suspended,
    mustChangePassword: !!row.must_change_password,
    permissions,
    createdAt: row.created_at ?? new Date(0).toISOString(),
  };
}

function getUserLimitsState(userId: number, role: string): UserLimitsState {
  if (role === "ADMIN") {
    return {
      ...DEFAULT_USER_LIMITS,
      allowIsoDelete: true,
      allowStorageManage: true,
      allowNetworkManage: true,
    };
  }
  const row = db.prepare("SELECT * FROM user_limits WHERE user_id = ?").get(userId) as Record<string, number> | undefined;
  return mapUserLimitsRow(row);
}

function getResourceOwnerMeta(resourceType: ResourceAclType, resourceName: string): ResourceOwnerMeta {
  if (resourceType === "vm") {
    const row = db.prepare("SELECT user_id FROM qemu_vms WHERE vm_name = ?").get(resourceName) as { user_id: number | null } | undefined;
    return { ownerUserId: row?.user_id ?? null };
  }
  if (resourceType === "lxc") {
    const row = db.prepare("SELECT user_id FROM lxc_containers WHERE container_name = ?").get(resourceName) as { user_id: number | null } | undefined;
    return { ownerUserId: row?.user_id ?? null };
  }
  const row = db.prepare(`
    SELECT user_id
    FROM docker_containers
    WHERE container_id = ?
       OR container_id LIKE ?
       OR ? LIKE container_id || '%'
    ORDER BY CASE WHEN container_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(resourceName, `${resourceName}%`, resourceName, resourceName) as { user_id: number | null } | undefined;
  return { ownerUserId: row?.user_id ?? null };
}

function getResourceAclRow(userId: number, resourceType: ResourceAclType, resourceName: string) {
  if (resourceType === "docker") {
    return db
      .prepare(`
        SELECT *
        FROM user_resource_acl
        WHERE user_id = ?
          AND resource_type = ?
          AND (
            resource_name = ?
            OR resource_name LIKE ?
            OR ? LIKE resource_name || '%'
          )
        ORDER BY CASE WHEN resource_name = ? THEN 0 ELSE 1 END
        LIMIT 1
      `)
      .get(userId, resourceType, resourceName, `${resourceName}%`, resourceName, resourceName) as ResourceAclRow | undefined;
  }
  return db
    .prepare("SELECT * FROM user_resource_acl WHERE user_id = ? AND resource_type = ? AND resource_name = ?")
    .get(userId, resourceType, resourceName) as ResourceAclRow | undefined;
}

function resourceAclAllows(row: ResourceAclRow | undefined, permission: ResourceAclPermission) {
  if (!row) return false;
  if (row.can_admin) return true;
  const map: Record<ResourceAclPermission, keyof ResourceAclRow | null> = {
    view: "can_view",
    console: "can_console",
    power: "can_power",
    media: "can_media",
    modify: "can_modify",
    delete: "can_delete",
    backup: "can_backup",
    snapshot: "can_snapshot",
    admin: "can_admin",
  };
  const key = map[permission];
  return key ? Boolean(row[key]) : false;
}

function hasResourcePermission(userId: number, role: string, resourceType: ResourceAclType, resourceName: string, permission: ResourceAclPermission) {
  if (role === "ADMIN") return true;
  const ownerMeta = getResourceOwnerMeta(resourceType, resourceName);
  if (ownerMeta.ownerUserId !== null && ownerMeta.ownerUserId === userId) return true;
  const acl = getResourceAclRow(userId, resourceType, resourceName);
  if (permission === "view" && ownerMeta.ownerUserId === null) {
    return resourceAclAllows(acl, "view");
  }
  return resourceAclAllows(acl, permission);
}

function getResourcePermissionState(userId: number, role: string, resourceType: ResourceAclType, resourceName: string): ResourcePermissionState {
  return {
    canView: hasResourcePermission(userId, role, resourceType, resourceName, "view"),
    canConsole: hasResourcePermission(userId, role, resourceType, resourceName, "console"),
    canPower: hasResourcePermission(userId, role, resourceType, resourceName, "power"),
    canMedia: hasResourcePermission(userId, role, resourceType, resourceName, "media"),
    canModify: hasResourcePermission(userId, role, resourceType, resourceName, "modify"),
    canDelete: hasResourcePermission(userId, role, resourceType, resourceName, "delete"),
    canBackup: hasResourcePermission(userId, role, resourceType, resourceName, "backup"),
    canSnapshot: hasResourcePermission(userId, role, resourceType, resourceName, "snapshot"),
    canAdmin: hasResourcePermission(userId, role, resourceType, resourceName, "admin"),
  };
}

function requireResourcePermission(
  req: FastifyRequest,
  resourceType: ResourceAclType,
  resourceName: string,
  permission: ResourceAclPermission
) {
  if (!hasResourcePermission(req.session.userId!, req.session.role!, resourceType, resourceName, permission)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

function filterResourceNamesByPermission(
  userId: number,
  role: string,
  resourceType: ResourceAclType,
  names: string[],
  permission: ResourceAclPermission = "view"
) {
  if (role === "ADMIN") return new Set(names);
  return new Set(names.filter((name) => hasResourcePermission(userId, role, resourceType, name, permission)));
}

function mapAclRow(row: ResourceAclRow) {
  return {
    id: row.id,
    userId: row.user_id,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    canView: !!row.can_view,
    canConsole: !!row.can_console,
    canPower: !!row.can_power,
    canMedia: !!row.can_media,
    canModify: !!row.can_modify,
    canDelete: !!row.can_delete,
    canBackup: !!row.can_backup,
    canSnapshot: !!row.can_snapshot,
    canAdmin: !!row.can_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseResourceAclType(value: string): ResourceAclType {
  if (value === "vm" || value === "lxc" || value === "docker") return value;
  throw Object.assign(new Error("Invalid resource type"), { statusCode: 400 });
}

function requireResourceAclAdmin(req: FastifyRequest, resourceType: ResourceAclType, resourceName: string) {
  requireAuth(req, {} as FastifyReply);
  if (req.session.role === "ADMIN") return;
  if (!hasResourcePermission(req.session.userId!, req.session.role!, resourceType, resourceName, "admin")) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

function listResourceCatalog() {
  const localNodeName = getLocalNodeName();
  const vmRows = db.prepare(`
    SELECT q.vm_name AS resource_name, q.user_id AS owner_id, u.username AS owner_username, COALESCE(q.node_name, ?) AS node_name
    FROM qemu_vms q
    LEFT JOIN users u ON u.id = q.user_id
    ORDER BY q.vm_name
  `).all(localNodeName) as Array<{ resource_name: string; owner_id: number | null; owner_username: string | null; node_name: string }>;
  const lxcRows = db.prepare(`
    SELECT l.container_name AS resource_name, l.user_id AS owner_id, u.username AS owner_username, COALESCE(l.node_name, ?) AS node_name
    FROM lxc_containers l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.container_name
  `).all(localNodeName) as Array<{ resource_name: string; owner_id: number | null; owner_username: string | null; node_name: string }>;
  const dockerRows = db.prepare(`
    SELECT d.container_id AS resource_name, d.container_name AS display_name, d.user_id AS owner_id, u.username AS owner_username, COALESCE(d.node_name, ?) AS node_name
    FROM docker_containers d
    LEFT JOIN users u ON u.id = d.user_id
    ORDER BY d.container_name
  `).all(localNodeName) as Array<{ resource_name: string; display_name: string; owner_id: number | null; owner_username: string | null; node_name: string }>;

  return [
    ...vmRows.map((row) => ({
      resourceType: "vm" as const,
      resourceName: row.resource_name,
      displayName: row.resource_name,
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      nodeName: row.node_name,
    })),
    ...lxcRows.map((row) => ({
      resourceType: "lxc" as const,
      resourceName: row.resource_name,
      displayName: row.resource_name,
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      nodeName: row.node_name,
    })),
    ...dockerRows.map((row) => ({
      resourceType: "docker" as const,
      resourceName: row.resource_name,
      displayName: row.display_name || row.resource_name,
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      nodeName: row.node_name,
    })),
  ];
}

async function reconcileResourceMetadata() {
  const [systemVms, systemLxc, systemDocker] = await Promise.all([
    callRunner<Array<{ name: string }>>("qemu_vms").catch(() => []),
    callRunner<Array<{ name: string }>>("lxc_containers").catch(() => []),
    callRunner<Array<{ id: string }>>("docker_containers").catch(() => []),
  ]);

  const vmNames = new Set(systemVms.map((vm) => vm.name));
  const lxcNames = new Set(systemLxc.map((ct) => ct.name));
  const dockerIds = new Set(systemDocker.map((ct) => ct.id));

  const dbVmNames = db.prepare("SELECT vm_name FROM qemu_vms").all() as Array<{ vm_name: string }>;
  const dbLxcNames = db.prepare("SELECT container_name FROM lxc_containers").all() as Array<{ container_name: string }>;
  const dbDockerIds = db.prepare("SELECT container_id FROM docker_containers").all() as Array<{ container_id: string }>;

  let changed = false;

  for (const { vm_name } of dbVmNames) {
    if (vmNames.has(vm_name)) continue;
    db.prepare("DELETE FROM qemu_vms WHERE vm_name = ?").run(vm_name);
    db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ?").run(vm_name);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'vm' AND resource_name = ?").run(vm_name);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'vm' AND linked_resource_name = ?").run(vm_name);
    changed = true;
  }

  for (const { container_name } of dbLxcNames) {
    if (lxcNames.has(container_name)) continue;
    db.prepare("DELETE FROM lxc_containers WHERE container_name = ?").run(container_name);
    db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ?").run(container_name);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'lxc' AND resource_name = ?").run(container_name);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ?").run(container_name);
    changed = true;
  }

  for (const { container_id } of dbDockerIds) {
    if (dockerIds.has(container_id)) continue;
    db.prepare("DELETE FROM docker_containers WHERE container_id = ?").run(container_id);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'docker' AND resource_name = ?").run(container_id);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'docker' AND linked_resource_name = ?").run(container_id);
    changed = true;
  }

  if (changed) {
    await syncFirewallState();
  }
}

function getAccessibleResources(userId: number, role: string) {
  const localNodeName = getLocalNodeName();
  const vmRows = db.prepare("SELECT vm_name, COALESCE(node_name, ?) AS node_name FROM qemu_vms ORDER BY vm_name").all(localNodeName) as Array<{ vm_name: string; node_name: string }>;
  const lxcRows = db.prepare("SELECT container_name, COALESCE(node_name, ?) AS node_name FROM lxc_containers ORDER BY container_name").all(localNodeName) as Array<{ container_name: string; node_name: string }>;
  const dockerRows = db.prepare("SELECT container_id, COALESCE(node_name, ?) AS node_name FROM docker_containers ORDER BY container_name").all(localNodeName) as Array<{ container_id: string; node_name: string }>;

  return {
    vms: vmRows
      .map((row) => ({ name: row.vm_name, nodeName: row.node_name, permissions: getResourcePermissionState(userId, role, "vm", row.vm_name) }))
      .filter((entry) => entry.permissions.canView),
    lxc: lxcRows
      .map((row) => ({ name: row.container_name, nodeName: row.node_name, permissions: getResourcePermissionState(userId, role, "lxc", row.container_name) }))
      .filter((entry) => entry.permissions.canView),
    docker: dockerRows
      .map((row) => ({ id: row.container_id, nodeName: row.node_name, permissions: getResourcePermissionState(userId, role, "docker", row.container_id) }))
      .filter((entry) => entry.permissions.canView),
  };
}

function buildDefaultRoute(sections: Record<UiSection, boolean>, resources: AuthCapabilitiesResponse["resources"]) {
  if (sections.dashboard) return "/dashboard";
  if (sections.isoLibrary) return "/storage/isos";
  if (resources.vms.length === 1) return `/vms/${encodeURIComponent(resources.vms[0].name)}`;
  if (sections.vms) return "/vms";
  if (resources.lxc.length === 1) return `/lxc/${encodeURIComponent(resources.lxc[0].name)}`;
  if (sections.lxc) return "/lxc";
  if (resources.docker.length === 1) return `/docker/${encodeURIComponent(resources.docker[0].id)}`;
  if (sections.docker) return "/docker";
  if (sections.storageOverview) return "/storage";
  if (sections.network) return "/network";
  return "/access-denied";
}

function buildAuthCapabilities(user: {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  display_name: string | null;
  email: string | null;
  must_change_password: number;
}): AuthCapabilitiesResponse {
  const limits = getUserLimitsState(user.id, user.role);
  const resources = getAccessibleResources(user.id, user.role);
  const isAdmin = user.role === "ADMIN";
  const hasMediaAccess =
    resources.vms.some((entry) => entry.permissions.canMedia) ||
    resources.lxc.some((entry) => entry.permissions.canMedia) ||
    resources.docker.some((entry) => entry.permissions.canMedia);
  const canViewIsoLibrary =
    isAdmin ||
    limits.allowStorageManage ||
    limits.allowIsoUpload ||
    limits.allowIsoDelete ||
    limits.allowVmCreate ||
    limits.allowLxcCreate ||
    limits.allowDockerCreate ||
    hasMediaAccess;

  // "datacenter" gates GET /api/nodes and GET /api/nodes/:name/* (node-level
  // ISO/template/pool listings). The create wizard, the ISO manager and
  // every node-scoped form need these endpoints, so anyone who can create a
  // workload must also be allowed to read node data. Admins always get it.
  // True datacenter-administration endpoints (add/remove nodes, change
  // datacenter settings) are separately gated by requireAdmin.
  const canCreateAnything = isAdmin || limits.allowVmCreate || limits.allowLxcCreate || limits.allowDockerCreate;
  const sections: Record<UiSection, boolean> = {
    datacenter: canCreateAnything,
    createWizard: canCreateAnything,
    host: isAdmin,
    dashboard: isAdmin,
    health: isAdmin,
    hostShell: isAdmin,
    storageOverview: isAdmin || limits.allowStorageManage,
    isoLibrary: canViewIsoLibrary,
    backups: isAdmin || limits.allowStorageManage,
    network: isAdmin || limits.allowNetworkManage,
    firewall: isAdmin || limits.allowNetworkManage,
    users: isAdmin,
    audit: isAdmin,
    settings: isAdmin,
    vms: isAdmin || limits.allowVmCreate || resources.vms.length > 0,
    vmCreate: isAdmin || limits.allowVmCreate,
    lxc: isAdmin || limits.allowLxcCreate || resources.lxc.length > 0,
    lxcCreate: isAdmin || limits.allowLxcCreate,
    docker: isAdmin || limits.allowDockerCreate || resources.docker.length > 0,
    dockerCreate: isAdmin || limits.allowDockerCreate,
  };

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    email: user.email,
    mustChangePassword: !!user.must_change_password,
    limits,
    sections,
    resources,
    defaultRoute: buildDefaultRoute(sections, resources),
  };
}

function requireUiSection(req: FastifyRequest, section: UiSection) {
  requireAuth(req, {} as FastifyReply);
  const user = db.prepare("SELECT id, username, role, display_name, email, must_change_password FROM users WHERE id = ?").get(req.session.userId) as {
    id: number;
    username: string;
    role: "ADMIN" | "USER";
    display_name: string | null;
    email: string | null;
    must_change_password: number;
  } | undefined;
  if (!user) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  const capabilities = buildAuthCapabilities(user);
  if (!capabilities.sections[section]) {
    throw Object.assign(new Error("You do not have the required rights to access this section"), { statusCode: 403 });
  }
}

async function countResourcesForNode(nodeName: string): Promise<ResourceCounts> {
  const localNodeName = getLocalNodeName();
  const sharedPoolNames = new Set(
    (listDatacenterStoragePoolRows() as Array<{ name: string }>).map((row) => row.name),
  );
  const countLocalOnlyPools = () => {
    const pools = db.prepare("SELECT name, used_bytes, total_bytes FROM storage_pools").all() as Array<{
      name: string;
      used_bytes: number | null;
      total_bytes: number | null;
    }>;
    const localPools = pools.filter((pool) => !sharedPoolNames.has(pool.name));
    return {
      total: localPools.length,
      usedGb: localPools.reduce((sum, pool) => sum + ((pool.used_bytes ?? 0) / (1024 ** 3)), 0),
      totalGb: localPools.reduce((sum, pool) => sum + ((pool.total_bytes ?? 0) / (1024 ** 3)), 0),
    };
  };
  let vmRows = (db.prepare("SELECT vm_name FROM qemu_vms WHERE COALESCE(node_name, ?) = ?").all(localNodeName, nodeName) as Array<{ vm_name: string }>)
    .map((row) => row.vm_name);
  let lxcRows = (db.prepare("SELECT container_name FROM lxc_containers WHERE COALESCE(node_name, ?) = ?").all(localNodeName, nodeName) as Array<{ container_name: string }>)
    .map((row) => row.container_name);
  let dockerRows = (db.prepare("SELECT container_id FROM docker_containers WHERE COALESCE(node_name, ?) = ?").all(localNodeName, nodeName) as Array<{ container_id: string }>)
    .map((row) => row.container_id);

  if (nodeName === localNodeName) {
    const localResources = await listLocalDatacenterResourceEntries();
    vmRows = Array.from(new Set([
      ...vmRows,
      ...localResources.filter((entry) => entry.resourceType === "vm" && entry.nodeName === localNodeName).map((entry) => entry.resourceName),
    ]));
    lxcRows = Array.from(new Set([
      ...lxcRows,
      ...localResources.filter((entry) => entry.resourceType === "lxc" && entry.nodeName === localNodeName).map((entry) => entry.resourceName),
    ]));
    dockerRows = Array.from(new Set([
      ...dockerRows,
      ...localResources.filter((entry) => entry.resourceType === "docker" && entry.nodeName === localNodeName).map((entry) => entry.resourceName),
    ]));
  }

  let runningVms = 0;
  let runningLxc = 0;
  let runningDocker = 0;

  if (nodeName === localNodeName) {
    const localOnlyPools = countLocalOnlyPools();
    try {
      const vms = (callRunner<Array<{ name: string; state?: string }>>("qemu_vms"));
      const lxc = (callRunner<Array<{ name: string; state?: string }>>("lxc_containers"));
      const docker = (callRunner<Array<{ id: string; state?: string }>>("docker_containers"));
      const [liveVms, liveLxc, liveDocker] = await Promise.all([vms, lxc, docker]);
      const vmNames = new Set(vmRows);
      const lxcNames = new Set(lxcRows);
      const dockerIds = new Set(dockerRows);
      return {
        vms: { total: vmRows.length, running: liveVms.filter((entry) => vmNames.has(entry.name) && `${entry.state ?? ""}`.toLowerCase() === "running").length },
        lxc: { total: lxcRows.length, running: liveLxc.filter((entry) => lxcNames.has(entry.name) && `${entry.state ?? ""}`.toLowerCase() === "running").length },
        docker: { total: dockerRows.length, running: liveDocker.filter((entry) => dockerIds.has(entry.id) && `${entry.state ?? ""}`.toLowerCase() === "running").length },
        storagePoolsTotal: localOnlyPools.total,
        storageUsedGb: localOnlyPools.usedGb,
        storageTotalGb: localOnlyPools.totalGb,
      } satisfies ResourceCounts;
    } catch {}
  }

  const localOnlyPools = nodeName === localNodeName ? countLocalOnlyPools() : null;

  return {
    vms: { total: vmRows.length, running: runningVms },
    lxc: { total: lxcRows.length, running: runningLxc },
    docker: { total: dockerRows.length, running: runningDocker },
    storagePoolsTotal: localOnlyPools?.total ?? 0,
    storageUsedGb: localOnlyPools?.usedGb ?? 0,
    storageTotalGb: localOnlyPools?.totalGb ?? 0,
  };
}

async function buildNodeSummary(node: DatacenterNode): Promise<DatacenterNodeSummary> {
  if (!node.isLocal) {
    try {
      const summary = await fetchRemoteNode<DatacenterNodeSummary>(node, "/api/internal/node/summary");
      db.prepare("UPDATE datacenter_nodes SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE name = ?").run(node.name);
      return {
        ...summary,
        node: {
          ...node,
          status: "online",
          lastSeenAt: new Date().toISOString(),
        },
      };
    } catch {
      const resources = await countResourcesForNode(node.name);
      return {
        node: { ...node, status: node.enabled ? "offline" : "unknown" },
        resources,
        totalResources: resources.vms.total + resources.lxc.total + resources.docker.total,
      };
    }
  }

  const resources = await countResourcesForNode(node.name);
  const [systemInfo, systemStats] = await Promise.all([
    callRunner<SystemInfo>("system_info").catch(() => undefined),
    callRunner<SystemStats>("system_stats").catch(() => undefined),
  ]);

  return {
    node,
    virtuaVersion: APP_VERSION,
    systemInfo,
    systemStats,
    resources,
    totalResources: resources.vms.total + resources.lxc.total + resources.docker.total,
  };
}

async function listLocalDatacenterResourceEntries(): Promise<DatacenterResourceEntry[]> {
  const localNodeName = getLocalNodeName();
  const [vmRows, lxcRows, dockerRows, runtimeVms, runtimeLxc, runtimeDocker] = await Promise.all([
    Promise.resolve(db.prepare("SELECT vm_name, COALESCE(node_name, ?) AS node_name FROM qemu_vms WHERE COALESCE(node_name, ?) = ? ORDER BY vm_name").all(localNodeName, localNodeName, localNodeName) as Array<{ vm_name: string; node_name: string }>),
    Promise.resolve(db.prepare("SELECT container_name, COALESCE(node_name, ?) AS node_name FROM lxc_containers WHERE COALESCE(node_name, ?) = ? ORDER BY container_name").all(localNodeName, localNodeName, localNodeName) as Array<{ container_name: string; node_name: string }>),
    Promise.resolve(db.prepare("SELECT container_id, container_name, COALESCE(node_name, ?) AS node_name FROM docker_containers WHERE COALESCE(node_name, ?) = ? ORDER BY container_name").all(localNodeName, localNodeName, localNodeName) as Array<{ container_id: string; container_name: string; node_name: string }>),
    callRunner<Array<{ name: string; state?: string }>>("qemu_vms").catch(() => []),
    callRunner<Array<{ name: string; state?: string }>>("lxc_containers").catch(() => []),
    callRunner<Array<{ id: string; name: string; state?: string }>>("docker_containers").catch(() => []),
  ]);

  const entries = new Map<string, DatacenterResourceEntry>();
  for (const row of vmRows) {
    entries.set(`vm:${row.vm_name}`, { resourceType: "vm", resourceName: row.vm_name, displayName: row.vm_name, nodeName: row.node_name });
  }
  for (const row of lxcRows) {
    entries.set(`lxc:${row.container_name}`, { resourceType: "lxc", resourceName: row.container_name, displayName: row.container_name, nodeName: row.node_name });
  }
  for (const row of dockerRows) {
    entries.set(`docker:${row.container_id}`, { resourceType: "docker", resourceName: row.container_id, displayName: row.container_name, nodeName: row.node_name });
  }
  for (const vm of runtimeVms) {
    entries.set(`vm:${vm.name}`, { resourceType: "vm", resourceName: vm.name, displayName: vm.name, nodeName: localNodeName, state: vm.state });
  }
  for (const ct of runtimeLxc) {
    entries.set(`lxc:${ct.name}`, { resourceType: "lxc", resourceName: ct.name, displayName: ct.name, nodeName: localNodeName, state: ct.state });
  }
  for (const ct of runtimeDocker) {
    entries.set(`docker:${ct.id}`, { resourceType: "docker", resourceName: ct.id, displayName: ct.name, nodeName: localNodeName, state: ct.state });
  }
  return Array.from(entries.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function buildDatacenterSummary(): Promise<DatacenterSummary> {
  const config = getDatacenterConfig();
  const rawNodes = listDatacenterNodes();
  const nodes = await Promise.all(rawNodes.map((node) => buildNodeSummary(node)));
  const sharedPools = listDatacenterStoragePoolRows();
  const sharedPoolNames = new Set(sharedPools.map((pool) => pool.name));
  const localPools = (db.prepare("SELECT name, path, type, content, mount_source, fstype, mount_options, enabled FROM storage_pools WHERE enabled = 1 ORDER BY name").all() as Array<{
    name: string;
    path: string;
    type: string;
    content: string;
    mount_source: string | null;
    fstype: string | null;
    mount_options: string | null;
    enabled: number;
  }>).filter((pool) => !sharedPoolNames.has(pool.name));
  const remoteResources = await Promise.all(rawNodes.filter((node) => !node.isLocal && node.enabled).map(async (node) => {
    try {
      return await fetchRemoteNode<DatacenterResourceEntry[]>(node, "/api/internal/node/resources");
    } catch {
      return [] as DatacenterResourceEntry[];
    }
  }));
  const remoteStorages = await Promise.all(rawNodes.filter((node) => !node.isLocal && node.enabled).map(async (node) => {
    try {
      const pools = await fetchRemoteNode<Array<{ name: string }>>(node, "/api/internal/storage/pools");
      return pools.map((pool) => ({
        kind: "pool" as const,
        name: pool.name,
        displayName: pool.name,
        nodeName: node.name,
        scope: "node" as const,
      })).filter((pool) => !sharedPoolNames.has(pool.name));
    } catch {
      return [] as Array<{ kind: "pool"; name: string; displayName: string; nodeName: string; scope: "node" }>;
    }
  }));
  const resources = [
    ...await listLocalDatacenterResourceEntries(),
    ...remoteResources.flat(),
  ];
  const storages = [
    ...sharedPools.map((pool) => ({
      kind: "pool" as const,
      name: pool.name,
      displayName: pool.name,
      path: pool.path,
      content: JSON.parse(pool.content || "[]") as string[],
      enabled: !!pool.enabled,
      nodeName: null,
      scope: "datacenter" as const,
      type: pool.type,
      fstype: pool.fstype,
      mountSource: pool.mount_source,
      mountOptions: pool.mount_options,
    })),
    ...localPools.map((pool) => ({
      kind: "pool" as const,
      name: pool.name,
      displayName: pool.name,
      path: pool.path,
      content: JSON.parse(pool.content || "[]") as string[],
      enabled: !!pool.enabled,
      nodeName: getLocalNodeName(),
      scope: "node" as const,
      type: pool.type,
      fstype: pool.fstype,
      mountSource: pool.mount_source,
      mountOptions: pool.mount_options,
    })),
    ...remoteStorages.flat(),
  ];
  const nodeLocalStorageCount = new Map<string, number>();
  for (const storage of storages) {
    if (storage.scope !== "node" || !storage.nodeName) continue;
    nodeLocalStorageCount.set(storage.nodeName, (nodeLocalStorageCount.get(storage.nodeName) ?? 0) + 1);
  }
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    resources: {
      ...node.resources,
      storagePoolsTotal: nodeLocalStorageCount.get(node.node.name) ?? 0,
    },
  }));

  return {
    config,
    nodes: normalizedNodes,
    totals: {
      nodes: normalizedNodes.length,
      cpuCores: normalizedNodes.reduce((sum, node) => sum + (node.systemStats?.cpuCount ?? 0), 0),
      memoryBytes: normalizedNodes.reduce((sum, node) => sum + (node.systemStats?.mem.total ?? 0), 0),
      memoryUsedBytes: normalizedNodes.reduce((sum, node) => sum + (node.systemStats?.mem.used ?? 0), 0),
      diskBytes: normalizedNodes.reduce((sum, node) => sum + (node.systemStats?.disk.total ?? 0), 0),
      diskUsedBytes: normalizedNodes.reduce((sum, node) => sum + (node.systemStats?.disk.used ?? 0), 0),
      vms: normalizedNodes.reduce((sum, node) => sum + node.resources.vms.total, 0),
      lxc: normalizedNodes.reduce((sum, node) => sum + node.resources.lxc.total, 0),
      docker: normalizedNodes.reduce((sum, node) => sum + node.resources.docker.total, 0),
      storagePools: normalizedNodes.reduce((sum, node) => sum + node.resources.storagePoolsTotal, 0) + sharedPools.length,
    },
    resources,
    storages,
  };
}

function getClientIp(req: FastifyRequest): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0] ?? req.ip ?? "unknown";
}

function issueWsTicket(kind: ConsoleTicketKind, userId: number, target?: string, initialCommand?: string, proxyNode?: string, context?: Partial<Pick<ConsoleTicket, "deviceId" | "resourceType" | "resourceNode" | "resourceName" | "mode">>) {
  const id = randomUUID();
  const ticket: ConsoleTicket = { id, kind, target, proxyNode, userId, initialCommand, expiresAt: Date.now() + WS_TICKET_TTL_MS, ...context };
  wsTickets.set(id, ticket);
  return ticket;
}

// SPICE opens one WebSocket per protocol channel (main, then display, inputs,
// cursor, ... — spice-html5 reuses the exact same URL for every channel), so a
// SPICE ticket must survive several upgrades: with a single-use ticket only the
// main channel connects and the console shows a black screen. Bounded reuse
// within the TTL; every other ticket kind stays strictly single-use.
const SPICE_TICKET_MAX_USES = 16;

function consumeWsTicket(ticketId: string | null): ConsoleTicket | null {
  if (!ticketId) return null;
  const ticket = wsTickets.get(ticketId);
  if (!ticket) return null;
  if (ticket.expiresAt < Date.now()) {
    wsTickets.delete(ticketId);
    return null;
  }
  if (ticket.kind === "vm-spice" || ticket.kind === "remote-vm-spice") {
    ticket.uses = (ticket.uses ?? 0) + 1;
    if (ticket.uses >= SPICE_TICKET_MAX_USES) wsTickets.delete(ticketId);
    return ticket;
  }
  wsTickets.delete(ticketId);
  return ticket;
}

function buildWsUrl(req: FastifyRequest, pathName: string, ticketId: string, options: { requireReachableHost?: boolean } = {}) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const originUrl = origin ? new URL(origin) : null;
  const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim().toLowerCase();
  const forwardedSsl = (req.headers["x-forwarded-ssl"] as string | undefined)?.toLowerCase();
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const requestProtocol = (req.protocol ?? "").toLowerCase();
  const usesHttps =
    originUrl?.protocol === "https:" ||
    forwardedProto === "https" ||
    forwardedSsl === "on" ||
    requestProtocol === "https" ||
    Boolean(tlsOptions);
  const proto = usesHttps ? "wss" : "ws";
  let host = originUrl?.host ?? forwardedHost ?? req.headers.host ?? "";
  // Never hand a client (esp. the native desktop) a loopback URL it can't reach.
  // Prefer an explicitly-configured public host when the resolved host is empty
  // or points at localhost.
  const publicHost = (process.env.AUXINUX_PUBLIC_HOST ?? "").trim();
  const isLoopbackHost = !host || /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host);
  if (isLoopbackHost) {
    if (options.requireReachableHost && !publicHost) {
      throw new Error("AUXINUX_PUBLIC_HOST is required to build a reachable desktop WebSocket URL");
    }
    host = publicHost || host || "localhost";
  }
  return `${proto}://${host}${pathName}?ticket=${ticketId}`;
}

function buildPublicHost(req: FastifyRequest): string {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const originUrl = origin ? new URL(origin) : null;
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  let host = originUrl?.host ?? forwardedHost ?? req.headers.host ?? "";
  const publicHost = (process.env.AUXINUX_PUBLIC_HOST ?? "").trim();
  const isLoopbackHost = !host || /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host);
  if (isLoopbackHost) host = publicHost || host || "localhost";
  return host;
}

function stripPort(host: string): string {
  if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] || host;
}

function buildRdpFile(args: { host: string; port: number; vmName: string; width?: number; height?: number }) {
  const address = `${stripPort(args.host)}:${args.port}`;
  return [
    `full address:s:${address}`,
    // QEMU's VNC framebuffer is fixed; scale it to the RDP client window.
    "screen mode id:i:1",
    "use multimon:i:0",
    `desktopwidth:i:${args.width ?? 1440}`,
    `desktopheight:i:${args.height ?? 900}`,
    "dynamic resolution:i:0",
    "smart sizing:i:1",
    "session bpp:i:32",
    "compression:i:0",
    "keyboardhook:i:2",
    "audiomode:i:2",
    "redirectclipboard:i:1",
    "redirectprinters:i:0",
    "redirectsmartcards:i:0",
    "authentication level:i:2",
    "enablecredsspsupport:i:1",
    // Prompting up-front makes the client send INFO_AUTOLOGON with the console
    // password, so xrdp (even unpatched) skips its login screen and connects
    // straight to the VM session.
    "prompt for credentials:i:1",
    "username:s:na",
    "",
  ].join("\r\n");
}

function normalizeBlockDeviceRef(raw?: string) {
  if (!raw) throw new Error("Missing block device reference");
  return raw.startsWith("/dev/") ? raw : `/dev/${raw}`;
}

/**
 * Validate a URL to prevent SSRF attacks.
 * Blocks private/loopback networks and non-HTTP(S) protocols.
 */
function validateDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS protocols are allowed for downloads");
  }
  const hostname = parsed.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/,
    /^127\./,
    /^0\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^0\.0\.0\.0$/,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  ];
  if (privatePatterns.some((pattern) => pattern.test(hostname))) {
    throw new Error("Downloads from private or loopback addresses are not allowed");
  }
}

function ensureBuiltinStoragePools() {
  const poolsToEnsure = [
    {
      name: "local",
      path: path.join(DATA_DIR, "pools", "local"),
      content: JSON.stringify(["vm", "iso", "backup", "template", "container", "disk"]),
    },
  ];

  for (const pool of poolsToEnsure) {
    const existing = db.prepare("SELECT id FROM storage_pools WHERE name = ?").get(pool.name);
    if (!existing) {
      fs.mkdirSync(pool.path, { recursive: true });
      db.prepare("INSERT INTO storage_pools (name, path, type, content) VALUES (?, ?, 'directory', ?)").run(pool.name, pool.path, pool.content);
    } else {
      db.prepare("UPDATE storage_pools SET content = ? WHERE name = ?").run(pool.content, pool.name);
    }
  }
}

function persistTask(task: BackgroundTask) {
  db.prepare(`
    INSERT INTO task_history (
      id, owner_user_id, owner_username, kind, action, label, resource_type, resource_name,
      status, progress_percent, bytes_current, bytes_total, message, detail, error, created_at, updated_at, activity_log
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      owner_username = excluded.owner_username,
      kind = excluded.kind,
      action = excluded.action,
      label = excluded.label,
      resource_type = excluded.resource_type,
      resource_name = excluded.resource_name,
      status = excluded.status,
      progress_percent = excluded.progress_percent,
      bytes_current = excluded.bytes_current,
      bytes_total = excluded.bytes_total,
      message = excluded.message,
      detail = excluded.detail,
      activity_log = excluded.activity_log,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    task.id,
    task.ownerUserId,
    task.ownerUsername,
    task.kind,
    task.action,
    task.label,
    task.resourceType ?? null,
    task.resourceName ?? null,
    task.status,
    task.progressPercent,
    task.bytesCurrent ?? null,
    task.bytesTotal ?? null,
    task.message ?? null,
    task.detail ?? null,
    task.error ?? null,
    task.createdAt,
    task.updatedAt,
    JSON.stringify(task.activityLog ?? []),
  );
}

function mapTaskRow(row: {
  id: string;
  owner_user_id: number;
  owner_username: string;
  kind: TaskKind;
  action: string;
  label: string;
  resource_type: string | null;
  resource_name: string | null;
  status: TaskStatus;
  progress_percent: number;
  bytes_current: number | null;
  bytes_total: number | null;
  message: string | null;
  detail: string | null;
  activity_log: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}): BackgroundTask {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    kind: row.kind,
    action: row.action,
    label: row.label,
    resourceType: row.resource_type ?? undefined,
    resourceName: row.resource_name ?? undefined,
    status: row.status,
    progressPercent: row.progress_percent,
    bytesCurrent: row.bytes_current ?? undefined,
    bytesTotal: row.bytes_total ?? undefined,
    message: row.message ?? undefined,
    detail: row.detail ?? undefined,
    activityLog: row.activity_log ? JSON.parse(row.activity_log) as string[] : [],
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTaskRecord(taskId: string) {
  const active = backgroundTasks.get(taskId);
  if (active) return active;
  const row = db.prepare("SELECT * FROM task_history WHERE id = ?").get(taskId) as Parameters<typeof mapTaskRow>[0] | undefined;
  return row ? mapTaskRow(row) : null;
}

function createTask(
  ownerUserId: number,
  ownerUsername: string,
  options: {
    kind: TaskKind;
    action: string;
    label: string;
    resourceType?: string;
    resourceName?: string;
    message?: string;
    detail?: string;
  },
): BackgroundTask {
  const now = new Date().toISOString();
  const task: BackgroundTask = {
    id: randomUUID(),
    ownerUserId,
    ownerUsername,
    kind: options.kind,
    action: options.action,
    label: options.label,
    resourceType: options.resourceType,
    resourceName: options.resourceName,
    status: "pending",
    progressPercent: 0,
    message: options.message,
    detail: options.detail,
    activityLog: options.message || options.detail ? [options.detail ?? options.message ?? "Task created"] : [],
    createdAt: now,
    updatedAt: now,
  };
  backgroundTasks.set(task.id, task);
  persistTask(task);
  return task;
}

function updateTask(taskId: string, patch: Partial<BackgroundTask>) {
  const current = getTaskRecord(taskId);
  if (!current) return;
  const nextLog = [...(current.activityLog ?? [])];
  const nextEntrySource = patch.error ?? patch.detail ?? patch.message;
  if (nextEntrySource) {
    const entry = `${new Date().toLocaleTimeString("en-CA", { hour12: false })} · ${nextEntrySource}`;
    // Dedupe on the message TEXT (ignoring the timestamp prefix) so repeated
    // progress ticks with the same message don't flood the activity log.
    const lastText = nextLog[nextLog.length - 1]?.split(" · ").slice(1).join(" · ");
    if (lastText !== nextEntrySource) {
      nextLog.push(entry);
    }
  }
  const updated: BackgroundTask = {
    ...current,
    ...patch,
    activityLog: nextLog,
    updatedAt: new Date().toISOString(),
  };
  if (updated.status === "completed" || updated.status === "failed") {
    backgroundTasks.delete(taskId);
  } else {
    backgroundTasks.set(taskId, updated);
  }
  persistTask(updated);
}

function sanitizeTask(task: BackgroundTask) {
  const { ownerUserId, result, ...publicTask } = task;
  return publicTask;
}

function loadRecentTasks(userId: number, role: string, limit = 50, since?: string, mine?: boolean) {
  const sinceClause = since ? " AND created_at >= ?" : "";
  const sinceParam = since ? [since] : [];
  if (role === "ADMIN" && !mine) {
    const rows = db.prepare(`SELECT * FROM task_history WHERE 1=1${sinceClause} ORDER BY updated_at DESC LIMIT ?`).all(...sinceParam, limit) as Array<Parameters<typeof mapTaskRow>[0]>;
    return rows.map((row) => sanitizeTask(mapTaskRow(row)));
  }
  const rows = db.prepare(`SELECT * FROM task_history WHERE owner_user_id = ?${sinceClause} ORDER BY updated_at DESC LIMIT ?`).all(userId, ...sinceParam, limit) as Array<Parameters<typeof mapTaskRow>[0]>;
  return rows.map((row) => sanitizeTask(mapTaskRow(row)));
}

function taskAuditDetails(task: BackgroundTask) {
  return task.error ?? task.detail ?? task.message ?? null;
}

function writeTaskAudit(task: BackgroundTask, ip: string) {
  auditLog(db, {
    userId: task.ownerUserId,
    username: task.ownerUsername,
    ip,
    action: task.action,
    resourceType: task.resourceType,
    resourceName: task.resourceName,
    result: task.status === "failed" ? "error" : "success",
    details: taskAuditDetails(task) ?? undefined,
  });
}

/**
 * Runs a quick synchronous task in-place (awaits completion before returning).
 * Records the task in history just like runTrackedTask, but the HTTP handler
 * can still return the result directly to the client.
 */
async function runInstantTask<T>(
  task: BackgroundTask,
  ip: string,
  fn: () => Promise<T>,
): Promise<T> {
  updateTask(task.id, { status: "running", progressPercent: 10 });
  try {
    const result = await fn();
    updateTask(task.id, { status: "completed", progressPercent: 100, message: task.message ?? "Completed", result });
    const completed = getTaskRecord(task.id);
    if (completed) writeTaskAudit(completed, ip);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task failed";
    updateTask(task.id, { status: "failed", error: message, message: task.message ?? "Failed" });
    const failed = getTaskRecord(task.id);
    if (failed) writeTaskAudit(failed, ip);
    throw error;
  }
}

async function runTrackedTask(
  task: BackgroundTask,
  ip: string,
  runner: (helpers: { update: (patch: Partial<BackgroundTask>) => void }) => Promise<unknown>,
) {
  updateTask(task.id, { status: "running", progressPercent: Math.max(task.progressPercent, 5) });
  try {
    const result = await runner({ update: (patch) => updateTask(task.id, patch) });
    const current = getTaskRecord(task.id);
    updateTask(task.id, {
      status: "completed",
      progressPercent: 100,
      message: current?.message ?? "Completed",
      detail: current?.detail,
      result,
    });
    const completed = getTaskRecord(task.id);
    if (completed) writeTaskAudit(completed, ip);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task failed";
    const current = getTaskRecord(task.id);
    updateTask(task.id, {
      status: "failed",
      error: message,
      detail: message,
      message: current?.message ?? "Failed",
    });
    const failed = getTaskRecord(task.id);
    if (failed) writeTaskAudit(failed, ip);
  }
}

// Tasks that have received REAL progress from the runner (pv / qemu-img -p);
// the file-size fallback ticker steps aside for these.
const tasksWithRealProgress = new Set<string>();

/**
 * Returns a callback that streams the runner's REAL progress into the task.
 * The percent is clamped to 1..99 so completion is signalled only when the
 * backup actually finishes.
 */
function onBackupProgress(taskId: string) {
  return (p: RunnerProgress) => {
    tasksWithRealProgress.add(taskId);
    const percent = typeof p.percent === "number"
      ? Math.min(99, Math.max(1, Math.round(p.percent)))
      : undefined;
    // Progress ticks update the bar/bytes only — no activity-log entry, so the
    // log isn't flooded with one line every couple of seconds.
    updateTask(taskId, {
      ...(percent !== undefined ? { progressPercent: percent } : {}),
      ...(p.bytesCurrent !== undefined ? { bytesCurrent: p.bytesCurrent } : {}),
      ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
    });
  };
}

async function trackOutputFileProgress(
  taskId: string,
  outputPath: string,
  _getCurrentPercent: () => number,
) {
  while (true) {
    const task = getTaskRecord(taskId);
    if (!task || task.status !== "running") break;
    // Once real progress is flowing, the runner owns percent + bytes — step aside.
    if (!tasksWithRealProgress.has(taskId)) {
      try {
        const stat = await fs.promises.stat(outputPath);
        // Report real on-disk bytes only (no fictional percent, no log spam).
        if (stat.size > 0) updateTask(taskId, { bytesCurrent: stat.size });
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  tasksWithRealProgress.delete(taskId);
}

setInterval(() => {
  const cutoff = Date.now() - (60 * 60 * 1000);
  for (const [taskId, task] of backgroundTasks.entries()) {
    if ((task.status === "completed" || task.status === "failed") && Date.parse(task.updatedAt) < cutoff) {
      backgroundTasks.delete(taskId);
    }
  }
}, 10 * 60 * 1000).unref();

interface LanguageMeta {
  code: string;
  label: string;
  nativeName: string;
}

async function listLanguageCatalog(): Promise<LanguageMeta[]> {
  const entries = await fs.promises.readdir(LANG_DIR).catch(() => []);
  const languages: LanguageMeta[] = [];

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const code = path.basename(entry, path.extname(entry)).toUpperCase();
    try {
      const raw = await fs.promises.readFile(path.join(LANG_DIR, entry), "utf8");
      const parsed = JSON.parse(raw) as { _meta?: { label?: string; nativeName?: string } };
      languages.push({
        code,
        label: parsed._meta?.label ?? code,
        nativeName: parsed._meta?.nativeName ?? parsed._meta?.label ?? code,
      });
    } catch {
      languages.push({ code, label: code, nativeName: code });
    }
  }

  return languages.sort((a, b) => a.code.localeCompare(b.code));
}

async function loadLanguageBundle(code: string) {
  const normalized = code.toUpperCase();
  const filePath = path.join(LANG_DIR, `${normalized}.json`);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown> & { _meta?: { label?: string; nativeName?: string } };
  const { _meta, ...translations } = parsed;
  return {
    code: normalized,
    label: _meta?.label ?? normalized,
    nativeName: _meta?.nativeName ?? _meta?.label ?? normalized,
    translations,
  };
}

function getManagedStorageDir(type: ManagedFileType) {
  if (type === "iso") return ISOS_DIR;
  if (type === "lxc_template") return LXC_TEMPLATES_DIR;
  if (type === "vm_disk") return VM_DISKS_DIR;
  return DOCKER_ARCHIVES_DIR;
}

function sanitizeManagedFilename(input: string) {
  return path.basename(input).replace(/[^\w.+-]/g, "_");
}

function resolveManagedFileType(raw?: string): ManagedFileType {
  if (raw === "lxc_template" || raw === "docker_image" || raw === "iso" || raw === "vm_disk") return raw;
  return "iso";
}

function isAllowedManagedFile(filename: string, type: ManagedFileType) {
  const lower = filename.toLowerCase();
  if (type === "iso") return lower.endsWith(".iso") || lower.endsWith(".img");
  if (type === "lxc_template") {
    return lower.endsWith(".tar.gz") || lower.endsWith(".tar.xz") || lower.endsWith(".tar.zst") || lower.endsWith(".tar");
  }
  if (type === "vm_disk") {
    return lower.endsWith(".qcow2") || lower.endsWith(".img") || lower.endsWith(".raw") || lower.endsWith(".vmdk") || lower.endsWith(".vhd") || lower.endsWith(".vhdx");
  }
  return lower.endsWith(".tar");
}

let apiLibvirtQemuIdentity: Promise<{ uid: number; gid: number } | null> | null = null;

async function getApiLibvirtQemuIdentity(): Promise<{ uid: number; gid: number } | null> {
  if (!apiLibvirtQemuIdentity) {
    apiLibvirtQemuIdentity = (async () => {
      for (const user of ["libvirt-qemu", "qemu"]) {
        try {
          const [uidOut, gidOut] = await Promise.all([
            execFileAsync("id", ["-u", user]),
            execFileAsync("id", ["-g", user]),
          ]);
          const uid = parseInt(uidOut.stdout.trim(), 10);
          const gid = parseInt(gidOut.stdout.trim(), 10);
          if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
        } catch {
          /* try next common libvirt account */
        }
      }
      return null;
    })();
  }
  return apiLibvirtQemuIdentity;
}

async function ensureLibvirtManagedFileAccess(filePath: string, type: ManagedFileType): Promise<void> {
  if (type !== "iso" && type !== "vm_disk") return;

  const dirPath = path.dirname(filePath);
  await fs.promises.mkdir(dirPath, { recursive: true });

  if (type === "iso") {
    const isoRoot = path.resolve(ISOS_DIR);
    const isoParent = path.dirname(isoRoot);
    const resolvedDir = path.resolve(dirPath);
    if (resolvedDir === isoParent || resolvedDir === isoRoot || resolvedDir.startsWith(`${isoRoot}${path.sep}`)) {
      await fs.promises.chmod(isoParent, 0o755).catch(() => {});
    }
    await fs.promises.chmod(dirPath, 0o755).catch(() => {});
  }

  const identity = await getApiLibvirtQemuIdentity();
  if (identity) {
    await fs.promises.chown(filePath, identity.uid, identity.gid).catch(() => {});
    await fs.promises.chmod(filePath, type === "vm_disk" ? 0o660 : 0o640).catch(() => {});
  } else {
    await fs.promises.chmod(filePath, type === "vm_disk" ? 0o666 : 0o644).catch(() => {});
  }
}

async function listManagedFiles() {
  const dbFiles = db.prepare(`
    SELECT f.*, u.username AS owner_username
    FROM iso_files f
    LEFT JOIN users u ON u.id = f.owner_id
  `).all() as Array<{
    filename: string;
    display_name: string | null;
    type: ManagedFileType;
    owner_id: number | null;
    owner_username: string | null;
    is_public: number;
    storage_pool: string | null;
    created_at: string | null;
  }>;
  const metaMap = new Map(dbFiles.map((entry) => [`${entry.type}:${entry.filename}`, entry]));

  // Build path map from BOTH local and datacenter pools (datacenter pools take precedence)
  const localPoolRows = db.prepare("SELECT name, path, content FROM storage_pools").all() as Array<{ name: string; path: string; content: string }>;
  const datacenterPoolRows = db.prepare("SELECT name, path, content FROM datacenter_storage_pools").all() as Array<{ name: string; path: string; content: string }>;

  // Deduplicate: local wins on path lookup, but datacenter pools that aren't local are also included
  const poolPathMap = new Map<string, string>();
  for (const pool of datacenterPoolRows) poolPathMap.set(pool.name, pool.path);
  for (const pool of localPoolRows) poolPathMap.set(pool.name, pool.path); // local overrides

  // All unique pools to scan for unregistered files (local + datacenter-only)
  const allPoolsByName = new Map<string, { name: string; path: string; content: string }>();
  for (const pool of datacenterPoolRows) allPoolsByName.set(pool.name, pool);
  for (const pool of localPoolRows) allPoolsByName.set(pool.name, pool); // local overrides
  const allPools = [...allPoolsByName.values()];

  const result: Array<{
    filename: string;
    displayName?: string;
    type: ManagedFileType;
    sizeBytes: number;
    ownerId?: number;
    ownerUsername?: string;
    isPublic: boolean;
    storagePool?: string;
    createdAt?: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const entry of dbFiles) {
    const baseDir = entry.storage_pool ? poolPathMap.get(entry.storage_pool) : getManagedStorageDir(entry.type);
    if (!baseDir) continue;
    const fullPath = path.join(baseDir, entry.filename);
    const stat = await fs.promises.stat(fullPath).catch(() => null);
    if (!stat?.isFile()) continue;
    const key = `${entry.type}:${entry.filename}`;
    seen.add(key);
    result.push({
      filename: entry.filename,
      displayName: entry.display_name ?? undefined,
      type: entry.type,
      sizeBytes: stat.size,
      ownerId: entry.owner_id ?? undefined,
      ownerUsername: entry.owner_username ?? undefined,
      isPublic: entry.is_public === 1,
      storagePool: entry.storage_pool ?? undefined,
      createdAt: entry.created_at ?? undefined,
    });
  }

  for (const type of ["iso", "lxc_template", "docker_image", "vm_disk"] as ManagedFileType[]) {
    const dir = getManagedStorageDir(type);
    await fs.promises.mkdir(dir, { recursive: true });
    const files = await fs.promises.readdir(dir).catch(() => []);
    for (const filename of files) {
      if (!isAllowedManagedFile(filename, type)) continue;
      const stat = await fs.promises.stat(path.join(dir, filename)).catch(() => null);
      if (!stat?.isFile()) continue;
      const key = `${type}:${filename}`;
      if (seen.has(key)) continue;
      const meta = metaMap.get(`${type}:${filename}`);
      result.push({
        filename,
        displayName: meta?.display_name ?? undefined,
        type,
        sizeBytes: stat.size,
        ownerId: meta?.owner_id ?? undefined,
        ownerUsername: meta?.owner_username ?? undefined,
        isPublic: meta?.is_public === 1,
        storagePool: meta?.storage_pool ?? undefined,
        createdAt: meta?.created_at ?? undefined,
      });
    }
  }

  const managedTypeToPoolContent: Record<ManagedFileType, string> = {
    iso: "iso",
    lxc_template: "template",
    docker_image: "template",
    vm_disk: "disk",
  };

  for (const pool of allPools) {
    const poolContent = JSON.parse(pool.content || "[]") as string[];
    const files = await fs.promises.readdir(pool.path).catch(() => []);
    for (const filename of files) {
      for (const type of ["iso", "lxc_template", "docker_image", "vm_disk"] as ManagedFileType[]) {
        if (!poolContent.includes(managedTypeToPoolContent[type])) continue;
        if (!isAllowedManagedFile(filename, type)) continue;
        const key = `${type}:${filename}`;
        if (seen.has(key)) continue;
        const fullPath = path.join(pool.path, filename);
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        if (!stat?.isFile()) continue;
        seen.add(key);
        result.push({
          filename,
          type,
          sizeBytes: stat.size,
          isPublic: false,
          storagePool: pool.name,
          createdAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.filename.localeCompare(b.filename);
  });
}

async function resolveManagedFilePath(fileRef: string, fileType: ManagedFileType) {
  const raw = fileRef.trim();
  if (!raw) {
    throw Object.assign(new Error("Managed file is required"), { statusCode: 400 });
  }
  if (/[\n\r\0]/.test(raw)) {
    throw Object.assign(new Error("Invalid managed file path"), { statusCode: 400 });
  }

  const filename = sanitizeManagedFilename(path.basename(raw));
  if (!filename || !isAllowedManagedFile(filename, fileType)) {
    throw Object.assign(new Error(`Unsupported file extension for ${fileType}`), { statusCode: 400 });
  }

  const candidates: string[] = [];
  const addCandidate = (baseDir?: string) => {
    if (!baseDir) return;
    const candidate = path.join(baseDir, filename);
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  const rows = db.prepare("SELECT storage_pool FROM iso_files WHERE filename = ? AND type = ?").all(filename, fileType) as Array<{ storage_pool: string | null }>;
  for (const row of rows) {
    if (row.storage_pool) {
      addCandidate(resolveManagedStoragePool(row.storage_pool)?.path);
    } else {
      addCandidate(getManagedStorageDir(fileType));
    }
  }

  const indexedFiles = await listManagedFiles();
  for (const entry of indexedFiles) {
    if (entry.type !== fileType || entry.filename !== filename) continue;
    addCandidate(entry.storagePool ? resolveManagedStoragePool(entry.storagePool)?.path : getManagedStorageDir(fileType));
  }

  addCandidate(getManagedStorageDir(fileType));

  const requiredContent: Record<ManagedFileType, string> = {
    iso: "iso",
    lxc_template: "template",
    docker_image: "template",
    vm_disk: "disk",
  };
  const poolRows = [
    ...(db.prepare("SELECT path, content FROM datacenter_storage_pools").all() as Array<{ path: string; content: string }>),
    ...(db.prepare("SELECT path, content FROM storage_pools").all() as Array<{ path: string; content: string }>),
  ];
  for (const pool of poolRows) {
    const content = JSON.parse(pool.content || "[]") as string[];
    if (content.includes(requiredContent[fileType])) addCandidate(pool.path);
  }

  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }

  throw Object.assign(new Error(`Managed file not found: ${filename}`), { statusCode: 404 });
}

function resolveManagedIsoPath(isoFile: string) {
  return resolveManagedFilePath(isoFile, "iso");
}

function managedFileAbsolutePath(entry: { filename: string; type: ManagedFileType; storagePool?: string }) {
  const baseDir = entry.storagePool ? resolveManagedStoragePool(entry.storagePool)?.path : getManagedStorageDir(entry.type);
  return baseDir ? path.join(baseDir, entry.filename) : undefined;
}

async function listAttachedVmDiskSources() {
  const attached = new Set<string>();
  const vms = await callRunner<Array<{ name: string }>>("qemu_vms").catch(() => []);
  for (const vm of vms) {
    const info = await callRunner<{ disks?: Array<{ source?: string; readonly?: boolean }> }>("qemu_info", { name: vm.name }).catch(() => null);
    for (const disk of info?.disks ?? []) {
      if (!disk.source || disk.readonly) continue;
      const source = disk.source;
      const resolved = await fs.promises.realpath(source).catch(() => source);
      attached.add(resolved);
    }
  }
  return attached;
}

async function repairVmIsoSourcesBeforeStart(name: string) {
  const info = await callRunner<{ disks?: Array<{ source?: string; readonly?: boolean; deviceType?: string }> }>("qemu_info", { name }).catch(() => null);
  for (const disk of info?.disks ?? []) {
    if (!disk.source || !disk.readonly) continue;
    const stat = await fs.promises.stat(disk.source).catch(() => null);
    if (stat?.isFile()) continue;
    const resolvedPath = await resolveManagedIsoPath(path.basename(disk.source)).catch(() => undefined);
    if (resolvedPath && resolvedPath !== disk.source) {
      await callRunner("qemu_attach_iso", { name, isoPath: resolvedPath });
    }
  }
}

async function runQemuAction(name: string, action: string) {
  if (action === "start") {
    await repairVmIsoSourcesBeforeStart(name);
  }
  return callRunner("qemu_action", { name, action });
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES — server-managed VM/ISO templates (source of truth in Cloud mode)
// ═══════════════════════════════════════════════════════════════════════════

interface TemplateRow {
  id: string;
  type: "iso" | "vm";
  name: string;
  description: string;
  arch: string;
  cpu: number | null;
  memory_mb: number | null;
  disk_gb: number | null;
  disk_file: string | null;
  filename: string;
  size_bytes: number;
  visibility: "public" | "restricted";
  tags: string;
  storage_pool: string | null;
  owner_id: number | null;
  created_at: string;
  updated_at: string;
}

/** Where a template's backing file lives on disk. */
function resolveTemplateFilePath(row: Pick<TemplateRow, "type" | "filename" | "storage_pool">): string {
  if (row.storage_pool) {
    const pool = resolveManagedStoragePool(row.storage_pool);
    if (pool) return path.join(pool.path, row.filename);
  }
  return path.join(row.type === "iso" ? ISOS_DIR : VM_TEMPLATES_DIR, row.filename);
}

/**
 * Reads config.virtua from a .tar.gz WITHOUT extracting it to disk. Used to
 * derive default CPU/RAM/disk for an uploaded VM template. Returns null when the
 * archive carries no config.virtua (the template still works as a raw import).
 */
async function peekTemplateConfigFromArchive(archivePath: string) {
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", archivePath], { maxBuffer: 16 * 1024 * 1024 });
  const member = listing.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith("config.virtua"));
  if (!member) return null;
  const { stdout } = await execFileAsync("tar", ["-xzOf", archivePath, member], { maxBuffer: 4 * 1024 * 1024 });
  return parseVirtuaConfig(stdout);
}

function mapTemplateRow(row: TemplateRow): TemplateSummary {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description ?? "",
    architecture: qemuToArch(row.arch),
    cpu: row.cpu ?? undefined,
    memory: row.memory_mb ?? undefined,
    disk: row.disk_file ?? undefined,
    diskGb: row.disk_gb ?? undefined,
    size: row.size_bytes,
    createdAt: row.created_at,
    visibility: row.visibility,
    tags: (() => { try { return JSON.parse(row.tags) as string[]; } catch { return []; } })(),
    filename: row.filename,
    storagePool: row.storage_pool ?? undefined,
    ownerId: row.owner_id ?? undefined,
  };
}

/** A non-admin may USE a template only if it is public or they own it. */
function canUseTemplate(row: TemplateRow, userId: number, role: string): boolean {
  return role === "ADMIN" || row.visibility === "public" || row.owner_id === userId;
}

function listTemplatesVisibleTo(userId: number, role: string, filters: { type?: string; arch?: string }): TemplateSummary[] {
  const rows = db.prepare("SELECT * FROM templates ORDER BY type ASC, name ASC").all() as TemplateRow[];
  return rows
    .filter((row) => canUseTemplate(row, userId, role))
    .filter((row) => !filters.type || row.type === filters.type)
    .filter((row) => !filters.arch || qemuToArch(row.arch) === filters.arch)
    .map(mapTemplateRow);
}

function getTemplateRow(id: string): TemplateRow | undefined {
  return db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
}

function isAllowedTemplateFile(filename: string, type: "iso" | "vm"): boolean {
  const lower = filename.toLowerCase();
  if (type === "iso") return lower.endsWith(".iso") || lower.endsWith(".img");
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

function templateSidecarPath(archivePath: string): string {
  return archivePath.replace(/\.(tar\.gz|tgz)$/i, ".json");
}

async function ensureTemplateSidecar(row: TemplateRow, archivePath: string): Promise<string> {
  const sidecarPath = templateSidecarPath(archivePath);
  const stat = await fs.promises.stat(sidecarPath).catch(() => null);
  if (stat?.isFile()) return sidecarPath;

  await writeTemplateSidecar(archivePath, {
    Name: row.name,
    Desc: row.description,
    CPU: row.cpu ?? undefined,
    RAM: row.memory_mb ?? undefined,
    DISK: row.disk_file ?? row.disk_gb ?? undefined,
    ARCH: qemuToArch(row.arch),
  });
  return sidecarPath;
}

// ── Routes ────────────────────────────────────────────────────────────────

// GET /api/templates — list visible templates (filters: type, arch)
app.get("/api/templates", async (req, reply) => {
  requireAuth(req, reply);
  const { type, arch } = req.query as { type?: string; arch?: string };
  if (type && type !== "iso" && type !== "vm") return reply.status(400).send({ error: "type must be iso or vm" });
  if (arch && arch !== "amd64" && arch !== "arm64") return reply.status(400).send({ error: "arch must be amd64 or arm64" });
  return listTemplatesVisibleTo(req.session.userId!, req.session.role!, { type, arch });
});

// GET /api/templates/:id — metadata detail
app.get("/api/templates/:id", async (req, reply) => {
  requireAuth(req, reply);
  const row = getTemplateRow((req.params as { id: string }).id);
  if (!row || !canUseTemplate(row, req.session.userId!, req.session.role!)) {
    return reply.status(404).send({ error: "Template not found" });
  }
  return mapTemplateRow(row);
});

// GET /api/templates/:id/download — ADMIN download backing file(s)
app.get("/api/templates/:id/download", async (req, reply) => {
  requireAdmin(req, reply);
  const row = getTemplateRow((req.params as { id: string }).id);
  if (!row) return reply.status(404).send({ error: "Template not found" });

  const filePath = resolveTemplateFilePath(row);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return reply.status(404).send({ error: "Template file not found" });

  const ip = getClientIp(req);
  auditLog(db, {
    userId: req.session.userId!,
    username: req.session.username ?? "",
    ip,
    action: "template.download",
    resourceType: "template",
    resourceName: row.name,
    result: "success",
  });

  if (row.type === "iso") {
    const filename = path.basename(row.filename).replace(/"/g, "");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", String(stat.size));
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(filePath));
  }

  const sidecarPath = await ensureTemplateSidecar(row, filePath);
  const sidecarStat = await fs.promises.stat(sidecarPath).catch(() => null);
  if (!sidecarStat?.isFile()) return reply.status(404).send({ error: "Template sidecar not found" });

  const bundleName = `${path.basename(row.filename).replace(/\.(tar\.gz|tgz)$/i, "")}-bundle.tar.gz`.replace(/"/g, "");
  const tar = spawn("tar", [
    "-czf", "-",
    "-C", path.dirname(filePath), path.basename(filePath),
    "-C", path.dirname(sidecarPath), path.basename(sidecarPath),
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  tar.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  tar.on("close", (code) => {
    if (code !== 0) app.log.error({ code, stderr }, "Template download tar failed");
  });

  reply.header("Content-Type", "application/gzip");
  reply.header("Content-Disposition", `attachment; filename="${bundleName}"`);
  return reply.send(tar.stdout);
});

// POST /api/templates — ADMIN upload/import of a template or ISO
app.post("/api/templates", async (req, reply) => {
  requireAdmin(req, reply);
  const data = await req.file({ limits: { fileSize: TEMPLATE_MAX_BYTES } });
  if (!data) return reply.status(400).send({ error: "No file" });

  const field = (k: string) => (data.fields[k] as { value?: string } | undefined)?.value?.trim() || undefined;
  const type = field("type") === "vm" ? "vm" : field("type") === "iso" ? "iso" : undefined;
  if (!type) { await data.file.resume(); return reply.status(400).send({ error: "type must be iso or vm" }); }

  const filename = sanitizeManagedFilename(data.filename);
  if (!isAllowedTemplateFile(filename, type)) {
    await data.file.resume();
    return reply.status(400).send({ error: type === "iso" ? "ISO templates must be .iso or .img" : "VM templates must be .tar.gz or .tgz" });
  }

  const storagePool = field("storagePool");
  let targetDir = type === "iso" ? ISOS_DIR : VM_TEMPLATES_DIR;
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) { await data.file.resume(); return reply.status(404).send({ error: "Storage pool not found" }); }
    const required = type === "iso" ? "iso" : "template";
    if (!pool.content.includes(required)) { await data.file.resume(); return reply.status(400).send({ error: "Storage pool does not allow this template type" }); }
    targetDir = pool.path;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destPath = path.join(targetDir, filename);
  if (fs.existsSync(destPath)) { await data.file.resume(); return reply.status(409).send({ error: "A file with this name already exists" }); }

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "upload", action: "template.upload", label: `Upload template ${filename}`,
    resourceType: "template", resourceName: filename, message: "Uploading template", detail: filename,
  });

  return runInstantTask(task, ip, async () => {
    const stream = fs.createWriteStream(destPath);
    try {
      await pipeline(data.file, stream);
    } catch (err) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw err;
    }
    if (data.file.truncated) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw Object.assign(new Error("Template exceeds maximum allowed size"), { statusCode: 413 });
    }
    if (type === "iso") await ensureLibvirtManagedFileAccess(destPath, "iso");
    const stat = fs.statSync(destPath);

    // Derive metadata: explicit fields override; otherwise read config.virtua.
    let cfg: Awaited<ReturnType<typeof peekTemplateConfigFromArchive>> = null;
    if (type === "vm") {
      try {
        cfg = await peekTemplateConfigFromArchive(destPath);
      } catch {
        await fs.promises.unlink(destPath).catch(() => {});
        throw Object.assign(new Error("VM template archive is unreadable or corrupt"), { statusCode: 400 });
      }
    }

    const archField = field("arch");
    const arch = (archField === "arm64" || archField === "aarch64") ? "arm64"
      : (archField === "amd64" || archField === "x86_64") ? "amd64"
      : qemuToArch(cfg?.arch);
    const name = field("name") || cfg?.name || filename;
    const description = field("description") ?? cfg?.desc ?? "";
    const visibility = field("visibility") === "public" ? "public" : "restricted";
    const cpu = field("cpu") ? parseInt(field("cpu")!, 10) : cfg?.cpu ?? null;
    const memoryMb = field("memoryMb") ? parseInt(field("memoryMb")!, 10) : cfg?.ram ?? null;
    const diskGb = field("diskGb") ? parseInt(field("diskGb")!, 10) : null;
    let tags: string[] = [];
    try { tags = JSON.parse(field("tags") ?? "[]") as string[]; } catch { tags = []; }

    const id = randomUUID();
    db.prepare(`INSERT INTO templates (id, type, name, description, arch, cpu, memory_mb, disk_gb, disk_file, filename, size_bytes, visibility, tags, storage_pool, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, type, name, description, archToQemu(arch === "arm64" ? "arm64" : "amd64"),
      cpu, memoryMb, diskGb, cfg?.disk ?? null, filename, stat.size, visibility, JSON.stringify(tags),
      storagePool ?? null, req.session.userId!,
    );

    // Write/refresh the NomTemplate.json sidecar next to the archive (vm only).
    if (type === "vm") {
      await writeTemplateSidecar(destPath, { Name: name, Desc: description, CPU: cpu ?? undefined, RAM: memoryMb ?? undefined, DISK: cfg?.disk, ARCH: arch });
    }
    return mapTemplateRow(getTemplateRow(id)!);
  });
});

/** Writes NomTemplate.json next to NomTemplate.tar.gz (best-effort). */
async function writeTemplateSidecar(archivePath: string, meta: Record<string, unknown>) {
  const jsonPath = archivePath.replace(/\.(tar\.gz|tgz)$/i, ".json");
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  await fs.promises.writeFile(jsonPath, JSON.stringify(clean, null, 2)).catch(() => {});
}

// PATCH /api/templates/:id — ADMIN edit metadata/visibility
app.patch("/api/templates/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const row = getTemplateRow((req.params as { id: string }).id);
  if (!row) return reply.status(404).send({ error: "Template not found" });
  const parsed = UpdateTemplateSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const p = parsed.data;
  db.prepare(`UPDATE templates SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      visibility = COALESCE(?, visibility),
      tags = COALESCE(?, tags),
      arch = COALESCE(?, arch),
      cpu = COALESCE(?, cpu),
      memory_mb = COALESCE(?, memory_mb),
      disk_gb = COALESCE(?, disk_gb),
      updated_at = ?
    WHERE id = ?`).run(
    p.name ?? null, p.description ?? null, p.visibility ?? null,
    p.tags ? JSON.stringify(p.tags) : null,
    p.arch ? archToQemu(p.arch) : null,
    p.cpu ?? null, p.memoryMb ?? null, p.diskGb ?? null,
    new Date().toISOString(), row.id,
  );
  const updated = getTemplateRow(row.id)!;
  if (updated.type === "vm") {
    await writeTemplateSidecar(resolveTemplateFilePath(updated), {
      Name: updated.name, Desc: updated.description, CPU: updated.cpu ?? undefined,
      RAM: updated.memory_mb ?? undefined, DISK: updated.disk_file ?? undefined, ARCH: qemuToArch(updated.arch),
    });
  }
  auditLog(db, { userId: req.session.userId!, username: req.session.username ?? "", ip: getClientIp(req), action: "template.update", resourceType: "template", resourceName: updated.name, result: "success" });
  return mapTemplateRow(updated);
});

// DELETE /api/templates/:id — ADMIN delete template + associated files
app.delete("/api/templates/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const row = getTemplateRow((req.params as { id: string }).id);
  if (!row) return reply.status(404).send({ error: "Template not found" });
  const filePath = resolveTemplateFilePath(row);
  await fs.promises.unlink(filePath).catch(() => {});
  if (row.type === "vm") {
    await fs.promises.unlink(filePath.replace(/\.(tar\.gz|tgz)$/i, ".json")).catch(() => {});
  }
  db.prepare("DELETE FROM templates WHERE id = ?").run(row.id);
  auditLog(db, { userId: req.session.userId!, username: req.session.username ?? "", ip: getClientIp(req), action: "template.delete", resourceType: "template", resourceName: row.name, result: "success" });
  return { ok: true };
});

// ── Remote depot catalog (browse + import) ───────────────────────────────────

interface DepotItem {
  id: string;            // depot-relative path (stable identifier)
  type: "iso" | "vm";
  arch: TemplateArch;
  name: string;
  description: string;
  cpu?: number;
  memory?: number;
  diskFile?: string;
  filename: string;
  url: string;
  sizeBytes?: number;
  sizeLabel?: string;
  alreadyImported: boolean;
}

/** "712M" / "1.2G" / "-" → bytes (best-effort, for display). */
function humanSizeToBytes(token: string): number | undefined {
  const m = token.trim().match(/^([\d.]+)\s*([KMGT]?)i?B?$/i);
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const mult: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(value * (mult[m[2].toUpperCase()] ?? 1));
}

/** Parse an nginx-style autoindex page into { name, sizeLabel } entries. */
function parseAutoindex(html: string): Array<{ name: string; sizeLabel?: string }> {
  const out: Array<{ name: string; sizeLabel?: string }> = [];
  const re = /<a href="([^"]+)">[^<]*<\/a>\s*([^\n<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = match[1];
    if (href.startsWith("/") || href.startsWith("..") || href.startsWith("?")) continue;
    const tail = match[2].trim();
    const sizeToken = tail.split(/\s+/).pop();
    out.push({ name: decodeURIComponent(href), sizeLabel: sizeToken && sizeToken !== "-" ? sizeToken : undefined });
  }
  return out;
}

async function fetchDepotText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Depot HTTP ${res.status} for ${url}`);
  return res.text();
}

const ARCH_FOLDERS: Array<{ folder: string; arch: TemplateArch }> = [
  { folder: "AMD64", arch: "amd64" },
  { folder: "ARM", arch: "arm64" },
];

let depotCache: { at: number; items: DepotItem[] } | null = null;
const DEPOT_CACHE_MS = 5 * 60_000;

async function listTemplateDepot(): Promise<DepotItem[]> {
  if (depotCache && Date.now() - depotCache.at < DEPOT_CACHE_MS) return depotCache.items;

  const importedFilenames = new Set(
    (db.prepare("SELECT filename FROM templates").all() as Array<{ filename: string }>).map((r) => r.filename),
  );
  const items: DepotItem[] = [];

  for (const type of ["iso", "vm"] as const) {
    const typeFolder = type === "iso" ? "ISO" : "VM";
    for (const { folder, arch } of ARCH_FOLDERS) {
      const dirUrl = `${getTemplateDepotBase()}${typeFolder}/${folder}/`;
      let entries: Array<{ name: string; sizeLabel?: string }>;
      try {
        entries = parseAutoindex(await fetchDepotText(dirUrl));
      } catch {
        continue; // folder may be empty/missing — skip silently
      }
      for (const entry of entries) {
        if (entry.name.endsWith("/")) continue;
        const lower = entry.name.toLowerCase();
        const relId = `${typeFolder}/${folder}/${entry.name}`;
        const url = `${dirUrl}${encodeURIComponent(entry.name)}`;
        if (type === "iso") {
          if (!lower.endsWith(".iso") && !lower.endsWith(".img")) continue;
          items.push({
            id: relId, type, arch, name: entry.name, description: "",
            filename: entry.name, url,
            sizeBytes: entry.sizeLabel ? humanSizeToBytes(entry.sizeLabel) : undefined,
            sizeLabel: entry.sizeLabel, alreadyImported: importedFilenames.has(entry.name),
          });
        } else {
          if (!lower.endsWith(".tar.gz") && !lower.endsWith(".tgz")) continue;
          // Read the sidecar metadata when present (NomTemplate.json).
          const jsonUrl = url.replace(/\.(tar\.gz|tgz)$/i, ".json");
          let meta: { name?: string; desc?: string; cpu?: number; ram?: number; disk?: string } = {};
          try {
            const parsed = TemplateMetaSchema.partial().parse(JSON.parse(await fetchDepotText(jsonUrl)));
            meta = { name: parsed.Name, desc: parsed.Desc, cpu: parsed.CPU, ram: parsed.RAM, disk: parsed.DISK };
          } catch { /* no/invalid sidecar — use filename */ }
          items.push({
            id: relId, type, arch,
            name: meta.name || entry.name.replace(/\.(tar\.gz|tgz)$/i, ""),
            description: meta.desc ?? "",
            cpu: meta.cpu, memory: meta.ram, diskFile: meta.disk,
            filename: entry.name, url,
            sizeBytes: entry.sizeLabel ? humanSizeToBytes(entry.sizeLabel) : undefined,
            sizeLabel: entry.sizeLabel, alreadyImported: importedFilenames.has(entry.name),
          });
        }
      }
    }
  }

  depotCache = { at: Date.now(), items };
  return items;
}

// GET /api/templates/depot — ADMIN browse the remote depot catalog
app.get("/api/templates/depot", async (req, reply) => {
  requireAdmin(req, reply);
  const { refresh } = req.query as { refresh?: string };
  if (refresh) depotCache = null;
  try {
    return { base: getTemplateDepotBase(), items: await listTemplateDepot() };
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : "Depot unreachable" });
  }
});

// POST /api/templates/depot/import — ADMIN import a depot item (async download)
app.post("/api/templates/depot/import", async (req, reply) => {
  requireAdmin(req, reply);
  const { id, storagePool, visibility } = req.body as { id?: string; storagePool?: string; visibility?: string };
  if (!id) return reply.status(400).send({ error: "id required" });

  const catalog = await listTemplateDepot().catch(() => [] as DepotItem[]);
  const item = catalog.find((entry) => entry.id === id);
  if (!item) return reply.status(404).send({ error: "Depot item not found" });
  if (item.alreadyImported) return reply.status(409).send({ error: "Already imported" });

  let targetDir = item.type === "iso" ? ISOS_DIR : VM_TEMPLATES_DIR;
  let poolName: string | undefined;
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
    if (!pool.content.includes(item.type === "iso" ? "iso" : "template")) {
      return reply.status(400).send({ error: "Storage pool does not allow this template type" });
    }
    targetDir = pool.path;
    poolName = storagePool;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destPath = path.join(targetDir, sanitizeManagedFilename(item.filename));
  if (fs.existsSync(destPath)) return reply.status(409).send({ error: "A file with this name already exists" });

  const ip = getClientIp(req);
  const userId = req.session.userId!;
  const vis = visibility === "public" ? "public" : "restricted";
  const task = createTask(userId, req.session.username ?? "unknown", {
    kind: "url-download", action: "template.depot.import", label: `Import ${item.name} from depot`,
    resourceType: "template", resourceName: item.filename, message: "Downloading from depot", detail: item.filename,
  });

  void runTrackedTask(task, ip, async ({ update }) => {
    const tmpPath = path.join(targetDir, `.depot-${randomUUID()}`);
    try {
      await withUrlDownloadSlot(task.id, () => downloadUrlToFileWithProgress(task.id, item.url, tmpPath));
      await fs.promises.rename(tmpPath, destPath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
    const stat = fs.statSync(destPath);

    let diskFile = item.diskFile ?? null;
    if (item.type === "vm") {
      update({ progressPercent: 97, message: "Reading template metadata" });
      try { diskFile = (await peekTemplateConfigFromArchive(destPath))?.disk ?? diskFile; } catch { /* keep */ }
      await writeTemplateSidecar(destPath, {
        Name: item.name, Desc: item.description, CPU: item.cpu, RAM: item.memory, DISK: diskFile ?? undefined, ARCH: item.arch,
      });
    }

    const tplId = randomUUID();
    db.prepare(`INSERT INTO templates (id, type, name, description, arch, cpu, memory_mb, disk_gb, disk_file, filename, size_bytes, visibility, tags, storage_pool, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`).run(
      tplId, item.type, item.name, item.description, archToQemu(item.arch),
      item.cpu ?? null, item.memory ?? null, null, diskFile, sanitizeManagedFilename(item.filename),
      stat.size, vis, poolName ?? null, userId,
    );
    depotCache = null; // reflect alreadyImported on next browse
    return mapTemplateRow(getTemplateRow(tplId)!);
  });

  return reply.status(202).send(sanitizeTask(getTaskRecord(task.id) ?? task));
});

/**
 * Shared provisioning core for /api/resources (session) and
 * /api/internal/resources (VDM node-token). Validates the template/ISO, builds
 * the right runner call and returns the created background task. `enforce`
 * applies quota + per-user permission checks (skipped for VDM-authorized calls,
 * where the cloud layer already authorized the user). Throws statusCode-tagged
 * errors the caller maps to HTTP responses.
 */
function provisionResourceTask(
  input: import("@auxinux/shared").CreateResourceInput,
  actor: { userId: number; username: string; role: string; ip: string },
  enforce: boolean,
) {
  if (enforce) {
    const quotaCheck = checkQuota(db, actor.userId, actor.role, "vms");
    if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason ?? "Quota exceeded"), { statusCode: 403 });
    const permCheck = checkPermission(db, actor.userId, actor.role, "allow_vm_create");
    if (!permCheck.ok) throw Object.assign(new Error(permCheck.reason ?? "Forbidden"), { statusCode: 403 });
  }

  let template: TemplateRow | undefined;
  if (input.templateId) {
    template = getTemplateRow(input.templateId);
    if (!template) throw Object.assign(new Error("Template not found"), { statusCode: 404 });
    if (enforce && !canUseTemplate(template, actor.userId, actor.role)) throw Object.assign(new Error("Not allowed to use this template"), { statusCode: 403 });
  }
  let isoTemplate: TemplateRow | undefined;
  if (input.isoId) {
    isoTemplate = getTemplateRow(input.isoId);
    if (isoTemplate && isoTemplate.type !== "iso") throw Object.assign(new Error("isoId does not reference an ISO template"), { statusCode: 400 });
    if (enforce && isoTemplate && !canUseTemplate(isoTemplate, actor.userId, actor.role)) throw Object.assign(new Error("Not allowed to use this ISO"), { statusCode: 403 });
  }

  const targetNode = listDatacenterNodes().find((n) => n.name === getLocalNodeName());
  if (!targetNode) throw Object.assign(new Error("Local node unavailable"), { statusCode: 500 });

  const arch: TemplateArch = input.architecture ?? (template ? qemuToArch(template.arch) : isoTemplate ? qemuToArch(isoTemplate.arch) : "amd64");
  const qemuArch = archToQemu(arch);
  const storagePoolName = input.storagePool ?? "local";
  const pool = resolveManagedStoragePool(storagePoolName);
  if (!pool) throw Object.assign(new Error("Storage pool not found"), { statusCode: 404 });

  const task = createTask(actor.userId, actor.username, {
    kind: "create", action: "vm.create", label: `Create VM ${input.name}`,
    resourceType: "vm", resourceName: input.name, message: "Creating virtual machine",
  });
  const userId = actor.userId;

  // Background — never block the event loop; progress is followed via the task.
  void runTrackedTask(task, actor.ip, async ({ update }) => {
    if (template && template.type === "vm") {
      update({ progressPercent: 20, message: "Importing template disk" });
      await callRunner("qemu_create_from_template", {
        archivePath: resolveTemplateFilePath(template),
        storagePool: pool.path,
        name: input.name,
        bridge: input.network ?? "virbr0",
        arch: qemuArch,
        machine: arch === "arm64" ? "virt" : "q35",
        videoModel: input.gpuModel ?? "virtio",
        vcpus: input.cpu ?? template.cpu ?? undefined,
        memoryMb: input.memory ?? template.memory_mb ?? undefined,
        expectedDisk: template.disk_file ?? undefined,
      });
    } else {
      // ISO-boot path (template is an ISO, or a raw isoId, or no template).
      update({ progressPercent: 20, message: "Provisioning VM from ISO" });
      const isoFilename = isoTemplate ? isoTemplate.filename : input.isoId;
      const vmPayload = await prepareVmCreatePayload(CreateVmSchema.parse({
        name: input.name,
        vcpus: input.cpu ?? template?.cpu ?? 2,
        memoryMb: input.memory ?? template?.memory_mb ?? 2048,
        diskGb: input.disk ?? template?.disk_gb ?? 40,
        storagePool: storagePoolName,
        os: "generic",
        isoFile: isoFilename,
        bridge: input.network ?? "virbr0",
        arch: qemuArch,
        machine: arch === "arm64" ? "virt" : "q35",
        bootDevice: isoFilename ? "cdrom" : "hd",
        videoModel: input.gpuModel ?? "vga",
        description: input.description,
        tags: input.tags,
      }));
      await callRunner("qemu_create", vmPayload);
    }
    db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, tags = excluded.tags, node_name = excluded.node_name")
      .run(input.name, userId, input.description ?? null, JSON.stringify(input.tags ?? []), targetNode.name);
    return { name: input.name, node: targetNode.name };
  });

  return sanitizeTask(getTaskRecord(task.id) ?? task);
}

// POST /api/resources — unified VM creation from a template or ISO (async)
app.post("/api/resources", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = CreateResourceSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  try {
    const task = provisionResourceTask(parsed.data, {
      userId: req.session.userId!, username: req.session.username ?? "unknown", role: req.session.role!, ip: getClientIp(req),
    }, true);
    return reply.status(202).send(task);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(code).send({ error: err instanceof Error ? err.message : "Create failed" });
  }
});

// ── Internal template routes (consumed by VDM relay over the node token) ─────
app.get("/api/internal/templates", async (req, reply) => {
  requireInternalNodeToken(req);
  const { type, arch } = req.query as { type?: string; arch?: string };
  // VDM acts on behalf of an authenticated cloud user; expose ALL templates and
  // let VDM apply its own visibility. (Node trust boundary = the node token.)
  const rows = db.prepare("SELECT * FROM templates ORDER BY type ASC, name ASC").all() as TemplateRow[];
  return rows
    .filter((r) => !type || r.type === type)
    .filter((r) => !arch || qemuToArch(r.arch) === arch)
    .map(mapTemplateRow);
});

app.get("/api/internal/templates/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  const row = getTemplateRow((req.params as { id: string }).id);
  if (!row) return reply.status(404).send({ error: "Template not found" });
  return mapTemplateRow(row);
});

// POST /api/internal/resources — VDM-authorized VM creation (node token).
app.post("/api/internal/resources", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = CreateResourceSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  try {
    const actorName = `${(req.headers["x-auxinux-actor"] ?? "vdm")}`;
    const task = provisionResourceTask(parsed.data, { userId: 0, username: actorName, role: "ADMIN", ip: getClientIp(req) }, false);
    return reply.status(202).send(task);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(code).send({ error: err instanceof Error ? err.message : "Create failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LOCKS — a locked VM/LXC/Docker is priority/sensitive and is protected
// SERVER-SIDE against any modification or deletion until it is unlocked.
// ═══════════════════════════════════════════════════════════════════════════

interface ResourceLockRow {
  resource_type: string;
  resource_name: string;
  reason: string | null;
  locked_by: number | null;
  locked_by_username: string | null;
  created_at: string;
}

function getResourceLock(type: string, name: string): ResourceLockRow | undefined {
  if (type === "docker") {
    // Docker ids may be short or long — match the same way ownership does.
    return db.prepare(
      "SELECT * FROM resource_locks WHERE resource_type = 'docker' AND (resource_name = ? OR resource_name LIKE ? OR ? LIKE resource_name || '%') ORDER BY length(resource_name) DESC LIMIT 1",
    ).get(name, `${name}%`, name) as ResourceLockRow | undefined;
  }
  return db.prepare("SELECT * FROM resource_locks WHERE resource_type = ? AND resource_name = ?").get(type, name) as ResourceLockRow | undefined;
}

function isResourceLocked(type: string, name: string): boolean {
  return !!getResourceLock(type, name);
}

function mapLockRow(row: ResourceLockRow) {
  return {
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    reason: row.reason,
    lockedBy: row.locked_by,
    lockedByUsername: row.locked_by_username,
    createdAt: row.created_at,
  };
}

/** Identify which VM/LXC/Docker resource (if any) a request path acts on. */
function lockTargetFromPath(pathname: string): { type: ResourceAclType; id: string; rest: string[] } | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg[0] !== "api") return null;
  let i = seg[1] === "internal" ? 2 : 1;
  const kind = seg[i];
  if (kind === "vms") {
    if (!seg[i + 1]) return null;
    return { type: "vm", id: decodeURIComponent(seg[i + 1]), rest: seg.slice(i + 2) };
  }
  if (kind === "lxc") {
    if (!seg[i + 1] || seg[i + 1] === "templates") return null;
    return { type: "lxc", id: decodeURIComponent(seg[i + 1]), rest: seg.slice(i + 2) };
  }
  if (kind === "docker") {
    if (seg[i + 1] !== "containers" || !seg[i + 2]) return null; // images/networks aren't resources
    return { type: "docker", id: decodeURIComponent(seg[i + 2]), rest: seg.slice(i + 3) };
  }
  return null;
}

const LOCK_BLOCKED_POST = new Set(["config", "rename", "repair-disk", "disk", "network", "networks", "iso"]);

/** Whether a method+sub-path on a LOCKED resource must be refused. */
function lockBlocksMutation(method: string, rest: string[]): boolean {
  const sub = rest[0];
  if (method === "DELETE") return true;                       // delete resource or any sub-object
  if (method === "PUT" || method === "PATCH") return sub !== "notes"; // allow only metadata notes
  if (method === "POST") {
    if (!sub) return false;
    if (LOCK_BLOCKED_POST.has(sub)) return true;
    if (sub === "snapshot" && rest[2] === "rollback") return true; // /snapshot/:snap/rollback
    return false;                                              // action/power, snapshot create, clone, backup, console…
  }
  return false;
}

// Global guard: enforce CSRF token verification on cookie-session-authenticated
// mutating requests. The web UI already fetches /api/auth/csrf and attaches
// X-CSRF-Token on every POST/PUT/PATCH/DELETE (apps/ui/src/api/client.ts), so
// this was previously generated but never actually verified anywhere.
// Desktop/internal-node routes authenticate via bearer/node tokens (no
// session cookie), so they are exempt — csrfProtection requires a session-bound
// secret those clients never receive.
app.addHook("preHandler", async (req, reply) => {
  const method = req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const pathName = (req.url || "").split("?")[0];
  if (pathName === "/api/auth/csrf") return;
  if (pathName.startsWith("/api/desktop/") || pathName.startsWith("/api/internal/")) return;
  await app.csrfProtection(req, reply, () => {});
});

// Global guard: refuse modifying/deleting a locked resource (covers session,
// internal/VDM and any future route hitting /api/(vms|lxc|docker)).
app.addHook("preHandler", async (req, reply) => {
  const method = req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const target = lockTargetFromPath((req.url || "").split("?")[0]);
  if (!target) return;
  if (!lockBlocksMutation(method, target.rest)) return;
  if (!isResourceLocked(target.type, target.id)) return;
  return reply.status(423).send({
    error: "Ressource verrouillée (prioritaire/sensible) : déverrouillez-la pour la modifier ou la supprimer.",
    locked: true,
  });
});

app.get("/api/locks", async (req, reply) => {
  requireAuth(req, reply);
  const rows = db.prepare("SELECT * FROM resource_locks ORDER BY created_at DESC").all() as ResourceLockRow[];
  return rows.map(mapLockRow);
});

app.post("/api/locks/:type/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { type, name } = req.params as { type: string; name: string };
  const aclType = parseResourceAclType(type);
  requireResourcePermission(req, aclType, name, "admin");
  const reason = ((req.body as { reason?: string } | undefined)?.reason ?? "").trim() || null;
  db.prepare(`INSERT INTO resource_locks (resource_type, resource_name, reason, locked_by, locked_by_username)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(resource_type, resource_name) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by, locked_by_username = excluded.locked_by_username`)
    .run(aclType, name, reason, req.session.userId!, req.session.username ?? null);
  auditLog(db, { userId: req.session.userId!, username: req.session.username ?? "", ip: getClientIp(req), action: "resource.lock", resourceType: aclType, resourceName: name, result: "success" });
  return mapLockRow(getResourceLock(aclType, name)!);
});

app.delete("/api/locks/:type/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { type, name } = req.params as { type: string; name: string };
  const aclType = parseResourceAclType(type);
  requireResourcePermission(req, aclType, name, "admin");
  const result = db.prepare("DELETE FROM resource_locks WHERE resource_type = ? AND resource_name = ?").run(aclType, name);
  if (result.changes === 0) return reply.status(404).send({ error: "Resource is not locked" });
  auditLog(db, { userId: req.session.userId!, username: req.session.username ?? "", ip: getClientIp(req), action: "resource.unlock", resourceType: aclType, resourceName: name, result: "success" });
  return { ok: true };
});

type BackupResourceType = "vm" | "lxc";

interface BackupRow {
  id: number;
  resource_type: BackupResourceType;
  resource_name: string;
  filename: string;
  storage_pool: string;
  size_bytes: number;
  format: string;
  created_by: number | null;
  created_at: string;
}

interface BackupApiEntry {
  id: string;
  nodeName: string;
  resourceType: BackupResourceType;
  resourceName: string;
  filename: string;
  storagePool: string;
  sizeBytes: number;
  format: string;
  createdBy: number | null;
  createdAt: string;
}

function isAllowedBackupFile(filename: string, resourceType: BackupResourceType) {
  const lower = filename.toLowerCase();
  if (resourceType === "vm") {
    return lower.endsWith(".qcow2") || lower.endsWith(".img") || lower.endsWith(".raw") || lower.endsWith(".tar.gz") || lower.endsWith(".tar.zst");
  }
  return lower.endsWith(".tar.gz") || lower.endsWith(".tar.zst") || lower.endsWith(".tar");
}

function normalizeBackupFormat(filename: string, resourceType: BackupResourceType, requestedFormat?: string) {
  if (requestedFormat === "qcow2" || requestedFormat === "tar.gz") return requestedFormat;
  const lower = filename.toLowerCase();
  if (resourceType === "vm" && (lower.endsWith(".qcow2") || lower.endsWith(".img") || lower.endsWith(".raw"))) return "qcow2";
  return "tar.gz";
}

function getBackupRow(id: number) {
  return db.prepare("SELECT * FROM backups WHERE id = ?").get(id) as BackupRow | undefined;
}

function encodeBackupRef(nodeName: string, id: number) {
  return `${nodeName}:${id}`;
}

function parseBackupRef(ref: string) {
  const idx = ref.indexOf(":");
  if (idx < 0) {
    return {
      nodeName: getLocalNodeName(),
      backupId: Number.parseInt(ref, 10),
    };
  }
  return {
    nodeName: ref.slice(0, idx),
    backupId: Number.parseInt(ref.slice(idx + 1), 10),
  };
}

function mapBackupRow(row: BackupRow, nodeName: string): BackupApiEntry {
  return {
    id: encodeBackupRef(nodeName, row.id),
    nodeName,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    filename: row.filename,
    storagePool: row.storage_pool,
    sizeBytes: row.size_bytes,
    format: row.format,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function listLocalBackupRows(resourceType?: string, resourceName?: string) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (resourceType) {
    clauses.push("resource_type = ?");
    params.push(resourceType);
  }
  if (resourceName) {
    clauses.push("resource_name = ?");
    params.push(resourceName);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM backups
    ${where}
    ORDER BY created_at DESC
  `).all(...params) as BackupRow[];
}

function resolveBackupPath(row: BackupRow) {
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(row.storage_pool) as { path: string } | undefined;
  if (!pool) throw new Error(`Storage pool ${row.storage_pool} not found`);
  return {
    poolPath: pool.path,
    fullPath: path.join(pool.path, "backups", row.filename),
  };
}

async function createLocalStoragePool(input: {
  name: string;
  path: string;
  type: string;
  content: string[];
  mountSource?: string;
  fstype?: string;
  mountOptions?: string;
  smbUsername?: string;
  smbPassword?: string;
  smbDomain?: string;
  smbVersion?: string;
  nfsVersion?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Provider?: string;
  s3VfsCacheMode?: string;
}) {
  await callRunner("storage_pool_mount", input);
  db.prepare(`
    INSERT INTO storage_pools (name, path, type, content, mount_source, fstype, mount_options)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.path,
    input.type,
    JSON.stringify(input.content),
    input.mountSource ?? null,
    input.fstype ?? null,
    input.mountOptions ?? null,
  );
  return { ok: true };
}

async function deleteLocalStoragePool(name: string) {
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(name) as { path: string } | undefined;
  if (!pool) throw new Error("Pool not found");
  await callRunner("storage_pool_umount", { path: pool.path, name });
  db.prepare("DELETE FROM storage_pools WHERE name = ?").run(name);
  return { ok: true };
}

type FirewallRuleType = "allow" | "forward";
type FirewallProtocol = "tcp" | "udp";
type FirewallRuleSourceKind = "manual" | "auto";

interface FirewallRuleRow {
  id: number;
  enabled: number;
  source_kind: FirewallRuleSourceKind;
  rule_type: FirewallRuleType;
  protocol: FirewallProtocol;
  host_port: number;
  target_ip: string | null;
  target_port: number | null;
  source_cidr: string | null;
  description: string | null;
  linked_resource_type: "vm" | "lxc" | "docker" | "host" | null;
  linked_resource_name: string | null;
  relation: string | null;
  created_at: string;
  updated_at: string;
}

interface EffectiveFirewallRule {
  id: string;
  sourceKind: FirewallRuleSourceKind;
  enabled: boolean;
  type: FirewallRuleType;
  protocol: FirewallProtocol;
  hostPort: number;
  targetIp?: string;
  targetPort?: number;
  sourceCidr?: string;
  description?: string;
  linkedResourceType?: "vm" | "lxc" | "docker" | "host";
  linkedResourceName?: string;
  relation?: string;
  status: "ready";
  createdAt?: string;
  updatedAt?: string;
}

function getBooleanSetting(key: string, fallback = false) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
  if (!row?.value) return fallback;
  return row.value === "1" || row.value.toLowerCase() === "true";
}

function setSetting(key: string, value: string | null) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function mapManualFirewallRule(row: FirewallRuleRow): EffectiveFirewallRule {
  return {
    id: String(row.id),
    sourceKind: row.source_kind,
    enabled: row.enabled === 1,
    type: row.rule_type,
    protocol: row.protocol,
    hostPort: row.host_port,
    targetIp: row.target_ip ?? undefined,
    targetPort: row.target_port ?? undefined,
    sourceCidr: row.source_cidr ?? undefined,
    description: row.description ?? undefined,
    linkedResourceType: row.linked_resource_type ?? undefined,
    linkedResourceName: row.linked_resource_name ?? undefined,
    relation: row.relation ?? undefined,
    status: "ready",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadManualFirewallRules(filters?: { linkedResourceType?: string; linkedResourceName?: string }) {
  let sql = "SELECT * FROM firewall_rules";
  const args: unknown[] = [];
  const clauses: string[] = [];
  if (filters?.linkedResourceType) {
    clauses.push("linked_resource_type = ?");
    args.push(filters.linkedResourceType);
  }
  if (filters?.linkedResourceName) {
    clauses.push("linked_resource_name = ?");
    args.push(filters.linkedResourceName);
  }
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  sql += " ORDER BY source_kind ASC, host_port ASC, id ASC";
  const rows = db.prepare(sql).all(...args) as FirewallRuleRow[];
  return rows.map(mapManualFirewallRule);
}

async function loadAutomaticDockerFirewallRules() {
  const containers = await callRunner<Array<{
    id: string;
    name: string;
    state?: string;
    ports?: Array<{ hostPort: number; containerPort: number; protocol: FirewallProtocol; hostIp?: string }>;
  }>>("docker_containers").catch(() => []);

  const rules: EffectiveFirewallRule[] = [];
  for (const container of containers) {
    if (container.state !== "running") continue;
    for (const port of container.ports ?? []) {
      if (port.hostIp && (port.hostIp === "127.0.0.1" || port.hostIp === "::1")) continue;
      rules.push({
        id: `docker:${container.id}:${port.protocol}:${port.hostPort}:${port.containerPort}`,
        sourceKind: "auto",
        enabled: true,
        type: "allow",
        protocol: port.protocol,
        hostPort: port.hostPort,
        description: `Docker published port ${port.hostPort}/${port.protocol}`,
        linkedResourceType: "docker",
        linkedResourceName: container.name,
        relation: `Docker ${port.hostPort} -> ${port.containerPort}`,
        status: "ready",
      });
    }
  }
  return rules;
}

async function listEffectiveFirewallRules(filters?: { linkedResourceType?: string; linkedResourceName?: string }) {
  const manual = loadManualFirewallRules(filters);
  const autoDocker = await loadAutomaticDockerFirewallRules();
  const filteredAuto = autoDocker.filter((rule) => {
    if (filters?.linkedResourceType && rule.linkedResourceType !== filters.linkedResourceType) return false;
    if (filters?.linkedResourceName && rule.linkedResourceName !== filters.linkedResourceName) return false;
    return true;
  });
  return [...manual, ...filteredAuto];
}

async function syncFirewallState() {
  const enabled = getBooleanSetting("firewall.enabled", false);
  const protectSsh = getBooleanSetting("firewall.protectSsh", true);
  const status = await callRunner<{ sshPort?: number }>("network_firewall_status").catch(() => ({ sshPort: 22 }));
  const effectiveRules = await listEffectiveFirewallRules();
  await callRunner("network_firewall_apply", {
    enabled,
    protectSsh,
    apiPort: PORT,
    sshPort: status.sshPort ?? 22,
    rules: effectiveRules.map((rule) => ({
      enabled: rule.enabled,
      type: rule.type,
      protocol: rule.protocol,
      hostPort: rule.hostPort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      sourceCidr: rule.sourceCidr,
    })),
  });
  setSetting("firewall.lastAppliedAt", new Date().toISOString());
}

async function ensureVmRdpFirewallRule(vmName: string, port: number, userId: number | null) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const relation = "VM RDP Remote";
  const description = `RDP Remote console for VM ${vmName}`;
  const existing = db.prepare(`
    SELECT id FROM firewall_rules
    WHERE linked_resource_type = 'vm'
      AND linked_resource_name = ?
      AND relation = ?
      AND protocol = 'tcp'
    LIMIT 1
  `).get(vmName, relation) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE firewall_rules
      SET enabled = 1,
          source_kind = 'manual',
          rule_type = 'allow',
          host_port = ?,
          target_ip = NULL,
          target_port = NULL,
          source_cidr = NULL,
          description = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(port, description, existing.id);
    return;
  }
  db.prepare(`
    INSERT INTO firewall_rules (
      enabled, source_kind, rule_type, protocol, host_port, target_ip, target_port,
      source_cidr, description, linked_resource_type, linked_resource_name, relation, created_by
    ) VALUES (1, 'manual', 'allow', 'tcp', ?, NULL, NULL, NULL, ?, 'vm', ?, ?, ?)
  `).run(port, description, vmName, relation, userId);
}

async function isManagedVmDiskAttached(realDiskPath: string) {
  const vms = await callRunner<Array<{ name: string }>>("qemu_vms").catch(() => []);
  for (const vm of vms) {
    const info = await callRunner<{ disks?: Array<{ source?: string }> }>("qemu_info", { name: vm.name }).catch(() => null);
    const disks = info?.disks ?? [];
    for (const disk of disks) {
      if (!disk.source) continue;
      const realSource = await fs.promises.realpath(disk.source).catch(() => disk.source);
      if (realSource === realDiskPath) {
        return vm.name;
      }
    }
  }
  return null;
}

interface StoragePoolContentItem {
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt?: string | null;
  linkedResourceType?: string;
  linkedResourceName?: string;
  relation?: string;
  synthetic?: boolean;
  isLinked?: boolean;
  deletable?: boolean;
}

async function getQemuBackingReference(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (![".qcow2", ".img"].includes(ext)) return null;
  try {
    const { stdout } = await execFileAsync("qemu-img", ["info", "--output=json", filePath]);
    const parsed = JSON.parse(stdout) as {
      "backing-filename"?: string;
      "full-backing-filename"?: string;
    };
    const backingPath = parsed["full-backing-filename"]
      ?? (parsed["backing-filename"] ? path.resolve(path.dirname(filePath), parsed["backing-filename"]) : null);
    return backingPath || null;
  } catch {
    return null;
  }
}

function normalizeSnapshotDate(value?: string | null) {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

async function syncSnapshotsForResource(resourceType: "vm" | "lxc", resourceName: string) {
  const existingRows = db.prepare(
    "SELECT snapshot_name, description, created_by, created_at FROM snapshots WHERE resource_type = ? AND resource_name = ?"
  ).all(resourceType, resourceName) as Array<{
    snapshot_name: string;
    description: string | null;
    created_by: number | null;
    created_at: string;
  }>;
  const existingMap = new Map(existingRows.map((row) => [row.snapshot_name, row]));

  const action = resourceType === "vm" ? "qemu_snapshot_list" : "lxc_snapshot_list";
  const runtimeSnapshots = await callRunner<Array<{ name: string; description?: string; createdAt?: string }>>(action, { name: resourceName }).catch(() => []);

  db.prepare("DELETE FROM snapshots WHERE resource_type = ? AND resource_name = ?").run(resourceType, resourceName);
  const insert = db.prepare(`
    INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const snapshot of runtimeSnapshots) {
    const existing = existingMap.get(snapshot.name);
    insert.run(
      resourceType,
      resourceName,
      snapshot.name,
      snapshot.description ?? existing?.description ?? null,
      existing?.created_by ?? null,
      normalizeSnapshotDate(snapshot.createdAt) || normalizeSnapshotDate(existing?.created_at) || new Date().toISOString(),
    );
  }
}

async function reconcileSnapshotMetadata() {
  const [vmRows, lxcRows] = await Promise.all([
    Promise.resolve(db.prepare("SELECT vm_name FROM qemu_vms ORDER BY vm_name").all() as Array<{ vm_name: string }>),
    Promise.resolve(db.prepare("SELECT container_name FROM lxc_containers ORDER BY container_name").all() as Array<{ container_name: string }>),
  ]);

  for (const row of vmRows) {
    await syncSnapshotsForResource("vm", row.vm_name);
  }
  for (const row of lxcRows) {
    await syncSnapshotsForResource("lxc", row.container_name);
  }
}

async function walkFiles(root: string, current = root, results: string[] = []): Promise<string[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, results);
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function listPoolContent(poolName: string, poolPath: string): Promise<StoragePoolContentItem[]> {
  const items: StoragePoolContentItem[] = [];
  const seen = new Set<string>();

  // Retrieve the pool's declared content types (e.g. ["vm","iso","container"])
  const poolRow = db.prepare("SELECT type, content FROM storage_pools WHERE name = ?").get(poolName) as { type: string; content: string } | undefined;
  const poolType = poolRow?.type ?? "directory";
  const poolContentTypes: string[] = poolRow ? (() => { try { return JSON.parse(poolRow.content) as string[]; } catch { return []; } })() : [];

  const backups = db.prepare("SELECT * FROM backups WHERE storage_pool = ? ORDER BY created_at DESC").all(poolName) as Array<{
    id: number;
    resource_type: string;
    resource_name: string;
    filename: string;
    storage_pool: string;
    size_bytes: number;
    format: string;
    created_at: string;
  }>;
  const backupMap = new Map(backups.map((entry) => [path.join(poolPath, "backups", entry.filename), entry]));

  const snapshots = db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC").all() as Array<{
    resource_type: string;
    resource_name: string;
    snapshot_name: string;
    description: string | null;
    created_at: string;
  }>;

  const vmDiskMap = new Map<string, { vmName: string; relation: string }>();
  const vmList = await callRunner<Array<{ name: string }>>("qemu_vms").catch(() => []);
  for (const vm of vmList) {
    const info = await callRunner<{ disks?: Array<{ source?: string; readonly?: boolean; deviceType?: string }> }>("qemu_info", { name: vm.name }).catch(() => null);
    for (const disk of info?.disks ?? []) {
      if (!disk.source) continue;
      const normalized = await fs.promises.realpath(disk.source).catch(() => disk.source!);
      vmDiskMap.set(normalized, {
        vmName: vm.name,
        relation: disk.readonly || disk.deviceType === "cdrom" ? "attached ISO/CD-ROM" : "attached disk",
      });
    }
  }

  const files = await walkFiles(poolPath);
  const backingReferenceMap = new Map<string, string[]>();
  for (const filePath of files) {
    const backingPath = await getQemuBackingReference(filePath);
    if (!backingPath) continue;
    const normalizedFilePath = await fs.promises.realpath(filePath).catch(() => filePath);
    const normalizedBacking = await fs.promises.realpath(backingPath).catch(() => backingPath);
    const dependents = backingReferenceMap.get(normalizedBacking) ?? [];
    dependents.push(normalizedFilePath);
    backingReferenceMap.set(normalizedBacking, dependents);
  }
  for (const filePath of files) {
    const realPath = await fs.promises.realpath(filePath).catch(() => filePath);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;

    const backup = backupMap.get(filePath);
    const vmAttachment = vmDiskMap.get(realPath);
    const ext = path.extname(filePath).toLowerCase();
    const relativePath = path.relative(poolPath, filePath);
    const backingDependents = backingReferenceMap.get(realPath) ?? [];
    let type = "file";
    let linkedResourceType: string | undefined;
    let linkedResourceName: string | undefined;
    let relation: string | undefined;

    if (backup) {
      type = "backup";
      linkedResourceType = backup.resource_type;
      linkedResourceName = backup.resource_name;
      relation = `${backup.resource_type.toUpperCase()} backup`;
    } else if (vmAttachment) {
      type = ext === ".iso" || ext === ".img" ? "iso" : "vm_disk";
      linkedResourceType = "vm";
      linkedResourceName = vmAttachment.vmName;
      relation = vmAttachment.relation;
    } else if (relativePath.startsWith(`backups${path.sep}`)) {
      type = "backup";
    } else if ([".qcow2", ".img", ".raw", ".vmdk", ".vhd", ".vhdx"].includes(ext)) {
      type = "disk";
    } else if (ext === ".iso") {
      type = "iso";
    } else if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tar.xz") || filePath.endsWith(".tar.zst") || ext === ".tar") {
      type = "archive";
    }

    if (!linkedResourceType && backingDependents.length > 0) {
      const dependentAttachment = backingDependents
        .map((dependent) => vmDiskMap.get(dependent))
        .find(Boolean);
      if (dependentAttachment) {
        linkedResourceType = "vm";
        linkedResourceName = dependentAttachment.vmName;
        relation = `backing file for ${dependentAttachment.relation}`;
      } else {
        relation = `backing file for ${backingDependents.length} disk${backingDependents.length === 1 ? "" : "s"}`;
      }
    }

    const key = `file:${realPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      name: path.basename(filePath),
      type,
      size: stat.size,
      path: filePath,
      createdAt: stat.mtime.toISOString(),
      linkedResourceType,
      linkedResourceName,
      relation,
      isLinked: Boolean((linkedResourceType && linkedResourceName) || backingDependents.length > 0),
    });
  }

  for (const snapshot of snapshots) {
    const syntheticPath = `snapshot://${snapshot.resource_type}/${snapshot.resource_name}/${snapshot.snapshot_name}`;
    if (seen.has(syntheticPath)) continue;
    seen.add(syntheticPath);
    items.push({
      name: snapshot.snapshot_name,
      type: "snapshot",
      size: 0,
      path: syntheticPath,
      createdAt: snapshot.created_at,
      linkedResourceType: snapshot.resource_type,
      linkedResourceName: snapshot.resource_name,
      relation: snapshot.description || `${snapshot.resource_type.toUpperCase()} snapshot`,
      synthetic: true,
      isLinked: true,
    });
  }

  // Inject Docker images, containers and volumes as synthetic entries when the
  // pool declares "container" content type. Docker data lives under
  // /var/lib/docker (not the pool dir), so it would otherwise be invisible.
  if (poolContentTypes.includes("container")) {
    interface DockerImageEntry {
      id: string;
      repoTags: string[];
      size: number;
      created: number;
    }
    interface DockerContainerEntry {
      id: string;
      name: string;
      image: string;
      state?: string;
      status?: string;
      createdAt?: string;
    }
    interface DockerVolumeEntry {
      name: string;
      driver: string;
      mountpoint: string;
    }
    const dockerImages = await callRunner<DockerImageEntry[]>("docker_images").catch(() => []);
    const dockerContainers = await callRunner<DockerContainerEntry[]>("docker_containers").catch(() => []);
    const dockerVolumes = await callRunner<DockerVolumeEntry[]>("docker_volumes").catch(() => []);
    for (const img of dockerImages) {
      const tag = img.repoTags?.[0] ?? img.id;
      const syntheticPath = `docker-image://${img.id}`;
      if (seen.has(syntheticPath)) continue;
      seen.add(syntheticPath);
      const users = dockerContainers.filter((container) => {
        const image = container.image ?? "";
        if (!image) return false;
        return image === img.id
          || img.id.includes(image.replace(/^sha256:/, ""))
          || image.includes(img.id.replace(/^sha256:/, ""))
          || (img.repoTags ?? []).includes(image);
      });
      const usedBy = users[0];
      items.push({
        name: tag,
        type: "container",
        size: img.size ?? 0,
        path: syntheticPath,
        createdAt: img.created ? new Date(img.created).toISOString() : undefined,
        linkedResourceType: usedBy ? "docker" : undefined,
        linkedResourceName: usedBy ? (usedBy.name || usedBy.id) : undefined,
        relation: usedBy ? `Used by Docker container ${usedBy.name || usedBy.id.slice(0, 12)}` : "Docker image cache",
        synthetic: true,
        isLinked: Boolean(usedBy),
        deletable: !usedBy,
      });
    }

    // Docker containers (running or stopped) as synthetic entries.
    for (const container of dockerContainers) {
      const syntheticPath = `docker-container://${container.id}`;
      if (seen.has(syntheticPath)) continue;
      seen.add(syntheticPath);
      items.push({
        name: container.name || container.id.slice(0, 12),
        type: "container",
        size: 0,
        path: syntheticPath,
        createdAt: container.createdAt,
        linkedResourceType: "docker",
        linkedResourceName: container.name || container.id,
        relation: container.state ? `Docker container (${container.state})` : "Docker container",
        synthetic: true,
        isLinked: true,
      });
    }

    // Docker volumes as synthetic entries. Size is read with a bounded `du`
    // (5s) so a huge volume can never stall the pool listing the way the old
    // recursive LXC rootfs walk did.
    for (const vol of dockerVolumes) {
      const syntheticPath = `docker-volume://${vol.name}`;
      if (seen.has(syntheticPath)) continue;
      seen.add(syntheticPath);
      let size = 0;
      if (vol.mountpoint) {
        try {
          const { stdout } = await execFileAsync("du", ["-sb", vol.mountpoint], { timeout: 5000 });
          size = parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10) || 0;
        } catch {
          size = 0;
        }
      }
      items.push({
        name: vol.name,
        type: "container",
        size,
        path: syntheticPath,
        linkedResourceType: "docker",
        linkedResourceName: vol.name,
        relation: `Docker volume (${vol.driver})`,
        synthetic: true,
        isLinked: true,
      });
    }
  }

  // Inject LXC containers as synthetic entries (rootfs lives in /var/lib/lxc,
  // not in the pool dir, so they would otherwise be invisible). Only the LOCAL
  // directory pool gets these — never S3/NFS pools, to avoid mixing storage.
  const isLocalDirectoryPool = poolType === "directory" || poolName === "local";
  if (isLocalDirectoryPool && (poolContentTypes.includes("container") || poolContentTypes.includes("vm"))) {
    const lxcList = await callRunner<Array<{ name: string; state?: string; rootfsSizeGb?: number; diskGb?: number }>>("lxc_containers").catch(() => []);
    for (const ct of lxcList) {
      const syntheticPath = `lxc://${ct.name}`;
      if (seen.has(syntheticPath)) continue;
      seen.add(syntheticPath);
      // The runner already reports the rootfs size (rootfsSizeGb/diskGb); use it
      // instead of recursively walking the rootfs, which took tens of seconds on
      // large containers and made the pool listing time out (81s observed).
      const sizeGb = ct.rootfsSizeGb ?? ct.diskGb ?? 0;
      const size = sizeGb > 0 ? Math.round(sizeGb * 1024 * 1024 * 1024) : 0;
      items.push({
        name: ct.name,
        type: "container",
        size,
        path: syntheticPath,
        linkedResourceType: "lxc",
        linkedResourceName: ct.name,
        relation: ct.state ? `LXC container (${ct.state})` : "LXC container",
        synthetic: true,
        isLinked: true,
      });
    }
  }

  // Inject VMs as synthetic entries (their disks may live outside the pool dir).
  // Only the LOCAL directory pool gets these — never S3/NFS pools, and only if
  // at least one disk physically resolves inside this pool's path, so storage
  // views never mix disks that live elsewhere.
  if (isLocalDirectoryPool && (poolContentTypes.includes("vm") || poolContentTypes.includes("disk"))) {
    const vmList = await callRunner<Array<{ name: string; state?: string }>>("qemu_vms").catch(() => []);
    for (const vm of vmList) {
      const syntheticPath = `vm://${vm.name}`;
      if (seen.has(syntheticPath)) continue;
      seen.add(syntheticPath);
      let size = 0;
      let inThisPool = false;
      const info = await callRunner<{ disks?: Array<{ source?: string }> }>("qemu_info", { name: vm.name }).catch(() => null);
      for (const disk of info?.disks ?? []) {
        if (!disk.source) continue;
        const resolved = await fs.promises.realpath(disk.source).catch(() => disk.source);
        if (resolved && (resolved === poolPath || resolved.startsWith(`${poolPath}${path.sep}`))) {
          inThisPool = true;
          size += await fs.promises.stat(disk.source).then((s) => s.size).catch(() => 0);
        }
      }
      // Only show the VM in this pool if it actually has a disk here.
      if (!inThisPool) continue;
      items.push({
        name: vm.name,
        type: "vm_disk",
        size,
        path: syntheticPath,
        linkedResourceType: "vm",
        linkedResourceName: vm.name,
        relation: vm.state ? `VM (${vm.state})` : "VM",
        synthetic: true,
        isLinked: true,
      });
    }
  }

  return items.sort((a, b) => {
    const createdA = a.createdAt ? Date.parse(a.createdAt) : 0;
    const createdB = b.createdAt ? Date.parse(b.createdAt) : 0;
    return createdB - createdA || a.name.localeCompare(b.name);
  });
}

async function resolvePoolContentItem(poolName: string, requestedPath: string) {
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(poolName) as { path: string } | undefined;
  if (!pool) {
    throw Object.assign(new Error("Pool not found"), { statusCode: 404 });
  }
  const content = await listPoolContent(poolName, pool.path);
  const item = content.find((entry) => entry.path === requestedPath);
  if (!item) {
    throw Object.assign(new Error("Pool content item not found"), { statusCode: 404 });
  }
  if (!item.synthetic) {
    const realPoolPath = await fs.promises.realpath(pool.path).catch(() => pool.path);
    const realItemPath = await fs.promises.realpath(item.path).catch(() => item.path);
    const relative = path.relative(realPoolPath, realItemPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Invalid pool item path"), { statusCode: 400 });
    }
  }
  return { pool, item };
}

async function deletePoolContentItem(poolName: string, item: StoragePoolContentItem) {
  if (item.synthetic) {
    if (item.path.startsWith("docker-image://") && !item.isLinked) {
      const imageId = item.path.slice("docker-image://".length);
      if (!imageId) {
        throw Object.assign(new Error("Docker image id is missing"), { statusCode: 400 });
      }
      await callRunner("docker_image_delete", { id: imageId });
      return { ok: true };
    }
    throw Object.assign(new Error("Snapshots and linked synthetic entries must be deleted from their resource screen"), { statusCode: 400 });
  }

  if (item.isLinked) {
    throw Object.assign(new Error("This file is linked to a resource and cannot be deleted from pool content"), { statusCode: 400 });
  }

  await fs.promises.unlink(item.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    throw error;
  });

  db.prepare("DELETE FROM iso_files WHERE filename = ?").run(item.name);
  db.prepare("DELETE FROM backups WHERE filename = ? AND storage_pool = ?").run(item.name, poolName);
  return { ok: true };
}

async function saveManagedDownload(url: string, fileType: ManagedFileType, displayName?: string, storagePool?: string) {
  validateDownloadUrl(url);
  const parsedUrl = new URL(url);
  const fallbackName = sanitizeManagedFilename(path.basename(parsedUrl.pathname) || `${fileType}-download`);
  const requestedName = displayName ? sanitizeManagedFilename(displayName) : fallbackName;
  const extensionSource = path.extname(fallbackName) ? fallbackName : path.basename(parsedUrl.pathname);
  let filename = requestedName;
  if (!isAllowedManagedFile(filename, fileType)) {
    if (fileType === "iso" && (extensionSource.toLowerCase().endsWith(".iso") || extensionSource.toLowerCase().endsWith(".img"))) {
      filename = `${requestedName}${path.extname(extensionSource)}`;
    } else if (fileType === "vm_disk") {
      if (extensionSource.toLowerCase().endsWith(".qcow2")) filename = `${requestedName}.qcow2`;
      else if (extensionSource.toLowerCase().endsWith(".img")) filename = `${requestedName}.img`;
      else if (extensionSource.toLowerCase().endsWith(".raw")) filename = `${requestedName}.raw`;
      else if (extensionSource.toLowerCase().endsWith(".vmdk")) filename = `${requestedName}.vmdk`;
      else if (extensionSource.toLowerCase().endsWith(".vhd")) filename = `${requestedName}.vhd`;
      else if (extensionSource.toLowerCase().endsWith(".vhdx")) filename = `${requestedName}.vhdx`;
    } else if (fileType === "docker_image" && extensionSource.toLowerCase().endsWith(".tar")) {
      filename = `${requestedName}.tar`;
    } else if (fileType === "lxc_template") {
      if (extensionSource.toLowerCase().endsWith(".tar.gz")) filename = `${requestedName}.tar.gz`;
      else if (extensionSource.toLowerCase().endsWith(".tar.xz")) filename = `${requestedName}.tar.xz`;
      else if (extensionSource.toLowerCase().endsWith(".tar.zst")) filename = `${requestedName}.tar.zst`;
      else if (extensionSource.toLowerCase().endsWith(".tar")) filename = `${requestedName}.tar`;
    }
  }

  if (!isAllowedManagedFile(filename, fileType)) {
    throw new Error(`Unsupported file extension for ${fileType}`);
  }

  let targetDir = getManagedStorageDir(fileType);
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) throw new Error("Storage pool not found");
    targetDir = pool.path;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destination = path.join(targetDir, filename);
  const temporary = `${destination}.part`;

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream),
      fs.createWriteStream(temporary),
    );
    await fs.promises.rename(temporary, destination);
    await ensureLibvirtManagedFileAccess(destination, fileType);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }

  const stat = await fs.promises.stat(destination);
  return { filename, sizeBytes: stat.size };
}

let activeUrlDownloads = 0;
const pendingUrlDownloads: Array<() => void> = [];

async function withUrlDownloadSlot<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  if (activeUrlDownloads >= MAX_URL_DOWNLOADS) {
    updateTask(taskId, {
      status: "running",
      progressPercent: 0,
      message: "Waiting for download slot",
      detail: `${activeUrlDownloads}/${MAX_URL_DOWNLOADS} downloads active`,
    });
    await new Promise<void>((resolve) => pendingUrlDownloads.push(resolve));
  }

  activeUrlDownloads += 1;
  try {
    return await fn();
  } finally {
    activeUrlDownloads = Math.max(0, activeUrlDownloads - 1);
    pendingUrlDownloads.shift()?.();
  }
}

async function getRemoteContentLength(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    const size = parseInt(response.headers.get("content-length") ?? "0", 10);
    return Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

async function downloadUrlToFileWithProgress(taskId: string, url: string, temporary: string) {
  await fs.promises.unlink(temporary).catch(() => {});
  const totalBytes = await getRemoteContentLength(url);
  updateTask(taskId, {
    status: "running",
    progressPercent: 0,
    bytesCurrent: 0,
    bytesTotal: totalBytes,
    message: "Downloading file",
  });

  let lastSize = 0;
  const progressTimer = setInterval(async () => {
    try {
      const stat = await fs.promises.stat(temporary);
      lastSize = stat.size;
      const percent = totalBytes ? Math.min(99, Math.round((stat.size / totalBytes) * 100)) : undefined;
      updateTask(taskId, {
        status: "running",
        bytesCurrent: stat.size,
        bytesTotal: totalBytes,
        progressPercent: percent,
        message: "Downloading file",
        detail: `${stat.size}${totalBytes ? ` / ${totalBytes}` : ""} bytes`,
      });
    } catch {}
  }, 1000);
  progressTimer.unref();

  const args = [
    "--location",
    "--fail",
    "--show-error",
    "--silent",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--speed-time",
    "30",
    "--speed-limit",
    "1024",
    "--connect-timeout",
    "20",
    "--output",
    temporary,
    url,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `curl exited with code ${code ?? "unknown"}`));
    });
  }).finally(() => clearInterval(progressTimer));

  const stat = await fs.promises.stat(temporary);
  updateTask(taskId, {
    status: "running",
    bytesCurrent: stat.size || lastSize,
    bytesTotal: stat.size || undefined,
    progressPercent: 95,
    message: "Download finished, finalizing file",
  });
}

async function saveManagedDownloadWithProgress(taskId: string, url: string, fileType: ManagedFileType, displayName?: string, storagePool?: string) {
  validateDownloadUrl(url);
  const parsedUrl = new URL(url);
  const fallbackName = sanitizeManagedFilename(path.basename(parsedUrl.pathname) || `${fileType}-download`);
  const requestedName = displayName ? sanitizeManagedFilename(displayName) : fallbackName;
  const extensionSource = path.extname(fallbackName) ? fallbackName : path.basename(parsedUrl.pathname);
  let filename = requestedName;
  if (!isAllowedManagedFile(filename, fileType)) {
    if (fileType === "iso" && (extensionSource.toLowerCase().endsWith(".iso") || extensionSource.toLowerCase().endsWith(".img"))) {
      filename = `${requestedName}${path.extname(extensionSource)}`;
    } else if (fileType === "vm_disk") {
      if (extensionSource.toLowerCase().endsWith(".qcow2")) filename = `${requestedName}.qcow2`;
      else if (extensionSource.toLowerCase().endsWith(".img")) filename = `${requestedName}.img`;
      else if (extensionSource.toLowerCase().endsWith(".raw")) filename = `${requestedName}.raw`;
      else if (extensionSource.toLowerCase().endsWith(".vmdk")) filename = `${requestedName}.vmdk`;
      else if (extensionSource.toLowerCase().endsWith(".vhd")) filename = `${requestedName}.vhd`;
      else if (extensionSource.toLowerCase().endsWith(".vhdx")) filename = `${requestedName}.vhdx`;
    } else if (fileType === "docker_image" && extensionSource.toLowerCase().endsWith(".tar")) {
      filename = `${requestedName}.tar`;
    } else if (fileType === "lxc_template") {
      if (extensionSource.toLowerCase().endsWith(".tar.gz")) filename = `${requestedName}.tar.gz`;
      else if (extensionSource.toLowerCase().endsWith(".tar.xz")) filename = `${requestedName}.tar.xz`;
      else if (extensionSource.toLowerCase().endsWith(".tar.zst")) filename = `${requestedName}.tar.zst`;
      else if (extensionSource.toLowerCase().endsWith(".tar")) filename = `${requestedName}.tar`;
    }
  }

  if (!isAllowedManagedFile(filename, fileType)) throw new Error(`Unsupported file extension for ${fileType}`);

  let targetDir = getManagedStorageDir(fileType);
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) throw new Error("Storage pool not found");
    targetDir = pool.path;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destination = path.join(targetDir, filename);
  const temporary = `${destination}.part`;

  try {
    await withUrlDownloadSlot(taskId, () => downloadUrlToFileWithProgress(taskId, url, temporary));
    await fs.promises.rename(temporary, destination);
    await ensureLibvirtManagedFileAccess(destination, fileType);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }

  const stat = await fs.promises.stat(destination);
  return { filename, sizeBytes: stat.size };
}

async function runDockerPullTask(taskId: string, image: string) {
  updateTask(taskId, {
    status: "running",
    progressPercent: 10,
    message: "Pulling Docker image",
    detail: image,
  });
  await callRunner("docker_pull", { image }, 15 * 60_000);
  updateTask(taskId, {
    status: "running",
    progressPercent: 95,
    message: "Pulling Docker image",
    detail: image,
  });
}

async function runLxcTemplateCacheTask(taskId: string, template: { dist: string; release: string; arch: string; variant?: string }) {
  updateTask(taskId, {
    status: "running",
    progressPercent: 10,
    message: "Caching LXC template",
    detail: `${template.dist}:${template.release}:${template.arch}:${template.variant ?? "default"}`,
  });
  await callRunner("lxc_cache_template", template, 15 * 60_000);
  updateTask(taskId, {
    status: "running",
    progressPercent: 95,
    message: "Caching LXC template",
    detail: `${template.dist}:${template.release}:${template.arch}:${template.variant ?? "default"}`,
  });
}

// ── ACME HTTP-01 Challenge Tokens ─────────────────────────────────────────
// Must be defined BEFORE authentication middlewares so Let's Encrypt can reach it
app.get("/.well-known/acme-challenge/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  // Only allow URL-safe base64 characters used in ACME tokens
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) {
    return reply.status(400).send("Invalid token");
  }
  const keyAuthorization = challengeTokens.get(token);
  if (!keyAuthorization) return reply.status(404).send("Not found");
  return reply.header("Content-Type", "text/plain").send(keyAuthorization);
});

// ── AUTH Routes ────────────────────────────────────────────────────────────
app.get("/api/i18n/languages", async (_req, reply) => {
  return reply.send(await listLanguageCatalog());
});

app.get("/api/i18n/:code", async (req, reply) => {
  const { code } = req.params as { code: string };
  // Validate code to only allow alphanumeric + underscore/hyphen (prevent path traversal)
  if (!/^[a-zA-Z0-9_-]{1,10}$/.test(code)) {
    return reply.status(400).send({ error: "Invalid language code" });
  }
  try {
    return reply.send(await loadLanguageBundle(code));
  } catch {
    return reply.status(404).send({ error: "Language not found" });
  }
});

app.get("/api/tasks/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const task = getTaskRecord(id);
  if (!task) return reply.status(404).send({ error: "Task not found" });
  if (req.session.role !== "ADMIN" && task.ownerUserId !== req.session.userId) {
    return reply.status(403).send({ error: "Forbidden" });
  }
  return sanitizeTask(task);
});

// Internal task status (VDM polls this after proxying a node-side task).
app.get("/api/internal/tasks/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const task = getTaskRecord(id);
  if (!task) return reply.status(404).send({ error: "Task not found" });
  return sanitizeTask(task);
});

app.get("/api/tasks", async (req, reply) => {
  requireAuth(req, reply);
  const { limit = 50, since, mine } = req.query as { limit?: number; since?: string; mine?: string };
  const parsedSince = since && typeof since === "string" && since.length <= 30 ? since : undefined;
  const mineOnly = mine === "true" || mine === "1";
  return loadRecentTasks(req.session.userId!, req.session.role!, Math.max(1, Math.min(200, Number(limit) || 50)), parsedSince, mineOnly);
});

app.get("/api/auth/csrf", async (req, reply) => {
  const token = await reply.generateCsrf();
  return { token };
});

// Account lockout policy: too many failed attempts within FAILED_WINDOW_MS triggers
// a lock for LOCKOUT_DURATION_MS. This complements per-IP rate limiting and protects
// individual accounts targeted from rotating IPs.
const FAILED_ATTEMPTS_THRESHOLD = 10;
const FAILED_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function recordFailedLogin(userId: number, now: Date) {
  const row = db.prepare("SELECT failed_login_count, failed_login_window_start FROM users WHERE id = ?").get(userId) as { failed_login_count: number; failed_login_window_start: string | null } | undefined;
  if (!row) return;
  const windowStart = row.failed_login_window_start ? new Date(row.failed_login_window_start) : null;
  const inWindow = windowStart && (now.getTime() - windowStart.getTime() < FAILED_WINDOW_MS);
  const nextCount = inWindow ? row.failed_login_count + 1 : 1;
  const nextWindowStart = inWindow ? row.failed_login_window_start : now.toISOString();
  const lockedUntil = nextCount >= FAILED_ATTEMPTS_THRESHOLD ? new Date(now.getTime() + LOCKOUT_DURATION_MS).toISOString() : null;
  db.prepare("UPDATE users SET failed_login_count = ?, failed_login_window_start = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?")
    .run(nextCount, nextWindowStart, lockedUntil, userId);
}

function clearFailedLogin(userId: number) {
  db.prepare("UPDATE users SET failed_login_count = 0, failed_login_window_start = NULL, locked_until = NULL WHERE id = ?").run(userId);
}

app.post("/api/auth/login", {
  config: { rateLimit: { max: 5, timeWindow: 15 * 60 * 1000 } },
}, async (req, reply) => {
  const body = LoginSchema.safeParse(req.body);
  if (!body.success) return reply.status(400).send({ error: "Invalid input" });
  const { username, password } = body.data;

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as { id: number; username: string; password_hash: string; role: string; suspended: number; must_change_password: number; locked_until: string | null } | undefined;

  if (user?.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    if (lockedUntil.getTime() > Date.now()) {
      const retryAfterSec = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
      securityLog(db, { userId: user.id, username, ip: getClientIp(req), action: "auth.login", result: "error", details: "Account locked" });
      reply.header("Retry-After", String(retryAfterSec));
      return reply.status(423).send({ error: "Account temporarily locked. Try again later.", retryAfterSec });
    }
  }

  if (!user || !await argon2.verify(user.password_hash, password)) {
    if (user) recordFailedLogin(user.id, new Date());
    securityLog(db, { userId: user?.id ?? null, username, ip: getClientIp(req), action: "auth.login", result: "error", details: "Invalid credentials" });
    return reply.status(401).send({ error: "Invalid credentials" });
  }
  if (user.suspended) return reply.status(403).send({ error: "Account suspended" });

  clearFailedLogin(user.id);

  // ── Second factor ────────────────────────────────────────────────────────
  // If the account has an MFA channel enabled (and it is globally available),
  // hold the session in a "pending" state and send a one-time code. The session
  // is NOT authenticated until POST /api/auth/mfa/verify succeeds.
  const mfaUser = getMfaUser(user.id);
  const smsActive = !!mfaUser?.mfa_sms_enabled && !!mfaUser?.phone_verified && mfaSmsGloballyEnabled() && !!getSetting("mfa.twilio.accountSid");
  const emailActive = !!mfaUser?.mfa_email_enabled && !!mfaUser?.email_verified && mfaEmailGloballyEnabled() && !!getSetting("mfa.smtp.host");
  if (smsActive || emailActive) {
    const method: "sms" | "email" = smsActive ? "sms" : "email";
    const destination = method === "sms" ? (mfaUser!.phone_number ?? "") : (mfaUser!.email ?? "");
    try {
      await issueMfaCode({ userId: user.id, purpose: method === "sms" ? "login-sms" : "login-email", channel: method, destination });
    } catch (err) {
      securityLog(db, { userId: user.id, username: user.username, ip: getClientIp(req), action: "auth.login.mfa-send", result: "error", details: (err as Error).message });
      return reply.status(502).send({ error: `Could not send the verification code: ${(err as Error).message}` });
    }
    // Reset any prior identity on the session; only the pending marker is set.
    req.session.userId = undefined;
    req.session.role = undefined;
    req.session.pendingMfaUserId = user.id;
    req.session.pendingMfaMethod = method;
    await req.session.save();
    securityLog(db, { userId: user.id, username: user.username, ip: getClientIp(req), action: "auth.login.mfa-challenge", result: "success", details: method });
    return {
      ok: true,
      mfaRequired: true,
      method,
      sentTo: method === "sms" ? maskPhone(destination) : maskEmail(destination),
      availableMethods: [smsActive ? "sms" : null, emailActive ? "email" : null].filter(Boolean),
    };
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.mustChangePassword = !!user.must_change_password;
  req.session.pendingMfaUserId = undefined;
  await req.session.save();

  securityLog(db, { userId: user.id, username: user.username, ip: getClientIp(req), action: "auth.login", result: "success", details: "mfa:off" });
  return { ok: true, user: { id: user.id, username: user.username, role: user.role, mustChangePassword: !!user.must_change_password } };
});

// Complete an MFA-gated login by submitting the one-time code.
app.post("/api/auth/mfa/verify", { config: { rateLimit: { max: 10, timeWindow: 15 * 60_000 } } }, async (req, reply) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return reply.status(401).send({ error: "No pending verification. Sign in again." });
  const code = (req.body as { code?: unknown })?.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return reply.status(400).send({ error: "A 6-digit code is required" });
  const method = req.session.pendingMfaMethod ?? "sms";
  const result = await verifyMfaCode(pendingUserId, method === "sms" ? "login-sms" : "login-email", code);
  if (!result.ok) {
    securityLog(db, { userId: pendingUserId, ip: getClientIp(req), action: "auth.login.mfa-verify", result: "error", details: result.reason });
    return reply.status(401).send({ error: result.reason });
  }
  const user = db.prepare("SELECT id, username, role, suspended, must_change_password FROM users WHERE id = ?").get(pendingUserId) as { id: number; username: string; role: string; suspended: number; must_change_password: number } | undefined;
  if (!user || user.suspended) return reply.status(403).send({ error: "Account unavailable" });
  req.session.pendingMfaUserId = undefined;
  req.session.pendingMfaMethod = undefined;
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.mustChangePassword = !!user.must_change_password;
  await req.session.save();
  securityLog(db, { userId: user.id, username: user.username, ip: getClientIp(req), action: "auth.login", result: "success", details: `mfa:${method}` });
  return { ok: true, user: { id: user.id, username: user.username, role: user.role, mustChangePassword: !!user.must_change_password } };
});

// Resend a fresh login code to the pending account.
app.post("/api/auth/mfa/resend", { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (req, reply) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return reply.status(401).send({ error: "No pending verification. Sign in again." });
  const method = req.session.pendingMfaMethod ?? "sms";
  const u = getMfaUser(pendingUserId);
  if (!u) return reply.status(404).send({ error: "Not found" });
  const destination = method === "sms" ? (u.phone_number ?? "") : (u.email ?? "");
  try {
    await issueMfaCode({ userId: pendingUserId, purpose: method === "sms" ? "login-sms" : "login-email", channel: method, destination });
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
  return { ok: true, sentTo: method === "sms" ? maskPhone(destination) : maskEmail(destination) };
});

app.post("/api/auth/logout", async (req, reply) => {
  if (req.session.userId) {
    securityLog(db, { userId: req.session.userId, username: req.session.username, ip: getClientIp(req), action: "auth.logout", result: "success" });
  }
  await req.session.destroy();
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  if (!req.session.userId) return reply.status(401).send({ error: "Unauthorized" });
  const user = db.prepare("SELECT id, username, role, display_name, email, must_change_password FROM users WHERE id = ?").get(req.session.userId) as { id: number; username: string; role: string; display_name: string | null; email: string | null; must_change_password: number };
  if (!user) return reply.status(404).send({ error: "Not found" });
  return { id: user.id, username: user.username, role: user.role, displayName: user.display_name, email: user.email, mustChangePassword: !!user.must_change_password };
});

app.get("/api/auth/capabilities", async (req, reply) => {
  if (!req.session.userId) return reply.status(401).send({ error: "Unauthorized" });
  await reconcileResourceMetadata();
  const user = db.prepare("SELECT id, username, role, display_name, email, must_change_password FROM users WHERE id = ?").get(req.session.userId) as {
    id: number;
    username: string;
    role: "ADMIN" | "USER";
    display_name: string | null;
    email: string | null;
    must_change_password: number;
  } | undefined;
  if (!user) return reply.status(404).send({ error: "Not found" });
  return buildAuthCapabilities(user);
});

app.post("/api/auth/change-password", async (req, reply) => {
  requireAuth(req, reply);
  const body = req.body as { currentPassword?: unknown; newPassword?: unknown };
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return reply.status(400).send({ error: "currentPassword and newPassword are required" });
  }
  const policyCheck = validatePassword(newPassword);
  if (!policyCheck.ok) {
    return reply.status(400).send({ error: policyCheck.error });
  }
  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.session.userId!) as { password_hash: string };
  if (!await argon2.verify(user.password_hash, currentPassword)) return reply.status(401).send({ error: "Wrong password" });
  const hash = await argon2.hash(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, req.session.userId!);
  req.session.mustChangePassword = false;
  await req.session.save();
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "auth.change-password", result: "success" });
  return { ok: true };
});

// ── MFA (multi-factor authentication) ───────────────────────────────────────
const MFA_LOGIN_TTL_MS = 10 * 60_000;   // login challenge codes: 10 minutes
const MFA_VERIFY_TTL_MS = 30 * 60_000;  // ownership-verification codes: 30 minutes
const MFA_MAX_ATTEMPTS = 5;

function mfaSmsGloballyEnabled(): boolean { return getSetting("mfa.sms.enabled") === "1"; }
function mfaEmailGloballyEnabled(): boolean { return getSetting("mfa.email.enabled") === "1"; }

function getTwilioConfig(): TwilioConfig {
  return {
    accountSid: getSetting("mfa.twilio.accountSid") ?? "",
    authToken: getSetting("mfa.twilio.authToken") ?? "",
    fromNumber: getSetting("mfa.twilio.fromNumber") ?? "",
  };
}
function getSmtpConfig(): SmtpConfig {
  return {
    host: getSetting("mfa.smtp.host") ?? "",
    port: parseInt(getSetting("mfa.smtp.port") ?? "587", 10) || 587,
    secure: getSetting("mfa.smtp.secure") === "1",
    user: getSetting("mfa.smtp.user") ?? undefined,
    pass: getSetting("mfa.smtp.pass") ?? undefined,
    from: getSetting("mfa.smtp.from") ?? "",
  };
}

interface MfaUserRow {
  id: number; username: string; email: string | null; phone_number: string | null;
  phone_verified: number; email_verified: number; mfa_sms_enabled: number; mfa_email_enabled: number;
}
function getMfaUser(userId: number): MfaUserRow | undefined {
  return db.prepare("SELECT id, username, email, phone_number, phone_verified, email_verified, mfa_sms_enabled, mfa_email_enabled FROM users WHERE id = ?").get(userId) as MfaUserRow | undefined;
}

/** Generate a code, store its hash, and deliver it over the requested channel. */
async function issueMfaCode(opts: {
  userId: number;
  purpose: "verify-phone" | "verify-email" | "login-sms" | "login-email";
  channel: "sms" | "email";
  destination: string;
  username?: string;
}): Promise<void> {
  const code = generateNumericCode(6);
  const ttl = opts.purpose.startsWith("login-") ? MFA_LOGIN_TTL_MS : MFA_VERIFY_TTL_MS;
  // Invalidate any previous un-consumed code for the same (user,purpose).
  db.prepare("UPDATE mfa_codes SET consumed_at = datetime('now') WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL").run(opts.userId, opts.purpose);
  const hash = await argon2.hash(code);
  db.prepare("INSERT INTO mfa_codes (id, user_id, purpose, channel, destination, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), opts.userId, opts.purpose, opts.channel, opts.destination, hash, new Date(Date.now() + ttl).toISOString());

  const minutes = Math.round(ttl / 60_000);
  const text = `AuxiNux Virtua: votre code de vérification est ${code}. Il expire dans ${minutes} minutes.`;
  if (opts.channel === "sms") {
    await sendSms(getTwilioConfig(), opts.destination, text);
  } else {
    await sendEmail(getSmtpConfig(), opts.destination, "Code de vérification AuxiNux Virtua", text);
  }
}

/** Verify a submitted code; consumes it on success. Returns ok/reason. */
async function verifyMfaCode(userId: number, purpose: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const row = db.prepare("SELECT id, code_hash, expires_at, consumed_at, attempts FROM mfa_codes WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(userId, purpose) as { id: string; code_hash: string; expires_at: string; consumed_at: string | null; attempts: number } | undefined;
  if (!row) return { ok: false, reason: "No active code. Request a new one." };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE mfa_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: false, reason: "Code expired. Request a new one." };
  }
  if (row.attempts >= MFA_MAX_ATTEMPTS) {
    db.prepare("UPDATE mfa_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: false, reason: "Too many attempts. Request a new code." };
  }
  const valid = await argon2.verify(row.code_hash, code).catch(() => false);
  if (!valid) {
    db.prepare("UPDATE mfa_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return { ok: false, reason: "Invalid code." };
  }
  db.prepare("UPDATE mfa_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true };
}

const mfaRateLimit = { config: { rateLimit: { max: 6, timeWindow: 60_000 } } };

// ── Account MFA (self-service) ──────────────────────────────────────────────
app.get("/api/account/mfa", async (req, reply) => {
  requireAuth(req, reply);
  const u = getMfaUser(req.session.userId!);
  if (!u) return reply.status(404).send({ error: "Not found" });
  return {
    smsAvailable: mfaSmsGloballyEnabled() && !!getSetting("mfa.twilio.accountSid"),
    emailAvailable: mfaEmailGloballyEnabled() && !!getSetting("mfa.smtp.host"),
    sms: { enabled: !!u.mfa_sms_enabled, phoneVerified: !!u.phone_verified, phone: u.phone_number ? maskPhone(u.phone_number) : null },
    email: { enabled: !!u.mfa_email_enabled, emailVerified: !!u.email_verified, email: u.email ? maskEmail(u.email) : null },
  };
});

app.post("/api/account/mfa/sms/start", mfaRateLimit, async (req, reply) => {
  requireAuth(req, reply);
  if (!mfaSmsGloballyEnabled()) return reply.status(403).send({ error: "SMS MFA is disabled by the administrator" });
  const phoneRaw = (req.body as { phone?: unknown })?.phone;
  if (typeof phoneRaw !== "string" || !isLikelyPhone(phoneRaw)) return reply.status(400).send({ error: "A valid phone number is required (E.164, e.g. +15145551234)" });
  const phone = normalizePhone(phoneRaw);
  // Store the (unverified) phone, reset verification until the code is confirmed.
  db.prepare("UPDATE users SET phone_number = ?, phone_verified = 0 WHERE id = ?").run(phone, req.session.userId!);
  try {
    await issueMfaCode({ userId: req.session.userId!, purpose: "verify-phone", channel: "sms", destination: phone });
  } catch (err) {
    return reply.status(502).send({ error: `Could not send SMS: ${(err as Error).message}` });
  }
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.sms.verify-start", result: "success" });
  return { ok: true, sentTo: maskPhone(phone) };
});

app.post("/api/account/mfa/sms/confirm", mfaRateLimit, async (req, reply) => {
  requireAuth(req, reply);
  const code = (req.body as { code?: unknown })?.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return reply.status(400).send({ error: "A 6-digit code is required" });
  const result = await verifyMfaCode(req.session.userId!, "verify-phone", code);
  if (!result.ok) return reply.status(400).send({ error: result.reason });
  db.prepare("UPDATE users SET phone_verified = 1, mfa_sms_enabled = 1 WHERE id = ?").run(req.session.userId!);
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.sms.enabled", result: "success" });
  return { ok: true };
});

app.post("/api/account/mfa/sms/disable", async (req, reply) => {
  requireAuth(req, reply);
  db.prepare("UPDATE users SET mfa_sms_enabled = 0 WHERE id = ?").run(req.session.userId!);
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.sms.disabled", result: "success" });
  return { ok: true };
});

app.post("/api/account/mfa/email/start", mfaRateLimit, async (req, reply) => {
  requireAuth(req, reply);
  if (!mfaEmailGloballyEnabled()) return reply.status(403).send({ error: "Email MFA is disabled by the administrator" });
  const emailRaw = (req.body as { email?: unknown })?.email;
  const u = getMfaUser(req.session.userId!);
  // Allow setting/overriding the email if provided, else use the account email.
  const email = typeof emailRaw === "string" && emailRaw.trim() ? emailRaw.trim() : (u?.email ?? "");
  if (!isLikelyEmail(email)) return reply.status(400).send({ error: "A valid email address is required" });
  db.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?").run(email, req.session.userId!);
  try {
    await issueMfaCode({ userId: req.session.userId!, purpose: "verify-email", channel: "email", destination: email });
  } catch (err) {
    return reply.status(502).send({ error: `Could not send email: ${(err as Error).message}` });
  }
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.email.verify-start", result: "success" });
  return { ok: true, sentTo: maskEmail(email) };
});

app.post("/api/account/mfa/email/confirm", mfaRateLimit, async (req, reply) => {
  requireAuth(req, reply);
  const code = (req.body as { code?: unknown })?.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return reply.status(400).send({ error: "A 6-digit code is required" });
  const result = await verifyMfaCode(req.session.userId!, "verify-email", code);
  if (!result.ok) return reply.status(400).send({ error: result.reason });
  db.prepare("UPDATE users SET email_verified = 1, mfa_email_enabled = 1 WHERE id = ?").run(req.session.userId!);
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.email.enabled", result: "success" });
  return { ok: true };
});

app.post("/api/account/mfa/email/disable", async (req, reply) => {
  requireAuth(req, reply);
  db.prepare("UPDATE users SET mfa_email_enabled = 0 WHERE id = ?").run(req.session.userId!);
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "mfa.email.disabled", result: "success" });
  return { ok: true };
});

// ── Admin: global MFA settings (Twilio + SMTP) ──────────────────────────────
app.get("/api/settings/mfa", async (req, reply) => {
  requireAdmin(req, reply);
  return {
    sms: {
      enabled: mfaSmsGloballyEnabled(),
      twilio: {
        accountSid: getSetting("mfa.twilio.accountSid") ?? "",
        fromNumber: getSetting("mfa.twilio.fromNumber") ?? "",
        hasAuthToken: !!getSetting("mfa.twilio.authToken"),
      },
    },
    email: {
      enabled: mfaEmailGloballyEnabled(),
      smtp: {
        host: getSetting("mfa.smtp.host") ?? "",
        port: parseInt(getSetting("mfa.smtp.port") ?? "587", 10) || 587,
        secure: getSetting("mfa.smtp.secure") === "1",
        user: getSetting("mfa.smtp.user") ?? "",
        from: getSetting("mfa.smtp.from") ?? "",
        hasPass: !!getSetting("mfa.smtp.pass"),
      },
    },
  };
});

app.put("/api/settings/mfa", async (req, reply) => {
  requireAdmin(req, reply);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const sms = (b.sms ?? {}) as Record<string, unknown>;
  const email = (b.email ?? {}) as Record<string, unknown>;
  const twilio = (sms.twilio ?? {}) as Record<string, unknown>;
  const smtp = (email.smtp ?? {}) as Record<string, unknown>;

  if (typeof sms.enabled === "boolean") setSetting("mfa.sms.enabled", sms.enabled ? "1" : "0");
  if (typeof twilio.accountSid === "string") setSetting("mfa.twilio.accountSid", twilio.accountSid.trim());
  if (typeof twilio.fromNumber === "string") setSetting("mfa.twilio.fromNumber", twilio.fromNumber.trim());
  // Secrets: only overwrite when a non-empty value is supplied.
  if (typeof twilio.authToken === "string" && twilio.authToken.length > 0) setSetting("mfa.twilio.authToken", twilio.authToken.trim());

  if (typeof email.enabled === "boolean") setSetting("mfa.email.enabled", email.enabled ? "1" : "0");
  if (typeof smtp.host === "string") setSetting("mfa.smtp.host", smtp.host.trim());
  if (smtp.port !== undefined) setSetting("mfa.smtp.port", String(parseInt(String(smtp.port), 10) || 587));
  if (typeof smtp.secure === "boolean") setSetting("mfa.smtp.secure", smtp.secure ? "1" : "0");
  if (typeof smtp.user === "string") setSetting("mfa.smtp.user", smtp.user.trim());
  if (typeof smtp.from === "string") setSetting("mfa.smtp.from", smtp.from.trim());
  if (typeof smtp.pass === "string" && smtp.pass.length > 0) setSetting("mfa.smtp.pass", smtp.pass);

  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "settings.mfa.update", result: "success" });
  return { ok: true };
});

app.post("/api/settings/mfa/test-sms", mfaRateLimit, async (req, reply) => {
  requireAdmin(req, reply);
  const to = (req.body as { to?: unknown })?.to;
  if (typeof to !== "string" || !isLikelyPhone(to)) return reply.status(400).send({ error: "A valid destination phone is required" });
  try {
    await sendSms(getTwilioConfig(), normalizePhone(to), "AuxiNux Virtua: SMS de test (configuration MFA).");
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
  return { ok: true };
});

app.post("/api/settings/mfa/test-email", mfaRateLimit, async (req, reply) => {
  requireAdmin(req, reply);
  const to = (req.body as { to?: unknown })?.to;
  if (typeof to !== "string" || !isLikelyEmail(to)) return reply.status(400).send({ error: "A valid destination email is required" });
  try {
    await sendEmail(getSmtpConfig(), to, "AuxiNux Virtua — test", "Email de test (configuration MFA).");
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
  return { ok: true };
});

// ── Admin: host SSH access ─────────────────────────────────────────────────
app.get("/api/settings/ssh", async (req, reply) => {
  requireAdmin(req, reply);
  return callRunner("system_ssh_status");
});

app.put("/api/settings/ssh", async (req, reply) => {
  requireAdmin(req, reply);
  const mode = (req.body as { mode?: unknown } | undefined)?.mode;
  if (mode !== "key-only" && mode !== "key-and-password" && mode !== "password-only") {
    return reply.status(400).send({ error: "Invalid SSH mode" });
  }
  const result = await callRunner("system_ssh_set_mode", { mode });
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "settings.ssh.mode", result: "success", details: String(mode) });
  return result;
});

app.post("/api/settings/ssh/key", async (req, reply) => {
  requireAdmin(req, reply);
  const result = await callRunner("system_ssh_generate_key");
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "settings.ssh.key.generate", result: "success" });
  return result;
});

app.get("/api/settings/ssh/key/download", async (req, reply) => {
  requireAdmin(req, reply);
  const key = await callRunner<{ filename: string; privateKey: string }>("system_ssh_private_key");
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "settings.ssh.key.download", result: "success" });
  return reply
    .header("Content-Type", "application/octet-stream")
    .header("Content-Disposition", `attachment; filename="${key.filename}"`)
    .send(key.privateKey);
});

// ── SYSTEM Routes ──────────────────────────────────────────────────────────
app.get("/api/system/stats", async (req, reply) => {
  requireUiSection(req, "dashboard");
  const stats = await callRunner("system_stats");
  return stats;
});

app.get("/api/system/info", async (req, reply) => {
  requireUiSection(req, "dashboard");
  return callRunner("system_info");
});

app.get("/api/internal/node/summary", async (req, reply) => {
  requireInternalNodeToken(req);
  const localNode = listDatacenterNodes().find((node) => node.isLocal);
  if (!localNode) return reply.status(404).send({ error: "Local node not found" });
  return buildNodeSummary(localNode);
});

app.get("/api/internal/node/resources", async (req, reply) => {
  requireInternalNodeToken(req);
  return listLocalDatacenterResourceEntries();
});

app.get("/api/internal/system/info", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("system_info");
});

app.get("/api/internal/system/services", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("system_services");
});

app.get("/api/internal/system/updates", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("system_updates");
});

app.get("/api/internal/settings", async (req, reply) => {
  requireInternalNodeToken(req);
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
});

app.put("/api/internal/settings", async (req, reply) => {
  requireInternalNodeToken(req);
  const settings = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(settings)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
  return { ok: true };
});

app.post("/api/internal/system/host/console-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { initialCommand } = (req.body as { initialCommand?: string } | undefined) ?? {};
  const ticket = issueWsTicket("host", 0, undefined, initialCommand);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.get("/api/internal/storage/pools", async (req, reply) => {
  requireInternalNodeToken(req);
  ensureBuiltinStoragePools();
  const pools = db.prepare("SELECT * FROM storage_pools WHERE enabled = 1").all() as Array<{
    id: number;
    name: string;
    path: string;
    type: string;
    content: string;
    total_bytes: number;
    used_bytes: number;
    mount_source: string | null;
    fstype: string | null;
    mount_options: string | null;
  }>;
  // Actual mount state — a FUSE mount whose daemon died still shows up in
  // `findmnt` (the kernel keeps the entry) but any real access fails with
  // ENOTCONN. Probe liveness with `stat` (storage_pool_alive) instead, so a
  // dead rclone mount is reported as unmounted and VDM can remount it.
  return Promise.all(pools.map(async (pool) => {
    let alive: boolean | undefined;
    try {
      alive = (await callRunner<{ alive: boolean }>("storage_pool_alive", { path: pool.path })).alive;
    } catch {
      alive = undefined; // runner unreachable → unknown
    }
    try {
      const df = await callRunner<{ totalBytes: number; usedBytes: number; freeBytes: number }>("storage_pool_df", { path: pool.path });
      return {
        ...pool,
        content: JSON.parse(pool.content),
        mounted: alive,
        totalBytes: df.totalBytes,
        usedBytes: df.usedBytes,
        freeBytes: df.freeBytes,
        mountSource: pool.mount_source ?? undefined,
        mountOptions: pool.mount_options ?? undefined,
      };
    } catch {
      return {
        ...pool,
        content: JSON.parse(pool.content),
        mounted: alive,
        totalBytes: pool.total_bytes,
        usedBytes: pool.used_bytes,
        freeBytes: 0,
        mountSource: pool.mount_source ?? undefined,
        mountOptions: pool.mount_options ?? undefined,
      };
    }
  }));
});

app.get("/api/internal/storage/pools/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const pool = db.prepare("SELECT * FROM storage_pools WHERE name = ?").get(name) as {
    path: string;
    type: string;
    content: string;
    mount_source: string | null;
    fstype: string | null;
    mount_options: string | null;
    enabled?: number;
  } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  const df = await callRunner<{ totalBytes: number; usedBytes: number; freeBytes: number }>("storage_pool_df", { path: pool.path });
  return {
    ...pool,
    name,
    content: JSON.parse(pool.content),
    mountSource: pool.mount_source ?? undefined,
    mountOptions: pool.mount_options ?? undefined,
    enabled: pool.enabled !== 0,
    ...df as object,
  };
});

app.get("/api/internal/storage/pools/:name/content", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(name) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  await reconcileSnapshotMetadata();
  return listPoolContent(name, pool.path);
});

app.post("/api/internal/storage/pools/:name/content/delete", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { itemPath } = (req.body as { itemPath?: string }) ?? {};
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
  const { item } = await resolvePoolContentItem(name, itemPath);
  return deletePoolContentItem(name, item);
});

app.post("/api/internal/storage/pools/:name/content/checksum", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { itemPath } = (req.body as { itemPath?: string }) ?? {};
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
  const { item } = await resolvePoolContentItem(name, itemPath);
  if (item.synthetic) return reply.status(400).send({ error: "Synthetic items cannot be checksummed" });
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(item.path)) hash.update(chunk as Buffer);
  return { algorithm: "sha256", checksum: hash.digest("hex"), sizeBytes: item.size };
});

// Download a pool content file as a binary stream (cross-node transfer).
app.get("/api/internal/storage/pools/:name/content/download", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { itemPath } = req.query as { itemPath?: string };
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
  const { item } = await resolvePoolContentItem(name, itemPath);
  if (item.synthetic) return reply.status(400).send({ error: "Synthetic items cannot be downloaded" });
  const stat = await fs.promises.stat(item.path);
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Length", stat.size);
  reply.header("Content-Disposition", `attachment; filename="${path.basename(item.path)}"`);
  return reply.send(fs.createReadStream(item.path));
});

// Upload a file into a pool's backups dir as a binary stream (cross-node transfer).
app.post("/api/internal/storage/pools/:name/content/upload", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { filename } = req.query as { filename?: string };
  if (!filename) return reply.status(400).send({ error: "filename is required" });
  const safeName = sanitizeManagedFilename(filename);
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(name) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  const destDir = path.join(pool.path, "backups");
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, safeName);
  const tempPath = `${destPath}.part-${randomUUID()}`;
  try {
    await pipeline(req.body as NodeJS.ReadableStream, fs.createWriteStream(tempPath, { flags: "wx" }));
    await fs.promises.rename(tempPath, destPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
  const stat = await fs.promises.stat(destPath);
  return { ok: true, filename: safeName, sizeBytes: stat.size, path: destPath };
});

app.post("/api/internal/storage/pools", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = CreateStoragePoolSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return createLocalStoragePool({
    name: parsed.data.name,
    path: parsed.data.path,
    type: parsed.data.type,
    content: parsed.data.content,
    mountSource: parsed.data.mountSource ?? parsed.data.mountDevice ?? undefined,
    fstype: parsed.data.fstype ?? undefined,
    mountOptions: parsed.data.mountOptions ?? undefined,
    smbUsername: parsed.data.smbUsername ?? undefined,
    smbPassword: parsed.data.smbPassword ?? undefined,
    smbDomain: parsed.data.smbDomain ?? undefined,
    smbVersion: parsed.data.smbVersion ?? undefined,
    nfsVersion: parsed.data.nfsVersion ?? undefined,
    s3Endpoint: parsed.data.s3Endpoint ?? undefined,
    s3Bucket: parsed.data.s3Bucket ?? undefined,
    s3Region: parsed.data.s3Region ?? undefined,
    s3AccessKey: parsed.data.s3AccessKey ?? undefined,
    s3SecretKey: parsed.data.s3SecretKey ?? undefined,
    s3Provider: parsed.data.s3Provider ?? undefined,
    s3VfsCacheMode: parsed.data.s3VfsCacheMode ?? undefined,
  });
});

app.delete("/api/internal/storage/pools/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return deleteLocalStoragePool(name);
});

app.get("/api/internal/storage/isos", async (req, reply) => {
  requireInternalNodeToken(req);
  // Return ALL managed files (ISO, LXC templates, docker images, VM disks) so
  // VDM can manage them uniformly. The `type` field lets the UI group/filter.
  return listManagedFiles();
});

// Stream a managed ISO file (cross-node copy / VDM download).
app.get("/api/internal/storage/isos/:filename/download", async (req, reply) => {
  requireInternalNodeToken(req);
  const { filename } = req.params as { filename: string };
  const resolvedPath = await resolveManagedFilePath(filename, "iso");
  const stat = await fs.promises.stat(resolvedPath);
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Length", stat.size);
  reply.header("Content-Disposition", `attachment; filename="${path.basename(resolvedPath)}"`);
  return reply.send(fs.createReadStream(resolvedPath));
});

// Receive a managed ISO as a binary stream (cross-node copy target).
app.post("/api/internal/storage/isos/upload", async (req, reply) => {
  requireInternalNodeToken(req);
  const { filename, storagePool } = req.query as { filename?: string; storagePool?: string };
  if (!filename) return reply.status(400).send({ error: "filename is required" });
  const safeName = sanitizeManagedFilename(filename);
  if (!isAllowedManagedFile(safeName, "iso")) return reply.status(400).send({ error: "Unsupported ISO extension" });
  // Optional target pool (local or shared). Defaults to the managed ISO dir.
  let destDir = getManagedStorageDir("iso");
  let poolName: string | undefined;
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
    if (!pool.content.includes("iso")) return reply.status(400).send({ error: "Storage pool does not allow ISO files" });
    destDir = pool.path;
    poolName = storagePool;
  }
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, safeName);
  const tempPath = `${destPath}.part-${randomUUID()}`;
  try {
    await pipeline(req.body as NodeJS.ReadableStream, fs.createWriteStream(tempPath, { flags: "wx" }));
    await fs.promises.rename(tempPath, destPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
  await ensureLibvirtManagedFileAccess(destPath, "iso");
  const stat = await fs.promises.stat(destPath);
  db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, 'iso', ?, NULL, 0, ?)").run(safeName, safeName, stat.size, poolName ?? null);
  return { ok: true, filename: safeName, sizeBytes: stat.size, storagePool: poolName ?? null };
});

// Delete a managed ISO/template file (VDM proxy target).
app.delete("/api/internal/storage/isos/:filename", async (req, reply) => {
  requireInternalNodeToken(req);
  const { filename } = req.params as { filename: string };
  const fileType = resolveManagedFileType((req.query as { type?: string }).type);
  const safeName = sanitizeManagedFilename(filename);
  const fileRow = db.prepare("SELECT storage_pool FROM iso_files WHERE filename = ? AND type = ?").get(safeName, fileType) as { storage_pool: string | null } | undefined;
  let managedDir = getManagedStorageDir(fileType);
  if (fileRow?.storage_pool) {
    const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(fileRow.storage_pool) as { path: string } | undefined;
    if (pool) managedDir = pool.path;
  }
  const fullPath = path.join(managedDir, safeName);
  const realPath = await fs.promises.realpath(fullPath).catch(() => null);
  if (!realPath || !realPath.startsWith(managedDir)) return reply.status(400).send({ error: "Invalid path" });
  if (fileType === "vm_disk") {
    const attachedVm = await isManagedVmDiskAttached(realPath);
    if (attachedVm) return reply.status(409).send({ error: `Disk image is attached to VM ${attachedVm}` });
  }
  await fs.promises.unlink(realPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  db.prepare("DELETE FROM iso_files WHERE filename = ? AND type = ?").run(safeName, fileType);
  return { ok: true };
});

// Download a managed file from a URL into a pool (VDM proxy target).
app.post("/api/internal/storage/isos/from-url", async (req, reply) => {
  requireInternalNodeToken(req);
  const { url, displayName, type, storagePool } = req.body as { url?: string; displayName?: string; type?: string; storagePool?: string };
  if (!url) return reply.status(400).send({ error: "url is required" });
  const fileType = resolveManagedFileType(type);
  const task = createTask(0, "vdm", {
    kind: "url-download", action: "storage.download.url",
    label: `Download ${displayName || url}`, resourceType: fileType,
    resourceName: displayName || url, message: "Downloading file", detail: displayName || url,
  });
  const ip = getClientIp(req);
  void saveManagedDownloadWithProgress(task.id, url, fileType, displayName, storagePool?.trim() || undefined)
    .then((download) => {
      db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, ?, ?, 0, 0, ?)").run(
        download.filename, displayName || download.filename, fileType, download.sizeBytes, storagePool?.trim() || null,
      );
      updateTask(task.id, { status: "completed", progressPercent: 100, bytesCurrent: download.sizeBytes, bytesTotal: download.sizeBytes, message: "Download completed", detail: download.filename, result: { ...download, type: fileType } });
      const completed = getTaskRecord(task.id);
      if (completed) writeTaskAudit(completed, ip);
    })
    .catch((error) => {
      updateTask(task.id, { status: "failed", error: error instanceof Error ? error.message : "Download failed", message: "Download failed" });
      const failed = getTaskRecord(task.id);
      if (failed) writeTaskAudit(failed, ip);
    });
  return sanitizeTask(task);
});

// Remote depot catalog (VDM proxy target).
app.get("/api/internal/templates/depot", async (req, reply) => {
  requireInternalNodeToken(req);
  const { refresh } = req.query as { refresh?: string };
  if (refresh) depotCache = null;
  try {
    return { base: getTemplateDepotBase(), items: await listTemplateDepot() };
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : "Depot unreachable" });
  }
});

// Import a depot item into a pool (VDM proxy target).
app.post("/api/internal/templates/depot/import", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id, storagePool, visibility } = req.body as { id?: string; storagePool?: string; visibility?: string };
  if (!id) return reply.status(400).send({ error: "id required" });
  const catalog = await listTemplateDepot().catch(() => [] as DepotItem[]);
  const item = catalog.find((entry) => entry.id === id);
  if (!item) return reply.status(404).send({ error: "Depot item not found" });
  if (item.alreadyImported) return reply.status(409).send({ error: "Already imported" });
  let targetDir = item.type === "iso" ? ISOS_DIR : VM_TEMPLATES_DIR;
  let poolName: string | undefined;
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
    if (!pool.content.includes(item.type === "iso" ? "iso" : "template")) {
      return reply.status(400).send({ error: "Storage pool does not allow this template type" });
    }
    targetDir = pool.path;
    poolName = storagePool;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destPath = path.join(targetDir, sanitizeManagedFilename(item.filename));
  if (fs.existsSync(destPath)) return reply.status(409).send({ error: "A file with this name already exists" });
  const ip = getClientIp(req);
  const task = createTask(0, "vdm", {
    kind: "url-download", action: "template.depot.import", label: `Import ${item.name} from depot`,
    resourceType: "template", resourceName: item.filename, message: "Downloading from depot", detail: item.filename,
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    const tmpPath = path.join(targetDir, `.depot-${randomUUID()}`);
    try {
      await withUrlDownloadSlot(task.id, () => downloadUrlToFileWithProgress(task.id, item.url, tmpPath));
      await fs.promises.rename(tmpPath, destPath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
    const stat = await fs.promises.stat(destPath);
    db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, ?, ?, 0, ?, ?)").run(
      item.filename, item.name, item.type === "iso" ? "iso" : "lxc_template", stat.size,
      visibility === "public" ? 1 : 0, poolName ?? null,
    );
    update({ progressPercent: 100, message: "Import complete", result: { filename: item.filename, sizeBytes: stat.size } });
  });
  return sanitizeTask(task);
});

// Recent local warn/error entries for the VDM central LOGS page.
app.get("/api/internal/logs/recent", async (req, reply) => {
  requireInternalNodeToken(req);
  const query = req.query as { since?: string };
  const since = query.since && /^\d{4}-\d{2}-\d{2}T/.test(query.since) ? query.since : new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = db.prepare("SELECT ts, level, category, message FROM node_error_log WHERE ts >= ? AND level IN ('warn','error') ORDER BY ts DESC LIMIT 200").all(since) as Array<{ ts: string; level: string; category: string; message: string }>;
  return rows;
});

app.get("/api/internal/network/bridges", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("network_bridges_list");
});

app.get("/api/internal/host/usb-devices", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("system_usb_devices");
});

app.get("/api/internal/host/gpu-devices", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("system_gpu_devices");
});

app.get("/api/internal/lxc/templates", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("lxc_templates", { refresh: false });
});

app.get("/api/internal/docker/images", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_images");
});

app.get("/api/internal/docker/networks", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_networks");
});

app.post("/api/internal/vms", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = CreateVmSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const result = await callRunner("qemu_create", await prepareVmCreatePayload(parsed.data));
  db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, NULL, ?, ?, ?)")
    .run(parsed.data.name, parsed.data.description ?? null, JSON.stringify(parsed.data.tags ?? []), getLocalNodeName());
  return result;
});

app.post("/api/internal/lxc", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = CreateLxcSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const result = await callRunner("lxc_create", lxcPayloadWithRepos(parsed.data));
  db.prepare("INSERT INTO lxc_containers (container_name, user_id, description, node_name) VALUES (?, NULL, ?, ?)")
    .run(parsed.data.name, parsed.data.description ?? null, getLocalNodeName());
  return result;
});

app.post("/api/internal/docker/containers", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = RunDockerSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const dockerPayload = await prepareDockerRunPayload(parsed.data);
  const result = await callRunner<{ ok: boolean; id: string }>("docker_run", dockerPayload);
  db.prepare("INSERT OR IGNORE INTO docker_containers (container_id, container_name, image, user_id, node_name) VALUES (?, ?, ?, NULL, ?)")
    .run(result.id, parsed.data.name, parsed.data.image, getLocalNodeName());
  await syncFirewallState();
  return result;
});

app.get("/api/internal/vms", async (req, reply) => {
  requireInternalNodeToken(req);
  const systemVms = await callRunner<unknown[]>("qemu_vms");
  const dbVms = db.prepare("SELECT * FROM qemu_vms").all() as Array<{ vm_name: string; user_id: number | null; description: string | null; tags: string }>;
  const vmMeta = new Map(dbVms.map((v) => [v.vm_name, v]));
  return systemVms.map((vm: unknown) => {
    const v = vm as Record<string, unknown>;
    const meta = vmMeta.get(v.name as string);
    return { ...v, userId: meta?.user_id ?? undefined, description: meta?.description, tags: meta ? JSON.parse(meta.tags) : [] };
  });
});

app.get("/api/internal/vms/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const info = await callRunner("qemu_info", { name });
  const meta = db.prepare("SELECT * FROM qemu_vms WHERE vm_name = ?").get(name) as { user_id: number | null; description: string | null; tags: string } | undefined;
  return { ...info as object, userId: meta?.user_id ?? undefined, description: meta?.description, tags: meta ? JSON.parse(meta.tags) : [] };
});

app.get("/api/internal/vms/:name/stats", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("qemu_stats", req.params);
});

app.get("/api/internal/vms/:name/logs", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  return { logs: await callRunner("qemu_logs", { name, tail }) };
});

app.post("/api/internal/vms/:name/console-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const ticket = issueWsTicket("vm-console", 0, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.post("/api/internal/vms/:name/vnc-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const ticket = issueWsTicket("vm-vnc", 0, name);
  const vnc = await callRunner<VmVncPasswordInfo>("qemu_vnc_password", { name });
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/vnc", ticket.id), password: vnc.password };
});

app.get("/api/internal/vms/:name/vnc-password", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("qemu_vnc_password", { name });
});

app.post("/api/internal/vms/:name/spice-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const info = await callRunner<SpiceConsoleInfo>("qemu_ensure_spice", { name });
  const port = info.spicePort ?? info.spiceTlsPort;
  if (!info.enabled || !info.active || !port || info.requiresRestart) {
    return reply.status(409).send({
      error: info.requiresRestart
        ? "SPICE enabled but VM restart required"
        : info.requiresStart
          ? "SPICE console requires a running VM"
          : "SPICE console is not active",
      requiresRestart: !!info.requiresRestart,
      requiresStart: !!info.requiresStart,
    });
  }
  const ticket = issueWsTicket("vm-spice", 0, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/spice", ticket.id), password: info.spicePassword };
});

app.get("/api/internal/vms/:name/rdp-info", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("qemu_rdp_console_info", { name });
});

app.post("/api/internal/vms/:name/rdp-prepare", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const result = await callRunner<VmRdpConsoleInfo>("qemu_rdp_prepare", { name });
  await ensureVmRdpFirewallRule(name, result.xrdpPort, null);
  await syncFirewallState();
  return result;
});

app.get("/api/internal/vms/:name/snapshots", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  await syncSnapshotsForResource("vm", name);
  return callRunner("qemu_snapshot_list", { name });
});

app.post("/api/internal/vms/:name/snapshot/create", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = CreateSnapshotSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const result = await callRunner("qemu_snapshot_create", { name, snapName: parsed.data.name, description: parsed.data.description }, 15 * 60_000);
  db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('vm', ?, ?, ?, NULL)")
    .run(name, parsed.data.name, parsed.data.description ?? null);
  return result;
});

app.post("/api/internal/vms/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, snap } = req.params as { name: string; snap: string };
  return callRunner("qemu_snapshot_rollback", { name, snapName: snap }, 15 * 60_000);
});

app.delete("/api/internal/vms/:name/snapshot/:snap", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, snap } = req.params as { name: string; snap: string };
  await callRunner("qemu_snapshot_delete", { name, snapName: snap }, 15 * 60_000);
  db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ? AND snapshot_name = ?").run(name, snap);
  return { ok: true };
});

app.post("/api/internal/vms/:name/backup", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = BackupVmSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(parsed.data.storagePool) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
  const filename = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.${parsed.data.format === "tar.gz" ? "tar.zst" : "qcow2"}`;
  const result = await callRunner<{ ok: boolean; filename: string; sizeBytes: number }>("qemu_backup", {
    name,
    ...parsed.data,
    storagePool: pool.path,
    filename,
  }, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT INTO backups (resource_type, resource_name, filename, storage_pool, size_bytes, format, created_by) VALUES ('vm', ?, ?, ?, ?, ?, NULL)")
    .run(name, result.filename, parsed.data.storagePool, result.sizeBytes, parsed.data.format);
  return result;
});

app.put("/api/internal/vms/:name/config", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UpdateVmConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (
    parsed.data.vcpus !== undefined ||
    parsed.data.memoryMb !== undefined ||
    parsed.data.autostart !== undefined ||
    parsed.data.uefi !== undefined ||
    parsed.data.secureBoot !== undefined ||
    parsed.data.bootDevice !== undefined ||
    parsed.data.tpmEnabled !== undefined ||
    parsed.data.qemuAgentEnabled !== undefined ||
    parsed.data.videoModel !== undefined
  ) {
    await callRunner("qemu_update_config", { name, ...parsed.data });
  }
  if (parsed.data.description !== undefined || parsed.data.tags !== undefined) {
    db.prepare("UPDATE qemu_vms SET description = COALESCE(?, description), tags = COALESCE(?, tags) WHERE vm_name = ?")
      .run(parsed.data.description ?? null, parsed.data.tags ? JSON.stringify(parsed.data.tags) : null, name);
  }
  return { ok: true };
});

app.post("/api/internal/vms/:name/restore-backup", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { sourcePath, storagePool, ...rest } = req.body as { sourcePath: string; storagePool: string; [key: string]: unknown };
  if (!sourcePath || !storagePool) return reply.status(400).send({ error: "sourcePath and storagePool required" });
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
  const poolPath = pool?.path ?? storagePool; // accept either pool name or direct path
  const result = await callRunner("qemu_restore_backup", { name, sourcePath, storagePool: poolPath, ...rest }, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT OR IGNORE INTO qemu_vms (vm_name) VALUES (?)").run(name);
  return result;
});

app.post("/api/internal/vms/:name/iso/attach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { isoPath, isoFile } = req.body as { isoPath?: string; isoFile?: string };
  const resolvedPath = isoPath ? await resolveManagedIsoPath(isoPath) : isoFile ? await resolveManagedIsoPath(isoFile) : undefined;
  if (!resolvedPath) return reply.status(400).send({ error: "ISO file is required" });
  return callRunner("qemu_attach_iso", { name, isoPath: resolvedPath });
});

app.post("/api/internal/vms/:name/iso/eject", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("qemu_eject_iso", { name });
});

app.post("/api/internal/vms/:name/usb/attach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("qemu_usb_attach", { name, ...parsed.data });
});

app.post("/api/internal/vms/:name/usb/detach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("qemu_usb_detach", { name, ...parsed.data });
});

app.post("/api/internal/vms/:name/clone", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { newName } = req.body as { newName: string };
  if (!newName) return reply.status(400).send({ error: "newName required" });
  const result = await callRunner("qemu_clone", { name, newName }, 10 * 60_000);
  db.prepare("INSERT OR IGNORE INTO qemu_vms (vm_name) VALUES (?)").run(newName);
  return result;
});

app.post("/api/internal/vms/:name/repair-disk", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("qemu_repair_disk", { name }, 5 * 60_000);
});

const QEMU_ACTION_ALLOWLIST = new Set(["start", "stop", "forceStop", "reboot", "pause", "resume", "reset", "shutdown", "suspend"]);
const LXC_ACTION_ALLOWLIST = new Set(["start", "stop", "restart", "freeze", "unfreeze", "reboot", "pause", "resume"]);
const DOCKER_ACTION_ALLOWLIST = new Set(["start", "stop", "restart", "pause", "unpause", "kill"]);

app.post("/api/internal/vms/:name/:action", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, action } = req.params as { name: string; action: string };
  if (!QEMU_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid VM action. Allowed: ${[...QEMU_ACTION_ALLOWLIST].join(", ")}` });
  return runQemuAction(name, action);
});

app.delete("/api/internal/vms/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { deleteDisks = true } = req.query as { deleteDisks?: boolean };
  await callRunner("qemu_delete", { name, deleteDisks });
  db.prepare("DELETE FROM qemu_vms WHERE vm_name = ?").run(name);
  db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ?").run(name);
  db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'vm' AND resource_name = ?").run(name);
  db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'vm' AND linked_resource_name = ?").run(name);
  await syncFirewallState();
  return { ok: true };
});

app.get("/api/internal/lxc", async (req, reply) => {
  requireInternalNodeToken(req);
  const containers = await callRunner<unknown[]>("lxc_containers");
  const dbRows = db.prepare("SELECT * FROM lxc_containers").all() as Array<{ container_name: string; user_id: number | null; description: string | null }>;
  const meta = new Map(dbRows.map((r) => [r.container_name, r]));
  return containers.map((c: unknown) => {
    const ct = c as Record<string, unknown>;
    const m = meta.get(ct.name as string);
    return { ...ct, userId: m?.user_id ?? undefined, description: m?.description };
  });
});

app.get("/api/internal/lxc/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("lxc_info", req.params);
});

app.get("/api/internal/lxc/:name/stats", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("lxc_stats", req.params);
});

app.get("/api/internal/lxc/:name/logs", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  return { logs: await callRunner("lxc_logs", { name, tail }) };
});

app.post("/api/internal/lxc/:name/console-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const ticket = issueWsTicket("lxc-console", 0, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.get("/api/internal/lxc/:name/snapshots", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  await syncSnapshotsForResource("lxc", name);
  return callRunner("lxc_snapshot_list", { name });
});

app.post("/api/internal/lxc/:name/snapshot/create", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { snapName: snapNameRaw, description } = req.body as { snapName?: string; description?: string };
  const snapName = normalizeLxcSnapshotName(snapNameRaw);
  if (!snapName) return reply.status(400).send({ error: LXC_SNAPSHOT_NAME_ERROR });
  const result = await callRunner("lxc_snapshot_create", { name, snapName, description });
  db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('lxc', ?, ?, ?, NULL)")
    .run(name, snapName, description ?? null);
  return result;
});

app.post("/api/internal/lxc/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, snap } = req.params as { name: string; snap: string };
  return callRunner("lxc_snapshot_rollback", { name, snapName: snap });
});

app.delete("/api/internal/lxc/:name/snapshot/:snap", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, snap } = req.params as { name: string; snap: string };
  await callRunner("lxc_snapshot_delete", { name, snapName: snap });
  db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ? AND snapshot_name = ?").run(name, snap);
  return { ok: true };
});

app.post("/api/internal/lxc/:name/backup", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = BackupLxcSchema.safeParse({ format: "tar.gz", ...((req.body as Record<string, unknown>) ?? {}) });
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(parsed.data.storagePool) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
  const filename = `lxc-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.zst`;
  const result = await callRunner<{ ok: boolean; filename: string; sizeBytes: number }>("lxc_backup", {
    name,
    ...parsed.data,
    storagePool: pool.path,
    filename,
  }, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT INTO backups (resource_type, resource_name, filename, storage_pool, size_bytes, format, created_by) VALUES ('lxc', ?, ?, ?, ?, ?, NULL)")
    .run(name, result.filename, parsed.data.storagePool, result.sizeBytes, parsed.data.format);
  return result;
});

app.put("/api/internal/lxc/:name/config", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UpdateLxcConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  let lxcForwardTargetIp: string | undefined;
  if (parsed.data.portForwards) {
    const info = await callRunner<{ ipAddress?: string }>("lxc_info", { name }).catch(() => ({ ipAddress: undefined }));
    lxcForwardTargetIp = (parsed.data.ipv4 && parsed.data.ipv4 !== "dhcp" ? parsed.data.ipv4 : info.ipAddress)?.split("/")[0];
    if (!lxcForwardTargetIp) {
      return reply.status(400).send({ error: "LXC port forwards require a known container IPv4 address" });
    }
  }
  const result = await callRunner("lxc_update_config", { name, ...parsed.data });
  if (parsed.data.portForwards) {
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ? AND relation LIKE 'LXC port %'").run(name);
    const insert = db.prepare(`
      INSERT INTO firewall_rules (
        enabled, source_kind, rule_type, protocol, host_port, target_ip, target_port,
        description, linked_resource_type, linked_resource_name, relation, created_by, updated_at
      ) VALUES (1, 'manual', 'forward', ?, ?, ?, ?, ?, 'lxc', ?, ?, NULL, datetime('now'))
    `);
    for (const forward of parsed.data.portForwards) {
      insert.run(
        forward.protocol,
        forward.hostPort,
        lxcForwardTargetIp,
        forward.containerPort,
        `LXC ${name} port forward`,
        name,
        `LXC port ${forward.hostPort} -> ${forward.containerPort}`,
      );
    }
    await syncFirewallState();
  }
  return result;
});

app.post("/api/internal/lxc/:name/usb/attach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_usb_attach", { name, ...parsed.data });
});

app.post("/api/internal/lxc/:name/usb/detach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_usb_detach", { name, ...parsed.data });
});

app.post("/api/internal/lxc/:name/gpu/attach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = GpuDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_gpu_attach", { name, ...parsed.data });
});

app.post("/api/internal/lxc/:name/gpu/detach", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = GpuDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_gpu_detach", { name, ...parsed.data });
});

// Internal LXC multi-NIC (called by the primary node for remote containers).
app.get("/api/internal/lxc/:name/networks", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("lxc_net_list", { name });
});
app.post("/api/internal/lxc/:name/networks", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = LxcNicSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_net_add", { name, ...parsed.data });
});
app.put("/api/internal/lxc/:name/networks/:index", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, index } = req.params as { name: string; index: string };
  const parsed = LxcNicSchema.partial().safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("lxc_net_update", { name, index: parseInt(index, 10), ...parsed.data });
});
app.delete("/api/internal/lxc/:name/networks/:index", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, index } = req.params as { name: string; index: string };
  return callRunner("lxc_net_delete", { name, index: parseInt(index, 10) });
});

app.post("/api/internal/lxc/:name/restore-backup", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { sourcePath, ...rest } = req.body as { sourcePath: string; [key: string]: unknown };
  if (!sourcePath) return reply.status(400).send({ error: "sourcePath required" });
  const result = await callRunner("lxc_restore_backup", { name, sourcePath, ...rest }, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT OR IGNORE INTO lxc_containers (container_name) VALUES (?)").run(name);
  return result;
});

app.post("/api/internal/lxc/:name/:action", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name, action } = req.params as { name: string; action: string };
  if (!LXC_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid LXC action. Allowed: ${[...LXC_ACTION_ALLOWLIST].join(", ")}` });
  return callRunner("lxc_action", { name, action });
});

app.delete("/api/internal/lxc/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  await callRunner("lxc_delete", { name });
  db.prepare("DELETE FROM lxc_containers WHERE container_name = ?").run(name);
  db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ?").run(name);
  db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'lxc' AND resource_name = ?").run(name);
  db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ?").run(name);
  await syncFirewallState();
  return { ok: true };
});

app.get("/api/internal/docker/containers", async (req, reply) => {
  requireInternalNodeToken(req);
  const containers = await callRunner<unknown[]>("docker_containers");
  const dbRows = db.prepare("SELECT * FROM docker_containers").all() as Array<{ container_id: string; user_id: number | null }>;
  return containers.map((c: unknown) => {
    const ct = c as Record<string, unknown>;
    const dockerId = ct.id as string;
    const m = dbRows.find((row) => row.container_id === dockerId || row.container_id.startsWith(dockerId) || dockerId.startsWith(row.container_id));
    return { ...ct, userId: m?.user_id ?? undefined };
  });
});

app.get("/api/internal/docker/containers/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_inspect", req.params);
});

app.get("/api/internal/docker/containers/:id/stats", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_stats", req.params);
});

app.get("/api/internal/docker/containers/:id/logs", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  return { logs: await callRunner("docker_logs", { id, tail }) };
});

app.post("/api/internal/docker/containers/:id/console-ticket", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const ticket = issueWsTicket("docker-console", 0, id);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.post("/api/internal/docker/containers/:id/exec", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const parsed = DockerExecSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_exec", { id, ...parsed.data });
});

app.put("/api/internal/docker/containers/:id/config", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const parsed = UpdateDockerConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_update_config", { id, ...parsed.data });
});

app.put("/api/internal/docker/containers/:id/recreate", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const parsed = RecreateDockerSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_recreate", { id, ...parsed.data });
});

app.get("/api/internal/docker/containers/:id/details", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_inspect", req.params);
});

app.post("/api/internal/docker/containers/:id/migration-export", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const { storagePool, targetName } = req.body as { storagePool?: string; targetName?: string };
  if (!storagePool || !targetName) return reply.status(400).send({ error: "storagePool and targetName are required" });
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
  const filename = sanitizeManagedFilename(`docker-${targetName}-${randomUUID()}.tar`);
  const archivePath = path.join(pool.path, "backups", filename);
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
  return callRunner("docker_migration_export", { id, targetName, archivePath }, BACKUP_TIMEOUT_MS);
});

app.post("/api/internal/docker/migration-import", async (req, reply) => {
  requireInternalNodeToken(req);
  const { storagePool, filename, imageRef, manifest } = req.body as { storagePool?: string; filename?: string; imageRef?: string; manifest?: Record<string, unknown> };
  if (!storagePool || !filename || !imageRef || !manifest) return reply.status(400).send({ error: "storagePool, filename, imageRef and manifest are required" });
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
  const archivePath = path.join(pool.path, "backups", sanitizeManagedFilename(filename));
  const result = await callRunner<{ ok: boolean; id: string; name: string }>("docker_migration_import", { archivePath, imageRef, manifest }, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT OR IGNORE INTO docker_containers (container_id, container_name, image, user_id, node_name) VALUES (?, ?, ?, NULL, ?)")
    .run(result.id, result.name, imageRef, getLocalNodeName());
  await syncFirewallState();
  return result;
});

// Internal Docker multi-NIC (called by the primary node for remote containers).
app.get("/api/internal/docker/containers/:id/networks", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_container_networks", { id: (req.params as { id: string }).id });
});
app.post("/api/internal/docker/containers/:id/networks", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  const parsed = DockerConnectNetworkSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_network_connect", { id, ...parsed.data });
});
app.delete("/api/internal/docker/containers/:id/networks/:network", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id, network } = req.params as { id: string; network: string };
  return callRunner("docker_network_disconnect", { id, network });
});

app.post("/api/internal/docker/containers/:id/:action", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id, action } = req.params as { id: string; action: string };
  if (!DOCKER_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid Docker action. Allowed: ${[...DOCKER_ACTION_ALLOWLIST].join(", ")}` });
  const result = await callRunner("docker_action", { id, action });
  await syncFirewallState();
  return result;
});

app.delete("/api/internal/docker/containers/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  const { id } = req.params as { id: string };
  await callRunner("docker_delete", { id });
  db.prepare("DELETE FROM docker_containers WHERE container_id = ?").run(id);
  db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'docker' AND resource_name = ?").run(id);
  db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'docker' AND linked_resource_name = ?").run(id);
  await syncFirewallState();
  return { ok: true };
});

// ── Internal Docker Compose (persistent .yml) — called by the primary node for remote nodes ──
app.get("/api/internal/docker/compose", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_compose_list");
});

app.post("/api/internal/docker/compose", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = ComposeProjectSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (!parsed.data.composeYaml) return reply.status(400).send({ error: "composeYaml is required" });
  return callRunner("docker_compose_save", parsed.data, 60_000);
});

app.get("/api/internal/docker/compose/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_config", { name });
});

app.put("/api/internal/docker/compose/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const parsed = ComposeProjectSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (!parsed.data.composeYaml) return reply.status(400).send({ error: "composeYaml is required" });
  return callRunner("docker_compose_save", { name, composeYaml: parsed.data.composeYaml }, 60_000);
});

app.delete("/api/internal/docker/compose/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_delete", { name }, 120_000);
});

app.post("/api/internal/docker/compose/:name/up", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_up", { name }, 300_000);
});

app.post("/api/internal/docker/compose/:name/down", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { removeVolumes } = (req.body ?? {}) as { removeVolumes?: boolean };
  return callRunner("docker_compose_down", { name, removeVolumes }, 300_000);
});

app.post("/api/internal/docker/compose/:name/restart", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { service } = (req.body ?? {}) as { service?: string };
  return callRunner("docker_compose_restart", { name, service }, 120_000);
});

app.get("/api/internal/docker/compose/:name/ps", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_ps", { name });
});

app.get("/api/internal/docker/compose/:name/logs", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  const { tail = 100, service } = req.query as { tail?: number; service?: string };
  return { logs: await callRunner("docker_compose_logs", { name, tail, service }) };
});

// ── Internal Docker volumes ──
app.get("/api/internal/docker/volumes", async (req, reply) => {
  requireInternalNodeToken(req);
  return callRunner("docker_volumes");
});

app.post("/api/internal/docker/volumes", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = DockerVolumeCreateSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_volume_create", parsed.data);
});

app.delete("/api/internal/docker/volumes/:name", async (req, reply) => {
  requireInternalNodeToken(req);
  const { name } = req.params as { name: string };
  return callRunner("docker_volume_delete", { id: name });
});

// ── Internal Docker prune ──
app.post("/api/internal/docker/prune", async (req, reply) => {
  requireInternalNodeToken(req);
  const parsed = DockerPruneSchema.safeParse(req.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_prune", parsed.data);
});

app.get("/api/internal/backups", async (req, reply) => {
  requireInternalNodeToken(req);
  const { resourceType, resourceName } = req.query as { resourceType?: string; resourceName?: string };
  return listLocalBackupRows(resourceType, resourceName).map((row) => mapBackupRow(row, getLocalNodeName()));
});

app.get("/api/internal/backups/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  const id = Number.parseInt((req.params as { id: string }).id, 10);
  const row = getBackupRow(id);
  if (!row) return reply.status(404).send({ error: "Backup not found" });
  return mapBackupRow(row, getLocalNodeName());
});

app.delete("/api/internal/backups/:id", async (req, reply) => {
  requireInternalNodeToken(req);
  const id = Number.parseInt((req.params as { id: string }).id, 10);
  const backup = getBackupRow(id);
  if (!backup) return reply.status(404).send({ error: "Backup not found" });
  const { fullPath } = resolveBackupPath(backup);
  await fs.promises.unlink(fullPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  db.prepare("DELETE FROM backups WHERE id = ?").run(backup.id);
  return { ok: true };
});

app.post("/api/internal/backups/:id/restore", async (req, reply) => {
  requireInternalNodeToken(req);
  const id = Number.parseInt((req.params as { id: string }).id, 10);
  const backup = getBackupRow(id);
  if (!backup) return reply.status(404).send({ error: "Backup not found" });
  const payload = (req.body as Record<string, unknown> | undefined) ?? {};
  const { fullPath } = resolveBackupPath(backup);
  if (backup.resource_type === "vm") {
    const name = String(payload.name ?? "").trim();
    const storagePool = String(payload.storagePool ?? backup.storage_pool).trim();
    if (!name) return reply.status(400).send({ error: "VM name is required" });
    const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
    if (!pool) return reply.status(404).send({ error: "Storage pool not found" });
    const vmRestoreParams: Record<string, unknown> = {
      sourcePath: fullPath,
      storagePool: pool.path,
      name,
      bridge: payload.bridge ?? "virbr0",
      mac: payload.mac,
      arch: payload.arch ?? "x86_64",
      machine: payload.machine ?? "q35",
      uefi: payload.uefi ?? false,
      bootDevice: payload.bootDevice ?? "hd",
      videoModel: payload.videoModel ?? "virtio",
      autostart: payload.autostart ?? false,
    };
    if (typeof payload.vcpus === "number") vmRestoreParams.vcpus = payload.vcpus;
    if (typeof payload.memoryMb === "number") vmRestoreParams.memoryMb = payload.memoryMb;
    const result = await callRunner("qemu_restore_backup", vmRestoreParams, BACKUP_TIMEOUT_MS);
    db.prepare("INSERT OR IGNORE INTO qemu_vms (vm_name, user_id, node_name) VALUES (?, NULL, ?)").run(name, getLocalNodeName());
    return result;
  }
  const name = String(payload.name ?? "").trim();
  if (!name) return reply.status(400).send({ error: "Container name is required" });
  const lxcRestoreParams: Record<string, unknown> = {
    sourcePath: fullPath,
    name,
    bridge: payload.bridge ?? "lxcbr0",
    macAddress: payload.macAddress,
    ipv4: payload.ipv4,
    ipv4Gateway: payload.ipv4Gateway,
    dnsServers: Array.isArray(payload.dnsServers) ? payload.dnsServers : [],
    autostart: payload.autostart ?? false,
  };
  if (typeof payload.cpuCores === "number") lxcRestoreParams.cpuCores = payload.cpuCores;
  if (typeof payload.memoryMb === "number") lxcRestoreParams.memoryMb = payload.memoryMb;
  const result = await callRunner("lxc_restore_backup", lxcRestoreParams, BACKUP_TIMEOUT_MS);
  db.prepare("INSERT OR IGNORE INTO lxc_containers (container_name, user_id, description, node_name) VALUES (?, NULL, NULL, ?)").run(name, getLocalNodeName());
  return result;
});

app.get("/api/nodes", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const nodes = listDatacenterNodes();
  if (req.session.role === "ADMIN") return nodes;
  const resources = getAccessibleResources(req.session.userId!, req.session.role!);
  const limits = getUserLimitsState(req.session.userId!, req.session.role!);
  const allowedNodeNames = new Set([
    ...resources.vms.map((entry) => entry.nodeName),
    ...resources.lxc.map((entry) => entry.nodeName),
    ...resources.docker.map((entry) => entry.nodeName),
  ]);
  if (limits.allowVmCreate || limits.allowLxcCreate || limits.allowDockerCreate) {
    allowedNodeNames.add(getLocalNodeName());
  }
  return nodes.filter((node) => allowedNodeNames.has(node.name));
});

app.post("/api/nodes", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = CreateDatacenterNodeSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

  const name = parsed.data.name.trim();
  db.prepare(`
    INSERT INTO datacenter_nodes (name, display_name, role, api_url, enabled, is_local, notes)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(
    name,
    parsed.data.displayName?.trim() || null,
    parsed.data.role,
    parsed.data.apiUrl?.trim() || null,
    parsed.data.enabled ? 1 : 0,
    parsed.data.notes?.trim() || null,
  );

  return { ok: true, node: listDatacenterNodes().find((node) => node.name === name) };
});

app.get("/api/nodes/:name", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (req.session.role !== "ADMIN") {
    const resources = getAccessibleResources(req.session.userId!, req.session.role!);
    const limits = getUserLimitsState(req.session.userId!, req.session.role!);
    const allowedNodeNames = new Set([
      ...resources.vms.map((entry) => entry.nodeName),
      ...resources.lxc.map((entry) => entry.nodeName),
      ...resources.docker.map((entry) => entry.nodeName),
    ]);
    if (limits.allowVmCreate || limits.allowLxcCreate || limits.allowDockerCreate) {
      allowedNodeNames.add(getLocalNodeName());
    }
    if (!allowedNodeNames.has(name)) {
      return reply.status(403).send({ error: "Forbidden" });
    }
  }
  return buildNodeSummary(node);
});

app.get("/api/nodes/:name/system/info", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  return node.isLocal ? callRunner("system_info") : fetchRemoteNode(node, "/api/internal/system/info");
});

app.get("/api/nodes/:name/system/services", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  return node.isLocal ? callRunner("system_services") : fetchRemoteNode(node, "/api/internal/system/services");
});

app.get("/api/nodes/:name/system/updates", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  return node.isLocal ? callRunner("system_updates") : fetchRemoteNode(node, "/api/internal/system/updates");
});

app.get("/api/nodes/:name/settings", async (req, reply) => {
  requireUiSection(req, "settings");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  return fetchRemoteNode(node, "/api/internal/settings");
});

app.put("/api/nodes/:name/settings", async (req, reply) => {
  requireUiSection(req, "settings");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  const settings = req.body as Record<string, string>;
  if (node.isLocal) {
    for (const [key, value] of Object.entries(settings)) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    }
    return { ok: true };
  }
  return fetchRemoteNode(node, "/api/internal/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
});

app.post("/api/nodes/:name/host/console-ticket", async (req, reply) => {
  requireUiSection(req, "datacenter");
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  const { initialCommand } = (req.body as { initialCommand?: string } | undefined) ?? {};
  if (node.isLocal) {
    const ticket = issueWsTicket("host", req.session.userId!, undefined, initialCommand);
    return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
  }
  const ticket = issueWsTicket("remote-host", req.session.userId!, node.name, initialCommand);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.get("/api/nodes/:name/storage/pools", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    ensureBuiltinStoragePools();
    const pools = db.prepare("SELECT * FROM storage_pools WHERE enabled = 1").all() as Array<{
      id: number;
      name: string;
      path: string;
      type: string;
      content: string;
      total_bytes: number;
      used_bytes: number;
      mount_source: string | null;
      fstype: string | null;
      mount_options: string | null;
    }>;
    return Promise.all(pools.map(async (pool) => {
      try {
        const df = await callRunner<{ totalBytes: number; usedBytes: number; freeBytes: number }>("storage_pool_df", { path: pool.path });
        return {
          ...pool,
          content: JSON.parse(pool.content),
          totalBytes: df.totalBytes,
          usedBytes: df.usedBytes,
          freeBytes: df.freeBytes,
          mountSource: pool.mount_source ?? undefined,
          mountOptions: pool.mount_options ?? undefined,
        };
      } catch {
        return {
          ...pool,
          content: JSON.parse(pool.content),
          totalBytes: pool.total_bytes,
          usedBytes: pool.used_bytes,
          freeBytes: 0,
          mountSource: pool.mount_source ?? undefined,
          mountOptions: pool.mount_options ?? undefined,
        };
      }
    }));
  }
  return fetchRemoteNode(node, "/api/internal/storage/pools");
});

app.get("/api/nodes/:name/storage/pools/:poolName", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name, poolName } = req.params as { name: string; poolName: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    const pool = db.prepare("SELECT * FROM storage_pools WHERE name = ?").get(poolName) as {
      path: string;
      type: string;
      content: string;
      mount_source: string | null;
      fstype: string | null;
      mount_options: string | null;
      enabled?: number;
    } | undefined;
    if (!pool) return reply.status(404).send({ error: "Pool not found" });
    const df = await callRunner("storage_pool_df", { path: pool.path });
    return {
      ...pool,
      name: poolName,
      content: JSON.parse(pool.content),
      mountSource: pool.mount_source ?? undefined,
      mountOptions: pool.mount_options ?? undefined,
      enabled: pool.enabled !== 0,
      ...df as object,
    };
  }
  return fetchRemoteNode(node, `/api/internal/storage/pools/${encodeURIComponent(poolName)}`);
});

app.get("/api/nodes/:name/storage/pools/:poolName/content", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name, poolName } = req.params as { name: string; poolName: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(poolName) as { path: string } | undefined;
    if (!pool) return reply.status(404).send({ error: "Pool not found" });
    await reconcileSnapshotMetadata();
    return listPoolContent(poolName, pool.path);
  }
  return fetchRemoteNode(node, `/api/internal/storage/pools/${encodeURIComponent(poolName)}/content`);
});

app.get("/api/nodes/:name/storage/pools/:poolName/content/download", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name, poolName } = req.params as { name: string; poolName: string };
  const { itemPath } = req.query as { itemPath?: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
  if (node.isLocal) {
    const { item } = await resolvePoolContentItem(poolName, itemPath);
    if (item.synthetic) return reply.status(400).send({ error: "Synthetic entries cannot be downloaded" });
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${path.basename(item.name).replace(/"/g, "")}"`);
    return reply.send(fs.createReadStream(item.path));
  }
  return reply.status(501).send({ error: "Remote pool download is not available yet through the primary node" });
});

app.post("/api/nodes/:name/storage/pools/:poolName/content/delete", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name, poolName } = req.params as { name: string; poolName: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    const { itemPath } = (req.body as { itemPath?: string }) ?? {};
    if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
    const { item } = await resolvePoolContentItem(poolName, itemPath);
    return deletePoolContentItem(poolName, item);
  }
  return fetchRemoteNode(node, `/api/internal/storage/pools/${encodeURIComponent(poolName)}/content/delete`, {
    method: "POST",
    body: JSON.stringify(req.body ?? {}),
  });
});

app.get("/api/nodes/:name/storage/isos", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  type ManagedIsoEntry = {
    filename: string;
    displayName?: string;
    type: "iso";
    sizeBytes: number;
    ownerId?: number;
    ownerUsername?: string;
    isPublic: boolean;
    storagePool?: string;
    createdAt?: string | null;
  };
  const toManagedIsoEntry = (entry: {
    filename: string;
    displayName?: string;
    sizeBytes: number;
    ownerId?: number;
    ownerUsername?: string;
    isPublic: boolean;
    storagePool?: string;
    createdAt?: string | null;
  }): ManagedIsoEntry => ({
    filename: entry.filename,
    displayName: entry.displayName,
    type: "iso",
    sizeBytes: entry.sizeBytes,
    ownerId: entry.ownerId,
    ownerUsername: entry.ownerUsername,
    isPublic: entry.isPublic,
    storagePool: entry.storagePool,
    createdAt: entry.createdAt,
  });
  const sharedPoolNames = new Set(listDatacenterStoragePoolRows().map((row) => row.name));
  const localSharedIsos: ManagedIsoEntry[] = (await listManagedFiles())
    .filter((entry) => entry.type === "iso")
    .map((entry) => toManagedIsoEntry(entry))
    .filter((entry) => !!entry.storagePool && sharedPoolNames.has(entry.storagePool));
  if (node.isLocal) {
    return (await listManagedFiles())
      .filter((entry) => entry.type === "iso")
      .map((entry) => toManagedIsoEntry(entry));
  }
  const remote = await fetchRemoteNode<ManagedIsoEntry[]>(node, "/api/internal/storage/isos");
  const merged = new Map<string, ManagedIsoEntry>();
  for (const entry of [...remote, ...localSharedIsos]) {
    merged.set(`${entry.type}:${entry.storagePool ?? "local"}:${entry.filename}`, entry);
  }
  return Array.from(merged.values()).sort((a, b) => a.filename.localeCompare(b.filename));
});

app.get("/api/nodes/:name/network/bridges", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    return callRunner("network_bridges_list");
  }
  return fetchRemoteNode(node, "/api/internal/network/bridges");
});

app.get("/api/nodes/:name/lxc/templates", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    return callRunner("lxc_templates", { refresh: false });
  }
  return fetchRemoteNode(node, "/api/internal/lxc/templates");
});

app.get("/api/nodes/:name/docker/images", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const node = listDatacenterNodes().find((entry) => entry.name === name);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  if (node.isLocal) {
    return callRunner("docker_images");
  }
  return fetchRemoteNode(node, "/api/internal/docker/images");
});

app.put("/api/nodes/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const parsed = UpdateDatacenterNodeSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const existing = listDatacenterNodes().find((entry) => entry.name === name);
  if (!existing) return reply.status(404).send({ error: "Node not found" });
  if (existing.isLocal && parsed.data.role === "secondary") {
    return reply.status(400).send({ error: "The local node must remain primary" });
  }

  db.prepare(`
    UPDATE datacenter_nodes
    SET display_name = ?, role = ?, api_url = ?, enabled = ?, notes = ?, updated_at = datetime('now')
    WHERE name = ?
  `).run(
    parsed.data.displayName?.trim() || null,
    parsed.data.role,
    parsed.data.apiUrl?.trim() || null,
    parsed.data.enabled ? 1 : 0,
    parsed.data.notes?.trim() || null,
    name,
  );

  const config = getDatacenterConfig();
  if (config.primaryNodeName === name && parsed.data.role !== "primary") {
    const fallbackPrimary = listDatacenterNodes().find((entry) => entry.name === name)?.isLocal ? getLocalNodeName() : getLocalNodeName();
    setDatacenterConfig({ ...config, primaryNodeName: fallbackPrimary });
  }

  return { ok: true, node: listDatacenterNodes().find((entry) => entry.name === name) };
});

app.delete("/api/nodes/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const existing = listDatacenterNodes().find((entry) => entry.name === name);
  if (!existing) return reply.status(404).send({ error: "Node not found" });
  if (existing.isLocal) return reply.status(400).send({ error: "The local node cannot be removed" });

  const hasResources =
    (db.prepare("SELECT COUNT(*) AS count FROM qemu_vms WHERE COALESCE(node_name, ?) = ?").get(getLocalNodeName(), name) as { count: number }).count > 0 ||
    (db.prepare("SELECT COUNT(*) AS count FROM lxc_containers WHERE COALESCE(node_name, ?) = ?").get(getLocalNodeName(), name) as { count: number }).count > 0 ||
    (db.prepare("SELECT COUNT(*) AS count FROM docker_containers WHERE COALESCE(node_name, ?) = ?").get(getLocalNodeName(), name) as { count: number }).count > 0;
  if (hasResources) return reply.status(400).send({ error: "This node still contains resources" });

  db.prepare("DELETE FROM datacenter_nodes WHERE name = ?").run(name);
  return { ok: true };
});

app.post("/api/system/host/console-ticket", async (req, reply) => {
  requireUiSection(req, "hostShell");
  const { initialCommand } = (req.body as { initialCommand?: string } | undefined) ?? {};
  const ticket = issueWsTicket("host", req.session.userId!, undefined, initialCommand);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.get("/api/system/services", async (req, reply) => {
  requireUiSection(req, "health");
  return callRunner("system_services");
});

app.get("/api/system/updates", async (req, reply) => {
  requireUiSection(req, "health");
  return callRunner("system_updates");
});

app.get("/api/system/reboot-safety", async (req, reply) => {
  requireAdmin(req, reply);
  return callRunner<RebootSafetyReport>("system_reboot_safety");
});

app.post("/api/system/reboot", async (req, reply) => {
  requireAdmin(req, reply);
  const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
  const safety = await callRunner<RebootSafetyReport>("system_reboot_safety");
  if (!force && !safety.ok) {
    return reply.status(409).send({
      error: "Reboot safety check failed",
      message: "Host reboot was blocked because remote access may not survive the reboot.",
      safety,
    });
  }
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "action",
    action: "system.reboot",
    label: "Reboot Host",
    resourceType: "host",
    resourceName: "srv",
    message: "Scheduling host reboot",
  });
  return runInstantTask(task, ip, () => callRunner("system_reboot", {}, 10_000));
});

app.post("/api/system/shutdown", async (req, reply) => {
  requireAdmin(req, reply);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "action",
    action: "system.shutdown",
    label: "Shutdown Host",
    resourceType: "host",
    resourceName: "srv",
    message: "Scheduling host shutdown",
  });
  return runInstantTask(task, ip, () => callRunner("system_shutdown", {}, 10_000));
});

app.get("/api/system/counts", async (req, reply) => {
  requireUiSection(req, "dashboard");
  const userId = req.session.userId!;
  const role = req.session.role!;

  const [systemVms, systemLxc, systemDocker] = await Promise.all([
    callRunner<Array<{ name: string; state: string }>>("qemu_vms").catch(() => []),
    callRunner<Array<{ name: string; state: string }>>("lxc_containers").catch(() => []),
    callRunner<Array<{ id: string; state: string }>>("docker_containers").catch(() => []),
  ]);

  const visibleVmNames = filterResourceNamesByPermission(userId, role, "vm", systemVms.map((vm) => vm.name));
  const visibleLxcNames = filterResourceNamesByPermission(userId, role, "lxc", systemLxc.map((ct) => ct.name));
  const visibleDockerIds = filterResourceNamesByPermission(userId, role, "docker", systemDocker.map((ct) => ct.id));
  const vmsTotal = visibleVmNames.size;
  const lxcTotal = visibleLxcNames.size;
  const dockerTotal = visibleDockerIds.size;

  const vmsRunning = systemVms.filter((vm) => visibleVmNames.has(vm.name) && vm.state === "running").length;
  const lxcRunning = systemLxc.filter((ct) => visibleLxcNames.has(ct.name) && ct.state === "running").length;
  const dockerRunning = systemDocker.filter((ct) => visibleDockerIds.has(ct.id) && ct.state === "running").length;

  const pools = db.prepare("SELECT * FROM storage_pools WHERE enabled = 1").all() as Array<{ total_bytes: number; used_bytes: number }>;
  const storageTotal = pools.reduce((a, p) => a + (p.total_bytes ?? 0), 0);
  const storageUsed = pools.reduce((a, p) => a + (p.used_bytes ?? 0), 0);

  return {
    vms: { total: vmsTotal, running: vmsRunning },
    lxc: { total: lxcTotal, running: lxcRunning },
    docker: { total: dockerTotal, running: dockerRunning },
    storagePoolsTotal: pools.length,
    storageUsedGb: Math.round(storageUsed / 1e9),
    storageTotalGb: Math.round(storageTotal / 1e9),
  };
});

app.get("/api/system/guests-overview", async (req, reply) => {
  requireUiSection(req, "dashboard");
  const userId = req.session.userId!;
  const role = req.session.role!;

  const visibleVm = (name: string) => hasResourcePermission(userId, role, "vm", name, "view");
  const visibleLxc = (name: string) => hasResourcePermission(userId, role, "lxc", name, "view");
  const visibleDocker = (id: string) => hasResourcePermission(userId, role, "docker", id, "view");

  const [vms, lxc, docker] = await Promise.all([
    callRunner<Array<{ name: string; state: string }>>("qemu_vms").catch(() => []),
    callRunner<Array<{ name: string; state: string }>>("lxc_containers").catch(() => []),
    callRunner<Array<{ id: string; name: string; state: string }>>("docker_containers").catch(() => []),
  ]);

  const vmOverview = await Promise.all(vms.filter((vm) => visibleVm(vm.name)).map(async (vm) => {
    const stats = await callRunner<{ cpuPercent?: number; memPercent?: number }>("qemu_stats", { name: vm.name }).catch((): { cpuPercent?: number; memPercent?: number } => ({}));
    return { name: vm.name, state: vm.state, cpuPercent: stats.cpuPercent ?? 0, memPercent: stats.memPercent ?? 0, type: "qemu" };
  }));

  const lxcOverview = await Promise.all(lxc.filter((ct) => visibleLxc(ct.name)).map(async (ct) => {
    const stats = await callRunner<{ cpuPercent?: number; memUsedBytes?: number; memTotalBytes?: number }>("lxc_stats", { name: ct.name }).catch((): { cpuPercent?: number; memUsedBytes?: number; memTotalBytes?: number } => ({}));
    const memPercent = stats.memTotalBytes ? Math.round(((stats.memUsedBytes ?? 0) / stats.memTotalBytes) * 100) : 0;
    return { name: ct.name, state: ct.state, cpuPercent: stats.cpuPercent ?? 0, memPercent, type: "lxc" };
  }));

  const dockerOverview = await Promise.all(docker.filter((ct) => visibleDocker(ct.id)).map(async (ct) => {
    const stats = await callRunner<{ cpuPercent?: number; memPercent?: number }>("docker_stats", { id: ct.id }).catch((): { cpuPercent?: number; memPercent?: number } => ({}));
    return { id: ct.id, name: ct.name, state: ct.state, cpuPercent: stats.cpuPercent ?? 0, memPercent: stats.memPercent ?? 0, type: "docker" };
  }));

  return { qemu: vmOverview, lxc: lxcOverview, docker: dockerOverview };
});

// Liveness: process is running. Always returns 200. Use for systemd / load balancer liveness probes.
app.get("/api/health", async () => ({ ok: true, version: APP_VERSION }));

app.get("/api/host/usb-devices", async (req, reply) => {
  requireAuth(req, reply);
  const nodeName = `${(req.query as { node?: string }).node ?? ""}`.trim();
  if (nodeName) {
    const node = listDatacenterNodes().find((entry) => entry.name === nodeName);
    if (!node || !node.enabled) return reply.status(404).send({ error: "Node not found" });
    return node.isLocal ? callRunner("system_usb_devices") : fetchRemoteNode(node, "/api/internal/host/usb-devices");
  }
  return callRunner("system_usb_devices");
});

app.get("/api/host/gpu-devices", async (req, reply) => {
  requireAuth(req, reply);
  const nodeName = `${(req.query as { node?: string }).node ?? ""}`.trim();
  if (nodeName) {
    const node = listDatacenterNodes().find((entry) => entry.name === nodeName);
    if (!node || !node.enabled) return reply.status(404).send({ error: "Node not found" });
    return node.isLocal ? callRunner("system_gpu_devices") : fetchRemoteNode(node, "/api/internal/host/gpu-devices");
  }
  return callRunner("system_gpu_devices");
});

// Readiness: checks dependencies (DB + runner socket). Returns 503 if anything fails.
// Use for monitoring dashboards or pre-traffic checks.
app.get("/api/health/ready", async (_req, reply) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  try {
    db.prepare("SELECT 1").get();
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await callRunner("system_ping", {}, 2000);
    checks.runner = { ok: true };
  } catch (err) {
    checks.runner = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return reply.status(ok ? 200 : 503).send({ ok, version: APP_VERSION, checks });
});

// ── QEMU VM Routes ─────────────────────────────────────────────────────────
app.get("/api/vms", async (req, reply) => {
  requireAuth(req, reply);
  const { scope } = req.query as { scope?: string };
  await reconcileResourceMetadata();
  const userId = req.session.userId!;
  const role = req.session.role!;
  const dbVms = db.prepare("SELECT * FROM qemu_vms").all() as Array<{ vm_name: string; user_id: number; description: string | null; tags: string }>;
  const vmMeta = new Map(dbVms.map((v) => [v.vm_name, v]));
  const nodes = enabledResourceNodes();
  const vmLists = await Promise.all(nodes.map(async (node) => {
    try {
      return node.isLocal ? await callRunner<unknown[]>("qemu_vms") : await fetchRemoteNode<unknown[]>(node, "/api/internal/vms");
    } catch {
      return [];
    }
  }));
  return vmLists.flat().map((vm: unknown) => {
    const v = vm as Record<string, unknown>;
    const meta = vmMeta.get(v.name as string);
    if (!hasResourcePermission(userId, role, "vm", v.name as string, "view")) return null;
    if (scope === "mine" && role !== "ADMIN" && meta?.user_id !== userId) return null;
    return { ...v, userId: meta?.user_id, description: meta?.description, tags: meta ? JSON.parse(meta.tags) : [] };
  }).filter(Boolean);
});

app.post("/api/vms", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = CreateVmSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const targetNodeName = `${(req.query as { node?: string }).node ?? ""}`.trim() || getLocalNodeName();
  const targetNode = listDatacenterNodes().find((entry) => entry.name === targetNodeName);
  if (!targetNode || !targetNode.enabled) return reply.status(404).send({ error: "Target node not found" });

  const quotaCheck = checkQuota(db, req.session.userId!, req.session.role!, "vms");
  if (!quotaCheck.ok) return replyQuotaError(reply, quotaCheck);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_create");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "vm.create", label: `Create VM ${parsed.data.name}`, resourceType: "vm", resourceName: parsed.data.name, message: "Creating virtual machine" });
  return runInstantTask(task, ip, async () => {
    let result: unknown;
    if (targetNode.isLocal) {
      result = await callRunner("qemu_create", await prepareVmCreatePayload(parsed.data));
    } else {
      result = await fetchRemoteNode(targetNode, "/api/internal/vms", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
    }
    db.prepare("INSERT INTO qemu_vms (vm_name, user_id, description, tags, node_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, tags = excluded.tags, node_name = excluded.node_name")
      .run(parsed.data.name, req.session.userId!, parsed.data.description ?? null, JSON.stringify(parsed.data.tags ?? []), targetNode.name);
    return result;
  });
});

app.get("/api/vms/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "view");
  const node = await getResourceNodeAsync("vm", name);
  const info = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}`)
    : await callRunner("qemu_info", { name });
  const meta = db.prepare("SELECT * FROM qemu_vms WHERE vm_name = ?").get(name) as { user_id: number; description: string | null; tags: string } | undefined;
  return {
    ...info as object,
    nodeName: node?.name ?? getLocalNodeName(),
    userId: meta?.user_id,
    description: meta?.description,
    tags: meta ? JSON.parse(meta.tags) : [],
  };
});

app.delete("/api/vms/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { deleteDisks = true } = req.query as { deleteDisks?: boolean };
  requireResourcePermission(req, "vm", name, "delete");

  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_delete");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "vm.delete", label: `Delete VM ${name}`, resourceType: "vm", resourceName: name, message: "Deleting virtual machine" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}?deleteDisks=${deleteDisks ? "true" : "false"}`, { method: "DELETE" });
    } else {
      await callRunner("qemu_delete", { name, deleteDisks });
    }
    db.prepare("DELETE FROM qemu_vms WHERE vm_name = ?").run(name);
    db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ?").run(name);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'vm' AND resource_name = ?").run(name);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'vm' AND linked_resource_name = ?").run(name);
    await syncFirewallState();
    return { ok: true };
  });
});

app.post("/api/vms/:name/rename", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const newName = String((req.body as { newName?: unknown })?.newName ?? "").trim();
  requireResourcePermission(req, "vm", name, "modify");
  if (!isValidResourceName("vm", newName)) return reply.status(400).send({ error: "Invalid VM name" });
  if (isResourceLocked("vm", name)) return reply.status(423).send({ error: "Ressource verrouillée : déverrouillez-la avant de la renommer." });

  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_modify");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const node = await getResourceNodeAsync("vm", name);
  const renamed = await renameDesktopResource("vm", node?.name ?? getLocalNodeName(), name, newName);
  await syncFirewallState();
  auditLog(db, {
    userId: req.session.userId,
    username: req.session.username,
    ip: getClientIp(req),
    action: "vm.rename",
    resourceType: "vm",
    resourceName: renamed,
    details: `${name} -> ${renamed}`,
  });
  return { ok: true, name: renamed };
});

app.post("/api/vms/:name/:action", async (req, reply) => {
  requireAuth(req, reply);
  const { name, action } = req.params as { name: string; action: string };
  if (!QEMU_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid VM action. Allowed: ${[...QEMU_ACTION_ALLOWLIST].join(", ")}` });
  requireResourcePermission(req, "vm", name, "power");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: `vm.${action}`, label: `VM ${name}: ${action}`, resourceType: "vm", resourceName: name, message: `Executing ${action}` });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: "POST" })
      : runQemuAction(name, action);
  });
});

app.put("/api/vms/:name/config", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = UpdateVmConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_modify");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.config.update", label: `Update VM config ${name}`, resourceType: "vm", resourceName: name, message: "Updating configuration" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/config`, {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
    } else {
      if (
        parsed.data.vcpus !== undefined ||
        parsed.data.memoryMb !== undefined ||
        parsed.data.autostart !== undefined ||
        parsed.data.uefi !== undefined ||
        parsed.data.secureBoot !== undefined ||
        parsed.data.bootDevice !== undefined ||
        parsed.data.tpmEnabled !== undefined ||
        parsed.data.qemuAgentEnabled !== undefined ||
        parsed.data.videoModel !== undefined
      ) {
        await callRunner("qemu_update_config", { name, ...parsed.data });
      }
      if (parsed.data.description !== undefined || parsed.data.tags !== undefined) {
        db.prepare("UPDATE qemu_vms SET description = COALESCE(?, description), tags = COALESCE(?, tags) WHERE vm_name = ?").run(parsed.data.description ?? null, parsed.data.tags ? JSON.stringify(parsed.data.tags) : null, name);
      }
    }
    return { ok: true };
  });
});

app.get("/api/vms/:name/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "view");
  const node = await getResourceNodeAsync("vm", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/stats`)
    : callRunner("qemu_stats", { name });
});

app.get("/api/vms/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  requireResourcePermission(req, "vm", name, "view");
  const node = await getResourceNodeAsync("vm", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/logs?tail=${encodeURIComponent(String(tail))}`)
    : { logs: await callRunner("qemu_logs", { name, tail }) };
});

app.post("/api/vms/:name/disk/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = AttachDiskSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_modify");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);
  let storagePath: string | undefined;
  if (parsed.data.storagePool) {
    const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(parsed.data.storagePool) as { path: string } | undefined;
    storagePath = pool?.path;
  }
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.disk.attach", label: `Attach disk to VM ${name}`, resourceType: "vm", resourceName: name, message: "Attaching disk" });
  return runInstantTask(task, ip, async () => {
    let existingPath: string | undefined;
    if (parsed.data.existingPath) {
      const filename = sanitizeManagedFilename(path.basename(parsed.data.existingPath));
      if (!isAllowedManagedFile(filename, "vm_disk")) {
        throw Object.assign(new Error("Unsupported file extension for vm_disk"), { statusCode: 400 });
      }
      if (parsed.data.storagePool) {
        const pool = resolveManagedStoragePool(parsed.data.storagePool);
        if (!pool) throw Object.assign(new Error("Storage pool not found"), { statusCode: 404 });
        const candidate = path.join(pool.path, filename);
        const stat = await fs.promises.stat(candidate).catch(() => null);
        if (!stat?.isFile()) throw Object.assign(new Error(`Managed file not found: ${filename}`), { statusCode: 404 });
        existingPath = candidate;
      } else {
        existingPath = await resolveManagedFilePath(filename, "vm_disk");
      }
    }
    const attachedSources = existingPath ? await listAttachedVmDiskSources() : undefined;
    const realExistingPath = existingPath ? await fs.promises.realpath(existingPath).catch(() => existingPath) : undefined;
    if (realExistingPath && attachedSources?.has(realExistingPath)) {
      throw Object.assign(new Error("This VM disk is already attached to a machine"), { statusCode: 409 });
    }
    return callRunner("qemu_attach_disk", {
      name,
      ...parsed.data,
      existingPath: realExistingPath,
      storagePool: storagePath,
    });
  });
});

app.post("/api/vms/:name/disk/detach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { device } = req.body as { device: string };
  requireResourcePermission(req, "vm", name, "modify");
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_vm_modify");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.disk.detach", label: `Detach disk from VM ${name}`, resourceType: "vm", resourceName: name, message: `Detaching ${device}` });
  return runInstantTask(task, ip, () => callRunner("qemu_detach_disk", { name, device }));
});

app.post("/api/vms/:name/disk/resize", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { device, sizeGb } = req.body as { device: string; sizeGb: number };
  requireResourcePermission(req, "vm", name, "modify");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.disk.resize", label: `Resize disk ${device} on VM ${name}`, resourceType: "vm", resourceName: name, message: `Resize to ${sizeGb} GB` });
  return runInstantTask(task, ip, () => callRunner("qemu_resize_disk", { name, device, sizeGb }));
});

app.post("/api/vms/:name/network/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = AttachNetworkSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.network.attach", label: `Attach network to VM ${name}`, resourceType: "vm", resourceName: name, message: `Bridge: ${parsed.data.bridge ?? "default"}` });
  return runInstantTask(task, ip, () => callRunner("qemu_attach_network", { name, ...parsed.data }));
});

app.put("/api/vms/:name/network/:mac", async (req, reply) => {
  requireAuth(req, reply);
  const { name, mac } = req.params as { name: string; mac: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = UpdateNetworkSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.network.update", label: `Update network ${mac} on VM ${name}`, resourceType: "vm", resourceName: name, message: "Updating network adapter" });
  return runInstantTask(task, ip, () => callRunner("qemu_update_network", { name, mac, newMac: parsed.data.mac, bridge: parsed.data.bridge, model: parsed.data.model }));
});

app.delete("/api/vms/:name/network/:mac", async (req, reply) => {
  requireAuth(req, reply);
  const { name, mac } = req.params as { name: string; mac: string };
  requireResourcePermission(req, "vm", name, "modify");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.network.detach", label: `Detach network ${mac} from VM ${name}`, resourceType: "vm", resourceName: name, message: "Detaching network adapter" });
  return runInstantTask(task, ip, () => callRunner("qemu_detach_network", { name, mac }));
});

app.post("/api/vms/:name/iso/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "media");
  const { isoPath, isoFile } = req.body as { isoPath?: string; isoFile?: string };
  const requestedIso = isoPath ?? isoFile;
  if (!requestedIso) return reply.status(400).send({ error: "ISO file is required" });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.iso.attach", label: `Attach ISO to VM ${name}`, resourceType: "vm", resourceName: name, message: path.basename(requestedIso) });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    if (node && !node.isLocal) {
      return fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/iso/attach`, {
        method: "POST",
        body: JSON.stringify({ isoPath, isoFile }),
      });
    }
    const resolvedPath = await resolveManagedIsoPath(requestedIso);
    return callRunner("qemu_attach_iso", { name, isoPath: resolvedPath });
  });
});

app.post("/api/vms/:name/iso/eject", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "media");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.iso.eject", label: `Eject ISO from VM ${name}`, resourceType: "vm", resourceName: name, message: "Ejecting disc" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/iso/eject`, { method: "POST" })
      : callRunner("qemu_eject_iso", { name });
  });
});

// Guest tools (VirtIO drivers + agents for Windows guests). One click: insert
// the ISO if the library has it, otherwise download the stable virtio-win ISO
// (fixed upstream URL — never user-supplied), register it, then insert it.
const GUEST_TOOLS_ISO_FILENAME = "virtio-win.iso";
const GUEST_TOOLS_ISO_URL = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso";

app.post("/api/vms/:name/guest-tools", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "media");
  const ip = getClientIp(req);

  const node = await getResourceNodeAsync("vm", name);
  if (node && !node.isLocal) {
    // Remote node: insert from ITS iso library (each node owns its storage).
    // Downloading onto a remote node is not orchestrated from here — the
    // attach fails with a clear 404 if virtio-win.iso is absent over there.
    const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.guest-tools.attach", label: `Attach guest tools to VM ${name}`, resourceType: "vm", resourceName: name, message: GUEST_TOOLS_ISO_FILENAME });
    return runInstantTask(task, ip, () => fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/iso/attach`, {
      method: "POST",
      body: JSON.stringify({ isoFile: GUEST_TOOLS_ISO_FILENAME }),
    }));
  }

  const existing = await resolveManagedIsoPath(GUEST_TOOLS_ISO_FILENAME).catch(() => null);
  if (existing) {
    const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "vm.guest-tools.attach", label: `Attach guest tools to VM ${name}`, resourceType: "vm", resourceName: name, message: GUEST_TOOLS_ISO_FILENAME });
    return runInstantTask(task, ip, () => callRunner("qemu_attach_iso", { name, isoPath: existing }));
  }

  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "url-download",
    action: "vm.guest-tools.download",
    label: `Download guest tools for VM ${name}`,
    resourceType: "vm",
    resourceName: name,
    message: "Downloading virtio-win.iso",
    detail: GUEST_TOOLS_ISO_URL,
  });
  void saveManagedDownloadWithProgress(task.id, GUEST_TOOLS_ISO_URL, "iso", GUEST_TOOLS_ISO_FILENAME)
    .then(async (download) => {
      db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, 'iso', ?, ?, 1, NULL)")
        .run(download.filename, "VirtIO guest tools (Windows)", download.sizeBytes, req.session.userId!);
      const isoPath = await resolveManagedIsoPath(download.filename);
      await callRunner("qemu_attach_iso", { name, isoPath });
      updateTask(task.id, {
        status: "completed",
        progressPercent: 100,
        bytesCurrent: download.sizeBytes,
        bytesTotal: download.sizeBytes,
        message: "Guest tools ISO inserted",
        detail: download.filename,
        result: { filename: download.filename, attached: true },
      });
      const completed = getTaskRecord(task.id);
      if (completed) writeTaskAudit(completed, ip);
    })
    .catch((error) => {
      updateTask(task.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Guest tools download failed",
        message: "Guest tools download failed",
      });
      const failed = getTaskRecord(task.id);
      if (failed) writeTaskAudit(failed, ip);
    });
  return sanitizeTask(task);
});

app.post("/api/vms/:name/usb/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = `${parsed.data.vendorId}:${parsed.data.productId}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "vm.usb.attach", label: `Attach USB ${label} to VM ${name}`, resourceType: "vm", resourceName: name, message: "Attaching USB device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/usb/attach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("qemu_usb_attach", { name, ...parsed.data });
  });
});

app.post("/api/vms/:name/usb/detach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = `${parsed.data.vendorId}:${parsed.data.productId}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "vm.usb.detach", label: `Detach USB ${label} from VM ${name}`, resourceType: "vm", resourceName: name, message: "Detaching USB device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/usb/detach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("qemu_usb_detach", { name, ...parsed.data });
  });
});

app.post("/api/vms/:name/snapshot/create", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "snapshot");
  const parsed = CreateSnapshotSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const username = req.session.username ?? "unknown";
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, username, {
    kind: "vm-snapshot",
    action: "vm.snapshot.create",
    label: `Create VM snapshot ${parsed.data.name}`,
    resourceType: "vm",
    resourceName: name,
    message: "Creating VM snapshot",
    detail: parsed.data.name,
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    update({ progressPercent: 35, detail: parsed.data.name });
    const node = await getResourceNodeAsync("vm", name);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/create`, {
          method: "POST",
          body: JSON.stringify(parsed.data),
        })
      : await callRunner("qemu_snapshot_create", { name, snapName: parsed.data.name, description: parsed.data.description }, 15 * 60_000);
    if (!node || node.isLocal) {
      db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('vm', ?, ?, ?, ?)")
        .run(name, parsed.data.name, parsed.data.description ?? null, req.session.userId!);
    }
    update({ progressPercent: 100, message: "VM snapshot created", detail: parsed.data.name });
    return result;
  });
  return sanitizeTask(task);
});

app.get("/api/vms/:name/snapshots", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "view");
  const node = await getResourceNodeAsync("vm", name);
  if (node && !node.isLocal) {
    return fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshots`);
  }
  await syncSnapshotsForResource("vm", name);
  return callRunner("qemu_snapshot_list", { name });
});

app.post("/api/vms/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireAuth(req, reply);
  const { name, snap } = req.params as { name: string; snap: string };
  requireResourcePermission(req, "vm", name, "snapshot");
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "vm-rollback",
    action: "vm.snapshot.rollback",
    label: `Rollback VM snapshot ${snap}`,
    resourceType: "vm",
    resourceName: name,
    message: "Rolling back VM snapshot",
    detail: snap,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    update({ progressPercent: 40, detail: snap });
    const node = await getResourceNodeAsync("vm", name);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}/rollback`, { method: "POST" })
      : await callRunner("qemu_snapshot_rollback", { name, snapName: snap }, 15 * 60_000);
    update({ progressPercent: 100, message: "VM snapshot rollback completed", detail: snap });
    return result;
  });
  return sanitizeTask(task);
});

app.delete("/api/vms/:name/snapshot/:snap", async (req, reply) => {
  requireAuth(req, reply);
  const { name, snap } = req.params as { name: string; snap: string };
  requireResourcePermission(req, "vm", name, "snapshot");
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "vm-snapshot-delete",
    action: "vm.snapshot.delete",
    label: `Delete VM snapshot ${snap}`,
    resourceType: "vm",
    resourceName: name,
    message: "Deleting VM snapshot",
    detail: snap,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    update({ progressPercent: 50, detail: snap });
    const node = await getResourceNodeAsync("vm", name);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}`, { method: "DELETE" });
    } else {
      await callRunner("qemu_snapshot_delete", { name, snapName: snap }, 15 * 60_000);
      db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ? AND snapshot_name = ?").run(name, snap);
    }
    update({ progressPercent: 100, message: "VM snapshot deleted", detail: snap });
    return { ok: true };
  });
  return sanitizeTask(task);
});

app.post("/api/vms/:name/backup", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "backup");
  const parsed = BackupVmSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "vm-backup",
    action: "vm.backup.create",
    label: `Create VM backup ${name}`,
    resourceType: "vm",
    resourceName: name,
    message: "Creating VM backup",
    detail: parsed.data.storagePool,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    const node = await getResourceNodeAsync("vm", name);
    let result: { ok: boolean; filename: string; sizeBytes: number };
    if (node && !node.isLocal) {
      update({ progressPercent: 25, detail: `Node ${node.name}` });
      result = await fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
    } else {
      const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(parsed.data.storagePool) as { path: string } | undefined;
      if (!pool) throw new Error("Storage pool not found");
      const filename = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.${parsed.data.format === "tar.gz" ? "tar.zst" : "qcow2"}`;
      const destPath = path.join(pool.path, "backups", filename);
      update({ progressPercent: 5, detail: `Pool ${parsed.data.storagePool}` });
      void trackOutputFileProgress(task.id, destPath, () => getTaskRecord(task.id)?.progressPercent ?? 5);
      result = await callRunner<{ ok: boolean; filename: string; sizeBytes: number }>("qemu_backup", { name, ...parsed.data, storagePool: pool.path, filename }, BACKUP_TIMEOUT_MS, onBackupProgress(task.id));
      db.prepare("INSERT INTO backups (resource_type, resource_name, filename, storage_pool, size_bytes, format, created_by) VALUES ('vm', ?, ?, ?, ?, ?, ?)")
        .run(name, result.filename, parsed.data.storagePool, result.sizeBytes, parsed.data.format, req.session.userId!);
    }
    update({
      progressPercent: 100,
      message: "VM backup created",
      detail: result.filename,
      bytesCurrent: result.sizeBytes,
      bytesTotal: result.sizeBytes,
    });
    return result;
  });
  return sanitizeTask(task);
});

app.post("/api/vms/:name/clone", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const { newName } = req.body as { newName: string };
  const quotaCheck = checkQuota(db, req.session.userId!, req.session.role!, "vms");
  if (!quotaCheck.ok) return replyQuotaError(reply, quotaCheck);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "vm.clone", label: `Clone VM ${name} → ${newName}`, resourceType: "vm", resourceName: name, message: `Cloning to ${newName}` });
  return runInstantTask(task, ip, async () => {
    const result = await callRunner("qemu_clone", { name, newName });
    db.prepare("INSERT OR IGNORE INTO qemu_vms (vm_name, user_id, node_name) VALUES (?, ?, ?)").run(newName, req.session.userId!, getLocalNodeName());
    return result;
  });
});

app.post("/api/vms/:name/export-template", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const { templateName, description = "" } = req.body as { templateName: string; description?: string };
  if (!templateName?.trim()) return reply.status(400).send({ error: "templateName is required" });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "create",
    action: "vm.export-template",
    label: `Export VM ${name} as template "${templateName}"`,
    resourceType: "vm",
    resourceName: name,
    message: "Exporting VM disk as template",
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    update({ progressPercent: 5, detail: "Preparing export" });
    const result = await callRunner<{ ok: boolean; filename: string; jsonFilename: string; sizeBytes: number }>(
      "qemu_export_template",
      { name, templateName: templateName.trim(), description, outputDir: VM_TEMPLATES_DIR },
      BACKUP_TIMEOUT_MS,
      (p) => update({ progressPercent: Math.min(90, p.percent ?? 0), detail: p.message }),
    );
    const info = await callRunner<{ vcpus: number; maxMemoryKiB: number; arch: string; disks: Array<{ source: string; sizeBytes: number }> }>("qemu_info", { name });
    const diskGb = Math.ceil((info.disks[0]?.sizeBytes ?? 0) / (1024 ** 3)) || 10;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO templates (id, type, name, description, arch, cpu, memory_mb, disk_gb, disk_file, filename, size_bytes, visibility, tags, storage_pool, owner_id)
       VALUES (?, 'vm', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'private', '[]', NULL, ?)`,
    ).run(id, templateName.trim(), description, info.arch ?? "x86_64", info.vcpus ?? 1, Math.round((info.maxMemoryKiB ?? 0) / 1024), diskGb, result.filename, result.sizeBytes, req.session.userId!);
    update({ progressPercent: 100, message: "Template exported", detail: result.filename, bytesCurrent: result.sizeBytes, bytesTotal: result.sizeBytes });
    return result;
  });
  return sanitizeTask(task);
});

app.post("/api/vms/:name/repair-disk", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "config",
    action: "vm.repair-disk",
    label: `Repair VM disk ${name}`,
    resourceType: "vm",
    resourceName: name,
    message: "Repairing VM disk chain",
  });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("vm", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/repair-disk`, { method: "POST" })
      : callRunner("qemu_repair_disk", { name }, 5 * 60_000);
  });
});

app.get("/api/vms/:name/vnc-info", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "view");
  const info = await callRunner<{ vncPort?: number; vncHost?: string }>("qemu_info", { name });
  return { host: info.vncHost ?? "127.0.0.1", port: info.vncPort ?? -1 };
});

app.post("/api/vms/:name/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  const ticket = node && !node.isLocal
    ? issueWsTicket("remote-vm-console", req.session.userId!, name, undefined, node.name)
    : issueWsTicket("vm-console", req.session.userId!, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.post("/api/vms/:name/vnc-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  const ticket = node && !node.isLocal
    ? issueWsTicket("remote-vm-vnc", req.session.userId!, name, undefined, node.name)
    : issueWsTicket("vm-vnc", req.session.userId!, name);
  const vnc = node && !node.isLocal
    ? await fetchRemoteNode<VmVncPasswordInfo>(node, `/api/internal/vms/${encodeURIComponent(name)}/vnc-password`)
    : await callRunner<VmVncPasswordInfo>("qemu_vnc_password", { name });
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/vnc", ticket.id), password: vnc.password };
});

app.post("/api/vms/:name/spice-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  if (node && !node.isLocal) {
    const remote = await fetchRemoteNode<{ ticket: string; url: string; password?: string }>(
      node,
      `/api/internal/vms/${encodeURIComponent(name)}/spice-ticket`,
      { method: "POST" },
    );
    const ticket = issueWsTicket("remote-vm-spice", req.session.userId!, name, undefined, node.name);
    return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/spice", ticket.id), password: remote.password };
  }
  const info = await callRunner<SpiceConsoleInfo>("qemu_ensure_spice", { name });
  const port = info.spicePort ?? info.spiceTlsPort;
  if (!info.enabled || !info.active || !port || info.requiresRestart) {
    return reply.status(409).send({
      error: info.requiresRestart
        ? "SPICE enabled but VM restart required"
        : info.requiresStart
          ? "SPICE console requires a running VM"
          : "SPICE console is not active",
      requiresRestart: !!info.requiresRestart,
      requiresStart: !!info.requiresStart,
    });
  }
  const ticket = issueWsTicket("vm-spice", req.session.userId!, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/spice", ticket.id), password: info.spicePassword };
});

function buildVvFile(args: { host: string; port: number; tlsPort?: number; password: string; vmName: string }) {
  const lines = [
    "[virt-viewer]",
    "type=spice",
    `host=${args.host}`,
  ];
  if (args.port) lines.push(`port=${args.port}`);
  if (args.tlsPort) lines.push(`tls-port=${args.tlsPort}`);
  lines.push(
    `password=${args.password}`,
    `title=Virtua - ${args.vmName}`,
    "toggle-fullscreen=shift+f11",
    "release-cursor=shift+f12",
    "enable-smartcard=0",
    "enable-usbredir=0",
    "delete-this-file=1",
    "",
  );
  return lines.join("\n");
}

app.get("/api/vms/:name/spice-file", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  if (node && !node.isLocal && !node.apiUrl) {
    return reply.status(409).send({ error: "Remote node API URL is not configured" });
  }
  const info = node && !node.isLocal
    ? await fetchRemoteNode<SpiceConsoleInfo>(node, `/api/internal/vms/${encodeURIComponent(name)}/spice-ticket`, { method: "POST" })
    : await callRunner<SpiceConsoleInfo>("qemu_ensure_spice", { name });
  const port = info.spicePort ?? info.spiceTlsPort;
  if (!info.enabled || !info.active || !port || !info.spicePassword || info.requiresRestart) {
    return reply.status(409).send({ error: "SPICE console is not ready" });
  }
  // virt-viewer connects straight to the VM's SPICE port: unlike the browser
  // client, it needs no WS proxy/ticket, so it must reach the host directly
  // (the loopback-only listener requires the same network access a direct
  // hypervisor SSH/VNC session would).
  const host = node && !node.isLocal ? new URL(node.apiUrl!).hostname : buildPublicHost(req);
  const body = buildVvFile({ host, port: info.spicePort ?? 0, tlsPort: info.spiceTlsPort, password: info.spicePassword, vmName: name });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "vm.console.spice.download", resourceType: "vm", resourceName: name });
  return reply
    .header("Content-Type", "application/x-virt-viewer")
    .header("Content-Disposition", `attachment; filename="virtua-${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.vv"`)
    .send(body);
});

app.get("/api/vms/:name/rdp-info", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/vms/${encodeURIComponent(name)}/rdp-info`)
    : callRunner("qemu_rdp_console_info", { name });
});

app.post("/api/vms/:name/rdp-prepare", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  const result = node && !node.isLocal
    ? await fetchRemoteNode<VmRdpConsoleInfo>(node, `/api/internal/vms/${encodeURIComponent(name)}/rdp-prepare`, { method: "POST" })
    : await callRunner<VmRdpConsoleInfo>("qemu_rdp_prepare", { name });
  if (!node || node.isLocal) {
    await ensureVmRdpFirewallRule(name, result.xrdpPort, req.session.userId!);
    await syncFirewallState();
  }
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "vm.console.rdp.prepare", resourceType: "vm", resourceName: name });
  return result;
});

app.get("/api/vms/:name/rdp-file", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "console");
  const node = await getResourceNodeAsync("vm", name);
  const info = node && !node.isLocal
    ? await fetchRemoteNode<VmRdpConsoleInfo>(node, `/api/internal/vms/${encodeURIComponent(name)}/rdp-info`)
    : await callRunner<VmRdpConsoleInfo>("qemu_rdp_console_info", { name });
  if (!info.ready) {
    return reply.status(409).send({ error: "RDP console is not ready", warnings: info.warnings });
  }
  if (node && !node.isLocal && !node.apiUrl) {
    return reply.status(409).send({ error: "Remote node API URL is not configured" });
  }
  const host = node && !node.isLocal ? new URL(node.apiUrl!).hostname : buildPublicHost(req);
  const body = buildRdpFile({ host, port: info.xrdpPort, vmName: name, width: info.consoleWidth, height: info.consoleHeight });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "vm.console.rdp.download", resourceType: "vm", resourceName: name });
  return reply
    .header("Content-Type", "application/x-rdp")
    .header("Content-Disposition", `attachment; filename="virtua-${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.rdp"`)
    .send(body);
});

// ── Notes (free-text description) per resource ───────────────────────────────
function parseNotesBody(body: unknown): string {
  const raw = (body as { notes?: unknown })?.notes;
  const notes = typeof raw === "string" ? raw : "";
  if (notes.length > 4000) throw Object.assign(new Error("Notes too long (max 4000 chars)"), { statusCode: 400 });
  return notes;
}

app.get("/api/vms/:name/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "view");
  const row = db.prepare("SELECT description FROM qemu_vms WHERE vm_name = ?").get(name) as { description: string | null } | undefined;
  return { notes: row?.description ?? "" };
});
app.put("/api/vms/:name/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "vm", name, "modify");
  const notes = parseNotesBody(req.body);
  db.prepare("INSERT INTO qemu_vms (vm_name, description, node_name) VALUES (?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET description = excluded.description")
    .run(name, notes, getLocalNodeName());
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "vm.notes.update", resourceType: "vm", resourceName: name });
  return { ok: true, notes };
});

app.get("/api/lxc/:name/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "view");
  const row = db.prepare("SELECT description FROM lxc_containers WHERE container_name = ?").get(name) as { description: string | null } | undefined;
  return { notes: row?.description ?? "" };
});
app.put("/api/lxc/:name/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const notes = parseNotesBody(req.body);
  db.prepare("INSERT INTO lxc_containers (container_name, description, node_name) VALUES (?, ?, ?) ON CONFLICT(container_name) DO UPDATE SET description = excluded.description")
    .run(name, notes, getLocalNodeName());
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "lxc.notes.update", resourceType: "lxc", resourceName: name });
  return { ok: true, notes };
});

app.get("/api/docker/containers/:id/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "view");
  const row = db.prepare("SELECT description FROM docker_containers WHERE container_id = ?").get(id) as { description: string | null } | undefined;
  return { notes: row?.description ?? "" };
});
app.put("/api/docker/containers/:id/notes", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "modify");
  const notes = parseNotesBody(req.body);
  db.prepare("INSERT INTO docker_containers (container_id, container_name, image, description, node_name) VALUES (?, '', '', ?, ?) ON CONFLICT(container_id) DO UPDATE SET description = excluded.description")
    .run(id, notes, getLocalNodeName());
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "docker.notes.update", resourceType: "docker", resourceName: id });
  return { ok: true, notes };
});

// ── LXC Routes ─────────────────────────────────────────────────────────────
app.get("/api/lxc", async (req, reply) => {
  requireAuth(req, reply);
  await reconcileResourceMetadata();
  const userId = req.session.userId!;
  const role = req.session.role!;
  const dbRows = db.prepare("SELECT * FROM lxc_containers").all() as Array<{ container_name: string; user_id: number; description: string | null }>;
  const meta = new Map(dbRows.map((r) => [r.container_name, r]));
  const nodes = enabledResourceNodes();
  const containerLists = await Promise.all(nodes.map(async (node) => {
    try {
      return node.isLocal ? await callRunner<unknown[]>("lxc_containers") : await fetchRemoteNode<unknown[]>(node, "/api/internal/lxc");
    } catch {
      return [];
    }
  }));
  return containerLists.flat().map((c: unknown) => {
    const ct = c as Record<string, unknown>;
    const m = meta.get(ct.name as string);
    if (!hasResourcePermission(userId, role, "lxc", ct.name as string, "view")) return null;
    return { ...ct, userId: m?.user_id, description: m?.description };
  }).filter(Boolean);
});

app.post("/api/lxc", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = CreateLxcSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const targetNodeName = `${(req.query as { node?: string }).node ?? ""}`.trim() || getLocalNodeName();
  const targetNode = listDatacenterNodes().find((entry) => entry.name === targetNodeName);
  if (!targetNode || !targetNode.enabled) return reply.status(404).send({ error: "Target node not found" });

  const quotaCheck = checkQuota(db, req.session.userId!, req.session.role!, "lxc");
  if (!quotaCheck.ok) return replyQuotaError(reply, quotaCheck);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_lxc_create");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "lxc.create", label: `Create LXC ${parsed.data.name}`, resourceType: "lxc", resourceName: parsed.data.name, message: "Creating container" });
  return runInstantTask(task, ip, async () => {
    const result = targetNode.isLocal
      ? await callRunner("lxc_create", lxcPayloadWithRepos(parsed.data))
      : await fetchRemoteNode(targetNode, "/api/internal/lxc", { method: "POST", body: JSON.stringify(parsed.data) });
    db.prepare("INSERT INTO lxc_containers (container_name, user_id, description, node_name) VALUES (?, ?, ?, ?) ON CONFLICT(container_name) DO UPDATE SET user_id = excluded.user_id, description = excluded.description, node_name = excluded.node_name")
      .run(parsed.data.name, req.session.userId!, parsed.data.description ?? null, targetNode.name);
    return result;
  });
});

app.get("/api/lxc/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "view");
  const node = await getResourceNodeAsync("lxc", name);
  const info = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}`)
    : await callRunner("lxc_info", { name });
  return { ...(info as object), nodeName: node?.name ?? getLocalNodeName() };
});

app.post("/api/lxc/:name/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "console");
  const node = await getResourceNodeAsync("lxc", name);
  const ticket = node && !node.isLocal
    ? issueWsTicket("remote-lxc-console", req.session.userId!, name, undefined, node.name)
    : issueWsTicket("lxc-console", req.session.userId!, name);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.delete("/api/lxc/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "delete");
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_lxc_delete");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "lxc.delete", label: `Delete LXC ${name}`, resourceType: "lxc", resourceName: name, message: "Deleting container" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}`, { method: "DELETE" });
    } else {
      await callRunner("lxc_delete", { name });
    }
    db.prepare("DELETE FROM lxc_containers WHERE container_name = ?").run(name);
    db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ?").run(name);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'lxc' AND resource_name = ?").run(name);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ?").run(name);
    await syncFirewallState();
    return { ok: true };
  });
});

app.post("/api/lxc/:name/rename", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const newName = String((req.body as { newName?: unknown })?.newName ?? "").trim();
  requireResourcePermission(req, "lxc", name, "modify");
  if (!isValidResourceName("lxc", newName)) return reply.status(400).send({ error: "Invalid LXC name" });
  if (isResourceLocked("lxc", name)) return reply.status(423).send({ error: "Ressource verrouillée : déverrouillez-la avant de la renommer." });

  const node = await getResourceNodeAsync("lxc", name);
  const renamed = await renameDesktopResource("lxc", node?.name ?? getLocalNodeName(), name, newName);
  await syncFirewallState();
  auditLog(db, {
    userId: req.session.userId,
    username: req.session.username,
    ip: getClientIp(req),
    action: "lxc.rename",
    resourceType: "lxc",
    resourceName: renamed,
    details: `${name} -> ${renamed}`,
  });
  return { ok: true, name: renamed };
});

app.post("/api/lxc/:name/:action", async (req, reply) => {
  requireAuth(req, reply);
  const { name, action } = req.params as { name: string; action: string };
  if (!LXC_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid LXC action. Allowed: ${[...LXC_ACTION_ALLOWLIST].join(", ")}` });
  requireResourcePermission(req, "lxc", name, "power");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: `lxc.${action}`, label: `LXC ${name}: ${action}`, resourceType: "lxc", resourceName: name, message: `Executing ${action}` });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: "POST" })
      : callRunner("lxc_action", { name, action });
  });
});

app.put("/api/lxc/:name/config", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = UpdateLxcConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const node = await getResourceNodeAsync("lxc", name);
  if (node && !node.isLocal) {
    return fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/config`, {
      method: "PUT",
      body: JSON.stringify(parsed.data),
    });
  }
  let lxcForwardTargetIp: string | undefined;
  if (parsed.data.portForwards) {
    const info = await callRunner<{ ipAddress?: string }>("lxc_info", { name }).catch(() => ({ ipAddress: undefined }));
    lxcForwardTargetIp = (parsed.data.ipv4 && parsed.data.ipv4 !== "dhcp" ? parsed.data.ipv4 : info.ipAddress)?.split("/")[0];
    if (!lxcForwardTargetIp) {
      return reply.status(400).send({ error: "LXC port forwards require a known container IPv4 address" });
    }
  }
  const result = await callRunner("lxc_update_config", { name, ...parsed.data });
  if (parsed.data.portForwards) {
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ? AND relation LIKE 'LXC port %'").run(name);
    const insert = db.prepare(`
      INSERT INTO firewall_rules (
        enabled, source_kind, rule_type, protocol, host_port, target_ip, target_port,
        description, linked_resource_type, linked_resource_name, relation, created_by, updated_at
      ) VALUES (1, 'manual', 'forward', ?, ?, ?, ?, ?, 'lxc', ?, ?, ?, datetime('now'))
    `);
    for (const forward of parsed.data.portForwards) {
      insert.run(
        forward.protocol,
        forward.hostPort,
        lxcForwardTargetIp,
        forward.containerPort,
        `LXC ${name} port forward`,
        name,
        `LXC port ${forward.hostPort} -> ${forward.containerPort}`,
        req.session.userId!,
      );
    }
    await syncFirewallState();
  }
  return result;
});

app.post("/api/lxc/:name/usb/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = `${parsed.data.vendorId}:${parsed.data.productId}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "lxc.usb.attach", label: `Attach USB ${label} to LXC ${name}`, resourceType: "lxc", resourceName: name, message: "Attaching USB device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/usb/attach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("lxc_usb_attach", { name, ...parsed.data });
  });
});

app.post("/api/lxc/:name/usb/detach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = UsbDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = `${parsed.data.vendorId}:${parsed.data.productId}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "lxc.usb.detach", label: `Detach USB ${label} from LXC ${name}`, resourceType: "lxc", resourceName: name, message: "Detaching USB device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/usb/detach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("lxc_usb_detach", { name, ...parsed.data });
  });
});

app.post("/api/lxc/:name/gpu/attach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = GpuDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = parsed.data.id === "dri" ? "/dev/dri" : "/dev/nvidia*";
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "lxc.gpu.attach", label: `Attach GPU ${label} to LXC ${name}`, resourceType: "lxc", resourceName: name, message: "Attaching shared GPU device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/gpu/attach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("lxc_gpu_attach", { name, ...parsed.data });
  });
});

app.post("/api/lxc/:name/gpu/detach", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = GpuDeviceAssignmentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = parsed.data.id === "dri" ? "/dev/dri" : "/dev/nvidia*";
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "config", action: "lxc.gpu.detach", label: `Detach GPU ${label} from LXC ${name}`, resourceType: "lxc", resourceName: name, message: "Detaching shared GPU device" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("lxc", name);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/gpu/detach`, { method: "POST", body: JSON.stringify(parsed.data) })
      : callRunner("lxc_gpu_detach", { name, ...parsed.data });
  });
});

// ── LXC multi-NIC ───────────────────────────────────────────────────────────
app.get("/api/lxc/:name/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "view");
  const node = await getResourceNodeAsync("lxc", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks`)
    : callRunner("lxc_net_list", { name });
});

app.post("/api/lxc/:name/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const parsed = LxcNicSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const node = await getResourceNodeAsync("lxc", name);
  const result = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks`, { method: "POST", body: JSON.stringify(parsed.data) })
    : await callRunner("lxc_net_add", { name, ...parsed.data });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "lxc.network.add", resourceName: name, result: "success" });
  return result;
});

app.put("/api/lxc/:name/networks/:index", async (req, reply) => {
  requireAuth(req, reply);
  const { name, index } = req.params as { name: string; index: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const idx = parseInt(index, 10);
  if (!Number.isInteger(idx) || idx < 0) return reply.status(400).send({ error: "Invalid interface index" });
  const parsed = LxcNicSchema.partial().safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const node = await getResourceNodeAsync("lxc", name);
  const result = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks/${idx}`, { method: "PUT", body: JSON.stringify(parsed.data) })
    : await callRunner("lxc_net_update", { name, index: idx, ...parsed.data });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "lxc.network.update", resourceName: name, result: "success", details: `nic#${idx}` });
  return result;
});

app.delete("/api/lxc/:name/networks/:index", async (req, reply) => {
  requireAuth(req, reply);
  const { name, index } = req.params as { name: string; index: string };
  requireResourcePermission(req, "lxc", name, "modify");
  const idx = parseInt(index, 10);
  if (!Number.isInteger(idx) || idx < 0) return reply.status(400).send({ error: "Invalid interface index" });
  if (idx === 0) return reply.status(400).send({ error: "The primary network interface (#0) cannot be removed" });
  const node = await getResourceNodeAsync("lxc", name);
  const result = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/networks/${idx}`, { method: "DELETE" })
    : await callRunner("lxc_net_delete", { name, index: idx });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "lxc.network.delete", resourceName: name, result: "success", details: `nic#${idx}` });
  return result;
});

app.get("/api/lxc/:name/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "view");
  const node = await getResourceNodeAsync("lxc", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/stats`)
    : callRunner("lxc_stats", { name });
});

app.get("/api/lxc/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  requireResourcePermission(req, "lxc", name, "view");
  const node = await getResourceNodeAsync("lxc", name);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/logs?tail=${encodeURIComponent(String(tail))}`)
    : { logs: await callRunner("lxc_logs", { name, tail }) };
});

app.post("/api/lxc/:name/snapshot/create", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "snapshot");
  const { snapName: snapNameRaw, description } = req.body as { snapName?: string; description?: string };
  const snapName = normalizeLxcSnapshotName(snapNameRaw);
  if (!snapName) return reply.status(400).send({ error: LXC_SNAPSHOT_NAME_ERROR });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-snapshot",
    action: "lxc.snapshot.create",
    label: `Create LXC snapshot ${snapName}`,
    resourceType: "lxc",
    resourceName: name,
    message: "Creating LXC snapshot",
    detail: snapName,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    update({ progressPercent: 35, detail: snapName });
    const node = await getResourceNodeAsync("lxc", name);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/create`, {
          method: "POST",
          body: JSON.stringify({ snapName, description }),
        })
      : await callRunner("lxc_snapshot_create", { name, snapName, description });
    if (!node || node.isLocal) {
      db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('lxc', ?, ?, ?, ?)")
        .run(name, snapName, description ?? null, req.session.userId!);
    }
    update({ progressPercent: 100, message: "LXC snapshot created", detail: snapName });
    return result;
  });
  return sanitizeTask(task);
});

app.get("/api/lxc/:name/snapshots", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "view");
  const node = await getResourceNodeAsync("lxc", name);
  if (node && !node.isLocal) {
    return fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshots`);
  }
  await syncSnapshotsForResource("lxc", name);
  return callRunner("lxc_snapshot_list", { name });
});

app.post("/api/lxc/:name/snapshot/:snap/rollback", async (req, reply) => {
  requireAuth(req, reply);
  const { name, snap } = req.params as { name: string; snap: string };
  requireResourcePermission(req, "lxc", name, "snapshot");
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-rollback",
    action: "lxc.snapshot.rollback",
    label: `Rollback LXC snapshot ${snap}`,
    resourceType: "lxc",
    resourceName: name,
    message: "Rolling back LXC snapshot",
    detail: snap,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    update({ progressPercent: 40, detail: snap });
    const node = await getResourceNodeAsync("lxc", name);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}/rollback`, { method: "POST" })
      : await callRunner("lxc_snapshot_rollback", { name, snapName: snap });
    update({ progressPercent: 100, message: "LXC snapshot rollback completed", detail: snap });
    return result;
  });
  return sanitizeTask(task);
});

app.delete("/api/lxc/:name/snapshot/:snap", async (req, reply) => {
  requireAuth(req, reply);
  const { name, snap } = req.params as { name: string; snap: string };
  requireResourcePermission(req, "lxc", name, "snapshot");
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-snapshot-delete",
    action: "lxc.snapshot.delete",
    label: `Delete LXC snapshot ${snap}`,
    resourceType: "lxc",
    resourceName: name,
    message: "Deleting LXC snapshot",
    detail: snap,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    update({ progressPercent: 50, detail: snap });
    const node = await getResourceNodeAsync("lxc", name);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snap)}`, { method: "DELETE" });
    } else {
      await callRunner("lxc_snapshot_delete", { name, snapName: snap });
      db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ? AND snapshot_name = ?").run(name, snap);
    }
    update({ progressPercent: 100, message: "LXC snapshot deleted", detail: snap });
    return { ok: true };
  });
  return sanitizeTask(task);
});

app.post("/api/lxc/:name/backup", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  requireResourcePermission(req, "lxc", name, "backup");
  const parsed = BackupLxcSchema.safeParse({ format: "tar.gz", ...((req.body as Record<string, unknown>) ?? {}) });
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-backup",
    action: "lxc.backup.create",
    label: `Create LXC backup ${name}`,
    resourceType: "lxc",
    resourceName: name,
    message: "Creating LXC backup",
    detail: parsed.data.storagePool,
  });
  void runTrackedTask(task, getClientIp(req), async ({ update }) => {
    const node = await getResourceNodeAsync("lxc", name);
    let result: { ok: boolean; filename: string; sizeBytes: number };
    if (node && !node.isLocal) {
      update({ progressPercent: 25, detail: `Node ${node.name}` });
      result = await fetchRemoteNode(node, `/api/internal/lxc/${encodeURIComponent(name)}/backup`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
    } else {
      const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(parsed.data.storagePool) as { path: string } | undefined;
      if (!pool) throw new Error("Storage pool not found");
      const filename = `lxc-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.zst`;
      const destPath = path.join(pool.path, "backups", filename);
      update({ progressPercent: 5, detail: `Pool ${parsed.data.storagePool}` });
      // Real progress streamed from the runner (pv-measured bytes); file-size
      // tracking stays as a fallback for hosts without pv.
      void trackOutputFileProgress(task.id, destPath, () => getTaskRecord(task.id)?.progressPercent ?? 5);
      result = await callRunner<{ ok: boolean; filename: string; sizeBytes: number }>("lxc_backup", { name, ...parsed.data, storagePool: pool.path, filename }, BACKUP_TIMEOUT_MS, onBackupProgress(task.id));
      db.prepare("INSERT INTO backups (resource_type, resource_name, filename, storage_pool, size_bytes, format, created_by) VALUES ('lxc', ?, ?, ?, ?, ?, ?)")
        .run(name, result.filename, parsed.data.storagePool, result.sizeBytes, parsed.data.format, req.session.userId!);
    }
    update({
      progressPercent: 100,
      message: "LXC backup created",
      detail: result.filename,
      bytesCurrent: result.sizeBytes,
      bytesTotal: result.sizeBytes,
    });
    return result;
  });
  return sanitizeTask(task);
});

app.get("/api/lxc/templates", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  const { refresh = false } = req.query as { refresh?: boolean };
  return callRunner("lxc_templates", { refresh });
});

app.post("/api/lxc/templates/cache", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  const { dist, release, arch = "amd64", variant = "default" } = req.body as { dist?: string; release?: string; arch?: string; variant?: string };
  if (!dist || !release) return reply.status(400).send({ error: "dist and release are required" });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-cache",
    action: "lxc.template.cache",
    label: `Cache ${dist}:${release}:${arch}:${variant}`,
    resourceType: "lxc-template",
    resourceName: `${dist}:${release}:${arch}:${variant}`,
    message: "Caching LXC template",
    detail: `${dist}:${release}:${arch}:${variant}`,
  });
  const ip = getClientIp(req);
  void runLxcTemplateCacheTask(task.id, { dist, release, arch, variant })
    .then(() => {
      updateTask(task.id, {
        status: "completed",
        progressPercent: 100,
        message: "LXC template cached",
        detail: `${dist}:${release}:${arch}:${variant}`,
      });
      const completed = getTaskRecord(task.id);
      if (completed) writeTaskAudit(completed, ip);
    })
    .catch((error) => {
      updateTask(task.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Template caching failed",
        message: "LXC template caching failed",
      });
      const failed = getTaskRecord(task.id);
      if (failed) writeTaskAudit(failed, ip);
    });
  return sanitizeTask(task);
});

app.delete("/api/lxc/templates/cache", async (req, reply) => {
  requireAdmin(req, reply);
  return callRunner("lxc_cache_delete");
});

app.delete("/api/lxc/templates/cache/:dist/:release", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  const { dist, release } = req.params as { dist: string; release: string };
  return callRunner("lxc_cache_delete_entry", { dist, release });
});

// ── Docker Routes ──────────────────────────────────────────────────────────
app.get("/api/docker/containers", async (req, reply) => {
  requireAuth(req, reply);
  await reconcileResourceMetadata();
  const userId = req.session.userId!;
  const role = req.session.role!;
  const dbRows = db.prepare("SELECT * FROM docker_containers").all() as Array<{ container_id: string; user_id: number }>;
  const nodes = enabledResourceNodes();
  const containerLists = await Promise.all(nodes.map(async (node) => {
    try {
      return node.isLocal ? await callRunner<unknown[]>("docker_containers") : await fetchRemoteNode<unknown[]>(node, "/api/internal/docker/containers");
    } catch {
      return [];
    }
  }));
  return containerLists.flat().map((c: unknown) => {
    const ct = c as Record<string, unknown>;
    const dockerId = ct.id as string;
    const m = dbRows.find((row) => row.container_id === dockerId || row.container_id.startsWith(dockerId) || dockerId.startsWith(row.container_id));
    if (!hasResourcePermission(userId, role, "docker", ct.id as string, "view")) return null;
    return { ...ct, userId: m?.user_id };
  }).filter(Boolean);
});

app.post("/api/docker/containers", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = RunDockerSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const targetNodeName = `${(req.query as { node?: string }).node ?? ""}`.trim() || getLocalNodeName();
  const targetNode = listDatacenterNodes().find((entry) => entry.name === targetNodeName);
  if (!targetNode || !targetNode.enabled) return reply.status(404).send({ error: "Target node not found" });

  const quotaCheck = checkQuota(db, req.session.userId!, req.session.role!, "docker");
  if (!quotaCheck.ok) return replyQuotaError(reply, quotaCheck);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_docker_create");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "docker.create", label: `Create container ${parsed.data.name}`, resourceType: "docker", resourceName: parsed.data.name, message: `Image: ${parsed.data.image}` });
  return runInstantTask(task, ip, async () => {
    const result = targetNode.isLocal
      ? await callRunner<{ ok: boolean; id: string }>("docker_run", await prepareDockerRunPayload(parsed.data))
      : await fetchRemoteNode<{ ok: boolean; id: string }>(targetNode, "/api/internal/docker/containers", { method: "POST", body: JSON.stringify(parsed.data) });
    db.prepare("INSERT OR IGNORE INTO docker_containers (container_id, container_name, image, user_id, node_name) VALUES (?, ?, ?, ?, ?)")
      .run(result.id, parsed.data.name, parsed.data.image, req.session.userId!, targetNode.name);
    if (targetNode.isLocal) await syncFirewallState();
    return result;
  });
});

app.post("/api/docker/containers/:id/:action", async (req, reply) => {
  requireAuth(req, reply);
  const { id, action } = req.params as { id: string; action: string };
  if (!DOCKER_ACTION_ALLOWLIST.has(action)) return reply.status(400).send({ error: `Invalid Docker action. Allowed: ${[...DOCKER_ACTION_ALLOWLIST].join(", ")}` });
  requireResourcePermission(req, "docker", id, "power");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: `docker.${action}`, label: `Container ${id.slice(0, 12)}: ${action}`, resourceType: "docker", resourceName: id, message: `Executing ${action}` });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("docker", id);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: "POST" })
      : await callRunner("docker_action", { id, action });
    if (!node || node.isLocal) await syncFirewallState();
    return result;
  });
});

app.put("/api/docker/containers/:id/config", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "modify");
  const parsed = UpdateDockerConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "docker.config.update", label: `Update container config ${id.slice(0, 12)}`, resourceType: "docker", resourceName: id, message: "Updating configuration" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("docker", id);
    return node && !node.isLocal
      ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/config`, {
          method: "PUT",
          body: JSON.stringify(parsed.data),
        })
      : callRunner("docker_update_config", { id, ...parsed.data });
  });
});

// Full container edit (ports/volumes/env/image/command/network/resources).
// The runner recreates the container, preserving its volumes and data.
app.put("/api/docker/containers/:id/recreate", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "modify");
  const parsed = RecreateDockerSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "docker.recreate", label: `Edit container ${id.slice(0, 12)}`, resourceType: "docker", resourceName: id, message: "Recreating container" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("docker", id);
    const result = node && !node.isLocal
      ? await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/recreate`, {
          method: "PUT",
          body: JSON.stringify(parsed.data),
        })
      : await callRunner("docker_recreate", { id, ...parsed.data });
    // If the container was renamed, keep the DB metadata in sync.
    if (parsed.data.name && parsed.data.name !== id) {
      db.prepare("UPDATE docker_containers SET container_name = ? WHERE container_id = ?").run(parsed.data.name, id);
    }
    if (!node || node.isLocal) await syncFirewallState();
    return result;
  });
});

app.delete("/api/docker/containers/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "delete");
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_docker_delete");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "docker.delete", label: `Delete container ${id.slice(0, 12)}`, resourceType: "docker", resourceName: id, message: "Deleting container" });
  return runInstantTask(task, ip, async () => {
    const node = await getResourceNodeAsync("docker", id);
    if (node && !node.isLocal) {
      await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else {
      await callRunner("docker_delete", { id });
    }
    db.prepare("DELETE FROM docker_containers WHERE container_id = ?").run(id);
    db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'docker' AND resource_name = ?").run(id);
    db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'docker' AND linked_resource_name = ?").run(id);
    if (!node || node.isLocal) await syncFirewallState();
    return { ok: true };
  });
});

app.get("/api/docker/containers/:id/stats", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "view");
  const node = await getResourceNodeAsync("docker", id);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/stats`)
    : callRunner("docker_stats", { id });
});

// ── Docker multi-NIC (per-container network attachments) ────────────────────
app.get("/api/docker/containers/:id/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "view");
  const node = await getResourceNodeAsync("docker", id);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks`)
    : callRunner("docker_container_networks", { id });
});

app.post("/api/docker/containers/:id/networks", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "modify");
  const parsed = DockerConnectNetworkSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const node = await getResourceNodeAsync("docker", id);
  const result = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks`, { method: "POST", body: JSON.stringify(parsed.data) })
    : await callRunner("docker_network_connect", { id, ...parsed.data });
  if (!node || node.isLocal) await syncFirewallState();
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "docker.network.connect", resourceName: id, result: "success", details: parsed.data.network });
  return result;
});

app.delete("/api/docker/containers/:id/networks/:network", async (req, reply) => {
  requireAuth(req, reply);
  const { id, network } = req.params as { id: string; network: string };
  requireResourcePermission(req, "docker", id, "modify");
  const node = await getResourceNodeAsync("docker", id);
  const result = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/networks/${encodeURIComponent(network)}`, { method: "DELETE" })
    : await callRunner("docker_network_disconnect", { id, network });
  if (!node || node.isLocal) await syncFirewallState();
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "docker.network.disconnect", resourceName: id, result: "success", details: network });
  return result;
});

app.get("/api/docker/containers/:id/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const { tail: tailRaw = 200 } = req.query as { tail?: number };
  const tail = Math.min(Math.max(1, Number(tailRaw) || 200), 10000);
  requireResourcePermission(req, "docker", id, "view");
  const node = await getResourceNodeAsync("docker", id);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/logs?tail=${encodeURIComponent(String(tail))}`)
    : { logs: await callRunner("docker_logs", { id, tail }) };
});

app.get("/api/docker/containers/:id/details", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "view");
  const node = await getResourceNodeAsync("docker", id);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/details`)
    : callRunner("docker_inspect", { id });
});

app.get("/api/docker/containers/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "view");
  const node = await getResourceNodeAsync("docker", id);
  const info = node && !node.isLocal
    ? await fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}`)
    : await callRunner("docker_inspect", { id });
  return { ...(info as object), nodeName: node?.name ?? getLocalNodeName() };
});

app.post("/api/docker/containers/:id/console-ticket", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "console");
  const node = await getResourceNodeAsync("docker", id);
  const ticket = node && !node.isLocal
    ? issueWsTicket("remote-docker-console", req.session.userId!, id, undefined, node.name)
    : issueWsTicket("docker-console", req.session.userId!, id);
  return { ticket: ticket.id, url: buildWsUrl(req, "/api/ws/term", ticket.id) };
});

app.get("/api/docker/images", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  return callRunner("docker_images");
});

app.post("/api/docker/images/pull", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  const { image } = req.body as { image: string };
  if (!image) return reply.status(400).send({ error: "Image is required" });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "docker-pull",
    action: "docker.image.pull",
    label: `Pull ${image}`,
    resourceType: "docker-image",
    resourceName: image,
    message: "Pulling Docker image",
    detail: image,
  });
  const ip = getClientIp(req);
  void runDockerPullTask(task.id, image)
    .then(() => {
      updateTask(task.id, {
        status: "completed",
        progressPercent: 100,
        message: "Docker image pulled",
        detail: image,
      });
      const completed = getTaskRecord(task.id);
      if (completed) writeTaskAudit(completed, ip);
    })
    .catch((error) => {
      updateTask(task.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Docker pull failed",
        message: "Docker pull failed",
      });
      const failed = getTaskRecord(task.id);
      if (failed) writeTaskAudit(failed, ip);
    });
  return sanitizeTask(task);
});

app.delete("/api/docker/images/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  return callRunner("docker_image_delete", { id });
});

// ── Docker Compose (persistent .yml projects) ────────────────────────────────
app.get("/api/docker/compose", async (req, reply) => {
  requireAuth(req, reply);
  return callRunner("docker_compose_list");
});

app.post("/api/docker/compose", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = ComposeProjectSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (!parsed.data.composeYaml) return reply.status(400).send({ error: "composeYaml is required" });
  return callRunner("docker_compose_save", parsed.data, 60_000);
});

app.get("/api/docker/compose/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_config", { name });
});

app.put("/api/docker/compose/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const parsed = ComposeProjectSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (!parsed.data.composeYaml) return reply.status(400).send({ error: "composeYaml is required" });
  return callRunner("docker_compose_save", { name, composeYaml: parsed.data.composeYaml }, 60_000);
});

app.delete("/api/docker/compose/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_delete", { name }, 120_000);
});

app.post("/api/docker/compose/:name/up", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_up", { name }, 300_000);
});

app.post("/api/docker/compose/:name/down", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { removeVolumes } = (req.body ?? {}) as { removeVolumes?: boolean };
  return callRunner("docker_compose_down", { name, removeVolumes }, 300_000);
});

app.post("/api/docker/compose/:name/restart", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { service } = (req.body ?? {}) as { service?: string };
  return callRunner("docker_compose_restart", { name, service }, 120_000);
});

app.get("/api/docker/compose/:name/ps", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  return callRunner("docker_compose_ps", { name });
});

app.get("/api/docker/compose/:name/logs", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  const { tail = 100, service } = req.query as { tail?: number; service?: string };
  return { logs: await callRunner("docker_compose_logs", { name, tail, service }) };
});

// Backward-compatible deploy endpoint (persists the file, then `up -d`).
app.post("/api/docker/compose/deploy", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = ComposeDeploySchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_compose_up", parsed.data, 300_000);
});

// ── Docker volumes ────────────────────────────────────────────────────────────
app.get("/api/docker/volumes", async (req, reply) => {
  requireAuth(req, reply);
  return callRunner("docker_volumes");
});

app.post("/api/docker/volumes", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = DockerVolumeCreateSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_volume_create", parsed.data);
});

app.delete("/api/docker/volumes/:name", async (req, reply) => {
  requireAuth(req, reply);
  const { name } = req.params as { name: string };
  return callRunner("docker_volume_delete", { id: name });
});

// ── docker exec ────────────────────────────────────────────────────────────────
app.post("/api/docker/containers/:id/exec", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  requireResourcePermission(req, "docker", id, "console");
  const parsed = DockerExecSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const node = await getResourceNodeAsync("docker", id);
  return node && !node.isLocal
    ? fetchRemoteNode(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/exec`, { method: "POST", body: JSON.stringify(parsed.data) })
    : callRunner("docker_exec", { id, ...parsed.data });
});

// ── docker prune ───────────────────────────────────────────────────────────────
app.post("/api/docker/prune", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = DockerPruneSchema.safeParse(req.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return callRunner("docker_prune", parsed.data, 300_000);
});

app.get("/api/docker/networks", async (req, reply) => {
  requireAuth(req, reply);
  const targetNodeName = `${(req.query as { node?: string }).node ?? ""}`.trim() || getLocalNodeName();
  const targetNode = listDatacenterNodes().find((entry) => entry.name === targetNodeName);
  if (!targetNode || !targetNode.enabled) return reply.status(404).send({ error: "Target node not found" });
  return targetNode.isLocal
    ? callRunner("docker_networks")
    : fetchRemoteNode(targetNode, "/api/internal/docker/networks");
});

app.post("/api/docker/networks", async (req, reply) => {
  requireAuth(req, reply);
  const parsed = CreateDockerNetworkSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "docker.network.create", label: `Create Docker network ${parsed.data.name}`, resourceType: "docker", resourceName: parsed.data.name, message: "Creating network" });
  return runInstantTask(task, ip, () => callRunner("docker_network_create", parsed.data));
});

app.delete("/api/docker/networks/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "docker.network.delete", label: `Delete Docker network ${id.slice(0, 12)}`, resourceType: "docker", resourceName: id, message: "Deleting network" });
  return runInstantTask(task, ip, () => callRunner("docker_network_delete", { id }));
});

app.get("/api/docker/search", async (req, reply) => {
  requireAuth(req, reply);
  const { q, limit = 25 } = req.query as { q: string; limit?: number };
  return callRunner("docker_search", { query: q, limit });
});

app.get("/api/docker/hub-detail", async (req, reply) => {
  requireAuth(req, reply);
  const { image } = req.query as { image?: string };
  if (!image || typeof image !== "string") {
    return reply.status(400).send({ error: "image query parameter is required" });
  }
  // Basic image name validation to prevent injection
  if (!/^[a-z0-9][a-z0-9._/:-]*$/i.test(image) || image.length > 256) {
    return reply.status(400).send({ error: "Invalid image name" });
  }
  return callRunner("docker_hub_detail", { image });
});

// ── Storage Routes ─────────────────────────────────────────────────────────
app.get("/api/storage/disks", async (req, reply) => {
  requireAdmin(req, reply);
  return callRunner("storage_disks_list");
});

app.get("/api/storage/mounts", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  return callRunner("storage_mounts_list");
});

app.post("/api/storage/disks/:dev/format", async (req, reply) => {
  requireAdmin(req, reply);
  const { dev } = req.params as { dev: string };
  const parsed = FormatDiskSchema.safeParse({ ...req.body as object, device: `/dev/${dev}` });
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "storage.disk.format", label: `Format disk /dev/${dev}`, resourceType: "storage", resourceName: `/dev/${dev}`, message: `Formatting as ${parsed.data.fstype ?? "ext4"}` });
  return runInstantTask(task, ip, () => callRunner("storage_disk_format", parsed.data));
});

app.post("/api/storage/disks/:dev/wipe", async (req, reply) => {
  requireAdmin(req, reply);
  const { dev } = req.params as { dev: string };
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "storage.disk.wipe", label: `Wipe disk /dev/${dev}`, resourceType: "storage", resourceName: `/dev/${dev}`, message: "Wiping disk" });
  return runInstantTask(task, ip, () => callRunner("storage_disk_wipe", { device: `/dev/${dev}` }));
});

app.get("/api/storage/raid", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  return callRunner("storage_raid_list");
});

app.post("/api/storage/raid", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = CreateRaidSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "storage.raid.create", label: `Create RAID ${parsed.data.level} array`, resourceType: "storage", resourceName: parsed.data.name, message: `Level: ${parsed.data.level}, devices: ${parsed.data.devices.join(", ")}` });
  return runInstantTask(task, ip, async () => {
    const result = await callRunner<{ ok: boolean; device: string }>("storage_raid_create", parsed.data);
    db.prepare("INSERT OR REPLACE INTO raid_arrays (device, level, name, members) VALUES (?, ?, ?, ?)").run(result.device, parsed.data.level, parsed.data.name, JSON.stringify(parsed.data.devices));
    return result;
  });
});

app.get("/api/storage/raid/:dev", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { dev } = req.params as { dev: string };
  return callRunner("storage_raid_detail", { device: normalizeBlockDeviceRef(dev) });
});

app.delete("/api/storage/raid/:dev", async (req, reply) => {
  requireAdmin(req, reply);
  const { dev } = req.params as { dev: string };
  const device = normalizeBlockDeviceRef(dev);
  await callRunner("storage_raid_stop", { device });
  db.prepare("DELETE FROM raid_arrays WHERE device = ?").run(device);
  return { ok: true };
});

app.delete("/api/storage/raid", async (req, reply) => {
  requireAdmin(req, reply);
  const { device } = req.query as { device?: string };
  const normalized = normalizeBlockDeviceRef(device);
  await callRunner("storage_raid_stop", { device: normalized });
  db.prepare("DELETE FROM raid_arrays WHERE device = ?").run(normalized);
  return { ok: true };
});

app.post("/api/storage/raid/:dev/add", async (req, reply) => {
  requireAdmin(req, reply);
  const { dev } = req.params as { dev: string };
  const { member } = req.body as { member: string };
  return callRunner("storage_raid_add", { device: normalizeBlockDeviceRef(dev), member });
});

app.post("/api/storage/raid/:dev/remove", async (req, reply) => {
  requireAdmin(req, reply);
  const { dev } = req.params as { dev: string };
  const { member } = req.body as { member: string };
  return callRunner("storage_raid_remove", { device: normalizeBlockDeviceRef(dev), member });
});

app.get("/api/storage/pools", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  ensureBuiltinStoragePools();
  const pools = db.prepare("SELECT * FROM storage_pools WHERE enabled = 1").all() as Array<{
    id: number;
    name: string;
    path: string;
    type: string;
    content: string;
    total_bytes: number;
    used_bytes: number;
    mount_source: string | null;
    fstype: string | null;
    mount_options: string | null;
  }>;
  const result = await Promise.all(pools.map(async (pool) => {
    try {
      const df = await callRunner<{ totalBytes: number; usedBytes: number; freeBytes: number }>("storage_pool_df", { path: pool.path });
      db.prepare("UPDATE storage_pools SET total_bytes = ?, used_bytes = ? WHERE name = ?").run(df.totalBytes, df.usedBytes, pool.name);
      return {
        ...pool,
        content: JSON.parse(pool.content),
        totalBytes: df.totalBytes,
        usedBytes: df.usedBytes,
        freeBytes: df.freeBytes,
        mountSource: pool.mount_source ?? undefined,
        mountOptions: pool.mount_options ?? undefined,
      };
    } catch {
      return {
        ...pool,
        content: JSON.parse(pool.content),
        totalBytes: pool.total_bytes,
        usedBytes: pool.used_bytes,
        freeBytes: 0,
        mountSource: pool.mount_source ?? undefined,
        mountOptions: pool.mount_options ?? undefined,
      };
    }
  }));
  return result;
});

app.post("/api/storage/pools", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = CreateStoragePoolSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "storage.pool.create", label: `Create storage pool ${parsed.data.name}`, resourceType: "storage", resourceName: parsed.data.name, message: `Type: ${parsed.data.type}, path: ${parsed.data.path}` });
  return runInstantTask(task, ip, async () => {
    await callRunner("storage_pool_mount", parsed.data);
    db.prepare(`
      INSERT INTO storage_pools (name, path, type, content, mount_source, fstype, mount_options)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.data.name,
      parsed.data.path,
      parsed.data.type,
      JSON.stringify(parsed.data.content),
      parsed.data.mountSource ?? parsed.data.mountDevice ?? null,
      parsed.data.fstype ?? null,
      parsed.data.mountOptions ?? null,
    );
    return { ok: true };
  });
});

app.get("/api/storage/pools/:name", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name } = req.params as { name: string };
  const pool = db.prepare("SELECT * FROM storage_pools WHERE name = ?").get(name) as {
    path: string;
    type: string;
    content: string;
    mount_source: string | null;
    fstype: string | null;
    mount_options: string | null;
  } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  const df = await callRunner("storage_pool_df", { path: pool.path });
  return {
    ...pool,
    content: JSON.parse(pool.content),
    mountSource: pool.mount_source ?? undefined,
    mountOptions: pool.mount_options ?? undefined,
    ...df as object,
  };
});

app.get("/api/storage/pools/:name/content", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name } = req.params as { name: string };
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(name) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  await reconcileSnapshotMetadata();
  return listPoolContent(name, pool.path);
});

app.get("/api/storage/pools/:name/content/download", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name } = req.params as { name: string };
  const { itemPath } = req.query as { itemPath?: string };
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });
  const { item } = await resolvePoolContentItem(name, itemPath);
  if (item.synthetic) return reply.status(400).send({ error: "Synthetic entries cannot be downloaded" });

  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `attachment; filename="${path.basename(item.name).replace(/"/g, "")}"`);
  return reply.send(fs.createReadStream(item.path));
});

app.post("/api/storage/pools/:name/content/delete", async (req, reply) => {
  requireUiSection(req, "storageOverview");
  const { name } = req.params as { name: string };
  const { itemPath } = (req.body as { itemPath?: string }) ?? {};
  if (!itemPath) return reply.status(400).send({ error: "itemPath is required" });

  const { item } = await resolvePoolContentItem(name, itemPath);
  await deletePoolContentItem(name, item);

  auditLog(db, {
    userId: req.session.userId!,
    username: req.session.username,
    ip: getClientIp(req),
    action: "storage.pool_content.delete",
    resourceType: "storage-file",
    resourceName: item.name,
    result: "success",
    details: name,
  });
  return { ok: true };
});

app.delete("/api/storage/pools/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(name) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Pool not found" });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "storage.pool.delete", label: `Delete storage pool ${name}`, resourceType: "storage", resourceName: name, message: `Path: ${pool.path}` });
  return runInstantTask(task, ip, async () => {
    await callRunner("storage_pool_umount", { path: pool.path });
    db.prepare("DELETE FROM storage_pools WHERE name = ?").run(name);
    return { ok: true };
  });
});

app.get("/api/storage/vm-disks/available", async (req, reply) => {
  requireAuth(req, reply);
  const userId = req.session.userId!;
  const role = req.session.role!;
  const canAttachVmDisk = role === "ADMIN"
    || (db.prepare("SELECT vm_name FROM qemu_vms ORDER BY vm_name").all() as Array<{ vm_name: string }>)
      .some((row) => hasResourcePermission(userId, role, "vm", row.vm_name, "modify"));
  if (!canAttachVmDisk) return reply.status(403).send({ error: "Forbidden" });

  const [managedFiles, attachedSources] = await Promise.all([
    listManagedFiles(),
    listAttachedVmDiskSources(),
  ]);

  const visibleDisks = [];
  for (const entry of managedFiles) {
    if (entry.type !== "vm_disk") continue;
    if (role !== "ADMIN" && entry.ownerId && entry.ownerId !== userId && !entry.isPublic) continue;
    const fullPath = managedFileAbsolutePath(entry);
    if (!fullPath) continue;
    const realPath = await fs.promises.realpath(fullPath).catch(() => fullPath);
    if (attachedSources.has(realPath)) continue;
    visibleDisks.push({ ...entry, path: realPath });
  }

  return visibleDisks;
});

// ── ISO Routes ─────────────────────────────────────────────────────────────
app.get("/api/storage/isos", async (req, reply) => {
  requireUiSection(req, "isoLibrary");
  const managedFiles = await listManagedFiles();
  const userId = req.session.userId!;
  const role = req.session.role!;
  const hasVmMediaAccess = role === "ADMIN"
    || (db.prepare("SELECT vm_name FROM qemu_vms ORDER BY vm_name").all() as Array<{ vm_name: string }>)
      .some((row) => hasResourcePermission(userId, role, "vm", row.vm_name, "media"));
  return managedFiles.filter((entry) =>
    role === "ADMIN"
    || (entry.type === "iso" && hasVmMediaAccess)
    || !entry.ownerId
    || entry.ownerId === userId
    || entry.isPublic
  );
});

app.post("/api/storage/isos/upload", async (req, reply) => {
  requireAuth(req, reply);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_iso_upload");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const data = await req.file();
  if (!data) return reply.status(400).send({ error: "No file" });

  const fileType = resolveManagedFileType((data.fields.type as { value?: string } | undefined)?.value);
  const storagePool = (data.fields.storagePool as { value?: string } | undefined)?.value?.trim() || undefined;
  const filename = sanitizeManagedFilename(data.filename);
  if (!isAllowedManagedFile(filename, fileType)) {
    await data.file.resume(); // drain body before sending error response
    return reply.status(400).send({ error: `Unsupported file type for ${fileType}` });
  }

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "upload",
    action: "storage.file.upload",
    label: `Upload ${filename}`,
    resourceType: fileType,
    resourceName: filename,
    message: `Uploading to ${storagePool ?? "local"} storage`,
    detail: filename,
  });

  // Resolve pool BEFORE starting to consume the body so errors are reported cleanly
  let targetDir = getManagedStorageDir(fileType);
  if (storagePool) {
    const pool = resolveManagedStoragePool(storagePool);
    if (!pool) {
      await data.file.resume();
      updateTask(task.id, { status: "failed", error: "Storage pool not found" });
      return reply.status(404).send({ error: "Storage pool not found" });
    }
    const requiredContent = fileType === "docker_image"
      ? "template"
      : fileType === "lxc_template"
        ? "template"
        : fileType === "vm_disk"
          ? "disk"
          : "iso";
    if (!pool.content.includes(requiredContent)) {
      await data.file.resume();
      updateTask(task.id, { status: "failed", error: "Storage pool does not allow this file type" });
      return reply.status(400).send({ error: "Selected storage pool does not allow this file type" });
    }
    targetDir = pool.path;
  }
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destPath = path.join(targetDir, filename);

  return runInstantTask(task, ip, async () => {
    // Stream directly to destination (local or NAS) — no local temp copy
    const stream = fs.createWriteStream(destPath);
    try {
      await pipeline(data.file, stream);
    } catch (err) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw err;
    }
    await ensureLibvirtManagedFileAccess(destPath, fileType);
    const stat = fs.statSync(destPath);
    db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, ?, ?, ?, 0, ?)").run(
      filename,
      filename,
      fileType,
      stat.size,
      req.session.userId!,
      storagePool ?? null,
    );
    return { ok: true, filename, sizeBytes: stat.size, type: fileType, storagePool };
  });
});

app.post("/api/storage/isos/from-url", async (req, reply) => {
  requireAuth(req, reply);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_iso_upload");
  if (!permCheck.ok) return replyQuotaError(reply, permCheck);

  const { url, displayName, type, storagePool } = req.body as { url?: string; displayName?: string; type?: string; storagePool?: string };
  if (!url) return reply.status(400).send({ error: "URL is required" });

  try {
    const fileType = resolveManagedFileType(type);
    const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
      kind: "url-download",
      action: "storage.download.url",
      label: `Download ${displayName || url}`,
      resourceType: fileType,
      resourceName: displayName || url,
      message: "Downloading file",
      detail: displayName || url,
    });
    const ip = getClientIp(req);
    void saveManagedDownloadWithProgress(task.id, url, fileType, displayName, storagePool?.trim() || undefined)
      .then((download) => {
        db.prepare("INSERT OR REPLACE INTO iso_files (filename, display_name, type, size_bytes, owner_id, is_public, storage_pool) VALUES (?, ?, ?, ?, ?, 0, ?)").run(
          download.filename,
          displayName || download.filename,
          fileType,
          download.sizeBytes,
          req.session.userId!,
          storagePool?.trim() || null,
        );
        updateTask(task.id, {
          status: "completed",
          progressPercent: 100,
          bytesCurrent: download.sizeBytes,
          bytesTotal: download.sizeBytes,
          message: "Download completed",
          detail: download.filename,
          result: { ...download, type: fileType },
        });
        const completed = getTaskRecord(task.id);
        if (completed) writeTaskAudit(completed, ip);
      })
      .catch((error) => {
        updateTask(task.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Download failed",
          message: "Download failed",
        });
        const failed = getTaskRecord(task.id);
        if (failed) writeTaskAudit(failed, ip);
      });
    return sanitizeTask(task);
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : "Download failed" });
  }
});

app.post("/api/storage/isos/visibility", async (req, reply) => {
  requireAuth(req, reply);
  const { filename, type, isPublic } = req.body as { filename?: string; type?: string; isPublic?: boolean };
  const safeName = filename ? sanitizeManagedFilename(filename) : "";
  const fileType = resolveManagedFileType(type);
  if (!safeName) return reply.status(400).send({ error: "Filename is required" });

  const row = db.prepare("SELECT owner_id FROM iso_files WHERE filename = ? AND type = ?").get(safeName, fileType) as { owner_id: number | null } | undefined;
  if (!row) return reply.status(404).send({ error: "Managed file not found" });

  const isOwner = row.owner_id !== null && row.owner_id === req.session.userId!;
  if (req.session.role !== "ADMIN" && !isOwner) {
    return reply.status(403).send({ error: "Forbidden" });
  }

  db.prepare("UPDATE iso_files SET is_public = ? WHERE filename = ? AND type = ?").run(isPublic ? 1 : 0, safeName, fileType);
  auditLog(db, {
    userId: req.session.userId!,
    username: req.session.username,
    ip: getClientIp(req),
    action: "storage.iso.visibility",
    resourceType: "storage-file",
    resourceName: safeName,
    result: "success",
    details: `${fileType}:${isPublic ? "public" : "private"}`,
  });
  return { ok: true };
});

app.delete("/api/storage/isos/:filename", async (req, reply) => {
  requireAuth(req, reply);
  const { filename } = req.params as { filename: string };
  const fileType = resolveManagedFileType((req.query as { type?: string }).type);
  const permCheck = checkPermission(db, req.session.userId!, req.session.role!, "allow_iso_delete");
  if (!permCheck.ok && req.session.role !== "ADMIN") return replyQuotaError(reply, permCheck);
  const safeName = sanitizeManagedFilename(filename);
  const fileRow = db.prepare("SELECT storage_pool FROM iso_files WHERE filename = ? AND type = ?").get(safeName, fileType) as { storage_pool: string | null } | undefined;
  let managedDir = getManagedStorageDir(fileType);
  if (fileRow?.storage_pool) {
    const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(fileRow.storage_pool) as { path: string } | undefined;
    if (pool) managedDir = pool.path;
  }
  const fullPath = path.join(managedDir, safeName);
  const realPath = await fs.promises.realpath(fullPath).catch(() => null);
  if (!realPath || !realPath.startsWith(managedDir)) return reply.status(400).send({ error: "Invalid path" });
  if (fileType === "vm_disk") {
    const attachedVm = await isManagedVmDiskAttached(realPath);
    if (attachedVm) {
      return reply.status(409).send({ error: `Disk image is attached to VM ${attachedVm}` });
    }
  }
  await fs.promises.unlink(realPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  db.prepare("DELETE FROM iso_files WHERE filename = ? AND type = ?").run(safeName, fileType);
  return { ok: true };
});

// ── Firewall Routes ────────────────────────────────────────────────────────
app.get("/api/firewall/status", async (req, reply) => {
  requireUiSection(req, "firewall");
  const runnerStatus = await callRunner<{ backend: "iptables"; enabled: boolean; sshPort: number; protectSsh: boolean; protectedPorts: number[] }>("network_firewall_status");
  const rules = await listEffectiveFirewallRules();
  const lastApplied = db.prepare("SELECT value FROM settings WHERE key = 'firewall.lastAppliedAt'").get() as { value?: string } | undefined;
  return {
    enabled: getBooleanSetting("firewall.enabled", false),
    backend: runnerStatus.backend,
    protectedPorts: runnerStatus.protectedPorts,
    sshPort: runnerStatus.sshPort,
    protectSsh: getBooleanSetting("firewall.protectSsh", true),
    rulesCount: rules.length,
    autoRulesCount: rules.filter((rule) => rule.sourceKind === "auto").length,
    manualRulesCount: rules.filter((rule) => rule.sourceKind === "manual").length,
    lastAppliedAt: lastApplied?.value,
  };
});

app.get("/api/firewall/rules", async (req, reply) => {
  const { linkedResourceType, linkedResourceName } = req.query as { linkedResourceType?: string; linkedResourceName?: string };
  if (linkedResourceType && linkedResourceName) {
    const resourceType = parseResourceAclType(linkedResourceType);
    requireResourcePermission(req, resourceType, linkedResourceName, "view");
  } else {
    requireUiSection(req, "firewall");
  }
  return listEffectiveFirewallRules({ linkedResourceType, linkedResourceName });
});

app.put("/api/firewall/settings", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = FirewallSettingsSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "firewall.settings.update", label: "Update firewall settings", resourceType: "firewall", resourceName: "host", message: `Enabled: ${parsed.data.enabled}` });
  return runInstantTask(task, ip, async () => {
    setSetting("firewall.enabled", parsed.data.enabled ? "1" : "0");
    if (parsed.data.protectSsh !== undefined) {
      setSetting("firewall.protectSsh", parsed.data.protectSsh ? "1" : "0");
    }
    await syncFirewallState();
    return { ok: true };
  });
});

app.post("/api/firewall/sync", async (req, reply) => {
  requireAdmin(req, reply);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "firewall.sync", label: "Sync firewall rules", resourceType: "firewall", resourceName: "host", message: "Applying firewall rules" });
  return runInstantTask(task, ip, async () => {
    await syncFirewallState();
    return { ok: true };
  });
});

app.post("/api/firewall/rules", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = FirewallRuleSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const label = `${parsed.data.protocol}/${parsed.data.hostPort}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "firewall.rule.create", label: `Create firewall rule ${label}`, resourceType: "firewall", resourceName: label, message: parsed.data.description ?? parsed.data.relation ?? label });
  return runInstantTask(task, ip, async () => {
    const result = db.prepare(`
      INSERT INTO firewall_rules (
        enabled, source_kind, rule_type, protocol, host_port, target_ip, target_port, source_cidr,
        description, linked_resource_type, linked_resource_name, relation, created_by, updated_at
      ) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      parsed.data.enabled ? 1 : 0,
      parsed.data.type,
      parsed.data.protocol,
      parsed.data.hostPort,
      parsed.data.targetIp ?? null,
      parsed.data.targetPort ?? null,
      parsed.data.sourceCidr ?? null,
      parsed.data.description ?? null,
      parsed.data.linkedResourceType ?? null,
      parsed.data.linkedResourceName ?? null,
      parsed.data.relation ?? null,
      req.session.userId!,
    );
    await syncFirewallState();
    return { ok: true, id: result.lastInsertRowid };
  });
});

app.put("/api/firewall/rules/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = FirewallRuleSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const id = parseInt((req.params as { id: string }).id, 10);
  const ip = getClientIp(req);
  const label = `${parsed.data.protocol}/${parsed.data.hostPort}`;
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "action", action: "firewall.rule.update", label: `Update firewall rule ${label}`, resourceType: "firewall", resourceName: label, message: parsed.data.description ?? parsed.data.relation ?? label });
  return runInstantTask(task, ip, async () => {
    db.prepare(`
      UPDATE firewall_rules
      SET enabled = ?, rule_type = ?, protocol = ?, host_port = ?, target_ip = ?, target_port = ?, source_cidr = ?,
          description = ?, linked_resource_type = ?, linked_resource_name = ?, relation = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.enabled ? 1 : 0,
      parsed.data.type,
      parsed.data.protocol,
      parsed.data.hostPort,
      parsed.data.targetIp ?? null,
      parsed.data.targetPort ?? null,
      parsed.data.sourceCidr ?? null,
      parsed.data.description ?? null,
      parsed.data.linkedResourceType ?? null,
      parsed.data.linkedResourceName ?? null,
      parsed.data.relation ?? null,
      id,
    );
    await syncFirewallState();
    return { ok: true };
  });
});

app.delete("/api/firewall/rules/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const id = parseInt((req.params as { id: string }).id, 10);
  const rule = db.prepare("SELECT protocol, host_port FROM firewall_rules WHERE id = ?").get(id) as { protocol?: string; host_port?: number } | undefined;
  const label = rule?.host_port ? `${rule.protocol ?? "tcp"}/${rule.host_port}` : String(id);
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "firewall.rule.delete", label: `Delete firewall rule ${label}`, resourceType: "firewall", resourceName: label, message: "Deleting rule" });
  return runInstantTask(task, ip, async () => {
    db.prepare("DELETE FROM firewall_rules WHERE id = ?").run(id);
    await syncFirewallState();
    return { ok: true };
  });
});

// ── Network Routes ─────────────────────────────────────────────────────────
app.get("/api/network/bridges", async (req, reply) => {
  requireAuth(req, reply);
  return callRunner("network_bridges_list");
});

app.post("/api/network/bridges", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = CreateBridgeSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "network.bridge.create", label: `Create bridge ${parsed.data.name}`, resourceType: "network", resourceName: parsed.data.name, message: `Creating network bridge` });
  return runInstantTask(task, ip, () => callRunner("network_bridge_create", parsed.data));
});

app.delete("/api/network/bridges/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "network.bridge.delete", label: `Delete bridge ${name}`, resourceType: "network", resourceName: name, message: "Deleting bridge" });
  return runInstantTask(task, ip, () => callRunner("network_bridge_delete", { name }));
});

app.get("/api/network/nat", async (req, reply) => {
  requireUiSection(req, "network");
  return callRunner("network_nat_list");
});

app.post("/api/network/nat", async (req, reply) => {
  requireAdmin(req, reply);
  const ip = getClientIp(req);
  const body = req.body as { name?: string };
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "create", action: "network.nat.create", label: `Create NAT network ${body?.name ?? ""}`, resourceType: "network", resourceName: body?.name ?? "nat", message: "Creating NAT network" });
  return runInstantTask(task, ip, () => callRunner("network_nat_create", body));
});

app.delete("/api/network/nat/:name", async (req, reply) => {
  requireAdmin(req, reply);
  const { name } = req.params as { name: string };
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", { kind: "delete", action: "network.nat.delete", label: `Delete NAT network ${name}`, resourceType: "network", resourceName: name, message: "Deleting NAT network" });
  return runInstantTask(task, ip, () => callRunner("network_nat_delete", { name }));
});

app.get("/api/network/interfaces", async (req, reply) => {
  requireUiSection(req, "network");
  return callRunner("network_interfaces_list");
});

// ── Users Routes ───────────────────────────────────────────────────────────
app.get("/api/users", async (req, reply) => {
  requireAdmin(req, reply);
  const rows = db.prepare("SELECT id, username, role, display_name, email, suspended, must_change_password, permissions, created_at FROM users ORDER BY username").all() as Array<{
    id: number;
    username: string;
    role: "ADMIN" | "USER";
    display_name: string | null;
    email: string | null;
    suspended: number;
    must_change_password: number;
    permissions: string | null;
    created_at: string;
  }>;
  // Aggregate resource counts per user from ACL table
  const aclCounts = db.prepare(`
    SELECT user_id,
      SUM(CASE WHEN resource_type = 'vm' THEN 1 ELSE 0 END) AS vm_count,
      SUM(CASE WHEN resource_type = 'lxc' THEN 1 ELSE 0 END) AS lxc_count,
      SUM(CASE WHEN resource_type = 'docker' THEN 1 ELSE 0 END) AS docker_count
    FROM user_resource_acl
    GROUP BY user_id
  `).all() as Array<{ user_id: number; vm_count: number; lxc_count: number; docker_count: number }>;
  const countMap = new Map(aclCounts.map((r) => [r.user_id, r]));
  return rows.map((row) => {
    const base = mapUserRow(row);
    const counts = countMap.get(row.id);
    return {
      ...base,
      vmCount: counts?.vm_count ?? 0,
      lxcCount: counts?.lxc_count ?? 0,
      dockerCount: counts?.docker_count ?? 0,
    };
  });
});

app.post("/api/users", async (req, reply) => {
  requireAdmin(req, reply);
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(parsed.data.username);
  if (existing) return reply.status(409).send({ error: "Username already exists" });
  const hash = await argon2.hash(parsed.data.password);
  const result = db.prepare("INSERT INTO users (username, password_hash, role, display_name, email) VALUES (?, ?, ?, ?, ?)").run(parsed.data.username, hash, parsed.data.role, parsed.data.displayName ?? null, parsed.data.email ?? null);
  if (parsed.data.role === "USER") {
    db.prepare(`
      INSERT INTO user_limits (
        user_id,
        max_vms,
        max_lxc,
        max_docker,
        max_storage_gb,
        allow_vm_create,
        allow_vm_delete,
        allow_vm_modify,
        allow_lxc_create,
        allow_lxc_delete,
        allow_docker_create,
        allow_docker_delete,
        allow_iso_upload,
        allow_iso_delete,
        allow_storage_manage,
        allow_network_manage
      ) VALUES (?, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    `).run(result.lastInsertRowid);
  }
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "user.create", resourceType: "user", resourceName: parsed.data.username, result: "success", details: `role=${parsed.data.role ?? "USER"}` });
  return { ok: true, id: result.lastInsertRowid };
});

app.get("/api/users/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const row = db.prepare("SELECT id, username, role, display_name, email, suspended, must_change_password, permissions, created_at FROM users WHERE id = ?").get(parseInt(id, 10)) as {
    id: number;
    username: string;
    role: "ADMIN" | "USER";
    display_name: string | null;
    email: string | null;
    suspended: number;
    must_change_password: number;
    permissions: string | null;
    created_at: string;
  } | undefined;
  if (!row) return reply.status(404).send({ error: "User not found" });
  return mapUserRow(row);
});

app.put("/api/users/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const userId = parseInt(id, 10);
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  db.prepare(`
    UPDATE users
    SET
      display_name = COALESCE(?, display_name),
      email = COALESCE(?, email),
      role = COALESCE(?, role),
      must_change_password = COALESCE(?, must_change_password)
    WHERE id = ?
  `).run(
    parsed.data.displayName ?? null,
    parsed.data.email ?? null,
    parsed.data.role ?? null,
    parsed.data.mustChangePassword === undefined ? null : (parsed.data.mustChangePassword ? 1 : 0),
    userId,
  );
  const effectiveRole = (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: "ADMIN" | "USER" } | undefined)?.role;
  if (effectiveRole === "USER") {
    db.prepare("INSERT OR IGNORE INTO user_limits (user_id) VALUES (?)").run(userId);
  }
  const targetUsername = (db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username?: string } | undefined)?.username;
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "user.update", resourceType: "user", resourceName: targetUsername ?? String(userId), result: "success", details: parsed.data.role ? `role=${parsed.data.role}` : undefined });
  return { ok: true };
});

app.delete("/api/users/:id", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  if (parseInt(id) === req.session.userId!) return reply.status(400).send({ error: "Cannot delete yourself" });
  const targetUsername = (db.prepare("SELECT username FROM users WHERE id = ?").get(parseInt(id)) as { username?: string } | undefined)?.username;
  db.prepare("DELETE FROM users WHERE id = ?").run(parseInt(id));
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "user.delete", resourceType: "user", resourceName: targetUsername ?? String(id), result: "success" });
  return { ok: true };
});

app.put("/api/users/:id/password", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const body = req.body as { password?: string; newPassword?: string };
  const password = body.newPassword ?? body.password;
  const policyCheck = validatePassword(password);
  if (!policyCheck.ok) {
    return reply.status(400).send({ error: policyCheck.error });
  }
  const hash = await argon2.hash(password!);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hash, parseInt(id, 10));
  const targetUsername = (db.prepare("SELECT username FROM users WHERE id = ?").get(parseInt(id, 10)) as { username?: string } | undefined)?.username;
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "user.password-reset", resourceType: "user", resourceName: targetUsername ?? String(id), result: "success" });
  return { ok: true };
});

app.put("/api/users/:id/suspend", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const { suspended } = req.body as { suspended: boolean };
  db.prepare("UPDATE users SET suspended = ? WHERE id = ?").run(suspended ? 1 : 0, parseInt(id));
  const targetUsername = (db.prepare("SELECT username FROM users WHERE id = ?").get(parseInt(id)) as { username?: string } | undefined)?.username;
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: suspended ? "user.suspend" : "user.unsuspend", resourceType: "user", resourceName: targetUsername ?? String(id), result: "success" });
  return { ok: true };
});

app.get("/api/users/:id/limits", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const row = db.prepare("SELECT * FROM user_limits WHERE user_id = ?").get(parseInt(id)) as Record<string, number> | undefined;
  return { userId: parseInt(id, 10), ...mapUserLimitsRow(row) };
});

app.put("/api/users/:id/limits", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const userId = parseInt(id);
  const parsed = UpdateUserLimitsSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

  const existing = db.prepare("SELECT user_id FROM user_limits WHERE user_id = ?").get(userId);
  if (!existing) {
    db.prepare("INSERT INTO user_limits (user_id) VALUES (?)").run(userId);
  }

  const updates = Object.entries(parsed.data).filter(([, v]) => v !== undefined).map(([k]) => {
    const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return col;
  });

  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    db.prepare(`UPDATE user_limits SET ${col} = ? WHERE user_id = ?`).run(typeof value === "boolean" ? (value ? 1 : 0) : value, userId);
  }

  db.prepare("UPDATE user_limits SET updated_at = datetime('now') WHERE user_id = ?").run(userId);

  return { ok: true };
});

app.get("/api/resources/catalog", async (req, reply) => {
  requireAdmin(req, reply);
  return listResourceCatalog();
});

app.get("/api/resources/acl-summary", async (req, reply) => {
  requireAdmin(req, reply);
  return db.prepare(`
    SELECT
      resource_type AS resourceType,
      resource_name AS resourceName,
      COUNT(*) AS entryCount
    FROM user_resource_acl
    GROUP BY resource_type, resource_name
    ORDER BY resource_type, resource_name
  `).all() as Array<{ resourceType: ResourceAclType; resourceName: string; entryCount: number }>;
});

app.get("/api/resources/:resourceType/:resourceName/acl", async (req, reply) => {
  requireAuth(req, reply);
  const { resourceType: rawType, resourceName } = req.params as { resourceType: string; resourceName: string };
  const resourceType = parseResourceAclType(rawType);
  requireResourceAclAdmin(req, resourceType, resourceName);

  const entries = db.prepare(`
    SELECT
      a.*,
      u.username,
      u.role,
      u.display_name,
      u.email
    FROM user_resource_acl a
    JOIN users u ON u.id = a.user_id
    WHERE a.resource_type = ? AND a.resource_name = ?
    ORDER BY u.username
  `).all(resourceType, resourceName) as Array<ResourceAclRow & {
    username: string;
    role: string;
    display_name: string | null;
    email: string | null;
  }>;

  const users = db.prepare("SELECT id, username, role, display_name, email FROM users ORDER BY username").all() as Array<{
    id: number;
    username: string;
    role: string;
    display_name: string | null;
    email: string | null;
  }>;

  return {
    entries: entries.map((entry) => ({
      ...mapAclRow(entry),
      username: entry.username,
      role: entry.role,
      displayName: entry.display_name,
      email: entry.email,
    })),
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      email: user.email,
    })),
  };
});

app.put("/api/resources/:resourceType/:resourceName/acl/:userId", async (req, reply) => {
  requireAuth(req, reply);
  const { resourceType: rawType, resourceName, userId: rawUserId } = req.params as { resourceType: string; resourceName: string; userId: string };
  const resourceType = parseResourceAclType(rawType);
  const userId = parseInt(rawUserId, 10);
  requireResourceAclAdmin(req, resourceType, resourceName);

  const parsed = UpdateUserResourceAclSchema.safeParse({
    entries: [{ ...((req.body as Record<string, unknown>) ?? {}), resourceType, resourceName }],
  });
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const entry = parsed.data.entries[0];

  const anyEnabled =
    entry.canView ||
    entry.canConsole ||
    entry.canPower ||
    entry.canMedia ||
    entry.canModify ||
    entry.canDelete ||
    entry.canBackup ||
    entry.canSnapshot ||
    entry.canAdmin;

  if (!anyEnabled) {
    db.prepare("DELETE FROM user_resource_acl WHERE user_id = ? AND resource_type = ? AND resource_name = ?").run(userId, resourceType, resourceName);
    return { ok: true };
  }

  db.prepare(`
    INSERT INTO user_resource_acl (
      user_id, resource_type, resource_name, can_view, can_console, can_power,
      can_media, can_modify, can_delete, can_backup, can_snapshot, can_admin, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, resource_type, resource_name) DO UPDATE SET
      can_view = excluded.can_view,
      can_console = excluded.can_console,
      can_power = excluded.can_power,
      can_media = excluded.can_media,
      can_modify = excluded.can_modify,
      can_delete = excluded.can_delete,
      can_backup = excluded.can_backup,
      can_snapshot = excluded.can_snapshot,
      can_admin = excluded.can_admin,
      updated_at = datetime('now')
  `).run(
    userId,
    resourceType,
    resourceName,
    entry.canView ? 1 : 0,
    entry.canConsole ? 1 : 0,
    entry.canPower ? 1 : 0,
    entry.canMedia ? 1 : 0,
    entry.canModify ? 1 : 0,
    entry.canDelete ? 1 : 0,
    entry.canBackup ? 1 : 0,
    entry.canSnapshot ? 1 : 0,
    entry.canAdmin ? 1 : 0,
  );

  securityLog(db, {
    userId: req.session.userId!,
    username: req.session.username,
    ip: getClientIp(req),
    action: "resource.acl.upsert",
    resourceType,
    resourceName,
    result: "success",
    details: `user=${userId}`,
  });
  return { ok: true };
});

app.delete("/api/resources/:resourceType/:resourceName/acl/:userId", async (req, reply) => {
  requireAuth(req, reply);
  const { resourceType: rawType, resourceName, userId: rawUserId } = req.params as { resourceType: string; resourceName: string; userId: string };
  const resourceType = parseResourceAclType(rawType);
  const userId = parseInt(rawUserId, 10);
  requireResourceAclAdmin(req, resourceType, resourceName);
  db.prepare("DELETE FROM user_resource_acl WHERE user_id = ? AND resource_type = ? AND resource_name = ?").run(userId, resourceType, resourceName);
  securityLog(db, {
    userId: req.session.userId!,
    username: req.session.username,
    ip: getClientIp(req),
    action: "resource.acl.delete",
    resourceType,
    resourceName,
    result: "success",
    details: `user=${userId}`,
  });
  return { ok: true };
});

app.get("/api/users/:id/acl", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const userId = parseInt(id, 10);
  const rows = db
    .prepare("SELECT * FROM user_resource_acl WHERE user_id = ? ORDER BY resource_type, resource_name")
    .all(userId) as ResourceAclRow[];
  return rows.map(mapAclRow);
});

app.put("/api/users/:id/acl", async (req, reply) => {
  requireAdmin(req, reply);
  const { id } = req.params as { id: string };
  const userId = parseInt(id, 10);
  const parsed = UpdateUserResourceAclSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

  const replace = db.prepare(`
    INSERT INTO user_resource_acl (
      user_id, resource_type, resource_name, can_view, can_console, can_power,
      can_media, can_modify, can_delete, can_backup, can_snapshot, can_admin, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, resource_type, resource_name) DO UPDATE SET
      can_view = excluded.can_view,
      can_console = excluded.can_console,
      can_power = excluded.can_power,
      can_media = excluded.can_media,
      can_modify = excluded.can_modify,
      can_delete = excluded.can_delete,
      can_backup = excluded.can_backup,
      can_snapshot = excluded.can_snapshot,
      can_admin = excluded.can_admin,
      updated_at = datetime('now')
  `);

  const incomingKeys = new Set(parsed.data.entries.map((entry) => `${entry.resourceType}:${entry.resourceName}`));
  const existingRows = db.prepare("SELECT resource_type, resource_name FROM user_resource_acl WHERE user_id = ?").all(userId) as Array<{ resource_type: ResourceAclType; resource_name: string }>;
  for (const row of existingRows) {
    const key = `${row.resource_type}:${row.resource_name}`;
    if (!incomingKeys.has(key)) {
      db.prepare("DELETE FROM user_resource_acl WHERE user_id = ? AND resource_type = ? AND resource_name = ?").run(userId, row.resource_type, row.resource_name);
    }
  }

  for (const entry of parsed.data.entries) {
    const anyEnabled = entry.canView || entry.canConsole || entry.canPower || entry.canMedia || entry.canModify || entry.canDelete || entry.canBackup || entry.canSnapshot || entry.canAdmin;
    if (!anyEnabled) continue;
    replace.run(
      userId,
      entry.resourceType,
      entry.resourceName,
      entry.canView ? 1 : 0,
      entry.canConsole ? 1 : 0,
      entry.canPower ? 1 : 0,
      entry.canMedia ? 1 : 0,
      entry.canModify ? 1 : 0,
      entry.canDelete ? 1 : 0,
      entry.canBackup ? 1 : 0,
      entry.canSnapshot ? 1 : 0,
      entry.canAdmin ? 1 : 0,
    );
  }

  securityLog(db, {
    userId: req.session.userId!,
    username: req.session.username,
    ip: getClientIp(req),
    action: "user.acl.update",
    resourceType: "user",
    resourceName: String(userId),
    result: "success",
    details: `${parsed.data.entries.length} ACL entries`,
  });
  return { ok: true };
});

app.get("/api/account", async (req, reply) => {
  requireAuth(req, reply);
  return db.prepare("SELECT id, username, role, display_name, email FROM users WHERE id = ?").get(req.session.userId!);
});

app.put("/api/account", async (req, reply) => {
  requireAuth(req, reply);
  const { displayName, email } = req.body as { displayName?: string; email?: string };
  db.prepare("UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email) WHERE id = ?").run(displayName ?? null, email ?? null, req.session.userId!);
  return { ok: true };
});

app.get("/api/backups", async (req, reply) => {
  requireAuth(req, reply);
  const { resourceType, resourceName } = req.query as { resourceType?: string; resourceName?: string };
  if (!resourceType && !resourceName) {
    requireUiSection(req, "backups");
  }
  if (resourceType && resourceName && (resourceType === "vm" || resourceType === "lxc")) {
    requireResourcePermission(req, resourceType, resourceName, "view");
  }
  const localRows = listLocalBackupRows(resourceType, resourceName).map((row) => mapBackupRow(row, getLocalNodeName()));
  const remoteRows = await Promise.all(
    listDatacenterNodes()
      .filter((node) => !node.isLocal && node.enabled)
      .map(async (node) => {
        try {
          return await fetchRemoteNode<BackupApiEntry[]>(
            node,
            `/api/internal/backups?resourceType=${encodeURIComponent(resourceType ?? "")}&resourceName=${encodeURIComponent(resourceName ?? "")}`,
          );
        } catch {
          return [] as BackupApiEntry[];
        }
      }),
  );

  return [...localRows, ...remoteRows.flat()]
    .filter((row) => hasResourcePermission(req.session.userId!, req.session.role!, row.resourceType, row.resourceName, "view"))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
});

app.post("/api/backups/upload", async (req, reply) => {
  requireAuth(req, reply);
  requireUiSection(req, "backups");
  const data = await req.file();
  if (!data) return reply.status(400).send({ error: "No file" });

  const storagePool = (data.fields.storagePool as { value?: string } | undefined)?.value;
  const resourceType = ((data.fields.resourceType as { value?: string } | undefined)?.value ?? "vm") as BackupResourceType;
  const resourceName = (data.fields.resourceName as { value?: string } | undefined)?.value?.trim() || path.basename(data.filename, path.extname(data.filename));
  const requestedFormat = (data.fields.format as { value?: string } | undefined)?.value;

  if (!storagePool) return reply.status(400).send({ error: "Storage pool is required" });
  if (resourceType !== "vm" && resourceType !== "lxc") return reply.status(400).send({ error: "Invalid backup resource type" });

  const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
  if (!pool) return reply.status(404).send({ error: "Storage pool not found" });

  const filename = sanitizeManagedFilename(data.filename);
  if (!isAllowedBackupFile(filename, resourceType)) {
    return reply.status(400).send({ error: `Unsupported backup file type for ${resourceType}` });
  }

  const format = normalizeBackupFormat(filename, resourceType, requestedFormat);
  const backupDir = path.join(pool.path, "backups");
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "backup-upload",
    action: "backup.upload",
    label: `Upload ${resourceType.toUpperCase()} backup ${filename}`,
    resourceType,
    resourceName,
    message: "Uploading backup",
    detail: filename,
  });

  fs.mkdirSync(backupDir, { recursive: true });
  const destPath = path.join(backupDir, filename);
  const totalBytes = Number((data.fields.size as { value?: string } | undefined)?.value ?? 0) || undefined;

  try {
    updateTask(task.id, { status: "running", progressPercent: 5, bytesTotal: totalBytes });
    // Stream directly to destination (local or NAS) — no local temp copy
    const stream = fs.createWriteStream(destPath);
    let written = 0;
    data.file.on("data", (chunk: Buffer) => {
      written += chunk.length;
      const percent = totalBytes ? Math.min(95, Math.max(5, Math.round((written / totalBytes) * 100))) : 50;
      updateTask(task.id, {
        progressPercent: percent,
        bytesCurrent: written,
        bytesTotal: totalBytes,
        detail: filename,
      });
    });
    await new Promise<void>((resolve, reject) => {
      data.file.pipe(stream);
      stream.on("finish", resolve);
      stream.on("error", reject);
      data.file.on("error", reject);
    });
    const stat = fs.statSync(destPath);
    const result = db.prepare(`
      INSERT INTO backups (resource_type, resource_name, filename, storage_pool, size_bytes, format, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(resourceType, resourceName, filename, storagePool, stat.size, format, req.session.userId!);
    updateTask(task.id, {
      status: "completed",
      progressPercent: 100,
      bytesCurrent: stat.size,
      bytesTotal: stat.size,
      message: "Backup uploaded",
      detail: filename,
    });
    const completed = getTaskRecord(task.id);
    if (completed) writeTaskAudit(completed, ip);
    return { ...sanitizeTask(completed ?? task), backupId: result.lastInsertRowid, filename, sizeBytes: stat.size, format };
  } catch (error) {
    await fs.promises.unlink(destPath).catch(() => {});
    const message = error instanceof Error ? error.message : "Backup upload failed";
    updateTask(task.id, {
      status: "failed",
      error: message,
      detail: message,
      message: "Backup upload failed",
    });
    const failed = getTaskRecord(task.id);
    if (failed) writeTaskAudit(failed, ip);
    return reply.status(500).send(sanitizeTask(failed ?? task));
  }
});

app.delete("/api/backups/:id", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const ref = parseBackupRef(id);
  const node = listDatacenterNodes().find((entry) => entry.name === ref.nodeName);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  const backup = node.isLocal
    ? getBackupRow(ref.backupId)
    : await fetchRemoteNode<BackupApiEntry | { error: string }>(node, `/api/internal/backups/${ref.backupId}`).catch(() => undefined);
  if (!backup || ("error" in backup && backup.error)) return reply.status(404).send({ error: "Backup not found" });
  const backupRecord = backup as BackupApiEntry | BackupRow;
  const backupType = "resource_type" in backupRecord ? backupRecord.resource_type : backupRecord.resourceType;
  const backupName = "resource_name" in backupRecord ? backupRecord.resource_name : backupRecord.resourceName;
  const backupFilename = backupRecord.filename;
  requireResourcePermission(req, backupType as ResourceAclType, backupName, "backup");

  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "backup-delete",
    action: "backup.delete",
    label: `Delete ${backupType.toUpperCase()} backup ${backupFilename}`,
    resourceType: backupType,
    resourceName: backupName,
    message: "Deleting backup",
    detail: backupFilename,
  });

  try {
    updateTask(task.id, { status: "running", progressPercent: 20 });
    if (node.isLocal) {
      const localBackup = backup as BackupRow;
      const { fullPath } = resolveBackupPath(localBackup);
      await fs.promises.unlink(fullPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      db.prepare("DELETE FROM backups WHERE id = ?").run(localBackup.id);
    } else {
      await fetchRemoteNode(node, `/api/internal/backups/${ref.backupId}`, { method: "DELETE" });
    }
    updateTask(task.id, {
      status: "completed",
      progressPercent: 100,
      message: "Backup deleted",
      detail: backupFilename,
    });
    const completed = getTaskRecord(task.id);
    if (completed) writeTaskAudit(completed, ip);
    return sanitizeTask(completed ?? task);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backup deletion failed";
    updateTask(task.id, {
      status: "failed",
      error: message,
      detail: message,
      message: "Backup deletion failed",
    });
    const failed = getTaskRecord(task.id);
    if (failed) writeTaskAudit(failed, ip);
    return reply.status(500).send(sanitizeTask(failed ?? task));
  }
});

app.post("/api/backups/:id/restore", async (req, reply) => {
  requireAuth(req, reply);
  const { id } = req.params as { id: string };
  const ref = parseBackupRef(id);
  const node = listDatacenterNodes().find((entry) => entry.name === ref.nodeName);
  if (!node) return reply.status(404).send({ error: "Node not found" });
  const backup = node.isLocal
    ? getBackupRow(ref.backupId)
    : await fetchRemoteNode<BackupApiEntry | { error: string }>(node, `/api/internal/backups/${ref.backupId}`).catch(() => undefined);
  if (!backup || ("error" in backup && backup.error)) return reply.status(404).send({ error: "Backup not found" });
  const backupRecord = backup as BackupApiEntry | BackupRow;
  const backupType = "resource_type" in backupRecord ? backupRecord.resource_type : backupRecord.resourceType;
  const backupName = "resource_name" in backupRecord ? backupRecord.resource_name : backupRecord.resourceName;
  const backupFilename = backupRecord.filename;
  const backupStoragePool = "storage_pool" in backupRecord ? backupRecord.storage_pool : backupRecord.storagePool;
  requireResourcePermission(req, backupType as ResourceAclType, backupName, "backup");

  const payload = (req.body as Record<string, unknown> | undefined) ?? {};
  const ip = getClientIp(req);

  if (backupType === "vm") {
    const name = String(payload.name ?? "").trim();
    const storagePool = String(payload.storagePool ?? backupStoragePool).trim();
    if (!name) return reply.status(400).send({ error: "VM name is required" });

    const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
      kind: "vm-restore",
      action: "vm.backup.restore",
      label: `Restore VM backup ${backupFilename}`,
      resourceType: "vm",
      resourceName: name,
      message: "Restoring VM backup",
      detail: backupFilename,
    });
    void runTrackedTask(task, ip, async ({ update }) => {
      update({ progressPercent: 20, detail: backupFilename });
      let result: unknown;
      if (node.isLocal) {
        const localBackup = backup as BackupRow;
        const { fullPath } = resolveBackupPath(localBackup);
        const pool = db.prepare("SELECT path FROM storage_pools WHERE name = ?").get(storagePool) as { path: string } | undefined;
        if (!pool) throw new Error("Storage pool not found");
        const vmRestoreParams: Record<string, unknown> = {
          sourcePath: fullPath,
          storagePool: pool.path,
          name,
          bridge: payload.bridge ?? "virbr0",
          mac: payload.mac,
          arch: payload.arch ?? "x86_64",
          machine: payload.machine ?? "q35",
          uefi: payload.uefi ?? false,
          bootDevice: payload.bootDevice ?? "hd",
          videoModel: payload.videoModel ?? "virtio",
          autostart: payload.autostart ?? false,
        };
        // Only override CPU/RAM when the restore explicitly modifies them;
        // otherwise the VM keeps its original resources from the backup XML.
        if (typeof payload.vcpus === "number") vmRestoreParams.vcpus = payload.vcpus;
        if (typeof payload.memoryMb === "number") vmRestoreParams.memoryMb = payload.memoryMb;
        result = await callRunner("qemu_restore_backup", vmRestoreParams, BACKUP_TIMEOUT_MS);
        db.prepare("INSERT OR IGNORE INTO qemu_vms (vm_name, user_id, node_name) VALUES (?, ?, ?)").run(name, req.session.userId!, getLocalNodeName());
      } else {
        result = await fetchRemoteNode(node, `/api/internal/backups/${ref.backupId}/restore`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      update({ progressPercent: 100, message: "VM backup restored", detail: backupFilename });
      return result;
    });
    return sanitizeTask(task);
  }

  const name = String(payload.name ?? "").trim();
  if (!name) return reply.status(400).send({ error: "Container name is required" });
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "lxc-restore",
    action: "lxc.backup.restore",
    label: `Restore LXC backup ${backupFilename}`,
    resourceType: "lxc",
    resourceName: name,
    message: "Restoring LXC backup",
    detail: backupFilename,
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    update({ progressPercent: 20, detail: backupFilename });
    let result: unknown;
    if (node.isLocal) {
      const localBackup = backup as BackupRow;
      const { fullPath } = resolveBackupPath(localBackup);
      const lxcRestoreParams: Record<string, unknown> = {
        sourcePath: fullPath,
        name,
        bridge: payload.bridge ?? "lxcbr0",
        macAddress: payload.macAddress,
        ipv4: payload.ipv4,
        ipv4Gateway: payload.ipv4Gateway,
        dnsServers: Array.isArray(payload.dnsServers) ? payload.dnsServers : [],
        autostart: payload.autostart ?? false,
      };
      // Only override CPU/RAM when the restore explicitly modifies them;
      // otherwise the container keeps its original cgroup limits.
      if (typeof payload.cpuCores === "number") lxcRestoreParams.cpuCores = payload.cpuCores;
      if (typeof payload.memoryMb === "number") lxcRestoreParams.memoryMb = payload.memoryMb;
      result = await callRunner("lxc_restore_backup", lxcRestoreParams, BACKUP_TIMEOUT_MS);
      db.prepare("INSERT OR IGNORE INTO lxc_containers (container_name, user_id, description, node_name) VALUES (?, ?, ?, ?)").run(name, req.session.userId!, null, getLocalNodeName());
    } else {
      result = await fetchRemoteNode(node, `/api/internal/backups/${ref.backupId}/restore`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    update({ progressPercent: 100, message: "LXC backup restored", detail: backupFilename });
    return result;
  });
  return sanitizeTask(task);
});

// ── Audit Logs ─────────────────────────────────────────────────────────────
app.get("/api/audit-logs", async (req, reply) => {
  requireAdmin(req, reply);
  const q = req.query as { page?: string; limit?: string; offset?: string; action?: string; category?: string };
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
  const page = Math.max(1, Number(q.page) || 1);
  const offset = q.offset !== undefined ? Math.max(0, Number(q.offset) || 0) : (page - 1) * limit;
  const action = typeof q.action === "string" && q.action.trim() ? q.action.trim() : undefined;
  // category: "general" | "security" (omit = both). Security entries are immutable.
  const category = q.category === "security" || q.category === "general" ? q.category : undefined;

  const clauses: string[] = [];
  const filterParams: unknown[] = [];
  if (action) { clauses.push("action LIKE ?"); filterParams.push(`%${action}%`); }
  if (category) { clauses.push("category = ?"); filterParams.push(category); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const logs = db.prepare(`
    SELECT
      id,
      user_id AS userId,
      username,
      ip,
      action,
      resource_type AS resourceType,
      resource_name AS resourceName,
      result,
      details,
      category,
      created_at AS createdAt
    FROM audit_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...filterParams, limit, offset);
  const total = (db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${where}`).get(...filterParams) as { c: number }).c;
  return { logs, total };
});

// Clear the general audit log. Security events are NEVER deletable.
app.delete("/api/audit-logs", async (req, reply) => {
  requireAdmin(req, reply);
  const info = db.prepare("DELETE FROM audit_logs WHERE category != 'security'").run();
  securityLog(db, { userId: req.session.userId!, username: req.session.username, ip: getClientIp(req), action: "audit.clear", result: "success", details: `${info.changes} entries` });
  return { ok: true, cleared: info.changes };
});

// Clear finished task history (running/pending tasks are kept).
app.delete("/api/tasks", async (req, reply) => {
  requireAdmin(req, reply);
  const info = db.prepare("DELETE FROM task_history WHERE status NOT IN ('pending','running')").run();
  return { ok: true, cleared: info.changes };
});

// ── SSL / Let's Encrypt ────────────────────────────────────────────────────
app.get("/api/ssl/status", async (req, reply) => {
  requireAdmin(req, reply);
  return getSslStatus();
});

/**
 * Restart the API service so it reloads with the new TLS certificate. tlsOptions
 * is read once at startup, so a freshly provisioned/imported cert only takes
 * effect after a restart — without this, https://host:8441 keeps failing the TLS
 * handshake because the running process is still plain HTTP. We detach the
 * restart (with a short delay) so the HTTP response flushes first; systemd then
 * brings the API back up serving HTTPS on 8441 (+ 443).
 */
function scheduleApiRestartForTls() {
  try {
    const child = spawn(
      "bash",
      ["-c", "sleep 2; systemctl restart auxinuxvirtual-api.service || systemctl restart auxinuxvirtual-api"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    app.log.info("[ssl] API restart scheduled to apply the new TLS certificate");
    return true;
  } catch (err) {
    app.log.warn({ err }, "[ssl] could not schedule API restart — restart manually to apply HTTPS");
    return false;
  }
}

app.post("/api/ssl/provision", async (req, reply) => {
  requireAdmin(req, reply);
  const body = req.body as { domain?: unknown; email?: unknown; challenge?: unknown; staging?: unknown };
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const challenge = body.challenge as string | undefined;
  const staging = body.staging === true;
  if (!domain || !email || !challenge) {
    return reply.status(400).send({ error: "domain, email, and challenge are required" });
  }
  // Basic domain format validation
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$/.test(domain) || domain.includes("..")) {
    return reply.status(400).send({ error: "Invalid domain format" });
  }
  if (challenge !== "http-01" && challenge !== "dns-01") {
    return reply.status(400).send({ error: "challenge must be http-01 or dns-01" });
  }
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "upload",
    action: "ssl.provision",
    label: `Provision SSL certificate for ${domain}`,
    resourceType: "ssl",
    resourceName: domain,
    message: "Provisioning Let's Encrypt certificate",
    detail: `Domain: ${domain}, Challenge: ${challenge}, Staging: ${staging}`,
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    await provisionCertificate({
      domain, email, challenge, staging, apiPort: PORT,
      progressCallback: (step) => update({ detail: step }),
    });
    scheduleApiRestartForTls();
    update({ progressPercent: 100, message: "Certificate provisioned. Applying HTTPS now — the panel will restart in a few seconds (reconnect via https)." });
    return { ok: true, domain, restarting: true };
  });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip, action: "ssl.provision", resourceName: domain });
  return sanitizeTask(task);
});

app.post("/api/ssl/renew", async (req, reply) => {
  requireAdmin(req, reply);
  const status = await getSslStatus();
  if (!status.certExists) return reply.status(404).send({ error: "No SSL certificate found" });
  const ip = getClientIp(req);
  const task = createTask(req.session.userId!, req.session.username ?? "unknown", {
    kind: "upload",
    action: "ssl.renew",
    label: "Renew SSL certificate",
    message: "Renewing Let's Encrypt certificate",
  });
  void runTrackedTask(task, ip, async ({ update }) => {
    await checkAndRenew();
    scheduleApiRestartForTls();
    update({ progressPercent: 100, message: "Certificate renewed. Applying it now — the panel will restart in a few seconds." });
    return { ok: true, restarting: true };
  });
  auditLog(db, { userId: req.session.userId!, username: req.session.username, ip, action: "ssl.renew" });
  return sanitizeTask(task);
});

app.post("/api/ssl/import", async (req, reply) => {
  requireAdmin(req, reply);
  const body = req.body as { domain?: unknown; certPem?: unknown; keyPem?: unknown } | undefined;
  const domain = typeof body?.domain === "string" ? body.domain.trim() : "";
  const certPem = typeof body?.certPem === "string" ? body.certPem.trim() : "";
  const keyPem = typeof body?.keyPem === "string" ? body.keyPem.trim() : "";

  if (!certPem || !keyPem) {
    return reply.status(400).send({ error: "Certificate and private key are required" });
  }
  if (!certPem.includes("-----BEGIN CERTIFICATE-----") || !certPem.includes("-----END CERTIFICATE-----")) {
    return reply.status(400).send({ error: "Invalid certificate PEM format" });
  }
  try {
    new X509Certificate(certPem);
    createPrivateKey(keyPem);
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid certificate or private key" });
  }

  const cert = new X509Certificate(certPem);
  const expiresAt = new Date(cert.validTo).toISOString();
  await fs.promises.mkdir(path.dirname(CERT_PATH), { recursive: true });
  await fs.promises.writeFile(CERT_PATH, certPem.endsWith("\n") ? certPem : `${certPem}\n`, { mode: 0o644 });
  await fs.promises.writeFile(KEY_PATH, keyPem.endsWith("\n") ? keyPem : `${keyPem}\n`, { mode: 0o600 });
  await fs.promises.writeFile(path.join(path.dirname(CERT_PATH), "meta.json"), JSON.stringify({
    domain: domain || cert.subject,
    email: "",
    challenge: "http-01",
    issuedAt: new Date().toISOString(),
    expiresAt,
    autoRenew: false,
    imported: true,
  }, null, 2), { mode: 0o600 });

  auditLog(db, {
    userId: req.session.userId!, username: req.session.username,
    ip: getClientIp(req), action: "ssl.import", resourceName: domain || cert.subject, result: "success",
  });
  scheduleApiRestartForTls();
  return { ok: true, restarting: true, message: "SSL certificate imported. Applying HTTPS now — the panel will restart in a few seconds (reconnect via https)." };
});

app.delete("/api/ssl", async (req, reply) => {
  requireAdmin(req, reply);
  await removeCertificate();
  auditLog(db, {
    userId: req.session.userId!, username: req.session.username,
    ip: getClientIp(req), action: "ssl.remove", result: "success",
  });
  scheduleApiRestartForTls();
  return { ok: true, restarting: true, message: "SSL certificate removed. Reverting to HTTP now — the panel will restart in a few seconds." };
});

// ── Settings ───────────────────────────────────────────────────────────────
app.get("/api/settings", async (req, reply) => {
  requireAdmin(req, reply);
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
});

app.put("/api/settings", async (req, reply) => {
  requireAdmin(req, reply);
  const settings = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(settings)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
  return { ok: true };
});

app.get("/api/vdm-manager/status", async (req, reply) => {
  requireAdmin(req, reply);
  const managerApiUrl = getSetting("vdm.managerApiUrl");
  const joinedAt = getSetting("vdm.joinedAt");
  const localNodeName = getLocalNodeName();
  const localNode = listDatacenterNodes().find((node) => node.isLocal);
  return {
    joined: !!managerApiUrl,
    managerApiUrl,
    joinedAt,
    localNodeName,
    localDisplayName: localNode?.displayName ?? localNodeName,
    localApiUrl: getSetting("datacenter.primaryApiUrl") || null,
    nodeAuthTokenPresent: !!getLocalNodeAuthToken(),
  };
});

// Host-level VDM discovery used by `vos vdm`. This endpoint is intentionally
// node-token protected: it exposes placement only to another trusted node in
// the same Virtua datacenter and prevents two VDM installations in one cluster.
app.get("/api/internal/vdm-host-status", async (req) => {
  requireInternalNodeToken(req);
  const managerApiUrl = getSetting("vdm.managerApiUrl");
  const lockRaw = getSetting("vdm.installLock");
  let installLock: { holder?: string; expiresAt?: string } | null = null;
  try {
    installLock = lockRaw ? JSON.parse(lockRaw) as { holder?: string; expiresAt?: string } : null;
    if (installLock?.expiresAt && Date.parse(installLock.expiresAt) <= Date.now()) installLock = null;
  } catch { installLock = null; }
  const lxcName = process.env.AUXINUX_VDM_LXC_NAME || "auxinux-vdm";
  let lxcPath = process.env.AUXINUX_VDM_LXC_PATH || "/var/lib/lxc";
  try {
    const haConfig = fs.readFileSync("/etc/auxinux-vdm/ha.conf", "utf8");
    const configuredPath = haConfig.match(/^VDM_HA_LXC_PATH=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (configuredPath?.startsWith("/") && !configuredPath.includes("..")) lxcPath = configuredPath;
  } catch { /* HA is not configured */ }
  return {
    nodeName: getLocalNodeName(),
    joined: !!managerApiUrl,
    managerApiUrl,
    vdmInstalled: fs.existsSync(path.join(lxcPath, lxcName, "config")),
    lxcName,
    installLock,
  };
});

app.post("/api/internal/vdm-install-lock", async (req, reply) => {
  requireInternalNodeToken(req);
  const body = (req.body ?? {}) as { action?: unknown; holder?: unknown; ttlSeconds?: unknown };
  const action = typeof body.action === "string" ? body.action : "";
  const holder = typeof body.holder === "string" ? body.holder.trim() : "";
  if (!holder || holder.length > 200 || !["acquire", "release"].includes(action)) {
    return reply.status(400).send({ error: "action and holder are required" });
  }
  const currentRaw = getSetting("vdm.installLock");
  let current: { holder?: string; expiresAt?: string } | null = null;
  try { current = currentRaw ? JSON.parse(currentRaw) as { holder?: string; expiresAt?: string } : null; } catch { current = null; }
  const active = !!current?.expiresAt && Date.parse(current.expiresAt) > Date.now();
  if (action === "release") {
    if (!active || current?.holder === holder) db.prepare("DELETE FROM settings WHERE key = 'vdm.installLock'").run();
    return { ok: true };
  }
  if (active && current?.holder !== holder) {
    return reply.status(409).send({ error: "Another VDM operation owns the cluster lock", lock: current });
  }
  const ttlSeconds = Math.max(60, Math.min(7200, Number(body.ttlSeconds) || 1800));
  const value = JSON.stringify({ holder, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() });
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('vdm.installLock', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(value);
  return { ok: true, lock: JSON.parse(value) };
});

app.delete("/api/internal/vdm-placement", async (req) => {
  requireInternalNodeToken(req);
  db.prepare("DELETE FROM settings WHERE key IN ('vdm.managerApiUrl', 'vdm.joinedAt', 'vdm.installLock')").run();
  return { ok: true };
});

app.get("/api/internal/vdm-ha", async (req, reply) => {
  requireInternalNodeToken(req);
  const cli = fs.existsSync("/usr/bin/vos") ? "/usr/bin/vos" : "/usr/bin/virtuaos";
  if (!fs.existsSync(cli)) return reply.status(503).send({ error: "VirtuaOS CLI is not installed" });
  try {
    const { stdout } = await execFileAsync(cli, ["vdm", "ha", "status"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: stdout.trim(), enabled: /HA configured:\s*1/.test(stdout) };
  } catch (error) {
    return reply.status(503).send({ error: error instanceof Error ? error.message : "HA status failed" });
  }
});

app.put("/api/internal/vdm-ha", async (req, reply) => {
  requireInternalNodeToken(req);
  const body = (req.body ?? {}) as { enabled?: unknown; sharedPath?: unknown };
  if (typeof body.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be boolean" });
  const sharedPath = typeof body.sharedPath === "string" ? body.sharedPath.trim() : "";
  if (body.enabled && (!sharedPath.startsWith("/") || sharedPath.includes("..") || /\s/.test(sharedPath) || sharedPath.length > 300)) {
    return reply.status(400).send({ error: "A safe absolute sharedPath is required to enable HA" });
  }
  const cli = fs.existsSync("/usr/bin/vos") ? "/usr/bin/vos" : "/usr/bin/virtuaos";
  if (!fs.existsSync(cli)) return reply.status(503).send({ error: "VirtuaOS CLI is not installed" });
  try {
    const args = ["vdm", "ha", body.enabled ? "enable" : "disable"];
    const env = { ...process.env, ...(sharedPath ? { VDM_HA_LXC_PATH: sharedPath } : {}) };
    const { stdout, stderr } = await execFileAsync(cli, args, { env, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, enabled: body.enabled, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return reply.status(409).send({ error: detail.stderr?.trim() || detail.stdout?.trim() || detail.message });
  }
});

app.post("/api/vdm-manager/join", async (req, reply) => {
  requireAdmin(req, reply);
  const body = (req.body ?? {}) as { managerApiUrl?: string; joinToken?: string; displayName?: string; apiUrl?: string };
  const managerApiUrl = body.managerApiUrl?.trim().replace(/\/+$/, "") || "";
  const joinToken = body.joinToken?.trim() || "";
  const localNodeName = getLocalNodeName();
  const localNode = listDatacenterNodes().find((node) => node.isLocal);
  const displayName = body.displayName?.trim() || localNode?.displayName || localNodeName;
  const apiUrl = body.apiUrl?.trim() || `${req.protocol}://${req.headers.host ?? "127.0.0.1:8441"}`;
  const authToken = getLocalNodeAuthToken();

  if (!managerApiUrl || !joinToken) {
    return reply.status(400).send({ error: "managerApiUrl and joinToken are required" });
  }
  if (!authToken) {
    return reply.status(400).send({ error: "Local node auth token is missing" });
  }

  const res = await fetch(`${managerApiUrl}/api/vdm/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: joinToken,
      name: localNodeName,
      displayName,
      apiUrl,
      authToken,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    return reply.status(res.status).send({ error: err.error ?? `VDM manager HTTP ${res.status}` });
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("vdm.managerApiUrl", managerApiUrl);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("vdm.joinedAt", new Date().toISOString());
  return { ok: true };
});

app.post("/api/vdm-manager/leave", async (req, reply) => {
  requireAdmin(req, reply);
  db.prepare("DELETE FROM settings WHERE key IN ('vdm.managerApiUrl', 'vdm.joinedAt')").run();
  return { ok: true };
});

// ── WebSocket: VNC Proxy ───────────────────────────────────────────────────
const httpServer = app.server as http.Server;

const vncWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
vncWss.on("connection", async (rawWs: WebSocket) => {
  const ws = rawWs as WebSocket & { auxinuxTicket?: ConsoleTicket };
  const ticket = ws.auxinuxTicket;
  if (!ticket || !ticket.target) { ws.close(); return; }
  if (ticket.kind === "remote-vm-vnc" && ticket.proxyNode) {
    try {
      const node = listDatacenterNodes().find((entry) => entry.name === ticket.proxyNode);
      if (!node || node.isLocal) {
        ws.close(1011, "Remote node not found");
        return;
      }
      const remoteTicket = await fetchRemoteNode<{ url: string }>(
        node,
        `/api/internal/vms/${encodeURIComponent(ticket.target)}/vnc-ticket`,
        { method: "POST" },
      );
      const remoteWs = new WebSocket(remoteTicket.url);
      remoteWs.on("message", (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data, { binary: true, compress: false });
        }
      });
      ws.on("message", (data) => {
        if (remoteWs.readyState === WebSocket.OPEN) remoteWs.send(data as Buffer);
      });
      ws.on("close", () => {
        try { remoteWs.close(); } catch {}
      });
      remoteWs.on("error", () => ws.close(1011, "Remote VNC connection error"));
      remoteWs.on("close", () => ws.close());
      return;
    } catch {
      ws.close(1011, "Remote VNC error");
      return;
    }
  }
  if (ticket.kind !== "vm-vnc") { ws.close(); return; }
  const vmName = ticket.target;
  try {
    const info = await callRunner<{ vncPort?: number; vncHost?: string }>("qemu_info", { name: vmName });
    const port = info.vncPort;
    const host = info.vncHost ?? "127.0.0.1";
    if (!port || port === -1) { ws.close(1011, "VNC not available"); return; }

    const net = await import("net");
    const vncSocket = net.createConnection({ host, port });
    vncSocket.setNoDelay(true);
    (ws as unknown as { _socket?: { setNoDelay?: (enabled: boolean) => void } })._socket?.setNoDelay?.(true);
    vncSocket.on("data", (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true, compress: false });
      }
    });
    ws.on("message", (data) => { vncSocket.write(data as Buffer); });
    ws.on("close", () => vncSocket.destroy());
    vncSocket.on("error", () => ws.close(1011, "VNC connection error"));
    vncSocket.on("close", () => ws.close());
  } catch { ws.close(1011, "Error"); }
});

// ── WebSocket: SPICE Proxy ─────────────────────────────────────────────────
const spiceWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
spiceWss.on("connection", async (rawWs: WebSocket) => {
  const ws = rawWs as WebSocket & { auxinuxTicket?: ConsoleTicket };
  const ticket = ws.auxinuxTicket;
  if (!ticket || !ticket.target) { ws.close(); return; }

  const toBuffer = (data: RawData) => {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
  };

  // SPICE is a client-talks-first protocol: the browser sends its link header
  // the instant the WS opens, i.e. while we are still awaiting the runner /
  // remote node below. Queue anything that arrives before the backend pipe is
  // wired, or that first message is silently dropped and the handshake hangs
  // until the client-side 30s timeout. (VNC does not need this: RFB is
  // server-talks-first, so the client stays quiet until we are ready.)
  const earlyMessages: Buffer[] = [];
  const queueEarlyMessage = (data: RawData) => { earlyMessages.push(toBuffer(data)); };
  ws.on("message", queueEarlyMessage);

  if (ticket.kind === "remote-vm-spice" && ticket.proxyNode) {
    try {
      const node = listDatacenterNodes().find((entry) => entry.name === ticket.proxyNode);
      if (!node || node.isLocal) {
        ws.close(1011, "Remote node not found");
        return;
      }
      const remoteTicket = await fetchRemoteNode<{ url: string }>(
        node,
        `/api/internal/vms/${encodeURIComponent(ticket.target)}/spice-ticket`,
        { method: "POST" },
      );
      const remoteWs = new WebSocket(remoteTicket.url);
      remoteWs.on("message", (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true, compress: false });
      });
      remoteWs.on("open", () => {
        ws.off("message", queueEarlyMessage);
        for (const chunk of earlyMessages.splice(0)) {
          remoteWs.send(chunk, { binary: true, compress: false });
        }
        ws.on("message", (data) => {
          if (remoteWs.readyState === WebSocket.OPEN) remoteWs.send(toBuffer(data), { binary: true, compress: false });
        });
      });
      ws.on("close", () => {
        try { remoteWs.close(); } catch {}
      });
      remoteWs.on("error", () => ws.close(1011, "Remote SPICE connection error"));
      remoteWs.on("close", () => ws.close());
      return;
    } catch {
      ws.close(1011, "Remote SPICE error");
      return;
    }
  }

  if (ticket.kind !== "vm-spice") { ws.close(); return; }
  try {
    const info = await callRunner<SpiceConsoleInfo>("qemu_ensure_spice", { name: ticket.target });
    const port = info.spicePort ?? info.spiceTlsPort;
    const host = info.spiceHost ?? "127.0.0.1";
    if (!info.active || !port) {
      ws.close(1011, info.requiresRestart ? "SPICE restart required" : "SPICE not available");
      return;
    }

    const spiceSocket = net.createConnection({ host, port });
    spiceSocket.setNoDelay(true);
    (ws as unknown as { _socket?: { setNoDelay?: (enabled: boolean) => void } })._socket?.setNoDelay?.(true);
    spiceSocket.on("data", (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true, compress: false });
    });
    // net queues writes issued before "connect" completes, so it is safe to
    // flush the early messages and start piping immediately.
    ws.off("message", queueEarlyMessage);
    for (const chunk of earlyMessages.splice(0)) spiceSocket.write(chunk);
    ws.on("message", (data) => { spiceSocket.write(toBuffer(data)); });
    ws.on("close", () => spiceSocket.destroy());
    spiceSocket.on("error", () => ws.close(1011, "SPICE connection error"));
    spiceSocket.on("close", () => ws.close());
  } catch {
    ws.close(1011, "SPICE error");
  }
});

// ── WebSocket: PTY Terminal (containers) ──────────────────────────────────
const termWss = new WebSocketServer({ noServer: true });
termWss.on("connection", (rawWs: WebSocket) => {
  const ws = rawWs as WebSocket & { auxinuxTicket?: ConsoleTicket };
  const ticket = ws.auxinuxTicket;
  let ptyProcess: pty.IPty | null = null;
  let remoteWs: WebSocket | null = null;

  const env = { ...(process.env as Record<string, string>), TERM: "xterm-256color" };
  if (ticket?.kind === "host") {
    ptyProcess = pty.spawn(process.env.SHELL ?? "/bin/bash", ["-l"], { name: "xterm-256color", cols: 120, rows: 32, cwd: process.env.HOME ?? "/root", env });
  } else if (ticket?.kind === "lxc-console" && ticket.target) {
    ptyProcess = pty.spawn("lxc-attach", ["-n", ticket.target, "--", "sh", "-lc", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp", env });
  } else if (ticket?.kind === "docker-console" && ticket.target) {
    ptyProcess = pty.spawn("docker", ["exec", "-it", ticket.target, "sh", "-lc", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp", env });
  } else if (ticket?.kind === "vm-console" && ticket.target) {
    ptyProcess = pty.spawn("virsh", ["console", ticket.target], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp", env });
  }

  if (
    ticket?.target &&
    (
      ticket.kind === "remote-host" ||
      ticket.kind === "remote-lxc-console" ||
      ticket.kind === "remote-docker-console" ||
      ticket.kind === "remote-vm-console"
    )
  ) {
    void (async () => {
      try {
        const remoteNodeName = ticket.kind === "remote-host" ? ticket.target : ticket.proxyNode;
        const node = listDatacenterNodes().find((entry) => entry.name === remoteNodeName);
        if (!node || node.isLocal) {
          ws.close(1011, "Remote node not found");
          return;
        }
        const remoteTarget = ticket.target;
        if (!remoteTarget) {
          ws.close(1011, "Remote target not found");
          return;
        }
        const remotePath = ticket.kind === "remote-host"
          ? "/api/internal/system/host/console-ticket"
          : ticket.kind === "remote-lxc-console"
            ? `/api/internal/lxc/${encodeURIComponent(remoteTarget)}/console-ticket`
            : ticket.kind === "remote-docker-console"
              ? `/api/internal/docker/containers/${encodeURIComponent(remoteTarget)}/console-ticket`
              : `/api/internal/vms/${encodeURIComponent(remoteTarget)}/console-ticket`;
        const remoteTicket = await fetchRemoteNode<{ url: string }>(node, remotePath, ticket.kind === "remote-host"
          ? {
              method: "POST",
              body: JSON.stringify({ initialCommand: ticket.initialCommand }),
            }
          : { method: "POST" });
        remoteWs = new WebSocket(remoteTicket.url);
        remoteWs.on("message", (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
        });
        remoteWs.on("error", () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data: "\r\n\x1b[31mRemote shell connection error\x1b[0m\r\n" }));
          }
        });
        remoteWs.on("close", () => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        });
        ws.on("message", (msg) => {
          if (remoteWs?.readyState === WebSocket.OPEN) remoteWs.send(msg.toString());
        });
        ws.on("close", () => {
          try { remoteWs?.close(); } catch {}
        });
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m${error instanceof Error ? error.message : "Remote shell failed"}\x1b[0m\r\n` }));
          ws.close();
        }
      }
    })();
    return;
  }

  if (!ptyProcess) { ws.close(); return; }

  if (ticket?.kind === "host" && ticket.initialCommand) {
    setTimeout(() => {
      try {
        ptyProcess?.write(`${ticket.initialCommand}\r`);
      } catch {}
    }, 150);
  }

  ptyProcess.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output", data })); });
  ws.on("message", (msg) => {
    try {
      const m = JSON.parse(msg.toString()) as { type: string; data?: string; cols?: number; rows?: number };
      if (m.type === "input" && m.data) ptyProcess!.write(m.data);
      if (m.type === "resize" && m.cols && m.rows) ptyProcess!.resize(m.cols, m.rows);
    } catch {}
  });
  ws.on("close", () => {
    try { ptyProcess!.kill(); } catch {}
    try { remoteWs?.close(); } catch {}
  });
});

function handleWsUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const parsed = new URL(req.url ?? "/", "http://localhost");
  const ticket = consumeWsTicket(parsed.searchParams.get("ticket"));
  if (!ticket) return socket.destroy();

  if (parsed.pathname === "/api/ws/vnc" && (ticket.kind === "vm-vnc" || ticket.kind === "remote-vm-vnc")) {
    vncWss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
      (ws as WebSocket & { auxinuxTicket?: ConsoleTicket }).auxinuxTicket = ticket;
      vncWss.emit("connection", ws, req);
    });
    return;
  }

  if (parsed.pathname === "/api/ws/spice" && (ticket.kind === "vm-spice" || ticket.kind === "remote-vm-spice")) {
    spiceWss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
      (ws as WebSocket & { auxinuxTicket?: ConsoleTicket }).auxinuxTicket = ticket;
      spiceWss.emit("connection", ws, req);
    });
    return;
  }

  if (
    parsed.pathname === "/api/ws/term" &&
    ticket.kind !== "vm-vnc" &&
    ticket.kind !== "remote-vm-vnc" &&
    ticket.kind !== "vm-spice" &&
    ticket.kind !== "remote-vm-spice"
  ) {
    termWss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
      (ws as WebSocket & { auxinuxTicket?: ConsoleTicket }).auxinuxTicket = ticket;
      termWss.emit("connection", ws, req);
    });
    return;
  }

  socket.destroy();
}

httpServer.on("upgrade", handleWsUpgrade);

app.get("/api/ws/term", async (_req, reply) => {
  return reply.status(426).send({ error: "WebSocket upgrade required for /api/ws/term" });
});

app.get("/api/ws/vnc", async (_req, reply) => {
  return reply.status(426).send({ error: "WebSocket upgrade required for /api/ws/vnc" });
});

app.get("/api/ws/spice", async (_req, reply) => {
  return reply.status(426).send({ error: "WebSocket upgrade required for /api/ws/spice" });
});

// ── Desktop client API (/api/desktop/*) ─────────────────────────────────────
// Reuses RBAC, audit log and one-time WS console tickets; delegates node-aware
// resource ops to the existing internal paths.
// ── Desktop resource lifecycle / enrichment helpers ─────────────────────────
function desktopErr(message: string, statusCode = 502): never {
  throw Object.assign(new Error(message), { desktopError: true, statusCode });
}
/** Map a coded runner rename error to a desktop error with the right HTTP status. */
function desktopErrFromRunner(err: unknown): never {
  // Errors crossing the runner IPC boundary lose their attached `.code`, so we
  // recover the intent from the message as well.
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  const byMsg = /already exists|must be stopped/i.test(message) ? 409
    : /invalid .*name/i.test(message) ? 400
    : /not found/i.test(message) ? 404
    : undefined;
  const status = code === "INVALID_NAME" ? 400
    : code === "NOT_FOUND" ? 404
    : code === "EXISTS" || code === "RUNNING" ? 409
    : byMsg ?? 502;
  desktopErr(message, status);
}

/**
 * Rename a resource on the LOCAL node and propagate the new name to every place
 * Virtua keys by it (metadata, ACL, snapshots, backups, firewall, desktop
 * handle). For docker, the key (container id) is stable — only the container's
 * name/displayName changes. Returns the resource's canonical key after rename.
 */
async function renameDesktopResource(type: "vm" | "lxc" | "docker", node: string, oldKey: string, newName: string): Promise<string> {
  if (!isValidResourceName(type, newName)) desktopErr(`Invalid ${type} name`, 400);
  const dc = listDatacenterNodes().find((n) => n.name === node);
  if (dc && !dc.isLocal) desktopErr("Rename is only supported on the local node", 400);

  if (type === "docker") {
    // The desktop key is the container id (immutable). Rename = new docker name.
    try { await callRunner("docker_rename", { id: oldKey, newName }); }
    catch (e) { desktopErrFromRunner(e); }
    db.prepare("UPDATE docker_containers SET container_name = ?, display_name = ? WHERE container_id = ?").run(newName, newName, oldKey);
    return oldKey;
  }

  // vm / lxc: the name IS the key — perform a real domain/container rename.
  try { await callRunner(type === "vm" ? "qemu_rename" : "lxc_rename", { name: oldKey, newName }); }
  catch (e) { desktopErrFromRunner(e); }

  if (type === "vm") db.prepare("UPDATE qemu_vms SET vm_name = ? WHERE vm_name = ?").run(newName, oldKey);
  else db.prepare("UPDATE lxc_containers SET container_name = ? WHERE container_name = ?").run(newName, oldKey);

  db.prepare("UPDATE snapshots SET resource_name = ? WHERE resource_type = ? AND resource_name = ?").run(newName, type, oldKey);
  db.prepare("UPDATE backups SET resource_name = ? WHERE resource_type = ? AND resource_name = ?").run(newName, type, oldKey);
  db.prepare("UPDATE user_resource_acl SET resource_name = ? WHERE resource_type = ? AND resource_name = ?").run(newName, type, oldKey);
  db.prepare("UPDATE firewall_rules SET linked_resource_name = ? WHERE linked_resource_type = ? AND linked_resource_name = ?").run(newName, type, oldKey);
  // Keep the SAME opaque desktop handle valid: repoint it to the new name.
  db.prepare("DELETE FROM desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?").run(type, node, newName);
  db.prepare("UPDATE desktop_resource_handles SET resource_name = ? WHERE resource_type = ? AND node_name = ? AND resource_name = ?").run(newName, type, node, oldKey);
  return newName;
}
function defaultStoragePoolName(): string {
  const row = db.prepare("SELECT name FROM storage_pools WHERE enabled = 1 ORDER BY (name = 'local') DESC, name LIMIT 1").get() as { name: string } | undefined;
  return row?.name ?? "local";
}
function desktopUsernameById(id?: number | null): string | undefined {
  if (!id) return undefined;
  const r = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as { username: string } | undefined;
  return r?.username;
}
function desktopAssignedUsers(type: string, name: string): string[] {
  const rows = db.prepare(
    "SELECT u.username FROM user_resource_acl a JOIN users u ON u.id = a.user_id WHERE a.resource_type = ? AND a.resource_name = ? AND a.can_view = 1",
  ).all(type, name) as Array<{ username: string }>;
  return rows.map((r) => r.username);
}
function parseLxcImageRef(image?: string): { dist: string; release: string } {
  if (!image) return { dist: "debian", release: "13" };
  const sep = image.includes("/") ? "/" : image.includes(":") ? ":" : "/";
  const [dist, release] = image.split(sep);
  return { dist: (dist || "debian").toLowerCase(), release: (release || "13").toLowerCase() };
}
function generateLxcRootPassword(): string {
  return randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) + "Aa1!";
}
function parseDockerUptimeSeconds(status?: string): number | undefined {
  if (!status || !/^up\b/i.test(status.trim())) return undefined;
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/i.exec(status);
  if (!m) return /about a minute/i.test(status) ? 60 : /less than a second/i.test(status) ? 1 : undefined;
  const mult: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  return (parseInt(m[1], 10) || 0) * (mult[m[2].toLowerCase()] ?? 0);
}
function userCanCreateResource(userId: number, role: string, type: "vm" | "lxc" | "docker"): boolean {
  const q = checkQuota(db, userId, role, type === "vm" ? "vms" : type);
  if (!q.ok) return false;
  const pkey = type === "vm" ? "allow_vm_create" : type === "lxc" ? "allow_lxc_create" : "allow_docker_create";
  return checkPermission(db, userId, role, pkey).ok;
}
// Masks a just-deleted resource from the desktop inventory until the hypervisor
// listing is consistent again — so a successful DELETE is never followed by the
// resource reappearing in GET /api/desktop/resources.
const desktopTombstones = new ResourceTombstones(60_000);

/** Project an internal BackgroundTask onto the desktop task shape. */
function toDesktopTaskInfo(t: BackgroundTask): import("@auxinux/shared").DesktopTaskInfo {
  const status = t.status === "pending" ? "queued"
    : t.status === "running" ? "running"
    : t.status === "failed" ? "failed"
    : "completed";
  return { id: t.id, label: t.label, target: t.resourceName ?? "", status, progress: t.progressPercent, createdAt: t.createdAt };
}

/** Parse a "8080:80,443:443/udp" desktop port string into RunDocker port specs. */
function parseDesktopPorts(ports?: string): Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp" }> {
  if (!ports?.trim()) return [];
  const out: Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp" }> = [];
  for (const part of ports.split(",")) {
    const m = /^\s*(\d{1,5})\s*:\s*(\d{1,5})\s*(?:\/\s*(tcp|udp))?\s*$/i.exec(part);
    if (!m) continue;
    const hostPort = parseInt(m[1], 10);
    const containerPort = parseInt(m[2], 10);
    if (hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535) continue;
    out.push({ hostPort, containerPort, protocol: (m[3]?.toLowerCase() as "tcp" | "udp") ?? "tcp" });
  }
  return out;
}
/** Build the create-options catalog (nodes/images/networks/defaults) for a type. */
async function buildDesktopCreateOptions(type: "vm" | "lxc" | "docker"): Promise<import("@auxinux/shared").DesktopCreateOptions> {
  const nodes = listDatacenterNodes()
    .filter((n) => n.enabled)
    .map((n) => ({ id: n.name, name: n.name, label: n.isLocal ? `${n.name} (local)` : n.name }));
  const localNode = getLocalNodeName();

  type Item = { id: string; name: string; label?: string; type?: string; node?: string };
  let images: Item[] = [];
  let networks: Item[] = [];
  let defaults: { cpu?: number; memory?: number; disk?: number; network?: string } = {};

  if (type === "vm") {
    defaults = { cpu: 2, memory: 2048, disk: 20, network: "virbr0" };
    const managed = await listManagedFiles().catch(() => [] as Array<{ filename: string; displayName?: string; type: string }>);
    images = managed
      .filter((f) => f.type === "iso")
      .map((f) => ({ id: f.filename, name: f.filename, label: f.displayName ?? f.filename, type: "iso", node: localNode }));
    const bridges = await callRunner<Array<{ name: string }>>("network_bridges_list").catch(() => []);
    networks = bridges.map((b) => ({ id: b.name, name: b.name, label: b.name, type: "bridge", node: localNode }));
  } else if (type === "lxc") {
    defaults = { cpu: 2, memory: 1024, disk: 8, network: "lxcbr0" };
    const templates = await callRunner<Array<{ name: string; dist: string; release: string; arch: string; variant: string; description?: string; cached?: boolean }>>("lxc_templates", { refresh: false }).catch(() => []);
    // Prefer cached templates (immediately usable); fall back to the whole catalog if none cached.
    const cached = templates.filter((tpl) => tpl.cached);
    const chosen = cached.length > 0 ? cached : templates.slice(0, 60);
    images = chosen.map((tpl) => ({
      id: `${tpl.dist}/${tpl.release}`,
      name: `${tpl.dist}/${tpl.release}`,
      label: tpl.description ?? `${tpl.dist} ${tpl.release} (${tpl.arch})`,
      type: tpl.cached ? "template-cached" : "template",
      node: localNode,
    }));
    const bridges = await callRunner<Array<{ name: string }>>("network_bridges_list").catch(() => []);
    networks = bridges.map((b) => ({ id: b.name, name: b.name, label: b.name, type: "bridge", node: localNode }));
  } else {
    defaults = { cpu: 1, memory: 512, network: "bridge" };
    const dockerImages = await callRunner<Array<{ id: string; repoTags?: string[] }>>("docker_images").catch(() => []);
    images = dockerImages.flatMap((img) => {
      const tags = (img.repoTags ?? []).filter((tag) => tag && !tag.startsWith("<none>"));
      return tags.length > 0
        ? tags.map((tag) => ({ id: tag, name: tag, label: tag, type: "image", node: localNode }))
        : [{ id: img.id, name: img.id.slice(0, 19), label: img.id.slice(0, 19), type: "image", node: localNode }];
    });
    const dockerNets = await callRunner<Array<{ id: string; name: string; driver?: string }>>("docker_networks").catch(() => []);
    networks = dockerNets.map((n) => ({ id: n.name, name: n.name, label: n.driver ? `${n.name} (${n.driver})` : n.name, type: n.driver ?? "docker", node: localNode }));
  }

  return { nodes, images, networks, defaults };
}

registerDesktopApi({
  app,
  db,
  getTokenSecret: getDesktopTokenSecret,
  getClientIp,
  hasResourcePermission: (userId, role, type, name, perm) => hasResourcePermission(userId, role, type, name, perm),
  userCanCreate: (userId, role, type) => userCanCreateResource(userId, role, type),
  getCreateOptions: (type) => buildDesktopCreateOptions(type),
  getWebSessionUser: (req) =>
    req.session?.userId
      ? { userId: req.session.userId, role: (req.session.role as "ADMIN" | "USER") ?? "USER", username: req.session.username ?? "" }
      : null,

  // Aggregate VM/LXC/Docker across all enabled nodes (deduplicated) with live
  // metrics (CPU%/RAM%), IP, uptime, image, owner and assigned users.
  listResourcesForDesktop: async (): Promise<DesktopResourceRow[]> => {
    const nodes = enabledResourceNodes();
    const out: DesktopResourceRow[] = [];
    // Pre-load ownership + display-name maps once (cheap, avoids N queries).
    const vmOwners = new Map<string, number>();
    const vmDisplay = new Map<string, string>();
    for (const r of db.prepare("SELECT vm_name, user_id, display_name FROM qemu_vms").all() as Array<{ vm_name: string; user_id: number | null; display_name: string | null }>) { if (r.user_id) vmOwners.set(r.vm_name, r.user_id); if (r.display_name) vmDisplay.set(r.vm_name, r.display_name); }
    const lxcOwners = new Map<string, number>();
    const lxcDisplay = new Map<string, string>();
    for (const r of db.prepare("SELECT container_name, user_id, display_name FROM lxc_containers").all() as Array<{ container_name: string; user_id: number | null; display_name: string | null }>) { if (r.user_id) lxcOwners.set(r.container_name, r.user_id); if (r.display_name) lxcDisplay.set(r.container_name, r.display_name); }
    const dockerOwners = new Map<string, number>();
    const dockerDisplay = new Map<string, string>();
    for (const r of db.prepare("SELECT container_id, user_id, display_name FROM docker_containers").all() as Array<{ container_id: string; user_id: number | null; display_name: string | null }>) { if (r.user_id) dockerOwners.set(r.container_id, r.user_id); if (r.display_name) dockerDisplay.set(r.container_id, r.display_name); }

    // Enrichment tasks run after assembling rows, bounded by try/catch each.
    const enrich: Array<Promise<void>> = [];

    for (const node of nodes) {
      try {
        const [vms, lxc, docker] = await Promise.all([
          (node.isLocal ? callRunner<unknown[]>("qemu_vms") : fetchRemoteNode<unknown[]>(node, "/api/internal/vms")).catch(() => []),
          (node.isLocal ? callRunner<unknown[]>("lxc_containers") : fetchRemoteNode<unknown[]>(node, "/api/internal/lxc")).catch(() => []),
          (node.isLocal ? callRunner<unknown[]>("docker_containers") : fetchRemoteNode<unknown[]>(node, "/api/internal/docker/containers")).catch(() => []),
        ]);

        for (const v of vms as Array<Record<string, unknown>>) {
          const name = String(v.name);
          const state = String(v.state ?? "unknown");
          const agentEnabled = v.qemuAgentEnabled === true;
          const row: DesktopResourceRow = {
            type: "vm", node: node.name, name, state,
            displayName: vmDisplay.get(name),
            owner: desktopUsernameById(vmOwners.get(name)), assignedUsers: desktopAssignedUsers("vm", name),
            // Baseline from the (cheap) list XML; refined live by qemu_stats below.
            qemuGuestAgentEnabled: agentEnabled,
            qemuGuestAgentRunning: false,
            qemuGuestAgentStatus: agentEnabled ? (state === "running" ? "unknown" : "stopped") : "not-installed",
          };
          out.push(row);
          if (state === "running") enrich.push((async () => {
            try {
              type VmStats = {
                cpuPercent?: number; memPercent?: number; uptimeSeconds?: number;
                guestAgentEnabled?: boolean; guestAgentRunning?: boolean;
                guestAgentStatus?: "running" | "stopped" | "not-installed" | "unknown";
                ipAddresses?: string[];
              };
              const s = node.isLocal
                ? await callRunner<VmStats>("qemu_stats", { name })
                : await fetchRemoteNode<VmStats>(node, `/api/internal/vms/${encodeURIComponent(name)}/stats`);
              row.cpuPercent = typeof s.cpuPercent === "number" ? Math.round(s.cpuPercent * 10) / 10 : undefined;
              row.memoryPercent = typeof s.memPercent === "number" ? s.memPercent : undefined;
              if (typeof s.uptimeSeconds === "number") row.uptimeSeconds = s.uptimeSeconds;
              if (typeof s.guestAgentEnabled === "boolean") row.qemuGuestAgentEnabled = s.guestAgentEnabled;
              if (typeof s.guestAgentRunning === "boolean") row.qemuGuestAgentRunning = s.guestAgentRunning;
              if (s.guestAgentStatus) row.qemuGuestAgentStatus = s.guestAgentStatus;
              if (Array.isArray(s.ipAddresses) && s.ipAddresses.length > 0) {
                row.ipAddresses = s.ipAddresses;
                row.ipAddress = s.ipAddresses[0];
              }
            } catch { /* metrics best-effort */ }
          })());
        }

        for (const c of lxc as Array<Record<string, unknown>>) {
          const name = String(c.name);
          const rawIp = typeof c.ipAddress === "string" ? c.ipAddress.split("/")[0] : undefined;
          const row: DesktopResourceRow = {
            type: "lxc", node: node.name, name, state: String(c.state ?? "unknown"),
            displayName: lxcDisplay.get(name),
            ipAddress: rawIp || undefined, ipAddresses: rawIp ? [rawIp] : undefined,
            owner: desktopUsernameById(lxcOwners.get(name)), assignedUsers: desktopAssignedUsers("lxc", name),
          };
          out.push(row);
          if (row.state === "running") enrich.push((async () => {
            try {
              const s = node.isLocal
                ? await callRunner<{ cpuPercent?: number; memUsedBytes?: number; memTotalBytes?: number; uptimeSeconds?: number }>("lxc_stats", { name })
                : await fetchRemoteNode<{ cpuPercent?: number; memUsedBytes?: number; memTotalBytes?: number; uptimeSeconds?: number }>(node, `/api/internal/lxc/${encodeURIComponent(name)}/stats`);
              row.cpuPercent = typeof s.cpuPercent === "number" ? Math.round(s.cpuPercent * 10) / 10 : undefined;
              row.memoryPercent = s.memTotalBytes && s.memUsedBytes !== undefined ? Math.round((s.memUsedBytes / s.memTotalBytes) * 100) : undefined;
              if (typeof s.uptimeSeconds === "number") row.uptimeSeconds = s.uptimeSeconds;
            } catch { /* best-effort */ }
          })());
        }

        for (const d of docker as Array<Record<string, unknown>>) {
          const id = String(d.id);
          const row: DesktopResourceRow = {
            type: "docker", node: node.name, name: id, displayName: dockerDisplay.get(id) ?? String(d.name ?? id),
            state: String(d.state ?? "unknown"), image: typeof d.image === "string" ? d.image : undefined,
            uptimeSeconds: parseDockerUptimeSeconds(typeof d.status === "string" ? d.status : undefined),
            owner: desktopUsernameById(dockerOwners.get(id)), assignedUsers: desktopAssignedUsers("docker", id),
          };
          out.push(row);
          if (row.state === "running") enrich.push((async () => {
            try {
              const s = node.isLocal
                ? await callRunner<{ cpuPercent?: number; memPercent?: number; uptimeSeconds?: number }>("docker_stats", { id })
                : await fetchRemoteNode<{ cpuPercent?: number; memPercent?: number; uptimeSeconds?: number }>(node, `/api/internal/docker/containers/${encodeURIComponent(id)}/stats`);
              row.cpuPercent = typeof s.cpuPercent === "number" ? Math.round(s.cpuPercent * 10) / 10 : undefined;
              row.memoryPercent = typeof s.memPercent === "number" ? s.memPercent : undefined;
              if (typeof s.uptimeSeconds === "number") row.uptimeSeconds = s.uptimeSeconds; // accurate StartedAt-based value
            } catch { /* best-effort */ }
          })());
        }
      } catch {
        /* node unreachable → skip */
      }
    }
    await Promise.all(enrich);
    // Drop anything a recent DELETE removed but the hypervisor list may still show.
    return desktopTombstones.filter(out);
  },

  // Node-aware power action. Maps the desktop verbs onto each runtime.
  runResourceAction: async (type, node, name, action) => {
    const dc = listDatacenterNodes().find((n) => n.name === node);
    const remote = dc && !dc.isLocal ? dc : null;
    if (type === "vm") {
      const vmAction = action === "restart" ? "reboot" : action === "stop" ? "shutdown" : "start";
      return remote
        ? fetchRemoteNode(remote, `/api/internal/vms/${encodeURIComponent(name)}/${vmAction}`, { method: "POST" })
        : runQemuAction(name, vmAction);
    }
    if (type === "lxc") {
      return remote
        ? fetchRemoteNode(remote, `/api/internal/lxc/${encodeURIComponent(name)}/${action}`, { method: "POST" })
        : callRunner("lxc_action", { name, action });
    }
    // docker (name === container id)
    return remote
      ? fetchRemoteNode(remote, `/api/internal/docker/containers/${encodeURIComponent(name)}/${action}`, { method: "POST" })
      : callRunner("docker_action", { id: name, action });
  },

  // Node-aware snapshot (VM/LXC only).
  createSnapshotForResource: async (type, node, name, input) => {
    const dc = listDatacenterNodes().find((n) => n.name === node);
    const remote = dc && !dc.isLocal ? dc : null;
    if (type === "vm") {
      if (remote) return fetchRemoteNode(remote, `/api/internal/vms/${encodeURIComponent(name)}/snapshot/create`, { method: "POST", body: JSON.stringify(input) });
      const result = await callRunner("qemu_snapshot_create", { name, snapName: input.name, description: input.description }, 15 * 60_000);
      db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('vm', ?, ?, ?, NULL)").run(name, input.name, input.description ?? null);
      return result;
    }
    if (type === "lxc") {
      if (remote) return fetchRemoteNode(remote, `/api/internal/lxc/${encodeURIComponent(name)}/snapshot/create`, { method: "POST", body: JSON.stringify(input) });
      const result = await callRunner("lxc_snapshot_create", { name, snapName: input.name, description: input.description }, 15 * 60_000);
      db.prepare("INSERT INTO snapshots (resource_type, resource_name, snapshot_name, description, created_by) VALUES ('lxc', ?, ?, ?, NULL)").run(name, input.name, input.description ?? null);
      return result;
    }
    throw new Error("Snapshots not supported for this resource type");
  },

  // Create a resource from the minimal desktop body, reusing the panel's runner
  // calls + DB bookkeeping. Quota/permission are re-checked here server-side.
  createResource: async (ctx, input) => {
    const targetNodeName = input.node?.trim() || getLocalNodeName();
    const targetNode = listDatacenterNodes().find((n) => n.name === targetNodeName);
    if (!targetNode || !targetNode.enabled) desktopErr("Target node not found");
    if (!userCanCreateResource(ctx.userId, ctx.role, input.type)) desktopErr("You are not allowed to create this resource");
    // A new resource with this identity supersedes any stale deletion tombstone.
    desktopTombstones.clear(input.type, targetNode.name, input.name);

    if (input.type === "vm") {
      // secureBoot requires UEFI firmware — enabling it implies uefi=true.
      const payload = CreateVmSchema.parse({
        name: input.name,
        vcpus: input.cpu ?? 2,
        memoryMb: input.memory ?? 2048,
        diskGb: input.disk ?? 20,
        storagePool: defaultStoragePoolName(),
        os: "linux",
        isoFile: input.image,
        ...(input.network ? { bridge: input.network } : {}),
        ...(input.secureBoot !== undefined ? { secureBoot: input.secureBoot } : {}),
        ...(input.secureBoot ? { uefi: true } : {}),
        ...(input.tpm2 !== undefined ? { tpmEnabled: input.tpm2 } : {}),
        ...(input.qemuGuestAgent !== undefined ? { qemuAgentEnabled: input.qemuGuestAgent } : {}),
        ...(input.autostart !== undefined ? { autostart: input.autostart } : {}),
      });
      if (targetNode.isLocal) await callRunner("qemu_create", await prepareVmCreatePayload(payload));
      else await fetchRemoteNode(targetNode, "/api/internal/vms", { method: "POST", body: JSON.stringify(payload) });
      db.prepare("INSERT INTO qemu_vms (vm_name, user_id, node_name) VALUES (?, ?, ?) ON CONFLICT(vm_name) DO UPDATE SET user_id = excluded.user_id, node_name = excluded.node_name")
        .run(payload.name, ctx.userId, targetNode.name);
      return { node: targetNode.name, name: payload.name };
    }

    if (input.type === "lxc") {
      const { dist, release } = parseLxcImageRef(input.image);
      const payload = CreateLxcSchema.parse({
        name: input.name,
        dist, release,
        cpuCores: input.cpu ?? 1,
        memoryMb: input.memory ?? 512,
        diskGb: input.disk ?? 8,
        password: generateLxcRootPassword(),
        ...(input.network ? { bridge: input.network } : {}),
        ...(input.autostart !== undefined ? { autostart: input.autostart } : {}),
      });
      // nesting is an LXC-only runner extension (not part of CreateLxcSchema).
      const lxcPayload = { ...payload, ...(input.nesting !== undefined ? { nesting: input.nesting } : {}) };
      if (targetNode.isLocal) await callRunner("lxc_create", lxcPayload);
      else await fetchRemoteNode(targetNode, "/api/internal/lxc", { method: "POST", body: JSON.stringify(lxcPayload) });
      db.prepare("INSERT INTO lxc_containers (container_name, user_id, node_name) VALUES (?, ?, ?) ON CONFLICT(container_name) DO UPDATE SET user_id = excluded.user_id, node_name = excluded.node_name")
        .run(payload.name, ctx.userId, targetNode.name);
      return { node: targetNode.name, name: payload.name };
    }

    // docker
    if (!input.image) desktopErr("An image is required to create a Docker container");
    const payload = RunDockerSchema.parse({
      name: input.name,
      image: input.image,
      ...(input.cpu !== undefined ? { cpuLimit: input.cpu } : {}),
      ...(input.memory !== undefined ? { memoryMb: input.memory } : {}),
      ...(input.network ? { network: input.network } : {}),
      ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
      ...(input.privileged !== undefined ? { privileged: input.privileged } : {}),
      ...(input.ports ? { ports: parseDesktopPorts(input.ports) } : {}),
    });
    const result = targetNode.isLocal
      ? await callRunner<{ ok: boolean; id: string }>("docker_run", await prepareDockerRunPayload(payload))
      : await fetchRemoteNode<{ ok: boolean; id: string }>(targetNode, "/api/internal/docker/containers", { method: "POST", body: JSON.stringify(payload) });
    db.prepare("INSERT OR IGNORE INTO docker_containers (container_id, container_name, image, user_id, node_name) VALUES (?, ?, ?, ?, ?)")
      .run(result.id, payload.name, payload.image, ctx.userId, targetNode.name);
    if (targetNode.isLocal) await syncFirewallState();
    return { node: targetNode.name, name: result.id, displayName: payload.name };
  },

  // Apply a partial update. Only fields that map cleanly per type are accepted;
  // renaming / image changes after creation are rejected (unsafe).
  updateResource: async (res, patch) => {
    if (isResourceLocked(res.type, res.name)) desktopErr("Ressource verrouillée : déverrouillez-la avant de la modifier.", 423);
    const dc = listDatacenterNodes().find((n) => n.name === res.node);
    const remote = dc && !dc.isLocal ? dc : null;
    if (patch.image !== undefined) desktopErr("Changing the image of an existing resource is not supported", 400);

    // ── Rename / displayName ──────────────────────────────────────────────────
    // The canonical key may change for VM/LXC (the name IS the key); for Docker
    // the key (id) is stable and only the container name/displayName changes.
    let key = res.name;
    if (res.type === "docker") {
      // For Docker, both name and displayName map to the container's docker name.
      const newDockerName = patch.name ?? patch.displayName;
      if (newDockerName !== undefined && newDockerName.trim() && newDockerName !== res.name) {
        key = await renameDesktopResource("docker", res.node, key, newDockerName.trim());
      }
    } else {
      if (patch.name !== undefined && patch.name !== res.name) {
        key = await renameDesktopResource(res.type, res.node, res.name, patch.name);
      }
      if (patch.displayName !== undefined) {
        const table = res.type === "vm" ? "qemu_vms" : "lxc_containers";
        const col = res.type === "vm" ? "vm_name" : "container_name";
        db.prepare(`UPDATE ${table} SET display_name = ? WHERE ${col} = ?`).run(patch.displayName.trim() || null, key);
      }
    }

    if (res.type === "vm") {
      if (patch.disk !== undefined) desktopErr("Disk resize is not available from the desktop for VMs", 400);
      const cfg: Record<string, unknown> = {};
      if (patch.cpu !== undefined) cfg.vcpus = patch.cpu;
      if (patch.memory !== undefined) cfg.memoryMb = patch.memory;
      if (patch.tpm2 !== undefined) cfg.tpmEnabled = patch.tpm2;
      if (patch.secureBoot !== undefined) cfg.secureBoot = patch.secureBoot; // the runner derives uefi from it
      if (patch.qemuGuestAgent !== undefined) cfg.qemuAgentEnabled = patch.qemuGuestAgent;
      if (patch.autostart !== undefined) cfg.autostart = patch.autostart;
      if (Object.keys(cfg).length > 0) {
        const v = UpdateVmConfigSchema.parse(cfg);
        if (remote) await fetchRemoteNode(remote, `/api/internal/vms/${encodeURIComponent(key)}/config`, { method: "PUT", body: JSON.stringify(v) });
        else await callRunner("qemu_update_config", { name: key, ...v });
      }
      return { node: res.node, name: key };
    }

    if (res.type === "lxc") {
      const cfg: Record<string, unknown> = {};
      if (patch.cpu !== undefined) cfg.cpuCores = patch.cpu;
      if (patch.memory !== undefined) cfg.memoryMb = patch.memory;
      if (patch.disk !== undefined) cfg.diskGb = patch.disk;
      if (patch.network !== undefined) cfg.bridge = patch.network;
      if (patch.autostart !== undefined) cfg.autostart = patch.autostart;
      if (Object.keys(cfg).length > 0) {
        const v = UpdateLxcConfigSchema.parse(cfg);
        if (remote) await fetchRemoteNode(remote, `/api/internal/lxc/${encodeURIComponent(key)}/config`, { method: "PUT", body: JSON.stringify(v) });
        else await callRunner("lxc_update_config", { name: key, ...v });
      }
      return { node: res.node, name: key };
    }

    // docker
    if (patch.disk !== undefined) desktopErr("Docker containers have no resizable disk", 400);
    const cfg: Record<string, unknown> = {};
    if (patch.cpu !== undefined) cfg.cpuLimit = patch.cpu;
    if (patch.memory !== undefined) cfg.memoryMb = patch.memory;
    if (patch.restartPolicy !== undefined) cfg.restartPolicy = patch.restartPolicy;
    if (Object.keys(cfg).length > 0) {
      const v = UpdateDockerConfigSchema.parse(cfg);
      if (remote) await fetchRemoteNode(remote, `/api/internal/docker/containers/${encodeURIComponent(key)}/config`, { method: "PUT", body: JSON.stringify(v) });
      else await callRunner("docker_update_config", { id: key, ...v });
    }
    return { node: res.node, name: key };
  },

  // Delete a resource cleanly per type (mirrors the web panel delete paths).
  // Authorization is the per-resource ACL `delete` permission, already enforced
  // by the desktop endpoint (requireResourceByHandle(..., "delete")) — so the
  // effective right matches the `canDelete` flag the client was shown.
  deleteResource: async (res) => {
    if (isResourceLocked(res.type, res.name)) {
      throw Object.assign(new Error("Ressource verrouillée : déverrouillez-la avant de la supprimer."), { desktopError: true, statusCode: 423 });
    }
    const dc = listDatacenterNodes().find((n) => n.name === res.node);
    const remote = dc && !dc.isLocal ? dc : null;

    if (res.type === "vm") {
      if (remote) await fetchRemoteNode(remote, `/api/internal/vms/${encodeURIComponent(res.name)}?deleteDisks=true`, { method: "DELETE" });
      else await callRunner("qemu_delete", { name: res.name, deleteDisks: true });
      db.prepare("DELETE FROM qemu_vms WHERE vm_name = ?").run(res.name);
      db.prepare("DELETE FROM snapshots WHERE resource_type = 'vm' AND resource_name = ?").run(res.name);
      db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'vm' AND resource_name = ?").run(res.name);
      db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'vm' AND linked_resource_name = ?").run(res.name);
    } else if (res.type === "lxc") {
      if (remote) await fetchRemoteNode(remote, `/api/internal/lxc/${encodeURIComponent(res.name)}`, { method: "DELETE" });
      else await callRunner("lxc_delete", { name: res.name });
      db.prepare("DELETE FROM lxc_containers WHERE container_name = ?").run(res.name);
      db.prepare("DELETE FROM snapshots WHERE resource_type = 'lxc' AND resource_name = ?").run(res.name);
      db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'lxc' AND resource_name = ?").run(res.name);
      db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'lxc' AND linked_resource_name = ?").run(res.name);
    } else {
      if (remote) await fetchRemoteNode(remote, `/api/internal/docker/containers/${encodeURIComponent(res.name)}`, { method: "DELETE" });
      else await callRunner("docker_delete", { id: res.name });
      db.prepare("DELETE FROM docker_containers WHERE container_id = ?").run(res.name);
      db.prepare("DELETE FROM user_resource_acl WHERE resource_type = 'docker' AND resource_name = ?").run(res.name);
      db.prepare("DELETE FROM firewall_rules WHERE linked_resource_type = 'docker' AND linked_resource_name = ?").run(res.name);
    }
    db.prepare("DELETE FROM desktop_resource_handles WHERE resource_type = ? AND node_name = ? AND resource_name = ?").run(res.type, res.node, res.name);
    // Mask it from the desktop inventory until the hypervisor listing is consistent.
    desktopTombstones.mark(res.type, res.node, res.name);
    await syncFirewallState();
  },

  // Recent server-side operations the caller may see (ADMIN: all; USER: own).
  listRecentTasks: (userId, role) => {
    return [...backgroundTasks.values()]
      .filter((t) => role === "ADMIN" || t.ownerUserId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 50)
      .map(toDesktopTaskInfo);
  },
  getTask: (userId, role, taskId) => {
    const t = backgroundTasks.get(taskId);
    if (!t) return null;
    if (role !== "ADMIN" && t.ownerUserId !== userId) return null; // not visible → treat as absent
    return toDesktopTaskInfo(t);
  },

  // One-time console ticket reusing the existing WS infra (term/vnc/spice).
  issueConsoleTicket: async (req, { type, node, name, mode, userId, deviceId }) => {
    const dc = listDatacenterNodes().find((n) => n.name === node);
    const isRemote = !!dc && !dc.isLocal;
    const proxyNode = isRemote ? node : undefined;
    let kind: ConsoleTicketKind;
    let wsPath: string;
    if (mode === "spice") {
      if (type !== "vm") desktopErr("SPICE console is only available for VMs", 400);
      if (isRemote) {
        try {
          await fetchRemoteNode<unknown>(
            dc,
            `/api/internal/vms/${encodeURIComponent(name)}/spice-ticket`,
            { method: "POST" },
          );
        } catch (error) {
          desktopErr(error instanceof Error ? error.message : "Remote SPICE console is not active", 409);
        }
        kind = "remote-vm-spice";
      } else {
        const info = await callRunner<SpiceConsoleInfo>("qemu_ensure_spice", { name }).catch((error) => {
          desktopErr(error instanceof Error ? error.message : "SPICE console check failed", 502);
        });
        const port = info.spicePort ?? info.spiceTlsPort;
        if (!info.enabled || !info.active || !port || info.requiresRestart) {
          desktopErr(
            info.requiresRestart
              ? "SPICE enabled; restart the VM once before using SPICE"
              : info.requiresStart
                ? "SPICE console requires a running VM"
                : "SPICE console is not active",
            409,
          );
        }
        kind = "vm-spice";
      }
      wsPath = "/api/ws/spice";
    } else if (mode === "graphical") {
      kind = isRemote ? "remote-vm-vnc" : "vm-vnc";
      wsPath = "/api/ws/vnc";
    } else {
      const base = type === "vm" ? "vm-console" : type === "lxc" ? "lxc-console" : "docker-console";
      kind = (isRemote ? `remote-${base}` : base) as ConsoleTicketKind;
      wsPath = "/api/ws/term";
    }
    const ticket = issueWsTicket(kind, userId, name, undefined, proxyNode, {
      deviceId,
      resourceType: type,
      resourceNode: node,
      resourceName: name,
      mode,
    });
    let url: string;
    try {
      url = buildWsUrl(req, wsPath, ticket.id, { requireReachableHost: true });
    } catch (error) {
      desktopErr(error instanceof Error ? error.message : "Unable to build desktop WebSocket URL", 500);
    }
    return { ticketId: ticket.id, url, ttlMs: WS_TICKET_TTL_MS };
  },
});

// ── SPA Fallback ───────────────────────────────────────────────────────────
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
  try {
    return reply.sendFile("index.html");
  } catch {
    return reply.status(404).send("Not found");
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
await app.listen({ port: PORT, host: "0.0.0.0" });
void syncFirewallState().catch((error) => {
  app.log.warn({ err: error }, "firewall sync failed during startup");
});
console.log(`[api] AuxiNux API running on port ${PORT}${tlsOptions ? " (HTTPS)" : " (HTTP)"}`);

// When TLS is active, ALSO serve standard HTTPS on 443 so the panel answers at
// https://<domain> (not only https://<domain>:8441). The same Fastify app
// handles both sockets by re-emitting requests into its underlying server.
const HTTPS_PUBLIC_PORT = parseInt(process.env.AUXINUX_HTTPS_PORT ?? "443");
let serving443 = false;
if (tlsOptions && PORT !== HTTPS_PUBLIC_PORT && process.env.AUXINUX_HTTPS_443 !== "0") {
  try {
    const https = await import("https");
    await app.ready();
    const https443 = https.createServer(tlsOptions);
    https443.on("request", (req, res) => app.server.emit("request", req, res));
    https443.on("upgrade", (req, socket, head) => handleWsUpgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      https443.once("error", reject);
      https443.listen(HTTPS_PUBLIC_PORT, "0.0.0.0", () => resolve());
    });
    serving443 = true;
    console.log(`[ssl] HTTPS also listening on port ${HTTPS_PUBLIC_PORT} (panel reachable at https://<domain>)`);
  } catch (err) {
    console.warn(`[ssl] Could not bind HTTPS on ${HTTPS_PUBLIC_PORT} (panel still on :${PORT}):`, (err as Error).message);
  }
}

// HTTP → HTTPS redirect server + ACME HTTP-01 challenge fallback when TLS is active
if (tlsOptions) {
  const http = await import("http");
  const redirectServer = http.createServer((req, res) => {
    // Serve ACME HTTP-01 challenge tokens
    const tokenMatch = req.url?.match(/^\/\.well-known\/acme-challenge\/([a-zA-Z0-9_-]{1,128})$/);
    if (tokenMatch) {
      const val = challengeTokens.get(tokenMatch[1]);
      if (val) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(val);
        return;
      }
    }
    // Redirect HTTP → HTTPS. Prefer the standard 443 endpoint when we serve it,
    // so links are clean (https://domain) rather than https://domain:8441.
    const host = (req.headers.host ?? "localhost").replace(/:\d+$/, "");
    const httpsPort = serving443 || PORT === 443 ? "" : `:${PORT}`;
    res.writeHead(301, { Location: `https://${host}${httpsPort}${req.url ?? "/"}` });
    res.end();
  });
  redirectServer.listen(HTTP_REDIRECT_PORT, "0.0.0.0", () => {
    console.log(`[ssl] HTTP redirect/challenge server listening on port ${HTTP_REDIRECT_PORT}`);
  });
  redirectServer.on("error", (err) => {
    console.warn(`[ssl] HTTP redirect server failed to start on port ${HTTP_REDIRECT_PORT}:`, (err as Error).message);
  });
}

// SSL auto-renewal check (runs at startup + every 12 hours)
void checkAndRenew().catch((err) => app.log.warn({ err }, "SSL startup renewal check failed"));
setInterval(() => {
  checkAndRenew().catch((err) => app.log.warn({ err }, "SSL auto-renewal failed"));
}, 12 * 60 * 60 * 1000).unref();
