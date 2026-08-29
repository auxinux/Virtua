import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import { useConfirm } from "@/hooks/useDialog";
import type { VdmJoinToken, VdmNode } from "@/types/vdm";

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

// ── Add/Edit Node Modal ────────────────────────────────────────────────────
interface NodeForm { name: string; displayName: string; apiUrl: string; authToken: string; }

function NodeModal({ open, onClose, initial, onSave }: {
  open: boolean; onClose: () => void; initial?: NodeForm & { id?: number }; onSave: (data: NodeForm) => void;
}) {
  const isEdit = !!initial?.id;
const [form, setForm] = useState<NodeForm>(initial ?? { name: "", displayName: "", apiUrl: "", authToken: "" });

  if (!open) return null;

  function field(label: string, key: keyof NodeForm, type = "text", placeholder = "") {
    return (
      <div>
        <label className="vdm-label">{label}</label>
        <input className="vdm-input" type={type} placeholder={placeholder} value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">{isEdit ? "Edit Node" : "Add Node"}</h3>
        {field("Internal Name (unique slug)", "name", "text", "node-paris-01")}
        {field("Display Name", "displayName", "text", "Paris Node 1")}
        {field("API URL", "apiUrl", "url", "https://192.168.1.10:3001")}
        <div>
          <label className="vdm-label">Node Token</label>
          <input className="vdm-input font-mono text-xs" type="password" placeholder="Paste the node's AUXINUX_NODE_TOKEN value"
            value={form.authToken} onChange={(e) => setForm((f) => ({ ...f, authToken: e.target.value }))} />
          <p className="text-xs text-vdm-textMuted mt-1">Found in the node's environment: <code className="text-vdm-accent">AUXINUX_NODE_TOKEN</code></p>
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { onSave(form); onClose(); }}>{isEdit ? "Save" : "Add Node"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Status Badge ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  if (status === "online") return <span className="pill-green">Online</span>;
  if (status === "degraded") return <span className="pill-yellow">Degraded</span>;
  if (status === "offline") return <span className="pill-red">Offline</span>;
  return <span className="pill-gray">{status}</span>;
}

export default function NodesPage() {
  const { isAdmin } = useVdmAuth();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [showAdd, setShowAdd] = useState(false);
  const [editNode, setEditNode] = useState<(NodeForm & { nodeName: string }) | null>(null);
  const [joinTokenForm, setJoinTokenForm] = useState({ note: "", expiresInMinutes: 60 });

  const nodesQuery = useQuery<VdmNode[]>({
    queryKey: ["vdm-nodes"],
    queryFn: () => api.get("/api/vdm/nodes"),
    refetchInterval: 30_000,
  });

  const joinTokensQuery = useQuery<VdmJoinToken[]>({
    queryKey: ["vdm-join-tokens"],
    queryFn: () => api.get("/api/vdm/join-tokens"),
    enabled: isAdmin,
  });

  const addMut = useMutation({
    mutationFn: (data: NodeForm) => api.post("/api/vdm/nodes", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-nodes"] }),
  });
  const editMut = useMutation({
    mutationFn: ({ nodeName, data }: { nodeName: string; data: Partial<NodeForm> }) => api.put(`/api/vdm/nodes/${encodeURIComponent(nodeName)}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-nodes"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (nodeName: string) => api.delete(`/api/vdm/nodes/${encodeURIComponent(nodeName)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-nodes"] }),
  });
  const pingMut = useMutation({
    mutationFn: (nodeName: string) => api.post(`/api/vdm/nodes/${encodeURIComponent(nodeName)}/ping`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-nodes"] }),
  });
  const createJoinTokenMut = useMutation({
    mutationFn: () => api.post<VdmJoinToken>("/api/vdm/join-tokens", joinTokenForm),
    onSuccess: () => {
      setJoinTokenForm({ note: "", expiresInMinutes: 60 });
      qc.invalidateQueries({ queryKey: ["vdm-join-tokens"] });
    },
  });
  const deleteJoinTokenMut = useMutation({
    mutationFn: (id: number) => api.delete(`/api/vdm/join-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-join-tokens"] }),
  });

  const nodes = nodesQuery.data ?? [];
  const joinTokens = joinTokensQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Nodes</h1>
          <p className="text-sm text-vdm-textMuted">{nodes.length} registered node{nodes.length !== 1 ? "s" : ""}</p>
        </div>
        {isAdmin && (
          <button className="vdm-btn-primary" onClick={() => setShowAdd(true)}>
            <Icon path="M12 4.5v15m7.5-7.5h-15" className="w-3.5 h-3.5" />
            Add Node
          </button>
        )}
      </div>

      {isAdmin && (
        <div className="vdm-card p-4 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-vdm-text">Manager Join Tokens</h2>
            <p className="text-xs text-vdm-textMuted mt-1">Use one of these tokens from a Node Settings page to join this VDM manager automatically.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_130px_auto] gap-3">
            <input
              className="vdm-input"
              placeholder="Optional note"
              value={joinTokenForm.note}
              onChange={(e) => setJoinTokenForm((current) => ({ ...current, note: e.target.value }))}
            />
            <input
              className="vdm-input"
              type="number"
              min={5}
              max={10080}
              value={joinTokenForm.expiresInMinutes}
              onChange={(e) => setJoinTokenForm((current) => ({ ...current, expiresInMinutes: parseInt(e.target.value, 10) || 60 }))}
            />
            <button className="vdm-btn-primary" onClick={() => createJoinTokenMut.mutate()} disabled={createJoinTokenMut.isPending}>
              {createJoinTokenMut.isPending ? "Creating..." : "Create token"}
            </button>
          </div>

          <div className="space-y-2">
            {joinTokens.length === 0 ? (
              <div className="text-sm text-vdm-textMuted">No active join tokens.</div>
            ) : joinTokens.map((token) => (
              <div key={token.id} className="rounded-lg border border-vdm-border bg-vdm-surface px-3 py-2 flex items-start gap-3 justify-between">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-vdm-text break-all">{token.token}</div>
                  <div className="text-xs text-vdm-textMuted mt-1">
                    {(token.note || "No note")} · expires {new Date(token.expiresAt).toLocaleString()}
                  </div>
                </div>
                <button className="vdm-btn-danger text-xs" onClick={() => deleteJoinTokenMut.mutate(token.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {nodesQuery.isLoading ? (
        <div className="vdm-card p-8 text-center"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></div>
      ) : nodes.length === 0 ? (
        <div className="vdm-card p-10 text-center space-y-2">
          <p className="text-vdm-textMuted">No nodes registered yet.</p>
          {isAdmin && <button className="vdm-btn-primary" onClick={() => setShowAdd(true)}>Add your first node</button>}
        </div>
      ) : (
        <div className="vdm-card divide-y divide-vdm-border/50">
          {nodes.map((node) => (
            <div key={node.id} className="flex items-center gap-4 px-4 py-3 hover:bg-vdm-bg/40 transition-colors">
              {/* Status dot */}
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${node.status === "online" ? "bg-vdm-success animate-pulse" : node.status === "degraded" ? "bg-vdm-warning" : "bg-vdm-danger"}`} />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-vdm-text">{node.displayName}</span>
                  <span className="text-xs text-vdm-textMuted font-mono">{node.name}</span>
                  <StatusBadge status={node.status} />
                  {node.virtuaVersion && <span className={node.compatibility === "incompatible" ? "pill-red" : "pill-blue"}>Virtua {node.virtuaVersion}</span>}
                </div>
                <div className="text-xs text-vdm-textMuted mt-0.5 flex items-center gap-3">
                  <span>{node.apiUrl}</span>
                  {node.lastSeenAt && <span>last seen: {new Date(node.lastSeenAt).toLocaleString()}</span>}
                  {node.latencyMs !== null && node.latencyMs !== undefined && <span>{node.latencyMs} ms</span>}
                </div>
                {node.lastError && <div className="text-xs text-vdm-danger mt-1 truncate">{node.lastError}</div>}
              </div>



              {/* Actions */}
              <div className="flex items-center gap-2">
                <button className="vdm-btn-ghost text-xs" onClick={() => pingMut.mutate(node.name)} disabled={pingMut.isPending}>
                  <Icon path="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z" />
                  Ping
                </button>
                {isAdmin && (
                  <>
                    <button className="vdm-btn-ghost text-xs" onClick={() => setEditNode({ nodeName: node.name, name: node.name, displayName: node.displayName, apiUrl: node.apiUrl, authToken: "" })}>
                      Edit
                    </button>
                    <button className="vdm-btn-danger text-xs" onClick={async () => { if (await confirm({ title: `Remove node ${node.displayName}?`, message: "The node will be unregistered from this VDM cluster.", confirmLabel: "Remove" })) deleteMut.mutate(node.name); }}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <NodeModal open={showAdd} onClose={() => setShowAdd(false)} onSave={(data) => addMut.mutate(data)} />
      {editNode && (
        <NodeModal open initial={editNode} onClose={() => setEditNode(null)}
          onSave={(data) => editMut.mutate({ nodeName: editNode.nodeName, data })} />
      )}
      {confirmDialog}
    </div>
  );
}
