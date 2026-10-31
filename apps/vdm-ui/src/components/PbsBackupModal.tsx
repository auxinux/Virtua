import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Modal } from "@/components/ui/Dialogs";
import type { VdmPbsRemote, VdmTask } from "@/types/vdm";

export function BetaBadge() {
  return <span className="ml-2 align-middle pill-yellow">Beta</span>;
}

/** "Back up to PBS" for one VM / container on its node. */
export function PbsBackupModal({ open, onClose, kind, node, name, onStarted }: {
  open: boolean;
  onClose: () => void;
  kind: "vm" | "lxc";
  node: string;
  name: string;
  onStarted?: (task: VdmTask) => void;
}) {
  const qc = useQueryClient();
  const [remoteId, setRemoteId] = useState<number | null>(null);
  const remotes = useQuery<VdmPbsRemote[]>({ queryKey: ["vdm-pbs-remotes"], queryFn: () => api.get("/api/vdm/pbs/remotes"), enabled: open });
  useEffect(() => { if (open) setRemoteId(null); }, [open]);

  const list = remotes.data ?? [];
  const selected = remoteId ?? list[0]?.id ?? null;

  const backup = useMutation({
    mutationFn: () => api.post<VdmTask>(`/api/vdm/pbs/remotes/${selected}/backup`, { node, resourceType: kind, name }),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] });
      onClose();
      onStarted?.(task);
    },
  });

  if (!open) return null;
  return (
    <Modal open onClose={onClose} maxWidth="max-w-md">
      <h3 className="text-base font-semibold text-vdm-text">Back up {name} to Proxmox Backup Server<BetaBadge /></h3>
      <p className="text-xs text-vdm-textMuted">{kind === "vm" ? "VM" : "Container"} on node <span className="font-mono">{node}</span></p>
      {remotes.isLoading ? (
        <p className="text-sm text-vdm-textMuted">Loading PBS remotes…</p>
      ) : remotes.error ? (
        <p className="text-sm text-vdm-danger">{(remotes.error as Error).message}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-vdm-warning">No Proxmox Backup Server connected. Add one in Backups → Proxmox Backup Server.</p>
      ) : (
        <>
          <div>
            <label className="vdm-label">Destination</label>
            <select className="vdm-input" value={selected ?? ""} onChange={(e) => setRemoteId(Number(e.target.value))}>
              {list.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
            </select>
          </div>
          <p className="text-xs text-vdm-textMuted">
            {kind === "vm"
              ? "A running VM keeps running: its disks are frozen on temporary overlays during the upload, then merged back."
              : "A running container is archived live, like the local hot backup."}
            {" "}Only changed chunks are sent after the first backup. The node needs proxmox-backup-client.
          </p>
        </>
      )}
      {backup.error && <p className="text-sm text-vdm-danger">{(backup.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="vdm-btn-primary" disabled={!selected || backup.isPending} onClick={() => backup.mutate()}>
          {backup.isPending ? "Starting…" : "Back up"}
        </button>
      </div>
    </Modal>
  );
}
