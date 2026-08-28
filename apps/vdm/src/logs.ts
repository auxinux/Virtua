// ── Central operational log (LOGS page) ─────────────────────────────────────
// All timestamps are stored in UTC (ISO 8601). The UI renders them in the
// viewer's timezone. Sources: "vdm" (this orchestrator) or a node name.
import type Database from "better-sqlite3";

export type VdmLogLevel = "warn" | "error" | "info";
export type VdmLogCategory = "storage" | "backup" | "migration" | "nodes" | "system";

export interface VdmLogSettings {
  enabled: boolean;
  minLevel: VdmLogLevel;
  retentionDays: number;
  categories: VdmLogCategory[];
}

export const LOG_SETTINGS_KEY = "logsConfig";

const LEVEL_SEVERITY: Record<VdmLogLevel, number> = { info: 0, warn: 1, error: 2 };
const DEFAULT_SETTINGS: VdmSettingsShape = {
  enabled: true,
  minLevel: "warn",
  retentionDays: 30,
  categories: ["storage", "backup", "migration", "nodes", "system"],
};
interface VdmSettingsShape {
  enabled: boolean;
  minLevel: VdmLogLevel;
  retentionDays: number;
  categories: VdmLogCategory[];
}

export function parseLogSettings(raw: string | null): VdmLogSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<VdmSettingsShape>;
    const minLevel = parsed.minLevel === "info" || parsed.minLevel === "warn" || parsed.minLevel === "error" ? parsed.minLevel : DEFAULT_SETTINGS.minLevel;
    const retentionDays = Number.isFinite(parsed.retentionDays) ? Math.max(1, Math.min(365, Math.trunc(parsed.retentionDays as number))) : DEFAULT_SETTINGS.retentionDays;
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.filter((c): c is VdmLogCategory => ["storage", "backup", "migration", "nodes", "system"].includes(c as string))
      : DEFAULT_SETTINGS.categories;
    return {
      enabled: parsed.enabled !== false,
      minLevel,
      retentionDays,
      categories: categories.length ? categories : DEFAULT_SETTINGS.categories,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function serializeLogSettings(settings: VdmLogSettings): string {
  return JSON.stringify(settings);
}

export function shouldLog(settings: VdmLogSettings, level: VdmLogLevel, category: VdmLogCategory): boolean {
  if (!settings.enabled) return false;
  if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[settings.minLevel]) return false;
  return settings.categories.includes(category);
}

export function recordVdmLog(
  db: Database.Database,
  level: VdmLogLevel,
  source: string,
  category: VdmLogCategory,
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    db.prepare("INSERT OR IGNORE INTO vdm_logs (ts, level, source, category, message, meta) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), level, source, category, message.slice(0, 4000), meta ? JSON.stringify(meta).slice(0, 4000) : null);
  } catch {
    // Logging must never crash an operation.
  }
}

export function purgeOldLogs(db: Database.Database, retentionDays: number): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    db.prepare("DELETE FROM vdm_logs WHERE ts < ?").run(cutoff);
  } catch {
    // Ignore.
  }
}