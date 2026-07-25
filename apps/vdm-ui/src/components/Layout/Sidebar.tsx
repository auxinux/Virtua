import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmNode, VdmVm, VdmLxc, VdmDocker, VdmSharedStorage } from "@/types/vdm";

// Icons as SVG strings
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  datacenter: "M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z",
  server: "M21.75 17.25v.002A2.25 2.25 0 0 1 19.5 19.5H4.5A2.25 2.25 0 0 1 2.25 17.25v-.002m19.5 0a2.25 2.25 0 0 0-2.25-2.25H4.5a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.002a2.25 2.25 0 0 1-2.25 2.248H4.5a2.25 2.25 0 0 1-2.25-2.248v-.002M3 7.5h18m-18 0A2.25 2.25 0 0 1 5.25 9.75h13.5A2.25 2.25 0 0 1 21 7.5m-18 0V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25V7.5",
  vm: "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3",
  container: "M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75 2.25-1.313M12 21.75V19.5m0 2.25-2.25-1.313m0-16.875L12 2.25l2.25 1.312M12 9.75 9.75 8.438",
  docker: "M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418",
  storage: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625",
  tasks: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z",
  nodes: "M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z",
  settings: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.282c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  chevronRight: "m8.25 4.5 7.5 7.5-7.5 7.5",
  chevronDown: "m19.5 8.25-7.5 7.5-7.5-7.5",
  dashboard: "M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z",
};

function StatusDot({ status }: { status: string }) {
  const color = {
    online: "bg-vdm-online",
    running: "bg-vdm-success",
    offline: "bg-vdm-offline",
    stopped: "bg-vdm-textMuted",
    paused: "bg-vdm-warning",
  }[status] ?? "bg-vdm-unknown";
  return <span className={`status-dot ${color} animate-pulse`} style={{ animationDuration: status === "running" || status === "online" ? "2s" : "0s" }} />;
}

function NavItem({ to, icon, label, count }: { to: string; icon: string; label: string; count?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors ${isActive ? "bg-vdm-accent/15 text-vdm-accentHover font-medium" : "text-vdm-textMuted hover:text-vdm-text hover:bg-vdm-surfaceHover"}`
      }
    >
      <Icon path={icon} />
      <span className="flex-1">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs px-1.5 py-0.5 bg-vdm-accent/20 text-vdm-accentHover rounded-full font-medium">{count}</span>
      )}
    </NavLink>
  );
}

function NodeTreeItem({ node }: { node: VdmNode }) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();

  const vmsQuery = useQuery({
    queryKey: ["vdm-vms", node.name],
    queryFn: () => api.get<VdmVm[]>(`/api/vdm/vms?node=${encodeURIComponent(node.name)}`),
    enabled: open && node.status === "online",
    staleTime: 30_000,
  });
  const lxcQuery = useQuery({
    queryKey: ["vdm-lxc", node.name],
    queryFn: () => api.get<VdmLxc[]>(`/api/vdm/lxc?node=${encodeURIComponent(node.name)}`),
    enabled: open && node.status === "online",
    staleTime: 30_000,
  });
  const dockerQuery = useQuery({
    queryKey: ["vdm-docker", node.name],
    queryFn: () => api.get<VdmDocker[]>(`/api/vdm/docker?node=${encodeURIComponent(node.name)}`),
    enabled: open && node.status === "online",
    staleTime: 30_000,
  });

  const vms = vmsQuery.data ?? [];
  const lxc = lxcQuery.data ?? [];
  const docker = dockerQuery.data ?? [];

  return (
    <div className="select-none">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-sm hover:bg-vdm-surfaceHover text-vdm-text transition-colors"
      >
        <Icon path={open ? ICONS.chevronDown : ICONS.chevronRight} className="w-3 h-3 text-vdm-textMuted flex-shrink-0" />
        <Icon path={ICONS.server} className="w-3.5 h-3.5 text-vdm-textMuted flex-shrink-0" />
        <span className="flex-1 text-left truncate">{node.displayName}</span>
        <StatusDot status={node.status} />
      </button>

      {open && (
        <div className="ml-4 border-l border-vdm-border/40 pl-2 mt-0.5 space-y-0.5">
          {vms.map((vm) => (
            <button
              key={vm.name}
              onClick={() => navigate(`/inventory/vm/${node.name}/${encodeURIComponent(vm.name)}`)}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded text-xs hover:bg-vdm-surfaceHover text-vdm-textMuted hover:text-vdm-text transition-colors"
            >
              <Icon path={ICONS.vm} className="w-3 h-3 flex-shrink-0 text-blue-400" />
              <span className="flex-1 text-left truncate">{vm.name}</span>
              <StatusDot status={vm.state === "running" ? "running" : "stopped"} />
            </button>
          ))}
          {lxc.map((ct) => (
            <button
              key={ct.name}
              onClick={() => navigate(`/inventory/lxc/${node.name}/${encodeURIComponent(ct.name)}`)}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded text-xs hover:bg-vdm-surfaceHover text-vdm-textMuted hover:text-vdm-text transition-colors"
            >
              <Icon path={ICONS.container} className="w-3 h-3 flex-shrink-0 text-green-400" />
              <span className="flex-1 text-left truncate">{ct.name}</span>
              <StatusDot status={ct.state === "running" ? "running" : "stopped"} />
            </button>
          ))}
          {docker.map((ct) => (
            <button
              key={ct.id}
              onClick={() => navigate(`/inventory/docker/${node.name}/${encodeURIComponent(ct.id)}`)}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded text-xs hover:bg-vdm-surfaceHover text-vdm-textMuted hover:text-vdm-text transition-colors"
            >
              <Icon path={ICONS.docker} className="w-3 h-3 flex-shrink-0 text-cyan-400" />
              <span className="flex-1 text-left truncate">{ct.name}</span>
              <StatusDot status={ct.state === "running" ? "running" : "stopped"} />
            </button>
          ))}
          {node.status === "online" && vms.length === 0 && lxc.length === 0 && docker.length === 0 && (
            <p className="px-2 py-1 text-xs text-vdm-textMuted/60 italic">No resources</p>
          )}
          {node.status === "offline" && (
            <p className="px-2 py-1 text-xs text-vdm-danger/70 italic">Node offline</p>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const [inventoryOpen, setInventoryOpen] = useState(true);
  const [storageOpen, setStorageOpen] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ["vdm-nodes"],
    queryFn: () => api.get<VdmNode[]>("/api/vdm/nodes"),
    staleTime: 30_000,
  });
  const storageQuery = useQuery({
    queryKey: ["vdm-storage"],
    queryFn: () => api.get<VdmSharedStorage[]>("/api/vdm/storage"),
    staleTime: 60_000,
  });
  const tasksQuery = useQuery({
    queryKey: ["vdm-tasks-active-count"],
    queryFn: () => api.get<{ count: number }>("/api/vdm/tasks?status=running&limit=1"),
    refetchInterval: 5000,
  });

  const nodes = nodesQuery.data ?? [];
  const storages = storageQuery.data ?? [];
  const activeTasksCount = Array.isArray(tasksQuery.data) ? tasksQuery.data.length : 0;

  return (
    <aside className="flex flex-col w-60 min-w-[240px] bg-[#0d1117] border-r border-vdm-border overflow-hidden">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-vdm-border">
        <div className="w-7 h-7 rounded bg-vdm-accent/20 flex items-center justify-center flex-shrink-0">
          <Icon path={ICONS.datacenter} className="w-4 h-4 text-vdm-accent" />
        </div>
        <div>
          <p className="text-sm font-semibold text-vdm-text leading-none">Virtua VDM</p>
          <p className="text-[10px] text-vdm-textMuted mt-0.5">Datacenter Manager</p>
        </div>
      </div>

      {/* Nav + Inventory */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        <NavItem to="/dashboard" icon={ICONS.dashboard} label="Dashboard" />

        {/* Inventory section */}
        <div className="pt-2">
          <button
            onClick={() => setInventoryOpen((v) => !v)}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted hover:text-vdm-text transition-colors"
          >
            <Icon path={inventoryOpen ? ICONS.chevronDown : ICONS.chevronRight} className="w-3 h-3" />
            Inventory
          </button>

          {inventoryOpen && (
            <div className="mt-1 space-y-0.5">
              <NavItem to="/inventory" icon={ICONS.datacenter} label="All Resources" />
              <div className="ml-2 mt-1 space-y-0.5">
                {nodes.map((node) => <NodeTreeItem key={node.name} node={node} />)}
                {nodes.length === 0 && nodesQuery.isSuccess && (
                  <p className="px-3 py-2 text-xs text-vdm-textMuted/70 italic">No nodes registered</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Resource type shortcuts */}
        <div className="pt-2">
          <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Resources</p>
          <NavItem to="/vms" icon={ICONS.vm} label="Virtual Machines" />
          <NavItem to="/lxc" icon={ICONS.container} label="LXC Containers" />
          <NavItem to="/docker" icon={ICONS.docker} label="Docker" />
        </div>

        {/* Shared Storage */}
        <div className="pt-2">
          <button
            onClick={() => setStorageOpen((v) => !v)}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted hover:text-vdm-text transition-colors"
          >
            <Icon path={storageOpen ? ICONS.chevronDown : ICONS.chevronRight} className="w-3 h-3" />
            Shared Storage
          </button>
          {storageOpen && (
            <div className="ml-2 space-y-0.5">
              {storages.map((s) => (
                <NavLink
                  key={s.name}
                  to="/storage"
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-vdm-textMuted hover:text-vdm-text hover:bg-vdm-surfaceHover transition-colors"
                >
                  <Icon path={ICONS.storage} className="w-3 h-3" />
                  <span className="truncate">{s.displayName}</span>
                  <span className="text-[10px] text-vdm-textMuted/60 uppercase">{s.type}</span>
                </NavLink>
              ))}
              <NavLink
                to="/storage"
                className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-vdm-textMuted hover:text-vdm-text hover:bg-vdm-surfaceHover transition-colors"
              >
                <Icon path={ICONS.storage} className="w-3 h-3" />
                Manage Storage
              </NavLink>
            </div>
          )}
        </div>

        {/* Management */}
        <div className="pt-2">
          <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Management</p>
          <NavItem to="/nodes" icon={ICONS.nodes} label="Nodes" count={nodes.filter((n) => n.status === "offline").length} />
          <NavItem to="/tasks" icon={ICONS.tasks} label="Tasks" count={activeTasksCount} />
          <NavItem to="/backups" icon={ICONS.storage} label="Backups" />
          <NavItem to="/settings" icon={ICONS.settings} label="Settings" />
        </div>
      </nav>

      {/* Status bar */}
      <div className="px-3 py-2 border-t border-vdm-border">
        <div className="flex items-center justify-between text-xs text-vdm-textMuted">
          <span>{nodes.filter((n) => n.status === "online").length}/{nodes.length} nodes online</span>
          {activeTasksCount > 0 && (
            <span className="pill-blue">{activeTasksCount} running</span>
          )}
        </div>
      </div>
    </aside>
  );
}
