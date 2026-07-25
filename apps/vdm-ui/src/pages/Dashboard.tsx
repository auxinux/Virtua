import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { VdmSummary, VdmTask } from "@/types/vdm";

function StatCard({ label, value, sub, color = "default" }: { label: string; value: string | number; sub?: string; color?: "green" | "red" | "yellow" | "blue" | "default" }) {
  const colors = {
    green: "border-vdm-success/30 bg-vdm-success/5",
    red: "border-vdm-danger/30 bg-vdm-danger/5",
    yellow: "border-vdm-warning/30 bg-vdm-warning/5",
    blue: "border-vdm-accent/30 bg-vdm-accent/5",
    default: "border-vdm-border",
  };

  return (
    <div className={`vdm-card ${colors[color]} p-4`}>
      <p className="text-xs text-vdm-textMuted uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-vdm-text mt-1">{value}</p>
      {sub && <p className="text-xs text-vdm-textMuted mt-1">{sub}</p>}
    </div>
  );
}

function ProgressBar({ value, max, color = "blue" }: { value: number; max: number; color?: "blue" | "green" | "warning" | "danger" }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round(value / max * 100));
  const cls = { blue: "progress-fill", green: "progress-fill-green", warning: "progress-fill-warning", danger: "progress-fill-danger" }[color];
  const barColor = pct > 90 ? "danger" : pct > 70 ? "warning" : color;
  return (
    <div className="progress-bar">
      <div className={`${{ blue: "progress-fill", green: "progress-fill-green", warning: "progress-fill-warning", danger: "progress-fill-danger" }[barColor]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function Dashboard() {
  const summaryQuery = useQuery<VdmSummary>({
    queryKey: ["vdm-summary"],
    queryFn: () => api.get("/api/vdm/summary"),
    refetchInterval: 15_000,
  });
  const tasksQuery = useQuery<VdmTask[]>({
    queryKey: ["vdm-tasks-recent"],
    queryFn: () => api.get("/api/vdm/tasks?limit=5"),
    refetchInterval: 5000,
  });

  const summary = summaryQuery.data;
  const tasks = tasksQuery.data ?? [];

  const totalNodes = summary?.nodes.length ?? 0;
  const onlineNodes = summary?.nodes.filter((n) => n.node.status === "online").length ?? 0;
  const totalVms = summary?.nodes.reduce((acc, n) => acc + (n.resources?.vms ?? 0), 0) ?? 0;
  const totalLxc = summary?.nodes.reduce((acc, n) => acc + (n.resources?.lxc ?? 0), 0) ?? 0;
  const totalDocker = summary?.nodes.reduce((acc, n) => acc + (n.resources?.docker ?? 0), 0) ?? 0;
  const totalCores = summary?.nodes.reduce((acc, n) => acc + (n.systemInfo?.cpuCores ?? 0), 0) ?? 0;
  const totalMemory = summary?.nodes.reduce((acc, n) => acc + (n.systemInfo?.memoryTotal ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-vdm-text">Dashboard</h1>
          <p className="text-sm text-vdm-textMuted mt-0.5">Datacenter overview</p>
        </div>
        {summaryQuery.isFetching && (
          <div className="w-4 h-4 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      {/* Global stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Nodes" value={`${onlineNodes}/${totalNodes}`} sub={`${totalNodes - onlineNodes} offline`} color={onlineNodes < totalNodes ? "red" : "green"} />
        <StatCard label="VMs" value={totalVms} color="blue" />
        <StatCard label="LXC" value={totalLxc} color="blue" />
        <StatCard label="Docker" value={totalDocker} color="blue" />
        <StatCard label="CPU Cores" value={totalCores} sub="total across nodes" />
        <StatCard label="Memory" value={formatBytes(totalMemory)} sub="total across nodes" />
      </div>

      {/* Node cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-vdm-text">Nodes</h2>
          <Link to="/nodes" className="text-xs text-vdm-accent hover:text-vdm-accentHover">Manage →</Link>
        </div>
        {summaryQuery.isLoading ? (
          <div className="flex flex-wrap gap-3">
            {[1, 2, 3].map((i) => <div key={i} className="vdm-card p-4 w-72 h-40 animate-pulse bg-vdm-surfaceHover" />)}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {(summary?.nodes ?? []).map((item) => {
              const node = item.node;
              const info = item.systemInfo;
              const stats = item.systemStats;
              const memPct = stats && info ? Math.round(stats.memoryUsedBytes / info.memoryTotal * 100) : 0;
              return (
                <div key={node.name} className="vdm-card p-4 w-72">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`status-dot ${node.status === "online" ? "status-online" : "status-offline"}`} />
                    <span className="font-medium text-vdm-text text-sm">{node.displayName}</span>
                    <span className={`pill ml-auto ${node.status === "online" ? "pill-green" : "pill-red"}`}>{node.status}</span>
                  </div>
                  {info && (
                    <div className="space-y-1 text-xs text-vdm-textMuted mb-3">
                      <p>{info.hostname} • {info.cpuCores} cores • {formatBytes(info.memoryTotal)}</p>
                      <p className="truncate">{info.cpuModel}</p>
                    </div>
                  )}
                  {stats && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-vdm-textMuted">
                        <span>CPU</span><span>{stats.cpuUsagePercent?.toFixed(1)}%</span>
                      </div>
                      <ProgressBar value={stats.cpuUsagePercent ?? 0} max={100} />
                      <div className="flex justify-between text-xs text-vdm-textMuted">
                        <span>Memory</span><span>{memPct}%</span>
                      </div>
                      <ProgressBar value={memPct} max={100} />
                    </div>
                  )}
                  <div className="flex gap-3 mt-3 text-xs text-vdm-textMuted">
                    <span>{item.resources?.vms ?? 0} VMs</span>
                    <span>{item.resources?.lxc ?? 0} LXC</span>
                    <span>{item.resources?.docker ?? 0} Docker</span>
                  </div>
                </div>
              );
            })}
            {(summary?.nodes.length ?? 0) === 0 && (
              <div className="vdm-card p-8 text-center text-vdm-textMuted w-full">
                <p className="text-sm">No nodes registered yet.</p>
                <Link to="/nodes" className="text-vdm-accent hover:underline text-sm mt-2 inline-block">Add your first node →</Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recent tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-vdm-text">Recent Tasks</h2>
          <Link to="/tasks" className="text-xs text-vdm-accent hover:text-vdm-accentHover">All tasks →</Link>
        </div>
        <div className="vdm-card divide-y divide-vdm-border/50">
          {tasks.length === 0 ? (
            <p className="px-4 py-6 text-sm text-vdm-textMuted text-center">No tasks yet</p>
          ) : tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-3 px-4 py-3">
              <span className={`pill ${task.status === "completed" ? "pill-green" : task.status === "failed" ? "pill-red" : task.status === "running" ? "pill-blue" : "pill-gray"}`}>
                {task.status}
              </span>
              <span className="text-sm text-vdm-text flex-1 truncate">{task.label}</span>
              {task.status === "running" && (
                <div className="flex items-center gap-1.5 text-xs text-vdm-textMuted">
                  <div className="w-16 progress-bar"><div className="progress-fill" style={{ width: `${task.progress}%` }} /></div>
                  {task.progress}%
                </div>
              )}
              {task.error && <span className="text-xs text-vdm-danger truncate max-w-48">{task.error}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
