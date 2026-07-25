import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiDelete } from "../../api/client";
import { StatusBadge } from "../../components/ui/Badge";
import { MetricBar } from "../../components/ui/MetricBar";
import { NotesCard } from "../../components/NotesCard";
import { LockBadge, LockButton, useResourceLock } from "../../components/LockControl";
import { Tabs } from "../../components/ui/Tabs";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { Terminal } from "../../components/Terminal";
import { ResourceAclPanel } from "../../components/acl/ResourceAclPanel";
import { HostUsbDevicesPanel } from "../../components/HostUsbDevicesPanel";
import { HostGpuDevicesPanel } from "../../components/HostGpuDevicesPanel";
import { useAuth } from "../../utils/useAuth";
import { formatBytes } from "../../utils/formatBytes";
import type { LxcContainer, LxcStats, LxcSnapshot, TaskProgress } from "@auxinux/shared";

type Backup = { id: string; filename: string; sizeBytes: number; createdAt: string; storagePool?: string; nodeName?: string };
const MAX_LXC_DISK_GB = 65536;
const INTERNAL_BRIDGES = new Set(["lxcbr0", "virbr0", "docker0"]);

function formatSnapshotDate(value?: string) {
  if (!value) return "—";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "—";
}

// ─── Summary Tab ───────────────────────────────────────────────────────────────
function LxcSummaryTab({ ct, stats }: { ct: LxcContainer; stats?: LxcStats }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-text-300 mb-3">{t("common.configuration")}</h3>
        <dl className="space-y-2 text-sm">
          {[
            [t("common.name"), ct.name],
            [t("common.state"), <StatusBadge key="s" state={ct.state} />],
            [t("res.cores"), ct.cpus],
            [t("res.memory"), `${ct.memoryMiB} MiB`],
            [t("res.disk"), `${ct.diskGb} GB`],
            ["IP", ct.ipAddress || "—"],
            [t("common.autostart"), ct.autostart ? t("common.yes") : t("common.no")],
          ].map(([k, v]) => (
            <div key={String(k)} className="flex justify-between gap-2">
              <dt className="text-text-500">{k}</dt>
              <dd className="text-text-200 font-mono text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {stats && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-text-300 mb-3">{t("common.liveStats")}</h3>
          <div className="space-y-3 mb-4">
            <MetricBar label={t("res.cpu")} value={stats.cpuPercent ?? 0} valueLabel={`${(stats.cpuPercent ?? 0).toFixed(1)}%`} />
            <MetricBar
              label={t("res.memory")}
              value={stats.memTotalBytes ? ((stats.memUsedBytes ?? 0) / stats.memTotalBytes) * 100 : 0}
              valueLabel={`${formatBytes(stats.memUsedBytes ?? 0)} / ${formatBytes(stats.memTotalBytes ?? 0)}`}
            />
          </div>
          <dl className="space-y-2 text-sm">
            {[
              [t("common.diskRead"), formatBytes(stats.diskRdBytes ?? 0)],
              [t("common.diskWrite"), formatBytes(stats.diskWrBytes ?? 0)],
              [t("common.netRx"), formatBytes(stats.netRxBytes ?? 0)],
              [t("common.netTx"), formatBytes(stats.netTxBytes ?? 0)],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex justify-between gap-2">
                <dt className="text-text-500">{k}</dt>
                <dd className="text-text-200 font-mono">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <NotesCard type="lxc" id={ct.name} className="md:col-span-2" />
    </div>
  );
}

// ─── Resources Tab ─────────────────────────────────────────────────────────────
function LxcResourcesTab({ ct, name }: { ct: LxcContainer; name: string }) {
  const qc = useQueryClient();
  const [cpus, setCpus] = useState(ct.cpus);
  const [memoryMiB, setMemoryMiB] = useState(ct.memoryMiB);
  const [diskGb, setDiskGb] = useState(ct.diskGb);
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: () => apiPut(`/api/lxc/${name}/config`, { cpuCores: cpus, memoryMb: memoryMiB, diskGb }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lxc", name] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="space-y-4">
      <div className="card p-5 max-w-md space-y-4">
        <h3 className="text-sm font-semibold text-text-300">Resource Limits</h3>
        <div>
          <label className="label">CPUs</label>
          <input type="number" className="input" min={1} max={64} value={cpus}
            onChange={(e) => setCpus(parseInt(e.target.value, 10))} />
        </div>
        <div>
          <label className="label">Memory (MiB)</label>
          <input type="number" className="input" min={64} step={64} value={memoryMiB}
            onChange={(e) => setMemoryMiB(parseInt(e.target.value, 10))} />
          <p className="text-xs text-text-500 mt-1">{(memoryMiB / 1024).toFixed(1)} GiB</p>
        </div>
        <div>
          <label className="label">Disk (GB)</label>
          <input type="number" className="input" min={ct.diskGb} max={MAX_LXC_DISK_GB} value={diskGb}
            onChange={(e) => setDiskGb(parseInt(e.target.value, 10))} />
          <p className="text-xs text-text-500 mt-1">Disk can only be expanded, not shrunk</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
            {update.isPending ? "Saving..." : "Apply Changes"}
          </button>
          {saved && <span className="text-green-400 text-sm">Saved!</span>}
        </div>
      </div>
      <HostUsbDevicesPanel
        resourceType="lxc"
        resourceName={name}
        nodeName={ct.nodeName}
        attachedDevices={ct.usbDevices ?? []}
        invalidateKey={["lxc", name]}
      />
      <HostGpuDevicesPanel
        resourceName={name}
        nodeName={ct.nodeName}
        attachedDevices={ct.gpuDevices ?? []}
        invalidateKey={["lxc", name]}
      />
    </div>
  );
}

// ─── Network Tab (multi-NIC) ─────────────────────────────────────────────────
interface LxcNic { index: number; primary?: boolean; type: string; link: string; hwaddr?: string; ipv4?: string; ipv4Gateway?: string; }

function LxcNetworkTab({ name }: { name: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nics = useQuery<LxcNic[]>({ queryKey: ["lxc", name, "networks"], queryFn: () => apiGet(`/api/lxc/${name}/networks`) });
  const { data: bridges = [] } = useQuery<string[]>({
    queryKey: ["network", "bridges-list"],
    queryFn: async () => (await apiGet<{ name: string }[]>("/api/network/bridges")).map((b) => b.name),
  });
  const [adding, setAdding] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["lxc", name, "networks"] });
  const remove = useMutation({ mutationFn: (i: number) => apiDelete(`/api/lxc/${name}/networks/${i}`), onSuccess: refresh });

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="rounded border border-yellow-800/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
        {t("net.restartNote", "Les changements de carte réseau prennent effet après redémarrage du conteneur.")}
      </div>

      {(nics.data ?? []).map((nic) =>
        editIndex === nic.index ? (
          <LxcNicForm key={nic.index} name={name} bridges={bridges} nic={nic} onDone={() => { setEditIndex(null); refresh(); }} onCancel={() => setEditIndex(null)} />
        ) : (
          <NicCard
            key={nic.index}
            title={`eth${nic.index}`}
            primary={!!nic.primary || nic.index === 0}
            rows={[
              [t("net.bridge", "Bridge"), nic.link],
              ["MAC", nic.hwaddr || "—"],
              [t("net.ip", "IP"), nic.ipv4 || t("net.dhcp", "DHCP")],
              ...(nic.ipv4Gateway ? [[t("net.gateway", "Passerelle"), nic.ipv4Gateway] as [string, string]] : []),
            ]}
            onEdit={() => setEditIndex(nic.index)}
            onDelete={() => remove.mutate(nic.index)}
            deleting={remove.isPending}
          />
        ),
      )}

      {remove.error && <p className="text-xs text-red-400">{(remove.error as Error).message}</p>}

      {adding ? (
        <LxcNicForm name={name} bridges={bridges} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />
      ) : (
        <button className="btn-secondary btn-sm" onClick={() => setAdding(true)}>
          + {t("net.addNic", "Ajouter une carte réseau")}
        </button>
      )}
    </div>
  );
}

// Shared NIC summary card with edit/delete (delete disabled for the primary card).
function NicCard({ title, primary, rows, onEdit, onDelete, deleting }: {
  title: string; primary: boolean; rows: [string, string][]; onEdit: () => void; onDelete: () => void; deleting?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-200">{title}</span>
          {primary && <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30">{t("net.primary", "principale")}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={onEdit}>{t("action.edit", "Modifier")}</button>
          <button
            className="btn-ghost btn-sm text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={primary || deleting}
            title={primary ? t("net.cannotDeletePrimary", "La carte principale ne peut pas être supprimée") : undefined}
            onClick={onDelete}
          >
            {t("action.delete", "Supprimer")}
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-text-500">{k}</dt>
            <dd className="font-mono text-text-200 text-right truncate">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

function LxcNicForm({ name, bridges, nic, onDone, onCancel }: {
  name: string; bridges: string[]; nic?: LxcNic; onDone: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const editing = !!nic;
  const [bridge, setBridge] = useState(nic?.link || bridges[0] || "lxcbr0");
  const [mac, setMac] = useState(nic?.hwaddr || "");
  const [mode, setMode] = useState<"dhcp" | "static">(nic?.ipv4 ? "static" : "dhcp");
  const [ip, setIp] = useState(nic?.ipv4 || "");
  const [gw, setGw] = useState(nic?.ipv4Gateway || "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        bridge,
        macAddress: mac || undefined,
        ipv4: mode === "dhcp" ? "dhcp" : ip || undefined,
        ipv4Gateway: mode === "dhcp" ? "" : gw || undefined,
      };
      return editing
        ? apiPut(`/api/lxc/${name}/networks/${nic!.index}`, body)
        : apiPost(`/api/lxc/${name}/networks`, body);
    },
    onSuccess: onDone,
  });

  return (
    <div className="card p-4 space-y-3 border border-accent-blue/30">
      <h4 className="text-sm font-semibold text-text-200">
        {editing ? `${t("action.edit", "Modifier")} eth${nic!.index}` : t("net.addNic", "Ajouter une carte réseau")}
      </h4>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label">{t("net.bridge", "Bridge")}</label>
          <select className="input font-mono" value={bridge} onChange={(e) => setBridge(e.target.value)}>
            {bridges.length === 0 && <option value={bridge}>{bridge}</option>}
            {bridges.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="label">MAC</label>
          <input className="input font-mono" value={mac} onChange={(e) => setMac(e.target.value.toLowerCase())} placeholder={t("net.macAuto", "auto si vide")} />
        </div>
        <div>
          <label className="label">{t("net.mode", "Mode")}</label>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as "dhcp" | "static")}>
            <option value="dhcp">DHCP</option>
            <option value="static">{t("net.static", "Statique")}</option>
          </select>
        </div>
        <div>
          <label className="label">{t("net.ipCidr", "IP (CIDR)")}</label>
          <input className="input font-mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.100/24" disabled={mode === "dhcp"} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">{t("net.gateway", "Passerelle")}</label>
          <input className="input font-mono" value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" disabled={mode === "dhcp"} />
        </div>
      </div>
      {save.error && <p className="text-xs text-red-400">{(save.error as Error).message}</p>}
      <div className="flex items-center gap-2">
        <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t("msg.loading", "…") : (editing ? t("action.save", "Enregistrer") : t("action.create", "Ajouter"))}
        </button>
        <button className="btn-ghost btn-sm" onClick={onCancel}>{t("action.cancel", "Annuler")}</button>
      </div>
    </div>
  );
}

// ─── DNS Tab ───────────────────────────────────────────────────────────────────
function LxcDnsTab({ ct, name }: { ct: LxcContainer; name: string }) {
  const qc = useQueryClient();
  const [dns, setDns] = useState((ct.dns || []).join("\n"));

  const update = useMutation({
    mutationFn: () => apiPut(`/api/lxc/${name}/config`, {
      dnsServers: dns.split(/[\n,\s]+/).filter(Boolean),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lxc", name] }),
  });

  return (
    <div className="card p-5 max-w-md space-y-4">
      <h3 className="text-sm font-semibold text-text-300">DNS Servers</h3>
      <div>
        <label className="label">DNS Servers (one per line)</label>
        <textarea className="input font-mono h-24 resize-none" value={dns} onChange={(e) => setDns(e.target.value)} placeholder="Leave empty to use host DNS" />
      </div>
      <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
        {update.isPending ? "Saving..." : "Apply"}
      </button>
    </div>
  );
}

// ─── Snapshots Tab ─────────────────────────────────────────────────────────────
function LxcSnapshotsTab({ name }: { name: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [snapName, setSnapName] = useState("");
  const [snapDesc, setSnapDesc] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const normalizedSnapName = snapName.trim();
  const isSnapNameValid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(normalizedSnapName);

  const { data: snapshots = [] } = useQuery<LxcSnapshot[]>({
    queryKey: ["lxc", name, "snapshots"],
    queryFn: () => apiGet<LxcSnapshot[]>(`/api/lxc/${name}/snapshots`),
  });
  const { data: tasks = [] } = useQuery<TaskProgress[]>({
    queryKey: ["tasks", "lxc-snapshots", name],
    queryFn: () => apiGet<TaskProgress[]>("/api/tasks?limit=50"),
    refetchInterval: 2_000,
  });

  const createSnap = useMutation({
    mutationFn: () => apiPost(`/api/lxc/${name}/snapshot/create`, {
      snapName: normalizedSnapName,
      description: snapDesc.trim() || undefined,
    }),
    onSuccess: () => {
      setCreateOpen(false);
      setSnapName("");
      setSnapDesc("");
      qc.invalidateQueries({ queryKey: ["lxc", name, "snapshots"] });
    },
  });

  const rollback = useMutation({
    mutationFn: (snap: string) => apiPost(`/api/lxc/${name}/snapshot/${snap}/rollback`, {}),
    onSuccess: () => {
      setRollbackTarget(null);
      qc.invalidateQueries({ queryKey: ["lxc", name] });
    },
  });

  const deleteSnap = useMutation({
    mutationFn: (snap: string) => apiDelete(`/api/lxc/${name}/snapshot/${snap}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lxc", name, "snapshots"] }),
  });

  const taskForSnapshot = (snapName: string) => tasks.find((task) =>
    task.resourceName === name &&
    task.detail === snapName &&
    (task.status === "pending" || task.status === "running") &&
    (task.action === "lxc.snapshot.create" || task.action === "lxc.snapshot.delete" || task.action === "lxc.snapshot.rollback")
  );

  const snapshotStatus = (snapshot: LxcSnapshot) => {
    const task = taskForSnapshot(snapshot.name);
    if (task?.action === "lxc.snapshot.create") return "Creating";
    if (task?.action === "lxc.snapshot.delete") return "Deleting";
    if (task?.action === "lxc.snapshot.rollback") return "Restoring";
    return "Ready";
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-text-300">Snapshots ({snapshots.length})</h3>
        <button onClick={() => setCreateOpen(true)} className="btn-primary text-sm">
          + Create Snapshot
        </button>
      </div>

      {snapshots.length === 0 ? (
        <div className="card p-6 text-center text-text-400 text-sm">No snapshots yet</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">Name</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Description</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Created</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Status</th>
                <th className="px-4 py-2 text-right text-text-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.name} className="border-b border-surface-700">
                  <td className="px-4 py-2 font-mono text-text-200">{s.name}</td>
                  <td className="px-4 py-2 text-text-400">{s.description || "—"}</td>
                  <td className="px-4 py-2 text-text-400">{formatSnapshotDate(s.createdAt)}</td>
                  <td className="px-4 py-2 text-text-400">{snapshotStatus(s)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setRollbackTarget(s.name)} disabled={!!taskForSnapshot(s.name)} className="text-xs btn">Rollback</button>
                      <button onClick={() => deleteSnap.mutate(s.name)} disabled={!!taskForSnapshot(s.name)} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} title={t("modal.createSnapshot")} onClose={() => setCreateOpen(false)}>
        <div className="space-y-3">
          <div>
            <label className="label">Snapshot Name</label>
            <input className="input" value={snapName} onChange={(e) => setSnapName(e.target.value)} placeholder="snap-1" />
            {normalizedSnapName && !isSnapNameValid && (
              <p className="text-xs text-red-400 mt-1">Use 1-64 letters, numbers, dots, hyphens or underscores.</p>
            )}
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <input className="input" value={snapDesc} onChange={(e) => setSnapDesc(e.target.value)} />
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => createSnap.mutate()} disabled={!isSnapNameValid || createSnap.isPending} className="btn-primary">
              {createSnap.isPending ? "Creating..." : "Create"}
            </button>
            <button onClick={() => setCreateOpen(false)} className="btn">Cancel</button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!rollbackTarget}
        title={t("modal.rollbackSnapshot")}
        message={`Rollback container to snapshot "${rollbackTarget}"? Current state will be lost.`}
        confirmLabel="Rollback"
        danger
        onConfirm={() => rollbackTarget && rollback.mutate(rollbackTarget)}
        onCancel={() => setRollbackTarget(null)}
        loading={rollback.isPending}
      />
    </div>
  );
}

// ─── Backup Tab ────────────────────────────────────────────────────────────────
function LxcBackupTab({ name, nodeName }: { name: string; nodeName?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [pool, setPool] = useState("");
  const [compressionLevel, setCompressionLevel] = useState(9);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restoreBridge, setRestoreBridge] = useState("lxcbr0");
  const [restoreMac, setRestoreMac] = useState("");
  // "asIs" keeps the container's original CPU/RAM; "modify" overrides them.
  const [restoreMode, setRestoreMode] = useState<"asIs" | "modify">("asIs");
  const [restoreCpus, setRestoreCpus] = useState(1);
  const [restoreMemoryMb, setRestoreMemoryMb] = useState(512);

  const { data: pools = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ["storage", "pools", nodeName ?? "local"],
    queryFn: () => apiGet<Array<{ name: string }>>(nodeName ? `/api/nodes/${encodeURIComponent(nodeName)}/storage/pools` : "/api/storage/pools"),
  });

  useEffect(() => {
    if (!pool && pools.length > 0) {
      setPool(pools[0].name);
    }
  }, [pool, pools]);

  const { data: backups = [] } = useQuery<Backup[]>({
    queryKey: ["lxc", name, "backups"],
    queryFn: () => apiGet<Backup[]>(`/api/backups?resourceType=lxc&resourceName=${encodeURIComponent(name)}`),
    refetchInterval: 5_000,
  });

  const createBackup = useMutation({
    mutationFn: () => apiPost(`/api/lxc/${name}/backup`, { storagePool: pool, format: "tar.gz", compressionLevel }),
    onSuccess: () => {
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["lxc", name, "backups"] });
    },
  });

  const deleteBackup = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/backups/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["lxc", name, "backups"] });
      qc.invalidateQueries({ queryKey: ["backups"] });
    },
  });

  const restoreBackup = useMutation({
    mutationFn: (id: string) => apiPost(`/api/backups/${id}/restore`, {
      name: restoreName,
      bridge: restoreBridge,
      macAddress: restoreMac || undefined,
      // Only override CPU/RAM when modifying; otherwise keep the originals.
      ...(restoreMode === "modify" ? { cpuCores: restoreCpus, memoryMb: restoreMemoryMb } : {}),
      autostart: false,
    }),
    onSuccess: () => {
      setRestoreTarget(null);
      qc.invalidateQueries({ queryKey: ["backups"] });
    },
  });

  useEffect(() => {
    if (!restoreTarget) return;
    setRestoreMode("asIs");
    setRestoreName(`${name}-restore`);
    setRestoreBridge("lxcbr0");
    setRestoreMac("");
    setRestoreCpus(1);
    setRestoreMemoryMb(512);
  }, [restoreTarget, name]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-text-300">Backups ({backups.length})</h3>
        <button onClick={() => setCreateOpen(true)} className="btn-primary text-sm">
          + Create Backup
        </button>
      </div>

      {backups.length === 0 ? (
        <div className="card p-6 text-center text-text-400 text-sm">No backups yet</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">File</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Size</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Created</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-surface-700">
                  <td className="px-4 py-2 font-mono text-text-200 text-xs">{b.filename}</td>
                  <td className="px-4 py-2 text-text-300">{formatBytes(b.sizeBytes)}</td>
                  <td className="px-4 py-2 text-text-400">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <button onClick={() => setRestoreTarget(b)} className="btn-secondary btn-sm">Restore</button>
                      <button onClick={() => setDeleteTarget(b)} className="btn-danger btn-sm">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} title={t("modal.createBackup")} onClose={() => setCreateOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-text-400">Crée une archive <span className="font-mono">.tar.zst</span> (zstd, à chaud) du rootfs du conteneur.</p>
          <div>
            <label className="label">Storage Pool</label>
            <select className="select" value={pool} onChange={(e) => setPool(e.target.value)}>
              <option value="">Select pool...</option>
              {pools.map((entry) => (
                <option key={entry.name} value={entry.name}>{entry.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Niveau de compression</label>
            <select className="select" value={compressionLevel} onChange={(e) => setCompressionLevel(parseInt(e.target.value, 10))}>
              <option value={3}>3 — Rapide (ratio faible)</option>
              <option value={9}>9 — Équilibré (recommandé)</option>
              <option value={19}>19 — Maximum (plus lent)</option>
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => createBackup.mutate()} disabled={createBackup.isPending || !pool} className="btn-primary">
              {createBackup.isPending ? "Creating..." : "Start Backup"}
            </button>
            <button onClick={() => setCreateOpen(false)} className="btn">Cancel</button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!restoreTarget}
        title={t("modal.restoreBackup")}
        onClose={() => setRestoreTarget(null)}
        footer={
          <>
            <button onClick={() => setRestoreTarget(null)} className="btn-secondary">Cancel</button>
            <button onClick={() => restoreTarget && restoreBackup.mutate(restoreTarget.id)} disabled={restoreBackup.isPending || !restoreName} className="btn-primary">
              {restoreBackup.isPending ? "Starting..." : "Restore"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-xs text-text-500 font-mono">{restoreTarget?.filename}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRestoreMode("asIs")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                restoreMode === "asIs"
                  ? "border-accent-blue bg-accent-blue/10 text-text-100"
                  : "border-surface-600 text-text-400 hover:text-text-200"
              }`}
            >
              Restaurer tel quel
            </button>
            <button
              type="button"
              onClick={() => setRestoreMode("modify")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                restoreMode === "modify"
                  ? "border-accent-blue bg-accent-blue/10 text-text-100"
                  : "border-surface-600 text-text-400 hover:text-text-200"
              }`}
            >
              Modifier (nom + CPU/RAM)
            </button>
          </div>
          <div>
            <label className="label">New Container Name</label>
            <input value={restoreName} onChange={(e) => setRestoreName(e.target.value)} className="input" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Bridge</label>
              <input value={restoreBridge} onChange={(e) => setRestoreBridge(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">MAC (optional)</label>
              <input value={restoreMac} onChange={(e) => setRestoreMac(e.target.value)} className="input" placeholder="aa:bb:cc:dd:ee:ff" />
            </div>
          </div>
          {restoreMode === "modify" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">CPU cores</label>
                <input type="number" min={1} value={restoreCpus} onChange={(e) => setRestoreCpus(parseInt(e.target.value, 10) || 1)} className="input" />
              </div>
              <div>
                <label className="label">Memory (MiB)</label>
                <input type="number" min={128} step={128} value={restoreMemoryMb} onChange={(e) => setRestoreMemoryMb(parseInt(e.target.value, 10) || 512)} className="input" />
              </div>
            </div>
          )}
        </div>
      </Modal>

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

// ─── Logs Tab ──────────────────────────────────────────────────────────────────
function LxcLogsTab({ name }: { name: string }) {
  const { data: logs } = useQuery<{ logs: string }>({
    queryKey: ["lxc", name, "logs"],
    queryFn: () => apiGet<{ logs: string }>(`/api/lxc/${name}/logs`),
    refetchInterval: 5_000,
  });

  return (
    <pre className="bg-surface-900 rounded-lg p-4 text-xs font-mono text-text-300 overflow-auto max-h-[500px] whitespace-pre-wrap break-all">
      {logs?.logs || "No logs available"}
    </pre>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function LxcDetail() {
  const { name } = useParams<{ name: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const { getResourcePermissions } = useAuth();
  const [tab, setTab] = useState("summary");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const perms = name ? getResourcePermissions("lxc", name) : null;
  const { locked, lockEntry } = useResourceLock("lxc", name);
  const tabs = [
    { key: "summary", label: "Summary" },
    perms?.canConsole ? { key: "console", label: "Console" } : null,
    perms?.canModify ? { key: "resources", label: "Resources" } : null,
    perms?.canModify ? { key: "network", label: "Network" } : null,
    perms?.canModify ? { key: "dns", label: "DNS" } : null,
    perms?.canAdmin ? { key: "acl", label: "Resource ACL" } : null,
    perms?.canSnapshot ? { key: "snapshots", label: "Snapshots" } : null,
    perms?.canBackup ? { key: "backup", label: "Backup" } : null,
    { key: "logs", label: "Logs" },
  ].filter(Boolean) as Array<{ key: string; label: string }>;

  const { data: ct, isLoading, error } = useQuery<LxcContainer>({
    queryKey: ["lxc", name],
    queryFn: () => apiGet<LxcContainer>(`/api/lxc/${name}`),
    refetchInterval: 10_000,
  });

  const { data: stats } = useQuery<LxcStats>({
    queryKey: ["lxc", name, "stats"],
    queryFn: () => apiGet<LxcStats>(`/api/lxc/${name}/stats`),
    refetchInterval: 5_000,
    enabled: ct?.state === "running",
  });

  const action = useMutation({
    mutationFn: (act: string) => apiPost(`/api/lxc/${name}/${act}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lxc"] }),
  });

  const remove = useMutation({
    mutationFn: () => apiDelete(`/api/lxc/${name}`),
    onSuccess: () => navigate("/lxc"),
  });

  const renameLxc = useMutation({
    mutationFn: (newName: string) => apiPost<{ ok: boolean; name: string }>(`/api/lxc/${name}/rename`, { newName }),
    onSuccess: (result) => {
      setRenameOpen(false);
      qc.invalidateQueries({ queryKey: ["lxc"] });
      qc.invalidateQueries({ queryKey: ["sidebar", "lxc"] });
      navigate(`/lxc/${encodeURIComponent(result.name)}`);
    },
  });

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab && tabs.some((entry) => entry.key === requestedTab)) {
      setTab(requestedTab);
      return;
    }
    if (!tabs.some((entry) => entry.key === tab)) {
      setTab("summary");
    }
  }, [searchParams, tab, tabs]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !ct) {
    return <div className="card p-6 text-red-400">Container not found</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/lxc")} className="text-text-400 hover:text-text-200 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-text-100">{ct.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge state={ct.state} />
              {locked && <LockBadge reason={lockEntry?.reason} />}
              {ct.ipAddress && <span className="text-xs font-mono text-text-400">{ct.ipAddress}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {perms?.canPower && ct.state === "stopped" && (
            <button onClick={() => action.mutate("start")} disabled={action.isPending}
              className="btn bg-green-900/40 text-green-400 hover:bg-green-900/60 border-green-800">
              Start
            </button>
          )}
          {perms?.canPower && ct.state === "running" && (
            <>
              <button onClick={() => action.mutate("restart")} disabled={action.isPending} className="btn">Restart</button>
              <button onClick={() => action.mutate("stop")} disabled={action.isPending}
                className="btn bg-red-900/40 text-red-400 hover:bg-red-900/60 border-red-800">
                Stop
              </button>
            </>
          )}
          {perms?.canModify && (
            <button
              onClick={() => { setRenameName(ct.name); setRenameOpen(true); }}
              disabled={renameLxc.isPending || locked}
              title={locked ? "Ressource verrouillée" : t("action.rename", "Renommer")}
              className="btn-secondary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("action.rename", "Renommer")}
            </button>
          )}
          {perms?.canAdmin && <LockButton type="lxc" name={name} />}
          {perms?.canDelete && <button onClick={() => setDeleteOpen(true)} disabled={locked} title={locked ? "Ressource verrouillée" : undefined}
            className="btn bg-red-900/20 text-red-400 hover:bg-red-900/40 border-red-900 disabled:opacity-40 disabled:cursor-not-allowed">
            {t("action.delete")}
          </button>}
        </div>
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {/* Tab content */}
      <div>
        {tab === "summary" && <LxcSummaryTab ct={ct} stats={stats} />}
        {tab === "console" && perms?.canConsole && (
          ct.state === "running" ? (
            <Terminal
              ticketPath={`/api/lxc/${name}/console-ticket`}
              className="h-[500px]"
            />
          ) : (
            <div className="card p-8 text-center text-text-400">
              Container must be running to access the console.
            </div>
          )
        )}
        {tab === "resources" && perms?.canModify && <LxcResourcesTab ct={ct} name={name!} />}
        {tab === "network" && perms?.canModify && <LxcNetworkTab name={name!} />}
        {tab === "dns" && perms?.canModify && <LxcDnsTab ct={ct} name={name!} />}
        {tab === "acl" && perms?.canAdmin && <ResourceAclPanel resourceType="lxc" resourceName={name!} title={`LXC ACL · ${name}`} />}
        {tab === "snapshots" && perms?.canSnapshot && <LxcSnapshotsTab name={name!} />}
        {tab === "backup" && perms?.canBackup && <LxcBackupTab name={name!} nodeName={ct.nodeName} />}
        {tab === "logs" && <LxcLogsTab name={name!} />}
      </div>

      <ConfirmModal
        open={deleteOpen}
        title={t("modal.deleteContainer")}
        message={`Delete container "${name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => remove.mutate()}
        onCancel={() => setDeleteOpen(false)}
        loading={remove.isPending}
      />

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title={t("action.rename", "Renommer")}>
        <div className="space-y-4">
          <p className="text-sm text-text-400">
            {t("modal.renameLxcDesc", "Le conteneur doit être arrêté pour être renommé. Le hostname interne sera aussi synchronisé avec le nouveau nom.")}
          </p>
          <div>
            <label className="block text-xs font-medium text-text-300 mb-1">{t("form.newName", "Nouveau nom")}</label>
            <input
              className="input w-full"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder={ct.name}
              autoFocus
            />
            <p className="text-xs text-text-500 mt-1">Lettre au début, puis lettres, chiffres, tirets ou underscores.</p>
          </div>
          {renameLxc.isError && <p className="text-xs text-red-400">{String((renameLxc.error as Error)?.message ?? "Erreur")}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setRenameOpen(false)}>{t("action.cancel", "Annuler")}</button>
            <button
              className="btn-primary"
              disabled={!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(renameName.trim()) || renameName.trim() === ct.name || renameLxc.isPending}
              onClick={() => renameLxc.mutate(renameName.trim())}
            >
              {renameLxc.isPending ? t("action.renaming", "Renommage…") : t("action.rename", "Renommer")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
