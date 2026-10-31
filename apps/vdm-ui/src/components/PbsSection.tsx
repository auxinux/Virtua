import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Modal } from "@/components/ui/Dialogs";
import { useConfirm } from "@/hooks/useDialog";
import { BetaBadge } from "@/components/PbsBackupModal";
import { PBS_DAYS, defaultPbsBridgeMap, describePbsDays, describePbsTargets, latestPbsSnapshots, optionalCount } from "@/lib/pbs";
import type {
  VdmLxc, VdmNode, VdmNodePool, VdmPbsClientStatus, VdmPbsInspect, VdmPbsJob, VdmPbsRemote, VdmPbsSnapshot, VdmVm,
} from "@/types/vdm";

function bytes(value?: number) {
  if (!value) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

type SnapshotList = { node: string; snapshots: VdmPbsSnapshot[] };

/**
 * Backups → Proxmox Backup Server: remotes, per-node client status, snapshot
 * browser with cross-node restore, and datacenter-wide scheduled jobs.
 */
export default function PbsSection({ nodes }: { nodes: VdmNode[] }) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [remoteId, setRemoteId] = useState<number | null>(null);
  const [readNode, setReadNode] = useState("");
  const [editing, setEditing] = useState<VdmPbsRemote | "new" | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<VdmPbsSnapshot | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "vm" | "ct">("all");
  const [latestOnly, setLatestOnly] = useState(true);
  const [search, setSearch] = useState("");

  const clients = useQuery<VdmPbsClientStatus[]>({ queryKey: ["vdm-pbs-nodes"], queryFn: () => api.get("/api/vdm/pbs/nodes"), staleTime: 30_000 });
  const remotes = useQuery<VdmPbsRemote[]>({ queryKey: ["vdm-pbs-remotes"], queryFn: () => api.get("/api/vdm/pbs/remotes") });
  const remoteList = remotes.data ?? [];
  const activeRemote = remoteList.find((r) => r.id === remoteId) ?? remoteList[0];
  const clientNodes = (clients.data ?? []).filter((c) => c.installed);

  const snapshots = useQuery<SnapshotList>({
    queryKey: ["vdm-pbs-snapshots", activeRemote?.id, readNode],
    queryFn: () => api.get(`/api/vdm/pbs/remotes/${activeRemote!.id}/snapshots${readNode ? `?node=${encodeURIComponent(readNode)}` : ""}`),
    enabled: !!activeRemote && clientNodes.length > 0,
    staleTime: 60_000,
    retry: false,
  });

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = (snapshots.data?.snapshots ?? []).filter((s) => typeFilter === "all" || s.type === typeFilter);
    if (needle) list = list.filter((s) => s.id.toLowerCase().includes(needle) || (s.comment ?? "").toLowerCase().includes(needle));
    return latestOnly ? latestPbsSnapshots(list) : list;
  }, [snapshots.data, typeFilter, latestOnly, search]);

  const install = useMutation({
    mutationFn: (node: string) => api.post(`/api/vdm/pbs/nodes/${encodeURIComponent(node)}/install-client`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }),
  });
  const deleteRemote = useMutation({
    mutationFn: (id: number) => api.delete(`/api/vdm/pbs/remotes/${id}`),
    onSuccess: () => { setRemoteId(null); qc.invalidateQueries({ queryKey: ["vdm-pbs-remotes"] }); qc.invalidateQueries({ queryKey: ["vdm-pbs-jobs"] }); },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-vdm-text">Proxmox Backup Server<BetaBadge /></h2>
          <p className="text-sm text-vdm-textMuted">Back up guests of every node to a PBS datastore and restore Virtua or Proxmox VE backups onto any node.</p>
        </div>
        <button className="vdm-btn-primary" onClick={() => setEditing("new")}>Add PBS</button>
      </div>

      {/* proxmox-backup-client per node */}
      <div className="vdm-card divide-y divide-vdm-border/50">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">proxmox-backup-client on nodes</span>
          <button className="vdm-btn-ghost text-xs" disabled={clients.isFetching} onClick={() => api.get<VdmPbsClientStatus[]>("/api/vdm/pbs/nodes?refresh=1").then((d) => qc.setQueryData(["vdm-pbs-nodes"], d))}>
            {clients.isFetching ? "Checking…" : "Recheck"}
          </button>
        </div>
        {(clients.data ?? []).map((c) => (
          <div key={c.node} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="flex-1 text-vdm-text">{c.displayName}</span>
            {c.installed ? <span className="pill-green">{c.version ?? "installed"}</span>
              : !c.online ? <span className="pill-gray">offline</span>
              : <span className="pill-yellow" title={c.error}>{c.supported ? "not installed" : "update Virtua"}</span>}
            {c.online && c.supported && !c.installed && (
              <button className="vdm-btn-ghost text-xs" disabled={install.isPending} onClick={() => install.mutate(c.node)}>Install</button>
            )}
          </div>
        ))}
        {clients.data && clients.data.length === 0 && <div className="px-4 py-3 text-sm text-vdm-textMuted">No enabled node.</div>}
        {install.isSuccess && <div className="px-4 py-2 text-xs text-vdm-success">Installation started — follow it in Tasks, then Recheck.</div>}
        {install.error && <div className="px-4 py-2 text-xs text-vdm-danger">{(install.error as Error).message}</div>}
      </div>

      {remoteList.length === 0 ? (
        <div className="vdm-card p-6 text-center text-sm text-vdm-textMuted">
          {remotes.isLoading ? "Loading…" : "No PBS connected. Add one with a PBS API token: DatastoreBackup to back up, DatastoreReader to restore (DatastorePowerUser covers both)."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select className="vdm-input w-56" value={activeRemote?.id ?? ""} onChange={(e) => setRemoteId(Number(e.target.value))}>
              {remoteList.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
            </select>
            {activeRemote && (
              <>
                <button className="vdm-btn-ghost text-xs" onClick={() => setEditing(activeRemote)}>Edit</button>
                <button className="vdm-btn-danger text-xs" onClick={async () => {
                  if (await confirm({ title: `Remove PBS ${activeRemote.name}?`, message: "Its scheduled jobs are deleted too. Backups on the PBS are not touched.", confirmLabel: "Remove" })) deleteRemote.mutate(activeRemote.id);
                }}>Remove</button>
                <button className="vdm-btn-ghost text-xs" disabled={snapshots.isFetching} onClick={() => snapshots.refetch()}>{snapshots.isFetching ? "Loading…" : "Refresh"}</button>
              </>
            )}
            <select className="vdm-input w-44" value={readNode} onChange={(e) => setReadNode(e.target.value)} title="Node used to read the datastore">
              <option value="">Read via: auto</option>
              {clientNodes.map((c) => <option key={c.node} value={c.node}>Read via {c.displayName}</option>)}
            </select>
            <div className="flex-1" />
            <input className="vdm-input w-44" placeholder="Search ID / comment" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="vdm-input w-32" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "all" | "vm" | "ct")}>
              <option value="all">All types</option><option value="vm">VM only</option><option value="ct">CT only</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-vdm-textMuted cursor-pointer">
              <input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} /> Latest per guest
            </label>
          </div>

          {clients.data && clientNodes.length === 0 && (
            <p className="text-sm text-vdm-warning">No online node has proxmox-backup-client: install it on at least one node to browse this datastore.</p>
          )}
          {snapshots.error && <SnapshotError remote={activeRemote!} error={snapshots.error as Error} onTrusted={() => snapshots.refetch()} />}

          <div className="vdm-card overflow-x-auto">
            <table className="vdm-table">
              <thead><tr><th>Type</th><th>ID</th><th>Backup time</th><th>Size</th><th>Comment</th><th>Actions</th></tr></thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.ref}>
                    <td><span className={s.type === "vm" ? "pill-blue" : "pill-green"}>{s.type === "vm" ? "VM" : "CT"}</span></td>
                    <td className="font-mono">{s.id}</td>
                    <td className="text-xs whitespace-nowrap">{new Date(s.time).toLocaleString()}</td>
                    <td>{bytes(s.sizeBytes)}</td>
                    <td className="text-xs text-vdm-textMuted">
                      {s.comment ?? ""}
                      {s.protected && <span className="ml-2">protected</span>}
                      {s.encrypted && <span className="ml-2 text-vdm-warning">encrypted</span>}
                    </td>
                    <td>
                      <button className="vdm-btn-primary text-xs" disabled={s.encrypted} title={s.encrypted ? "Encrypted backups are not supported yet" : undefined} onClick={() => setRestoreTarget(s)}>Restore</button>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-vdm-textMuted">{snapshots.isLoading ? "Loading snapshots…" : "No snapshots found"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {snapshots.data && <p className="text-xs text-vdm-textMuted">Read through node {snapshots.data.node}.</p>}

          <PbsJobsPanel remotes={remoteList} nodes={nodes} />
        </>
      )}

      <RemoteModal remote={editing} onClose={() => setEditing(null)} onSaved={(r) => {
        qc.invalidateQueries({ queryKey: ["vdm-pbs-remotes"] });
        qc.invalidateQueries({ queryKey: ["vdm-pbs-snapshots"] });
        setRemoteId(r.id);
        setEditing(null);
      }} />
      {activeRemote && (
        <RestoreModal remote={activeRemote} snapshot={restoreTarget} nodes={nodes} readNode={snapshots.data?.node} onClose={() => setRestoreTarget(null)} />
      )}
      {confirmDialog}
    </div>
  );
}

/** Listing error; an untrusted self-signed certificate can be pinned in one click. */
function SnapshotError({ remote, error, onTrusted }: { remote: VdmPbsRemote; error: Error; onTrusted: () => void }) {
  const qc = useQueryClient();
  const fp = /fingerprint ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})/i.exec(error.message)?.[1]?.toLowerCase();
  const trust = useMutation({
    mutationFn: () => api.post<VdmPbsRemote>(`/api/vdm/pbs/remotes/${remote.id}/trust-fingerprint`, { fingerprint: fp }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-pbs-remotes"] }); onTrusted(); },
  });
  return (
    <div className="text-sm text-vdm-danger space-y-1">
      <div>{error.message}</div>
      {fp && (
        <div className="text-vdm-textMuted">
          Check that this fingerprint matches the one on your PBS dashboard, then
          <button className="vdm-btn-ghost text-xs ml-2" disabled={trust.isPending} onClick={() => trust.mutate()}>Trust this certificate</button>
        </div>
      )}
    </div>
  );
}

type RemoteForm = { name: string; server: string; port: number; datastore: string; namespace: string; authId: string; secret: string; fingerprint: string };
const EMPTY_REMOTE: RemoteForm = { name: "", server: "", port: 8007, datastore: "", namespace: "", authId: "", secret: "", fingerprint: "" };
type TestResult = { ok: boolean; error?: string; fingerprint?: string; snapshotCount?: number; node?: string };

function RemoteModal({ remote, onClose, onSaved }: { remote: VdmPbsRemote | "new" | null; onClose: () => void; onSaved: (r: VdmPbsRemote) => void }) {
  const isNew = remote === "new";
  const [form, setForm] = useState<RemoteForm>(EMPTY_REMOTE);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!remote) return;
    setForm(remote === "new" ? EMPTY_REMOTE : { name: remote.name, server: remote.server, port: remote.port, datastore: remote.datastore, namespace: remote.namespace, authId: remote.authId, secret: "", fingerprint: remote.fingerprint });
    setTest(null);
  }, [remote]);

  const set = (key: keyof RemoteForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: key === "port" ? Number(e.target.value) || 8007 : e.target.value }));

  const testConn = useMutation({
    mutationFn: () => api.post<TestResult>("/api/vdm/pbs/test", { ...form, id: isNew || !remote ? undefined : remote.id }),
    onSuccess: setTest,
  });
  const save = useMutation({
    mutationFn: () => isNew || !remote ? api.post<VdmPbsRemote>("/api/vdm/pbs/remotes", form) : api.put<VdmPbsRemote>(`/api/vdm/pbs/remotes/${remote.id}`, form),
    onSuccess: onSaved,
  });

  if (!remote) return null;
  const error = (testConn.error ?? save.error) as Error | null;
  return (
    <Modal open onClose={onClose} maxWidth="max-w-xl">
      <h3 className="text-base font-semibold text-vdm-text">{isNew ? "Add Proxmox Backup Server" : `Edit ${remote.name}`}<BetaBadge /></h3>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">Name in VDM</label><input className="vdm-input" value={form.name} onChange={set("name")} disabled={!isNew} placeholder="pbs-main" /></div>
        <div><label className="vdm-label">Datastore</label><input className="vdm-input" value={form.datastore} onChange={set("datastore")} placeholder="store1" /></div>
        <div><label className="vdm-label">Server</label><input className="vdm-input" value={form.server} onChange={set("server")} placeholder="192.168.1.20 or pbs.example.com" /></div>
        <div><label className="vdm-label">Port</label><input className="vdm-input" type="number" value={form.port} onChange={set("port")} /></div>
        <div><label className="vdm-label">User or API token ID</label><input className="vdm-input" value={form.authId} onChange={set("authId")} placeholder="root@pam!virtua" /></div>
        <div><label className="vdm-label">{isNew ? "Password / token secret" : "Secret (blank = unchanged)"}</label><input className="vdm-input" type="password" autoComplete="new-password" value={form.secret} onChange={set("secret")} /></div>
        <div><label className="vdm-label">Namespace (optional)</label><input className="vdm-input" value={form.namespace} onChange={set("namespace")} /></div>
        <div><label className="vdm-label">Certificate fingerprint</label><input className="vdm-input font-mono text-xs" value={form.fingerprint} onChange={set("fingerprint")} placeholder="aa:bb:… (PBS dashboard)" /></div>
      </div>
      <p className="text-xs text-vdm-textMuted">The secret is stored encrypted in VDM and sent to a node only for the operation it runs.</p>
      {test && (test.ok ? (
        <p className="text-sm text-vdm-success">Connected via {test.node} — {test.snapshotCount} snapshot(s) found.</p>
      ) : (
        <div className="text-sm text-vdm-danger space-y-1">
          <div>{test.error}</div>
          {test.fingerprint && (
            <div className="text-vdm-textMuted">
              Check that this fingerprint matches the one on your PBS dashboard, then
              <button className="vdm-btn-ghost text-xs ml-2" onClick={() => { setForm((f) => ({ ...f, fingerprint: test.fingerprint! })); setTest(null); }}>Trust this certificate</button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="text-sm text-vdm-danger">{error.message}</p>}
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="vdm-btn-ghost" disabled={testConn.isPending} onClick={() => testConn.mutate()}>{testConn.isPending ? "Testing…" : "Test connection"}</button>
        <button className="vdm-btn-primary" disabled={save.isPending || !form.name} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

function RestoreModal({ remote, snapshot, nodes, readNode, onClose }: {
  remote: VdmPbsRemote;
  snapshot: VdmPbsSnapshot | null;
  nodes: VdmNode[];
  readNode?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const onlineNodes = nodes.filter((n) => n.status === "online");
  const [targetNode, setTargetNode] = useState("");
  const [name, setName] = useState("");
  const [storagePool, setStoragePool] = useState("");
  const [bridgeMap, setBridgeMap] = useState<Record<string, string>>({});
  const [autostart, setAutostart] = useState(false);
  const [keepUuid, setKeepUuid] = useState(true);
  const [started, setStarted] = useState(false);
  const isVm = snapshot?.type === "vm";
  const defaultBridge = isVm ? "virbr0" : "lxcbr0";
  const node = targetNode || readNode || onlineNodes[0]?.name || "";

  const inspect = useQuery<VdmPbsInspect>({
    queryKey: ["vdm-pbs-inspect", remote.id, snapshot?.ref],
    queryFn: () => api.get(`/api/vdm/pbs/remotes/${remote.id}/inspect?snapshot=${encodeURIComponent(snapshot!.ref)}${readNode ? `&node=${encodeURIComponent(readNode)}` : ""}`),
    enabled: !!snapshot,
    staleTime: Infinity,
    retry: false,
  });
  const pools = useQuery<VdmNodePool[]>({ queryKey: ["vdm-node-pools", node], queryFn: () => api.get(`/api/vdm/nodes/${encodeURIComponent(node)}/storage`), enabled: !!snapshot && !!node });
  const bridges = useQuery<Array<{ name: string }>>({ queryKey: ["vdm-node-bridges", node], queryFn: () => api.get(`/api/vdm/nodes/${encodeURIComponent(node)}/bridges`), enabled: !!snapshot && !!node });

  const bridgeOptions = useMemo(() => [...new Set([defaultBridge, ...(bridges.data ?? []).map((b) => b.name)])], [bridges.data, defaultBridge]);
  const sourceBridges = useMemo(
    () => [...new Set((inspect.data?.spec.nics ?? []).map((n) => n.bridge).filter((b): b is string => !!b))],
    [inspect.data],
  );

  useEffect(() => {
    if (!snapshot) return;
    setStarted(false);
    setTargetNode("");
    setStoragePool("");
  }, [snapshot]);
  useEffect(() => {
    if (!inspect.data) return;
    setName(inspect.data.suggestedName);
    setAutostart(inspect.data.spec.onboot);
  }, [inspect.data]);
  useEffect(() => {
    setBridgeMap(defaultPbsBridgeMap(sourceBridges, (bridges.data ?? []).map((b) => b.name), defaultBridge));
  }, [sourceBridges, bridges.data, defaultBridge]);
  useEffect(() => {
    // A pool name from another node would 404 on this one.
    setStoragePool(isVm ? (pools.data?.[0]?.name ?? "") : "");
  }, [pools.data, isVm]);

  const restore = useMutation({
    mutationFn: () => {
      const root = snapshot!.files.find((f) => /^root\.m?pxar\.didx$/.test(f.filename));
      return api.post(`/api/vdm/pbs/remotes/${remote.id}/restore`, {
        snapshot: snapshot!.ref,
        targetNode: node,
        name,
        storagePool: storagePool || undefined,
        bridge: defaultBridge,
        bridgeMap,
        autostart,
        ...(isVm ? { keepUuid } : { rootArchive: root?.filename, totalBytes: root?.sizeBytes }),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); setStarted(true); },
  });

  if (!snapshot) return null;
  const data = inspect.data;
  return (
    <Modal open onClose={onClose} maxWidth="max-w-xl">
      <h3 className="text-base font-semibold text-vdm-text">Restore {isVm ? "VM" : "CT"} {snapshot.id} from PBS<BetaBadge /></h3>
      <p className="text-xs text-vdm-textMuted font-mono break-all">{snapshot.ref}</p>
      {started && <p className="text-sm text-vdm-success">Restore started on {node}. Follow its progress in Tasks.</p>}
      {inspect.isLoading && <p className="text-sm text-vdm-textMuted">Reading the Proxmox configuration…</p>}
      {inspect.error && <p className="text-sm text-vdm-danger">{(inspect.error as Error).message}</p>}
      {data && !started && (
        <>
          <div className="rounded-md border border-vdm-border p-3 text-sm text-vdm-textMuted space-y-1">
            {data.type === "vm" ? (
              <>
                <div>{data.spec.vcpus} vCPU · {data.spec.memoryMb} MiB · {data.spec.uefi ? `UEFI${data.spec.secureBoot ? " + Secure Boot" : ""}` : "BIOS"} · {data.spec.machine}{data.spec.tpm ? ` · TPM ${data.spec.tpm}` : ""}{data.spec.ostype ? ` · ${data.spec.ostype}` : ""}</div>
                <div>Disks: {data.spec.disks.filter((d) => d.inBackup).map((d) => `${d.key}${d.sizeBytes ? ` (${bytes(d.sizeBytes)})` : ""}`).join(", ") || "none"}</div>
              </>
            ) : (
              <div>{data.spec.cores ? `${data.spec.cores} cores` : "unlimited CPU"} · {data.spec.memoryMb} MiB{data.spec.ostype ? ` · ${data.spec.ostype}` : ""}{data.spec.rootfsSizeGb ? ` · rootfs ${data.spec.rootfsSizeGb} GB` : ""}</div>
            )}
            <div>Network: {data.spec.nics.map((n) => `${n.key} → ${n.bridge ?? "?"}`).join(", ") || "none"}</div>
          </div>
          {data.spec.warnings.length > 0 && (
            <ul className="text-xs text-vdm-warning list-disc pl-5 space-y-1">{data.spec.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="vdm-label">Target node</label>
              <select className="vdm-input" value={node} onChange={(e) => setTargetNode(e.target.value)}>
                {onlineNodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
              </select>
            </div>
            <div><label className="vdm-label">Name</label><input className="vdm-input font-mono" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="col-span-2">
              <label className="vdm-label">Storage pool on {node || "node"}</label>
              <select className="vdm-input" value={storagePool} onChange={(e) => setStoragePool(e.target.value)}>
                {isVm ? <option value="">Select pool…</option> : <option value="">Default (/var/lib/lxc)</option>}
                {(pools.data ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          </div>
          {sourceBridges.length > 0 && (
            <div className="space-y-2">
              <label className="vdm-label">Network bridges (backup → {node || "node"})</label>
              {sourceBridges.map((b) => (
                <div key={b} className="flex items-center gap-2">
                  <span className="w-24 font-mono text-sm text-vdm-text">{b}</span>
                  <span className="text-vdm-textMuted">→</span>
                  <select className="vdm-input flex-1" value={bridgeMap[b] ?? defaultBridge} onChange={(e) => setBridgeMap((m) => ({ ...m, [b]: e.target.value }))}>
                    {bridgeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-vdm-textMuted cursor-pointer">
            <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} /> Start automatically at boot
          </label>
          {data.type === "vm" && data.spec.smbiosUuid && (
            <label className="flex items-center gap-2 text-sm text-vdm-textMuted cursor-pointer">
              <input type="checkbox" checked={keepUuid} onChange={(e) => setKeepUuid(e.target.checked)} /> Keep the original VM UUID (Windows activation, licences)
            </label>
          )}
          <p className="text-xs text-vdm-textMuted">The restored guest keeps its MAC address(es): don't start it while the original still runs on the same network. The target node needs proxmox-backup-client.</p>
        </>
      )}
      {restore.error && <p className="text-sm text-vdm-danger">{(restore.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        {started ? <button className="vdm-btn-primary" onClick={onClose}>Close</button> : (
          <>
            <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
            <button className="vdm-btn-primary" disabled={restore.isPending || !data || !name || !node || (isVm && !storagePool)} onClick={() => restore.mutate()}>
              {restore.isPending ? "Starting…" : "Restore"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function PbsJobsPanel({ remotes, nodes }: { remotes: VdmPbsRemote[]; nodes: VdmNode[] }) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<VdmPbsJob | "new" | null>(null);
  const jobs = useQuery<VdmPbsJob[]>({ queryKey: ["vdm-pbs-jobs"], queryFn: () => api.get("/api/vdm/pbs/jobs"), refetchInterval: 10_000 });
  const runJob = useMutation({
    mutationFn: (id: number) => api.post(`/api/vdm/pbs/jobs/${id}/run`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-pbs-jobs"] }); qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); },
  });
  const deleteJob = useMutation({ mutationFn: (id: number) => api.delete(`/api/vdm/pbs/jobs/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-pbs-jobs"] }) });
  const remoteName = (id: number) => remotes.find((r) => r.id === id)?.name ?? "?";

  return (
    <div className="vdm-card divide-y divide-vdm-border/50">
      <div className="flex items-center justify-between px-4 py-2.5 gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Scheduled backups to PBS ({jobs.data?.length ?? 0})</div>
          <div className="text-xs text-vdm-textMuted">Guests are backed up one at a time across the datacenter, in Proxmox VE format. Retention is applied after each backup. Times are VDM server time.</div>
        </div>
        <button className="vdm-btn-ghost text-xs shrink-0" onClick={() => setEditing("new")}>New job</button>
      </div>
      {(jobs.data ?? []).length === 0 ? (
        <div className="px-4 py-4 text-sm text-vdm-textMuted">No scheduled PBS backup yet.</div>
      ) : (jobs.data ?? []).map((job) => (
        <div key={job.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
          <span className="font-medium min-w-32">{job.name}{!job.enabled && <span className="ml-2 text-xs text-vdm-textMuted">disabled</span>}</span>
          <span className="text-vdm-textMuted flex-1 min-w-40">{describePbsTargets(job.targets)}</span>
          <span className="text-xs text-vdm-textMuted">{describePbsDays(job.days)} at {job.time} → {remoteName(job.remoteId)}</span>
          <span className="text-xs text-vdm-textMuted" title={job.lastMessage ?? undefined}>
            {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "never"}
            {job.lastStatus && <span className={`ml-2 ${job.lastStatus === "ok" ? "pill-green" : job.lastStatus === "running" ? "pill-blue" : job.lastStatus === "partial" ? "pill-yellow" : "pill-red"}`}>{job.lastStatus}</span>}
          </span>
          <button className="vdm-btn-ghost text-xs" disabled={job.running || runJob.isPending} onClick={() => runJob.mutate(job.id)}>Run now</button>
          <button className="vdm-btn-ghost text-xs" onClick={() => setEditing(job)}>Edit</button>
          <button className="vdm-btn-danger text-xs" onClick={async () => {
            if (await confirm({ title: `Delete job ${job.name}?`, message: "Backups already on the PBS are kept.", confirmLabel: "Delete" })) deleteJob.mutate(job.id);
          }}>Delete</button>
        </div>
      ))}
      {runJob.error && <div className="px-4 py-2 text-xs text-vdm-danger">{(runJob.error as Error).message}</div>}
      <JobModal job={editing} remotes={remotes} nodes={nodes} onClose={() => setEditing(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ["vdm-pbs-jobs"] }); setEditing(null); }} />
      {confirmDialog}
    </div>
  );
}

type JobForm = {
  name: string; remoteId: number; allVms: boolean; allCts: boolean; guests: string[];
  days: string; time: string; keepLast: string; keepDaily: string; keepWeekly: string; keepMonthly: string; enabled: boolean;
};

function JobModal({ job, remotes, nodes, onClose, onSaved }: {
  job: VdmPbsJob | "new" | null; remotes: VdmPbsRemote[]; nodes: VdmNode[]; onClose: () => void; onSaved: () => void;
}) {
  const isNew = job === "new";
  const empty: JobForm = { name: "Nightly PBS backup", remoteId: remotes[0]?.id ?? 0, allVms: true, allCts: true, guests: [], days: "0123456", time: "02:00", keepLast: "", keepDaily: "7", keepWeekly: "4", keepMonthly: "3", enabled: true };
  const [form, setForm] = useState<JobForm>(empty);
  const vms = useQuery<VdmVm[]>({ queryKey: ["vdm-vms-all"], queryFn: () => api.get("/api/vdm/vms"), enabled: !!job });
  const cts = useQuery<VdmLxc[]>({ queryKey: ["vdm-lxc-all"], queryFn: () => api.get("/api/vdm/lxc"), enabled: !!job });

  useEffect(() => {
    if (!job) return;
    if (job === "new") { setForm(empty); return; }
    const s = (n?: number) => (n === undefined ? "" : String(n));
    setForm({
      name: job.name, remoteId: job.remoteId, allVms: job.targets.all.includes("vm"), allCts: job.targets.all.includes("lxc"), guests: job.targets.guests,
      days: job.days, time: job.time, keepLast: s(job.keepLast), keepDaily: s(job.keepDaily), keepWeekly: s(job.keepWeekly), keepMonthly: s(job.keepMonthly), enabled: job.enabled,
    });
  }, [job]);

  const nodeLabel = (n: string) => nodes.find((x) => x.name === n)?.displayName ?? n;
  const guestOptions = useMemo(() => [
    ...(vms.data ?? []).map((g) => ({ key: `${g.nodeName}:vm:${g.name}`, kind: "vm" as const, label: `${nodeLabel(g.nodeName)} / ${g.displayName || g.name}` })),
    ...(cts.data ?? []).map((g) => ({ key: `${g.nodeName}:lxc:${g.name}`, kind: "lxc" as const, label: `${nodeLabel(g.nodeName)} / ${g.displayName || g.name}` })),
  ], [vms.data, cts.data, nodes]);

  const save = useMutation({
    mutationFn: () => {
      const all = [...(form.allVms ? ["vm"] : []), ...(form.allCts ? ["lxc"] : [])];
      // A guest already covered by an "all" kind need not be listed again.
      const guests = form.guests.filter((g) => !all.includes(g.split(":")[1]));
      const body = {
        name: form.name, remoteId: form.remoteId, targets: { all, guests }, days: form.days, time: form.time,
        keepLast: optionalCount(form.keepLast), keepDaily: optionalCount(form.keepDaily), keepWeekly: optionalCount(form.keepWeekly), keepMonthly: optionalCount(form.keepMonthly),
        enabled: form.enabled,
      };
      return isNew || !job ? api.post("/api/vdm/pbs/jobs", body) : api.put(`/api/vdm/pbs/jobs/${job.id}`, body);
    },
    onSuccess: onSaved,
  });

  if (!job) return null;
  const toggleDay = (d: string) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.replace(d, "") : f.days + d }));
  const toggleGuest = (key: string, on: boolean) => setForm((f) => ({ ...f, guests: on ? [...f.guests, key] : f.guests.filter((g) => g !== key) }));
  const keepField = (key: "keepLast" | "keepDaily" | "keepWeekly" | "keepMonthly", label: string) => (
    <div><label className="vdm-label">{label}</label><input className="vdm-input" type="number" min={1} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} /></div>
  );
  const pickable = guestOptions.filter((g) => !(g.kind === "vm" ? form.allVms : form.allCts));

  return (
    <Modal open onClose={onClose} maxWidth="max-w-2xl">
      <h3 className="text-base font-semibold text-vdm-text">{isNew ? "New PBS backup job" : `Edit ${job.name}`}<BetaBadge /></h3>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">Job name</label><input className="vdm-input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
        <div>
          <label className="vdm-label">PBS</label>
          <select className="vdm-input" value={form.remoteId} onChange={(e) => setForm((f) => ({ ...f, remoteId: Number(e.target.value) }))}>
            {remotes.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
          </select>
        </div>
      </div>
      <div className="space-y-2">
        <label className="vdm-label">Guests</label>
        <div className="flex gap-4 text-sm text-vdm-textMuted">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.allVms} onChange={(e) => setForm((f) => ({ ...f, allVms: e.target.checked }))} /> All VMs on all nodes (incl. future ones)</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.allCts} onChange={(e) => setForm((f) => ({ ...f, allCts: e.target.checked }))} /> All containers on all nodes</label>
        </div>
        {pickable.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-vdm-border p-2 max-h-40 overflow-y-auto">
            {pickable.map((g) => (
              <label key={g.key} className="flex items-center gap-1 text-sm text-vdm-text cursor-pointer">
                <input type="checkbox" checked={form.guests.includes(g.key)} onChange={(e) => toggleGuest(g.key, e.target.checked)} />
                <span className={g.kind === "vm" ? "pill-blue" : "pill-green"}>{g.kind === "vm" ? "VM" : "CT"}</span> {g.label}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="vdm-label">Days</label>
          <div className="flex gap-1">
            {PBS_DAYS.map(([d, l]) => (
              <button key={d} type="button" onClick={() => toggleDay(d)} className={`px-2 py-1 rounded text-xs border ${form.days.includes(d) ? "border-vdm-accent text-vdm-accent" : "border-vdm-border text-vdm-textMuted"}`}>{l}</button>
            ))}
          </div>
        </div>
        <div><label className="vdm-label">Time</label><input className="vdm-input w-28" type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} /></div>
        <label className="flex items-center gap-2 text-sm text-vdm-textMuted cursor-pointer pb-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> Enabled</label>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {keepField("keepLast", "Keep last")}
        {keepField("keepDaily", "Keep daily")}
        {keepField("keepWeekly", "Keep weekly")}
        {keepField("keepMonthly", "Keep monthly")}
      </div>
      <p className="text-xs text-vdm-textMuted">Retention is applied per guest on the PBS after each backup (blank = not used). A slot missed while VDM was down runs once when it is back the same day; guests on offline nodes are skipped and reported.</p>
      {save.error && <p className="text-sm text-vdm-danger">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="vdm-btn-primary" disabled={save.isPending || !form.name || !form.remoteId} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}
