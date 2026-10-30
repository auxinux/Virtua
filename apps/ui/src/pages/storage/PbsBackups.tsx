import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { formatBytes, formatDate } from "../../utils/formatBytes";

type PbsRemote = {
  id: number;
  name: string;
  server: string;
  port: number;
  datastore: string;
  namespace: string;
  authId: string;
  fingerprint: string;
};

type PbsSnapshotFile = { filename: string; sizeBytes?: number; encrypted: boolean };

type PbsSnapshot = {
  ref: string;
  type: "vm" | "ct";
  id: string;
  time: string;
  sizeBytes?: number;
  comment?: string;
  protected: boolean;
  encrypted: boolean;
  files: PbsSnapshotFile[];
};

type VmSpec = {
  name?: string;
  vcpus: number;
  memoryMb: number;
  uefi: boolean;
  secureBoot: boolean;
  machine: string;
  tpm?: string;
  ostype?: string;
  onboot: boolean;
  smbiosUuid?: string;
  disks: Array<{ key: string; sizeBytes?: number; inBackup: boolean }>;
  nics: Array<{ key: string; model: string; mac?: string; bridge?: string }>;
  warnings: string[];
};

type CtSpec = {
  hostname?: string;
  ostype?: string;
  cores?: number;
  memoryMb: number;
  unprivileged: boolean;
  onboot: boolean;
  rootfsSizeGb?: number;
  nics: Array<{ key: string; name: string; bridge?: string; hwaddr?: string; ip?: string }>;
  warnings: string[];
};

type Inspect =
  | { type: "vm"; spec: VmSpec; suggestedName: string }
  | { type: "ct"; spec: CtSpec; suggestedName: string };

type StoragePool = { name: string };

export default function PbsBackups({ pools }: { pools: StoragePool[] }) {
  const qc = useQueryClient();
  const [remoteId, setRemoteId] = useState<number | null>(null);
  const [editing, setEditing] = useState<PbsRemote | "new" | null>(null);
  const [deleting, setDeleting] = useState<PbsRemote | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PbsSnapshot | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "vm" | "ct">("all");
  const [latestOnly, setLatestOnly] = useState(true);
  const [search, setSearch] = useState("");

  const { data: status } = useQuery<{ installed: boolean; version: string | null }>({
    queryKey: ["pbs", "status"],
    queryFn: () => apiGet("/api/pbs/status"),
  });

  const { data: remotes = [] } = useQuery<PbsRemote[]>({
    queryKey: ["pbs", "remotes"],
    queryFn: () => apiGet("/api/pbs/remotes"),
  });

  const activeRemote = remotes.find((r) => r.id === remoteId) ?? remotes[0];

  const snapshots = useQuery<PbsSnapshot[]>({
    queryKey: ["pbs", "snapshots", activeRemote?.id],
    queryFn: () => apiGet(`/api/pbs/remotes/${activeRemote!.id}/snapshots`),
    enabled: !!activeRemote && !!status?.installed,
    staleTime: 60_000,
  });

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = (snapshots.data ?? []).filter((s) => typeFilter === "all" || s.type === typeFilter);
    if (needle) list = list.filter((s) => s.id.toLowerCase().includes(needle) || (s.comment ?? "").toLowerCase().includes(needle));
    if (latestOnly) {
      // The list is newest first: keep the first snapshot seen per guest.
      const seen = new Set<string>();
      list = list.filter((s) => {
        const key = `${s.type}/${s.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return list;
  }, [snapshots.data, typeFilter, latestOnly, search]);

  const installClient = useMutation({
    mutationFn: () => apiPost("/api/pbs/install-client"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pbs"] }),
  });

  const deleteRemote = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/pbs/remotes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pbs", "remotes"] });
      setDeleting(null);
      setRemoteId(null);
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-100">Proxmox Backup Server</h2>
          <p className="text-sm text-text-400">Restore Proxmox VE virtual machines and containers straight from a PBS datastore.</p>
        </div>
        <button onClick={() => setEditing("new")} className="btn-secondary">Add PBS</button>
      </div>

      {status && !status.installed && (
        <div className="card p-3 text-sm text-amber-300 border border-amber-500/30 flex items-center justify-between gap-3">
          <div>
            <code>proxmox-backup-client</code> is needed to read PBS backups and is not installed on this node.
            It comes from the AuxiNux depot and is then kept up to date by the node's regular apt updates.
            {installClient.error && <div className="mt-1 text-red-400">{(installClient.error as Error).message}</div>}
          </div>
          <button onClick={() => installClient.mutate()} disabled={installClient.isPending} className="btn-primary btn-sm shrink-0">
            {installClient.isPending ? "Installing..." : "Install"}
          </button>
        </div>
      )}

      {remotes.length === 0 ? (
        <div className="card p-6 text-center text-sm text-text-500">
          No PBS connected. Add one with a PBS API token (Datastore.Reader is enough to restore).
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={activeRemote?.id ?? ""} onChange={(e) => setRemoteId(Number(e.target.value))} className="select w-56">
              {remotes.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
            </select>
            {activeRemote && (
              <>
                <button onClick={() => setEditing(activeRemote)} className="btn-secondary btn-sm">Edit</button>
                <button onClick={() => setDeleting(activeRemote)} className="btn-danger btn-sm">Remove</button>
                <button onClick={() => snapshots.refetch()} disabled={snapshots.isFetching} className="btn-secondary btn-sm">
                  {snapshots.isFetching ? "Loading..." : "Refresh"}
                </button>
              </>
            )}
            <div className="flex-1" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="input w-48" placeholder="Search ID / comment" />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "all" | "vm" | "ct")} className="select w-32">
              <option value="all">All types</option>
              <option value="vm">VM only</option>
              <option value="ct">CT only</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-text-300 cursor-pointer">
              <input type="checkbox" className="w-4 h-4" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} />
              Latest per guest
            </label>
          </div>

          {snapshots.error && (
            <div className="text-sm text-red-400">{(snapshots.error as Error).message}</div>
          )}

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-600/50">
                <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">ID</th>
                  <th className="px-4 py-2">Backup time</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Comment</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-600">
                {visible.map((s) => (
                  <tr key={s.ref} className="hover:bg-surface-600/20">
                    <td className="px-4 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${s.type === "vm" ? "bg-accent-blue/20 text-accent-blue-light" : "bg-green-500/15 text-green-400"}`}>
                        {s.type === "vm" ? "VM" : "CT"}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-text-200">{s.id}</td>
                    <td className="px-4 py-2 text-text-400">{formatDate(s.time)}</td>
                    <td className="px-4 py-2 text-text-400">{s.sizeBytes ? formatBytes(s.sizeBytes) : "—"}</td>
                    <td className="px-4 py-2 text-text-400">
                      {s.comment ?? ""}
                      {s.protected && <span className="ml-2 text-xs text-text-500">protected</span>}
                      {s.encrypted && <span className="ml-2 text-xs text-amber-300">encrypted</span>}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => setRestoreTarget(s)}
                        disabled={s.encrypted}
                        title={s.encrypted ? "Encrypted backups are not supported yet" : undefined}
                        className="btn-secondary btn-sm"
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-text-500">
                      {snapshots.isLoading ? "Loading snapshots..." : "No snapshots found"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <RemoteModal remote={editing} onClose={() => setEditing(null)} onSaved={(r) => {
        qc.invalidateQueries({ queryKey: ["pbs"] });
        setRemoteId(r.id);
        setEditing(null);
      }} />

      {activeRemote && (
        <PbsRestoreModal remote={activeRemote} snapshot={restoreTarget} pools={pools} onClose={() => setRestoreTarget(null)} />
      )}

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteRemote.mutate(deleting.id)}
        loading={deleteRemote.isPending}
        dangerous
        title="Remove PBS"
        message={deleting ? `Remove PBS ${deleting.name} from Virtua? Backups on the PBS are not touched.` : ""}
        confirmLabel="Remove"
      />
    </div>
  );
}

function RemoteModal({ remote, onClose, onSaved }: {
  remote: PbsRemote | "new" | null;
  onClose: () => void;
  onSaved: (r: PbsRemote) => void;
}) {
  const isNew = remote === "new";
  const [form, setForm] = useState({ name: "", server: "", port: 8007, datastore: "", namespace: "", authId: "", secret: "", fingerprint: "" });
  const [test, setTest] = useState<{ ok: boolean; error?: string; fingerprint?: string; snapshotCount?: number } | null>(null);
  const [error, setError] = useState("");

  React.useEffect(() => {
    if (!remote) return;
    setForm(remote === "new"
      ? { name: "", server: "", port: 8007, datastore: "", namespace: "", authId: "", secret: "", fingerprint: "" }
      : { ...remote, secret: "" });
    setTest(null);
    setError("");
  }, [remote]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: key === "port" ? Number(e.target.value) || 8007 : e.target.value }));

  const body = () => ({ ...form, id: isNew || !remote ? undefined : remote.id });

  const testConn = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; error?: string; fingerprint?: string; snapshotCount?: number }>("/api/pbs/test", body()),
    onSuccess: (r) => { setTest(r); setError(""); },
    onError: (err: Error) => setError(err.message),
  });

  const save = useMutation({
    mutationFn: () => isNew || !remote
      ? apiPost<PbsRemote>("/api/pbs/remotes", form)
      : apiPut<PbsRemote>(`/api/pbs/remotes/${remote.id}`, form),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open={!!remote}
      onClose={onClose}
      title={isNew ? "Add Proxmox Backup Server" : "Edit Proxmox Backup Server"}
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => testConn.mutate()} disabled={testConn.isPending} className="btn-secondary">
            {testConn.isPending ? "Testing..." : "Test connection"}
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name} className="btn-primary">
            {save.isPending ? "Saving..." : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name in Virtua</label>
            <input value={form.name} onChange={set("name")} disabled={!isNew} className="input" placeholder="pbs-main" />
          </div>
          <div>
            <label className="label">Datastore</label>
            <input value={form.datastore} onChange={set("datastore")} className="input" placeholder="store1" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">Server</label>
            <input value={form.server} onChange={set("server")} className="input" placeholder="192.168.1.20 or pbs.example.com" />
          </div>
          <div>
            <label className="label">Port</label>
            <input type="number" value={form.port} onChange={set("port")} className="input" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">User or API token ID</label>
            <input value={form.authId} onChange={set("authId")} className="input" placeholder="root@pam!virtua" />
          </div>
          <div>
            <label className="label">{isNew ? "Password / token secret" : "Password / token secret (blank = unchanged)"}</label>
            <input type="password" value={form.secret} onChange={set("secret")} className="input" autoComplete="new-password" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Namespace (optional)</label>
            <input value={form.namespace} onChange={set("namespace")} className="input" />
          </div>
          <div>
            <label className="label">Certificate fingerprint</label>
            <input value={form.fingerprint} onChange={set("fingerprint")} className="input font-mono text-xs" placeholder="aa:bb:… (shown on the PBS dashboard)" />
          </div>
        </div>
        {test && (
          test.ok ? (
            <div className="text-sm text-green-400">Connected — {test.snapshotCount} snapshot(s) found.</div>
          ) : (
            <div className="space-y-2 text-sm text-red-400">
              <div>{test.error}</div>
              {test.fingerprint && (
                <div className="text-text-300">
                  Check that this fingerprint matches the one on your PBS dashboard, then:
                  <button
                    className="btn-secondary btn-sm ml-2"
                    onClick={() => { setForm((f) => ({ ...f, fingerprint: test.fingerprint! })); setTest(null); }}
                  >
                    Trust this certificate
                  </button>
                </div>
              )}
            </div>
          )
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>
    </Modal>
  );
}

function PbsRestoreModal({ remote, snapshot, pools, onClose }: {
  remote: PbsRemote;
  snapshot: PbsSnapshot | null;
  pools: StoragePool[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [storagePool, setStoragePool] = useState("");
  const [bridgeMap, setBridgeMap] = useState<Record<string, string>>({});
  const [autostart, setAutostart] = useState(false);
  const [keepUuid, setKeepUuid] = useState(true);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  const inspect = useQuery<Inspect>({
    queryKey: ["pbs", "inspect", remote.id, snapshot?.ref],
    queryFn: () => apiGet(`/api/pbs/remotes/${remote.id}/inspect?snapshot=${encodeURIComponent(snapshot!.ref)}`),
    enabled: !!snapshot,
    staleTime: Infinity,
  });

  const { data: hostBridges = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ["network", "bridges"],
    queryFn: () => apiGet("/api/network/bridges"),
    enabled: !!snapshot,
  });

  const isVm = snapshot?.type === "vm";
  const defaultBridge = isVm ? "virbr0" : "lxcbr0";
  const bridgeOptions = useMemo(
    () => [...new Set([defaultBridge, ...hostBridges.map((b) => b.name)])],
    [hostBridges, defaultBridge],
  );
  const pveBridges = useMemo(
    () => [...new Set((inspect.data?.spec.nics ?? []).map((n) => n.bridge).filter((b): b is string => !!b))],
    [inspect.data],
  );

  React.useEffect(() => {
    if (!snapshot) return;
    setStarted(false);
    setError("");
    setStoragePool(snapshot.type === "vm" ? (pools[0]?.name ?? "") : "");
  }, [snapshot, pools]);

  React.useEffect(() => {
    if (!inspect.data) return;
    setName(inspect.data.suggestedName);
    setAutostart(inspect.data.spec.onboot);
    // Same bridge name on this host (vmbr0 → vmbr0) is the natural default.
    const known = new Set(hostBridges.map((b) => b.name));
    setBridgeMap(Object.fromEntries(pveBridges.map((b) => [b, known.has(b) ? b : defaultBridge])));
  }, [inspect.data, hostBridges, pveBridges, defaultBridge]);

  const restore = useMutation({
    mutationFn: () => {
      if (!snapshot) throw new Error("No snapshot selected");
      const root = snapshot.files.find((f) => /^root\.m?pxar\.didx$/.test(f.filename));
      return apiPost(`/api/pbs/remotes/${remote.id}/restore`, {
        snapshot: snapshot.ref,
        name,
        storagePool: storagePool || undefined,
        bridge: defaultBridge,
        bridgeMap,
        autostart,
        ...(isVm ? { keepUuid } : { rootArchive: root?.filename, totalBytes: root?.sizeBytes }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      setStarted(true);
    },
    onError: (err: Error) => setError(err.message),
  });

  const data = inspect.data;

  return (
    <Modal
      open={!!snapshot}
      onClose={onClose}
      size="lg"
      title={snapshot ? `Restore ${snapshot.type === "vm" ? "VM" : "CT"} ${snapshot.id} from PBS` : "Restore from PBS"}
      footer={started ? (
        <button onClick={onClose} className="btn-primary">Close</button>
      ) : (
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => restore.mutate()}
            disabled={restore.isPending || !data || !name || (isVm && !storagePool)}
            className="btn-primary"
          >
            {restore.isPending ? "Starting..." : "Restore"}
          </button>
        </>
      )}
    >
      {snapshot && (
        <div className="space-y-3">
          <div className="text-xs text-text-500 font-mono">{snapshot.ref}</div>
          {started && (
            <div className="text-sm text-green-400">Restore started. Follow its progress in the task panel.</div>
          )}
          {inspect.isLoading && <div className="text-sm text-text-400">Reading the Proxmox configuration...</div>}
          {inspect.error && <div className="text-sm text-red-400">{(inspect.error as Error).message}</div>}
          {data && !started && (
            <>
              <div className="rounded-md border border-surface-600 p-3 text-sm text-text-300 space-y-1">
                {data.type === "vm" ? (
                  <>
                    <div>{data.spec.vcpus} vCPU · {data.spec.memoryMb} MiB · {data.spec.uefi ? `UEFI${data.spec.secureBoot ? " + Secure Boot" : ""}` : "BIOS"} · {data.spec.machine}{data.spec.tpm ? ` · TPM ${data.spec.tpm}` : ""}{data.spec.ostype ? ` · ${data.spec.ostype}` : ""}</div>
                    <div>Disks: {data.spec.disks.filter((d) => d.inBackup).map((d) => `${d.key}${d.sizeBytes ? ` (${formatBytes(d.sizeBytes)})` : ""}`).join(", ") || "none"}</div>
                  </>
                ) : (
                  <>
                    <div>{data.spec.cores ? `${data.spec.cores} cores` : "unlimited CPU"} · {data.spec.memoryMb} MiB{data.spec.ostype ? ` · ${data.spec.ostype}` : ""}{data.spec.rootfsSizeGb ? ` · rootfs ${data.spec.rootfsSizeGb} GB` : ""}</div>
                  </>
                )}
                <div>Network: {data.spec.nics.map((n) => `${n.key} → ${n.bridge ?? "?"}`).join(", ") || "none"}</div>
              </div>

              {data.spec.warnings.length > 0 && (
                <ul className="text-xs text-amber-300 list-disc pl-5 space-y-1">
                  {data.spec.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Name in Virtua</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="label">Storage Pool</label>
                  <select value={storagePool} onChange={(e) => setStoragePool(e.target.value)} className="select">
                    {isVm ? <option value="">Select pool...</option> : <option value="">Default (/var/lib/lxc)</option>}
                    {pools.map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}
                  </select>
                </div>
              </div>

              {pveBridges.length > 0 && (
                <div className="space-y-2">
                  <label className="label">Network bridges (Proxmox → this host)</label>
                  {pveBridges.map((b) => (
                    <div key={b} className="flex items-center gap-2">
                      <span className="w-24 font-mono text-sm text-text-300">{b}</span>
                      <span className="text-text-500">→</span>
                      <select value={bridgeMap[b] ?? defaultBridge} onChange={(e) => setBridgeMap((m) => ({ ...m, [b]: e.target.value }))} className="select flex-1">
                        {bridgeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
                <span className="text-sm text-text-300">Start automatically at boot</span>
              </label>
              {data.type === "vm" && data.spec.smbiosUuid && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4" checked={keepUuid} onChange={(e) => setKeepUuid(e.target.checked)} />
                  <span className="text-sm text-text-300">Keep the original VM UUID (Windows activation, licences)</span>
                </label>
              )}
              <div className="text-xs text-text-500">
                The restored guest keeps its MAC address{pveBridges.length > 1 ? "es" : ""}: don't start it while the original is still running on the same network.
              </div>
            </>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
