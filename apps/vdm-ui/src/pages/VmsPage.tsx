import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmVm, VdmNode } from "@/types/vdm";
import { CreateResourceModal } from "@/components/CreateResourceModal";
import { useConfirm } from "@/hooks/useDialog";

function StateChip({ state }: { state: string }) {
  const map: Record<string, string> = { running: "pill-green", stopped: "pill-gray", paused: "pill-yellow", crashed: "pill-red" };
  return <span className={map[state] ?? "pill-gray"}>{state}</span>;
}

export default function VmsPage() {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [filterNode, setFilterNode] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const vmsQuery = useQuery<VdmVm[]>({
    queryKey: ["vdm-vms"],
    queryFn: () => api.get("/api/vdm/vms"),
    refetchInterval: 15_000,
  });

  const actionMut = useMutation({
    mutationFn: ({ node, name, action }: { node: string; name: string; action: string }) =>
      api.post(`/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}/action`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vms"] }),
  });
  const deleteMut = useMutation({
    mutationFn: ({ node, name }: { node: string; name: string }) =>
      api.delete(`/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-vms"] }),
  });

  const vms = (vmsQuery.data ?? []).filter((vm) => {
    if (filterNode !== "all" && vm.nodeName !== filterNode) return false;
    if (search && !vm.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const nodes = nodesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Virtual Machines</h1>
          <p className="text-sm text-vdm-textMuted">{vms.length} VM{vms.length !== 1 ? "s" : ""} across all nodes</p>
        </div>
        <button className="vdm-btn-primary" onClick={() => setShowCreate(true)}>+ Create VM</button>
      </div>
      <CreateResourceModal open={showCreate} onClose={() => setShowCreate(false)} type="vm" />

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <input className="vdm-input w-48" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="vdm-input w-48" value={filterNode} onChange={(e) => setFilterNode(e.target.value)}>
          <option value="all">All nodes</option>
          {nodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
        </select>
      </div>

      <div className="vdm-card overflow-x-auto">
        <table className="vdm-table">
          <thead>
            <tr>
              <th>Name</th><th>Node</th><th>State</th><th>vCPUs</th><th>Memory</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {vmsQuery.isLoading ? (
              <tr><td colSpan={6} className="text-center py-8"><div className="w-6 h-6 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin mx-auto" /></td></tr>
            ) : vms.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-vdm-textMuted">No VMs found</td></tr>
            ) : (
              vms.map((vm) => (
                <tr key={`${vm.nodeName}:${vm.name}`} className="hover:bg-vdm-bg/40 transition-colors">
                  <td>
                    <Link to={`/inventory/vm/${encodeURIComponent(vm.nodeName)}/${encodeURIComponent(vm.name)}`} className="text-vdm-accent hover:underline font-medium">
                      {vm.name}
                    </Link>
                  </td>
                  <td className="text-vdm-textMuted text-sm">{vm.nodeName}</td>
                  <td><StateChip state={vm.state} /></td>
                  <td>{vm.vcpus ?? "—"}</td>
                  <td>{vm.memoryMb ? `${vm.memoryMb} MB` : "—"}</td>
                  <td>
                    <div className="flex gap-1">
                      {vm.state !== "running" && (
                        <button className="vdm-btn-success text-xs" onClick={() => actionMut.mutate({ node: vm.nodeName, name: vm.name, action: "start" })}>Start</button>
                      )}
                      {vm.state === "running" && (
                        <>
                          <button className="vdm-btn-warning text-xs" onClick={() => actionMut.mutate({ node: vm.nodeName, name: vm.name, action: "shutdown" })}>Stop</button>
                          <button className="vdm-btn-ghost text-xs" onClick={() => actionMut.mutate({ node: vm.nodeName, name: vm.name, action: "reboot" })}>Reboot</button>
                        </>
                      )}
                      <Link to={`/inventory/vm/${encodeURIComponent(vm.nodeName)}/${encodeURIComponent(vm.name)}`} className="vdm-btn-ghost text-xs">Details</Link>
                      <button className="vdm-btn-danger text-xs" onClick={async () => {
                        if (await confirm({ title: `Delete VM ${vm.name}?`, message: "The VM and its disks will be permanently removed.", confirmLabel: "Delete" })) deleteMut.mutate({ node: vm.nodeName, name: vm.name });
                      }}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {confirmDialog}
    </div>
  );
}
