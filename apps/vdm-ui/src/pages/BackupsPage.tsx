import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import type { VdmBackupItem, VdmBackupJob, VdmBackupRepository, VdmNode } from "@/types/vdm";

function bytes(value: number) {
  if (!value) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  repo: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625",
  plus: "M12 4.5v15m7.5-7.5h-15",
  check: "M4.5 12.75l6 6 9-13.5",
  trash: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
  restore: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5",
  shield: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z",
  db: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625",
};

function StatusBadge({ status }: { status: string }) {
  const cls = status === "available" ? "pill-green" : "pill-red";
  return <span className={cls}>{status}</span>;
}

function RestoreModal({ item, nodes, onClose, onRestore, isPending }: {
  item: VdmBackupItem | null;
  nodes: VdmNode[];
  onClose: () => void;
  onRestore: (targetNode: string, name: string) => void;
  isPending: boolean;
}) {
  const [targetNode, setTargetNode] = useState("");
  const [name, setName] = useState("");
  if (!item) return null;
  const defaultNode = nodes.find((n) => n.name === item.sourceNode)?.name ?? nodes[0]?.name ?? "";
  const resolved = targetNode || defaultNode;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="vdm-card w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-vdm-text">Restore backup</h3>
        <p className="text-xs text-vdm-textMuted break-all font-mono">{item.filename}</p>
        <div>
          <label className="vdm-label">Target node</label>
          <select className="vdm-input" value={resolved} onChange={(e) => setTargetNode(e.target.value)}>
            {nodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>
        <div>
          <label className="vdm-label">Restored resource name</label>
          <input className="vdm-input font-mono" value={name || item.resourceName} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={isPending} onClick={() => onRestore(resolved, name || item.resourceName)}>
            {isPending ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddJobModal({ repositories, nodes, onClose, onAdd, isPending }: {
  repositories: VdmBackupRepository[];
  nodes: VdmNode[];
  onClose: () => void;
  onAdd: (data: { name: string; repositoryId: number; resourceType: string; resourceName: string; sourceNode: string; intervalMinutes: number }) => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState({ name: "", repositoryId: "", resourceType: "vm", resourceName: "", sourceNode: "", intervalMinutes: "1440" });
  const onlineNodes = nodes.filter((n) => n.status === "online");
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.name && form.repositoryId && form.resourceName && form.sourceNode;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="vdm-card w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-vdm-text">New backup schedule</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className="vdm-label">Job name</label>
            <input className="vdm-input" placeholder="nightly-web" value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div><label className="vdm-label">Repository</label>
            <select className="vdm-input" value={form.repositoryId} onChange={(e) => set("repositoryId", e.target.value)}>
              <option value="">Select…</option>
              {repositories.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
            </select></div>
          <div><label className="vdm-label">Source node</label>
            <select className="vdm-input" value={form.sourceNode} onChange={(e) => set("sourceNode", e.target.value)}>
              <option value="">Select…</option>
              {onlineNodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
            </select></div>
          <div><label className="vdm-label">Resource type</label>
            <select className="vdm-input" value={form.resourceType} onChange={(e) => set("resourceType", e.target.value)}>
              <option value="vm">VM</option><option value="lxc">LXC</option>
            </select></div>
          <div><label className="vdm-label">Resource name</label>
            <input className="vdm-input font-mono" placeholder="my-vm" value={form.resourceName} onChange={(e) => set("resourceName", e.target.value)} /></div>
          <div className="col-span-2"><label className="vdm-label">Frequency</label>
            <select className="vdm-input" value={form.intervalMinutes} onChange={(e) => set("intervalMinutes", e.target.value)}>
              <option value="60">Hourly</option><option value="1440">Daily</option><option value="10080">Weekly</option>
            </select></div>
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!canSubmit || isPending} onClick={() => onAdd({ ...form, repositoryId: Number(form.repositoryId), intervalMinutes: Number(form.intervalMinutes) })}>
            {isPending ? "Adding…" : "Add schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackupsPage() {
  const { isAdmin } = useVdmAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [restoreTarget, setRestoreTarget] = useState<VdmBackupItem | null>(null);
  const [showAddJob, setShowAddJob] = useState(false);

  const backups = useQuery<VdmBackupItem[]>({ queryKey: ["vdm-backups"], queryFn: () => api.get("/api/vdm/backups"), refetchInterval: 10_000 });
  const repositories = useQuery<VdmBackupRepository[]>({ queryKey: ["vdm-backup-repositories"], queryFn: () => api.get("/api/vdm/backup-repositories") });
  const nodes = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const jobs = useQuery<VdmBackupJob[]>({ queryKey: ["vdm-backup-jobs"], queryFn: () => api.get("/api/vdm/backup-jobs"), refetchInterval: 15_000 });

  const verify = useMutation({
    mutationFn: (id: string) => api.post(`/api/vdm/backups/${encodeURIComponent(id)}/verify`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["vdm-backups"] }),
  });
  const restore = useMutation({
    mutationFn: ({ id, targetNode, name }: { id: string; targetNode: string; name: string }) =>
      api.post(`/api/vdm/backups/${encodeURIComponent(id)}/restore`, { targetNode, name }),
    onSuccess: () => { setRestoreTarget(null); queryClient.invalidateQueries({ queryKey: ["vdm-tasks"] }); },
  });
  const createJob = useMutation({
    mutationFn: (data: { name: string; repositoryId: number; resourceType: string; resourceName: string; sourceNode: string; intervalMinutes: number }) => api.post("/api/vdm/backup-jobs", data),
    onSuccess: () => { setShowAddJob(false); queryClient.invalidateQueries({ queryKey: ["vdm-backup-jobs"] }); },
  });
  const deleteJob = useMutation({ mutationFn: (id: string) => api.delete(`/api/vdm/backup-jobs/${encodeURIComponent(id)}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-backup-jobs"] }) });
  const deleteBackup = useMutation({ mutationFn: (id: string) => api.delete(`/api/vdm/backups/${encodeURIComponent(id)}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-backups"] }) });

  const repositoryById = useMemo(() => new Map((repositories.data ?? []).map((r) => [r.id, r])), [repositories.data]);

  const filtered = (backups.data ?? []).filter((item) => {
    if (search && !item.resourceName.toLowerCase().includes(search.toLowerCase()) && !item.filename.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (typeFilter !== "all" && item.resourceType !== typeFilter) return false;
    return true;
  });

  const totalBytes = filtered.reduce((s, i) => s + i.sizeBytes, 0);
  const verifiedCount = filtered.filter((i) => i.verifiedAt).length;
  const availableCount = filtered.filter((i) => i.status === "available").length;
  const uniqueResources = new Set(filtered.map((i) => `${i.resourceType}:${i.resourceName}`)).size;

  function onAddJob(data: { name: string; repositoryId: number; resourceType: string; resourceName: string; sourceNode: string; intervalMinutes: number }) {
    createJob.mutate(data);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Backups</h1>
          <p className="text-sm text-vdm-textMuted">Catalog, verification and cross-node restore</p>
        </div>
        {isAdmin && (
          <button className="vdm-btn-primary" onClick={() => setShowAddJob(true)}>
            <Icon path={ICONS.plus} className="w-3.5 h-3.5" /> New schedule
          </button>
        )}
      </div>

      {/* Metrics */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="vdm-card p-3"><div className="text-xs text-vdm-textMuted">Total backups</div><div className="text-xl font-semibold text-vdm-text">{filtered.length}</div></div>
        <div className="vdm-card p-3"><div className="text-xs text-vdm-textMuted">Total size</div><div className="text-xl font-semibold text-vdm-text">{bytes(totalBytes)}</div></div>
        <div className="vdm-card p-3"><div className="text-xs text-vdm-textMuted">Available</div><div className="text-xl font-semibold text-vdm-success">{availableCount}/{filtered.length}</div></div>
        <div className="vdm-card p-3"><div className="text-xs text-vdm-textMuted">Verified / resources</div><div className="text-xl font-semibold text-vdm-text">{verifiedCount} · {uniqueResources}</div></div>
      </div>

      {/* Repository cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(repositories.data ?? []).map((r) => {
          const items = (backups.data ?? []).filter((b) => b.repositoryId === r.id);
          const used = items.reduce((s, i) => s + i.sizeBytes, 0);
          return (
            <div key={r.id} className="vdm-card p-3">
              <div className="flex items-center gap-2">
                <Icon path={ICONS.db} className="w-4 h-4 text-vdm-accent" />
                <span className="font-medium text-vdm-text flex-1 truncate">{r.displayName}</span>
              </div>
              <p className="text-xs text-vdm-textMuted mt-1">Storage: {r.storageName}</p>
              <p className="text-xs text-vdm-textMuted">Retention {r.retentionDaily}d / {r.retentionWeekly}w / {r.retentionMonthly}m</p>
              <p className="text-xs text-vdm-textMuted mt-1">{items.length} backups · {bytes(used)}{r.quotaBytes ? ` / ${bytes(r.quotaBytes)}` : ""}</p>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <input className="vdm-input w-48" placeholder="Search resource or file…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="vdm-input w-36" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All status</option><option value="available">Available</option><option value="missing">Missing</option><option value="deleted">Deleted</option>
        </select>
        <select className="vdm-input w-32" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option><option value="vm">VM</option><option value="lxc">LXC</option>
        </select>
      </div>

      {/* Jobs */}
      {isAdmin && (
        <div className="vdm-card divide-y divide-vdm-border/50">
          <div className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Schedules ({jobs.data?.length ?? 0})</div>
          {(jobs.data ?? []).length === 0 ? (
            <div className="px-4 py-4 text-sm text-vdm-textMuted">No backup schedules yet. Create one to automate backups.</div>
          ) : (jobs.data ?? []).map((job) => (
            <div key={job.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="font-medium flex-1">{job.name}</span>
              <span className="pill-gray uppercase">{job.resourceType}</span>
              <span className="text-vdm-textMuted">{job.resourceName} · {job.sourceNode}</span>
              <span className="text-xs text-vdm-textMuted">next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</span>
              {isAdmin && <button className="vdm-btn-danger text-xs" onClick={() => deleteJob.mutate(job.id)}>Delete</button>}
            </div>
          ))}
        </div>
      )}

      {/* Backups table */}
      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead><tr><th>Resource</th><th>Node</th><th>Repository</th><th>File</th><th>Size</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {backups.isLoading ? (
              <tr><td colSpan={8} className="text-center py-8"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="py-8 text-center text-vdm-textMuted">No backups match the current filters</td></tr>
            ) : filtered.map((item) => (
              <tr key={item.id}>
                <td><span className="pill-gray uppercase mr-2">{item.resourceType}</span>{item.resourceName}</td>
                <td>{item.sourceNode}</td>
                <td>{repositoryById.get(item.repositoryId)?.displayName ?? item.repositoryId}</td>
                <td className="font-mono text-xs max-w-56 truncate" title={item.filename}>{item.filename}</td>
                <td>{bytes(item.sizeBytes)}</td>
                <td><StatusBadge status={item.status} />{item.verifiedAt && <div className="text-[10px] text-vdm-success">✓ verified</div>}</td>
                <td className="text-xs whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</td>
                <td className="space-x-2 whitespace-nowrap">
                  {isAdmin && <button className="vdm-btn-ghost text-xs" onClick={() => verify.mutate(item.id)}>Verify</button>}
                  {isAdmin && item.status === "available" && <button className="vdm-btn-primary text-xs" onClick={() => setRestoreTarget(item)}>Restore</button>}
                  {isAdmin && <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete backup ${item.filename}?`)) deleteBackup.mutate(item.id); }}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(verify.error || restore.error) && <p className="text-sm text-vdm-danger">{(verify.error ?? restore.error)?.message}</p>}

      <RestoreModal
        item={restoreTarget}
        nodes={nodes.data ?? []}
        onClose={() => setRestoreTarget(null)}
        onRestore={(targetNode, name) => restore.mutate({ id: restoreTarget!.id, targetNode, name })}
        isPending={restore.isPending}
      />
      <AddJobModal
        repositories={repositories.data ?? []}
        nodes={nodes.data ?? []}
        onClose={() => setShowAddJob(false)}
        onAdd={onAddJob}
        isPending={createJob.isPending}
      />
    </div>
  );
}
