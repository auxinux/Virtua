import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../../api/client";
import { SnapshotModal } from "../SnapshotModal";
import { useAuth } from "../../utils/useAuth";

type RType = "vm" | "lxc" | "docker";
interface Row { type: RType; key: string; label: string; state: string; }

/**
 * Console-mode sidebar list: machines the user can access, with a status badge
 * and, under each one, state-aware action buttons (start/stop/restart/snapshot).
 * Selecting a machine opens it in the Console view (/console?m=type:key).
 */
export function SidebarConsoleList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const selectedKey = params.get("m");
  const { capabilities, getResourcePermissions } = useAuth();
  const isAdmin = capabilities?.role === "ADMIN";
  const [snap, setSnap] = useState<{ type: "vm" | "lxc"; name: string } | null>(null);

  const vms = useQuery<Array<{ name: string; state: string }>>({ queryKey: ["vms", "list"], queryFn: () => apiGet("/api/vms"), refetchInterval: 10_000 });
  const lxc = useQuery<Array<{ name: string; state: string }>>({ queryKey: ["lxc", "list"], queryFn: () => apiGet("/api/lxc"), refetchInterval: 10_000 });
  const docker = useQuery<Array<{ id: string; name: string; state: string }>>({ queryKey: ["docker", "list"], queryFn: () => apiGet("/api/docker/containers"), refetchInterval: 10_000 });

  const rows = useMemo<Row[]>(() => {
    const aVm = new Set(capabilities?.resources.vms.map((r) => r.name) ?? []);
    const aLxc = new Set(capabilities?.resources.lxc.map((r) => r.name) ?? []);
    const aDk = capabilities?.resources.docker.map((r) => r.id) ?? [];
    const out: Row[] = [];
    for (const v of vms.data ?? []) if (isAdmin || aVm.has(v.name)) out.push({ type: "vm", key: v.name, label: v.name, state: v.state });
    for (const c of lxc.data ?? []) if (isAdmin || aLxc.has(c.name)) out.push({ type: "lxc", key: c.name, label: c.name, state: c.state });
    for (const d of docker.data ?? []) {
      const ok = isAdmin || aDk.some((id) => id === d.id || id.startsWith(d.id.slice(0, 12)) || d.id.startsWith(id.slice(0, 12)));
      if (ok) out.push({ type: "docker", key: d.id, label: d.name || d.id.slice(0, 12), state: d.state });
    }
    return out;
  }, [vms.data, lxc.data, docker.data, capabilities, isAdmin]);

  const action = useMutation({
    mutationFn: async ({ r, verb }: { r: Row; verb: "start" | "stop" | "restart" }) => {
      const base = r.type === "docker" ? `/api/docker/containers/${encodeURIComponent(r.key)}` : `/api/${r.type === "vm" ? "vms" : "lxc"}/${encodeURIComponent(r.key)}`;
      let act = verb as string;
      if (r.type === "vm") act = verb === "restart" ? "reboot" : verb === "stop" ? "shutdown" : "start";
      return apiPost(`${base}/${act}`, {});
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vms"] }); qc.invalidateQueries({ queryKey: ["lxc"] }); qc.invalidateQueries({ queryKey: ["docker"] }); },
  });

  const TypeIcon = ({ t }: { t: RType }) => (
    <span className="text-text-500 shrink-0">
      {t === "vm" ? "🖥" : t === "lxc" ? "📦" : "🐳"}
    </span>
  );

  return (
    <div className="space-y-1.5 px-1">
      {rows.length === 0 && <div className="px-2 py-3 text-2xs text-text-500">Aucune machine</div>}
      {rows.map((r) => {
        const perms = getResourcePermissions(r.type, r.key);
        const running = r.state === "running";
        const sel = selectedKey === `${r.type}:${r.key}`;
        return (
          <div key={`${r.type}:${r.key}`} className={`rounded-lg border px-2 py-2 ${sel ? "border-accent-blue bg-accent-blue/10" : "border-surface-700 hover:bg-surface-700/40"}`}>
            <button onClick={() => navigate(`/console?m=${r.type}:${encodeURIComponent(r.key)}`)} className="w-full flex items-center gap-1.5 min-w-0" title={t(statusLabelKey(r.state))}>
              <TypeIcon t={r.type} />
              <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot(r.state)}`} />
              <span className={`text-xs font-medium truncate ${statusText(r.state)}`}>{r.label}</span>
            </button>
            {/* State-aware actions under each machine */}
            <div className="flex items-center gap-1.5 mt-2">
              <MiniBtn title={t("action.start")} disabled={!perms.canPower || running || action.isPending} onClick={() => action.mutate({ r, verb: "start" })} cls="text-green-400 hover:bg-green-900/40">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              </MiniBtn>
              <MiniBtn title={t("action.stop")} disabled={!perms.canPower || !running || action.isPending} onClick={() => action.mutate({ r, verb: "stop" })} cls="text-red-400 hover:bg-red-900/40">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
              </MiniBtn>
              <MiniBtn title={t("action.restart")} disabled={!perms.canPower || !running || action.isPending} onClick={() => action.mutate({ r, verb: "restart" })} cls="text-amber-400 hover:bg-amber-900/40">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </MiniBtn>
              {r.type !== "docker" && (
                <MiniBtn title={t("action.snapshot")} disabled={!perms.canSnapshot} onClick={() => setSnap({ type: r.type as "vm" | "lxc", name: r.key })} cls="text-accent-blue hover:bg-accent-blue/25">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>
                </MiniBtn>
              )}
            </div>
          </div>
        );
      })}
      {snap && <SnapshotModal open={!!snap} onClose={() => setSnap(null)} type={snap.type} name={snap.name} />}
    </div>
  );
}

/** Maps a resource state to a status category used for colours/labels. */
function statusKind(state: string): "up" | "paused" | "down" {
  const s = (state || "").toLowerCase();
  if (s === "running" || s === "up") return "up";
  if (s === "paused" || s === "frozen" || s === "suspended") return "paused";
  return "down"; // stopped, shut off, exited, created, dead, …
}
function statusDot(state: string): string {
  const k = statusKind(state);
  return k === "up" ? "bg-emerald-400" : k === "paused" ? "bg-amber-400" : "bg-red-400";
}
function statusText(state: string): string {
  const k = statusKind(state);
  return k === "up" ? "text-emerald-300" : k === "paused" ? "text-amber-300" : "text-text-400";
}
// statusLabel is resolved via t() at the call site (passed as title=)
// so we return the i18n key rather than a translated string.
function statusLabelKey(state: string): string {
  const k = statusKind(state);
  return k === "up" ? "status.running" : k === "paused" ? "status.paused" : "status.stopped";
}

function MiniBtn({ children, title, onClick, disabled, cls }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; cls: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 h-8 rounded-md flex items-center justify-center border border-surface-600 bg-surface-800/50 transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  );
}
