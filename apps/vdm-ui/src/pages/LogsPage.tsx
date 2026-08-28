import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import { formatLogTs, localTimezoneLabel, type LogEntry, type LogsConfig } from "@/lib/time";

const ICONS = {
  logs: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z",
  refresh: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
  info: "m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z",
};

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const LEVELS = ["", "warn", "error"] as const;
const CATEGORIES = ["", "storage", "backup", "migration", "nodes", "system"] as const;

function levelBadgeClass(level: string): string {
  if (level === "error") return "border-vdm-danger/40 bg-vdm-danger/10 text-vdm-danger";
  if (level === "warn") return "border-vdm-warning/40 bg-vdm-warning/10 text-vdm-warning";
  return "border-vdm-border bg-vdm-bg text-vdm-textMuted";
}

export default function LogsPage() {
  const { isAdmin } = useVdmAuth();
  const qc = useQueryClient();
  const [level, setLevel] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const logsQuery = useQuery<LogEntry[]>({
    queryKey: ["vdm-logs", level, category, source],
    queryFn: () => {
      const params = new URLSearchParams();
      if (level) params.set("level", level);
      if (category) params.set("category", category);
      if (source) params.set("source", source);
      params.set("limit", "300");
      return api.get(`/api/vdm/logs?${params.toString()}`);
    },
    refetchInterval: autoRefresh ? 15_000 : false,
  });

  const nodesQuery = useQuery<Array<{ name: string; displayName: string }>>({
    queryKey: ["vdm-nodes"],
    queryFn: () => api.get("/api/vdm/nodes"),
    staleTime: 60_000,
  });

  const entries = logsQuery.data ?? [];
  const nodeNames = Array.from(new Set(entries.map((e) => e.source)));
  const hasVdm = nodeNames.includes("vdm");

  const clearLogs = () => {
    if (confirm("Vider tout le journal LOGS ? Cette action est irréversible.")) {
      api.delete("/api/vdm/logs").then(() => qc.invalidateQueries({ queryKey: ["vdm-logs"] }));
    }
  };

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">LOGS</h1>
          <p className="text-sm text-vdm-textMuted">
            Journal opérationnel — warnings et erreurs de VDM et des nœuds.
            {" "}Heures affichées en heure locale : <span className="font-mono text-vdm-text">{localTimezoneLabel()}</span> (stockage UTC).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-vdm-textMuted cursor-pointer">
            <input type="checkbox" className="rounded" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh (15 s)
          </label>
          <button className="vdm-btn-ghost text-xs" onClick={() => logsQuery.refetch()} disabled={logsQuery.isFetching}>
            <Icon path={ICONS.refresh} className="w-3.5 h-3.5" />
            Refresh
          </button>
          {isAdmin && (
            <button className="vdm-btn-danger text-xs" onClick={clearLogs}>Clear</button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select className="vdm-input w-auto" value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l === "" ? "Tous niveaux" : l === "warn" ? "Warnings" : "Errors"}</option>)}
        </select>
        <select className="vdm-input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c === "" ? "Toutes catégories" : c}</option>)}
        </select>
        <select className="vdm-input w-auto" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Toutes sources</option>
          {hasVdm && <option value="vdm">VDM</option>}
          {(nodesQuery.data ?? []).map((n) => <option key={n.name} value={n.name}>{n.displayName || n.name}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="vdm-card divide-y divide-vdm-border/50 overflow-hidden">
        {logsQuery.isLoading ? (
          <div className="p-10 flex justify-center"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : entries.length === 0 ? (
          <div className="p-10 text-center">
            <Icon path={ICONS.logs} className="w-10 h-10 text-vdm-textMuted/50 mx-auto" />
            <p className="mt-2 text-sm text-vdm-textMuted">Aucune entrée — aucun problème détecté pour ces filtres.</p>
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="px-4 py-2.5 flex items-start gap-3 hover:bg-vdm-bg/30 transition-colors">
              <span className={`mt-0.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider flex-shrink-0 ${levelBadgeClass(e.level)}`}>
                {e.level}
              </span>
              <span className="font-mono text-xs text-vdm-textMuted mt-0.5 flex-shrink-0 w-40">{formatLogTs(e.ts)}</span>
              <span className="rounded-md border border-vdm-border px-1.5 py-0.5 text-[10px] font-medium uppercase text-vdm-textMuted flex-shrink-0">{e.category}</span>
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium flex-shrink-0 ${e.source === "vdm" ? "border-vdm-accent/40 bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border bg-vdm-bg text-vdm-text"}`}>
                {e.source === "vdm" ? "VDM" : e.source}
              </span>
              <span className="text-sm text-vdm-text font-mono break-all min-w-0">{e.message}</span>
            </div>
          ))
        )}
      </div>
      {entries.length > 0 && (
        <p className="text-xs text-vdm-textMuted/70">{entries.length} entrée(s) affichée(s) · triées de la plus récente à la plus ancienne</p>
      )}
    </div>
  );
}