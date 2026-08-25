import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import type { VdmSharedStorage, VdmNode, VdmStorageNodeStatus } from "@/types/vdm";

// ── Icon ────────────────────────────────────────────────────────────────────
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

// ── Icons paths ─────────────────────────────────────────────────────────────
const ICONS = {
  db: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625",
  server: "M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z",
  plus: "M12 4.5v15m7.5-7.5h-15",
  link: "M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z",
  check: "M4.5 12.75l6 6 9-13.5",
  x: "M6 18 18 6M6 6l12 12",
  refresh: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
  info: "m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z",
  trash: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
};

// ── Types ───────────────────────────────────────────────────────────────────
interface StorageForm {
  name: string;
  displayName: string;
  type: "nfs" | "smb" | "cifs" | "glusterfs" | "s3";
  source: string;
  localMountPath: string;
  smbUsername: string;
  smbPassword: string;
  smbDomain: string;
  smbVersion: string;
  nfsVersion: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Provider: string;
  s3VfsCacheMode: string;
  notes: string;
}

const DEFAULT_FORM: StorageForm = {
  name: "", displayName: "", type: "nfs", source: "",
  localMountPath: "/mnt/vdm-shared", smbUsername: "", smbPassword: "",
  smbDomain: "", smbVersion: "", nfsVersion: "",
  s3Endpoint: "", s3Bucket: "", s3Region: "", s3AccessKey: "", s3SecretKey: "",
  s3Provider: "generic", s3VfsCacheMode: "off", notes: "",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function typeLabel(type: string): string {
  if (type === "nfs") return "NFS";
  if (type === "smb" || type === "cifs") return "SMB/CIFS";
  if (type === "glusterfs") return "GlusterFS";
  if (type === "s3") return "S3 / Object";
  return type.toUpperCase();
}

function typeIconPath(type: string): string {
  if (type === "s3") return ICONS.server;
  return type === "nfs" ? ICONS.db : ICONS.server;
}

// ── Add Storage Modal ────────────────────────────────────────────────────────
function AddStorageModal({ open, onClose, onSave, isPending }: {
  open: boolean; onClose: () => void;
  onSave: (f: StorageForm) => void; isPending: boolean;
}) {
  const [form, setForm] = useState<StorageForm>(DEFAULT_FORM);
  if (!open) return null;

  const set = <K extends keyof StorageForm>(k: K, v: StorageForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isSmb = form.type === "smb" || form.type === "cifs";
  const isNfs = form.type === "nfs";
  const isS3 = form.type === "s3";

  const sourceLabel = isNfs ? "NFS Source (host:/export)" : isSmb ? "SMB Share (//host/share)" : isS3 ? "S3 Endpoint (optional for AWS)" : "GlusterFS (host:/volume)";
  const sourcePlaceholder = isNfs ? "192.168.1.100:/exports/backups" : isSmb ? "//nas.local/backups" : isS3 ? "https://s3.amazonaws.com" : "gluster1:/gv0";

  const handleSave = () => {
    if (!form.name || !form.localMountPath) return;
    if (form.type !== "s3" && !form.source) return;
    if (isS3 && (!form.s3Bucket || !form.s3AccessKey || !form.s3SecretKey)) return;
    onSave(form);
    onClose();
    setForm(DEFAULT_FORM);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-xl p-6 space-y-5 overflow-y-auto max-h-[90vh]">
        <div>
          <h3 className="text-base font-semibold text-vdm-text">Add Shared Storage</h3>
          <p className="text-xs text-vdm-textMuted mt-0.5">NFS, SMB, or GlusterFS shares used by VDM for migration and backup operations.</p>
        </div>

        {/* Name / Display Name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="vdm-label">Internal Name <span className="text-vdm-danger">*</span></label>
            <input className="vdm-input font-mono" placeholder="nas-backups" value={form.name}
              onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} />
            <p className="text-xs text-vdm-textMuted mt-1">Lowercase, a–z, 0–9, - _</p>
          </div>
          <div>
            <label className="vdm-label">Display Name</label>
            <input className="vdm-input" placeholder="NAS Backups" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} />
          </div>
        </div>

        {/* Type */}
        <div>
          <label className="vdm-label">Storage Type <span className="text-vdm-danger">*</span></label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(["nfs", "smb", "glusterfs", "s3"] as const).map((t) => (
              <button key={t} type="button"
                className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${form.type === t || (t === "smb" && form.type === "cifs")
                  ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent"
                  : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}
                onClick={() => set("type", t)}>
                {t === "nfs" ? "NFS" : t === "smb" ? "SMB / CIFS" : t === "glusterfs" ? "GlusterFS" : "S3 / Object"}
              </button>
            ))}
          </div>
        </div>

        {/* Source (NFS/SMB/GlusterFS) */}
        {!isS3 && (
          <div>
            <label className="vdm-label">{sourceLabel} <span className="text-vdm-danger">*</span></label>
            <input className="vdm-input font-mono text-sm" placeholder={sourcePlaceholder}
              value={form.source} onChange={(e) => set("source", e.target.value)} />
          </div>
        )}

        {/* S3 / object storage fields */}
        {isS3 && (
          <div className="rounded-lg border border-vdm-border bg-vdm-bg p-4 space-y-4">
            <p className="text-xs font-semibold text-vdm-textMuted uppercase tracking-wider">S3 / Object Storage</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="vdm-label">Provider</label>
                <select className="vdm-input" value={form.s3Provider} onChange={(e) => set("s3Provider", e.target.value)}>
                  <option value="generic">S3 compatible</option>
                  <option value="aws">AWS S3</option>
                  <option value="minio">MinIO</option>
                  <option value="b2">Backblaze B2</option>
                </select>
              </div>
              <div>
                <label className="vdm-label">Bucket <span className="text-vdm-danger">*</span></label>
                <input className="vdm-input font-mono" placeholder="my-bucket" value={form.s3Bucket} onChange={(e) => set("s3Bucket", e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="vdm-label">Endpoint (optional for AWS)</label>
                <input className="vdm-input font-mono" placeholder="https://s3.amazonaws.com or http://minio:9000" value={form.s3Endpoint} onChange={(e) => set("s3Endpoint", e.target.value)} />
              </div>
              <div>
                <label className="vdm-label">Region (optional)</label>
                <input className="vdm-input font-mono" placeholder="us-east-1" value={form.s3Region} onChange={(e) => set("s3Region", e.target.value)} />
              </div>
              <div>
                <label className="vdm-label">VFS Cache</label>
                <select className="vdm-input" value={form.s3VfsCacheMode} onChange={(e) => set("s3VfsCacheMode", e.target.value)}>
                  <option value="off">Off (network reads)</option>
                  <option value="minimal">Minimal</option>
                  <option value="writes">Writes</option>
                  <option value="full">Full</option>
                </select>
              </div>
              <div>
                <label className="vdm-label">Access Key <span className="text-vdm-danger">*</span></label>
                <input className="vdm-input font-mono" autoComplete="off" value={form.s3AccessKey} onChange={(e) => set("s3AccessKey", e.target.value)} />
              </div>
              <div>
                <label className="vdm-label">Secret Key <span className="text-vdm-danger">*</span></label>
                <input className="vdm-input font-mono" type="password" autoComplete="new-password" value={form.s3SecretKey} onChange={(e) => set("s3SecretKey", e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {/* Mount Path */}
        <div>
          <label className="vdm-label">Mount Point (on nodes) <span className="text-vdm-danger">*</span></label>
          <input className="vdm-input font-mono text-sm" value={form.localMountPath} onChange={(e) => set("localMountPath", e.target.value)} />
        </div>

        {/* NFS version */}
        {isNfs && (
          <div>
            <label className="vdm-label">NFS Version</label>
            <div className="flex gap-2 flex-wrap">
              {["", "3", "4", "4.1", "4.2"].map((v) => (
                <button key={v} type="button"
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${form.nfsVersion === v
                    ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent"
                    : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/40"}`}
                  onClick={() => set("nfsVersion", v)}>
                  {v === "" ? "Auto" : `NFSv${v}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* SMB credentials + version */}
        {isSmb && (
          <div className="rounded-lg border border-vdm-border bg-vdm-bg p-4 space-y-4">
            <p className="text-xs font-semibold text-vdm-textMuted uppercase tracking-wider">SMB Protocol Version</p>
            <div className="flex gap-2 flex-wrap">
              {["", "1.0", "2.0", "2.1", "3.0", "3.1.1"].map((v) => (
                <button key={v} type="button"
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${form.smbVersion === v
                    ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent"
                    : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/40"}`}
                  onClick={() => set("smbVersion", v)}>
                  {v === "" ? "Auto" : `SMBv${v}`}
                </button>
              ))}
            </div>
            {form.smbVersion === "1.0" && (
              <div className="flex items-start gap-2 bg-vdm-warning/10 border border-vdm-warning/30 rounded-lg px-3 py-2 text-xs text-vdm-text">
                <Icon path={ICONS.info} className="w-3.5 h-3.5 text-vdm-warning flex-shrink-0 mt-0.5" />
                SMBv1 is deprecated and insecure. Use SMBv2 or v3 whenever possible.
              </div>
            )}
            <p className="text-xs font-semibold text-vdm-textMuted uppercase tracking-wider">SMB Credentials</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="vdm-label">Username</label>
                <input className="vdm-input" autoComplete="off" value={form.smbUsername} onChange={(e) => set("smbUsername", e.target.value)} />
              </div>
              <div>
                <label className="vdm-label">Password</label>
                <input className="vdm-input" type="password" autoComplete="new-password" value={form.smbPassword} onChange={(e) => set("smbPassword", e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="vdm-label">Domain (optional)</label>
                <input className="vdm-input" placeholder="WORKGROUP" value={form.smbDomain} onChange={(e) => set("smbDomain", e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="vdm-label">Notes (optional)</label>
          <input className="vdm-input" placeholder="e.g. Main NAS for datacenter backups" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!form.name || !form.source || !form.localMountPath || isPending} onClick={handleSave}>
            {isPending ? "Adding..." : "Add Storage"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cluster Status Panel ─────────────────────────────────────────────────────
function ClusterStatusPanel({ storage, onMountAll, onMountOne, mountingAll, mountingNode }: {
  storage: VdmSharedStorage;
  onMountAll: () => void;
  onMountOne: (nodeName: string) => void;
  mountingAll: boolean;
  mountingNode: string | null;
}) {
  const statusQuery = useQuery<VdmStorageNodeStatus[]>({
    queryKey: ["vdm-storage-cluster-status", storage.name],
    queryFn: () => api.get(`/api/vdm/storage/${encodeURIComponent(storage.name)}/cluster-status`),
    refetchInterval: 15_000,
  });

  const statuses = statusQuery.data ?? [];
  const mounted = statuses.filter((s) => s.mounted).length;
  const total = statuses.length;

  return (
    <div className="mt-3 rounded-lg border border-vdm-border bg-vdm-bg/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-vdm-border/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-vdm-textMuted uppercase tracking-wider">Cluster Mount Status</span>
          {statusQuery.isFetching && <div className="w-3 h-3 border border-vdm-accent border-t-transparent rounded-full animate-spin" />}
          {total > 0 && (
            <span className={`text-xs font-medium ${mounted === total ? "text-vdm-success" : mounted === 0 ? "text-vdm-danger" : "text-vdm-warning"}`}>
              {mounted}/{total} mounted
            </span>
          )}
        </div>
        <button className="vdm-btn-ghost text-xs" onClick={onMountAll} disabled={mountingAll || total === 0}>
          {mountingAll ? (
            <><div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />Mounting...</>
          ) : (
            <><Icon path={ICONS.link} className="w-3 h-3" />Mount all nodes</>
          )}
        </button>
      </div>

      {/* Node list */}
      {statusQuery.isLoading ? (
        <div className="px-3 py-3 flex gap-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-7 w-28 rounded bg-vdm-surfaceHover animate-pulse" />)}
        </div>
      ) : statuses.length === 0 ? (
        <div className="px-3 py-3 text-xs text-vdm-textMuted">No enabled nodes in cluster.</div>
      ) : (
        <div className="flex flex-wrap gap-2 px-3 py-2.5">
          {statuses.map((s) => (
            <div key={s.node} title={s.error ?? undefined}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors
                ${s.mounted
                  ? "border-vdm-success/40 bg-vdm-success/10 text-vdm-success"
                  : s.error === "Node offline"
                    ? "border-vdm-border bg-vdm-bg text-vdm-textMuted"
                    : "border-vdm-danger/40 bg-vdm-danger/10 text-vdm-danger"}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${s.mounted ? "bg-vdm-success" : s.error === "Node offline" ? "bg-vdm-textMuted" : "bg-vdm-danger"}`} />
              <span>{s.nodeDisplayName}</span>
              {s.mounted ? (
                <Icon path={ICONS.check} className="w-3 h-3" />
              ) : s.error !== "Node offline" ? (
                <button className="ml-1 underline text-[10px] hover:opacity-80"
                  disabled={mountingNode === s.node}
                  onClick={() => onMountOne(s.node)}>
                  {mountingNode === s.node ? "..." : "mount"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Storage Row ──────────────────────────────────────────────────────────────
function StorageRow({ stor, isAdmin, onDelete }: {
  stor: VdmSharedStorage; isAdmin: boolean; onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [mountingAll, setMountingAll] = useState(false);
  const [mountingNode, setMountingNode] = useState<string | null>(null);

  const isSmb = stor.type === "smb" || stor.type === "cifs";
  const isNfs = stor.type === "nfs";
  const isS3 = stor.type === "s3";

  const handleMountAll = async () => {
    setMountingAll(true);
    try {
      await api.post(`/api/vdm/storage/${encodeURIComponent(stor.name)}/mount`);
      qc.invalidateQueries({ queryKey: ["vdm-storage-cluster-status", stor.name] });
    } finally {
      setMountingAll(false);
    }
  };

  const handleMountOne = async (nodeName: string) => {
    setMountingNode(nodeName);
    try {
      await api.post(`/api/vdm/storage/${encodeURIComponent(stor.name)}/mount/${encodeURIComponent(nodeName)}`);
      qc.invalidateQueries({ queryKey: ["vdm-storage-cluster-status", stor.name] });
    } finally {
      setMountingNode(null);
    }
  };

  return (
    <div className="px-4 py-4 hover:bg-vdm-bg/30 transition-colors">
      {/* Main row */}
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div className="mt-0.5 w-8 h-8 rounded-lg bg-vdm-accent/10 flex items-center justify-center flex-shrink-0">
          <Icon path={typeIconPath(stor.type)} className="w-4 h-4 text-vdm-accent" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-vdm-text">{stor.displayName}</span>
            <span className="font-mono text-xs text-vdm-textMuted">{stor.name}</span>
            <span className="rounded-md border border-vdm-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-vdm-textMuted">
              {typeLabel(stor.type)}
              {isSmb && stor.smbVersion ? ` v${stor.smbVersion}` : ""}
              {isNfs && stor.nfsVersion ? ` v${stor.nfsVersion}` : ""}
              {isS3 && stor.s3Provider ? ` ${stor.s3Provider}` : ""}
            </span>
            {!stor.enabled && <span className="pill-gray text-[10px]">Disabled</span>}
          </div>
          <p className="text-sm font-mono text-vdm-textMuted mt-0.5 truncate">{isS3 ? (stor.s3Bucket || "bucket") : stor.source}</p>
          <p className="text-xs text-vdm-textMuted/70 mt-0.5">
            Mount: <code className="font-mono">{stor.localMountPath}</code>
            {isSmb && stor.smbUsername && <span className="ml-2 text-vdm-textMuted">user: {stor.smbUsername}</span>}
            {isSmb && stor.smbDomain && <span className="ml-2 text-vdm-textMuted">domain: {stor.smbDomain}</span>}
            {isS3 && <span className="ml-2 text-vdm-textMuted">{stor.s3Endpoint || "AWS S3"}{stor.s3Region ? ` · ${stor.s3Region}` : ""}</span>}
          </p>
          {stor.notes && <p className="text-xs text-vdm-textMuted/60 mt-0.5 italic">{stor.notes}</p>}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button className="vdm-btn-ghost text-xs" onClick={() => setExpanded((v) => !v)}>
            <Icon path={expanded ? "M4.5 15.75l7.5-7.5 7.5 7.5" : "M19.5 8.25l-7.5 7.5-7.5-7.5"} className="w-3.5 h-3.5" />
            {expanded ? "Hide" : "Cluster"}
          </button>
          {isAdmin && (
            <button className="vdm-btn-danger text-xs" onClick={onDelete}>
              <Icon path={ICONS.trash} className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Cluster panel */}
      {expanded && (
        <ClusterStatusPanel
          storage={stor}
          onMountAll={handleMountAll}
          onMountOne={handleMountOne}
          mountingAll={mountingAll}
          mountingNode={mountingNode}
        />
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function StoragePage() {
  const { isAdmin } = useVdmAuth();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const storagesQuery = useQuery<VdmSharedStorage[]>({
    queryKey: ["vdm-storage"],
    queryFn: () => api.get("/api/vdm/storage"),
    refetchInterval: 30_000,
  });

  const addMut = useMutation({
    mutationFn: (data: StorageForm) => api.post("/api/vdm/storage", {
      name: data.name,
      displayName: data.displayName || undefined,
      type: data.type,
      source: data.source,
      localMountPath: data.localMountPath,
      smbUsername: data.smbUsername || undefined,
      smbPassword: data.smbPassword || undefined,
      smbDomain: data.smbDomain || undefined,
      smbVersion: data.smbVersion || undefined,
      nfsVersion: data.nfsVersion || undefined,
      s3Endpoint: data.s3Endpoint || undefined,
      s3Bucket: data.s3Bucket || undefined,
      s3Region: data.s3Region || undefined,
      s3AccessKey: data.s3AccessKey || undefined,
      s3SecretKey: data.s3SecretKey || undefined,
      s3Provider: data.s3Provider || undefined,
      s3VfsCacheMode: data.s3VfsCacheMode || undefined,
      notes: data.notes || undefined,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-storage"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (name: string) => api.delete(`/api/vdm/storage/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-storage"] }),
  });

  const storages = storagesQuery.data ?? [];

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Shared Storage</h1>
          <p className="text-sm text-vdm-textMuted">
            {storages.length > 0
              ? `${storages.length} storage${storages.length !== 1 ? "s" : ""} · NFS, SMB/CIFS, GlusterFS`
              : "NFS / SMB / GlusterFS network storage for migration and backup"}
          </p>
        </div>
        {isAdmin && (
          <button className="vdm-btn-primary" onClick={() => setShowAdd(true)}>
            <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
            Add Storage
          </button>
        )}
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2.5 bg-vdm-accent/8 border border-vdm-accent/25 rounded-lg px-4 py-3 text-sm text-vdm-text">
        <Icon path={ICONS.info} className="w-4 h-4 text-vdm-accent flex-shrink-0 mt-0.5" />
        <div>
          <strong>Required for migration &amp; backup.</strong> Shared storages must be mounted on each participating node.
          Expand a storage to see per-node mount status and mount on individual nodes or the entire cluster at once.
        </div>
      </div>

      {/* Loading */}
      {storagesQuery.isLoading ? (
        <div className="vdm-card p-10 text-center">
          <div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : storages.length === 0 ? (
        <div className="vdm-card p-12 text-center space-y-3">
          <Icon path={ICONS.db} className="w-10 h-10 text-vdm-textMuted/50 mx-auto" />
          <div>
            <p className="font-medium text-vdm-textMuted">No shared storage configured</p>
            <p className="text-xs text-vdm-textMuted/70 mt-1">
              Add an NFS or SMB share to enable VM/LXC migration and cluster backups.
            </p>
          </div>
          {isAdmin && (
            <button className="vdm-btn-primary" onClick={() => setShowAdd(true)}>
              <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
              Add your first storage
            </button>
          )}
        </div>
      ) : (
        <div className="vdm-card divide-y divide-vdm-border/50">
          {storages.map((stor) => (
            <StorageRow
              key={stor.id}
              stor={stor}
              isAdmin={isAdmin}
              onDelete={() => {
                if (confirm(`Remove storage "${stor.displayName}"? This will not unmount it from nodes.`)) {
                  deleteMut.mutate(stor.name);
                }
              }}
            />
          ))}
        </div>
      )}

      <AddStorageModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSave={(data) => addMut.mutate(data)}
        isPending={addMut.isPending}
      />
    </div>
  );
}
