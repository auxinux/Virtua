import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as argon2 from "argon2";

const DATA_DIR = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinux";
const DB_PATH = process.env.AUXINUX_DB ?? path.join(DATA_DIR, "db", "auxinux.sqlite");

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureParentDirectory(DB_PATH);
  _db = new Database(DB_PATH);
  // WAL autorise les lectures pendant une écriture, ce qui convient au nœud
  // autonome. Le service VDM utilise un réglage distinct pour son mode HA.
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER',
      display_name TEXT,
      email TEXT,
      suspended INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_limits (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_vms INTEGER NOT NULL DEFAULT -1,
      max_lxc INTEGER NOT NULL DEFAULT -1,
      max_docker INTEGER NOT NULL DEFAULT -1,
      max_storage_gb INTEGER NOT NULL DEFAULT -1,
      allow_vm_create INTEGER NOT NULL DEFAULT 0,
      allow_vm_delete INTEGER NOT NULL DEFAULT 0,
      allow_vm_modify INTEGER NOT NULL DEFAULT 0,
      allow_lxc_create INTEGER NOT NULL DEFAULT 0,
      allow_lxc_delete INTEGER NOT NULL DEFAULT 0,
      allow_docker_create INTEGER NOT NULL DEFAULT 0,
      allow_docker_delete INTEGER NOT NULL DEFAULT 0,
      allow_iso_upload INTEGER NOT NULL DEFAULT 0,
      allow_iso_delete INTEGER NOT NULL DEFAULT 0,
      allow_storage_manage INTEGER NOT NULL DEFAULT 0,
      allow_network_manage INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS qemu_vms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vm_name TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id),
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lxc_containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS docker_containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT UNIQUE NOT NULL,
      container_name TEXT NOT NULL,
      image TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS iso_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      display_name TEXT,
      type TEXT NOT NULL DEFAULT 'iso',
      size_bytes INTEGER,
      owner_id INTEGER REFERENCES users(id),
      is_public INTEGER NOT NULL DEFAULT 0,
      storage_pool TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS storage_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'directory',
      content TEXT NOT NULL DEFAULT '[]',
      total_bytes INTEGER DEFAULT 0,
      used_bytes INTEGER DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raid_arrays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT UNIQUE NOT NULL,
      level INTEGER NOT NULL,
      name TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      state TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      snapshot_name TEXT NOT NULL,
      description TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      storage_pool TEXT,
      size_bytes INTEGER DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'tar.gz',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_name TEXT,
      result TEXT,
      details TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER,
      owner_username TEXT,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      label TEXT NOT NULL,
      resource_type TEXT,
      resource_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress_percent REAL NOT NULL DEFAULT 0,
      bytes_current INTEGER,
      bytes_total INTEGER,
      message TEXT,
      detail TEXT,
      activity_log TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS firewall_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enabled INTEGER NOT NULL DEFAULT 1,
      source_kind TEXT NOT NULL DEFAULT 'manual',
      rule_type TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'tcp',
      host_port INTEGER NOT NULL,
      target_ip TEXT,
      target_port INTEGER,
      source_cidr TEXT,
      description TEXT,
      linked_resource_type TEXT,
      linked_resource_name TEXT,
      relation TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_resource_acl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0,
      can_console INTEGER NOT NULL DEFAULT 0,
      can_power INTEGER NOT NULL DEFAULT 0,
      can_media INTEGER NOT NULL DEFAULT 0,
      can_modify INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      can_backup INTEGER NOT NULL DEFAULT 0,
      can_snapshot INTEGER NOT NULL DEFAULT 0,
      can_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, resource_type, resource_name)
    );

    CREATE TABLE IF NOT EXISTS datacenter_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'secondary',
      api_url TEXT,
      auth_token TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_local INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS datacenter_join_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      note TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS datacenter_storage_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'directory',
      content TEXT NOT NULL DEFAULT '[]',
      mount_source TEXT,
      fstype TEXT,
      mount_options TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Desktop client (Virtua Desktop) ────────────────────────────────────
    -- A paired device belonging to a user. Revoking it instantly cuts the
    -- device off (checked on every authenticated request + refresh).
    CREATE TABLE IF NOT EXISTS desktop_devices (
      id TEXT PRIMARY KEY,                      -- uuid
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      installation_id TEXT,                     -- stable per-install id sent by the client
      fingerprint TEXT,                         -- optional device public-key fingerprint
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,                          -- when it was revoked (nullable)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      last_ip TEXT
    );

    -- Rotating refresh tokens. Only the SHA-256 hash is stored. One row is
    -- active per rotation; rotating revokes the previous one.
    CREATE TABLE IF NOT EXISTS desktop_refresh_tokens (
      id TEXT PRIMARY KEY,                      -- uuid
      device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Short-lived pairing codes minted from the web panel so a device can pair
    -- without typing the account password into the desktop app.
    CREATE TABLE IF NOT EXISTS desktop_pairing_codes (
      id TEXT PRIMARY KEY,                      -- uuid
      code_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Opaque UUID handles for resources. The desktop client only ever sees the
    -- UUID; the server resolves it back to (type,node,name) and re-checks
    -- permissions — the client is NEVER trusted for resource identity.
    CREATE TABLE IF NOT EXISTS desktop_resource_handles (
      id TEXT PRIMARY KEY,                      -- uuid
      resource_type TEXT NOT NULL,              -- vm | lxc | docker
      node_name TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(resource_type, node_name, resource_name)
    );

    -- VM/ISO templates managed by the server (source of truth in Cloud mode).
    -- type=iso  → 'filename' is an .iso in the ISO store / storage pool.
    -- type=vm   → 'filename' is a .tar.gz archive (config.virtua + qcow2/raw),
    --             'disk_file' names the disk inside the archive, and cpu/ram/disk
    --             come from the bundled metadata (config.virtua / sidecar JSON).
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,                      -- uuid
      type TEXT NOT NULL,                       -- iso | vm
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      arch TEXT NOT NULL DEFAULT 'amd64',       -- amd64 | arm64 (portable)
      cpu INTEGER,
      memory_mb INTEGER,
      disk_gb INTEGER,
      disk_file TEXT,                           -- disk name inside the vm archive
      filename TEXT NOT NULL,                   -- stored archive / iso filename
      size_bytes INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'restricted', -- public | restricted
      tags TEXT NOT NULL DEFAULT '[]',
      storage_pool TEXT,
      owner_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);

    -- Resource locks: a locked VM/LXC/Docker is flagged priority/sensitive and is
    -- protected SERVER-SIDE against modification and deletion until unlocked.
    CREATE TABLE IF NOT EXISTS resource_locks (
      resource_type TEXT NOT NULL,              -- vm | lxc | docker
      resource_name TEXT NOT NULL,              -- vm_name | container_name | container_id
      reason TEXT,
      locked_by INTEGER REFERENCES users(id),
      locked_by_username TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (resource_type, resource_name)
    );

    -- Local operational error log, polled by VDM (/api/internal/logs/recent).
    -- ts is UTC ISO 8601; capped to keep the table small on long-running nodes.
    CREATE TABLE IF NOT EXISTS node_error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_error_log_ts ON node_error_log(ts);
  `);

  const storagePoolColumns = db.prepare("PRAGMA table_info(storage_pools)").all() as Array<{ name: string }>;
  const storagePoolColumnNames = new Set(storagePoolColumns.map((column) => column.name));
  if (!storagePoolColumnNames.has("mount_source")) {
    db.exec("ALTER TABLE storage_pools ADD COLUMN mount_source TEXT");
  }
  if (!storagePoolColumnNames.has("fstype")) {
    db.exec("ALTER TABLE storage_pools ADD COLUMN fstype TEXT");
  }
  if (!storagePoolColumnNames.has("mount_options")) {
    db.exec("ALTER TABLE storage_pools ADD COLUMN mount_options TEXT");
  }

  const taskHistoryColumns = db.prepare("PRAGMA table_info(task_history)").all() as Array<{ name: string }>;
  const taskHistoryColumnNames = new Set(taskHistoryColumns.map((column) => column.name));
  if (!taskHistoryColumnNames.has("activity_log")) {
    db.exec("ALTER TABLE task_history ADD COLUMN activity_log TEXT");
  }

  const auditColumns = db.prepare("PRAGMA table_info(audit_logs)").all() as Array<{ name: string }>;
  if (!new Set(auditColumns.map((column) => column.name)).has("category")) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
  }

  const firewallColumns = db.prepare("PRAGMA table_info(firewall_rules)").all() as Array<{ name: string }>;
  const firewallColumnNames = new Set(firewallColumns.map((column) => column.name));
  if (!firewallColumnNames.has("relation")) {
    db.exec("ALTER TABLE firewall_rules ADD COLUMN relation TEXT");
  }

  const aclColumns = db.prepare("PRAGMA table_info(user_resource_acl)").all() as Array<{ name: string }>;
  const aclColumnNames = new Set(aclColumns.map((column) => column.name));
  if (!aclColumnNames.has("can_media")) {
    db.exec("ALTER TABLE user_resource_acl ADD COLUMN can_media INTEGER NOT NULL DEFAULT 0");
  }

  const vmColumns = db.prepare("PRAGMA table_info(qemu_vms)").all() as Array<{ name: string }>;
  const vmColumnNames = new Set(vmColumns.map((column) => column.name));
  if (!vmColumnNames.has("node_name")) {
    db.exec("ALTER TABLE qemu_vms ADD COLUMN node_name TEXT");
  }
  // Optional human-friendly label (does NOT rename the real resource).
  if (!vmColumnNames.has("display_name")) {
    db.exec("ALTER TABLE qemu_vms ADD COLUMN display_name TEXT");
  }

  // Docker containers gained a free-text description (used for the Notes card).
  const dockerDescCols = db.prepare("PRAGMA table_info(docker_containers)").all() as Array<{ name: string }>;
  if (!new Set(dockerDescCols.map((c) => c.name)).has("description")) {
    db.exec("ALTER TABLE docker_containers ADD COLUMN description TEXT");
  }

  const lxcColumns = db.prepare("PRAGMA table_info(lxc_containers)").all() as Array<{ name: string }>;
  const lxcColumnNames = new Set(lxcColumns.map((column) => column.name));
  if (!lxcColumnNames.has("node_name")) {
    db.exec("ALTER TABLE lxc_containers ADD COLUMN node_name TEXT");
  }
  if (!lxcColumnNames.has("display_name")) {
    db.exec("ALTER TABLE lxc_containers ADD COLUMN display_name TEXT");
  }

  const dockerColumns = db.prepare("PRAGMA table_info(docker_containers)").all() as Array<{ name: string }>;
  const dockerColumnNames = new Set(dockerColumns.map((column) => column.name));
  if (!dockerColumnNames.has("node_name")) {
    db.exec("ALTER TABLE docker_containers ADD COLUMN node_name TEXT");
  }
  if (!dockerColumnNames.has("display_name")) {
    db.exec("ALTER TABLE docker_containers ADD COLUMN display_name TEXT");
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const userColumnNames = new Set(userColumns.map((column) => column.name));
  if (!userColumnNames.has("failed_login_count")) {
    db.exec("ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumnNames.has("failed_login_window_start")) {
    db.exec("ALTER TABLE users ADD COLUMN failed_login_window_start TEXT");
  }
  if (!userColumnNames.has("locked_until")) {
    db.exec("ALTER TABLE users ADD COLUMN locked_until TEXT");
  }
  // Multi-factor authentication (per-user). A channel can only be ENABLED after
  // the phone/email has been verified (ownership proof).
  if (!userColumnNames.has("phone_number")) {
    db.exec("ALTER TABLE users ADD COLUMN phone_number TEXT");
  }
  if (!userColumnNames.has("phone_verified")) {
    db.exec("ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumnNames.has("email_verified")) {
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumnNames.has("mfa_sms_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN mfa_sms_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumnNames.has("mfa_email_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN mfa_email_enabled INTEGER NOT NULL DEFAULT 0");
  }

  // One-time MFA codes: ownership verification (verify-phone / verify-email,
  // valid 30 min) and login challenges (login-sms / login-email, valid 10 min).
  db.exec(`
    CREATE TABLE IF NOT EXISTS mfa_codes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,                 -- verify-phone | verify-email | login-sms | login-email
      channel TEXT NOT NULL,                 -- sms | email
      destination TEXT NOT NULL,             -- phone or email the code was sent to
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mfa_codes_user_purpose ON mfa_codes(user_id, purpose)");

  // Index used by pruneAuditLogs() and the audit log query endpoint.
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)");

  const datacenterNodeColumns = db.prepare("PRAGMA table_info(datacenter_nodes)").all() as Array<{ name: string }>;
  const datacenterNodeColumnNames = new Set(datacenterNodeColumns.map((column) => column.name));
  if (!datacenterNodeColumnNames.has("auth_token")) {
    db.exec("ALTER TABLE datacenter_nodes ADD COLUMN auth_token TEXT");
  }
  if (!datacenterNodeColumnNames.has("last_seen_at")) {
    db.exec("ALTER TABLE datacenter_nodes ADD COLUMN last_seen_at TEXT");
  }

  // Desktop devices: stable per-installation identity + revocation timestamp.
  const desktopDeviceColumns = db.prepare("PRAGMA table_info(desktop_devices)").all() as Array<{ name: string }>;
  const desktopDeviceColumnNames = new Set(desktopDeviceColumns.map((column) => column.name));
  if (!desktopDeviceColumnNames.has("installation_id")) {
    db.exec("ALTER TABLE desktop_devices ADD COLUMN installation_id TEXT");
  }
  if (!desktopDeviceColumnNames.has("revoked_at")) {
    db.exec("ALTER TABLE desktop_devices ADD COLUMN revoked_at TEXT");
  }
  // At most ONE device row per (user, installation). Partial so legacy rows
  // (installation_id IS NULL) are exempt and never collide.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_devices_user_installation ON desktop_devices(user_id, installation_id) WHERE installation_id IS NOT NULL");

  const firewallEnabled = db.prepare("SELECT value FROM settings WHERE key = 'firewall.enabled'").get() as { value?: string } | undefined;
  if (!firewallEnabled) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('firewall.enabled', '0')").run();
  }
  const firewallProtectSsh = db.prepare("SELECT value FROM settings WHERE key = 'firewall.protectSsh'").get() as { value?: string } | undefined;
  if (!firewallProtectSsh) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('firewall.protectSsh', '1')").run();
  }

  db.exec(`
    INSERT INTO user_limits (user_id)
    SELECT id
    FROM users
    WHERE role = 'USER'
      AND id NOT IN (SELECT user_id FROM user_limits);

    UPDATE user_limits
    SET
      allow_vm_create = 0,
      allow_vm_delete = 0,
      allow_vm_modify = 0,
      allow_lxc_create = 0,
      allow_lxc_delete = 0,
      allow_docker_create = 0,
      allow_docker_delete = 0,
      allow_iso_upload = 0,
      updated_at = datetime('now')
    WHERE user_id IN (SELECT id FROM users WHERE role = 'USER')
      AND allow_vm_create = 1
      AND allow_vm_delete = 1
      AND allow_vm_modify = 1
      AND allow_lxc_create = 1
      AND allow_lxc_delete = 1
      AND allow_docker_create = 1
      AND allow_docker_delete = 1
      AND allow_iso_upload = 1
      AND allow_iso_delete = 0
      AND allow_storage_manage = 0
      AND allow_network_manage = 0
  `);

  // Create default admin if no users exist.
  // - If AUXINUX_INITIAL_ADMIN_PASSWORD is set (e.g. seeded by the VirtuaOS installer),
  //   use it and skip the "must_change_password" flag — the user already chose it.
  // - Otherwise fall back to admin/admin123 with must_change_password=1 (forced rotation).
  const count = (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  if (count === 0) {
    const seededPassword = process.env.AUXINUX_INITIAL_ADMIN_PASSWORD;
    const initialPassword = seededPassword && seededPassword.length >= 8 ? seededPassword : "admin123";
    const mustChange = seededPassword ? 0 : 1;
    argon2.hash(initialPassword).then((hash) => {
      db.prepare(`
        INSERT INTO users (username, password_hash, role, display_name, must_change_password)
        VALUES (?, ?, 'ADMIN', 'Administrator', ?)
      `).run("admin", hash, mustChange);
      if (seededPassword) {
        console.log("[db] Default admin created with installer-seeded password");
      } else {
        console.log("[db] Default admin created: admin / admin123 (please change!)");
      }
    });
  }

  // Create default storage pools dirs
  const poolsToEnsure = [
    { name: "local", path: `${DATA_DIR}/pools/local`, content: '["vm","iso","backup","template","container","disk"]' },
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

export function auditLog(db: Database.Database, params: {
  userId?: number | null;
  username?: string | null;
  ip?: string;
  action: string;
  resourceType?: string;
  resourceName?: string;
  result?: "success" | "error";
  details?: string;
  /** Mark as a sensitive security event — these entries can never be cleared. */
  security?: boolean;
}) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, username, ip, action, resource_type, resource_name, result, details, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.userId ?? null,
    params.username ?? null,
    params.ip ?? null,
    params.action,
    params.resourceType ?? null,
    params.resourceName ?? null,
    params.result ?? "success",
    params.details ?? null,
    params.security ? "security" : "general",
  );
}

/** Convenience wrapper for sensitive, immutable security events. */
export function securityLog(db: Database.Database, params: Omit<Parameters<typeof auditLog>[1], "security">) {
  auditLog(db, { ...params, security: true });
}

/**
 * Default audit log retention (days). Overridable via AUXINUX_AUDIT_RETENTION_DAYS.
 * Set to 0 to disable pruning entirely.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

export function getAuditRetentionDays(): number {
  const raw = process.env.AUXINUX_AUDIT_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_AUDIT_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  return parsed;
}

export function pruneAuditLogs(db: Database.Database, retentionDays = getAuditRetentionDays()): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  // Security events are immutable: never prune them, regardless of retention.
  const info = db.prepare("DELETE FROM audit_logs WHERE created_at < ? AND category != 'security'").run(cutoff);
  return info.changes;
}

/** Schedule a periodic prune. Returns a cancel handle. */
export function startAuditLogPruner(db: Database.Database, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  // Run once on startup so a long-stopped instance catches up immediately.
  try {
    const removed = pruneAuditLogs(db);
    if (removed > 0) console.log(`[audit] Pruned ${removed} expired audit log entries`);
  } catch (err) {
    console.error("[audit] Initial prune failed:", err);
  }
  const handle = setInterval(() => {
    try {
      const removed = pruneAuditLogs(db);
      if (removed > 0) console.log(`[audit] Pruned ${removed} expired audit log entries`);
    } catch (err) {
      console.error("[audit] Prune failed:", err);
    }
  }, intervalMs);
  handle.unref?.();
  return handle;
}
