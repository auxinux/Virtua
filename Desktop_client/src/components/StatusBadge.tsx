import type { ResourceState, VirtuaConnection, VirtuaNode, VirtuaTask } from "@/types";

type Status =
  | ResourceState
  | VirtuaNode["status"]
  | VirtuaTask["status"]
  | VirtuaConnection["status"];

const styles: Record<string, string> = {
  connected: "bg-virtua-green/15 text-virtua-green border-virtua-green/30",
  connecting: "bg-virtua-yellow/15 text-virtua-yellow border-virtua-yellow/30",
  online: "bg-virtua-green/15 text-virtua-green border-virtua-green/30",
  running: "bg-virtua-green/15 text-virtua-green border-virtua-green/30",
  completed: "bg-virtua-green/15 text-virtua-green border-virtua-green/30",
  queued: "bg-virtua-cyan/15 text-virtua-cyan border-virtua-cyan/30",
  paused: "bg-virtua-yellow/15 text-virtua-yellow border-virtua-yellow/30",
  maintenance: "bg-virtua-yellow/15 text-virtua-yellow border-virtua-yellow/30",
  stopped: "bg-virtua-muted/15 text-virtua-muted border-virtua-border",
  offline: "bg-virtua-red/15 text-virtua-red border-virtua-red/30",
  failed: "bg-virtua-red/15 text-virtua-red border-virtua-red/30",
  error: "bg-virtua-red/15 text-virtua-red border-virtua-red/30",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex h-6 items-center rounded border px-2 text-xs font-medium ${styles[status] ?? styles.offline}`}>
      {status}
    </span>
  );
}
