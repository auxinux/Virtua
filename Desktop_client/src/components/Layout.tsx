import { useEffect, useState } from "react";
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
  AppWindow,
  FlaskConical,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useConsolePrefs } from "@/consolePrefs";
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
  { to: "/disposable", labelKey: "nav.disposable", icon: FlaskConical },
  { to: "/unified", labelKey: "nav.unified", icon: AppWindow },
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
      // AuxiNux Shell / Windows 11 Settings navigation: 36 px rows, a soft
      // highlight and an accent pill on the selected row.
      className={({ isActive }) =>
        `flex h-9 items-center rounded px-3 text-sm text-virtua-text transition-colors ${
          isActive
            ? "bg-virtua-panelHover font-medium shadow-[inset_3px_0_0_0_rgb(var(--v-accent))]"
            : "hover:bg-virtua-panelHover"
        } ${isCollapsed ? "justify-center" : "gap-3"}`
      }
    >
      <Icon className="h-[1.15rem] w-[1.15rem] shrink-0 text-virtua-muted" />
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
          <div key={node.id} className="rounded border border-virtua-border/70 bg-virtua-shade/10 p-2">
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

const sidebarKey = "auxinux-virtua-desktop-sidebar";

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
  // The sidebar folds by itself on narrow windows (a 1366 px laptop with the
  // console open) unless the user chose explicitly; that choice is kept.
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem(sidebarKey);
      return saved === "collapsed" ? true : saved === "expanded" ? false : null;
    } catch {
      return null;
    }
  });
  const [isNarrow, setNarrow] = useState(() => window.innerWidth < 1200);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1200);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const isSidebarCollapsed = sidebarPreference ?? isNarrow;
  const setIsSidebarCollapsed = (collapsed: boolean) => {
    setSidebarPreference(collapsed);
    try {
      localStorage.setItem(sidebarKey, collapsed ? "collapsed" : "expanded");
    } catch {
      /* Not persisted; still applied. */
    }
  };
  const { t, language, setLanguage } = useLanguage();
  const location = useLocation();
  const consolePrefs = useConsolePrefs();
  // Console focus mode: every application bar gives way to the VM screen.
  const hideChrome = consolePrefs.focus && location.pathname.startsWith("/console/");
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
      <aside className={`${hideChrome ? "hidden" : "flex"} flex-col border-r border-virtua-border bg-virtua-sidebar transition-[width] duration-200 ${isSidebarCollapsed ? "w-14 min-w-[3.5rem]" : "w-60 min-w-[15rem]"}`}>
        <div className={`flex h-14 shrink-0 items-center ${isSidebarCollapsed ? "justify-center px-2" : "px-4"}`}>
          {isSidebarCollapsed ? (
             <img src="/brand/auxinux-virtua-mark.svg" alt="Virtua" className="h-8 w-8" draggable={false} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ) : (
            <>
              {/* The raster logo has light lettering: Virtua classique only. AuxiNux
                  themes show the app the way AuxiNux Shell apps do, icon + name. */}
              <img
                src="/brand/auxinux-virtua-logo.svg"
                alt="AuxiNux Virtua - Desktop Client"
                className="brand-classic h-auto w-40"
                draggable={false}
              />
              <div className="brand-auxinux items-center gap-2.5">
                <img src="/brand/auxinux-virtua-mark.svg" alt="" className="h-7 w-7" draggable={false} />
                <div className="leading-tight">
                  <p className="text-sm font-semibold">Virtua Desktop</p>
                  <p className="text-[0.7rem] text-virtua-muted">AuxiNux</p>
                </div>
              </div>
            </>
          )}
        </div>

        <nav className="min-h-0 space-y-0.5 overflow-y-auto px-2 py-1">
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} isCollapsed={isSidebarCollapsed} />
          ))}
        </nav>

        {!isSidebarCollapsed && (
          <div className="mt-2 hidden min-h-0 flex-1 overflow-auto border-t border-virtua-border px-3 py-3 [@media(min-height:820px)]:block">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-virtua-muted">{t("layout.nodes")}</p>
              <span className="text-xs text-virtua-muted">{nodes.length}</span>
            </div>
            <NodeTree nodes={nodes} resources={resources} />
          </div>
        )}

        {/* On short screens (768 px laptops) the node list gives way to the menu. */}
        <div className={`min-h-0 flex-1 ${isSidebarCollapsed ? "" : "[@media(min-height:820px)]:hidden"}`} />

        <div className={`shrink-0 border-t border-virtua-border ${isSidebarCollapsed ? "p-2 flex flex-col items-center gap-2" : "p-2"}`}>
          {!isSidebarCollapsed && (
            <div className="mb-2 hidden rounded border border-virtua-border bg-virtua-panel p-3 [@media(min-height:820px)]:block">
              <div className="mb-2 flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-virtua-muted" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{connection?.name ?? t("layout.no_connection")}</p>
              </div>
              <div className="flex items-center justify-between gap-2">
                {connection ? <StatusBadge status={connection.status} /> : <StatusBadge status="offline" />}
                <span className="rounded border border-virtua-border bg-virtua-shade/20 px-2 py-1 text-[0.65rem] uppercase tracking-wider text-virtua-muted">{usageMode}</span>
              </div>
            </div>
          )}

          <button
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            className="flex h-9 w-full items-center justify-center rounded text-virtua-muted transition-colors hover:bg-virtua-panelHover hover:text-virtua-text"
            title={isSidebarCollapsed ? t("layout.expand") : t("layout.collapse")}
          >
            {isSidebarCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`${hideChrome ? "hidden" : "flex"} h-11 shrink-0 items-center gap-2 border-b border-virtua-border bg-virtua-panel/80 px-3 lg:gap-3 lg:px-4`}>
          <div className="min-w-0 flex-1 flex items-baseline gap-3">
            <p className="truncate text-sm font-medium">{headerTitle}</p>
            {headerSubtitle ? <p className="text-xs text-virtua-muted hidden md:block">{headerSubtitle}</p> : null}
          </div>
          {runningTasks.length > 0 && (
            <div className="hidden items-center gap-2 rounded border border-virtua-border bg-virtua-shade/15 px-3 py-1.5 text-xs text-virtua-muted lg:flex">
              <PlayCircle className="h-3.5 w-3.5 text-virtua-accent" />
              <span>{runningTasks.length} {t("layout.active_operations")}</span>
            </div>
          )}
          <div className="scale-90 transform origin-right">
             <StatusBadge status={connection?.status ?? "offline"} />
          </div>

          <div className="flex items-center gap-1 rounded bg-virtua-shade/20 p-1">
            <button
              onClick={() => setLanguage("fr")}
              className={`h-6 rounded px-2 text-[10px] font-bold transition-colors ${language === "fr" ? "bg-virtua-accent text-virtua-onAccent" : "text-virtua-muted hover:text-virtua-text"}`}
            >
              FR
            </button>
            <button
              onClick={() => setLanguage("en")}
              className={`h-6 rounded px-2 text-[10px] font-bold transition-colors ${language === "en" ? "bg-virtua-accent text-virtua-onAccent" : "text-virtua-muted hover:text-virtua-text"}`}
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
          <div className="hidden items-center gap-2 rounded border border-virtua-border bg-virtua-shade/15 px-3 py-1.5 text-xs lg:flex">
            <span className="text-virtua-text font-medium">{user?.displayName ?? user?.username}</span>
            <span className="text-[10px] text-virtua-muted px-1.5 py-0.5 bg-virtua-shade/30 rounded">{user?.role}</span>
          </div>
          <button onClick={onLogout} className="virtua-icon-button !h-8 !w-8" title={usageMode === "local" ? t("layout.back_choice") : t("layout.logout")}>
            <LogOut className="h-4 w-4" />
          </button>
        </header>

        <main className={`min-h-0 flex-1 overflow-auto ${hideChrome ? "p-0" : "p-3 lg:p-4"}`}>{children}</main>
      </div>
    </div>
  );
}
