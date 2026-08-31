import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useConfirm, usePrompt } from "@/hooks/useDialog";
import type { VdmVmInfo } from "@/types/vdm";

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

// ── Docker config (full edit → recreate) ─────────────────────────────────
export function DockerConfigForm({ node, id, ct }: { node: string; id: string; ct: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [restartPolicy, setRestartPolicy] = useState<string>(String(ct.restartPolicy ?? "unless-stopped"));
  const [image, setImage] = useState<string>(String(ct.image ?? ""));
  const [command, setCommand] = useState<string>(String(ct.command ?? ""));
  const [memoryMb, setMemoryMb] = useState<number>(0);
  const [cpuLimit, setCpuLimit] = useState<number>(0);
  const [privileged, setPrivileged] = useState<boolean>(Boolean(ct.privileged));
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () => api.put(`/api/vdm/docker/${encodeURIComponent(node)}/${encodeURIComponent(id)}/recreate`, {
      restartPolicy,
      ...(image ? { image } : {}),
      ...(command ? { command } : {}),
      ...(memoryMb ? { memoryMb } : {}),
      ...(cpuLimit ? { cpuLimit } : {}),
      privileged,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-docker", node, id] }),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="vdm-card p-4 space-y-3 max-w-md">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Edit Container (recreates)</h3>
      <p className="text-xs text-vdm-warning bg-vdm-warning/10 border border-vdm-warning/30 rounded px-3 py-2">
        Editing recreates the container (stop + remove + recreate). Volumes and data are preserved.
      </p>
      <div>
        <label className="vdm-label">Image</label>
        <input className="vdm-input font-mono" value={image} onChange={(e) => setImage(e.target.value)} />
      </div>
      <div>
        <label className="vdm-label">Command (optional)</label>
        <input className="vdm-input font-mono" value={command} onChange={(e) => setCommand(e.target.value)} />
      </div>
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
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" className="accent-vdm-accent" checked={privileged} onChange={(e) => setPrivileged(e.target.checked)} />
        <span className="text-sm text-vdm-text">Privileged mode</span>
      </label>
      <div className="flex items-center gap-3">
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Recreating…" : "Save & Recreate"}</button>
        <SavedHint saved={save.isSuccess} error={err || undefined} />
      </div>
    </div>
  );
}

// ── Docker exec ───────────────────────────────────────────────────────────
export function DockerExec({ node, id }: { node: string; id: string }) {
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  const [err, setErr] = useState("");
  const run = useMutation({
    mutationFn: () => api.post<{ stdout: string; stderr: string }>(`/api/vdm/docker/${encodeURIComponent(node)}/${encodeURIComponent(id)}/exec`, { command }),
    onSuccess: (res) => { setOutput([res.stdout, res.stderr].filter(Boolean).join("\n")); setErr(""); },
    onError: (e: Error) => setErr(e.message),
  });
  return (
    <div className="vdm-card p-4 space-y-3 max-w-2xl">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Execute</h3>
      <div className="flex gap-2">
        <input className="vdm-input font-mono flex-1" placeholder="e.g. ls -la /app" value={command} onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && command.trim()) run.mutate(); }} />
        <button className="vdm-btn-primary" disabled={run.isPending || !command.trim()} onClick={() => run.mutate()}>{run.isPending ? "Running…" : "Run"}</button>
      </div>
      {err && <p className="text-xs text-vdm-danger">{err}</p>}
      {output && <pre className="bg-[#0d1117] rounded-lg p-3 text-xs font-mono text-vdm-textMuted overflow-auto max-h-72 whitespace-pre-wrap break-all">{output}</pre>}
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
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { prompt, dialog: promptDialog } = usePrompt();

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button className="vdm-btn-primary" onClick={async () => { const n = await prompt({ title: "New snapshot", label: "Snapshot name", placeholder: "snapshot-name" }); if (n) create.mutate(n); }}>+ New Snapshot</button>
      </div>
      <div className="vdm-card divide-y divide-vdm-border/50">
        {(snaps.data ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-vdm-textMuted text-center">No snapshots</p>
        ) : (snaps.data ?? []).map((s) => (
          <div key={s.name} className="flex items-center gap-3 px-4 py-3">
            <span className="font-mono text-sm text-vdm-text flex-1">{s.name}</span>
            <span className="text-xs text-vdm-textMuted">{s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}</span>
            <button className="vdm-btn-warning text-xs" onClick={async () => { if (await confirm({ title: `Rollback to ${s.name}?`, message: "The container state will be reverted to this snapshot.", confirmLabel: "Rollback", tone: "warning" })) rollback.mutate(s.name); }}>Rollback</button>
            <button className="vdm-btn-danger text-xs" onClick={async () => { if (await confirm({ title: `Delete snapshot ${s.name}?`, message: "This snapshot will be permanently removed.", confirmLabel: "Delete" })) del.mutate(s.name); }}>Delete</button>
          </div>
        ))}
      </div>
      {confirmDialog}
      {promptDialog}
    </div>
  );
}

// ── VM hardware (disks / NICs / ISO drive) ──────────────────────────────────
// The VDM panel used to expose only vCPU/RAM/flags for a VM: disks, network
// cards and the ISO drive could be edited from the single-node panel but not
// from the datacenter view. These call the /disk, /network and /iso relays.

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** qemu_info returns the CD drive alongside the data disks; only the latter
 *  can be resized or detached. */
function isCdrom(disk: { deviceType?: string }): boolean {
  return disk.deviceType === "cdrom";
}

export function VmHardwarePanel({ node, name, vm }: { node: string; name: string; vm: VdmVmInfo }) {
  const qc = useQueryClient();
  const base = `/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}`;
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { prompt, dialog: promptDialog } = usePrompt();
  const [addDisk, setAddDisk] = useState(false);
  const [addNic, setAddNic] = useState(false);
  const [editNic, setEditNic] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: ["vdm-vm", node, name] });
  const fail = (e: Error) => setErr(e.message);

  const pools = useQuery<Array<{ name: string; type?: string }>>({
    queryKey: ["vdm-node-pools", node], queryFn: () => api.get(`/api/vdm/nodes/${encodeURIComponent(node)}/storage`),
  });
  const bridges = useQuery<Array<{ name: string }>>({
    queryKey: ["vdm-node-bridges", node], queryFn: () => api.get(`/api/vdm/nodes/${encodeURIComponent(node)}/bridges`),
  });
  const isos = useQuery<Array<{ filename: string; nodeName: string; sizeBytes: number }>>({
    queryKey: ["vdm-isos"], queryFn: () => api.get("/api/vdm/isos"),
  });

  const detachDisk = useMutation({
    mutationFn: (device: string) => api.post(`${base}/disk/detach`, { device }),
    onSuccess: refresh, onError: fail,
  });
  const resizeDisk = useMutation({
    mutationFn: (p: { device: string; sizeGb: number }) => api.post(`${base}/disk/resize`, p),
    onSuccess: refresh, onError: fail,
  });
  const detachNic = useMutation({
    mutationFn: (mac: string) => api.delete(`${base}/network/${encodeURIComponent(mac)}`),
    onSuccess: refresh, onError: fail,
  });
  const attachIso = useMutation({
    mutationFn: (isoFile: string) => api.post(`${base}/iso/attach`, { isoFile }),
    onSuccess: refresh, onError: fail,
  });
  const ejectIso = useMutation({
    mutationFn: () => api.post(`${base}/iso/eject`),
    onSuccess: refresh, onError: fail,
  });

  const disks = (vm.disks ?? []).filter((d) => !isCdrom(d));
  const nics = vm.networks ?? [];
  const nodeIsos = (isos.data ?? []).filter((i) => i.nodeName === node);
  const running = vm.state === "running";

  return (
    <div className="space-y-5 max-w-3xl">
      {err && <p className="text-xs text-vdm-danger bg-vdm-danger/10 border border-vdm-danger/30 rounded px-3 py-2">{err}</p>}
      <p className="text-xs text-vdm-textMuted bg-vdm-warning/10 border border-vdm-warning/30 rounded px-3 py-2">
        Hardware changes apply to the VM definition. Attach/detach on a running VM may require a restart to be visible in the guest.
      </p>

      {/* ── ISO drive ── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">CD/DVD drive</h3>
        <div className="vdm-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-mono text-vdm-text truncate">{vm.mountedIso || "No disc"}</span>
            {vm.mountedIso && (
              <button className="vdm-btn-danger text-xs" disabled={ejectIso.isPending} onClick={() => { setErr(""); ejectIso.mutate(); }}>
                {ejectIso.isPending ? "Ejecting…" : "Eject"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select className="vdm-input flex-1" defaultValue="" onChange={(e) => { if (e.target.value) { setErr(""); attachIso.mutate(e.target.value); e.target.value = ""; } }}>
              <option value="">{nodeIsos.length ? "Insert an ISO…" : "No ISO available on this node"}</option>
              {nodeIsos.map((i) => <option key={i.filename} value={i.filename}>{i.filename} ({formatBytes(i.sizeBytes)})</option>)}
            </select>
          </div>
        </div>
      </section>

      {/* ── Disks ── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Disks</h3>
        {disks.length === 0 && <p className="text-sm text-vdm-textMuted italic">No disk attached.</p>}
        {disks.map((d) => (
          <NicCard
            key={d.device}
            title={d.device}
            primary={false}
            rows={[["Size", formatBytes(d.sizeBytes)], ["Format", d.format || "—"], ["Bus", d.bus || "—"], ["Path", d.source || "—"], ["Mode", d.readonly ? "read-only" : "read-write"]]}
            onEdit={async () => {
              const currentGb = Math.max(1, Math.round(d.sizeBytes / 1024 ** 3));
              const v = await prompt({ title: `Resize ${d.device}`, label: `New size in GB (current: ${currentGb} GB — growing only)`, placeholder: String(currentGb + 10) });
              const sizeGb = Number(v);
              if (!v || !Number.isFinite(sizeGb) || sizeGb <= 0) return;
              setErr("");
              resizeDisk.mutate({ device: d.device, sizeGb });
            }}
            onDelete={async () => {
              if (await confirm({ title: `Detach ${d.device}?`, message: "The disk is removed from the VM. Its image file is kept on the storage pool.", confirmLabel: "Detach" })) {
                setErr("");
                detachDisk.mutate(d.device);
              }
            }}
            deleting={detachDisk.isPending}
          />
        ))}
        {addDisk
          ? <AttachDiskForm base={base} pools={pools.data ?? []} onDone={() => { setAddDisk(false); refresh(); }} onCancel={() => setAddDisk(false)} />
          : <button className="vdm-btn-ghost" onClick={() => { setErr(""); setAddDisk(true); }}>+ Add disk</button>}
      </section>

      {/* ── Network cards ── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Network cards</h3>
        {nics.length === 0 && <p className="text-sm text-vdm-textMuted italic">No network card.</p>}
        {nics.map((n, i) => editNic === n.mac ? (
          <VmNicForm key={n.mac} base={base} bridges={bridges.data ?? []} nic={n} onDone={() => { setEditNic(null); refresh(); }} onCancel={() => setEditNic(null)} />
        ) : (
          <NicCard
            key={n.mac}
            title={`net${i}`}
            primary={false}
            rows={[["Bridge", n.source || "—"], ["MAC", n.mac], ["Model", n.model || "virtio"]]}
            onEdit={() => { setErr(""); setEditNic(n.mac); }}
            onDelete={async () => {
              if (await confirm({ title: `Detach ${n.mac}?`, message: running ? "The VM is running; the guest will lose this interface." : "This network card will be removed from the VM.", confirmLabel: "Detach" })) {
                setErr("");
                detachNic.mutate(n.mac);
              }
            }}
            deleting={detachNic.isPending}
          />
        ))}
        {addNic
          ? <VmNicForm base={base} bridges={bridges.data ?? []} onDone={() => { setAddNic(false); refresh(); }} onCancel={() => setAddNic(false)} />
          : <button className="vdm-btn-ghost" onClick={() => { setErr(""); setAddNic(true); }}>+ Add network card</button>}
      </section>

      {confirmDialog}
      {promptDialog}
    </div>
  );
}

function AttachDiskForm({ base, pools, onDone, onCancel }: {
  base: string; pools: Array<{ name: string; type?: string }>; onDone: () => void; onCancel: () => void;
}) {
  const [sizeGb, setSizeGb] = useState(10);
  const [bus, setBus] = useState<"virtio" | "sata" | "scsi" | "ide">("virtio");
  const [format, setFormat] = useState<"qcow2" | "raw">("qcow2");
  const [storagePool, setStoragePool] = useState(pools[0]?.name ?? "");
  const save = useMutation({
    mutationFn: () => api.post(`${base}/disk/attach`, { sizeGb, bus, format, ...(storagePool ? { storagePool } : {}) }),
    onSuccess: onDone,
  });
  return (
    <div className="vdm-card p-4 space-y-3 border border-vdm-accent/40">
      <h4 className="text-sm font-semibold text-vdm-text">Add disk</h4>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="vdm-label">Size (GB)</label><input className="vdm-input" type="number" min={1} value={sizeGb} onChange={(e) => setSizeGb(parseInt(e.target.value, 10) || 1)} /></div>
        <div><label className="vdm-label">Storage pool</label>
          <select className="vdm-input" value={storagePool} onChange={(e) => setStoragePool(e.target.value)}>
            {pools.length === 0 && <option value="">default</option>}
            {pools.map((p) => <option key={p.name} value={p.name}>{p.name}{p.type ? ` (${p.type})` : ""}</option>)}
          </select>
        </div>
        <div><label className="vdm-label">Bus</label>
          <select className="vdm-input" value={bus} onChange={(e) => setBus(e.target.value as typeof bus)}>
            {(["virtio", "sata", "scsi", "ide"] as const).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div><label className="vdm-label">Format</label>
          <select className="vdm-input" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            {(["qcow2", "raw"] as const).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
      {save.error && <p className="text-xs text-vdm-danger">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Attaching…" : "Attach"}</button>
      </div>
    </div>
  );
}

function VmNicForm({ base, bridges, nic, onDone, onCancel }: {
  base: string; bridges: Array<{ name: string }>; nic?: { mac: string; source: string; model: string };
  onDone: () => void; onCancel: () => void;
}) {
  const editing = !!nic;
  const [bridge, setBridge] = useState(nic?.source || bridges[0]?.name || "vmbr0");
  const [model, setModel] = useState<"virtio" | "e1000" | "rtl8139">((nic?.model as "virtio") || "virtio");
  const [mac, setMac] = useState(editing ? nic!.mac : "");
  const save = useMutation({
    mutationFn: () => {
      const macValue = mac.trim();
      if (editing) return api.put(`${base}/network/${encodeURIComponent(nic!.mac)}`, { bridge, model, ...(macValue && macValue !== nic!.mac ? { mac: macValue } : {}) });
      return api.post(`${base}/network/attach`, { bridge, model, ...(macValue ? { mac: macValue } : {}) });
    },
    onSuccess: onDone,
  });
  return (
    <div className="vdm-card p-4 space-y-3 border border-vdm-accent/40">
      <h4 className="text-sm font-semibold text-vdm-text">{editing ? `Edit ${nic!.mac}` : "Add network card"}</h4>
      <div className="grid grid-cols-3 gap-3">
        <div><label className="vdm-label">Bridge</label>
          <select className="vdm-input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
            {bridges.length === 0 && <option value={bridge}>{bridge}</option>}
            {bridges.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </div>
        <div><label className="vdm-label">Model</label>
          <select className="vdm-input" value={model} onChange={(e) => setModel(e.target.value as typeof model)}>
            {(["virtio", "e1000", "rtl8139"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div><label className="vdm-label">MAC {editing ? "" : "(optional)"}</label>
          <input className="vdm-input font-mono" placeholder="aa:bb:cc:dd:ee:ff" value={mac} onChange={(e) => setMac(e.target.value)} />
        </div>
      </div>
      {save.error && <p className="text-xs text-vdm-danger">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="vdm-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : editing ? "Save" : "Attach"}</button>
      </div>
    </div>
  );
}
