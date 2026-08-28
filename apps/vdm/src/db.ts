import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

export const DATA_DIR = process.env.AUXINUX_VDM_DATA_DIR ?? "/var/lib/auxinux-vdm";
const DB_PATH = process.env.AUXINUX_VDM_DB ?? path.join(DATA_DIR, "vdm.sqlite");

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureParentDirectory(DB_PATH);
  _db = new Database(DB_PATH);
  // WAL is excellent on local disks, but is unsafe on a cluster filesystem.
  // HA runs exactly one fenced VDM process and uses the rollback journal so a
  // Pacemaker relocation can reopen SQLite safely on the surviving node.
  _db.pragma(process.env.AUXINUX_VDM_HA_ENABLED === "1" ? "journal_mode = DELETE" : "journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  migrateColumns(_db);
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vdm_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdm_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      api_url TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdm_shared_storage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      mount_options TEXT,
      smb_domain TEXT,
      smb_username TEXT,
      smb_password TEXT,
      smb_version TEXT,
      nfs_version TEXT,
      s3_endpoint TEXT,
      s3_bucket TEXT,
      s3_region TEXT,
      s3_access_key TEXT,
      s3_secret_key TEXT,
      s3_provider TEXT,
      s3_vfs_cache_mode TEXT,
      local_mount_path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '["iso","backup","disk"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdm_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      source_node TEXT,
      target_node TEXT,
      resource_type TEXT,
      resource_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdm_join_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      note TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdm_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vdm_resource_locks (
      resource_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      owner_instance TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES vdm_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vdm_backup_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      storage_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      encryption_enabled INTEGER NOT NULL DEFAULT 0,
      retention_daily INTEGER NOT NULL DEFAULT 7,
      retention_weekly INTEGER NOT NULL DEFAULT 4,
      retention_monthly INTEGER NOT NULL DEFAULT 6,
      quota_bytes INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(storage_name) REFERENCES vdm_shared_storage(name) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS vdm_backup_items (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      task_id TEXT,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      source_node TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL,
      compression TEXT,
      checksum_sha256 TEXT,
      verified_at TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(repository_id) REFERENCES vdm_backup_repositories(id) ON DELETE RESTRICT,
      FOREIGN KEY(task_id) REFERENCES vdm_tasks(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vdm_backup_jobs (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      repository_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      source_node TEXT NOT NULL,
      schedule TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      compress INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(repository_id) REFERENCES vdm_backup_repositories(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS vdm_instances (
      instance_id TEXT PRIMARY KEY,
      cluster_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'active',
      leader_epoch INTEGER NOT NULL DEFAULT 0,
      last_heartbeat TEXT NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS vdm_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      remote_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Central operational log (LOGS page). Timestamps are stored in UTC (ISO 8601);
    -- the UI renders them in the viewer timezone. "source" is "vdm" or a node name.
    CREATE TABLE IF NOT EXISTS vdm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vdm_tasks_status ON vdm_tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_vdm_backup_items_resource ON vdm_backup_items(resource_type, resource_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_vdm_backup_jobs_next_run ON vdm_backup_jobs(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_vdm_audit_created ON vdm_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_vdm_logs_ts ON vdm_logs(ts);
    -- Dedupe key for node log polling (re-polls must not duplicate rows).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vdm_logs_dedupe ON vdm_logs(source, ts, message);
  `);
}

function migrateColumns(db: Database.Database) {
  const columns = (table: string) => new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
  const add = (table: string, column: string, definition: string) => {
    if (!columns(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  add("vdm_shared_storage", "smb_version", "TEXT");
  add("vdm_shared_storage", "nfs_version", "TEXT");
  // S3 / object storage fields
  add("vdm_shared_storage", "s3_endpoint", "TEXT");
  add("vdm_shared_storage", "s3_bucket", "TEXT");
  add("vdm_shared_storage", "s3_region", "TEXT");
  add("vdm_shared_storage", "s3_access_key", "TEXT");
  add("vdm_shared_storage", "s3_secret_key", "TEXT");
  add("vdm_shared_storage", "s3_provider", "TEXT");
  add("vdm_shared_storage", "s3_vfs_cache_mode", "TEXT");
  add("vdm_nodes", "virtua_version", "TEXT");
  add("vdm_nodes", "compatibility", "TEXT NOT NULL DEFAULT 'unknown'");
  add("vdm_nodes", "last_error", "TEXT");
  add("vdm_nodes", "failure_count", "INTEGER NOT NULL DEFAULT 0");
  add("vdm_nodes", "latency_ms", "INTEGER");
  add("vdm_users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  add("vdm_tasks", "operation_key", "TEXT");
  add("vdm_tasks", "attempt", "INTEGER NOT NULL DEFAULT 1");
  add("vdm_tasks", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
  add("vdm_tasks", "started_at", "TEXT");
  add("vdm_tasks", "finished_at", "TEXT");
  add("vdm_tasks", "heartbeat_at", "TEXT");
  add("vdm_tasks", "recovery_data", "TEXT");
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM vdm_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string | null): void {
  if (value === null) {
    db.prepare("DELETE FROM vdm_settings WHERE key = ?").run(key);
  } else {
    db.prepare("INSERT OR REPLACE INTO vdm_settings (key, value) VALUES (?, ?)").run(key, value);
  }
}
