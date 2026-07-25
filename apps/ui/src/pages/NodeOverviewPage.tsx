import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet } from "../api/client";
import { Tabs } from "../components/ui/Tabs";
import { Gauge } from "../components/ui/Gauge";
import { formatBytes, formatUptime } from "../utils/formatBytes";
import { useAuth } from "../utils/useAuth";
import HealthPage from "./HealthPage";
import HostShell from "./HostShell";
import type { DatacenterNodeSummary } from "@auxinux/shared";

function NodeSummaryTab({ summary }: { summary: DatacenterNodeSummary }) {
  const { t } = useTranslation();
  const info = summary.systemInfo;
  const stats = summary.systemStats;

  if (!info || !stats) {
    return (
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-text-300 mb-3">{t("tab.summary")}</h2>
        <p className="text-sm text-text-500">{t("node.remoteSummaryHint")}</p>
      </div>
    );
  }

  const memPercent = stats.mem.total > 0 ? (stats.mem.used / stats.mem.total) * 100 : 0;
  const diskPercent = stats.disk.total > 0 ? (stats.disk.used / stats.disk.total) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] gap-4">
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-300 mb-4">{t("node.systemInfo")}</h2>
          <dl className="space-y-2 text-sm">
            {[
              [t("node.hostname"), info.hostname],
              ["OS", info.os],
              [t("dashboard.kernel"), info.kernel],
              [t("node.architecture"), info.arch],
              [t("res.uptime"), formatUptime(info.uptime)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-text-500">{label}</dt>
                <dd className="text-text-200 font-mono text-right break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-300 mb-4">{t("node.networkAddresses")}</h2>
          <div className="flex flex-wrap gap-2">
            {info.allIps.map((ip) => (
              <span key={ip} className="inline-flex items-center rounded bg-surface-700 px-2.5 py-1 text-xs font-mono text-text-200 border border-surface-500">
                {ip}
              </span>
            ))}
            {info.allIps.length === 0 && <div className="text-sm text-text-500">{t("node.noIpAddresses")}</div>}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-semibold text-text-300 mb-6">{t("dashboard.hostResources")}</h2>
        <div className="flex flex-wrap gap-8 justify-center xl:justify-between">
          <Gauge value={stats.cpuUsage} size={130} label={t("res.cpu")} sublabel={`${stats.cpuCount} ${t("res.cores")} — ${stats.loadavg[0].toFixed(2)} load`} />
          <Gauge value={memPercent} size={130} label={t("res.memory")} sublabel={`${formatBytes(stats.mem.used)} / ${formatBytes(stats.mem.total)}`} />
          <Gauge value={diskPercent} size={130} label={t("res.rootDisk")} sublabel={`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`} />
          <div className="min-w-[180px] space-y-2 text-sm">
            <div className="text-text-500">{t("datacenter.resources")}</div>
            <div className="flex justify-between gap-4"><span>{t("nav.vms")}</span><span className="font-medium text-text-100">{summary.resources.vms.total}</span></div>
            <div className="flex justify-between gap-4"><span>{t("nav.lxc")}</span><span className="font-medium text-text-100">{summary.resources.lxc.total}</span></div>
            <div className="flex justify-between gap-4"><span>{t("nav.docker")}</span><span className="font-medium text-text-100">{summary.resources.docker.total}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NodeOverviewPage() {
  const { t } = useTranslation();
  const { capabilities } = useAuth();
  const { name = "" } = useParams();
  const [tab, setTab] = useState("summary");
  const { data, isLoading } = useQuery<DatacenterNodeSummary>({
    queryKey: ["node", name],
    queryFn: () => apiGet<DatacenterNodeSummary>(`/api/nodes/${encodeURIComponent(name)}`),
    enabled: !!name,
    refetchInterval: 10_000,
  });

  const tabs = [
    { id: "summary", label: t("tab.summary") },
    { id: "health", label: t("node.health") },
    { id: "shell", label: t("node.shell") },
  ];

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const nodeLabel = data.node.displayName || data.node.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/dashboard" className="text-text-500 hover:text-text-200 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-xl font-bold text-text-100">{nodeLabel}</h1>
          </div>
          <p className="text-sm text-text-500 mt-0.5">
            {data.node.isLocal ? t("node.localNodeHint") : t("node.remoteNodeHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {capabilities?.sections.settings && <Link to={`/nodes/${encodeURIComponent(name)}/settings`} className="btn">{t("nav.nodeSettings")}</Link>}
          {capabilities?.sections.createWizard && <Link to={`/create?node=${encodeURIComponent(name)}`} className="btn-primary">{t("wizard.new")}</Link>}
        </div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "summary" && <NodeSummaryTab summary={data} />}
      {tab === "health" && (
        <HealthPage
          servicesPath={data.node.isLocal ? "/api/system/services" : `/api/nodes/${encodeURIComponent(name)}/system/services`}
          updatesPath={data.node.isLocal ? "/api/system/updates" : `/api/nodes/${encodeURIComponent(name)}/system/updates`}
          ticketPath={data.node.isLocal ? "/api/system/host/console-ticket" : `/api/nodes/${encodeURIComponent(name)}/host/console-ticket`}
          title={data.node.isLocal ? t("node.health") : `${t("node.health")} · ${nodeLabel}`}
          subtitle={data.node.isLocal ? t("health.subtitle") : `${t("node.remoteNodeHint")} · ${nodeLabel}`}
        />
      )}
      {tab === "shell" && (
        <HostShell
          infoPath={data.node.isLocal ? "/api/system/info" : `/api/nodes/${encodeURIComponent(name)}/system/info`}
          ticketPath={data.node.isLocal ? "/api/system/host/console-ticket" : `/api/nodes/${encodeURIComponent(name)}/host/console-ticket`}
          title={data.node.isLocal ? t("hostShell.title") : t("node.shell")}
          subtitle={data.node.isLocal ? t("hostShell.subtitle") : `${t("node.remoteNodeHint")} · ${nodeLabel}`}
        />
      )}
    </div>
  );
}
