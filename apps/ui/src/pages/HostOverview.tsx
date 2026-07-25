import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet } from "../api/client";
import { Tabs } from "../components/ui/Tabs";
import { Gauge } from "../components/ui/Gauge";
import { formatBytes, formatUptime } from "../utils/formatBytes";
import HealthPage from "./HealthPage";
import HostShell from "./HostShell";
import type { SystemInfo, SystemStats } from "@auxinux/shared";

function HostSummaryTab() {
  const { t } = useTranslation();
  const { data: info } = useQuery<SystemInfo>({
    queryKey: ["system", "info"],
    queryFn: () => apiGet<SystemInfo>("/api/system/info"),
    staleTime: 60_000,
  });

  const { data: stats, isLoading } = useQuery<SystemStats>({
    queryKey: ["system", "stats"],
    queryFn: () => apiGet<SystemStats>("/api/system/stats"),
    refetchInterval: 5_000,
  });

  if (isLoading || !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const memPercent = stats.mem.total > 0 ? (stats.mem.used / stats.mem.total) * 100 : 0;
  const diskPercent = stats.disk.total > 0 ? (stats.disk.used / stats.disk.total) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] gap-4">
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-300 mb-4">System Information</h2>
          <dl className="space-y-2 text-sm">
            {[
              ["Hostname", info?.hostname ?? "—"],
              ["OS", info?.os ?? "—"],
              ["Kernel", info?.kernel ?? "—"],
              ["Architecture", info?.arch ?? "—"],
              ["Uptime", info ? formatUptime(info.uptime) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-text-500">{label}</dt>
                <dd className="text-text-200 font-mono text-right break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-300 mb-4">Network Addresses</h2>
          <div className="flex flex-wrap gap-2">
            {(info?.allIps ?? []).map((ip) => (
              <span key={ip} className="inline-flex items-center rounded bg-surface-700 px-2.5 py-1 text-xs font-mono text-text-200 border border-surface-500">
                {ip}
              </span>
            ))}
            {(info?.allIps ?? []).length === 0 && <div className="text-sm text-text-500">No IPs detected</div>}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-semibold text-text-300 mb-6">Host Resources</h2>
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
          <div className="min-w-[160px] space-y-3">
            <div>
              <div className="text-xs text-text-400 mb-2">Network I/O</div>
              <div className="space-y-2 text-sm font-mono">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-text-500">TX</span>
                  <span className="text-text-200">{formatBytes(stats.network.txBytes)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-text-500">RX</span>
                  <span className="text-text-200">{formatBytes(stats.network.rxBytes)}</span>
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs text-text-400 mb-2">Load Average</div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
                <div>
                  <div className="text-text-200">{stats.loadavg[0].toFixed(2)}</div>
                  <div className="text-text-500">1m</div>
                </div>
                <div>
                  <div className="text-text-200">{stats.loadavg[1].toFixed(2)}</div>
                  <div className="text-text-500">5m</div>
                </div>
                <div>
                  <div className="text-text-200">{stats.loadavg[2].toFixed(2)}</div>
                  <div className="text-text-500">15m</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HostOverview() {
  const [tab, setTab] = useState("summary");
  const tabs = [
    { id: "summary", label: "Summary" },
    { id: "health", label: "Health" },
    { id: "shell", label: "Shell" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text-100">Host</h1>
        <p className="text-sm text-text-500 mt-0.5">Overview, health and shell access for this Virtua node.</p>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "summary" && <HostSummaryTab />}
      {tab === "health" && <HealthPage />}
      {tab === "shell" && <HostShell />}
    </div>
  );
}
