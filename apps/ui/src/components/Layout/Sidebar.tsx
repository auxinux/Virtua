import React, { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiDelete, apiPost } from "../../api/client";
import type { DatacenterResourceEntry, DatacenterSummary } from "@auxinux/shared";
import { useAuth } from "../../utils/useAuth";
import { SidebarConsoleList } from "./SidebarConsoleList";
import { useSimpleMode } from "../../utils/useSimpleMode";
import {
  LayoutDashboard, Server, Database, Network, Shield,
  Monitor, Box, Package, Users, Activity, Settings,
  Info, User, Terminal, ChevronRight, Plus, AlertTriangle
} from "lucide-react";

interface SidebarVm { name: string; state: string }
interface SidebarLxc { name: string; state: string }
interface SidebarDocker { id: string; name: string; state: string }
interface SidebarPool { name: string; usedBytes: number; totalBytes: number }
type SidebarViewMode = "sections" | "storage" | "console";
type ContextMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};
type ContextMenuState = {
  x: number;
  y: number;
  title: string;
  items: ContextMenuItem[];
} | null;

const SIDEBAR_VIEW_KEY = "auxinux-sidebar-view";

function SidebarSection({
  title, icon, children, defaultOpen = true,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: { label: string; to: string };
}) {
  const [open, setOpen] = useState(defaultOpen);
  const navigate = useNavigate();

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-text-400 hover:text-text-200 hover:bg-surface-700/50 rounded transition-colors text-xs font-semibold uppercase tracking-wider group"
      >
        <span className="w-3.5 h-3.5 text-text-500">{icon}</span>
        <span className="flex-1 text-left truncate">{title}</span>
        {action && (
          <span
            onClick={(e) => { e.stopPropagation(); navigate(action.to); }}
            className="opacity-0 group-hover:opacity-100 w-4 h-4 text-accent-blue hover:text-accent-blue-light transition-opacity"
            title={action.label}
          >
            <Plus className="w-3.5 h-3.5" />
          </span>
        )}
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-2 border-l border-surface-600 pl-2">{children}</div>}
    </div>
  );
}

function SidebarItem({ to, icon, label, badge, state }: { to: string; icon?: React.ReactNode; label: string; badge?: React.ReactNode; state?: string }) {
  const stateColors: Record<string, string> = {
    running: "bg-state-running", stopped: "bg-state-stopped", paused: "bg-state-paused",
    "RUNNING": "bg-state-running", "STOPPED": "bg-state-stopped",
  };

  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors group ${
          isActive ? "bg-accent-blue/20 text-accent-blue-light font-medium" : "text-text-400 hover:text-text-200 hover:bg-surface-700/50"
        }`
      }
    >
      {state ? (
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${stateColors[state] || "bg-surface-400"}`} title={state} />
      ) : icon ? (
        <span className="w-3.5 h-3.5 flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">{icon}</span>
      ) : null}
      <span className="flex-1 truncate">{label}</span>
      {badge}
    </NavLink>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const { capabilities, getResourcePermissions, isAdmin } = useAuth();
  const { isSimpleMode } = useSimpleMode();
  const sections = capabilities?.sections;
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [viewMode, setViewMode] = useState<SidebarViewMode>(() => {
    const stored = localStorage.getItem(SIDEBAR_VIEW_KEY);
    return stored === "storage" ? stored : "sections";
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_VIEW_KEY, viewMode);
  }, [viewMode]);

  const { data: vms = [] } = useQuery<SidebarVm[]>({
    queryKey: ["sidebar", "vms"],
    queryFn: () => apiGet<SidebarVm[]>("/api/vms"),
    refetchInterval: 10_000,
    enabled: !!sections?.vms,
  });

  const { data: lxcList = [] } = useQuery<SidebarLxc[]>({
    queryKey: ["sidebar", "lxc"],
    queryFn: () => apiGet<SidebarLxc[]>("/api/lxc"),
    refetchInterval: 10_000,
    enabled: !!sections?.lxc,
  });

  const { data: dockerList = [] } = useQuery<SidebarDocker[]>({
    queryKey: ["sidebar", "docker"],
    queryFn: () => apiGet<SidebarDocker[]>("/api/docker/containers"),
    refetchInterval: 10_000,
    enabled: !!sections?.docker,
  });

  const { data: pools = [] } = useQuery<SidebarPool[]>({
    queryKey: ["sidebar", "pools"],
    queryFn: () => apiGet<SidebarPool[]>("/api/storage/pools"),
    refetchInterval: 30_000,
    enabled: !!sections?.storageOverview,
  });

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (contextMenuRef.current && event.target instanceof Node && contextMenuRef.current.contains(event.target)) return;
      setContextMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("contextmenu", handleClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("contextmenu", handleClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  const renderClassicSections = () => (
    <>
      <SidebarItem to="/dashboard" icon={<LayoutDashboard className="w-3.5 h-3.5" />} label={t("nav.dashboard")} />

      {!isSimpleMode && sections?.host && (
        <SidebarSection title={t("nav.host")} icon={<Server className="w-3.5 h-3.5" />} defaultOpen>
          {sections.health && <SidebarItem to="/health" icon={<Activity className="w-3.5 h-3.5" />} label="Health" />}
          {sections.hostShell && <SidebarItem to="/host/shell" icon={<Terminal className="w-3.5 h-3.5" />} label={t("nav.hostShell")} />}
        </SidebarSection>
      )}

      {(sections?.vms || sections?.lxc || sections?.docker) && (
        <SidebarSection
          title={isSimpleMode ? "Mes Machines" : "Ressources"}
          icon={<Monitor className="w-3.5 h-3.5" />}
          defaultOpen
        >
          {sections?.vms && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70">
                {isSimpleMode ? "Ordinateurs Virtuels" : t("nav.vms")}
              </div>
              {(isAdmin ? vms : vms.filter((vm) => capabilities?.resources.vms.some((r) => r.name === vm.name))).map((vm) => (
                <SidebarItem key={vm.name} to={`/vms/${vm.name}`} state={vm.state} label={vm.name} />
              ))}
              {vms.length === 0 && <p className="text-[10px] text-text-500 px-2 py-1 italic">{t("nav.noVms")}</p>}
            </div>
          )}

          {sections?.lxc && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70">
                {isSimpleMode ? "Conteneurs Légers" : t("nav.lxc")}
              </div>
              {(isAdmin ? lxcList : lxcList.filter((ct) => capabilities?.resources.lxc.some((r) => r.name === ct.name))).map((ct) => (
                <SidebarItem key={ct.name} to={`/lxc/${ct.name}`} state={ct.state} label={ct.name} />
              ))}
              {lxcList.length === 0 && <p className="text-[10px] text-text-500 px-2 py-1 italic">{t("nav.noContainers")}</p>}
            </div>
          )}

          {sections?.docker && (
            <div className="mb-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70">
                {isSimpleMode ? "Applications" : t("nav.docker")}
              </div>
              <SidebarItem to="/docker" icon={<Box className="w-3.5 h-3.5" />} label={t("nav.dockerOverview")} />
              <SidebarItem to="/docker/compose" icon={<Package className="w-3.5 h-3.5" />} label={t("nav.dockerCompose", "Docker Compose")} />
              <SidebarItem to="/docker/volumes" icon={<Database className="w-3.5 h-3.5" />} label={t("nav.dockerVolumes", "Docker Volumes")} />
              {(isAdmin
                ? dockerList
                : dockerList.filter((ct) =>
                    capabilities?.resources.docker.some((r) =>
                      r.id === ct.id || r.id.startsWith(ct.id.substring(0, 12)) || ct.id.startsWith(r.id.substring(0, 12))
                    )
                  )
              ).map((ct) => (
                <SidebarItem key={ct.id} to={`/docker/${ct.id}`} state={ct.state} label={ct.name} />
              ))}
              {dockerList.length === 0 && <p className="text-[10px] text-text-500 px-2 py-1 italic">{t("nav.noContainers")}</p>}
            </div>
          )}
        </SidebarSection>
      )}

      {!isSimpleMode && (sections?.storageOverview || sections?.isoLibrary || sections?.backups) && (
        <SidebarSection
          title={t("nav.storage")}
          icon={<Database className="w-3.5 h-3.5" />}
          action={sections.storageOverview ? { label: t("nav.manage"), to: "/storage" } : undefined}
        >
          {sections.storageOverview && <SidebarItem to="/storage" icon={<LayoutDashboard className="w-3.5 h-3.5" />} label={t("nav.storageOverview")} />}
          {sections.storageOverview && pools.map((pool) => (
            <SidebarItem key={pool.name} to={`/storage/pools/${pool.name}`} icon={<Box className="w-3.5 h-3.5" />} label={pool.name} />
          ))}
          {sections.isoLibrary && <SidebarItem to="/storage/isos" icon={<Package className="w-3.5 h-3.5" />} label={t("nav.isos")} />}
          {isAdmin && <SidebarItem to="/templates" icon={<Monitor className="w-3.5 h-3.5" />} label={t("nav.templates", "Templates")} />}
          {sections.backups && <SidebarItem to="/storage/backups" icon={<Database className="w-3.5 h-3.5" />} label="Backups" />}
        </SidebarSection>
      )}

      {!isSimpleMode && (sections?.network || sections?.firewall) && (
        <SidebarSection title={t("nav.network")} icon={<Network className="w-3.5 h-3.5" />} action={sections.network ? { label: t("nav.manage"), to: "/network" } : undefined}>
          {sections.network && <SidebarItem to="/network" icon={<Network className="w-3.5 h-3.5" />} label={t("nav.networkOverview")} />}
          {sections.firewall && <SidebarItem to="/network/firewall" icon={<Shield className="w-3.5 h-3.5" />} label="Firewall" />}
        </SidebarSection>
      )}
    </>
  );

  const renderStorageView = () => (
    <SidebarSection title={t("sidebar.storageView")} icon={<Database className="w-3.5 h-3.5" />} defaultOpen>
      {sections?.storageOverview && <SidebarItem to="/storage" icon={<LayoutDashboard className="w-3.5 h-3.5" />} label={t("nav.storageOverview")} />}

      {sections?.storageOverview && (
        <div className="ml-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70 pt-2">
            {t("storage.pools")}
          </div>
          {pools.map((pool) => (
            <SidebarItem key={pool.name} to={`/storage/pools/${pool.name}`} icon={<Box className="w-3.5 h-3.5" />} label={pool.name} />
          ))}
        </div>
      )}

      {sections?.isoLibrary && (
        <div className="ml-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70 pt-2">
            {t("nav.isos", "ISO / Templates")}
          </div>
          <SidebarItem to="/storage/isos" icon={<Package className="w-3.5 h-3.5" />} label={t("nav.isos", "ISO / Templates")} />
        </div>
      )}

      {isAdmin && (
        <div className="ml-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-500 font-bold opacity-70 pt-2">
            {t("nav.templates", "Templates")}
          </div>
          <SidebarItem to="/templates" icon={<Monitor className="w-3.5 h-3.5" />} label={t("nav.templates", "Templates")} />
        </div>
      )}
    </SidebarSection>
  );

  return (
    <aside className="w-52 bg-surface-900 border-r border-surface-500 flex flex-col overflow-hidden flex-shrink-0">
      <div className="px-3 py-3 border-b border-surface-600">
        <div>
          <label className="block text-[10px] uppercase tracking-[0.18em] text-text-500 mb-1">
            {t("sidebar.view")}
          </label>
          <select
            value={viewMode}
            onChange={(e) => {
              const v = e.target.value as SidebarViewMode;
              setViewMode(v);
              if (v === "console") navigate("/console");
            }}
            className="w-full bg-surface-800 border border-surface-600 rounded px-2 py-1.5 text-xs text-text-300 focus:border-accent-blue focus:outline-none transition-colors"
          >
            <option value="sections">{isSimpleMode ? "Général" : t("sidebar.allView")}</option>
            {!isSimpleMode && <option value="console">{t("nav.console")}</option>}
            {!isSimpleMode && <option value="storage">{t("sidebar.storageView")}</option>}
          </select>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-1 space-y-0.5 scrollbar-hide">
        {viewMode === "sections" && renderClassicSections()}
        {viewMode === "storage" && renderStorageView()}
        {viewMode === "console" && <SidebarConsoleList />}
      </nav>

      {/* Bottom nav */}
      <div className="border-t border-surface-600 py-1 px-1">
        {!isSimpleMode && sections?.users && <SidebarItem to="/users" icon={<Users className="w-3.5 h-3.5" />} label={t("nav.users")} />}
        {!isSimpleMode && sections?.audit && <SidebarItem to="/audit" icon={<Activity className="w-3.5 h-3.5" />} label={t("nav.audit")} />}
        {sections?.crashes && <SidebarItem to="/crashes" icon={<AlertTriangle className="w-3.5 h-3.5" />} label={t("nav.crashes")} />}

        <SidebarItem
          to="/account"
          icon={<User className="w-3.5 h-3.5" />}
          label={isSimpleMode ? "Mon Compte" : t("nav.account")}
        />

        {!isSimpleMode && (
          <SidebarItem
            to="/about"
            icon={<Info className="w-3.5 h-3.5" />}
            label={t("nav.about")}
          />
        )}

        {!isSimpleMode && sections?.settings && (
          <SidebarItem to="/settings" icon={<Settings className="w-3.5 h-3.5" />} label={t("nav.settings")} />
        )}
      </div>
    </aside>
  );
}
