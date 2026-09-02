import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RotateCcw, XCircle, Ban, ChevronDown, ChevronRight } from "lucide-react";
import { apiGet, apiDelete, apiPut } from "../api/client";
import type { GuestCrashEvent } from "@auxinux/shared";
import { useAuth } from "../utils/useAuth";

/**
 * Journal des pannes — utilisé à deux endroits :
 *  - page globale « Pannes » (toutes les machines du nœud) ;
 *  - onglet « Pannes » d'une VM ou d'un conteneur (une seule machine).
 */

const EVENT_STYLES: Record<GuestCrashEvent["event"], { color: string; icon: React.ReactNode; labelKey: string }> = {
  crash: { color: "text-red-400", icon: <AlertTriangle className="w-3.5 h-3.5" />, labelKey: "crash.eventCrash" },
  restart: { color: "text-green-400", icon: <RotateCcw className="w-3.5 h-3.5" />, labelKey: "crash.eventRestart" },
  "restart-failed": { color: "text-amber-400", icon: <XCircle className="w-3.5 h-3.5" />, labelKey: "crash.eventRestartFailed" },
  "gave-up": { color: "text-amber-500", icon: <Ban className="w-3.5 h-3.5" />, labelKey: "crash.eventGaveUp" },
};

const REASON_KEYS: Record<string, string> = {
  crashed: "crash.reasonCrashed",
  failed: "crash.reasonFailed",
  panicked: "crash.reasonPanicked",
  killed: "crash.reasonKilled",
  unexpected: "crash.reasonUnexpected",
};

interface CrashLogProps {
  /** Restreint le journal à une machine ; absent = toutes les machines. */
  resource?: { type: "vm" | "lxc"; name: string };
  limit?: number;
}

export function CrashLog({ resource, limit = 100 }: CrashLogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (resource) {
    query.set("resourceType", resource.type);
    query.set("resourceName", resource.name);
  }
  const queryKey = ["crash-events", resource?.type ?? "all", resource?.name ?? "all", page];

  const { data, isLoading } = useQuery<{ events: GuestCrashEvent[]; total: number }>({
    queryKey,
    queryFn: () => apiGet<{ events: GuestCrashEvent[]; total: number }>(`/api/crash-events?${query.toString()}`),
    refetchInterval: 20_000,
  });

  const clear = useMutation({
    mutationFn: () => apiDelete(`/api/crash-events${resource ? `?resourceType=${resource.type}&resourceName=${encodeURIComponent(resource.name)}` : ""}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crash-events"] }),
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-500">{total} {t("crash.eventsCount")}</span>
        {isAdmin && total > 0 && (
          <button
            onClick={() => { if (confirm(t("crash.confirmClear"))) clear.mutate(); }}
            disabled={clear.isPending}
            className="btn text-xs disabled:opacity-40"
          >
            {t("crash.clear")}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("crash.colTime")}</th>
                {!resource && <th className="px-4 py-3 text-left text-text-400 font-medium">{t("crash.colResource")}</th>}
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("crash.colEvent")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("crash.colReason")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("crash.colDetail")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const style = EVENT_STYLES[event.event] ?? EVENT_STYLES.crash;
                const isOpen = expanded === event.id;
                return (
                  <React.Fragment key={event.id}>
                    <tr
                      className="border-b border-surface-700 hover:bg-surface-700/20 transition-colors cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : event.id)}
                    >
                      <td className="px-4 py-2 text-text-400 text-xs font-mono whitespace-nowrap">
                        {new Date(event.createdAt).toLocaleString()}
                      </td>
                      {!resource && (
                        <td className="px-4 py-2 text-xs">
                          <span className="text-text-500 mr-1">{event.resourceType.toUpperCase()}</span>
                          <span className="font-mono text-text-200">{event.resourceName}</span>
                        </td>
                      )}
                      <td className={`px-4 py-2 text-xs font-medium ${style.color}`}>
                        <span className="inline-flex items-center gap-1.5">
                          {style.icon}
                          {t(style.labelKey)}
                          {event.attempt ? ` (${event.attempt})` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-text-300 text-xs">
                        {event.reason ? t(REASON_KEYS[event.reason] ?? "crash.reasonUnexpected") : "—"}
                      </td>
                      <td className="px-4 py-2 text-text-400 text-xs">
                        <span className="inline-flex items-center gap-1">
                          {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <span className="max-w-md truncate">
                            {event.detail ? event.detail.split("\n")[0] : t("crash.noDetail")}
                          </span>
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-surface-700 bg-black/30">
                        <td colSpan={resource ? 4 : 5} className="px-4 py-3">
                          <pre className="text-xs font-mono text-text-300 whitespace-pre-wrap max-h-80 overflow-y-auto custom-scrollbar">
                            {event.detail || t("crash.noDetail")}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {events.length === 0 && (
                <tr>
                  <td colSpan={resource ? 4 : 5} className="px-4 py-8 text-center text-text-500">
                    {t("crash.noEvents")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-surface-600">
              <span className="text-xs text-text-500">{page} / {totalPages}</span>
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

/**
 * Réglage « redémarrer automatiquement après une panne » d'une machine.
 * `null` = la machine suit le réglage par défaut du nœud (page Paramètres).
 */
export function CrashRestartToggle({
  resourceType,
  resourceName,
  value,
  canModify,
}: {
  resourceType: "vm" | "lxc";
  resourceName: string;
  value: boolean | null | undefined;
  canModify: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const update = useMutation({
    mutationFn: (restartOnCrash: boolean | null) =>
      apiPut(`/api/${resourceType === "vm" ? "vms" : "lxc"}/${encodeURIComponent(resourceName)}/config`, { restartOnCrash }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [resourceType, resourceName] });
      qc.invalidateQueries({ queryKey: ["crash-events"] });
    },
  });

  const current: "default" | "on" | "off" = value === null || value === undefined ? "default" : value ? "on" : "off";

  return (
    <div className="card p-5 space-y-3">
      <h3 className="text-sm font-semibold text-text-300">{t("crash.policyTitle")}</h3>
      <p className="text-xs text-text-500">{t("crash.policyHelp")}</p>
      <div className="flex flex-wrap gap-2">
        {([
          { id: "default", label: t("crash.policyDefault"), next: null },
          { id: "on", label: t("crash.policyOn"), next: true },
          { id: "off", label: t("crash.policyOff"), next: false },
        ] as const).map((option) => (
          <button
            key={option.id}
            disabled={!canModify || update.isPending}
            onClick={() => update.mutate(option.next)}
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors disabled:opacity-40 ${
              current === option.id
                ? "border-accent-blue bg-accent-blue/10 text-text-100"
                : "border-surface-600 text-text-400 hover:text-text-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {update.isError && (
        <p className="text-xs text-red-400">{(update.error as Error).message}</p>
      )}
    </div>
  );
}
