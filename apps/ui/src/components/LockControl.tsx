import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost } from "../api/client";

export type LockResourceType = "vm" | "lxc" | "docker";

interface LockEntry {
  resourceType: LockResourceType;
  resourceName: string;
  reason: string | null;
  lockedByUsername: string | null;
  createdAt: string;
}

function nameMatches(type: LockResourceType, lockName: string, name: string): boolean {
  if (type !== "docker") return lockName === name;
  // Docker ids may be short or long — match either way.
  return lockName === name || name.startsWith(lockName) || lockName.startsWith(name);
}

/**
 * Shared lock state for a VM/LXC/Docker resource. A locked resource is
 * priority/sensitive and is protected SERVER-SIDE against modification and
 * deletion; this hook only surfaces/toggles that state in the UI.
 */
export function useResourceLock(type: LockResourceType, name: string | undefined) {
  const qc = useQueryClient();
  const { data: locks = [] } = useQuery<LockEntry[]>({
    queryKey: ["locks"],
    queryFn: () => apiGet<LockEntry[]>("/api/locks"),
    staleTime: 10_000,
  });
  const entry = name ? locks.find((l) => l.resourceType === type && nameMatches(type, l.resourceName, name)) : undefined;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["locks"] });
  const lock = useMutation({
    mutationFn: (reason?: string) => apiPost(`/api/locks/${type}/${encodeURIComponent(name ?? "")}`, reason ? { reason } : {}),
    onSuccess: invalidate,
  });
  const unlock = useMutation({
    mutationFn: () => apiDelete(`/api/locks/${type}/${encodeURIComponent(name ?? "")}`),
    onSuccess: invalidate,
  });

  return { locked: !!entry, lockEntry: entry, lock, unlock, busy: lock.isPending || unlock.isPending };
}

function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {open ? (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-9 4h10a2 2 0 012 2v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5a2 2 0 012-2z" />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      )}
    </svg>
  );
}

/** Small "Verrouillé" badge shown next to a resource title when locked. */
export function LockBadge({ reason }: { reason?: string | null }) {
  return (
    <span
      title={reason || "Ressource prioritaire/sensible — modification et suppression bloquées"}
      className="inline-flex items-center gap-1 text-2xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded px-1.5 py-0.5"
    >
      <LockIcon /> Verrouillé
    </span>
  );
}

/** Lock / unlock toggle. Only render when the user may administer the resource. */
export function LockButton({ type, name }: { type: LockResourceType; name: string | undefined }) {
  const { locked, lockEntry, lock, unlock, busy } = useResourceLock(type, name);
  if (locked) {
    return (
      <button
        onClick={() => unlock.mutate()}
        disabled={busy}
        title={lockEntry?.reason || "Déverrouiller cette ressource"}
        className="btn-secondary btn-sm"
      >
        <LockIcon open /> Déverrouiller
      </button>
    );
  }
  return (
    <button
      onClick={() => lock.mutate(undefined)}
      disabled={busy}
      title="Marquer prioritaire/sensible et bloquer modification + suppression"
      className="btn-secondary btn-sm"
    >
      <LockIcon /> Verrouiller
    </button>
  );
}
