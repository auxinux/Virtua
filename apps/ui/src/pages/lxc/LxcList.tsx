import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { StatusBadge } from "../../components/ui/Badge";
import { ConfirmModal } from "../../components/ui/Modal";
import { useAuth } from "../../utils/useAuth";
import type { LxcContainer } from "@auxinux/shared";

export default function LxcList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { capabilities, getResourcePermissions, isAdmin } = useAuth();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data: containers = [], isLoading } = useQuery<LxcContainer[]>({
    queryKey: ["lxc", "list"],
    queryFn: () => apiGet<LxcContainer[]>("/api/lxc"),
    refetchInterval: 10_000,
  });

  const assignedNames = new Set(capabilities?.resources.lxc.map((r) => r.name) ?? []);
  const visibleContainers = isAdmin
    ? containers
    : containers.filter((ct) => assignedNames.has(ct.name));

  const filteredContainers = search.trim()
    ? visibleContainers.filter((ct) => ct.name.toLowerCase().includes(search.toLowerCase()))
    : visibleContainers;

  const action = useMutation({
    mutationFn: ({ name, act }: { name: string; act: string }) =>
      apiPost(`/api/lxc/${name}/${act}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lxc"] }),
  });

  const remove = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/lxc/${name}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["lxc"] });
    },
  });

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
          <h1 className="text-xl font-bold text-text-100">{t("lxc.containers")}</h1>
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
            className="input text-sm w-40"
          />
          {capabilities?.sections.lxcCreate && <Link to="/lxc/create" className="btn-primary">
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t("action.create")} {t("lxc.container")}
          </Link>}
        </div>
      </div>

      {filteredContainers.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">📦</div>
          <div className="text-text-400">{search ? t("msg.noSearchMatches") : t("lxc.noContainers")}</div>
          {!search && capabilities?.sections.lxcCreate && <Link to="/lxc/create" className="btn-primary mt-4 inline-flex">
            {t("action.create")} {t("lxc.container")}
          </Link>}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.name")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.state")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">IP</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("res.cpu")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("res.memory")}</th>
                {isAdmin && <th className="px-4 py-3 text-left text-text-400 font-medium">{t("common.owner")}</th>}
                <th className="px-4 py-3 text-right text-text-400 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredContainers.map((ct) => {
                const perms = getResourcePermissions("lxc", ct.name);
                return (
                <tr key={ct.name} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/lxc/${ct.name}`}
                      className="text-accent-blue hover:underline font-medium"
                    >
                      {ct.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge state={ct.state} />
                  </td>
                  <td className="px-4 py-3 font-mono text-text-300">
                    {ct.ipAddress || <span className="text-text-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-text-300">{ct.cpus}</td>
                  <td className="px-4 py-3 text-text-300">{ct.memoryMiB} MiB</td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      {(ct as LxcContainer & { userId?: number }).userId != null ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                          #{(ct as LxcContainer & { userId?: number }).userId}
                        </span>
                      ) : (
                        <span className="text-xs text-text-500">{t("msg.unassigned")}</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {perms.canPower && ct.state === "stopped" && (
                        <button
                          onClick={() => action.mutate({ name: ct.name, act: "start" })}
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
                            onClick={() => action.mutate({ name: ct.name, act: "stop" })}
                            disabled={action.isPending}
                            className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                            title={t("action.stop")}
                          >
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <rect x="6" y="6" width="12" height="12" />
                            </svg>
                          </button>
                          <button
                            onClick={() => action.mutate({ name: ct.name, act: "restart" })}
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
                        to={`/lxc/${ct.name}`}
                        className="p-1.5 rounded text-text-400 hover:bg-surface-600 transition-colors"
                        title={t("common.details")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </Link>
                      {perms.canDelete && (
                        <button
                          onClick={() => setDeleteTarget(ct.name)}
                          disabled={ct.state === "running"}
                          className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={ct.state === "running" ? t("lxc.stopBeforeDelete") : t("action.delete")}
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
        message={t("msg.confirmDeleteNamed", { name: deleteTarget ?? "" })}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={remove.isPending}
      />
    </div>
  );
}
