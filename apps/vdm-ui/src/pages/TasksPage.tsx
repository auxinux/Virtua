import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import type { VdmTask } from "@/types/vdm";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "pill-gray", running: "pill-green", done: "pill-green",
    failed: "pill-red", cancelled: "pill-gray", "recovery-required": "pill-yellow", "completed-with-warning": "pill-yellow",
  };
  return <span className={map[status] ?? "pill-gray"}>{status}</span>;
}

function ProgressBar({ value }: { value: number }) {
  const color = value === 100 ? "bg-vdm-success" : "bg-vdm-accent";
  return (
    <div className="progress-bar w-24">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

// ── Task detail modal (opened on double-click) ─────────────────────────────
function TaskDetailModal({ task, onClose }: { task: VdmTask; onClose: () => void }) {
  const fields: Array<[string, string | null]> = [
    ["ID", task.id],
    ["Type", task.kind],
    ["Label", task.label],
    ["Status", task.status],
    ["Progress", `${task.progress}%`],
    ["Source node", task.sourceNode],
    ["Target node", task.targetNode],
    ["Resource type", task.resourceType],
    ["Resource", task.resourceName],
    ["Created by", task.createdBy],
    ["Created", task.createdAt ? new Date(task.createdAt).toLocaleString() : null],
    ["Updated", task.updatedAt ? new Date(task.updatedAt).toLocaleString() : null],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="vdm-card w-full max-w-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-vdm-text">Task detail</h3>
          <button className="vdm-btn-ghost" onClick={onClose}>Close</button>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={task.status} />
          <span className="text-sm text-vdm-text capitalize">{task.kind}</span>
          <span className="text-sm text-vdm-textMuted">— {task.resourceName}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {fields.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <span className="text-xs text-vdm-textMuted">{k}</span>
              <span className="text-sm text-vdm-text break-all">{v ?? "—"}</span>
            </div>
          ))}
        </div>
        {task.message && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted mb-1">Message</h4>
            <p className="text-sm text-vdm-text whitespace-pre-wrap">{task.message}</p>
          </div>
        )}
        {task.error && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-vdm-danger mb-1">Error</h4>
            <pre className="text-sm text-vdm-danger whitespace-pre-wrap break-all bg-vdm-bg rounded p-3 max-h-48 overflow-auto">{task.error}</pre>
          </div>
        )}
        {task.result !== undefined && task.result !== null && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted mb-1">Result</h4>
            <pre className="text-xs text-vdm-textMuted whitespace-pre-wrap break-all bg-vdm-bg rounded p-3 max-h-48 overflow-auto">{JSON.stringify(task.result, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TasksPage() {
  const { isAdmin } = useVdmAuth();
  const queryClient = useQueryClient();
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterKind, setFilterKind] = useState("all");
  const [selectedTask, setSelectedTask] = useState<VdmTask | null>(null);

  const tasksQuery = useQuery<VdmTask[]>({
    queryKey: ["vdm-tasks"],
    queryFn: () => api.get("/api/vdm/tasks"),
    refetchInterval: 5_000,
  });
  const resolveTask = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: "completed" | "failed" }) => api.post(`/api/vdm/tasks/${encodeURIComponent(id)}/resolve`, { resolution }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-tasks"] }),
  });

  const tasks = (tasksQuery.data ?? []).filter((t) => {
    if (filterStatus !== "all" && t.status !== filterStatus) return false;
    if (filterKind !== "all" && (t.kind as string) !== filterKind) return false;
    return true;
  });

  const kinds = [...new Set((tasksQuery.data ?? []).map((t) => t.kind as string))].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Tasks</h1>
          <p className="text-sm text-vdm-textMuted">{tasks.length} task{tasks.length !== 1 ? "s" : ""} · double-click a row for full details</p>
        </div>
        {tasksQuery.isFetching && (
          <div className="w-4 h-4 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <select className="vdm-input w-40" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="recovery-required">Recovery required</option>
        </select>
        <select className="vdm-input w-44" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
          <option value="all">All types</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>

      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead>
            <tr><th>ID</th><th>Type</th><th>Resource</th><th>Status</th><th>Progress</th><th>Started</th><th>Message</th></tr>
          </thead>
          <tbody>
            {tasksQuery.isLoading ? (
              <tr><td colSpan={7} className="text-center py-8"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></td></tr>
            ) : tasks.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-vdm-textMuted">No tasks found</td></tr>
            ) : tasks.map((task) => (
              <tr
                key={task.id}
                className="hover:bg-vdm-bg/40 transition-colors cursor-pointer"
                onClick={() => setSelectedTask(task)}
                onDoubleClick={() => setSelectedTask(task)}
              >
                <td className="font-mono text-xs text-vdm-textMuted">{task.id.slice(0, 8)}…</td>
                <td><span className="pill-gray capitalize">{task.kind}</span></td>
                <td className="text-sm">
                  <div className="font-medium text-vdm-text">{task.resourceName}</div>
                  {task.sourceNode && <div className="text-xs text-vdm-textMuted/70">{task.sourceNode}{task.targetNode ? ` → ${task.targetNode}` : ""}</div>}
                </td>
                <td><StatusBadge status={task.status} /></td>
                <td>
                  {task.status === "running" || task.status === "completed" ? (
                    <div className="flex items-center gap-2">
                      <ProgressBar value={task.progress ?? 0} />
                      <span className="text-xs text-vdm-textMuted">{task.progress ?? 0}%</span>
                    </div>
                  ) : "—"}
                </td>
                <td className="text-xs text-vdm-textMuted whitespace-nowrap">
                  {task.createdAt ? new Date(task.createdAt).toLocaleString() : "—"}
                </td>
                <td className="text-xs max-w-48 truncate">
                  {task.error ? (
                    <span className="text-vdm-danger">{task.error}</span>
                  ) : (
                    <span className="text-vdm-textMuted">{task.message ?? "—"}</span>
                  )}
                  {isAdmin && task.status === "recovery-required" && <div className="mt-1 flex gap-1"><button className="vdm-btn-ghost text-[10px]" onClick={(e) => { e.stopPropagation(); resolveTask.mutate({ id: task.id, resolution: "completed" }); }}>Mark completed</button><button className="vdm-btn-danger text-[10px]" onClick={(e) => { e.stopPropagation(); resolveTask.mutate({ id: task.id, resolution: "failed" }); }}>Mark failed</button></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedTask && <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />}
    </div>
  );
}
