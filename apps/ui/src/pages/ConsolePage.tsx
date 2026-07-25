import React, { useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../api/client";
import { StatusBadge } from "../components/ui/Badge";
import { MetricBar } from "../components/ui/MetricBar";
import { Terminal } from "../components/Terminal";
import { NoVncConsole } from "../components/NoVncConsole";
import { SpiceConsole } from "../components/SpiceConsole";
import { SnapshotModal } from "../components/SnapshotModal";
import { useAuth } from "../utils/useAuth";
import { formatBytes } from "../utils/formatBytes";

type RType = "vm" | "lxc" | "docker";

interface UnifiedResource {
  type: RType;
  /** RBAC + API key: vm/lxc = name, docker = id */
  key: string;
  label: string;
  state: string;
  ip?: string;
  node?: string;
  ownerId?: number;
}

const TYPE_ICON: Record<RType, JSX.Element> = {
  vm: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" /></svg>
  ),
  lxc: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
  ),
  docker: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 13h16M4 13a8 8 0 008 8 8 8 0 008-8M4 13V9a1 1 0 011-1h2m12 5V9a1 1 0 00-1-1h-2M8 8V5a1 1 0 011-1h6a1 1 0 011 1v3" /></svg>
  ),
};

export default function ConsolePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { capabilities, getResourcePermissions } = useAuth();
  const isAdmin = capabilities?.role === "ADMIN";

  const [searchParams] = useSearchParams();
  const [selected, setSelected] = useState<{ type: RType; key: string } | null>(null);
  const [vmConsoleMode, setVmConsoleMode] = useState<"vnc" | "spice">("vnc");
  const consoleRef = useRef<HTMLDivElement>(null);

  // Allow the sidebar (Console view) to preselect a machine via ?m=type:key
  React.useEffect(() => {
    const m = searchParams.get("m");
    if (!m) return;
    const [type, ...rest] = m.split(":");
    const key = rest.join(":");
    if ((type === "vm" || type === "lxc" || type === "docker") && key) {
      setSelected({ type, key });
    }
  }, [searchParams]);

  const vms = useQuery<Array<{ name: string; state: string; ipAddress?: string; userId?: number; node?: string }>>({
    queryKey: ["vms", "list"], queryFn: () => apiGet("/api/vms"), refetchInterval: 10_000,
  });
  const lxc = useQuery<Array<{ name: string; state: string; ipAddress?: string; userId?: number; node?: string }>>({
    queryKey: ["lxc", "list"], queryFn: () => apiGet("/api/lxc"), refetchInterval: 10_000,
  });
  const docker = useQuery<Array<{ id: string; name: string; state: string; userId?: number; node?: string }>>({
    queryKey: ["docker", "list"], queryFn: () => apiGet("/api/docker/containers"), refetchInterval: 10_000,
  });

  // Client-side RBAC narrowing (server already filters; this keeps the list tight for USERs).
  const resources: UnifiedResource[] = useMemo(() => {
    const assignedVm = new Set(capabilities?.resources.vms.map((r) => r.name) ?? []);
    const assignedLxc = new Set(capabilities?.resources.lxc.map((r) => r.name) ?? []);
    const assignedDk = capabilities?.resources.docker.map((r) => r.id) ?? [];
    const out: UnifiedResource[] = [];
    for (const v of vms.data ?? []) {
      if (!isAdmin && !assignedVm.has(v.name)) continue;
      out.push({ type: "vm", key: v.name, label: v.name, state: v.state, ip: (v as { ipAddress?: string }).ipAddress, node: v.node, ownerId: v.userId });
    }
    for (const c of lxc.data ?? []) {
      if (!isAdmin && !assignedLxc.has(c.name)) continue;
      out.push({ type: "lxc", key: c.name, label: c.name, state: c.state, ip: c.ipAddress, node: c.node, ownerId: c.userId });
    }
    for (const d of docker.data ?? []) {
      const allowed = isAdmin || assignedDk.some((aid) => aid === d.id || aid.startsWith(d.id.slice(0, 12)) || d.id.startsWith(aid.slice(0, 12)));
      if (!allowed) continue;
      out.push({ type: "docker", key: d.id, label: d.name || d.id.slice(0, 12), state: d.state, node: d.node, ownerId: d.userId });
    }
    return out;
  }, [vms.data, lxc.data, docker.data, capabilities, isAdmin]);

  const current = selected ? resources.find((r) => r.type === selected.type && r.key === selected.key) ?? null : null;
  const perms = current ? getResourcePermissions(current.type, current.key) : null;
  const running = current?.state === "running";

  // Live stats for the selected machine, normalized across VM/LXC/Docker.
  const statsUrl = current
    ? current.type === "vm" ? `/api/vms/${encodeURIComponent(current.key)}/stats`
      : current.type === "lxc" ? `/api/lxc/${encodeURIComponent(current.key)}/stats`
      : `/api/docker/containers/${encodeURIComponent(current.key)}/stats`
    : null;
  const liveStats = useQuery<Record<string, number>>({
    queryKey: ["console", "stats", current?.type, current?.key],
    queryFn: () => apiGet(statsUrl!),
    enabled: !!current && !!running && !!statsUrl,
    refetchInterval: 3000,
  });
  const norm = (() => {
    const s = liveStats.data;
    if (!s || !current) return null;
    if (current.type === "vm") {
      return { cpu: s.cpuPercent ?? 0, memUsed: (s.memoryUsedKiB ?? 0) * 1024, memTotal: (s.balloonCurrentKiB ?? 0) * 1024, rx: s.netRxBytes ?? 0, tx: s.netTxBytes ?? 0 };
    }
    if (current.type === "lxc") {
      return { cpu: s.cpuPercent ?? 0, memUsed: s.memUsedBytes ?? 0, memTotal: s.memTotalBytes ?? 0, rx: s.netRxBytes ?? 0, tx: s.netTxBytes ?? 0 };
    }
    return { cpu: s.cpuPercent ?? 0, memUsed: s.memUsedBytes ?? 0, memTotal: s.memLimitBytes ?? 0, rx: s.netRxBytes ?? 0, tx: s.netTxBytes ?? 0 };
  })();

  function openConfig() {
    if (!current) return;
    const path = current.type === "vm" ? `/vms/${encodeURIComponent(current.key)}`
      : current.type === "lxc" ? `/lxc/${encodeURIComponent(current.key)}`
      : `/docker/${encodeURIComponent(current.key)}`;
    navigate(path);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  const action = useMutation({
    mutationFn: async ({ r, verb }: { r: UnifiedResource; verb: "start" | "stop" | "restart" | "reset" | "forceStop" }) => {
      const base = r.type === "docker" ? `/api/docker/containers/${encodeURIComponent(r.key)}` : `/api/${r.type === "vm" ? "vms" : "lxc"}/${encodeURIComponent(r.key)}`;
      let act = verb as string;
      if (r.type === "vm") {
        if (verb === "restart") act = "reboot";
        else if (verb === "stop") act = "shutdown";
        // reset and forceStop are passed through as-is (in QEMU_ACTION_ALLOWLIST)
      }
      return apiPost(`${base}/${act}`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms"] });
      qc.invalidateQueries({ queryKey: ["lxc"] });
      qc.invalidateQueries({ queryKey: ["docker"] });
    },
  });

  const [snapModal, setSnapModal] = useState<{ type: "vm" | "lxc"; name: string } | null>(null);
  const [statsCollapsed, setStatsCollapsed] = useState(false);

  function ticketPath(r: UnifiedResource): string {
    if (r.type === "vm") return `/api/vms/${encodeURIComponent(r.key)}/console-ticket`;
    if (r.type === "lxc") return `/api/lxc/${encodeURIComponent(r.key)}/console-ticket`;
    return `/api/docker/containers/${encodeURIComponent(r.key)}/console-ticket`;
  }

  function goFullscreen() {
    consoleRef.current?.requestFullscreen?.().catch(() => {});
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] p-4">
      {/* The machine list now lives in the sidebar (VUE → Console). This page is
          the full-width console of the selected machine. */}
      <div className="h-full card flex flex-col overflow-hidden">
        {!current ? (
          <div className="flex-1 flex items-center justify-center text-text-500 text-center px-6">
            {t("console.selectHintSidebar", "Choisis une machine dans le menu de gauche (VUE → Console) pour ouvrir sa console.")}
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-surface-600">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg font-bold text-text-100">{current.label}</h1>
                    <StatusBadge state={current.state} />
                  </div>
                  {/* Subtitle row — when stats are collapsed, CPU/RAM appear here inline */}
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-text-500">
                      {current.type.toUpperCase()}{current.node ? ` / ${current.node}` : ""}{current.ip ? ` / ${current.ip}` : ""}
                    </span>
                    {running && norm && statsCollapsed && (
                      <>
                        <span className="text-surface-600 text-xs">·</span>
                        <button
                          onClick={() => setStatsCollapsed(false)}
                          className="flex items-center gap-2 text-2xs text-text-500 hover:text-text-300 transition-colors group"
                          title={t("console.expandStats", "Afficher les stats")}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                          <span className="font-mono">
                            CPU <span className="text-text-300">{norm.cpu.toFixed(1)}%</span>
                            <span className="mx-1.5 text-surface-500">·</span>
                            RAM <span className="text-text-300">{formatBytes(norm.memUsed)}/{formatBytes(norm.memTotal)}</span>
                          </span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-1">
                    {(() => {
                      const canPower = !!perms?.canPower;
                      const busy = action.isPending;
                      return (
                        <>
                          <ActionBtn title={t("action.start", "Démarrer")} disabled={!canPower || running || busy} onClick={() => action.mutate({ r: current, verb: "start" })} color="green">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                          </ActionBtn>
                          <ActionBtn title={t("action.stop", "Arrêter")} disabled={!canPower || !running || busy} onClick={() => action.mutate({ r: current, verb: "stop" })} color="red">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" /></svg>
                          </ActionBtn>
                          <ActionBtn title={t("action.restart", "Redémarrer")} disabled={!canPower || !running || busy} onClick={() => action.mutate({ r: current, verb: "restart" })} color="amber">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          </ActionBtn>
                          {current.type === "vm" && (
                            <>
                              {/* Reset — hard reset (virsh reset), like pressing the reset button */}
                              <ActionBtn title={t("action.reset", "Reset forcé")} disabled={!canPower || !running || busy} onClick={() => action.mutate({ r: current, verb: "reset" })} color="orange">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                              </ActionBtn>
                              {/* Force Stop — virsh destroy, instant power cut */}
                              <ActionBtn title={t("action.forceStop", "Forcer l'arrêt")} disabled={!canPower || !running || busy} onClick={() => action.mutate({ r: current, verb: "forceStop" })} color="darkred">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" strokeWidth={2} /><line x1="12" y1="7" x2="12" y2="12" strokeWidth={2} strokeLinecap="round" /></svg>
                              </ActionBtn>
                            </>
                          )}
                          {current.type !== "docker" && (
                            <ActionBtn title={t("action.snapshot", "Snapshot")} disabled={!perms?.canSnapshot} onClick={() => setSnapModal({ type: current.type as "vm" | "lxc", name: current.key })} color="blue">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>
                            </ActionBtn>
                          )}
                          <ActionBtn title={t("console.fullscreen", "Plein écran")} onClick={goFullscreen} color="gray">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                          </ActionBtn>
                        </>
                      );
                    })()}
                  </div>
                  {/* Configuration → full machine detail page */}
                  <button onClick={openConfig} className="btn-secondary btn-sm flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" /></svg>
                    {t("console.configuration", "Configuration")}
                  </button>
                </div>
              </div>

              {/* Real-time stats strip — collapsible; summary moves to subtitle when collapsed */}
              {running && norm && !statsCollapsed && (
                <div className="mt-3">
                  {/* Collapse button — only shown when expanded */}
                  <button
                    onClick={() => setStatsCollapsed(true)}
                    className="flex items-center gap-1.5 text-2xs text-text-500 hover:text-text-300 transition-colors mb-2 group"
                    title={t("console.collapseStats", "Masquer les stats")}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                    <span className="group-hover:text-text-400">{t("console.collapseStats", "Masquer les stats")}</span>
                  </button>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                    <MetricBar label="CPU" value={norm.cpu} valueLabel={`${norm.cpu.toFixed(1)}%`} />
                    <MetricBar label="RAM" value={norm.memTotal ? (norm.memUsed / norm.memTotal) * 100 : 0} valueLabel={`${formatBytes(norm.memUsed)} / ${formatBytes(norm.memTotal)}`} />
                    <div className="flex items-center justify-between text-2xs text-text-400">
                      <span>NET IN ↓</span><span className="font-mono text-text-300">{formatBytes(norm.rx)}</span>
                    </div>
                    <div className="flex items-center justify-between text-2xs text-text-400">
                      <span>NET OUT ↑</span><span className="font-mono text-text-300">{formatBytes(norm.tx)}</span>
                    </div>
                  </div>
                </div>
              )}

              {action.error && (
                <div className="mt-3 rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-300">
                  {(action.error as Error)?.message || t("msg.actionFailed", "L'action a échoué")}
                </div>
              )}

              {/* Console mode selector. */}
              <div className="flex gap-2 mt-4">
                {current.type === "vm" ? (
                  <div className="flex items-center gap-2">
                  <div className="inline-flex items-center rounded-md border border-surface-500 bg-surface-700/70 p-0.5 text-sm">
                    <button
                      type="button"
                      onClick={() => setVmConsoleMode("vnc")}
                      className={`rounded px-3 py-1 transition-colors ${vmConsoleMode === "vnc" ? "bg-accent-blue text-white" : "text-text-400 hover:text-text-200"}`}
                    >
                      {t("console.graphical", "Console graphique")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setVmConsoleMode("spice")}
                      className={`rounded px-3 py-1 transition-colors ${vmConsoleMode === "spice" ? "bg-accent-blue text-white" : "text-text-400 hover:text-text-200"}`}
                    >
                      SPICE
                    </button>
                  </div>
                  <div id="console-page-spice-toolbar" className="flex items-center gap-2" />
                  </div>
                ) : (
                  <span className="px-3 py-1.5 rounded text-sm font-medium bg-accent-blue text-white">
                    {t("console.textTerminal", "Terminal texte")}
                  </span>
                )}
              </div>
            </div>

            {/* Console body. The key includes the live state so the console
                remounts (reconnects + refits) automatically when the machine is
                started/stopped — no manual refresh needed. */}
            <div ref={consoleRef} className="flex-1 bg-black overflow-hidden">
              {!perms?.canConsole ? (
                <div className="h-full flex items-center justify-center text-text-500 text-sm">
                  {t("console.noConsolePerm", "Vous n'avez pas la permission console sur cette machine")}
                </div>
              ) : current.state !== "running" ? (
                <div className="h-full flex items-center justify-center text-text-500 text-sm">
                  {t("console.notRunning", "La machine n'est pas démarrée — démarre-la pour ouvrir la console.")}
                </div>
              ) : current.type === "vm" ? (
                vmConsoleMode === "spice"
                  ? <SpiceConsole key={`spice:${current.key}:${current.state}`} ticketPath={`/api/vms/${encodeURIComponent(current.key)}/spice-ticket`} className="h-full" bare toolbarId="console-page-spice-toolbar" />
                  : <NoVncConsole key={`vnc:${current.key}:${current.state}`} ticketPath={`/api/vms/${encodeURIComponent(current.key)}/vnc-ticket`} className="h-full" />
              ) : (
                <Terminal key={`term:${current.type}:${current.key}:${current.state}`} ticketPath={ticketPath(current)} className="h-full" />
              )}
            </div>
          </>
        )}
      </div>

      {snapModal && (
        <SnapshotModal open={!!snapModal} onClose={() => setSnapModal(null)} type={snapModal.type} name={snapModal.name} />
      )}
    </div>
  );
}

function ActionBtn({ children, title, onClick, disabled, color }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; color: "green" | "red" | "amber" | "blue" | "gray" | "orange" | "darkred" }) {
  const colors: Record<string, string> = {
    green: "text-green-400 hover:bg-green-900/30",
    red: "text-red-400 hover:bg-red-900/30",
    amber: "text-amber-400 hover:bg-amber-900/30",
    blue: "text-accent-blue hover:bg-accent-blue/20",
    gray: "text-text-400 hover:bg-surface-600",
    orange: "text-orange-400 hover:bg-orange-900/30",
    darkred: "text-red-500 hover:bg-red-950/50",
  };
  return (
    <button title={title} onClick={onClick} disabled={disabled} className={`p-2 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${colors[color]}`}>
      {children}
    </button>
  );
}
