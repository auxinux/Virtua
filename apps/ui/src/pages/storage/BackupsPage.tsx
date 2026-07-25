import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiUpload } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { formatBytes, formatDate } from "../../utils/formatBytes";

type BackupEntry = {
  id: string;
  nodeName?: string;
  resourceType: "vm" | "lxc";
  resourceName: string;
  filename: string;
  storagePool: string;
  sizeBytes: number;
  format: string;
  createdBy: number | null;
  createdAt: string;
};

type StoragePool = { name: string };

export default function BackupsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "vm" | "lxc">("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupEntry | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);

  const { data: backups = [] } = useQuery<BackupEntry[]>({
    queryKey: ["backups"],
    queryFn: () => apiGet<BackupEntry[]>("/api/backups"),
    refetchInterval: 10_000,
  });

  const { data: pools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools"],
    queryFn: () => apiGet<StoragePool[]>("/api/storage/pools"),
  });

  const filtered = useMemo(() => (
    filter === "all" ? backups : backups.filter((entry) => entry.resourceType === filter)
  ), [backups, filter]);

  const deleteBackup = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/backups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups"] });
      setDeleteTarget(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-100">Backups</h1>
          <p className="text-sm text-text-400">Central library for VM and LXC backups.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | "vm" | "lxc")} className="select w-36">
            <option value="all">All types</option>
            <option value="vm">VM only</option>
            <option value="lxc">LXC only</option>
          </select>
          <button onClick={() => setUploadOpen(true)} className="btn-primary">Upload Backup</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-600/50">
            <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Resource</th>
              <th className="px-4 py-2">Filename</th>
              <th className="px-4 py-2">Pool</th>
              <th className="px-4 py-2">Size</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-600">
            {filtered.map((backup) => (
              <tr key={backup.id} className="hover:bg-surface-600/20">
                <td className="px-4 py-2">
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${backup.resourceType === "vm" ? "bg-accent-blue/20 text-accent-blue-light" : "bg-green-500/15 text-green-400"}`}>
                    {backup.resourceType.toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-2 text-text-300">{backup.resourceName}</td>
                <td className="px-4 py-2 font-mono text-xs text-text-200">{backup.filename}</td>
                <td className="px-4 py-2 text-text-400">{backup.storagePool}</td>
                <td className="px-4 py-2 text-text-400">{formatBytes(backup.sizeBytes)}</td>
                <td className="px-4 py-2 text-text-400">{formatDate(backup.createdAt)}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setRestoreTarget(backup)} className="btn-secondary btn-sm">Restore</button>
                    <button onClick={() => setDeleteTarget(backup)} className="btn-danger btn-sm">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-text-500">No backups found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <UploadBackupModal
        open={uploadOpen}
        pools={pools}
        onClose={() => setUploadOpen(false)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["backups"] });
          setUploadOpen(false);
        }}
      />

      <RestoreBackupModal
        backup={restoreTarget}
        pools={pools}
        onClose={() => setRestoreTarget(null)}
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteBackup.mutate(deleteTarget.id)}
        loading={deleteBackup.isPending}
        dangerous
        title={t("modal.deleteBackup")}
        message={deleteTarget ? `Delete backup ${deleteTarget.filename}?` : ""}
        confirmLabel="Delete"
      />
    </div>
  );
}

function UploadBackupModal({
  open,
  pools,
  onClose,
  onDone,
}: {
  open: boolean;
  pools: StoragePool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [storagePool, setStoragePool] = useState("");
  const [resourceType, setResourceType] = useState<"vm" | "lxc">("vm");
  const [resourceName, setResourceName] = useState("");
  const [format, setFormat] = useState<"qcow2" | "tar.gz">("qcow2");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);

  React.useEffect(() => {
    if (!storagePool && pools[0]) setStoragePool(pools[0].name);
  }, [storagePool, pools]);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Backup file is required");
      const form = new FormData();
      form.append("file", file);
      form.append("storagePool", storagePool);
      form.append("resourceType", resourceType);
      form.append("resourceName", resourceName || file.name.replace(/\.(tar\.gz|qcow2|img|raw)$/i, ""));
      form.append("format", format);
      return apiUpload("/api/backups/upload", form, ({ percent }) => setProgress(percent));
    },
    onSuccess: () => {
      setFile(null);
      setResourceName("");
      setProgress(0);
      setError("");
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("modal.uploadBackup")}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => upload.mutate()} disabled={upload.isPending || !storagePool || !file} className="btn-primary">
            {upload.isPending ? "Uploading..." : "Upload"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Type</label>
          <select value={resourceType} onChange={(e) => setResourceType(e.target.value as "vm" | "lxc")} className="select">
            <option value="vm">VM</option>
            <option value="lxc">LXC</option>
          </select>
        </div>
        <div>
          <label className="label">Storage Pool</label>
          <select value={storagePool} onChange={(e) => setStoragePool(e.target.value)} className="select">
            <option value="">Select pool...</option>
            {pools.map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Resource Name</label>
          <input value={resourceName} onChange={(e) => setResourceName(e.target.value)} className="input" placeholder="Recovered-VM or recovered-lxc" />
        </div>
        <div>
          <label className="label">Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as "qcow2" | "tar.gz")} className="select">
            <option value="qcow2">qcow2 / raw disk image</option>
            <option value="tar.gz">tar.gz archive</option>
          </select>
        </div>
        <div>
          <label className="label">File</label>
          <input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {(upload.isPending || progress > 0) && (
          <div className="text-xs text-text-400">Upload progress: {progress}%</div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>
    </Modal>
  );
}

function RestoreBackupModal({
  backup,
  pools,
  onClose,
}: {
  backup: BackupEntry | null;
  pools: StoragePool[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // "asIs" = restore identical (keep original CPU/RAM); "modify" = change name + resources.
  // qcow2 VM backups carry no stored config, so they always go through "modify".
  const [mode, setMode] = useState<"asIs" | "modify">("asIs");
  const [name, setName] = useState("");
  const [storagePool, setStoragePool] = useState("");
  const [bridge, setBridge] = useState("");
  const [mac, setMac] = useState("");
  const [cpus, setCpus] = useState(2);
  const [memoryMb, setMemoryMb] = useState(2048);
  const [autostart, setAutostart] = useState(false);
  const [error, setError] = useState("");

  const forcesModify = backup?.resourceType === "vm" && backup?.format === "qcow2";
  const effectiveMode = forcesModify ? "modify" : mode;

  React.useEffect(() => {
    if (!backup) return;
    setMode("asIs");
    setName(`${backup.resourceName}-restore`);
    setStoragePool(backup.storagePool);
    setBridge(backup.resourceType === "vm" ? "virbr0" : "lxcbr0");
    setMac("");
    setCpus(2);
    setMemoryMb(2048);
    setAutostart(false);
    setError("");
  }, [backup]);

  const restore = useMutation({
    mutationFn: () => {
      if (!backup) throw new Error("No backup selected");
      // Only send CPU/RAM when modifying; otherwise the backend preserves the
      // original resources from the backup definition.
      const resources = effectiveMode === "modify"
        ? (backup.resourceType === "vm" ? { vcpus: cpus, memoryMb } : { cpuCores: cpus, memoryMb })
        : {};
      return apiPost(`/api/backups/${backup.id}/restore`, backup.resourceType === "vm"
        ? { name, storagePool, bridge, mac, autostart, ...resources }
        : { name, bridge, macAddress: mac, autostart, ...resources });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open={!!backup}
      onClose={onClose}
      title={backup ? `Restore ${backup.resourceType.toUpperCase()} Backup` : "Restore Backup"}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => restore.mutate()} disabled={restore.isPending || !name} className="btn-primary">
            {restore.isPending ? "Starting..." : "Restore"}
          </button>
        </>
      }
    >
      {backup && (
        <div className="space-y-3">
          <div className="text-xs text-text-500 font-mono">{backup.filename}</div>

          {!forcesModify && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("asIs")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  effectiveMode === "asIs"
                    ? "border-accent-blue bg-accent-blue/10 text-text-100"
                    : "border-surface-600 text-text-400 hover:text-text-200"
                }`}
              >
                Restaurer tel quel
              </button>
              <button
                type="button"
                onClick={() => setMode("modify")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  effectiveMode === "modify"
                    ? "border-accent-blue bg-accent-blue/10 text-text-100"
                    : "border-surface-600 text-text-400 hover:text-text-200"
                }`}
              >
                Modifier (nom + CPU/RAM)
              </button>
            </div>
          )}

          <div>
            <label className="label">New Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>
          {backup.resourceType === "vm" && (
            <>
              <div>
                <label className="label">Storage Pool</label>
                <select value={storagePool} onChange={(e) => setStoragePool(e.target.value)} className="select">
                  <option value="">Select pool...</option>
                  {pools.map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Bridge</label>
                  <input value={bridge} onChange={(e) => setBridge(e.target.value)} className="input" placeholder="virbr0" />
                </div>
                <div>
                  <label className="label">MAC (optional)</label>
                  <input value={mac} onChange={(e) => setMac(e.target.value)} className="input" placeholder="aa:bb:cc:dd:ee:ff" />
                </div>
              </div>
            </>
          )}
          {backup.resourceType === "lxc" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Bridge</label>
                <input value={bridge} onChange={(e) => setBridge(e.target.value)} className="input" placeholder="lxcbr0" />
              </div>
              <div>
                <label className="label">MAC (optional)</label>
                <input value={mac} onChange={(e) => setMac(e.target.value)} className="input" placeholder="aa:bb:cc:dd:ee:ff" />
              </div>
            </div>
          )}
          {effectiveMode === "modify" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{backup.resourceType === "vm" ? "vCPUs" : "CPU cores"}</label>
                <input type="number" min={1} value={cpus} onChange={(e) => setCpus(parseInt(e.target.value, 10) || 1)} className="input" />
              </div>
              <div>
                <label className="label">Memory (MiB)</label>
                <input type="number" min={128} step={128} value={memoryMb} onChange={(e) => setMemoryMb(parseInt(e.target.value, 10) || 512)} className="input" />
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
            <span className="text-sm text-text-300">Autostart after restore</span>
          </label>
          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
