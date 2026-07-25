import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { StatusBadge } from "../../components/ui/Badge";
import { ConfirmModal } from "../../components/ui/Modal";
import { useAuth } from "../../utils/useAuth";
import { formatBytes } from "../../utils/formatBytes";
import type { QemuVm, VmStats } from "@auxinux/shared";

function usageColor(percent?: number) {
  if (percent === undefined) return "bg-surface-500";
  if (percent < 50) return "bg-green-500";
  if (percent < 75) return "bg-yellow-400";
  return "bg-red-500";
}

function UsageBar({ percent }: { percent?: number }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="mt-1.5 h-1.5 w-28 rounded-full bg-surface-700 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${usageColor(percent)}`} style={{ width: `${value}%` }} />
    </div>
  );
}

function VmUsageCells({ vm }: { vm: QemuVm }) {
  const { t } = useTranslation();
  const isRunning = vm.state === "running";
  const { data: stats } = useQuery<VmStats>({
    queryKey: ["vm", vm.name, "stats", "list"],
    queryFn: () => apiGet<VmStats>(`/api/vms/${encodeURIComponent(vm.name)}/stats`),
    enabled: isRunning,
    refetchInterval: isRunning ? 5_000 : false,
  });

  return (
    <>
      <td className="px-4 py-3 text-text-300">
        <div>{vm.vcpus} {t("vm.vcpus")}</div>
        {isRunning && (
          <>
            <UsageBar percent={stats?.cpuPercent} />
            <div className="mt-1 text-2xs font-mono text-text-500">{(stats?.cpuPercent ?? 0).toFixed(1)}%</div>
          </>
        )}
      </td>
      <td className="px-4 py-3 text-text-300">
        <div>{formatBytes((vm.maxMemoryKiB ?? 0) * 1024)}</div>
        {isRunning && (
          <>
            <UsageBar percent={stats?.memPercent} />
            <div className="mt-1 text-2xs font-mono text-text-500">
              {stats ? `${stats.memPercent.toFixed(0)}%` : "0%"}
            </div>
          </>
        )}
      </td>
    </>
  );
}

export default function VmList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { capabilities, getResourcePermissions, isAdmin } = useAuth();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data: vms = [], isLoading } = useQuery<QemuVm[]>({
    queryKey: ["vms"],
    queryFn: () => apiGet<QemuVm[]>("/api/vms"),
    refetchInterval: 10_000,
  });

  // Non-admin users only see VMs explicitly assigned to them
  const assignedNames = new Set(capabilities?.resources.vms.map((r) => r.name) ?? []);
  const visibleVms = isAdmin
    ? vms
    : vms.filter((vm) => assignedNames.has(vm.name));

  const filteredVms = search.trim()
    ? visibleVms.filter((vm) => vm.name.toLowerCase().includes(search.toLowerCase()))
    : visibleVms;

  const action = useMutation({
    mutationFn: ({ name, act }: { name: string; act: string }) => apiPost(`/api/vms/${name}/${act}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vms"] }),
  });

  const deleteVm = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/vms/${name}?deleteDisks=true`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vms"] }); setDeleteTarget(null); },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("nav.vms")}</h1>
          {!isAdmin && (
            <p className="text-xs text-text-500 mt-0.5">
              {t("msg.assignedCount", { count: visibleVms.length })}
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
          {capabilities?.sections.vmCreate && (
            <Link to="/vms/create" className="btn-primary">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t("vm.createVm")}
            </Link>
          )}
        </div>
      </div>

      {filteredVms.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-text-500">{search ? t("vm.noMatches") : t("msg.noData")}</p>
          {!search && capabilities?.sections.vmCreate && <Link to="/vms/create" className="btn-primary mt-4 inline-flex">{t("vm.createVm")}</Link>}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-500">
              <tr className="text-left text-xs font-medium text-text-500 uppercase tracking-wider">
                <th className="px-4 py-3">{t("common.name")}</th>
                <th className="px-4 py-3">{t("common.status")}</th>
                <th className="px-4 py-3">{t("res.cpu")}</th>
                <th className="px-4 py-3">{t("res.memory")}</th>
                {isAdmin && <th className="px-4 py-3">{t("common.owner")}</th>}
                <th className="px-4 py-3 text-right">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-600">
              {filteredVms.map((vm) => (
                <tr key={vm.name} className="hover:bg-surface-600/30 transition-colors">
                  {(() => {
                    const perms = getResourcePermissions("vm", vm.name);
                    return (
                      <>
                  <td className="px-4 py-3">
                    <Link to={`/vms/${vm.name}`} className="text-accent-blue-light hover:underline font-medium">
                      {vm.name}
                    </Link>
                    {vm.uuid && <div className="text-2xs text-text-500 font-mono">{vm.uuid.substring(0, 8)}...</div>}
                  </td>
                  <td className="px-4 py-3"><StatusBadge state={vm.state} /></td>
                  <VmUsageCells vm={vm} />
                  {isAdmin && (
                    <td className="px-4 py-3">
                      {vm.userId != null ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                          #{vm.userId}
                        </span>
                      ) : (
                        <span className="text-xs text-text-500">{t("msg.unassigned")}</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {perms.canPower && vm.state === "stopped" && (
                        <button onClick={() => action.mutate({ name: vm.name, act: "start" })} className="btn-ghost btn-sm text-green-400 hover:text-green-300" title={t("action.start")}>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        </button>
                      )}
                      {perms.canPower && vm.state === "running" && (
                        <>
                          <button onClick={() => action.mutate({ name: vm.name, act: "stop" })} className="btn-ghost btn-sm text-yellow-400 hover:text-yellow-300" title={t("action.stop")}>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
                          </button>
                          <button onClick={() => action.mutate({ name: vm.name, act: "reboot" })} className="btn-ghost btn-sm" title={t("action.reboot")}>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          </button>
                          <button onClick={() => action.mutate({ name: vm.name, act: "reset" })} className="btn-ghost btn-sm" title={t("action.reset")}>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5V2L7 7l5 5V9a5 5 0 11-4.58 3" /></svg>
                          </button>
                        </>
                      )}
                      <Link to={`/vms/${vm.name}`} className="btn-ghost btn-sm" title={t("common.details")}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      </Link>
                      {perms.canDelete && (
                        <button onClick={() => setDeleteTarget(vm.name)} className="btn-ghost btn-sm text-red-400 hover:text-red-300" title={t("action.delete")}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      )}
                    </div>
                  </td>
                      </>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteVm.mutate(deleteTarget)}
        title={`${t("action.delete")} ${t("vm.vm")}`}
        message={t("msg.confirmDelete", { name: deleteTarget ?? "" })}
        confirmLabel={t("action.delete")}
        dangerous
        loading={deleteVm.isPending}
      />
    </div>
  );
}
