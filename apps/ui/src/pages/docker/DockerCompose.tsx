import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiDelete } from "../../api/client";
import { ConfirmModal } from "../../components/ui/Modal";
import type { DockerComposeProject, DockerComposeService } from "@auxinux/shared";

interface ComposeDetail {
  name: string;
  yaml: string;
  services: DockerComposeService[];
  logs: string;
}

// Lit un fichier .yml sélectionné et remplit le textarea cible.
function readYamlFile(file: File, onContent: (content: string) => void, onError: (msg: string) => void) {
  const reader = new FileReader();
  reader.onload = () => onContent(String(reader.result ?? ""));
  reader.onerror = () => onError("Failed to read file");
  reader.readAsText(file);
}

function YamlUploadButton({ onContent, onError, label }: { onContent: (c: string) => void; onError: (m: string) => void; label: string }) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".yml,.yaml,application/x-yaml,text/yaml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) readYamlFile(f, onContent, onError);
          e.target.value = "";
        }}
      />
      <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
        <svg className="w-3.5 h-3.5 mr-1.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
        </svg>
        {label}
      </button>
    </>
  );
}

export default function DockerCompose() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formYaml, setFormYaml] = useState("");
  const [editYaml, setEditYaml] = useState("");
  const [error, setError] = useState("");

  const { data: projects = [], isLoading } = useQuery<DockerComposeProject[]>({
    queryKey: ["docker", "compose"],
    queryFn: () => apiGet<DockerComposeProject[]>("/api/docker/compose"),
  });

  const { data: detail } = useQuery<ComposeDetail>({
    queryKey: ["docker", "compose", selected],
    queryFn: async () => {
      const [yaml, services, logs] = await Promise.all([
        apiGet<string>(`/api/docker/compose/${encodeURIComponent(selected!)}`),
        apiGet<DockerComposeService[]>(`/api/docker/compose/${encodeURIComponent(selected!)}/ps`),
        apiGet<{ logs: string }>(`/api/docker/compose/${encodeURIComponent(selected!)}/logs?tail=100`).then((r) => r.logs),
      ]);
      return { name: selected!, yaml, services, logs };
    },
    enabled: !!selected,
  });

  const save = useMutation({
    mutationFn: ({ name, yaml }: { name: string; yaml: string }) =>
      apiPost("/api/docker/compose", { name, composeYaml: yaml }),
    onSuccess: () => {
      setCreating(false);
      setFormName("");
      setFormYaml("");
      qc.invalidateQueries({ queryKey: ["docker", "compose"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: ({ name, yaml }: { name: string; yaml: string }) =>
      apiPut(`/api/docker/compose/${encodeURIComponent(name)}`, { composeYaml: yaml }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker", "compose", selected] }),
    onError: (err: Error) => setError(err.message),
  });

  // Sync the editor buffer whenever the selected project's YAML loads.
  React.useEffect(() => {
    if (detail?.yaml !== undefined) setEditYaml(detail.yaml);
  }, [detail?.yaml]);

  const up = useMutation({
    mutationFn: (name: string) => apiPost(`/api/docker/compose/${encodeURIComponent(name)}/up`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker", "compose", selected] }),
    onError: (err: Error) => setError(err.message),
  });

  const down = useMutation({
    mutationFn: (name: string) => apiPost(`/api/docker/compose/${encodeURIComponent(name)}/down`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker", "compose", selected] }),
    onError: (err: Error) => setError(err.message),
  });

  const restart = useMutation({
    mutationFn: (name: string) => apiPost(`/api/docker/compose/${encodeURIComponent(name)}/restart`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker", "compose", selected] }),
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/docker/compose/${encodeURIComponent(name)}`),
    onSuccess: () => {
      setDeleteTarget(null);
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["docker", "compose"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const busy = save.isPending || update.isPending || up.isPending || down.isPending || restart.isPending || remove.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/docker")} className="text-text-400 hover:text-text-200 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-text-100">{t("docker.composeProjects")}</h1>
            <p className="text-xs text-text-500 mt-0.5">{t("docker.compose")}</p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t("docker.composeCreate")}
        </button>
      </div>

      {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
        </div>
      ) : projects.length === 0 && !creating ? (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">🐳</div>
          <div className="text-text-400">{t("docker.composeNoProjects")}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Project list */}
          <div className="card p-3 space-y-1">
            {projects.map((p) => (
              <button
                key={p.name}
                onClick={() => setSelected(p.name)}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                  selected === p.name ? "bg-accent-blue/20 text-accent-blue-light" : "hover:bg-surface-700/50 text-text-300"
                }`}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-2xs text-text-500">{t("docker.composeModified")}: {new Date(p.modifiedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>

          {/* Detail / editor */}
          <div className="lg:col-span-2 space-y-4">
            {creating ? (
              <div className="card p-5 space-y-4">
                <h2 className="text-sm font-semibold text-text-300">{t("docker.composeCreate")}</h2>
                <div>
                  <label className="label">{t("docker.composeName")}</label>
                  <input className="input font-mono" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="my-stack" />
                </div>
                <div>
                  <label className="label">{t("docker.composeYaml")}</label>
                  <div className="flex items-center gap-2 mb-2">
                    <YamlUploadButton
                      label={t("docker.composeUpload")}
                      onContent={(c) => setFormYaml(c)}
                      onError={(m) => setError(m)}
                    />
                  </div>
                  <textarea
                    className="input font-mono text-xs h-64 w-full"
                    value={formYaml}
                    onChange={(e) => setFormYaml(e.target.value)}
                    placeholder={t("docker.composeYamlPlaceholder")}
                    spellCheck={false}
                  />
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy || !formName || !formYaml} onClick={() => save.mutate({ name: formName, yaml: formYaml })}>
                    {t("action.save")}
                  </button>
                  <button className="btn-ghost" onClick={() => setCreating(false)}>{t("action.cancel")}</button>
                </div>
              </div>
            ) : selected && detail ? (
              <>
                <div className="card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-text-200">{selected}</h2>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-sm" disabled={busy} onClick={() => up.mutate(selected)}>{t("docker.composeUp")}</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => down.mutate(selected)}>{t("docker.composeDown")}</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => restart.mutate(selected)}>{t("docker.composeRestart")}</button>
                      <button className="btn btn-sm text-red-400" disabled={busy} onClick={() => setDeleteTarget(selected)}>{t("docker.composeDelete")}</button>
                    </div>
                  </div>

                  {detail.services.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-xs font-semibold text-text-400 mb-2">{t("docker.composePs")}</h3>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-surface-600">
                            <th className="py-1.5 text-left text-text-400 font-medium">{t("common.name")}</th>
                            <th className="py-1.5 text-left text-text-400 font-medium">{t("common.state")}</th>
                            <th className="py-1.5 text-left text-text-400 font-medium">{t("tab.ports")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.services.map((s) => (
                            <tr key={s.name} className="border-b border-surface-700">
                              <td className="py-1.5 font-mono text-xs text-text-200">{s.service}</td>
                              <td className="py-1.5 text-xs text-text-300">{s.state}</td>
                              <td className="py-1.5 font-mono text-xs text-text-400">{s.ports || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mb-4">
                    <h3 className="text-xs font-semibold text-text-400 mb-2">{t("docker.composeYaml")}</h3>
                    <div className="flex items-center gap-2 mb-2">
                      <YamlUploadButton
                        label={t("docker.composeUpload")}
                        onContent={(c) => setEditYaml(c)}
                        onError={(m) => setError(m)}
                      />
                    </div>
                    <textarea
                      className="input font-mono text-xs h-48 w-full"
                      value={editYaml}
                      onChange={(e) => setEditYaml(e.target.value)}
                      spellCheck={false}
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        className="btn btn-sm"
                        disabled={busy || editYaml === detail.yaml}
                        onClick={() => update.mutate({ name: selected, yaml: editYaml })}
                      >
                        {t("action.save")}
                      </button>
                      <p className="text-2xs text-text-500">{t("docker.editWarning")}</p>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-text-400 mb-2">{t("docker.composeLogs")}</h3>
                    <pre className="bg-surface-900 rounded-lg p-3 text-xs font-mono text-text-300 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                      {detail.logs || "—"}
                    </pre>
                  </div>
                </div>
              </>
            ) : (
              <div className="card p-10 text-center text-text-400">
                {t("docker.composeNoProjects")}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title={t("docker.composeDelete")}
        message={t("docker.composeDeleteConfirm")}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={remove.isPending}
      />
    </div>
  );
}
