import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { ScopeNotice } from "../../components/ui/ScopeNotice";
import { formatBytes } from "../../utils/formatBytes";
import type { MountedFilesystem, PhysicalDisk, RaidArray, StoragePool } from "@auxinux/shared";

type RaidLevel = 0 | 1 | 5 | 10;

// ─── Disk Section ──────────────────────────────────────────────────────────────
/**
 * Destructive disk action (format / wipe). The API has exposed these since the
 * beginning, but nothing in the UI could reach them — so a fresh disk could be
 * seen and never prepared.
 *
 * Guarded by a confirmation that requires typing the device path: these erase
 * a whole device or partition and there is no undo.
 */
function DiskActionModal({ target, action, onClose, onDone }: {
  target: { path: string; size: number; fstype?: string } | null;
  action: "format" | "wipe";
  onClose: () => void;
  onDone: () => void;
}) {
  const [fstype, setFstype] = useState<"ext4" | "xfs" | "btrfs">("ext4");
  const [label, setLabel] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  const device = target?.path ?? "";
  // /dev/sda1 → sda1, the path segment the API expects.
  const deviceName = device.replace(/^\/dev\//, "");

  const run = useMutation({
    mutationFn: () => action === "format"
      ? apiPost(`/api/storage/disks/${encodeURIComponent(deviceName)}/format`, { fstype, label: label.trim() || undefined, force: true })
      : apiPost(`/api/storage/disks/${encodeURIComponent(deviceName)}/wipe`, {}),
    onSuccess: () => { onDone(); onClose(); setTyped(""); setLabel(""); setError(""); },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={!!target} title={action === "format" ? `Format ${device}` : `Wipe ${device}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          This erases everything on <span className="font-mono">{device}</span> ({formatBytes(target?.size ?? 0)}
          {target?.fstype ? `, currently ${target.fstype}` : ", no filesystem detected"}). There is no undo.
        </div>
        {action === "format" && (
          <>
            <div>
              <label className="label">Filesystem *</label>
              <div className="grid grid-cols-3 gap-2">
                {(["ext4", "xfs", "btrfs"] as const).map((fs) => (
                  <button key={fs} type="button" onClick={() => setFstype(fs)}
                    className={`px-3 py-2 rounded text-sm border transition-colors ${
                      fstype === fs
                        ? "bg-accent-blue/20 text-accent-blue border-accent-blue/50"
                        : "bg-surface-700 text-text-300 border-surface-500 hover:bg-surface-600"
                    }`}>{fs}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Label (optional)</label>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="hdd-storage" />
            </div>
          </>
        )}
        <div>
          <label className="label">Type <span className="font-mono">{device}</span> to confirm</label>
          <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={device} />
        </div>
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" disabled={typed !== device || run.isPending} onClick={() => { setError(""); run.mutate(); }}>
            {run.isPending ? "Working…" : action === "format" ? "Format" : "Wipe"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface PartitionDraft { id: number; sizeGb: string; label: string }

/**
 * Write a new partition table on a whole disk. Replaces the existing table, so
 * every partition on the device is lost — same confirmation discipline as
 * format/wipe.
 */
function PartitionModal({ disk, onClose, onDone }: {
  disk: PhysicalDisk | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [table, setTable] = useState<"gpt" | "msdos">("gpt");
  const [rows, setRows] = useState<PartitionDraft[]>([{ id: 1, sizeGb: "", label: "" }]);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const device = disk?.path ?? "";
  const deviceName = device.replace(/^\/dev\//, "");

  const run = useMutation({
    mutationFn: () => apiPost(`/api/storage/disks/${encodeURIComponent(deviceName)}/partition`, {
      table,
      partitions: rows.map((row) => ({
        // An empty size means "take the remaining space".
        sizeMb: row.sizeGb.trim() ? Math.round(parseFloat(row.sizeGb) * 1024) : undefined,
        label: row.label.trim() || undefined,
      })),
    }),
    onSuccess: () => { onDone(); onClose(); setRows([{ id: 1, sizeGb: "", label: "" }]); setTyped(""); setError(""); },
    onError: (err: Error) => setError(err.message),
  });

  const update = (id: number, patch: Partial<PartitionDraft>) =>
    setRows((prev) => prev.map((row) => row.id === id ? { ...row, ...patch } : row));

  // Only the last partition may take the remaining space — mirror the server rule.
  const emptySizes = rows.filter((row) => !row.sizeGb.trim());
  const planInvalid = emptySizes.length > 1
    || (emptySizes.length === 1 && rows[rows.length - 1].sizeGb.trim() !== "")
    || rows.some((row) => row.sizeGb.trim() !== "" && !(parseFloat(row.sizeGb) > 0));

  return (
    <Modal open={!!disk} title={`Partition ${device}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          This writes a new partition table on <span className="font-mono">{device}</span> ({formatBytes(disk?.size ?? 0)}).
          Every existing partition and all data on the disk are lost.
        </div>
        <div>
          <label className="label">Partition table *</label>
          <div className="grid grid-cols-2 gap-2">
            {([["gpt", "GPT (recommended)"], ["msdos", "MBR / msdos"]] as const).map(([value, text]) => (
              <button key={value} type="button" onClick={() => setTable(value)}
                className={`px-3 py-2 rounded text-sm border transition-colors ${
                  table === value
                    ? "bg-accent-blue/20 text-accent-blue border-accent-blue/50"
                    : "bg-surface-700 text-text-300 border-surface-500 hover:bg-surface-600"
                }`}>{text}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Partitions *</label>
          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={row.id} className="flex items-center gap-2">
                <span className="text-xs text-text-500 w-6">{index + 1}</span>
                <input className="input flex-1" value={row.sizeGb} onChange={(e) => update(row.id, { sizeGb: e.target.value })}
                  placeholder={index === rows.length - 1 ? "Size in GB — empty = remaining space" : "Size in GB"} />
                <input className="input w-32" value={row.label} onChange={(e) => update(row.id, { label: e.target.value })} placeholder="label" />
                <button className="btn-ghost text-xs" disabled={rows.length === 1}
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}>Remove</button>
              </div>
            ))}
          </div>
          <button className="btn-ghost text-xs mt-2"
            onClick={() => setRows((prev) => [...prev, { id: Math.max(0, ...prev.map((r) => r.id)) + 1, sizeGb: "", label: "" }])}>
            + Add partition
          </button>
          <p className="text-xs text-text-500 mt-1">
            Leave the last size empty to use all remaining space. Partitions are aligned automatically.
          </p>
        </div>
        <div>
          <label className="label">Type <span className="font-mono">{device}</span> to confirm</label>
          <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={device} />
        </div>
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" disabled={typed !== device || planInvalid || run.isPending}
            onClick={() => { setError(""); run.mutate(); }}>
            {run.isPending ? "Partitioning…" : "Write partition table"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DiskCard({ disk, onChanged }: { disk: PhysicalDisk; onChanged: () => void }) {
  const stateColor = disk.inUse ? "text-yellow-400" : "text-green-400";
  const [target, setTarget] = useState<{ path: string; size: number; fstype?: string } | null>(null);
  const [action, setAction] = useState<"format" | "wipe">("format");
  const [partitioning, setPartitioning] = useState(false);
  const openAction = (next: "format" | "wipe", t: { path: string; size: number; fstype?: string }) => {
    setAction(next);
    setTarget(t);
  };
  // A device backing a RAID array or already mounted must not be touched.
  const diskLocked = disk.inUse || !!disk.inRaid;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-mono text-text-200 font-medium">{disk.name}</div>
          <div className="text-xs text-text-500 mt-0.5">{disk.path}</div>
        </div>
        <span className={`text-xs font-medium ${stateColor}`}>
          {disk.inRaid ? "RAID" : disk.inUse ? "Used" : "Free"}
        </span>
      </div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-text-500">Size</span>
          <span className="font-mono text-text-200">{formatBytes(disk.size)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-500">Model</span>
          <span className="text-text-300 truncate max-w-[60%]">{disk.model || "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-500">Type</span>
          <span className="text-text-300 uppercase">{disk.type || "—"}</span>
        </div>
      </div>
      {disk.partitions?.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-600">
          <div className="text-xs text-text-500 mb-1">Partitions</div>
          <div className="space-y-1">
            {disk.partitions.map((p) => (
              <div key={p.name} className="flex items-center justify-between text-xs gap-2">
                <span className="font-mono text-text-300">{p.name}</span>
                <span className="text-text-400">{p.fstype || "unformatted"}</span>
                <span className="text-text-400">{formatBytes(p.size)}</span>
                {p.mountpoint ? (
                  <span className="text-text-500 font-mono truncate max-w-[6rem]" title={`mounted on ${p.mountpoint}`}>{p.mountpoint}</span>
                ) : (
                  <button className="text-accent-blue hover:underline"
                    onClick={() => openAction("format", { path: p.path, size: p.size, fstype: p.fstype })}>
                    Format
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-surface-600 flex items-center gap-2">
        <button
          className="btn-ghost text-xs disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={diskLocked}
          title={diskLocked ? "Disk is mounted or part of a RAID array" : undefined}
          onClick={() => openAction("format", { path: disk.path, size: disk.size })}
        >
          Format whole disk
        </button>
        <button
          className="btn-ghost text-xs disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={diskLocked}
          title={diskLocked ? "Disk is mounted or part of a RAID array" : undefined}
          onClick={() => setPartitioning(true)}
        >
          Partition
        </button>
        <button
          className="btn-ghost text-xs text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={diskLocked}
          title={diskLocked ? "Disk is mounted or part of a RAID array" : undefined}
          onClick={() => openAction("wipe", { path: disk.path, size: disk.size })}
        >
          Wipe
        </button>
      </div>
      {diskLocked && (
        <p className="text-xs text-text-500 mt-1">
          {disk.inRaid ? `Member of ${disk.inRaid}` : "In use — unmount it first"}
        </p>
      )}

      <DiskActionModal target={target} action={action} onClose={() => setTarget(null)} onDone={onChanged} />
      <PartitionModal disk={partitioning ? disk : null} onClose={() => setPartitioning(false)} onDone={onChanged} />
    </div>
  );
}

// ─── RAID Section ──────────────────────────────────────────────────────────────
function RaidStateColor(state: string) {
  if (state === "active") return "text-green-400";
  if (state === "degraded") return "text-red-400";
  if (state === "rebuilding") return "text-yellow-400";
  return "text-text-400";
}

function RaidCard({ array, onDelete }: { array: RaidArray; onDelete: () => void }) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-mono text-text-200 font-medium">{array.device}</div>
          <div className="text-xs text-text-500">RAID {array.level}</div>
        </div>
        <span className={`text-xs font-medium ${RaidStateColor(array.state)}`}>
          {array.state}
        </span>
      </div>
      <div className="space-y-1 text-sm mb-3">
        <div className="flex justify-between">
          <span className="text-text-500">Size</span>
          <span className="font-mono text-text-200">{formatBytes(array.size)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-500">Members</span>
          <span className="text-text-300">{array.members?.length ?? 0} drives</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-500">Usage</span>
          <span className={array.inUse ? "text-yellow-400" : "text-text-300"}>
            {array.inUse ? "Mounted/System" : "Free"}
          </span>
        </div>
        {array.rebuildPercent !== undefined && (
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-text-500">Rebuild</span>
              <span className="text-yellow-400">{array.rebuildPercent.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-surface-600 rounded-full h-1.5">
              <div
                className="bg-yellow-400 h-1.5 rounded-full transition-all"
                style={{ width: `${array.rebuildPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="pt-2 border-t border-surface-600">
        <div className="text-xs text-text-500 mb-1">Member Drives</div>
        <div className="space-y-0.5">
          {array.members?.map((m) => (
            <div key={m.device} className="flex justify-between text-xs">
              <span className="font-mono text-text-300">{m.device}</span>
              <span className={m.role === "active" ? "text-green-400" : "text-red-400"}>{m.role}</span>
            </div>
          ))}
        </div>
      </div>
      {!!array.mountpoints?.length && (
        <div className="mt-3 pt-2 border-t border-surface-600">
          <div className="text-xs text-text-500 mb-1">Mounted On</div>
          <div className="space-y-0.5">
            {array.mountpoints.map((mountpoint) => (
              <div key={mountpoint} className="text-xs font-mono text-yellow-400">{mountpoint}</div>
            ))}
          </div>
        </div>
      )}
      <button
        onClick={onDelete}
        disabled={array.inUse}
        className="mt-3 text-xs text-red-400 hover:text-red-300 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {array.inUse ? "Cannot delete mounted array" : "Delete array"}
      </button>
    </div>
  );
}

// ─── Create RAID Modal ─────────────────────────────────────────────────────────
function CreateRaidModal({ open, disks, onClose, onCreated }: {
  open: boolean;
  disks: PhysicalDisk[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [level, setLevel] = useState<RaidLevel>(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => apiPost("/api/storage/raid", { level, devices: selected, name }),
    onSuccess: () => { onCreated(); onClose(); setSelected([]); setName(""); setError(""); },
    onError: (err: Error) => setError(err.message),
  });

  const minDisks: Record<number, number> = { 0: 2, 1: 2, 5: 3, 10: 4 };
  const availableDisks = disks.filter((d) => !d.inUse && !d.inRaid);

  const toggleDisk = (path: string) => {
    setSelected((s) => s.includes(path) ? s.filter((x) => x !== path) : [...s, path]);
  };

  return (
    <Modal open={open} title={t("modal.createRaidArray")} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">RAID Level</label>
          <div className="flex gap-2">
            {([0, 1, 5, 10] as RaidLevel[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  level === l
                    ? "bg-accent-blue text-white"
                    : "bg-surface-700 text-text-300 hover:bg-surface-600"
                }`}
              >
                RAID {l}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-500 mt-1">
            {level === 0 && "Striping — fastest, no redundancy. Min 2 drives."}
            {level === 1 && "Mirroring — 50% storage, 1 drive fault tolerance. Min 2 drives."}
            {level === 5 && "Striping + parity — 1 drive fault tolerance. Min 3 drives."}
            {level === 10 && "Striping + mirroring — 50% storage, best performance. Min 4 drives."}
          </p>
        </div>

        <div>
          <label className="label">Name (optional)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="md-storage" />
        </div>

        <div>
          <label className="label">
            Select Drives (min {minDisks[level]}, selected: {selected.length})
          </label>
          {availableDisks.length === 0 ? (
            <p className="text-sm text-yellow-400">No free drives available</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {availableDisks.map((d) => (
                <label key={d.path} className="flex items-center gap-2 p-2 rounded hover:bg-surface-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(d.path)}
                    onChange={() => toggleDisk(d.path)}
                    className="w-4 h-4 accent-accent-blue"
                  />
                  <span className="font-mono text-sm text-text-200">{d.path}</span>
                  <span className="text-xs text-text-400">{formatBytes(d.size)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => create.mutate()}
            disabled={selected.length < minDisks[level] || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? "Creating..." : "Create RAID"}
          </button>
          <button onClick={onClose} className="btn">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Pool Section ──────────────────────────────────────────────────────────────
function PoolCard({ pool }: { pool: StoragePool }) {
  const usedPercent = pool.totalBytes ? (pool.usedBytes / pool.totalBytes) * 100 : 0;
  const barColor = usedPercent > 85 ? "bg-red-500" : usedPercent > 70 ? "bg-yellow-500" : "bg-accent-blue";

  return (
    <Link to={`/storage/pools/${pool.name}`} className="card p-4 hover:border-surface-400 transition-colors block">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-text-200 font-medium">{pool.name}</div>
          <div className="text-xs text-text-500 font-mono mt-0.5">{pool.path}</div>
          {pool.mountSource && (
            <div className="text-xs text-text-500 font-mono mt-0.5 break-all">{pool.mountSource}</div>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          pool.enabled
            ? "bg-green-900/20 text-green-400 border-green-800"
            : "bg-surface-700 text-text-400 border-surface-500"
        }`}>
          {pool.enabled ? "Active" : "Disabled"}
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-text-500">Used</span>
          <span className="font-mono text-text-200">
            {formatBytes(pool.usedBytes)} / {formatBytes(pool.totalBytes)}
          </span>
        </div>
        <div className="w-full bg-surface-700 rounded-full h-1.5">
          <div className={`${barColor} h-1.5 rounded-full transition-all`} style={{ width: `${usedPercent}%` }} />
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs bg-surface-800 text-text-300 px-1.5 py-0.5 rounded uppercase">{pool.type}</span>
          {pool.content?.map((c) => (
            <span key={c} className="text-xs bg-surface-700 text-text-400 px-1.5 py-0.5 rounded">{c}</span>
          ))}
        </div>
      </div>
    </Link>
  );
}

function MountCard({ mount }: { mount: MountedFilesystem }) {
  const usedPercent = mount.totalBytes ? (mount.usedBytes / mount.totalBytes) * 100 : 0;
  const barColor = usedPercent > 85 ? "bg-red-500" : usedPercent > 70 ? "bg-yellow-500" : "bg-accent-blue";

  return (
    <div className={`card p-4 ${mount.isRoot ? "border-accent-blue/40" : ""}`}>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="font-mono text-text-200 font-medium">{mount.mountpoint}</div>
          <div className="mt-0.5 text-xs text-text-500">{mount.source}</div>
        </div>
        <span className={`text-xs font-medium ${mount.isRoot ? "text-accent-blue" : "text-text-400"}`}>
          {mount.isRoot ? "System Root" : mount.fstype}
        </span>
      </div>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-text-500">Used</span>
          <span className="font-mono text-text-200">{formatBytes(mount.usedBytes)} / {formatBytes(mount.totalBytes)}</span>
        </div>
        <div className="w-full bg-surface-700 rounded-full h-1.5">
          <div className={`${barColor} h-1.5 rounded-full`} style={{ width: `${usedPercent}%` }} />
        </div>
        <div className="flex justify-between text-xs text-text-500">
          <span>Free {formatBytes(mount.freeBytes)}</span>
          <span>{usedPercent.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

// ─── Create Pool Modal ─────────────────────────────────────────────────────────
function CreatePoolModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  // "disk" is a UI-level choice only: the API models a disk-backed pool as a
  // directory pool with a mountSource (the block device) + fstype, which it
  // mounts at `path` and persists in fstab.
  const [type, setType] = useState<"directory" | "disk" | "nfs" | "cifs">("directory");
  const [diskDevice, setDiskDevice] = useState("");
  const [diskFstype, setDiskFstype] = useState<"ext4" | "xfs" | "btrfs">("ext4");
  const [mountSource, setMountSource] = useState("");
  const [mountOptions, setMountOptions] = useState("");
  const [smbUsername, setSmbUsername] = useState("");
  const [smbPassword, setSmbPassword] = useState("");
  const [smbDomain, setSmbDomain] = useState("");
  const [content, setContent] = useState<string[]>(["vm", "iso", "backup", "disk"]);
  const [error, setError] = useState("");

  const { data: physicalDisks = [] } = useQuery<PhysicalDisk[]>({
    queryKey: ["storage", "disks"],
    queryFn: () => apiGet<PhysicalDisk[]>("/api/storage/disks"),
    enabled: open && type === "disk",
  });
  // Offer partitions when a disk has them, the whole device otherwise; skip
  // anything already mounted or claimed by a RAID array.
  const blockDevices = physicalDisks.flatMap((disk) =>
    disk.partitions.length > 0
      ? disk.partitions
          .filter((part) => !part.mountpoint)
          .map((part) => ({ path: part.path, size: part.size, fstype: part.fstype, label: `${disk.model || disk.name}` }))
      : disk.inUse || disk.inRaid
        ? []
        : [{ path: disk.path, size: disk.size, fstype: "" as string, label: disk.model || disk.name }],
  );
  const selectedDevice = blockDevices.find((d) => d.path === diskDevice);

  const create = useMutation({
    mutationFn: () => apiPost("/api/storage/pools", {
      name,
      path,
      content,
      type: type === "disk" ? "directory" : type,
      mountSource: type === "disk" ? diskDevice : type === "directory" ? undefined : mountSource,
      fstype: type === "disk" ? diskFstype : type === "directory" ? undefined : type,
      mountOptions: mountOptions || undefined,
      smbUsername: type === "cifs" && smbUsername ? smbUsername : undefined,
      smbPassword: type === "cifs" && smbUsername ? smbPassword : undefined,
      smbDomain: type === "cifs" && smbDomain ? smbDomain : undefined,
    }),
    onSuccess: () => {
      onCreated();
      onClose();
      setName("");
      setPath("");
      setType("directory");
      setDiskDevice("");
      setDiskFstype("ext4");
      setMountSource("");
      setMountOptions("");
      setSmbUsername("");
      setSmbPassword("");
      setSmbDomain("");
      setContent(["vm", "iso", "backup", "disk"]);
      setError("");
    },
    onError: (err: Error) => setError(err.message),
  });

  const toggleContent = (c: string) =>
    setContent((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);

  return (
    <Modal open={open} title={t("modal.createStoragePool")} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Pool Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vm-storage" />
        </div>
        <div>
          <label className="label">Pool Type *</label>
          <div className="grid grid-cols-4 gap-2">
            {[
              { value: "directory", label: "Directory" },
              { value: "disk", label: "Disk" },
              { value: "nfs", label: "NFS" },
              { value: "cifs", label: "SMB / CIFS" },
            ].map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setType(entry.value as "directory" | "disk" | "nfs" | "cifs")}
                className={`px-3 py-2 rounded text-sm border transition-colors ${
                  type === entry.value
                    ? "bg-accent-blue/20 text-accent-blue border-accent-blue/50"
                    : "bg-surface-700 text-text-300 border-surface-500 hover:bg-surface-600"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">{type === "directory" ? "Directory Path *" : "Mount Point *"}</label>
          <input className="input font-mono" value={path} onChange={(e) => setPath(e.target.value)}
            placeholder={type === "disk" ? `/mnt/${name || "pool"}` : "/var/lib/auxinux/pools/vm-storage"} />
          <p className="text-xs text-text-500 mt-1">
            {type === "directory"
              ? "Directory will be created if it doesn't exist"
              : type === "disk"
                ? "Where Virtua mounts the disk. Give a directory such as /mnt/… — never the device node itself (/dev/sda1)."
                : "Local mount point used by Virtua for this remote share"}
          </p>
        </div>
        {type === "disk" && (
          <div className="space-y-3">
            <div>
              <label className="label">Disk / Partition *</label>
              <select className="input font-mono" value={diskDevice} onChange={(e) => setDiskDevice(e.target.value)}>
                <option value="">{blockDevices.length ? "Select a device…" : "No unmounted device available"}</option>
                {blockDevices.map((device) => (
                  <option key={device.path} value={device.path}>
                    {device.path} — {formatBytes(device.size)}{device.fstype ? ` · ${device.fstype}` : " · unformatted"}{device.label ? ` · ${device.label}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-500 mt-1">
                Only devices that are not currently mounted are listed.
              </p>
            </div>
            <div>
              <label className="label">Filesystem *</label>
              <div className="grid grid-cols-3 gap-2">
                {(["ext4", "xfs", "btrfs"] as const).map((fs) => (
                  <button key={fs} type="button" onClick={() => setDiskFstype(fs)}
                    className={`px-3 py-2 rounded text-sm border transition-colors ${
                      diskFstype === fs
                        ? "bg-accent-blue/20 text-accent-blue border-accent-blue/50"
                        : "bg-surface-700 text-text-300 border-surface-500 hover:bg-surface-600"
                    }`}>{fs}</button>
                ))}
              </div>
              {selectedDevice && !selectedDevice.fstype && (
                <p className="text-xs text-accent-amber mt-1">
                  This device has no filesystem yet. Format it first from the disk list — creating the pool only mounts an existing filesystem, it does not erase anything.
                </p>
              )}
              {selectedDevice && selectedDevice.fstype && selectedDevice.fstype !== diskFstype && (
                <p className="text-xs text-accent-amber mt-1">
                  The device already holds {selectedDevice.fstype}. Select that filesystem, or the mount will fail.
                </p>
              )}
            </div>
          </div>
        )}
        {(type === "nfs" || type === "cifs") && (
          <div>
            <label className="label">Remote Source *</label>
            <input
              className="input font-mono"
              value={mountSource}
              onChange={(e) => setMountSource(e.target.value)}
              placeholder={type === "nfs" ? "192.168.1.10:/volume1/virtua" : "//192.168.1.10/virtua"}
            />
            <p className="text-xs text-text-500 mt-1">
              {type === "nfs" ? "Example: server:/export/path" : "Example: //server/share"}
            </p>
          </div>
        )}
        {type === "cifs" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Username</label>
              <input className="input" value={smbUsername} onChange={(e) => setSmbUsername(e.target.value)} placeholder="virtua" />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" className="input" value={smbPassword} onChange={(e) => setSmbPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <div className="md:col-span-2">
              <label className="label">Domain / Workgroup (optional)</label>
              <input className="input" value={smbDomain} onChange={(e) => setSmbDomain(e.target.value)} placeholder="WORKGROUP" />
            </div>
          </div>
        )}
        {type !== "directory" && (
          <div>
            <label className="label">Mount Options</label>
            <input
              className="input font-mono"
              value={mountOptions}
              onChange={(e) => setMountOptions(e.target.value)}
              placeholder={type === "nfs" ? "defaults,_netdev" : "guest,iocharset=utf8,vers=3.0,_netdev"}
            />
            <p className="text-xs text-text-500 mt-1">
              {type === "cifs" ? "Leave empty to use sane defaults. If username is set, Virtua creates a credentials file automatically." : "Leave empty to use sane defaults"}
            </p>
          </div>
        )}
        <div>
          <label className="label">Content Types</label>
          <div className="flex gap-2 flex-wrap">
            {["vm", "iso", "backup", "template", "disk"].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleContent(c)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  content.includes(c)
                    ? "bg-accent-blue/30 text-accent-blue border border-accent-blue/50"
                    : "bg-surface-700 text-text-400 border border-surface-500 hover:bg-surface-600"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => create.mutate()}
            disabled={!name || !path
              || (type === "disk" && !diskDevice)
              || ((type === "nfs" || type === "cifs") && !mountSource)
              || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? "Creating..." : "Create Pool"}
          </button>
          <button onClick={onClose} className="btn">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function StorageDashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createRaidOpen, setCreateRaidOpen] = useState(false);
  const [createPoolOpen, setCreatePoolOpen] = useState(false);
  const [deleteRaidTarget, setDeleteRaidTarget] = useState<string | null>(null);

  const { data: disks = [], refetch: refetchDisks } = useQuery<PhysicalDisk[]>({
    queryKey: ["storage", "disks"],
    queryFn: () => apiGet<PhysicalDisk[]>("/api/storage/disks"),
  });

  const { data: raids = [] } = useQuery<RaidArray[]>({
    queryKey: ["storage", "raid"],
    queryFn: () => apiGet<RaidArray[]>("/api/storage/raid"),
    refetchInterval: 15_000,
  });

  const { data: pools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools"],
    queryFn: () => apiGet<StoragePool[]>("/api/storage/pools"),
    refetchInterval: 30_000,
  });

  const { data: mounts = [] } = useQuery<MountedFilesystem[]>({
    queryKey: ["storage", "mounts"],
    queryFn: () => apiGet<MountedFilesystem[]>("/api/storage/mounts"),
    refetchInterval: 30_000,
  });

  const deleteRaid = useMutation({
    mutationFn: (dev: string) => apiDelete(`/api/storage/raid?device=${encodeURIComponent(dev)}`),
    onSuccess: () => {
      setDeleteRaidTarget(null);
      qc.invalidateQueries({ queryKey: ["storage", "raid"] });
      qc.invalidateQueries({ queryKey: ["storage", "disks"] });
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold text-text-100">Storage</h1>
      <ScopeNotice title={t("scope.localNodeTitle")} tone="warning">
        {t("scope.storageNodeDesc")}
      </ScopeNotice>

      {/* Physical Disks */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">Physical Disks ({disks.length})</h2>
        </div>
        {disks.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">No disks detected</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {disks.map((d) => <DiskCard key={d.path} disk={d} onChanged={() => { void refetchDisks(); }} />)}
          </div>
        )}
      </section>

      {/* RAID Arrays */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">RAID Arrays ({raids.length})</h2>
          <button onClick={() => setCreateRaidOpen(true)} className="btn-primary text-sm">
            + Create RAID
          </button>
        </div>
        {raids.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">
            No RAID arrays. Create one to combine disks.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {raids.map((r) => (
              <RaidCard key={r.device} array={r} onDelete={() => setDeleteRaidTarget(r.device)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">Mounted Filesystems ({mounts.length})</h2>
        </div>
        {mounts.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">No mounted filesystems detected</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {mounts.map((mount) => <MountCard key={`${mount.mountpoint}-${mount.source}`} mount={mount} />)}
          </div>
        )}
      </section>

      {/* Storage Pools */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">Storage Pools ({pools.length})</h2>
          <div className="flex gap-2">
            <Link to="/storage/isos" className="btn text-sm">ISO Manager</Link>
            <button onClick={() => setCreatePoolOpen(true)} className="btn-primary text-sm">
              + Create Pool
            </button>
          </div>
        </div>
        {pools.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">
            No storage pools configured.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pools.map((p) => <PoolCard key={p.name} pool={p} />)}
          </div>
        )}
      </section>

      <CreateRaidModal
        open={createRaidOpen}
        disks={disks}
        onClose={() => setCreateRaidOpen(false)}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ["storage", "raid"] });
          qc.invalidateQueries({ queryKey: ["storage", "disks"] });
        }}
      />

      <CreatePoolModal
        open={createPoolOpen}
        onClose={() => setCreatePoolOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["storage", "pools"] })}
      />

      <ConfirmModal
        open={!!deleteRaidTarget}
        title={t("modal.deleteRaidArray")}
        message={`Stop and remove RAID array "${deleteRaidTarget}"? Member drives will be released but data may be lost.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteRaidTarget && deleteRaid.mutate(deleteRaidTarget)}
        onCancel={() => setDeleteRaidTarget(null)}
        loading={deleteRaid.isPending}
      />
    </div>
  );
}
