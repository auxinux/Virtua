import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmTask } from "@/types/vdm";

interface TaskDrawerProps { open: boolean; onClose: () => void; }

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-bar flex-1">
      <div className="progress-fill transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "running") return <span className="w-2 h-2 rounded-full bg-vdm-accent animate-pulse flex-shrink-0" />;
  if (status === "done") return <span className="w-2 h-2 rounded-full bg-vdm-success flex-shrink-0" />;
  if (status === "failed") return <span className="w-2 h-2 rounded-full bg-vdm-danger flex-shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-vdm-textMuted flex-shrink-0" />;
}

export function TaskDrawer({ open, onClose }: TaskDrawerProps) {
  const tasksQuery = useQuery<VdmTask[]>({
    queryKey: ["vdm-tasks"],
    queryFn: () => api.get("/api/vdm/tasks"),
    enabled: open,
    refetchInterval: open ? 3_000 : false,
  });

  const tasks = tasksQuery.data ?? [];
  const running = tasks.filter((t) => t.status === "running" || t.status === "pending");
  const recent = tasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 10);

  return (
    <>
      {/* Backdrop */}
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />}
      {/* Drawer */}
      <div className={`fixed top-12 right-0 z-50 h-[calc(100vh-3rem)] w-80 bg-vdm-surface border-l border-vdm-border flex flex-col shadow-2xl transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-vdm-border">
          <span className="font-semibold text-vdm-text text-sm">Tasks</span>
          <button onClick={onClose} className="vdm-btn-ghost p-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-vdm-border/50">
          {/* Active */}
          {running.length > 0 && (
            <div>
              <p className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-vdm-accent">Active ({running.length})</p>
              {running.map((task) => (
                <div key={task.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <StatusDot status={task.status} />
                    <span className="text-sm font-medium text-vdm-text capitalize">{task.kind}</span>
                    <span className="text-xs text-vdm-textMuted ml-auto">{task.progress ?? 0}%</span>
                  </div>
                  <p className="text-xs text-vdm-textMuted pl-4">{task.resourceName}{task.targetNode ? ` → ${task.targetNode}` : ""}</p>
                  <div className="pl-4">
                    <ProgressBar value={task.progress ?? 0} />
                  </div>
                  {task.message && <p className="text-xs text-vdm-textMuted/70 pl-4 truncate">{task.message}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Recent */}
          {recent.length > 0 && (
            <div>
              <p className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Recent</p>
              {recent.map((task) => (
                <div key={task.id} className="px-4 py-3 flex items-start gap-2">
                  <StatusDot status={task.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-vdm-text capitalize">{task.kind} — {task.resourceName}</p>
                    {task.error && <p className="text-xs text-vdm-danger mt-0.5 truncate">{task.error}</p>}
                    {task.updatedAt && <p className="text-xs text-vdm-textMuted/70 mt-0.5">{new Date(task.updatedAt).toLocaleTimeString()}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tasks.length === 0 && !tasksQuery.isLoading && (
            <div className="p-8 text-center text-sm text-vdm-textMuted">No tasks yet</div>
          )}
        </div>
      </div>
    </>
  );
}
