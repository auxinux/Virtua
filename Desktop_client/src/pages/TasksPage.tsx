import { CheckCircle2, Clock, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import type { VirtuaTask } from "@/types";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

export function TasksPage({ tasks, onClear, onChanged }: { tasks: VirtuaTask[]; onClear?: () => void; onChanged?: () => void }) {
  const clearTasks = () => {
    onClear?.();
    onChanged?.();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Taches</h1>
          <p className="mt-1 text-sm text-virtua-muted">Historique local des operations lancees par ce client.</p>
        </div>
        <button disabled={tasks.length === 0} onClick={clearTasks} className="virtua-button">
          <Trash2 className="mr-2 h-4 w-4" />
          Vider
        </button>
      </div>

      <div className="overflow-hidden rounded border border-virtua-border bg-virtua-panel">
        {tasks.length === 0 ? (
          <div className="grid min-h-[22rem] place-items-center px-4 py-10 text-center">
            <div>
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded border border-virtua-border bg-black/20 text-virtua-muted">
                <Clock className="h-5 w-5" />
              </div>
              <p className="font-medium">Aucune operation</p>
              <p className="mt-1 text-sm text-virtua-muted">Les actions console, power, snapshot, creation, edition et suppression apparaitront ici.</p>
            </div>
          </div>
        ) : tasks.map((task) => (
          <div key={task.id} className="border-b border-virtua-border px-4 py-4 last:border-b-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className={`h-4 w-4 ${task.status === "completed" ? "text-virtua-green" : "text-virtua-muted"}`} />
                  <p className="font-medium">{task.label}</p>
                </div>
                <p className="mt-1 text-xs text-virtua-muted">{formatDate(task.createdAt)} / {task.target}</p>
              </div>
              <StatusBadge status={task.status} />
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded bg-black/25">
              <div className="h-full rounded bg-virtua-accent" style={{ width: `${task.progress}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
