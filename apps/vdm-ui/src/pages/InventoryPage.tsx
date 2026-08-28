import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmVm, VdmVmInfo, VdmVmStats, VdmLxc, VdmDocker, VdmNode, VdmSharedStorage, VdmSnapshot, VdmTask } from "@/types/vdm";
import { LogsModal } from "@/components/LogsModal";
import { ConsoleModal } from "@/components/ConsoleModal";
import { VmConfigForm, LxcConfigForm, DockerConfigForm, DockerExec, LxcNetworks, DockerNetworks, LxcSnapshots } from "@/components/ResourcePanels";

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function StatBar({ label, used, total, bytes = true }: { label: string; used: number; total: number; bytes?: boolean }) {
  const pct = total === 0 ? 0 : Math.min(100, Math.round(used / total * 100));
  const color = pct > 90 ? "progress-fill-danger" : pct > 70 ? "progress-fill-warning" : "progress-fill";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-vdm-textMuted">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="progress-bar"><div className={color} style={{ width: `${pct}%` }} /></div>
      <div className="flex justify-between text-xs text-vdm-textMuted/70">
        <span>{bytes ? formatBytes(used) : `${used.toFixed(1)}%`}</span><span>{bytes ? formatBytes(total) : `${total}%`}</span>
      </div>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const map: Record<string, string> = {
    running: "pill-green", stopped: "pill-gray", paused: "pill-yellow",
    suspended: "pill-yellow", crashed: "pill-red", unknown: "pill-gray",
  };
  return <span className={map[state] ?? "pill-gray"}>{state}</span>;
}

function AgentStatus({ label, present, connected, responding }: { label: string; present?: boolean; connected?: boolean; responding?: boolean }) {
  const state = !present ? "Not configured" : responding === false ? "Not responding" : connected ? "Connected" : "Disconnected";
  const cls = !present ? "pill-gray" : (responding === false || !connected) ? "pill-yellow" : "pill-green";
  return <div className="flex items-center justify-between rounded border border-vdm-border px-3 py-2 text-xs"><span className="text-vdm-textMuted">{label}</span><span className={cls}>{state}</span></div>;
}

// ── Action Modal (power actions, migrate, clone, backup) ──────────────────
function ActionButton({ label, icon, onClick, variant = "ghost", disabled }: { label: string; icon: string; onClick: () => void; variant?: "ghost" | "primary" | "danger" | "success" | "warning"; disabled?: boolean }) {
  const cls = {
    ghost: "vdm-btn-ghost", primary: "vdm-btn-primary",
    danger: "vdm-btn-danger", success: "vdm-btn-success", warning: "vdm-btn-warning",
  }[variant];
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      <Icon path={icon} className="w-3.5 h-3.5" />{label}
    </button>
  );
}

// ── Migrate Modal ──────────────────────────────────────────────────────────
function MigrateModal({ open, onClose, resourceType, resourceName, sourceNode, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; resourceType: string; resourceName: string;
  sourceNode: string; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (targetNode: string, sharedStorageName: string | undefined, targetStoragePool: string | undefined, deleteSource: boolean) => void;
}) {
  const [targetNode, setTargetNode] = useState("");
  const [mode, setMode] = useState<"shared" | "local">("shared");
  const [storName, setStorName] = useState("");
  const [deleteSource, setDeleteSource] = useState(true);

  if (!open) return null;
  const canSubmit = targetNode && (mode === "local" ? true : !!storName);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Migrate {resourceType}: {resourceName}</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
            <option value="">Select node...</option>
            {nodes.filter((n) => n.name !== sourceNode && n.status === "online").map((n) => (
              <option key={n.name} value={n.name}>{n.displayName}</option>
            ))}
          </select>
        </div>

        {/* Transfer mode */}
        <div>
          <label className="vdm-label">Transfer method</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode("shared")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Shared storage
            </button>
            <button type="button" onClick={() => setMode("local")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Local copy (direct)
            </button>
          </div>
        </div>

        {mode === "shared" ? (
          <div>
            <label className="vdm-label">Shared Storage (for migration data)</label>
            <select className="vdm-input" value={storName} onChange={(e) => setStorName(e.target.value)}>
              <option value="">Select shared storage...</option>
              {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.type}: {s.source})</option>)}
            </select>
            {storages.length === 0 && <p className="text-xs text-vdm-danger mt-1">⚠ No shared storage configured. Use "Local copy" instead.</p>}
          </div>
        ) : (
          <p className="text-xs text-vdm-textMuted bg-vdm-accent/8 border border-vdm-accent/25 rounded px-3 py-2">
            Copies the {resourceType} data directly to the target node's <span className="font-mono">local</span> storage pool (streamed node-to-node, no shared storage required).
          </p>
        )}

        <label className="flex items-center gap-2 text-sm text-vdm-text cursor-pointer">
          <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} className="rounded" />
          Delete from source after migration
        </label>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (canSubmit) { onSubmit(targetNode, mode === "shared" ? storName : undefined, mode === "local" ? "local" : undefined, deleteSource); onClose(); } }} disabled={!canSubmit}>
            Start Migration
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Clone Modal ────────────────────────────────────────────────────────────
function CloneModal({ open, onClose, resourceName, onSubmit }: {
  open: boolean; onClose: () => void; resourceName: string; onSubmit: (newName: string) => void;
}) {
  const [newName, setNewName] = useState(`${resourceName}-clone`);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-sm p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Clone: {resourceName}</h3>
        <div>
          <label className="vdm-label">New Name</label>
          <input className="vdm-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="clone-name" />
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (newName) { onSubmit(newName); onClose(); } }}>Clone</button>
        </div>
      </div>
    </div>
  );
}

// ── Backup Modal ───────────────────────────────────────────────────────────
function BackupModal({ open, onClose, resourceName, storages, onSubmit }: {
  open: boolean; onClose: () => void; resourceName: string; storages: VdmSharedStorage[];
  onSubmit: (sharedStorageName: string) => void;
}) {
  const [storName, setStorName] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-sm p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Backup: {resourceName}</h3>
        <div>
          <label className="vdm-label">Destination (Shared Storage)</label>
          <select className="vdm-input" value={storName} onChange={(e) => setStorName(e.target.value)}>
            <option value="">Select shared storage...</option>
            {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.source})</option>)}
          </select>
          {storages.length === 0 && <p className="text-xs text-vdm-danger mt-1">⚠ No shared storage configured.</p>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (storName) { onSubmit(storName); onClose(); } }} disabled={!storName}>
            Start Backup
          </button>
        </div>
      </div>
    </div>
  );
}

// ── VM Detail Panel ────────────────────────────────────────────────────────
function VmDetail({ nodeName, vmName }: { nodeName: string; vmName: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"summary" | "config" | "snapshots" | "tasks">("summary");
  const [showConsole, setShowConsole] = useState(false);
  const [showVnc, setShowVnc] = useState(false);
  const [showSpice, setShowSpice] = useState(false);
  const [showRdp, setShowRdp] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const navigate = useNavigate();

  const vmQuery = useQuery<VdmVmInfo>({
    queryKey: ["vdm-vm", nodeName, vmName],
    queryFn: () => api.get(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}`),
    refetchInterval: 10_000,
  });
  const statsQuery = useQuery<VdmVmStats>({
    queryKey: ["vdm-vm-stats", nodeName, vmName],
    queryFn: () => api.get(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/stats`),
    refetchInterval: 5_000,
    enabled: vmQuery.data?.state === "running",
  });
  const snapsQuery = useQuery<VdmSnapshot[]>({
    queryKey: ["vdm-vm-snaps", nodeName, vmName],
    queryFn: () => api.get(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/snapshots`),
    enabled: tab === "snapshots",
  });
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const storagesQuery = useQuery<VdmSharedStorage[]>({ queryKey: ["vdm-storage"], queryFn: () => api.get("/api/vdm/storage") });

  const actionMut = useMutation({
    mutationFn: (action: string) => api.post(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/action`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vm", nodeName, vmName] }),
  });
  const snapMut = useMutation({
    mutationFn: (snapName: string) => api.post(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/snapshot`, { snapName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vm-snaps", nodeName, vmName] }),
  });
  const rollbackMut = useMutation({
    mutationFn: (snap: string) => api.post(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/snapshot/${encodeURIComponent(snap)}/rollback`),
  });
  const delSnapMut = useMutation({
    mutationFn: (snap: string) => api.delete(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/snapshot/${encodeURIComponent(snap)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vm-snaps", nodeName, vmName] }),
  });
  const migrateMut = useMutation({
    mutationFn: (p: { targetNode: string; sharedStorageName?: string; targetStoragePool?: string; deleteSource: boolean }) =>
      api.post<VdmTask>(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/migrate`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const cloneMut = useMutation({
    mutationFn: (newName: string) => api.post(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/clone`, { newName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const backupMut = useMutation({
    mutationFn: (sharedStorageName: string) => api.post(`/api/vdm/vms/${encodeURIComponent(nodeName)}/${encodeURIComponent(vmName)}/backup`, { sharedStorageName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });

  const vm = vmQuery.data;
  const stats = statsQuery.data;
  const isRunning = vm?.state === "running";

  if (vmQuery.isLoading) return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!vm) return <div className="p-6 text-vdm-textMuted">VM not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-vdm-text">{vm.name}</h2>
            <StateChip state={vm.state} />
          </div>
          <p className="text-sm text-vdm-textMuted mt-0.5">{nodeName} · {vm.vcpus} vCPU · {vm.memoryMb} MB RAM</p>
        </div>
        {vmQuery.isFetching && <div className="w-4 h-4 border border-vdm-accent border-t-transparent rounded-full animate-spin mt-1" />}
      </div>

      {/* Action toolbar */}
      <div className="flex flex-wrap gap-2 p-3 bg-vdm-bg rounded-lg border border-vdm-border">
        {!isRunning && <ActionButton label="Power On" icon="M5.636 5.636a9 9 0 1 0 12.728 0M12 3v9" variant="success" onClick={() => actionMut.mutate("start")} />}
        {isRunning && <ActionButton label="Shutdown" icon="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" variant="warning" onClick={() => actionMut.mutate("shutdown")} />}
        {isRunning && <ActionButton label="Reboot" icon="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" variant="ghost" onClick={() => actionMut.mutate("reboot")} />}
        {isRunning && <ActionButton label="Force Off" icon="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" variant="danger" onClick={() => { if (confirm(`Force off ${vm.name}?`)) actionMut.mutate("forceStop"); }} />}
        {isRunning && <ActionButton label="Suspend" icon="M15.75 5.25v13.5m-7.5-13.5v13.5" variant="ghost" onClick={() => actionMut.mutate("pause")} />}
        <div className="h-6 w-px bg-vdm-border self-center" />
        <ActionButton label="Migrate" icon="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" onClick={() => setShowMigrate(true)} />
        <ActionButton label="Clone" icon="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" onClick={() => setShowClone(true)} />
        <ActionButton label="Backup" icon="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625" onClick={() => setShowBackup(true)} />
        <ActionButton label="Logs" icon="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" onClick={() => setShowLogs(true)} />
        <div className="h-6 w-px bg-vdm-border self-center" />
        <ActionButton label="Console" icon="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" variant="primary" disabled={!isRunning} onClick={() => setShowConsole(true)} />
        <ActionButton label="Graphical" icon="M2.25 12.75V12a2.25 2.25 0 0 1 2.25-2.25h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" disabled={!isRunning} onClick={() => setShowVnc(true)} />
        <ActionButton label="SPICE" icon="M9.75 17 9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z" disabled={!isRunning} onClick={() => setShowSpice(true)} />
        <ActionButton label="RDP" icon="M12 16.5V21m0 0H7.5m4.5 0h4.5M3.75 4.5h16.5v12H3.75v-12Z" disabled={!isRunning} onClick={() => setShowRdp(true)} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-vdm-border">
        {(["summary", "config", "snapshots", "tasks"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${tab === t ? "border-vdm-accent text-vdm-accent" : "border-transparent text-vdm-textMuted hover:text-vdm-text"}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Tab: Summary */}
      {tab === "summary" && (
        <div className="grid grid-cols-2 gap-4">
          {stats && (
            <div className="vdm-card p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Live Stats</h3>
              <StatBar label="CPU" used={stats.cpuUsagePercent} total={100} bytes={false} />
              <StatBar label="Memory" used={stats.memoryUsedMb * 1024 * 1024} total={stats.memoryTotalMb * 1024 * 1024} />
              <div className="grid grid-cols-2 gap-2 text-xs text-vdm-textMuted pt-1">
                <div><span className="text-vdm-textMuted/70">Disk R</span> <span className="text-vdm-text">{formatBytes(stats.diskReadBytes)}/s</span></div>
                <div><span className="text-vdm-textMuted/70">Disk W</span> <span className="text-vdm-text">{formatBytes(stats.diskWriteBytes)}/s</span></div>
                <div><span className="text-vdm-textMuted/70">Net ↓</span> <span className="text-vdm-text">{formatBytes(stats.netRxBytes)}/s</span></div>
                <div><span className="text-vdm-textMuted/70">Net ↑</span> <span className="text-vdm-text">{formatBytes(stats.netTxBytes)}/s</span></div>
              </div>
            </div>
          )}
          <div className="vdm-card p-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Configuration</h3>
            {[
              ["Architecture", vm.arch ?? "—"], ["Machine", vm.machine ?? "—"],
              ["Boot", vm.bootDevice ?? "—"], ["vCPUs", vm.vcpus ?? "—"],
              ["Memory", vm.memoryMb ? `${vm.memoryMb} MB` : "—"],
              ["UEFI", vm.uefi ? "Yes" : "No"], ["TPM", vm.tpmEnabled ? "Yes" : "No"],
              ["QEMU Agent", vm.qemuAgentEnabled ? "Yes" : "No"],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between text-xs">
                <span className="text-vdm-textMuted">{k}</span>
                <span className="text-vdm-text font-mono">{v as string}</span>
              </div>
            ))}
          </div>
          {stats && <div className="vdm-card col-span-2 p-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Guest Agents</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <AgentStatus label="QEMU Guest Agent" present={stats.guestAgentEnabled} connected={stats.guestAgentConnected} responding={stats.guestAgentRunning} />
              <AgentStatus label="SPICE Agent" present={stats.spiceAgentPresent} connected={stats.spiceAgentConnected} />
            </div>
            {stats.ipAddresses && stats.ipAddresses.length > 0 && <div className="flex justify-between rounded border border-vdm-border px-3 py-2 text-xs"><span className="text-vdm-textMuted">Guest IP</span><span className="font-mono text-vdm-text">{stats.ipAddresses.join(", ")}</span></div>}
          </div>}
          {vm.disks && vm.disks.length > 0 && (
            <div className="vdm-card p-4 space-y-2 col-span-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Disks</h3>
              <table className="vdm-table"><thead><tr><th>Device</th><th>Path</th><th>Size</th><th>Format</th></tr></thead>
                <tbody>{vm.disks.map((d) => (
                  <tr key={d.device}><td className="font-mono">{d.device}</td><td className="text-vdm-textMuted text-xs truncate max-w-48">{d.path}</td><td>{formatBytes(d.sizeBytes)}</td><td>{d.format}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Config */}
      {tab === "config" && <VmConfigForm node={nodeName} name={vm.name} vm={vm as unknown as Record<string, unknown>} />}

      {/* Tab: Snapshots */}
      {tab === "snapshots" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button className="vdm-btn-primary" onClick={() => {
              const n = prompt("Snapshot name:"); if (n) snapMut.mutate(n);
            }}>+ New Snapshot</button>
          </div>
          <div className="vdm-card divide-y divide-vdm-border/50">
            {(snapsQuery.data ?? []).length === 0 ? (
              <p className="px-4 py-6 text-sm text-vdm-textMuted text-center">No snapshots</p>
            ) : (snapsQuery.data ?? []).map((snap) => (
              <div key={snap.name} className="flex items-center gap-3 px-4 py-3">
                <span className="font-mono text-sm text-vdm-text flex-1">{snap.name}</span>
                <span className="text-xs text-vdm-textMuted">{snap.createdAt ? new Date(snap.createdAt).toLocaleString() : "—"}</span>
                <button className="vdm-btn-warning text-xs" onClick={() => { if (confirm(`Rollback to ${snap.name}?`)) rollbackMut.mutate(snap.name); }}>Rollback</button>
                <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete snapshot ${snap.name}?`)) delSnapMut.mutate(snap.name); }}>Delete</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modals */}
      <MigrateModal open={showMigrate} onClose={() => setShowMigrate(false)} resourceType="VM" resourceName={vm.name} sourceNode={nodeName}
        nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onSubmit={(t, s, p, d) => migrateMut.mutate({ targetNode: t, sharedStorageName: s, targetStoragePool: p, deleteSource: d })} />
      <CloneModal open={showClone} onClose={() => setShowClone(false)} resourceName={vm.name} onSubmit={(n) => cloneMut.mutate(n)} />
      <BackupModal open={showBackup} onClose={() => setShowBackup(false)} resourceName={vm.name} storages={storagesQuery.data ?? []} onSubmit={(s) => backupMut.mutate(s)} />
      <LogsModal open={showLogs} onClose={() => setShowLogs(false)} type="vms" node={nodeName} name={vm.name} title={vm.name} />
      <ConsoleModal open={showConsole} onClose={() => setShowConsole(false)} type="vms" node={nodeName} name={vm.name} title={vm.name} mode="term" />
      <ConsoleModal open={showVnc} onClose={() => setShowVnc(false)} type="vms" node={nodeName} name={vm.name} title={vm.name} mode="vnc" />
      <ConsoleModal open={showSpice} onClose={() => setShowSpice(false)} type="vms" node={nodeName} name={vm.name} title={vm.name} mode="spice" />
      <ConsoleModal open={showRdp} onClose={() => setShowRdp(false)} type="vms" node={nodeName} name={vm.name} title={vm.name} mode="rdp" />
    </div>
  );
}

// ── LXC Detail Panel ───────────────────────────────────────────────────────
function LxcDetail({ nodeName, ctName }: { nodeName: string; ctName: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showMigrate, setShowMigrate] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [tab, setTab] = useState<"summary" | "config" | "network" | "snapshots">("summary");

  const ctQuery = useQuery({
    queryKey: ["vdm-lxc", nodeName, ctName],
    queryFn: () => api.get<VdmLxc>(`/api/vdm/lxc/${encodeURIComponent(nodeName)}/${encodeURIComponent(ctName)}`),
    refetchInterval: 10_000,
  });
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const storagesQuery = useQuery<VdmSharedStorage[]>({ queryKey: ["vdm-storage"], queryFn: () => api.get("/api/vdm/storage") });

  const actionMut = useMutation({
    mutationFn: (action: string) => api.post(`/api/vdm/lxc/${encodeURIComponent(nodeName)}/${encodeURIComponent(ctName)}/action`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-lxc", nodeName, ctName] }),
  });
  const migrateMut = useMutation({
    mutationFn: (p: { targetNode: string; sharedStorageName?: string; targetStoragePool?: string; deleteSource: boolean }) =>
      api.post(`/api/vdm/lxc/${encodeURIComponent(nodeName)}/${encodeURIComponent(ctName)}/migrate`, p),
    onSuccess: () => navigate("/tasks"),
  });
  const backupMut = useMutation({
    mutationFn: (sharedStorageName: string) => api.post(`/api/vdm/lxc/${encodeURIComponent(nodeName)}/${encodeURIComponent(ctName)}/backup`, { sharedStorageName }),
    onSuccess: () => navigate("/tasks"),
  });

  const ct = ctQuery.data;
  if (ctQuery.isLoading) return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!ct) return <div className="p-6 text-vdm-textMuted">Container not found</div>;

  const isRunning = ct.state === "running";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-vdm-text">{ct.name}</h2>
        <StateChip state={ct.state} />
        <span className="text-sm text-vdm-textMuted">{nodeName}</span>
      </div>
      <div className="flex flex-wrap gap-2 p-3 bg-vdm-bg rounded-lg border border-vdm-border">
        {!isRunning && <ActionButton label="Start" icon="M5.636 5.636a9 9 0 1 0 12.728 0M12 3v9" variant="success" onClick={() => actionMut.mutate("start")} />}
        {isRunning && <ActionButton label="Stop" icon="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" variant="warning" onClick={() => actionMut.mutate("stop")} />}
        {isRunning && <ActionButton label="Restart" icon="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" variant="ghost" onClick={() => actionMut.mutate("restart")} />}
        <div className="h-6 w-px bg-vdm-border self-center" />
        <ActionButton label="Migrate" icon="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" onClick={() => setShowMigrate(true)} />
        <ActionButton label="Backup" icon="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625" onClick={() => setShowBackup(true)} />
        <ActionButton label="Logs" icon="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" onClick={() => setShowLogs(true)} />
        <ActionButton label="Console" icon="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" variant="primary" disabled={!isRunning} onClick={() => setShowConsole(true)} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-vdm-border">
        {(["summary", "config", "network", "snapshots"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${tab === t ? "border-vdm-accent text-vdm-accent" : "border-transparent text-vdm-textMuted hover:text-vdm-text"}`}>{t}</button>
        ))}
      </div>

      {tab === "summary" && (
        <div className="grid grid-cols-2 gap-3">
          {[["OS", ct.os ?? "—"], ["Arch", ct.arch ?? "—"], ["CPUs", ct.cpus ?? "—"], ["Memory", ct.memoryMb ? `${ct.memoryMb} MB` : "—"], ["Disk", ct.rootfsSizeGb ? `${ct.rootfsSizeGb} GB` : "—"]].map(([k, v]) => (
            <div key={k as string} className="vdm-card px-3 py-2 flex justify-between text-sm">
              <span className="text-vdm-textMuted">{k}</span><span className="text-vdm-text font-mono">{v as string}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "config" && <LxcConfigForm node={nodeName} name={ct.name} ct={ct as unknown as Record<string, unknown>} />}
      {tab === "network" && <LxcNetworks node={nodeName} name={ct.name} />}
      {tab === "snapshots" && <LxcSnapshots node={nodeName} name={ct.name} />}

      <MigrateModal open={showMigrate} onClose={() => setShowMigrate(false)} resourceType="LXC" resourceName={ct.name} sourceNode={nodeName}
        nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onSubmit={(t, s, p, d) => migrateMut.mutate({ targetNode: t, sharedStorageName: s, targetStoragePool: p, deleteSource: d })} />
      <BackupModal open={showBackup} onClose={() => setShowBackup(false)} resourceName={ct.name} storages={storagesQuery.data ?? []} onSubmit={(s) => backupMut.mutate(s)} />
      <LogsModal open={showLogs} onClose={() => setShowLogs(false)} type="lxc" node={nodeName} name={ct.name} title={ct.name} />
      <ConsoleModal open={showConsole} onClose={() => setShowConsole(false)} type="lxc" node={nodeName} name={ct.name} title={ct.name} mode="term" />
    </div>
  );
}

// ── Docker Detail Panel ────────────────────────────────────────────────────
function formatDockerPorts(ports: VdmDocker["ports"]): string {
  if (!ports) return "—";
  if (typeof ports === "string") return ports;
  if (!Array.isArray(ports) || ports.length === 0) return "—";
  return ports.map((p) => `${p.hostIp ? `${p.hostIp}:` : ""}${p.hostPort}->${p.containerPort}/${p.protocol}`).join(", ");
}

function DockerDetail({ nodeName, containerId }: { nodeName: string; containerId: string }) {
  const qc = useQueryClient();
  const [showLogs, setShowLogs] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [tab, setTab] = useState<"summary" | "config" | "network" | "exec">("summary");
  const ctQuery = useQuery({
    queryKey: ["vdm-docker", nodeName, containerId],
    queryFn: () => api.get<VdmDocker>(`/api/vdm/docker/${encodeURIComponent(nodeName)}/${encodeURIComponent(containerId)}`),
    refetchInterval: 10_000,
  });
  const actionMut = useMutation({
    mutationFn: (action: string) => api.post(`/api/vdm/docker/${encodeURIComponent(nodeName)}/${encodeURIComponent(containerId)}/action`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-docker", nodeName, containerId] }),
  });

  const ct = ctQuery.data as Record<string, unknown> | undefined;
  if (!ct) return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>;

  const isRunning = (ct.state as string) === "running";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-vdm-text">{ct.name as string}</h2>
        <StateChip state={ct.state as string ?? "unknown"} />
        <span className="text-sm text-vdm-textMuted">{nodeName}</span>
      </div>
      <div className="flex flex-wrap gap-2 p-3 bg-vdm-bg rounded-lg border border-vdm-border">
        {!isRunning && <ActionButton label="Start" icon="M5.636 5.636a9 9 0 1 0 12.728 0M12 3v9" variant="success" onClick={() => actionMut.mutate("start")} />}
        {isRunning && <ActionButton label="Stop" icon="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" variant="warning" onClick={() => actionMut.mutate("stop")} />}
        {isRunning && <ActionButton label="Restart" icon="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" onClick={() => actionMut.mutate("restart")} />}
        <div className="h-6 w-px bg-vdm-border self-center" />
        <ActionButton label="Logs" icon="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" onClick={() => setShowLogs(true)} />
        <ActionButton label="Console" icon="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" variant="primary" disabled={!isRunning} onClick={() => setShowConsole(true)} />
      </div>
      <LogsModal open={showLogs} onClose={() => setShowLogs(false)} type="docker" node={nodeName} name={containerId} title={ct.name as string} />
      <ConsoleModal open={showConsole} onClose={() => setShowConsole(false)} type="docker" node={nodeName} name={containerId} title={ct.name as string} mode="term" />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-vdm-border">
        {(["summary", "config", "network", "exec"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${tab === t ? "border-vdm-accent text-vdm-accent" : "border-transparent text-vdm-textMuted hover:text-vdm-text"}`}>{t}</button>
        ))}
      </div>

      {tab === "summary" && (
        <div className="vdm-card p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase text-vdm-textMuted">Container Info</h3>
          {([["Image", ct.image], ["Status", ct.status], ["Created", ct.createdAt ?? ct.created ?? "—"], ["Ports", formatDockerPorts(ct.ports as VdmDocker["ports"])]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs">
              <span className="text-vdm-textMuted">{k}</span>
              <span className="text-vdm-text font-mono truncate max-w-48">{v}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "config" && <DockerConfigForm node={nodeName} id={containerId} ct={ct} />}
      {tab === "network" && <DockerNetworks node={nodeName} id={containerId} />}
      {tab === "exec" && <DockerExec node={nodeName} id={containerId} />}
    </div>
  );
}

// ── Main InventoryPage ─────────────────────────────────────────────────────
export default function InventoryPage() {
  const { type, node, name } = useParams<{ type?: string; node?: string; name?: string }>();

  const hasSelection = !!(type && node && name);

  return (
    <div className="h-full flex gap-4">
      {/* Detail panel */}
      <div className="flex-1 min-w-0">
        {!hasSelection ? (
          <div className="vdm-card p-8 text-center">
            <p className="text-vdm-textMuted text-sm">Select a resource from the inventory tree on the left to view details.</p>
            <p className="text-vdm-textMuted/60 text-xs mt-2">Navigate to VMs, LXC Containers, or Docker sections for list views.</p>
          </div>
        ) : type === "vm" ? (
          <div className="vdm-card p-4">
            <VmDetail nodeName={node!} vmName={decodeURIComponent(name!)} />
          </div>
        ) : type === "lxc" ? (
          <div className="vdm-card p-4">
            <LxcDetail nodeName={node!} ctName={decodeURIComponent(name!)} />
          </div>
        ) : type === "docker" ? (
          <div className="vdm-card p-4">
            <DockerDetail nodeName={node!} containerId={decodeURIComponent(name!)} />
          </div>
        ) : (
          <div className="p-4 text-vdm-textMuted">Unknown resource type</div>
        )}
      </div>
    </div>
  );
}
