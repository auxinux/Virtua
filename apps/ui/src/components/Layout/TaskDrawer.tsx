import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TaskProgress } from "@auxinux/shared";
import { apiGet } from "../../api/client";
import { Modal } from "../ui/Modal";
import { useAuth } from "../../utils/useAuth";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusClasses(status: TaskProgress["status"]) {
  switch (status) {
    case "running":
      return "bg-accent-blue/15 text-accent-blue-light border-accent-blue/30";
    case "completed":
      return "bg-state-running/10 text-state-running border-state-running/30";
    case "failed":
      return "bg-state-stopped/10 text-state-stopped border-state-stopped/30";
    default:
      return "bg-surface-700 text-text-300 border-surface-500";
  }
}

function statusLabel(t: (key: string, options?: Record<string, unknown>) => string, status: TaskProgress["status"]) {
  if (status === "completed") return t("tasks.statusCompleted");
  if (status === "failed") return t("tasks.statusFailed");
  if (status === "running") return t("tasks.statusRunning");
  return t("tasks.statusPending");
}

function invalidateTaskQueries(qc: ReturnType<typeof useQueryClient>, task: TaskProgress) {
  qc.invalidateQueries({ queryKey: ["backups"] });
  if (!task.resourceName) return;
  if (task.action === "vm.snapshot.create" || task.action === "vm.snapshot.delete" || task.action === "vm.snapshot.rollback") {
    qc.invalidateQueries({ queryKey: ["vm", task.resourceName, "snapshots"] });
    qc.invalidateQueries({ queryKey: ["vm", task.resourceName] });
    return;
  }
  if (task.action === "vm.backup.create" || task.action === "vm.backup.restore" || task.action === "backup.delete" || task.action === "backup.upload") {
    qc.invalidateQueries({ queryKey: ["vm", task.resourceName, "backups"] });
    qc.invalidateQueries({ queryKey: ["vm", task.resourceName] });
    return;
  }
  if (task.action === "lxc.snapshot.create" || task.action === "lxc.snapshot.delete" || task.action === "lxc.snapshot.rollback") {
    qc.invalidateQueries({ queryKey: ["lxc", task.resourceName, "snapshots"] });
    qc.invalidateQueries({ queryKey: ["lxc", task.resourceName] });
    return;
  }
  if (task.action === "lxc.backup.create" || task.action === "lxc.backup.restore" || task.action === "backup.delete" || task.action === "backup.upload") {
    qc.invalidateQueries({ queryKey: ["lxc", task.resourceName, "backups"] });
    qc.invalidateQueries({ queryKey: ["lxc", task.resourceName] });
  }
}

export function TaskDrawer() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();

  const [open, setOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskProgress | null>(null);
  // mine=true → only my tasks; mine=false → all tasks (admin only)
  const [mineOnly, setMineOnly] = useState(true);
  const seenStatusesRef = useRef<Map<string, TaskProgress["status"]>>(new Map());

  // Only show tasks created after the current login
  const tasksSince = sessionStorage.getItem("tasksSince") ?? undefined;

  const buildQuery = () => {
    const params = new URLSearchParams({ limit: "100" });
    if (tasksSince) params.set("since", tasksSince);
    if (!mineOnly) params.set("mine", "false");
    else params.set("mine", "true");
    return `/api/tasks?${params.toString()}`;
  };

  const { data: tasks = [] } = useQuery<TaskProgress[]>({
    queryKey: ["tasks", "list", mineOnly, tasksSince],
    queryFn: () => apiGet<TaskProgress[]>(buildQuery()),
    refetchInterval: 2_000,
  });

  const { data: selectedTaskLive } = useQuery<TaskProgress>({
    queryKey: ["tasks", selectedTask?.id],
    queryFn: () => apiGet<TaskProgress>(`/api/tasks/${selectedTask?.id}`),
    enabled: !!selectedTask?.id,
    refetchInterval: selectedTask?.status === "running" || selectedTask?.status === "pending" ? 1_000 : 2_000,
  });

  useEffect(() => {
    if (selectedTaskLive) {
      setSelectedTask(selectedTaskLive);
    }
  }, [selectedTaskLive]);

  const activeCount = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "running").length,
    [tasks]
  );

  useEffect(() => {
    for (const task of tasks) {
      const previousStatus = seenStatusesRef.current.get(task.id);
      if (task.status === "completed" && previousStatus !== "completed") {
        invalidateTaskQueries(qc, task);
      }
      seenStatusesRef.current.set(task.id, task.status);
    }
  }, [qc, tasks]);

  return (
    <>
      <div className="border-t border-surface-600 bg-surface-900/95 backdrop-blur-sm flex-shrink-0">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-surface-800 transition-colors"
        >
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-accent-blue/15 text-accent-blue-light">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-100">{t("tasks.title")}</div>
            <div className="text-2xs text-text-500">
              {activeCount > 0 ? t("tasks.runningCount", { count: activeCount }) : t("tasks.idle")}
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-2xs bg-surface-700 text-text-300 border border-surface-500">
            {tasks.length}
          </span>
          <svg
            className={`w-4 h-4 text-text-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {open && (
          <div className="border-t border-surface-600">
            <div className="flex items-center justify-between px-4 py-1.5 border-b border-surface-600 bg-surface-800/50">
              <div className="grid flex-1 grid-cols-[minmax(8rem,0.8fr)_minmax(7rem,0.8fr)_minmax(11rem,1fr)_minmax(16rem,1.4fr)_minmax(7rem,0.6fr)] gap-3 text-2xs uppercase tracking-wider text-text-500">
                <div>{t("tasks.id")}</div>
                <div>{t("tasks.initiatedBy")}</div>
                <div>{t("tasks.action")}</div>
                <div>{t("tasks.activity")}</div>
                <div>{t("tasks.status")}</div>
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setMineOnly((v) => !v)}
                  className="ml-3 flex-shrink-0 px-2 py-0.5 rounded text-2xs border border-surface-500 hover:bg-surface-700 text-text-400 transition-colors"
                >
                  {mineOnly ? t("tasks.filterAll") : t("tasks.filterMine")}
                </button>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto">
              {tasks.length === 0 ? (
                <div className="px-4 py-6 text-sm text-text-500">{t("tasks.empty")}</div>
              ) : (
                tasks.map((task) => {
                  const activity = task.message || task.error || task.detail || t("task.waiting");
                  const progressValue = Math.max(0, Math.min(100, Math.round(task.progressPercent)));
                  const progress = task.status === "running" || task.status === "completed" ? `${progressValue}%` : null;

                  return (
                    <button
                      key={task.id}
                      type="button"
                      onDoubleClick={() => setSelectedTask(task)}
                      className="w-full text-left grid grid-cols-[minmax(8rem,0.8fr)_minmax(7rem,0.8fr)_minmax(11rem,1fr)_minmax(16rem,1.4fr)_minmax(7rem,0.6fr)] gap-3 px-4 py-3 border-b border-surface-700/70 text-xs hover:bg-surface-800/70 transition-colors"
                    >
                      <div className="text-text-300 font-mono truncate" title={task.id}>
                        {task.id.slice(0, 8)}
                      </div>
                      <div className="text-text-300 truncate" title={task.ownerUsername ?? "-"}>
                        {task.ownerUsername ?? "-"}
                      </div>
                      <div className="text-text-200 truncate" title={task.label}>
                        {task.label}
                      </div>
                      <div className="min-w-0">
                        <div className="text-text-300 truncate" title={activity}>
                          {activity}
                        </div>
                        {progress && (
                          <div className="mt-2">
                            <div className="h-1.5 rounded bg-surface-700 overflow-hidden">
                              <div
                                className={`h-full transition-all ${
                                  task.status === "completed"
                                    ? "bg-state-running"
                                    : task.status === "failed"
                                      ? "bg-state-stopped"
                                      : "bg-accent-blue"
                                }`}
                                style={{ width: progress }}
                              />
                            </div>
                            <div className="mt-1 text-2xs text-text-500">{progress}</div>
                          </div>
                        )}
                      </div>
                      <div>
                        <span className={`inline-flex px-2 py-1 rounded border text-2xs font-medium ${statusClasses(task.status)}`}>
                          {statusLabel(t, task.status)}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        title={selectedTask?.label ?? t("tasks.title")}
        size="lg"
        footer={<button onClick={() => setSelectedTask(null)} className="btn-secondary">{t("tasks.close")}</button>}
      >
        {selectedTask && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-text-500">{t("tasks.id")}</div>
                <div className="font-mono text-text-200 break-all">{selectedTask.id}</div>
              </div>
              <div>
                <div className="text-text-500">{t("tasks.status")}</div>
                <div className="text-text-200">{statusLabel(t, selectedTask.status)}</div>
              </div>
              <div>
                <div className="text-text-500">{t("tasks.initiatedBy")}</div>
                <div className="text-text-200">{selectedTask.ownerUsername ?? "-"}</div>
              </div>
              <div>
                <div className="text-text-500">{t("tasks.action")}</div>
                <div className="text-text-200">{selectedTask.action ?? selectedTask.label}</div>
              </div>
              <div>
                <div className="text-text-500">{t("tasks.createdAt")}</div>
                <div className="text-text-200">{new Date(selectedTask.createdAt).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-text-500">{t("tasks.updatedAt")}</div>
                <div className="text-text-200">{new Date(selectedTask.updatedAt).toLocaleString()}</div>
              </div>
            </div>

            {(selectedTask.bytesTotal || selectedTask.progressPercent > 0) && (
              <div>
                <div className="text-text-500 mb-1">{t("tasks.progress")}</div>
                <div className="rounded border border-surface-500 bg-surface-800 px-3 py-3">
                  <div className="relative h-7 rounded bg-surface-700 overflow-hidden border border-surface-500">
                    <div
                      className={`absolute inset-y-0 left-0 transition-all ${
                        selectedTask.status === "completed"
                          ? "bg-state-running/80"
                          : selectedTask.status === "failed"
                            ? "bg-state-stopped/80"
                            : "bg-accent-blue/80"
                      }`}
                      style={{ width: `${Math.max(0, Math.min(100, Math.round(selectedTask.progressPercent)))}%` }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-text-100">
                      {Math.max(0, Math.min(100, Math.round(selectedTask.progressPercent)))}%
                    </div>
                  </div>
                  {selectedTask.bytesTotal ? (
                    <div className="mt-2 text-2xs text-text-500 text-center">
                      {formatBytes(selectedTask.bytesCurrent ?? 0)} / {formatBytes(selectedTask.bytesTotal)}
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            <div>
              <div className="text-text-500 mb-1">{t("tasks.activity")}</div>
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2 text-text-200 max-h-48 overflow-y-auto">
                <div className="space-y-2 text-xs">
                  {(selectedTask.activityLog && selectedTask.activityLog.length > 0
                    ? selectedTask.activityLog
                    : [selectedTask.error || selectedTask.detail || selectedTask.message || t("task.waiting")]
                  ).map((entry, index) => (
                    <div key={`${index}-${entry}`} className="whitespace-pre-wrap break-all border-b border-surface-700/60 pb-2 last:border-b-0 last:pb-0">
                      {entry}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
