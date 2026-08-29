import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import { useConfirm } from "@/hooks/useDialog";
import type { VdmNode, VdmSharedStorage, VdmNodePool } from "@/types/vdm";

interface VdmIso {
  filename: string;
  displayName?: string;
  sizeBytes: number;
  createdAt?: string | null;
  storagePool?: string | null;
  type?: string;
  nodeName: string;
  nodeDisplayName: string;
}

interface DepotItem {
  id: string;
  name: string;
  filename: string;
  type: "iso" | "vm";
  arch: string;
  sizeBytes?: number;
  alreadyImported?: boolean;
  url?: string;
}

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  iso: "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3",
  copy: "M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75m9 10.5h3.375c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125h-9.75A1.125 1.125 0 0 0 8.25 4.875V7.5",
  download: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3",
  upload: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5",
  url: "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244",
  catalog: "M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z",
  close: "M6 18 18 6M6 6l12 12",
  trash: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
};

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ── Storage picker (local node pool OR shared storage) ─────────────────────
function StoragePicker({ node, nodes, storages, value, onChange }: {
  node: string; nodes: VdmNode[]; storages: VdmSharedStorage[];
  value: { kind: "local" | "shared"; pool?: string; shared?: string };
  onChange: (v: { kind: "local" | "shared"; pool?: string; shared?: string }) => void;
}) {
  const poolsQuery = useQuery<VdmNodePool[]>({
    queryKey: ["vdm-node-pools", node],
    queryFn: () => api.get(`/api/vdm/nodes/${encodeURIComponent(node)}/storage`),
    enabled: !!node,
  });
  const pools = (poolsQuery.data ?? []).filter((p) => {
    // Local directory pools are always available; only network/FUSE pools
    // (nfs/cifs/s3/glusterfs) are filtered by their mount state.
    const networkTypes = new Set(["nfs", "nfs4", "cifs", "smbfs", "glusterfs", "s3"]);
    if (!networkTypes.has(p.type ?? "")) return true;
    return p.mounted !== false;
  });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onChange({ kind: "local" })}
          className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${value.kind === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
          Local storage
        </button>
        <button type="button" onClick={() => onChange({ kind: "shared" })}
          className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${value.kind === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
          Shared storage
        </button>
      </div>
      {value.kind === "local" ? (
        <select className="vdm-input" value={value.pool ?? ""} onChange={(e) => onChange({ kind: "local", pool: e.target.value })}>
          <option value="">Select local pool…</option>
          {pools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      ) : (
        <select className="vdm-input" value={value.shared ?? ""} onChange={(e) => onChange({ kind: "shared", shared: e.target.value })}>
          <option value="">Select shared storage…</option>
          {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.type})</option>)}
        </select>
      )}
    </div>
  );
}

// ── Copy modal (target node + storage) ─────────────────────────────────────
function CopyIsoModal({ open, onClose, iso, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; iso: VdmIso | null; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (targetNode: string, targetStoragePool: string | undefined, sharedStorageName: string | undefined) => void;
}) {
  const [targetNode, setTargetNode] = useState("");
  const [storage, setStorage] = useState<{ kind: "local" | "shared"; pool?: string; shared?: string }>({ kind: "local" });
  if (!open || !iso) return null;
  const candidates = nodes.filter((n) => n.name !== iso.nodeName && n.status === "online");
  const ready = !!targetNode && (storage.kind === "local" ? !!storage.pool : !!storage.shared);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Copy ISO: {iso.filename}</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={targetNode} onChange={(e) => { setTargetNode(e.target.value); setStorage({ kind: "local" }); }}>
            <option value="">Select node...</option>
            {candidates.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
          {candidates.length === 0 && <p className="text-xs text-vdm-textMuted mt-1">No other online node available.</p>}
        </div>
        {targetNode && <StoragePicker node={targetNode} nodes={nodes} storages={storages} value={storage} onChange={setStorage} />}
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!ready} onClick={() => { if (ready) { onSubmit(targetNode, storage.kind === "local" ? storage.pool : undefined, storage.kind === "shared" ? storage.shared : undefined); onClose(); } }}>Copy</button>
        </div>
      </div>
    </div>
  );
}

// ── Upload modal (file) ─────────────────────────────────────────────────────
function UploadModal({ open, onClose, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (node: string, file: File, type: string, storagePool: string | undefined) => void;
}) {
  const [node, setNode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState("iso");
  const [storage, setStorage] = useState<{ kind: "local" | "shared"; pool?: string; shared?: string }>({ kind: "local" });
  if (!open) return null;
  const online = nodes.filter((n) => n.status === "online");
  const ready = !!node && !!file && (storage.kind === "local" ? !!storage.pool : !!storage.shared);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Upload file</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={node} onChange={(e) => { setNode(e.target.value); setStorage({ kind: "local" }); }}>
            <option value="">Select node...</option>
            {online.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>
        <div>
          <label className="vdm-label">Type</label>
          <select className="vdm-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="iso">ISO image</option>
            <option value="lxc_template">LXC template</option>
            <option value="vm_disk">VM disk</option>
          </select>
        </div>
        <div>
          <label className="vdm-label">File</label>
          <input type="file" className="vdm-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {node && <StoragePicker node={node} nodes={nodes} storages={storages} value={storage} onChange={setStorage} />}
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!ready} onClick={() => { if (ready && file) { onSubmit(node, file, type, storage.kind === "local" ? storage.pool : storage.shared); onClose(); } }}>Upload</button>
        </div>
      </div>
    </div>
  );
}

// ── Download-from-URL modal ─────────────────────────────────────────────────
function UrlModal({ open, onClose, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (node: string, url: string, displayName: string, type: string, storagePool: string | undefined) => void;
}) {
  const [node, setNode] = useState("");
  const [url, setUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState("iso");
  const [storage, setStorage] = useState<{ kind: "local" | "shared"; pool?: string; shared?: string }>({ kind: "local" });
  if (!open) return null;
  const online = nodes.filter((n) => n.status === "online");
  const ready = !!node && !!url.trim() && (storage.kind === "local" ? !!storage.pool : !!storage.shared);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Download from URL</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={node} onChange={(e) => { setNode(e.target.value); setStorage({ kind: "local" }); }}>
            <option value="">Select node...</option>
            {online.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>
        <div>
          <label className="vdm-label">Type</label>
          <select className="vdm-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="iso">ISO image</option>
            <option value="lxc_template">LXC template</option>
            <option value="vm_disk">VM disk</option>
          </select>
        </div>
        <div>
          <label className="vdm-label">URL</label>
          <input className="vdm-input font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div>
          <label className="vdm-label">Display name (optional)</label>
          <input className="vdm-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="my-image.iso" />
        </div>
        {node && <StoragePicker node={node} nodes={nodes} storages={storages} value={storage} onChange={setStorage} />}
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!ready} onClick={() => { if (ready) { onSubmit(node, url.trim(), displayName.trim(), type, storage.kind === "local" ? storage.pool : storage.shared); onClose(); } }}>Download</button>
        </div>
      </div>
    </div>
  );
}

// ── Depot modal (catalogue) ─────────────────────────────────────────────────
function DepotModal({ open, onClose, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (node: string, id: string, storagePool: string | undefined) => void;
}) {
  const [node, setNode] = useState("");
  const [storage, setStorage] = useState<{ kind: "local" | "shared"; pool?: string; shared?: string }>({ kind: "local" });
  const depotQuery = useQuery<{ base: string; items: DepotItem[] }>({ queryKey: ["vdm-depot"], queryFn: () => api.get("/api/vdm/templates/depot") });
  if (!open) return null;
  const online = nodes.filter((n) => n.status === "online");
  const items = depotQuery.data?.items ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-vdm-text">Catalogue (depot)</h3>
          <button className="vdm-btn-ghost text-xs" onClick={onClose}><Icon path={ICONS.close} className="w-3.5 h-3.5" /></button>
        </div>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={node} onChange={(e) => { setNode(e.target.value); setStorage({ kind: "local" }); }}>
            <option value="">Select node...</option>
            {online.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>
        {node && <StoragePicker node={node} nodes={nodes} storages={storages} value={storage} onChange={setStorage} />}
        <div className="vdm-card divide-y divide-vdm-border/50 max-h-80 overflow-y-auto">
          {depotQuery.isLoading ? (
            <div className="p-6 flex justify-center"><div className="w-5 h-5 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-vdm-textMuted">No depot items available.</p>
          ) : items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2">
              <Icon path={item.type === "iso" ? ICONS.iso : ICONS.catalog} className="w-4 h-4 text-vdm-accent flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-vdm-text truncate">{item.name}</p>
                <p className="text-xs text-vdm-textMuted">{item.type} · {item.arch}{item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}</p>
              </div>
              <button className="vdm-btn-primary text-xs" disabled={!node || item.alreadyImported || (storage.kind === "local" ? !storage.pool : !storage.shared)}
                onClick={() => { if (node) { onSubmit(node, item.id, storage.kind === "local" ? storage.pool : storage.shared); onClose(); } }}>
                {item.alreadyImported ? "Imported" : "Import"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function IsosPage() {
  const { isAdmin } = useVdmAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [copyTarget, setCopyTarget] = useState<VdmIso | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [showDepot, setShowDepot] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const isosQuery = useQuery<VdmIso[]>({ queryKey: ["vdm-isos"], queryFn: () => api.get("/api/vdm/isos"), refetchInterval: 30_000 });
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const storagesQuery = useQuery<VdmSharedStorage[]>({ queryKey: ["vdm-storage"], queryFn: () => api.get("/api/vdm/storage") });

  const copyMut = useMutation({
    mutationFn: (p: { sourceNode: string; filename: string; targetNode: string; targetStoragePool?: string; sharedStorageName?: string }) => api.post("/api/vdm/isos/copy", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const uploadMut = useMutation({
    mutationFn: (p: { node: string; file: File; type: string; storagePool: string | undefined }) => {
      const form = new FormData();
      form.append("file", p.file);
      form.append("type", p.type);
      if (p.storagePool) form.append("storagePool", p.storagePool);
      return api.upload(`/api/vdm/nodes/${encodeURIComponent(p.node)}/storage/isos/upload`, form);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const urlMut = useMutation({
    mutationFn: (p: { node: string; url: string; displayName: string; type: string; storagePool: string | undefined }) =>
      api.post(`/api/vdm/nodes/${encodeURIComponent(p.node)}/storage/isos/from-url`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const depotMut = useMutation({
    mutationFn: (p: { node: string; id: string; storagePool: string | undefined }) => api.post("/api/vdm/templates/depot/import", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const deleteMut = useMutation({
    mutationFn: (p: { node: string; filename: string; type: string }) =>
      api.delete(`/api/vdm/nodes/${encodeURIComponent(p.node)}/storage/isos/${encodeURIComponent(p.filename)}?type=${encodeURIComponent(p.type)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-isos"] }); },
  });

  const isos = isosQuery.data ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = isos.filter((iso) => {
    if (typeFilter !== "all" && (iso.type ?? "iso") !== typeFilter) return false;
    if (!needle) return true;
    return `${iso.filename} ${iso.nodeDisplayName} ${iso.nodeName}`.toLowerCase().includes(needle);
  });
  const downloadUrl = (iso: VdmIso) => `/api/vdm/nodes/${encodeURIComponent(iso.nodeName)}/isos/${encodeURIComponent(iso.filename)}/download`;

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">ISO &amp; Templates Library</h1>
          <p className="text-sm text-vdm-textMuted">{isos.length} file{isos.length !== 1 ? "s" : ""} across all nodes</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="vdm-input w-40" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            <option value="iso">ISO</option>
            <option value="lxc_template">LXC template</option>
            <option value="docker_image">Docker image</option>
            <option value="vm_disk">VM disk</option>
          </select>
          <input className="vdm-input w-48" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {isAdmin && (
            <>
              <button className="vdm-btn-primary text-xs inline-flex items-center gap-1" onClick={() => setShowUpload(true)}>
                <Icon path={ICONS.upload} className="w-3.5 h-3.5" />Upload
              </button>
              <button className="vdm-btn-ghost text-xs inline-flex items-center gap-1" onClick={() => setShowUrl(true)}>
                <Icon path={ICONS.url} className="w-3.5 h-3.5" />From URL
              </button>
              <button className="vdm-btn-ghost text-xs inline-flex items-center gap-1" onClick={() => setShowDepot(true)}>
                <Icon path={ICONS.catalog} className="w-3.5 h-3.5" />Catalogue
              </button>
            </>
          )}
        </div>
      </div>

      <div className="vdm-card overflow-x-auto">
        {isosQuery.isLoading ? (
          <div className="p-10 flex justify-center"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-vdm-textMuted">No files found.</div>
        ) : (
          <table className="vdm-table">
            <thead><tr><th>Name</th><th>Type</th><th>Node</th><th>Size</th><th>Storage</th><th></th></tr></thead>
            <tbody>
              {filtered.map((iso) => (
                <tr key={`${iso.nodeName}:${iso.filename}`} className="hover:bg-vdm-bg/40">
                  <td>
                    <div className="flex items-center gap-2">
                      <Icon path={ICONS.iso} className="w-4 h-4 text-vdm-accent" />
                      <span className="font-mono text-xs text-vdm-text truncate max-w-56" title={iso.filename}>{iso.filename}</span>
                    </div>
                  </td>
                  <td><span className="pill-gray text-[10px]">{iso.type ?? "iso"}</span></td>
                  <td className="text-sm text-vdm-textMuted">{iso.nodeDisplayName}</td>
                  <td className="text-xs text-vdm-textMuted">{formatBytes(iso.sizeBytes)}</td>
                  <td className="text-xs text-vdm-textMuted">{iso.storagePool ?? "local"}</td>
                  <td className="text-right space-x-2 whitespace-nowrap">
                    <a className="vdm-btn-ghost text-xs inline-flex items-center gap-1" href={downloadUrl(iso)}>
                      <Icon path={ICONS.download} className="w-3.5 h-3.5" />Download
                    </a>
                    {isAdmin && (
                      <>
                        <button className="vdm-btn-ghost text-xs inline-flex items-center gap-1" onClick={() => setCopyTarget(iso)}>
                          <Icon path={ICONS.copy} className="w-3.5 h-3.5" />Copy…
                        </button>
                        <button className="vdm-btn-danger text-xs inline-flex items-center gap-1" onClick={async () => {
                          if (await confirm({ title: `Delete ${iso.filename}?`, message: "This file will be permanently removed from the node.", confirmLabel: "Delete" })) {
                            deleteMut.mutate({ node: iso.nodeName, filename: iso.filename, type: iso.type ?? "iso" });
                          }
                        }}>
                          <Icon path={ICONS.trash} className="w-3.5 h-3.5" />Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CopyIsoModal open={!!copyTarget} iso={copyTarget} nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onClose={() => setCopyTarget(null)}
        onSubmit={(t, p, s) => copyTarget && copyMut.mutate({ sourceNode: copyTarget.nodeName, filename: copyTarget.filename, targetNode: t, targetStoragePool: p, sharedStorageName: s })} />
      <UploadModal open={showUpload} nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onClose={() => setShowUpload(false)}
        onSubmit={(n, f, t, s) => uploadMut.mutate({ node: n, file: f, type: t, storagePool: s })} />
      <UrlModal open={showUrl} nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onClose={() => setShowUrl(false)}
        onSubmit={(n, u, d, t, s) => urlMut.mutate({ node: n, url: u, displayName: d, type: t, storagePool: s })} />
      <DepotModal open={showDepot} nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
        onClose={() => setShowDepot(false)}
        onSubmit={(n, id, s) => depotMut.mutate({ node: n, id, storagePool: s })} />
      {confirmDialog}
    </div>
  );
}
