import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmLxc, VdmNode } from "@/types/vdm";
import { CreateResourceModal } from "@/components/CreateResourceModal";

function StateChip({ state }: { state: string }) {
  const map: Record<string, string> = { running: "pill-green", stopped: "pill-gray", paused: "pill-yellow" };
  return <span className={map[state] ?? "pill-gray"}>{state}</span>;
}

export default function LxcPage() {
  const qc = useQueryClient();
  const [filterNode, setFilterNode] = useState("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const lxcQuery = useQuery<VdmLxc[]>({
    queryKey: ["vdm-lxc-all"],
    queryFn: () => api.get("/api/vdm/lxc"),
    refetchInterval: 15_000,
  });

  const actionMut = useMutation({
    mutationFn: ({ node, name, action }: { node: string; name: string; action: string }) =>
      api.post(`/api/vdm/lxc/${encodeURIComponent(node)}/${encodeURIComponent(name)}/action`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-lxc-all"] }),
  });
  const deleteMut = useMutation({
    mutationFn: ({ node, name }: { node: string; name: string }) =>
      api.delete(`/api/vdm/lxc/${encodeURIComponent(node)}/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-lxc-all"] }),
  });

  const containers = (lxcQuery.data ?? []).filter((ct) => {
    if (filterNode !== "all" && ct.nodeName !== filterNode) return false;
    if (search && !ct.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">LXC Containers</h1>
          <p className="text-sm text-vdm-textMuted">{containers.length} container{containers.length !== 1 ? "s" : ""}</p>
        </div>
        <button className="vdm-btn-primary" onClick={() => setShowCreate(true)}>+ Create LXC</button>
      </div>
      <CreateResourceModal open={showCreate} onClose={() => setShowCreate(false)} type="lxc" />

      <div className="flex gap-2 flex-wrap">
        <input className="vdm-input w-48" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="vdm-input w-48" value={filterNode} onChange={(e) => setFilterNode(e.target.value)}>
          <option value="all">All nodes</option>
          {(nodesQuery.data ?? []).map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
        </select>
      </div>

      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead>
            <tr><th>Name</th><th>Node</th><th>State</th><th>OS</th><th>CPUs</th><th>Memory</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {lxcQuery.isLoading ? (
              <tr><td colSpan={7} className="text-center py-8"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></td></tr>
            ) : containers.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-vdm-textMuted">No containers found</td></tr>
            ) : containers.map((ct) => (
              <tr key={`${ct.nodeName}:${ct.name}`} className="hover:bg-vdm-bg/40 transition-colors">
                <td>
                  <Link to={`/inventory/lxc/${encodeURIComponent(ct.nodeName)}/${encodeURIComponent(ct.name)}`} className="text-vdm-accent hover:underline font-medium">{ct.name}</Link>
                </td>
                  <td className="text-vdm-textMuted text-sm">{ct.nodeName}</td>
                <td><StateChip state={ct.state} /></td>
                <td className="text-sm">{ct.os ?? "—"}</td>
                <td>{ct.cpus ?? "—"}</td>
                <td>{ct.memoryMb ? `${ct.memoryMb} MB` : "—"}</td>
                <td>
                  <div className="flex gap-1">
                    {ct.state !== "running" && <button className="vdm-btn-success text-xs" onClick={() => actionMut.mutate({ node: ct.nodeName, name: ct.name, action: "start" })}>Start</button>}
                    {ct.state === "running" && <>
                      <button className="vdm-btn-warning text-xs" onClick={() => actionMut.mutate({ node: ct.nodeName, name: ct.name, action: "stop" })}>Stop</button>
                      <button className="vdm-btn-ghost text-xs" onClick={() => actionMut.mutate({ node: ct.nodeName, name: ct.name, action: "restart" })}>Restart</button>
                    </>}
                    <Link to={`/inventory/lxc/${encodeURIComponent(ct.nodeName)}/${encodeURIComponent(ct.name)}`} className="vdm-btn-ghost text-xs">Details</Link>
                    <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete container ${ct.name}?`)) deleteMut.mutate({ node: ct.nodeName, name: ct.name }); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
