import { useState } from "react";
import {
  Boxes,
  CheckCircle2,
  ChevronRight,
  Container,
  Gauge,
  HardDrive,
  Database,
  Monitor,
  Network,
  PlayCircle,
  Server,
  Settings,
  TerminalSquare,
  LogOut,
  Repeat2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import type { ResourceKind, UsageMode, VirtuaConnection, VirtuaNode, VirtuaResource, VirtuaTask, VirtuaUser } from "@/types";
import { StatusBadge } from "@/components/StatusBadge";
import { useLanguage } from "@/i18n";

const cloudNavItems = [
  { to: "/", labelKey: "nav.console", icon: TerminalSquare },
  { to: "/dashboard", labelKey: "nav.dashboard", icon: Gauge },
  { to: "/inventory", labelKey: "nav.inventory", icon: Network },
  { to: "/vms", labelKey: "nav.vm", icon: Monitor },
  { to: "/lxc", labelKey: "nav.lxc", icon: Container },
  { to: "/docker", labelKey: "nav.docker", icon: Boxes },
  { to: "/tasks", labelKey: "nav.tasks", icon: CheckCircle2 },
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
];

const localNavItems = [
  { to: "/", labelKey: "nav.dashboard", icon: Gauge },
  { to: "/inventory", labelKey: "nav.inventory", icon: Network },
  { to: "/vms", labelKey: "nav.vm", icon: Monitor },
  { to: "/lxc", labelKey: "nav.lxc", icon: Container },
  { to: "/docker", labelKey: "nav.docker", icon: Boxes },
  { to: "/storage", labelKey: "nav.storage", icon: Database },
  { to: "/tasks", labelKey: "nav.tasks", icon: CheckCircle2 },
  { to: "/settings", labelKey: "nav.local_settings", icon: Settings },
];

const kindIcon: Record<ResourceKind, typeof Monitor> = {
  vm: Monitor,
  lxc: Container,
  docker: Boxes,
};

function formatSyncTime(value: string | undefined, lang: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function NavItem({ to, labelKey, icon: Icon, isCollapsed }: (typeof cloudNavItems)[number] & { isCollapsed: boolean }) {
  const { t } = useLanguage();
  const label = t(labelKey);
  return (
    <NavLink
      to={to}
      end={to === "/"}
      title={isCollapsed ? label : undefined}
      className={({ isActive }) =>
        `flex h-10 items-center rounded px-3 text-sm transition-colors ${
          isActive
            ? "bg-virtua-accentSoft text-white"
            : "text-virtua-muted hover:bg-virtua-panelHover hover:text-virtua-text"
        } ${isCollapsed ? "justify-center" : "gap-3"}`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!isCollapsed && <span>{label}</span>}
    </NavLink>
  );
}

function NodeTree({ nodes, resources }: { nodes: VirtuaNode[]; resources: VirtuaResource[] }) {
  return (
    <div className="space-y-2">
      {nodes.map((node) => {
        const nodeResources = resources.filter((resource) => resource.node === node.name).slice(0, 4);
        return (
          <div key={node.id} className="rounded border border-virtua-border/70 bg-black/10 p-2">
            <div className="flex items-center gap-2 text-sm text-virtua-text">
              <Server className="h-4 w-4 text-virtua-muted" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className={`h-2 w-2 rounded-full ${node.status === "online" ? "bg-virtua-green" : "bg-virtua-yellow"}`} />
            </div>
            <div className="mt-2 space-y-1 border-l border-virtua-border pl-3">
              {nodeResources.map((resource) => {
                const Icon = kindIcon[resource.kind];
                return (
                  <NavLink
                    key={resource.id}
                    to={`/console/${resource.id}`}
                    className="flex items-center gap-2 rounded px-1 py-0.5 text-xs text-virtua-muted transition-colors hover:bg-virtua-panelHover hover:text-virtua-text"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                    <ChevronRight className="h-3 w-3" />
                  </NavLink>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Layout({
  children,
  connection,
  nodes,
  resources,
  tasks,
  user,
  onLogout,
  onSwitchMode,
  loadError,
  usageMode = "cloud",
}: {
  children: React.ReactNode;
  connection: VirtuaConnection | null;
  nodes: VirtuaNode[];
  resources: VirtuaResource[];
  tasks: VirtuaTask[];
  user: VirtuaUser | null;
  onLogout: () => void;
  onSwitchMode?: () => void;
  loadError?: string | null;
  usageMode?: UsageMode;
}) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { t, language, setLanguage } = useLanguage();
  const runningTasks = tasks.filter((task) => task.status === "running");
  const navItems = usageMode === "local" ? localNavItems : cloudNavItems;
  const syncLabel = connection?.lastSync ? `${t("layout.subtitle_local")} ${formatSyncTime(connection.lastSync, language)}` : "";
  const headerTitle = usageMode === "local" ? t("layout.local_mode") : connection?.endpoint ?? t("layout.remote_mode");
  const headerSubtitle = loadError
    ? loadError
    : usageMode === "local"
      ? syncLabel
      : `${t("layout.subtitle_remote")}${syncLabel ? ` / ${syncLabel}` : ""}`;

  return (
    <div className="flex h-screen min-h-0 bg-virtua-bg text-virtua-text">
      <aside className={`flex flex-col border-r border-virtua-border bg-[#090d12] transition-[width] duration-300 ${isSidebarCollapsed ? "w-16 min-w-[4rem]" : "w-72 min-w-[18rem]"}`}>
        <div className={`border-b border-virtua-border ${isSidebarCollapsed ? "px-2 py-4 flex justify-center" : "px-4 py-4"}`}>
          {isSidebarCollapsed ? (
             <img src="/brand/auxinux-virtua-mark.svg" alt="Virtua" className="h-8 w-8" draggable={false} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ) : (
            <img
              src="/brand/auxinux-virtua-logo.svg"
              alt="AuxiNux Virtua - Desktop Client"
              className="h-auto w-56"
              draggable={false}
            />
          )}
        </div>

        <nav className="space-y-1 px-2 py-3">
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} isCollapsed={isSidebarCollapsed} />
          ))}
        </nav>

        {!isSidebarCollapsed && (
          <div className="min-h-0 flex-1 overflow-auto border-t border-virtua-border px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-virtua-muted">{t("layout.nodes")}</p>
              <span className="text-xs text-virtua-muted">{nodes.length}</span>
            </div>
            <NodeTree nodes={nodes} resources={resources} />
          </div>
        )}

        {isSidebarCollapsed && <div className="min-h-0 flex-1" />}

        <div className={`border-t border-virtua-border ${isSidebarCollapsed ? "p-2 flex flex-col items-center gap-2" : "p-3"}`}>
          {!isSidebarCollapsed && (
            <div className="rounded border border-virtua-border bg-virtua-panel p-3 mb-2">
              <div className="mb-2 flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-virtua-muted" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{connection?.name ?? t("layout.no_connection")}</p>
              </div>
              <div className="flex items-center justify-between gap-2">
                {connection ? <StatusBadge status={connection.status} /> : <StatusBadge status="offline" />}
                <span className="rounded border border-virtua-border bg-black/20 px-2 py-1 text-[0.65rem] uppercase tracking-wider text-virtua-muted">{usageMode}</span>
              </div>
            </div>
          )}

          <button
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            className="flex h-10 w-full items-center justify-center rounded text-virtua-muted transition-colors hover:bg-virtua-panelHover hover:text-virtua-text"
            title={isSidebarCollapsed ? t("layout.expand") : t("layout.collapse")}
          >
            {isSidebarCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-virtua-border bg-virtua-panel/80 px-5">
          <div className="min-w-0 flex-1 flex items-baseline gap-3">
            <p className="truncate text-sm font-medium">{headerTitle}</p>
            {headerSubtitle ? <p className="text-xs text-virtua-muted hidden md:block">{headerSubtitle}</p> : null}
          </div>
          {runningTasks.length > 0 && (
            <div className="hidden items-center gap-2 rounded border border-virtua-border bg-black/15 px-3 py-1.5 text-xs text-virtua-muted lg:flex">
              <PlayCircle className="h-3.5 w-3.5 text-virtua-accent" />
              <span>{runningTasks.length} {t("layout.active_operations")}</span>
            </div>
          )}
          <div className="scale-90 transform origin-right">
             <StatusBadge status={connection?.status ?? "offline"} />
          </div>

          <div className="flex items-center gap-1 rounded bg-black/20 p-1">
            <button
              onClick={() => setLanguage("fr")}
              className={`h-6 rounded px-2 text-[10px] font-bold transition-colors ${language === "fr" ? "bg-virtua-accent text-white" : "text-virtua-muted hover:text-virtua-text"}`}
            >
              FR
            </button>
            <button
              onClick={() => setLanguage("en")}
              className={`h-6 rounded px-2 text-[10px] font-bold transition-colors ${language === "en" ? "bg-virtua-accent text-white" : "text-virtua-muted hover:text-virtua-text"}`}
            >
              EN
            </button>
          </div>

          {onSwitchMode ? (
            <button onClick={onSwitchMode} className="virtua-button !h-8 text-xs px-3 border-virtua-accentSoft text-virtua-accent" title="Changer Local/Cloud">
              <Repeat2 className="mr-1.5 h-3.5 w-3.5" />
              {usageMode === "local" ? "Cloud" : "Local"}
            </button>
          ) : null}
          <div className="hidden items-center gap-2 rounded border border-virtua-border bg-black/15 px-3 py-1.5 text-xs lg:flex">
            <span className="text-virtua-text font-medium">{user?.displayName ?? user?.username}</span>
            <span className="text-[10px] text-virtua-muted px-1.5 py-0.5 bg-black/30 rounded">{user?.role}</span>
          </div>
          <button onClick={onLogout} className="virtua-icon-button !h-8 !w-8" title={usageMode === "local" ? t("layout.back_choice") : t("layout.logout")}>
            <LogOut className="h-4 w-4" />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
      </div>
    </div>
  );
}
