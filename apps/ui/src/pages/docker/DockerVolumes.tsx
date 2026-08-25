import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { ConfirmModal } from "../../components/ui/Modal";
import type { DockerVolume } from "@auxinux/shared";

export default function DockerVolumes() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("local");
  const [error, setError] = useState("");

  const { data: volumes = [], isLoading } = useQuery<DockerVolume[]>({
    queryKey: ["docker", "volumes"],
    queryFn: () => apiGet<DockerVolume[]>("/api/docker/volumes"),
  });

  const create = useMutation({
    mutationFn: () => apiPost("/api/docker/volumes", { name, driver }),
    onSuccess: () => {
      setCreating(false);
      setName("");
      setDriver("local");
      qc.invalidateQueries({ queryKey: ["docker", "volumes"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (vol: string) => apiDelete(`/api/docker/volumes/${encodeURIComponent(vol)}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["docker", "volumes"] });
    },
    onError: (err: Error) => setError(err.message),
  });

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
            <h1 className="text-xl font-bold text-text-100">{t("docker.volumesTitle")}</h1>
            <p className="text-xs text-text-500 mt-0.5">{t("docker.volumes")}</p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t("docker.volumeCreate")}
        </button>
      </div>

      {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}

      {creating && (
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300">{t("docker.volumeCreate")}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("docker.volumeName")}</label>
              <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-data" />
            </div>
            <div>
              <label className="label">{t("docker.volumeDriver")}</label>
              <input className="input font-mono" value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="local" />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={create.isPending || !name} onClick={() => create.mutate()}>
              {t("action.create")}
            </button>
            <button className="btn-ghost" onClick={() => setCreating(false)}>{t("action.cancel")}</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
        </div>
      ) : volumes.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">💾</div>
          <div className="text-text-400">{t("docker.volumesNoVolumes")}</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.name")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("docker.volumeDriver")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">Mountpoint</th>
                <th className="px-4 py-3 text-right text-text-400 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((v) => (
                <tr key={v.name} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-200">{v.name}</td>
                  <td className="px-4 py-3 text-text-300">{v.driver}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-400 truncate max-w-[300px]" title={v.mountpoint}>{v.mountpoint || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <button
                        onClick={() => setDeleteTarget(v.name)}
                        className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                        title={t("action.delete")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title={t("action.delete")}
        message={t("docker.volumeDeleteConfirm")}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={remove.isPending}
      />
    </div>
  );
}
