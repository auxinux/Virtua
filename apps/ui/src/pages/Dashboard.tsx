import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../api/client";
import { Gauge, MiniGauge } from "../components/ui/Gauge";
import { Sparkline } from "../components/ui/Sparkline";
import { formatBytes, formatUptime } from "../utils/formatBytes";
import type { SystemStats, SystemInfo, ResourceCounts } from "@auxinux/shared";
import { useSimpleMode } from "../utils/useSimpleMode";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Monitor, Play, Square, RefreshCcw, ExternalLink,
  Activity, Database, ShieldCheck, ChevronRight, LayoutGrid,
  Package
} from "lucide-react";

function StatCard({ label, value, sub, to, color = "bg-surface-700" }: { label: string; value: string | number; sub?: string; to?: string; color?: string }) {
  const content = (
    <div className={`${color} border border-surface-500 rounded-lg p-4 hover:border-surface-400 transition-colors shadow-sm`}>
      <div className="text-2xl font-bold text-text-100">{value}</div>
      <div className="text-sm font-medium text-text-300 mt-1">{label}</div>
      {sub && <div className="text-xs text-text-500 mt-0.5">{sub}</div>}
    </div>
  );
  if (to) return <Link to={to}>{content}</Link>;
  return content;
}

function LoadAvgBadge({ values }: { values: [number, number, number] }) {
  const getColor = (v: number, cpuCount: number) => {
    const ratio = v / cpuCount;
    if (ratio < 0.7) return "text-green-400";
    if (ratio < 1) return "text-yellow-400";
    return "text-red-400";
  };
  return (
    <div className="flex gap-3 text-sm">
      {values.map((v, i) => (
        <div key={i} className="text-center">
          <div className={`font-mono font-medium ${getColor(v, 1)}`}>{v.toFixed(2)}</div>
          <div className="text-2xs text-text-500">{i === 0 ? "1m" : i === 1 ? "5m" : "15m"}</div>
        </div>
      ))}
    </div>
  );
}

function GuestOverviewCard({ title, items, basePath, isSimple = false }: {
  title: string;
  items: Array<{ name: string; state: string; cpuPercent: number; memPercent: number; id?: string }>;
  basePath: string;
  isSimple?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-300 flex items-center gap-2">
          {isSimple ? <Monitor className="w-4 h-4 text-accent-blue" /> : null}
          {title}
        </h3>
        <span className="text-xs text-text-500">{items.length} total</span>
      </div>
      <div className="space-y-3">
        {items.slice(0, 8).map((item) => (
          <div key={item.id ?? item.name} className="group rounded-lg bg-surface-700/40 border border-transparent p-3 hover:bg-surface-700/70 hover:border-surface-500 transition-all duration-200">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${item.state === "running" ? "bg-state-running shadow-[0_0_8px_rgba(34,197,94,0.4)]" : "bg-text-500 opacity-50"}`} />
                <span className="font-semibold text-text-100">{item.name}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="p-1 hover:text-accent-blue transition-colors" title={t("action.start")}>
                  <Play className="w-3.5 h-3.5" />
                </button>
                <Link to={`${basePath}/${item.id ?? item.name}`} className="p-1 hover:text-accent-blue transition-colors">
                  <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
            {!isSimple ? (
              <div className="space-y-2">
                <MiniGauge value={item.cpuPercent} label="CPU" />
                <MiniGauge value={item.memPercent} label="Memory" />
              </div>
            ) : (
              <div className="flex items-center justify-between text-[10px] text-text-500">
                <span>{item.state === "running" ? "Actif" : "Éteint"}</span>
                <span className="font-mono">{item.state === "running" ? `${item.cpuPercent.toFixed(0)}% CPU` : ""}</span>
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <div className="text-sm text-text-500 italic py-4 text-center">Aucune machine disponible</div>}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { isSimpleMode } = useSimpleMode();
  const [history, setHistory] = useState<{ cpu: number[]; mem: number[]; disk: number[] }>({ cpu: [], mem: [], disk: [] });

  const { data: stats, isLoading: statsLoading } = useQuery<SystemStats>({
    queryKey: ["system", "stats"],
    queryFn: () => apiGet<SystemStats>("/api/system/stats"),
    refetchInterval: 5_000,
  });

  const { data: info } = useQuery<SystemInfo>({
    queryKey: ["system", "info"],
    queryFn: () => apiGet<SystemInfo>("/api/system/info"),
    staleTime: 60_000,
  });

  const { data: counts } = useQuery<ResourceCounts>({
    queryKey: ["system", "counts"],
    queryFn: () => apiGet<ResourceCounts>("/api/system/counts"),
    refetchInterval: 15_000,
  });

  const { data: guestOverview } = useQuery<{
    qemu: Array<{ name: string; state: string; cpuPercent: number; memPercent: number }>;
    lxc: Array<{ name: string; state: string; cpuPercent: number; memPercent: number }>;
    docker: Array<{ id: string; name: string; state: string; cpuPercent: number; memPercent: number }>;
  }>({
    queryKey: ["system", "guests-overview"],
    queryFn: () => apiGet("/api/system/guests-overview"),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!stats) return;
    setHistory((prev) => ({
      cpu: [...prev.cpu, stats.cpuUsage].slice(-24),
      mem: [...prev.mem, Math.round((stats.mem.used / Math.max(stats.mem.total, 1)) * 100)].slice(-24),
      disk: [...prev.disk, Math.round((stats.disk.used / Math.max(stats.disk.total, 1)) * 100)].slice(-24),
    }));
  }, [stats]);

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const memPercent = stats ? (stats.mem.used / stats.mem.total) * 100 : 0;
  const diskPercent = stats ? (stats.disk.used / stats.disk.total) * 100 : 0;

  return (
    <div className="space-y-6">
      <AnimatePresence mode="wait">
        {!isSimpleMode ? (
          <motion.div
            key="expert"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-bold text-text-100">{t("nav.dashboard")}</h1>
                {info && <p className="text-sm text-text-500 mt-0.5">{info.hostname} — {info.os}</p>}
              </div>
              {info && (
                <div className="text-right text-xs text-text-500">
                  <div>{t("dashboard.kernel")}: {info.kernel}</div>
                  <div>{t("dashboard.uptime")}: {formatUptime(info.uptime)}</div>
                </div>
              )}
            </div>

            {/* Resource Gauges */}
            <div className="card p-6">
              <h2 className="text-sm font-semibold text-text-300 mb-6 flex items-center gap-2">
                <Activity className="w-4 h-4 text-accent-blue" />
                {t("dashboard.hostResources")}
              </h2>
              <div className="space-y-6">
                {stats && (
                  <div className="flex flex-wrap gap-8 justify-center xl:justify-between">
                    <Gauge
                      value={stats.cpuUsage}
                      size={130}
                      label={t("res.cpu")}
                      sublabel={`${stats.cpuCount} cores — ${stats.loadavg[0].toFixed(2)} load`}
                    />
                    <Gauge
                      value={memPercent}
                      size={130}
                      label={t("res.memory")}
                      sublabel={`${formatBytes(stats.mem.used)} / ${formatBytes(stats.mem.total)}`}
                    />
                    <Gauge
                      value={diskPercent}
                      size={130}
                      label={t("res.rootDisk")}
                      sublabel={`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`}
                    />
                    <div className="flex flex-col items-center gap-2">
                      <div className="text-center">
                        <div className="text-xs text-text-400 mb-2">{t("res.networkIo")}</div>
                        <div className="space-y-2 min-w-[100px]">
                          <div className="flex justify-between gap-4">
                            <span className="text-xs text-text-500 uppercase tracking-tighter">TX</span>
                            <span className="text-sm font-mono text-text-200">{formatBytes(stats.network.txBytes)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-xs text-text-500 uppercase tracking-tighter">RX</span>
                            <span className="text-sm font-mono text-text-200">{formatBytes(stats.network.rxBytes)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="text-center mt-2 pt-2 border-t border-surface-600 w-full">
                        <LoadAvgBadge values={stats.loadavg} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-text-300 mb-3 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-green-400" />
                  {t("dashboard.hostTrends")}
                </h3>
                <div className="space-y-4">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-text-500 font-mono">
                      <span>CPU</span>
                      <span>{history.cpu[history.cpu.length - 1] ?? 0}%</span>
                    </div>
                    <Sparkline values={history.cpu} color="#40c057" />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-text-500 font-mono">
                      <span>MEM</span>
                      <span>{history.mem[history.mem.length - 1] ?? 0}%</span>
                    </div>
                    <Sparkline values={history.mem} color="#228be6" />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-text-500 font-mono">
                      <span>DISK</span>
                      <span>{history.disk[history.disk.length - 1] ?? 0}%</span>
                    </div>
                    <Sparkline values={history.disk} color="#fab005" />
                  </div>
                </div>
              </div>
              <GuestOverviewCard title="QEMU (VM)" items={guestOverview?.qemu ?? []} basePath="/vms" />
              <GuestOverviewCard title="LXC (Containers)" items={guestOverview?.lxc ?? []} basePath="/lxc" />
            </div>

            <GuestOverviewCard title="Docker (Apps)" items={guestOverview?.docker ?? []} basePath="/docker" />
          </motion.div>
        ) : (
          <motion.div
            key="simple"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="space-y-8"
          >
            {/* Header Simple */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-text-100">Bienvenue, {info?.hostname}</h1>
                <p className="text-text-400 mt-1">Gérez vos machines et serveurs en toute simplicité.</p>
              </div>
              <Link to="/create" className="btn-primary px-6 py-2.5 rounded-xl shadow-lg shadow-accent-blue/20 flex items-center gap-2 transition-transform hover:scale-[1.02] active:scale-[0.98]">
                <Plus className="w-5 h-5" />
                <span className="font-semibold">Nouvelle Machine</span>
              </Link>
            </div>

            {/* Simple Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="card p-5 border-l-4 border-l-accent-blue">
                <div className="flex items-center gap-3 text-text-300 mb-3">
                  <Monitor className="w-5 h-5" />
                  <span className="font-semibold">Ordinateurs</span>
                </div>
                <div className="text-3xl font-bold text-text-100">{counts?.vms.total ?? 0}</div>
                <div className="text-xs text-text-500 mt-1">{counts?.vms.running ?? 0} actifs actuellement</div>
              </div>
              <div className="card p-5 border-l-4 border-l-green-500">
                <div className="flex items-center gap-3 text-text-300 mb-3">
                  <LayoutGrid className="w-5 h-5" />
                  <span className="font-semibold">Conteneurs</span>
                </div>
                <div className="text-3xl font-bold text-text-100">{counts?.lxc.total ?? 0}</div>
                <div className="text-xs text-text-500 mt-1">{counts?.lxc.running ?? 0} actifs actuellement</div>
              </div>
              <div className="card p-5 border-l-4 border-l-purple-500">
                <div className="flex items-center gap-3 text-text-300 mb-3">
                  <Package className="w-5 h-5" />
                  <span className="font-semibold">Applications</span>
                </div>
                <div className="text-3xl font-bold text-text-100">{counts?.docker.total ?? 0}</div>
                <div className="text-xs text-text-500 mt-1">{counts?.docker.running ?? 0} actives actuellement</div>
              </div>
              <div className="card p-5 border-l-4 border-l-amber-500">
                <div className="flex items-center gap-3 text-text-300 mb-3">
                  <Database className="w-5 h-5" />
                  <span className="font-semibold">Stockage</span>
                </div>
                <div className="text-3xl font-bold text-text-100">{counts?.storageUsedGb ?? 0} GB</div>
                <div className="text-xs text-text-500 mt-1">sur {counts?.storageTotalGb ?? 0} GB utilisés</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">
                <h2 className="text-lg font-bold text-text-200 flex items-center gap-2">
                  <Monitor className="w-5 h-5 text-accent-blue" />
                  Mes Ordinateurs Virtuels
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {(guestOverview?.qemu ?? []).length > 0 ? (
                    guestOverview?.qemu.map(vm => (
                      <div key={vm.name} className="card p-5 group hover:border-accent-blue transition-all duration-300">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${vm.state === "running" ? "bg-green-500/10 text-green-400" : "bg-surface-600 text-text-500"}`}>
                              <Monitor className="w-6 h-6" />
                            </div>
                            <div>
                              <div className="font-bold text-text-100">{vm.name}</div>
                              <div className="text-xs text-text-500">{vm.state === "running" ? "Allumé" : "Éteint"}</div>
                            </div>
                          </div>
                          <div className={`w-3 h-3 rounded-full ${vm.state === "running" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" : "bg-text-600"}`} />
                        </div>
                        <div className="flex items-center gap-2">
                          {vm.state === "running" ? (
                            <button className="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                              <Square className="w-4 h-4 fill-current" /> Arrêter
                            </button>
                          ) : (
                            <button className="flex-1 bg-green-500/10 hover:bg-green-500/20 text-green-400 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                              <Play className="w-4 h-4 fill-current" /> Démarrer
                            </button>
                          )}
                          <Link to={`/vms/${vm.name}`} className="p-2 bg-surface-600 hover:bg-surface-500 rounded-lg text-text-300 transition-colors">
                            <ExternalLink className="w-5 h-5" />
                          </Link>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="col-span-2 py-12 text-center card bg-surface-800/50 border-dashed">
                       <p className="text-text-400">Aucun ordinateur virtuel créé.</p>
                       <Link to="/create" className="text-accent-blue hover:underline text-sm mt-2 inline-block">Créer ma première machine</Link>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <h2 className="text-lg font-bold text-text-200 flex items-center gap-2">
                  <LayoutGrid className="w-5 h-5 text-green-500" />
                  Conteneurs & Apps
                </h2>
                <div className="space-y-3">
                  {[...(guestOverview?.lxc ?? []), ...(guestOverview?.docker ?? [])].slice(0, 6).map((app: any) => (
                    <Link key={app.id ?? app.name} to={app.id ? `/docker/${app.id}` : `/lxc/${app.name}`} className="flex items-center justify-between p-3 rounded-xl bg-surface-700/50 border border-surface-600 hover:border-surface-400 transition-all">
                      <div className="flex items-center gap-3">
                         <div className={`w-2 h-2 rounded-full ${app.state === "running" ? "bg-green-500" : "bg-text-600"}`} />
                         <span className="text-sm font-medium text-text-200">{app.name}</span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-text-500" />
                    </Link>
                  ))}
                  {([...(guestOverview?.lxc ?? []), ...(guestOverview?.docker ?? [])].length === 0) && (
                    <div className="py-8 text-center text-text-500 italic text-sm">Rien à afficher</div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
