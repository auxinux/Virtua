import { Boxes, Container, Monitor, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { MetricBar } from "@/components/MetricBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { UsageMode, VirtuaConnection, VirtuaNode, VirtuaResource, VirtuaTask } from "@/types";
import { useLanguage } from "@/i18n";

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Server;
}) {
  return (
    <div className="rounded border border-virtua-border bg-virtua-panel p-4 shadow-panel">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-virtua-muted">{label}</p>
        <Icon className="h-5 w-5 text-virtua-accent" />
      </div>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-virtua-muted">{detail}</p>
    </div>
  );
}

function isRunningState(state: string) {
  return ["running", "run", "active", "started", "up"].includes(state.toLowerCase());
}

export function Dashboard({
  connection,
  nodes,
  resources,
  tasks,
  usageMode = "cloud",
}: {
  connection: VirtuaConnection | null;
  nodes: VirtuaNode[];
  resources: VirtuaResource[];
  tasks: VirtuaTask[];
  usageMode?: UsageMode;
}) {
  const { t } = useLanguage();
  const onlineNodes = nodes.filter((node) => node.status === "online").length;
  const vmCount = resources.filter((resource) => resource.kind === "vm").length;
  const lxcCount = resources.filter((resource) => resource.kind === "lxc").length;
  const dockerCount = resources.filter((resource) => resource.kind === "docker").length;
  const latestTasks = tasks.slice(0, 5);
  const localMode = usageMode === "local";
  const runningResources = resources.filter((resource) => isRunningState(resource.state));

  return (
    <div className="w-full max-w-none space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("dash.title")}</h1>
          <p className="mt-1 text-sm text-virtua-muted">
            {localMode ? t("dash.desc_local") : t("dash.desc_remote")}
          </p>
        </div>
        <div className="rounded border border-virtua-border bg-virtua-panel px-4 py-3">
          <p className="text-xs uppercase tracking-wider text-virtua-muted">{t("dash.session")}</p>
          <div className="mt-2 flex items-center gap-3">
            <StatusBadge status={connection?.status ?? "offline"} />
            <span className="text-sm">{connection?.username ?? t("dash.offline")}</span>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("layout.nodes")} value={`${onlineNodes}/${nodes.length}`} detail={t("dash.nodes_avail")} icon={Server} />
        <StatCard label={t("nav.vm")} value={vmCount} detail={t("dash.vms")} icon={Monitor} />
        <StatCard label={t("nav.lxc")} value={lxcCount} detail={t("dash.lxcs")} icon={Container} />
        <StatCard label={t("nav.docker")} value={dockerCount} detail={t("dash.dockers")} icon={Boxes} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr_25rem]">
        <div className="rounded border border-virtua-border bg-virtua-panel">
          <div className="border-b border-virtua-border px-4 py-3">
            <h2 className="text-sm font-semibold">{localMode ? t("dash.local_node_state") : t("dash.node_state")}</h2>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node) => (
              <div key={node.id} className="rounded border border-virtua-border bg-black/10 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{node.name}</p>
                    <p className="text-xs text-virtua-muted">{node.host}</p>
                  </div>
                  <StatusBadge status={node.status} />
                </div>
                <div className="space-y-3">
                  <MetricBar label={t("general.cpu")} value={node.cpuUsage} />
                  <MetricBar label={t("general.ram")} value={node.memoryUsage} />
                  <MetricBar label={t("general.storage")} value={node.storageUsage} />
                </div>
                {localMode ? (
                  <div className="mt-4 space-y-2 border-t border-virtua-border pt-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="text-virtua-muted">{t("dash.computer")}</span>
                      <span className="text-right">{node.computerName ?? node.name}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-virtua-muted">{t("general.uptime")}</span>
                      <span>{node.uptime ?? "n/a"}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-virtua-muted">{t("dash.cores")}</span>
                      <span>{node.totalCores ?? "n/a"} / virt. {node.virtualizationCores ?? "n/a"}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-virtua-muted">{t("general.ram")}</span>
                      <span>
                        {typeof node.totalMemoryGib === "number" ? `${Math.round(node.totalMemoryGib)} Go` : "n/a"}
                        {" / virt. "}
                        {typeof node.virtualizationMemoryGib === "number" ? `${Math.round(node.virtualizationMemoryGib)} Go` : "n/a"}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            {localMode && runningResources.map((resource) => (
              <Link
                key={resource.id}
                to={`/console/${resource.id}`}
                className="rounded border border-virtua-border bg-black/10 p-4 transition-colors hover:border-virtua-accent hover:bg-virtua-panelHover"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Monitor className="h-4 w-4 shrink-0 text-virtua-accent" />
                      <p className="truncate text-sm font-medium">{resource.name}</p>
                    </div>
                    <p className="mt-1 truncate text-xs text-virtua-muted">{resource.node} / {resource.architecture ?? "VM"}</p>
                  </div>
                  <StatusBadge status={resource.state} />
                </div>
                <div className="grid grid-cols-2 gap-2 border-b border-virtua-border pb-3 text-xs">
                  <div>
                    <p className="text-virtua-muted">IP</p>
                    <p className="mt-1 truncate font-mono">{resource.ip ?? "n/a"}</p>
                  </div>
                  <div>
                    <p className="text-virtua-muted">{t("general.uptime")}</p>
                    <p className="mt-1">{resource.uptime ?? "n/a"}</p>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  <MetricBar label={t("general.cpu")} value={resource.cpu ?? 0} />
                  <MetricBar label={t("general.ram")} value={resource.memory ?? 0} />
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="rounded border border-virtua-border bg-virtua-panel">
          <div className="border-b border-virtua-border px-4 py-3">
            <h2 className="text-sm font-semibold">{t("dash.recent_tasks")}</h2>
          </div>
          <div className="divide-y divide-virtua-border">
            {latestTasks.map((task) => (
              <div key={task.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm">{task.label}</p>
                  <StatusBadge status={task.status} />
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-black/25">
                  <div className="h-full rounded bg-virtua-accent" style={{ width: `${task.progress}%` }} />
                </div>
                <p className="mt-1 text-xs text-virtua-muted">{task.target}</p>
              </div>
            ))}
            {latestTasks.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-virtua-muted">{t("dash.no_tasks")}</div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
