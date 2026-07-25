import { useState } from "react";
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

export default function BackupsPage() {
  const { isAdmin } = useVdmAuth();
  const queryClient = useQueryClient();
  const [jobForm, setJobForm] = useState({ name: "", repositoryId: "", resourceType: "vm", resourceName: "", sourceNode: "", intervalMinutes: "1440" });
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-tasks"] }),
  });
  const createJob = useMutation({
    mutationFn: () => api.post("/api/vdm/backup-jobs", { ...jobForm, repositoryId: Number(jobForm.repositoryId), intervalMinutes: Number(jobForm.intervalMinutes) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["vdm-backup-jobs"] }); setJobForm({ name: "", repositoryId: "", resourceType: "vm", resourceName: "", sourceNode: "", intervalMinutes: "1440" }); },
  });
  const deleteJob = useMutation({ mutationFn: (id: string) => api.delete(`/api/vdm/backup-jobs/${encodeURIComponent(id)}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-backup-jobs"] }) });
  const deleteBackup = useMutation({ mutationFn: (id: string) => api.delete(`/api/vdm/backups/${encodeURIComponent(id)}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-backups"] }) });

  const repositoryById = new Map((repositories.data ?? []).map((repository) => [repository.id, repository]));
  const onlineNodes = (nodes.data ?? []).filter((node) => node.status === "online");

  function startRestore(item: VdmBackupItem) {
    const defaultNode = onlineNodes.find((node) => node.name === item.sourceNode)?.name ?? onlineNodes[0]?.name;
    const targetNode = window.prompt(`Target node (${onlineNodes.map((node) => node.name).join(", ")})`, defaultNode);
    if (!targetNode) return;
    const name = window.prompt("Restored resource name", item.resourceName);
    if (!name) return;
    restore.mutate({ id: item.id, targetNode, name });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-vdm-text">Central Backups</h1>
        <p className="text-sm text-vdm-textMuted">Catalog, verification and cross-node restore</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(repositories.data ?? []).map((repository) => (
          <div key={repository.id} className="vdm-card p-3">
            <p className="font-medium text-vdm-text">{repository.displayName}</p>
            <p className="text-xs text-vdm-textMuted">{repository.storageName}</p>
            <p className="mt-2 text-xs text-vdm-textMuted">Retention {repository.retentionDaily}d / {repository.retentionWeekly}w / {repository.retentionMonthly}m</p>
          </div>
        ))}
      </div>

      {isAdmin && (
        <div className="vdm-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-vdm-text">Backup schedules</h2>
          <div className="grid gap-2 md:grid-cols-6">
            <input className="vdm-input" placeholder="Job name" value={jobForm.name} onChange={(event) => setJobForm({ ...jobForm, name: event.target.value })} />
            <select className="vdm-input" value={jobForm.repositoryId} onChange={(event) => setJobForm({ ...jobForm, repositoryId: event.target.value })}><option value="">Repository</option>{(repositories.data ?? []).map((repository) => <option key={repository.id} value={repository.id}>{repository.displayName}</option>)}</select>
            <select className="vdm-input" value={jobForm.sourceNode} onChange={(event) => setJobForm({ ...jobForm, sourceNode: event.target.value })}><option value="">Source node</option>{onlineNodes.map((node) => <option key={node.name} value={node.name}>{node.displayName}</option>)}</select>
            <select className="vdm-input" value={jobForm.resourceType} onChange={(event) => setJobForm({ ...jobForm, resourceType: event.target.value })}><option value="vm">VM</option><option value="lxc">LXC</option></select>
            <input className="vdm-input" placeholder="Resource name" value={jobForm.resourceName} onChange={(event) => setJobForm({ ...jobForm, resourceName: event.target.value })} />
            <div className="flex gap-2"><select className="vdm-input" value={jobForm.intervalMinutes} onChange={(event) => setJobForm({ ...jobForm, intervalMinutes: event.target.value })}><option value="60">Hourly</option><option value="1440">Daily</option><option value="10080">Weekly</option></select><button className="vdm-btn-primary" disabled={createJob.isPending} onClick={() => createJob.mutate()}>Add</button></div>
          </div>
          <div className="space-y-1">{(jobs.data ?? []).map((job) => <div key={job.id} className="flex items-center gap-3 rounded border border-vdm-border px-3 py-2 text-sm"><span className="font-medium flex-1">{job.name}</span><span className="text-vdm-textMuted">{job.resourceType.toUpperCase()} {job.resourceName} · {job.sourceNode}</span><span className="text-vdm-textMuted">next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</span><button className="vdm-btn-danger text-xs" onClick={() => deleteJob.mutate(job.id)}>Delete</button></div>)}</div>
        </div>
      )}

      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead><tr><th>Resource</th><th>Node</th><th>Repository</th><th>File</th><th>Size</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {(backups.data ?? []).map((item) => (
              <tr key={item.id}>
                <td><span className="pill-gray uppercase mr-2">{item.resourceType}</span>{item.resourceName}</td>
                <td>{item.sourceNode}</td>
                <td>{repositoryById.get(item.repositoryId)?.displayName ?? item.repositoryId}</td>
                <td className="font-mono text-xs max-w-64 truncate">{item.filename}</td>
                <td>{bytes(item.sizeBytes)}</td>
                <td><span className={item.status === "available" ? "pill-green" : "pill-red"}>{item.status}</span>{item.verifiedAt && <div className="text-[10px] text-vdm-textMuted">verified</div>}</td>
                <td className="text-xs whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</td>
                <td className="space-x-2 whitespace-nowrap">
                  {isAdmin && <button className="vdm-btn-ghost text-xs" onClick={() => verify.mutate(item.id)}>Verify</button>}
                  {isAdmin && item.status === "available" && <button className="vdm-btn-primary text-xs" onClick={() => startRestore(item)}>Restore</button>}
                  {isAdmin && <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete backup ${item.filename}?`)) deleteBackup.mutate(item.id); }}>Delete</button>}
                </td>
              </tr>
            ))}
            {!backups.isLoading && (backups.data ?? []).length === 0 && <tr><td colSpan={8} className="py-8 text-center text-vdm-textMuted">No centralized backups yet</td></tr>}
          </tbody>
        </table>
      </div>
      {(verify.error || restore.error) && <p className="text-sm text-vdm-danger">{(verify.error ?? restore.error)?.message}</p>}
    </div>
  );
}
