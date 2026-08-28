// Timezone display helpers — VDM stores/exports everything in UTC (ISO 8601).
// The UI renders timestamps in the viewer's timezone (Europe/Montreal → UTC-4/-5).

export interface LogEntry {
  id: number;
  ts: string;
  level: "warn" | "error" | "info";
  source: string;
  category: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface LogsConfig {
  enabled: boolean;
  minLevel: "warn" | "error" | "info";
  retentionDays: number;
  categories: string[];
}

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = DTF_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("fr-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    DTF_CACHE.set(timeZone, f);
  }
  return f;
}

/** ISO UTC → "AAAA-MM-JJ HH:MM:SS" dans le fuseau du navigateur. */
export function formatLogTs(tsUtc: string): string {
  const d = new Date(tsUtc);
  if (Number.isNaN(d.getTime())) return tsUtc;
  const parts = dtf(Intl.DateTimeFormat().resolvedOptions().timeZone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Fuseau IANA du navigateur + décalage courant, ex. "America/Toronto (UTC−04:00)". */
export function localTimezoneLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "−";
  const h = Math.floor(Math.abs(offsetMin) / 60);
  const m = Math.abs(offsetMin) % 60;
  return `${tz} (UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")})`;
}