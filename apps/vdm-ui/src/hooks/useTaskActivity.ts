import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export interface VdmTaskActivity {
  count: number;
  lastFinishedAt: string | null;
}

/**
 * Query keys holding resource inventories. They must be refreshed whenever a
 * task finishes, because creation/deletion/migration are asynchronous: the API
 * answers 202 with a task and the resource only appears once that task reaches
 * a terminal state. Refreshing at submit time — as the create modal used to —
 * re-reads a list that cannot contain the new resource yet.
 *
 * Prefixes, so the per-node sidebar queries (`["vdm-vms", node]`) and the
 * detail queries (`["vdm-vm", node, name]`) are matched too.
 */
const RESOURCE_KEYS = [
  ["vdm-vms"], ["vdm-vm"],
  ["vdm-lxc"], ["vdm-docker"],
  ["vdm-vms-all"], ["vdm-lxc-all"], ["vdm-docker-all"],
  ["vdm-storage"], ["vdm-isos"], ["vdm-backups"],
  ["vdm-nodes"],
];

/**
 * Single poll of the task activity endpoint, shared by every consumer through
 * the query cache. Returns the current active-task count for the badge.
 */
export function useTaskActivity(): VdmTaskActivity {
  const qc = useQueryClient();
  const query = useQuery<VdmTaskActivity>({
    queryKey: ["vdm-tasks-active-count"],
    queryFn: () => api.get("/api/vdm/tasks/active-count"),
    refetchInterval: 5_000,
  });

  // `undefined` until the first response; seeding it with the first observed
  // value avoids a spurious invalidation burst on mount.
  const seen = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const last = query.data?.lastFinishedAt;
    if (last === undefined) return;
    if (seen.current === undefined) { seen.current = last; return; }
    if (seen.current === last) return;
    seen.current = last;
    for (const key of RESOURCE_KEYS) qc.invalidateQueries({ queryKey: key });
  }, [query.data?.lastFinishedAt, qc]);

  return { count: query.data?.count ?? 0, lastFinishedAt: query.data?.lastFinishedAt ?? null };
}
