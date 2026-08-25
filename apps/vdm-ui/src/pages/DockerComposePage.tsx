import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmComposeProject, VdmComposeService, VdmNode } from "@/types/vdm";

interface ComposeDetail {
  name: string;
  yaml: string;
  services: VdmComposeService[];
  logs: string;
}

export default function DockerComposePage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<{ node: string; name: string } | null>(null);
  const [editYaml, setEditYaml] = useState("");
  const [error, setError] = useState("");

  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const projectsQuery = useQuery<VdmComposeProject[]>({
    queryKey: ["vdm-compose"],
    queryFn: () => api.get("/api/vdm/docker/compose"),
    refetchInterval: 15_000,
  });

  const detailQuery = useQuery<ComposeDetail>({
    queryKey: ["vdm-compose", selected?.node, selected?.name],
    queryFn: async () => {
      const name = encodeURIComponent(selected!.name);
      const node = encodeURIComponent(selected!.node);
      const [yaml, services, logs] = await Promise.all([
        api.get<string>(`/api/vdm/docker/compose/${node}/${name}`),
        api.get<VdmComposeService[]>(`/api/vdm/docker/compose/${node}/${name}/ps`).catch(() => []),
        api.get<{ logs: string }>(`/api/vdm/docker/compose/${node}/${name}/logs`).then((r) => r.logs).catch(() => ""),
      ]);
      return { name: selected!.name, yaml, services, logs };
    },
    enabled: !!selected,
  });

  useEffect(() => {
    if (detailQuery.data?.yaml !== undefined) setEditYaml(detailQuery.data.yaml);
  }, [detailQuery.data?.yaml]);

  const runAction = useMutation({
    mutationFn: ({ node, name, action }: { node: string; name: string; action: string }) =>
      api.post(`/api/vdm/docker/compose/${encodeURIComponent(node)}/${encodeURIComponent(name)}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-compose"] }),
    onError: (err: Error) => setError(err.message),
  });

  const saveYaml = useMutation({
    mutationFn: ({ node, name, yaml }: { node: string; name: string; yaml: string }) =>
      api.put(`/api/vdm/docker/compose/${encodeURIComponent(node)}/${encodeURIComponent(name)}`, { name, composeYaml: yaml }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-compose", selected?.node, selected?.name] }),
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: ({ node, name }: { node: string; name: string }) =>
      api.delete(`/api/vdm/docker/compose/${encodeURIComponent(node)}/${encodeURIComponent(name)}`),
    onSuccess: () => {
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["vdm-compose"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const busy = runAction.isPending || saveYaml.isPending || remove.isPending;
  const detail = detailQuery.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-vdm-text">Docker Compose</h1>
          <p className="text-sm text-vdm-textMuted">Persistent Compose projects across nodes</p>
        </div>
      </div>

      {error && <div className="rounded-lg border border-vdm-danger/40 bg-vdm-danger/10 px-3 py-2 text-sm text-vdm-danger">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="vdm-card p-3 space-y-1">
          {projectsQuery.isLoading ? (
            <div className="text-center py-8 text-vdm-textMuted">Loading…</div>
          ) : (projectsQuery.data ?? []).length === 0 ? (
            <div className="text-center py-8 text-vdm-textMuted">No Compose projects yet</div>
          ) : (
            (projectsQuery.data ?? []).map((p) => (
              <button
                key={`${p.nodeName}:${p.name}`}
                onClick={() => {
                  setSelected({ node: p.nodeName, name: p.name });
                  setError("");
                }}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                  selected?.node === p.nodeName && selected?.name === p.name
                    ? "bg-vdm-accent/15 text-vdm-accentHover"
                    : "hover:bg-vdm-surfaceHover text-vdm-textMuted hover:text-vdm-text"
                }`}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-vdm-textMuted/70">{p.nodeDisplayName} · {new Date(p.modifiedAt).toLocaleString()}</div>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {selected && detail ? (
            <div className="vdm-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-medium text-vdm-text">{detail.name}</h2>
                  <p className="text-xs text-vdm-textMuted">{selected.node}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button className="vdm-btn-primary text-xs" disabled={busy} onClick={() => runAction.mutate({ ...selected, action: "up" })}>Up</button>
                  <button className="vdm-btn-ghost text-xs" disabled={busy} onClick={() => runAction.mutate({ ...selected, action: "down" })}>Down</button>
                  <button className="vdm-btn-ghost text-xs" disabled={busy} onClick={() => runAction.mutate({ ...selected, action: "restart" })}>Restart</button>
                  <button className="vdm-btn-danger text-xs" disabled={busy} onClick={() => { if (confirm(`Delete ${detail.name}?`)) remove.mutate(selected); }}>Delete</button>
                </div>
              </div>

              {detail.services.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted mb-2">Services</h3>
                  <table className="vdm-table">
                    <thead>
                      <tr><th>Service</th><th>Name</th><th>State</th><th>Ports</th></tr>
                    </thead>
                    <tbody>
                      {detail.services.map((s) => (
                        <tr key={s.service}>
                          <td className="font-mono text-xs">{s.service}</td>
                          <td className="text-xs">{s.name}</td>
                          <td><span className="pill-gray text-xs">{s.state}</span></td>
                          <td className="font-mono text-xs">{s.ports || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted mb-2">docker-compose.yml</h3>
                <textarea
                  className="vdm-input font-mono text-xs h-48 w-full"
                  value={editYaml}
                  onChange={(e) => setEditYaml(e.target.value)}
                  spellCheck={false}
                />
                <div className="flex items-center gap-2 mt-2">
                  <button
                    className="vdm-btn-primary text-xs"
                    disabled={busy || editYaml === detail.yaml}
                    onClick={() => saveYaml.mutate({ ...selected, yaml: editYaml })}
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-semibold text-vdm-textMuted uppercase mb-2">Logs</h3>
                <pre className="bg-[#0d1117] rounded-lg p-3 text-xs font-mono text-vdm-textMuted overflow-auto max-h-48 whitespace-pre-wrap break-all">{detail.logs || "—"}</pre>
              </div>
            </div>
          ) : (
            <div className="vdm-card p-10 text-center text-vdm-textMuted">Select a Compose project to manage it</div>
          )}
        </div>
      </div>
    </div>
  );
}
