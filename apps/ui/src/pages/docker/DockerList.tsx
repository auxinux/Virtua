import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { StatusBadge } from "../../components/ui/Badge";
import { ConfirmModal } from "../../components/ui/Modal";
import { useAuth } from "../../utils/useAuth";
import type { DockerContainer } from "@auxinux/shared";

export default function DockerList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { capabilities, getResourcePermissions, isAdmin } = useAuth();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data: containers = [], isLoading } = useQuery<DockerContainer[]>({
    queryKey: ["docker", "list"],
    queryFn: () => apiGet<DockerContainer[]>("/api/docker/containers"),
    refetchInterval: 10_000,
  });

  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: string }) =>
      apiPost(`/api/docker/containers/${id}/${act}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/docker/containers/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["docker"] });
    },
  });

  // Non-admin users only see Docker containers explicitly assigned to them
  const assignedIds = new Set(capabilities?.resources.docker.map((r) => r.id) ?? []);
  const visibleContainers = isAdmin
    ? containers
    : containers.filter((ct) =>
        assignedIds.has(ct.id) ||
        [...assignedIds].some((aid) => aid.startsWith(ct.id.substring(0, 12)) || ct.id.startsWith(aid.substring(0, 12)))
      );

  const filteredContainers = search.trim()
    ? visibleContainers.filter(
        (ct) =>
          ct.name.toLowerCase().includes(search.toLowerCase()) ||
          ct.image.toLowerCase().includes(search.toLowerCase())
      )
    : visibleContainers;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("docker.containers")}</h1>
          {!isAdmin && (
            <p className="text-xs text-text-500 mt-0.5">
              {t("msg.assignedCount", { count: visibleContainers.length })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder={t("msg.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-sm w-44"
          />
          {capabilities?.sections.dockerCreate && <Link to="/docker/create" className="btn-primary">
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t("action.create")} {t("docker.container")}
          </Link>}
        </div>
      </div>

      {filteredContainers.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">🐳</div>
          <div className="text-text-400">{search ? t("msg.noSearchMatches") : t("docker.noContainers")}</div>
          {!search && capabilities?.sections.dockerCreate && <Link to="/docker/create" className="btn-primary mt-4 inline-flex">
            {t("docker.createFirst")}
          </Link>}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.name")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("docker.image")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.state")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("tab.ports")}</th>
                {isAdmin && <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.owner")}</th>}
                <th className="px-4 py-3 text-right text-text-400 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredContainers.map((ct) => {
                const perms = getResourcePermissions("docker", ct.id);
                return (
                <tr key={ct.id} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link to={`/docker/${ct.id}`} className="text-accent-blue hover:underline font-medium">
                      {ct.name}
                    </Link>
                    <div className="text-2xs text-text-500 font-mono">{ct.id.substring(0, 12)}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-300 max-w-[180px] truncate" title={ct.image}>
                    {ct.image}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge state={ct.state} />
                  </td>
                  <td className="px-4 py-3 text-text-400 text-xs font-mono">
                    {ct.ports?.length
                      ? ct.ports.map((p) => `${p.hostPort}:${p.containerPort}`).join(", ")
                      : "—"}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      {(ct as DockerContainer & { userId?: number }).userId != null ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                          #{(ct as DockerContainer & { userId?: number }).userId}
                        </span>
                      ) : (
                        <span className="text-xs text-text-500">{t("msg.unassigned")}</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {perms.canPower && ct.state !== "running" && (
                        <button
                          onClick={() => action.mutate({ id: ct.id, act: "start" })}
                          disabled={action.isPending}
                          className="p-1.5 rounded text-green-400 hover:bg-green-900/30 transition-colors"
                          title={t("action.start")}
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                      )}
                      {perms.canPower && ct.state === "running" && (
                        <>
                          <button
                            onClick={() => action.mutate({ id: ct.id, act: "stop" })}
                            disabled={action.isPending}
                            className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                            title={t("action.stop")}
                          >
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <rect x="6" y="6" width="12" height="12" />
                            </svg>
                          </button>
                          <button
                            onClick={() => action.mutate({ id: ct.id, act: "restart" })}
                            disabled={action.isPending}
                            className="p-1.5 rounded text-yellow-400 hover:bg-yellow-900/30 transition-colors"
                            title={t("action.restart")}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                        </>
                      )}
                      <Link
                        to={`/docker/${ct.id}`}
                        className="p-1.5 rounded text-text-400 hover:bg-surface-600 transition-colors"
                        title={t("common.details")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </Link>
                      {perms.canDelete && (
                        <button
                          onClick={() => setDeleteTarget(ct.id)}
                          className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                          title={t("action.delete")}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title={t("docker.deleteTitle")}
        message={t("docker.deleteMessage")}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={remove.isPending}
      />
    </div>
  );
}
