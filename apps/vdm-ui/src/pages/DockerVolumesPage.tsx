import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmDockerVolume, VdmNode } from "@/types/vdm";

export default function DockerVolumesPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [formNode, setFormNode] = useState("");
  const [formName, setFormName] = useState("");
  const [formDriver, setFormDriver] = useState("local");

  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const volumesQuery = useQuery<VdmDockerVolume[]>({
    queryKey: ["vdm-volumes"],
    queryFn: () => api.get("/api/vdm/docker/volumes"),
    refetchInterval: 15_000,
  });

  const createMut = useMutation({
    mutationFn: () => api.post(`/api/vdm/docker/volumes/${encodeURIComponent(nameNode())}`, { name: formName, driver: formDriver }),
    onSuccess: () => {
      setCreating(false);
      setFormName("");
      setFormDriver("local");
      qc.invalidateQueries({ queryKey: ["vdm-volumes"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeMut = useMutation({
    mutationFn: ({ node, name }: { node: string; name: string }) =>
      api.delete(`/api/vdm/docker/volumes/${encodeURIComponent(node)}/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-volumes"] }),
    onError: (err: Error) => setError(err.message),
  });

  function nameNode() {
    return formNode || (nodesQuery.data ?? [])[0]?.name || "";
  }

  function createDisabled() {
    return createMut.isPending || !formName || !nameNode();
  }

  const volumes = volumesQuery.data ?? [];
  const nodes = nodesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Docker Volumes</h1>
          <p className="text-sm text-vdm-textMuted">{volumes.length} volume{volumes.length !== 1 ? "s" : ""} across nodes</p>
        </div>
        <button className="vdm-btn-primary" onClick={() => setCreating(true)}>+ Create Volume</button>
      </div>

      {error && <div className="rounded-lg border border-vdm-danger/40 bg-vdm-danger/10 px-3 py-2 text-sm text-vdm-danger">{error}</div>}

      {creating && (
        <div className="vdm-card p-4 space-y-3">
          <h2 className="font-medium text-vdm-text">Create Volume</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select className="vdm-input" value={formNode} onChange={(e) => setFormNode(e.target.value)}>
              <option value="">Select node…</option>
              {nodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
            </select>
            <input className="vdm-input font-mono" placeholder="volume name" value={formName} onChange={(e) => setFormName(e.target.value)} />
            <input className="vdm-input font-mono" placeholder="driver (local)" value={formDriver} onChange={(e) => setFormDriver(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <button className="vdm-btn-primary text-xs" disabled={createDisabled()} onClick={() => createMut.mutate()}>Create</button>
            <button className="vdm-btn-ghost text-xs" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead>
            <tr><th>Name</th><th>Node</th><th>Driver</th><th>Mountpoint</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {volumesQuery.isLoading ? (
              <tr><td colSpan={5} className="text-center py-8"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></td></tr>
            ) : volumes.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-vdm-textMuted">No volumes found</td></tr>
            ) : volumes.map((v) => (
              <tr key={`${v.nodeName}:${v.name}`} className="hover:bg-vdm-bg/40 transition-colors">
                <td className="font-mono text-xs text-vdm-text">{v.name}</td>
                <td className="text-sm text-vdm-textMuted">{v.nodeName}</td>
                <td className="text-xs">{v.driver}</td>
                <td className="font-mono text-xs text-vdm-textMuted truncate max-w-56" title={v.mountpoint}>{v.mountpoint || "—"}</td>
                <td>
                  <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete volume ${v.name}? Data will be lost.`)) removeMut.mutate({ node: v.nodeName, name: v.name }); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
