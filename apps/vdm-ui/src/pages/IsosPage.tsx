import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import type { VdmNode } from "@/types/vdm";

interface VdmIso {
  filename: string;
  displayName?: string;
  sizeBytes: number;
  createdAt?: string | null;
  storagePool?: string | null;
  nodeName: string;
  nodeDisplayName: string;
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
};

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function CopyIsoModal({ open, onClose, iso, nodes, onSubmit }: {
  open: boolean; onClose: () => void; iso: VdmIso | null; nodes: VdmNode[];
  onSubmit: (targetNode: string) => void;
}) {
  const [targetNode, setTargetNode] = useState("");
  if (!open || !iso) return null;
  const candidates = nodes.filter((n) => n.name !== iso.nodeName && n.status === "online");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-sm p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Copy ISO: {iso.filename}</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
            <option value="">Select node...</option>
            {candidates.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
          {candidates.length === 0 && <p className="text-xs text-vdm-textMuted mt-1">No other online node available.</p>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" disabled={!targetNode} onClick={() => { if (targetNode) { onSubmit(targetNode); onClose(); } }}>Copy</button>
        </div>
      </div>
    </div>
  );
}

export default function IsosPage() {
  const { isAdmin } = useVdmAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [copyTarget, setCopyTarget] = useState<VdmIso | null>(null);
  const [search, setSearch] = useState("");

  const isosQuery = useQuery<VdmIso[]>({ queryKey: ["vdm-isos"], queryFn: () => api.get("/api/vdm/isos"), refetchInterval: 30_000 });
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });

  const copyMut = useMutation({
    mutationFn: (p: { sourceNode: string; filename: string; targetNode: string }) => api.post("/api/vdm/isos/copy", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });

  const isos = isosQuery.data ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = needle ? isos.filter((iso) => `${iso.filename} ${iso.nodeDisplayName} ${iso.nodeName}`.toLowerCase().includes(needle)) : isos;

  const downloadUrl = (iso: VdmIso) => `/api/vdm/nodes/${encodeURIComponent(iso.nodeName)}/isos/${encodeURIComponent(iso.filename)}/download`;

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">ISO Library</h1>
          <p className="text-sm text-vdm-textMuted">{isos.length} ISO image{isos.length !== 1 ? "s" : ""} across all nodes</p>
        </div>
        <input className="vdm-input w-56" placeholder="Search ISOs…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="vdm-card overflow-x-auto">
        {isosQuery.isLoading ? (
          <div className="p-10 flex justify-center"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-vdm-textMuted">No ISO images found.</div>
        ) : (
          <table className="vdm-table">
            <thead><tr><th>Name</th><th>Node</th><th>Size</th><th>Storage</th><th></th></tr></thead>
            <tbody>
              {filtered.map((iso) => (
                <tr key={`${iso.nodeName}:${iso.filename}`} className="hover:bg-vdm-bg/40">
                  <td>
                    <div className="flex items-center gap-2">
                      <Icon path={ICONS.iso} className="w-4 h-4 text-vdm-accent" />
                      <span className="font-mono text-xs text-vdm-text truncate max-w-64" title={iso.filename}>{iso.filename}</span>
                    </div>
                  </td>
                  <td className="text-sm text-vdm-textMuted">{iso.nodeDisplayName}</td>
                  <td className="text-xs text-vdm-textMuted">{formatBytes(iso.sizeBytes)}</td>
                  <td className="text-xs text-vdm-textMuted">{iso.storagePool ?? "local"}</td>
                  <td className="text-right space-x-2 whitespace-nowrap">
                    <a className="vdm-btn-ghost text-xs inline-flex items-center gap-1" href={downloadUrl(iso)}>
                      <Icon path={ICONS.download} className="w-3.5 h-3.5" />Download
                    </a>
                    {isAdmin && (
                      <button className="vdm-btn-ghost text-xs inline-flex items-center gap-1" onClick={() => setCopyTarget(iso)}>
                        <Icon path={ICONS.copy} className="w-3.5 h-3.5" />Copy to node…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CopyIsoModal
        open={!!copyTarget}
        iso={copyTarget}
        nodes={nodesQuery.data ?? []}
        onClose={() => setCopyTarget(null)}
        onSubmit={(targetNode) => copyTarget && copyMut.mutate({ sourceNode: copyTarget.nodeName, filename: copyTarget.filename, targetNode })}
      />
    </div>
  );
}
