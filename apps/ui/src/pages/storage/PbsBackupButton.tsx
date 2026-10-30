import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../../api/client";
import { Modal } from "../../components/ui/Modal";
import { useAuth } from "../../utils/useAuth";

type Remote = { id: number; name: string; datastore: string };

/** "Back up to PBS" for one guest — admins only, hidden when no PBS is connected. */
export default function PbsBackupButton({ kind, name, className = "btn-secondary" }: {
  kind: "vm" | "lxc";
  name: string;
  className?: string;
}) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [remoteId, setRemoteId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: ["pbs", "remotes"],
    queryFn: () => apiGet("/api/pbs/remotes"),
    enabled: isAdmin,
  });

  const backup = useMutation({
    mutationFn: () => apiPost(`/api/pbs/remotes/${remoteId ?? remotes[0]?.id}/backup`, { resourceType: kind, name }),
    onSuccess: () => {
      setStarted(true);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!isAdmin || remotes.length === 0) return null;

  const close = () => {
    setOpen(false);
    setStarted(false);
    setError("");
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className={className}>Back up to PBS</button>
      <Modal
        open={open}
        onClose={close}
        title={`Back up ${name} to Proxmox Backup Server`}
        footer={started ? (
          <button onClick={close} className="btn-primary">Close</button>
        ) : (
          <>
            <button onClick={close} className="btn-secondary">Cancel</button>
            <button onClick={() => backup.mutate()} disabled={backup.isPending} className="btn-primary">
              {backup.isPending ? "Starting..." : "Back up"}
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          {started ? (
            <div className="text-sm text-green-400">Backup started. Follow its progress in the task panel.</div>
          ) : (
            <>
              <div>
                <label className="label">Destination</label>
                <select value={remoteId ?? remotes[0]?.id} onChange={(e) => setRemoteId(Number(e.target.value))} className="select">
                  {remotes.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
                </select>
              </div>
              <p className="text-xs text-text-500">
                {kind === "vm"
                  ? "A running VM keeps running: its disks are frozen on temporary overlays during the upload, then merged back."
                  : "A running container is archived live, like the local hot backup."}
                {" "}Only changed chunks are sent to the PBS after the first backup.
              </p>
            </>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>
      </Modal>
    </>
  );
}
