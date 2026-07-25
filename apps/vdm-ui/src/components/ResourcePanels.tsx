import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

// =============================================================================
//  Config editors + multi-NIC managers + LXC snapshots for the VDM detail panels
//  All wire to the VDM proxy endpoints (which forward to each node's runner).
// =============================================================================

function SavedHint({ saved, error }: { saved: boolean; error?: string }) {
  if (error) return <span className="text-xs text-vdm-danger">{error}</span>;
  if (saved) return <span className="text-xs text-vdm-success">Saved · restart to apply where needed</span>;
  return null;
}

// ── VM config ────────────────────────────────────────────────────────────────
export function VmConfigForm({ node, name, vm }: { node: string; name: string; vm: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [vcpus, setVcpus] = useState<number>(Number(vm.vcpus) || 1);
  const [memoryMb, setMemoryMb] = useState<number>(Number(vm.memoryMb) || 512);
  const [autostart, setAutostart] = useState<boolean>(!!vm.autostart);
  const [qemuAgent, setQemuAgent] = useState<boolean>(!!vm.qemuAgentEnabled);
  const [tpm, setTpm] = useState<boolean>(!!vm.tpmEnabled);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () => api.put(`/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}/config`, {
      vcpus, memoryMb, autostart, qemuAgentEnabled: qemuAgent, tpmEnabled: tpm,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vm", node, name] }),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="vdm-card p-4 space-y-3 max-w-md">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Configuration</h3>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">vCPUs</label><input className="vdm-input" type="number" min={1} value={vcpus} onChange={(e) => setVcpus(parseInt(e.target.value, 10) || 1)} /></div>
        <div><label className="vdm-label">Memory (MB)</label><input className="vdm-input" type="number" min={128} step={128} value={memoryMb} onChange={(e) => setMemoryMb(parseInt(e.target.value, 10) || 512)} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm text-vdm-text"><input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} /> Autostart</label>
      <label className="flex items-center gap-2 text-sm text-vdm-text"><input type="checkbox" checked={qemuAgent} onChange={(e) => setQemuAgent(e.target.checked)} /> QEMU Guest Agent</label>
      <label className="flex items-center gap-2 text-sm text-vdm-text"><input type="checkbox" checked={tpm} onChange={(e) => setTpm(e.target.checked)} /> TPM 2.0</label>
      <div className="flex items-center gap-3">
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Saving…" : "Save"}</button>
        <SavedHint saved={save.isSuccess} error={err || undefined} />
      </div>
    </div>
  );
}

// ── LXC config ───────────────────────────────────────────────────────────────
export function LxcConfigForm({ node, name, ct }: { node: string; name: string; ct: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [cpuCores, setCpuCores] = useState<number>(Number(ct.cpus) || 1);
  const [memoryMb, setMemoryMb] = useState<number>(Number(ct.memoryMb) || 512);
  const [diskGb, setDiskGb] = useState<number>(Number(ct.rootfsSizeGb) || 8);
  const [autostart, setAutostart] = useState<boolean>(!!ct.autostart);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () => api.put(`/api/vdm/lxc/${encodeURIComponent(node)}/${encodeURIComponent(name)}/config`, { cpuCores, memoryMb, diskGb, autostart }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-lxc", node, name] }),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="vdm-card p-4 space-y-3 max-w-md">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Configuration</h3>
      <div className="grid grid-cols-3 gap-3">
        <div><label className="vdm-label">CPUs</label><input className="vdm-input" type="number" min={1} value={cpuCores} onChange={(e) => setCpuCores(parseInt(e.target.value, 10) || 1)} /></div>
        <div><label className="vdm-label">Memory (MB)</label><input className="vdm-input" type="number" min={64} step={64} value={memoryMb} onChange={(e) => setMemoryMb(parseInt(e.target.value, 10) || 512)} /></div>
        <div><label className="vdm-label">Disk (GB)</label><input className="vdm-input" type="number" min={diskGb} value={diskGb} onChange={(e) => setDiskGb(parseInt(e.target.value, 10) || diskGb)} /></div>
      </div>
      <p className="text-xs text-vdm-textMuted/70">Disk can only be expanded, not shrunk.</p>
      <label className="flex items-center gap-2 text-sm text-vdm-text"><input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} /> Autostart</label>
      <div className="flex items-center gap-3">
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Saving…" : "Save"}</button>
        <SavedHint saved={save.isSuccess} error={err || undefined} />
      </div>
    </div>
  );
}

// ── Docker config ──────────────────────────────────────────────────────────
export function DockerConfigForm({ node, id, ct }: { node: string; id: string; ct: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [restartPolicy, setRestartPolicy] = useState<string>(String(ct.restartPolicy ?? "unless-stopped"));
  const [memoryMb, setMemoryMb] = useState<number>(0);
  const [cpuLimit, setCpuLimit] = useState<number>(0);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () => api.put(`/api/vdm/docker/${encodeURIComponent(node)}/${encodeURIComponent(id)}/config`, {
      restartPolicy,
      ...(memoryMb ? { memoryMb } : {}),
      ...(cpuLimit ? { cpuLimit } : {}),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-docker", node, id] }),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="vdm-card p-4 space-y-3 max-w-md">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Configuration</h3>
      <div>
        <label className="vdm-label">Restart policy</label>
        <select className="vdm-input" value={restartPolicy} onChange={(e) => setRestartPolicy(e.target.value)}>
          {["no", "unless-stopped", "always", "on-failure"].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">CPU limit (0 = keep)</label><input className="vdm-input" type="number" min={0} value={cpuLimit} onChange={(e) => setCpuLimit(parseInt(e.target.value, 10) || 0)} /></div>
        <div><label className="vdm-label">Memory MB (0 = keep)</label><input className="vdm-input" type="number" min={0} value={memoryMb} onChange={(e) => setMemoryMb(parseInt(e.target.value, 10) || 0)} /></div>
      </div>
      <div className="flex items-center gap-3">
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Saving…" : "Save"}</button>
        <SavedHint saved={save.isSuccess} error={err || undefined} />
      </div>
    </div>
  );
}

// ── LXC multi-NIC ─────────────────────────────────────────────────────────
interface LxcNic { index: number; primary?: boolean; type: string; link: string; hwaddr?: string; ipv4?: string; ipv4Gateway?: string; }

export function LxcNetworks({ node, name }: { node: string; name: string }) {
  const qc = useQueryClient();
  const base = `/api/vdm/lxc/${encodeURIComponent(node)}/${encodeURIComponent(name)}/networks`;
  const nics = useQuery<LxcNic[]>({ queryKey: ["vdm-lxc-nics", node, name], queryFn: () => api.get(base) });
  const bridges = useQuery<Array<{ name: string }>>({ queryKey: ["vdm-node-bridges", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/bridges`) });
  const [adding, setAdding] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["vdm-lxc-nics", node, name] });
  const remove = useMutation({ mutationFn: (i: number) => api.delete(`${base}/${i}`), onSuccess: refresh });

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-xs text-vdm-textMuted bg-vdm-warning/10 border border-vdm-warning/30 rounded px-3 py-2">
        Network changes take effect after the container is restarted.
      </p>
      {(nics.data ?? []).map((nic) => editIndex === nic.index ? (
        <LxcNicForm key={nic.index} base={base} bridges={bridges.data ?? []} nic={nic} onDone={() => { setEditIndex(null); refresh(); }} onCancel={() => setEditIndex(null)} />
      ) : (
        <NicCard key={nic.index} title={`eth${nic.index}`} primary={!!nic.primary || nic.index === 0}
          rows={[["Bridge", nic.link], ["MAC", nic.hwaddr || "—"], ["IP", nic.ipv4 || "DHCP"], ...(nic.ipv4Gateway ? [["Gateway", nic.ipv4Gateway] as [string, string]] : [])]}
          onEdit={() => setEditIndex(nic.index)} onDelete={() => remove.mutate(nic.index)} deleting={remove.isPending} />
      ))}
      {remove.error && <p className="text-xs text-vdm-danger">{(remove.error as Error).message}</p>}
      {adding
        ? <LxcNicForm base={base} bridges={bridges.data ?? []} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />
        : <button className="vdm-btn-ghost" onClick={() => setAdding(true)}>+ Add network card</button>}
    </div>
  );
}

function LxcNicForm({ base, bridges, nic, onDone, onCancel }: {
  base: string; bridges: Array<{ name: string }>; nic?: LxcNic; onDone: () => void; onCancel: () => void;
}) {
  const editing = !!nic;
  const [bridge, setBridge] = useState(nic?.link || bridges[0]?.name || "lxcbr0");
  const [mac, setMac] = useState(nic?.hwaddr || "");
  const [mode, setMode] = useState<"dhcp" | "static">(nic?.ipv4 ? "static" : "dhcp");
  const [ip, setIp] = useState(nic?.ipv4 || "");
  const [gw, setGw] = useState(nic?.ipv4Gateway || "");
  const save = useMutation({
    mutationFn: () => {
      const body = { bridge, macAddress: mac || undefined, ipv4: mode === "dhcp" ? "dhcp" : ip || undefined, ipv4Gateway: mode === "dhcp" ? "" : gw || undefined };
      return editing ? api.put(`${base}/${nic!.index}`, body) : api.post(base, body);
    },
    onSuccess: onDone,
  });
  return (
    <div className="vdm-card p-4 space-y-3 border border-vdm-accent/40">
      <h4 className="text-sm font-semibold text-vdm-text">{editing ? `Edit eth${nic!.index}` : "Add network card"}</h4>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">Bridge</label>
          <select className="vdm-input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
            {bridges.length === 0 && <option value={bridge}>{bridge}</option>}
            {bridges.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </div>
        <div><label className="vdm-label">MAC</label><input className="vdm-input font-mono" value={mac} onChange={(e) => setMac(e.target.value.toLowerCase())} placeholder="auto" /></div>
        <div><label className="vdm-label">Mode</label>
          <select className="vdm-input" value={mode} onChange={(e) => setMode(e.target.value as "dhcp" | "static")}><option value="dhcp">DHCP</option><option value="static">Static</option></select>
        </div>
        <div><label className="vdm-label">IP (CIDR)</label><input className="vdm-input font-mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50/24" disabled={mode === "dhcp"} /></div>
        <div className="col-span-2"><label className="vdm-label">Gateway</label><input className="vdm-input font-mono" value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" disabled={mode === "dhcp"} /></div>
      </div>
      {save.error && <p className="text-xs text-vdm-danger">{(save.error as Error).message}</p>}
      <div className="flex gap-2"><button className="vdm-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{editing ? "Save" : "Add"}</button><button className="vdm-btn-ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

// ── Docker multi-NIC ───────────────────────────────────────────────────────
interface DockerNic { network: string; primary: boolean; ipAddress?: string; ipPrefixLen?: number; gateway?: string; macAddress?: string; }

export function DockerNetworks({ node, id }: { node: string; id: string }) {
  const qc = useQueryClient();
  const base = `/api/vdm/docker/${encodeURIComponent(node)}/${encodeURIComponent(id)}/networks`;
  const nics = useQuery<DockerNic[]>({ queryKey: ["vdm-docker-nics", node, id], queryFn: () => api.get(base) });
  const allNets = useQuery<Array<{ name: string }>>({ queryKey: ["vdm-node-dnets", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/docker-networks`) });
  const [adding, setAdding] = useState(false);
  const [network, setNetwork] = useState("");
  const [ipv4, setIpv4] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["vdm-docker-nics", node, id] });
  const connect = useMutation({ mutationFn: () => api.post(base, { network, ...(ipv4 ? { ipv4 } : {}) }), onSuccess: () => { setAdding(false); setNetwork(""); setIpv4(""); refresh(); } });
  const disconnect = useMutation({ mutationFn: (n: string) => api.delete(`${base}/${encodeURIComponent(n)}`), onSuccess: refresh });

  const attached = new Set((nics.data ?? []).map((n) => n.network));
  const available = (allNets.data ?? []).map((n) => n.name).filter((n) => !attached.has(n) && n !== "host" && n !== "none");
  const canDelete = (nics.data ?? []).length > 1;

  return (
    <div className="space-y-3 max-w-2xl">
      {(nics.data ?? []).map((nic) => (
        <NicCard key={nic.network} title={nic.network} primary={nic.primary || !canDelete}
          rows={[["IP", nic.ipAddress ? `${nic.ipAddress}${nic.ipPrefixLen ? `/${nic.ipPrefixLen}` : ""}` : "—"], ["Gateway", nic.gateway || "—"], ["MAC", nic.macAddress || "—"]]}
          onDelete={() => disconnect.mutate(nic.network)} deleting={disconnect.isPending} />
      ))}
      {disconnect.error && <p className="text-xs text-vdm-danger">{(disconnect.error as Error).message}</p>}
      {adding ? (
        <div className="vdm-card p-4 space-y-3 border border-vdm-accent/40">
          <h4 className="text-sm font-semibold text-vdm-text">Connect to a network</h4>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="vdm-label">Network</label>
              <select className="vdm-input" value={network} onChange={(e) => setNetwork(e.target.value)}><option value="">Choose…</option>{available.map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </div>
            <div><label className="vdm-label">IPv4 (optional)</label><input className="vdm-input font-mono" value={ipv4} onChange={(e) => setIpv4(e.target.value)} placeholder="172.20.0.10" /></div>
          </div>
          {connect.error && <p className="text-xs text-vdm-danger">{(connect.error as Error).message}</p>}
          <div className="flex gap-2"><button className="vdm-btn-primary" disabled={connect.isPending || !network} onClick={() => connect.mutate()}>Connect</button><button className="vdm-btn-ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      ) : (
        <button className="vdm-btn-ghost" disabled={available.length === 0} onClick={() => setAdding(true)}>+ Connect to a network</button>
      )}
    </div>
  );
}

// ── Shared NIC card ──────────────────────────────────────────────────────────
function NicCard({ title, primary, rows, onEdit, onDelete, deleting }: {
  title: string; primary: boolean; rows: [string, string][]; onEdit?: () => void; onDelete: () => void; deleting?: boolean;
}) {
  return (
    <div className="vdm-card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-vdm-text">{title}</span>
          {primary && <span className="pill-blue text-2xs">primary</span>}
        </div>
        <div className="flex items-center gap-2">
          {onEdit && <button className="vdm-btn-ghost text-xs" onClick={onEdit}>Edit</button>}
          <button className="vdm-btn-danger text-xs disabled:opacity-30 disabled:cursor-not-allowed" disabled={primary || deleting}
            title={primary ? "The primary card cannot be removed" : undefined} onClick={onDelete}>Delete</button>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-vdm-textMuted">{k}</dt><dd className="font-mono text-vdm-text text-right truncate">{v}</dd></div>))}
      </dl>
    </div>
  );
}

// ── LXC snapshots ──────────────────────────────────────────────────────────
interface VdmSnap { name: string; createdAt: string; description?: string }
export function LxcSnapshots({ node, name }: { node: string; name: string }) {
  const qc = useQueryClient();
  const base = `/api/vdm/lxc/${encodeURIComponent(node)}/${encodeURIComponent(name)}`;
  const snaps = useQuery<VdmSnap[]>({ queryKey: ["vdm-lxc-snaps", node, name], queryFn: () => api.get(`${base}/snapshots`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["vdm-lxc-snaps", node, name] });
  const create = useMutation({ mutationFn: (snapName: string) => api.post(`${base}/snapshot`, { snapName }), onSuccess: refresh });
  const rollback = useMutation({ mutationFn: (s: string) => api.post(`${base}/snapshot/${encodeURIComponent(s)}/rollback`) });
  const del = useMutation({ mutationFn: (s: string) => api.delete(`${base}/snapshot/${encodeURIComponent(s)}`), onSuccess: refresh });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button className="vdm-btn-primary" onClick={() => { const n = prompt("Snapshot name:"); if (n) create.mutate(n); }}>+ New Snapshot</button>
      </div>
      <div className="vdm-card divide-y divide-vdm-border/50">
        {(snaps.data ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-vdm-textMuted text-center">No snapshots</p>
        ) : (snaps.data ?? []).map((s) => (
          <div key={s.name} className="flex items-center gap-3 px-4 py-3">
            <span className="font-mono text-sm text-vdm-text flex-1">{s.name}</span>
            <span className="text-xs text-vdm-textMuted">{s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}</span>
            <button className="vdm-btn-warning text-xs" onClick={() => { if (confirm(`Rollback to ${s.name}?`)) rollback.mutate(s.name); }}>Rollback</button>
            <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete snapshot ${s.name}?`)) del.mutate(s.name); }}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
