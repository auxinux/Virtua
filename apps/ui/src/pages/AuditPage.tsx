import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiDelete } from "../api/client";
import type { AuditLog, TaskProgress } from "@auxinux/shared";
import { ScopeNotice } from "../components/ui/ScopeNotice";
import { useTranslation } from "react-i18next";

const RESULT_COLORS: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
};

const ACTION_ICONS: Record<string, string> = {
  login: "🔑",
  logout: "🚪",
  vm_create: "🖥",
  vm_delete: "🗑",
  vm_start: "▶",
  vm_stop: "⏹",
  lxc_create: "📦",
  lxc_delete: "🗑",
  docker_create: "🐳",
  docker_delete: "🗑",
  user_create: "👤",
  user_delete: "🗑",
  storage_create: "💾",
};

type Tab = "tasks" | "audit" | "security";

const TASK_STATUS_COLORS: Record<string, string> = {
  completed: "text-green-400",
  failed: "text-red-400",
  running: "text-accent-blue",
  pending: "text-yellow-400",
};

export default function AuditPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("tasks");

  const tabs: Array<{ id: Tab; label: string; locked?: boolean }> = [
    { id: "tasks", label: t("logs.tabTasks") },
    { id: "audit", label: t("logs.tabAudit") },
    { id: "security", label: t("logs.tabSecurity"), locked: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-100">{t("logs.title")}</h1>
      </div>

      <ScopeNotice title={t("scope.controlPlaneTitle")}>
        {t("scope.auditControlPlaneDesc")}
      </ScopeNotice>

      <div className="flex gap-1 border-b border-surface-600">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === tb.id
                ? "border-accent-blue text-text-100"
                : "border-transparent text-text-400 hover:text-text-200"
            }`}
          >
            {tb.locked && <span className="mr-1">🔒</span>}
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "tasks" && <TasksTab />}
      {tab === "audit" && <AuditTab category="general" clearable />}
      {tab === "security" && <AuditTab category="security" />}
    </div>
  );
}

function TasksTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<TaskProgress[]>({
    queryKey: ["tasks-history"],
    queryFn: () => apiGet<TaskProgress[]>("/api/tasks?limit=200"),
    refetchInterval: 10_000,
  });
  const clear = useMutation({
    mutationFn: () => apiDelete("/api/tasks"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks-history"] }),
  });

  const tasks = data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-500">{tasks.length} {t("logs.tasksCount")}</span>
        <button
          onClick={() => { if (confirm(t("logs.confirmClearTasks"))) clear.mutate(); }}
          disabled={clear.isPending}
          className="btn text-xs disabled:opacity-40"
        >
          {t("logs.clear")}
        </button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <Th>{t("logs.colTime")}</Th>
                <Th>{t("logs.colUser")}</Th>
                <Th>{t("logs.colAction")}</Th>
                <Th>{t("logs.colResource")}</Th>
                <Th>{t("logs.colStatus")}</Th>
                <Th>{t("logs.colDetails")}</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-surface-700 hover:bg-surface-700/20 transition-colors">
                  <Td mono>{new Date(task.updatedAt || task.createdAt).toLocaleString()}</Td>
                  <td className="px-4 py-2 text-text-300">{task.ownerUsername || "—"}</td>
                  <td className="px-4 py-2 text-text-200">{task.action || task.kind}</td>
                  <td className="px-4 py-2 text-text-400 text-xs">
                    {task.resourceType && <span className="mr-1">{task.resourceType}</span>}
                    {task.resourceName && <span className="font-mono">{task.resourceName}</span>}
                    {!task.resourceType && !task.resourceName && "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs font-medium ${TASK_STATUS_COLORS[task.status] ?? "text-text-400"}`}>
                      {task.status}{task.status === "running" ? ` ${Math.round(task.progressPercent)}%` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-400 text-xs max-w-md truncate" title={task.error || task.message || task.detail || "—"}>
                    {task.error || task.message || task.detail || "—"}
                  </td>
                </tr>
              ))}
              {tasks.length === 0 && <EmptyRow colSpan={6} text={t("logs.noTasks")} />}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AuditTab({ category, clearable }: { category: "general" | "security"; clearable?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const limit = 50;

  const { data, isLoading } = useQuery<{ logs: AuditLog[]; total: number }>({
    queryKey: ["audit", category, page, filter],
    queryFn: () =>
      apiGet<{ logs: AuditLog[]; total: number }>(
        `/api/audit-logs?category=${category}&page=${page}&limit=${limit}${filter ? `&action=${encodeURIComponent(filter)}` : ""}`
      ),
    refetchInterval: 30_000,
  });
  const clear = useMutation({
    mutationFn: () => apiDelete("/api/audit-logs"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["audit"] }),
  });

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-3">
      {category === "security" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          🔒 {t("logs.securityImmutable")}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <input
          className="input w-56 text-sm"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(1); }}
          placeholder={t("logs.filterPlaceholder")}
        />
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-500">{total} {t("logs.eventsCount")}</span>
          {clearable && (
            <button
              onClick={() => { if (confirm(t("logs.confirmClearAudit"))) clear.mutate(); }}
              disabled={clear.isPending}
              className="btn text-xs disabled:opacity-40"
            >
              {t("logs.clear")}
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <Spinner />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <Th>{t("logs.colTime")}</Th>
                <Th>{t("logs.colUser")}</Th>
                <Th>{t("logs.colAction")}</Th>
                <Th>{t("logs.colResource")}</Th>
                <Th>{t("logs.colResult")}</Th>
                <Th>{t("logs.colDetails")}</Th>
                <Th>{t("logs.colIp")}</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-surface-700 hover:bg-surface-700/20 transition-colors">
                  <Td mono>{new Date(log.createdAt).toLocaleString()}</Td>
                  <td className="px-4 py-2 text-text-300">{log.username || "—"}</td>
                  <td className="px-4 py-2 text-text-200">{ACTION_ICONS[log.action] || "•"} {log.action}</td>
                  <td className="px-4 py-2 text-text-400 text-xs">
                    {log.resourceType && <span className="mr-1">{log.resourceType}</span>}
                    {log.resourceName && <span className="font-mono">{log.resourceName}</span>}
                    {!log.resourceType && !log.resourceName && "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs font-medium ${RESULT_COLORS[log.result ?? ""] ?? "text-text-400"}`}>
                      {log.result || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-400 text-xs max-w-md truncate" title={log.details || "—"}>
                    {log.details || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-text-400 text-xs">{log.ip || "—"}</td>
                </tr>
              ))}
              {logs.length === 0 && <EmptyRow colSpan={7} text={t("logs.noLogs")} />}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-surface-600">
              <span className="text-xs text-text-500">{t("logs.page")} {page} / {totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn text-xs disabled:opacity-40">{t("logs.prev")}</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="btn text-xs disabled:opacity-40">{t("logs.next")}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-text-400 font-medium">{children}</th>;
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`px-4 py-2 text-text-400 ${mono ? "text-xs font-mono whitespace-nowrap" : ""}`}>{children}</td>;
}
function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-text-500">{text}</td>
    </tr>
  );
}
function Spinner() {
  return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
