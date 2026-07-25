import React from "react";
import { useTranslation } from "react-i18next";

type BadgeVariant = "running" | "stopped" | "paused" | "frozen" | "degraded" | "rebuilding" | "active" | "inactive" | "unknown" | "admin" | "user" | "default";

const variants: Record<BadgeVariant, string> = {
  running:    "badge-status badge-status-running",
  stopped:    "badge-status badge-status-stopped",
  paused:     "badge-status badge-status-paused",
  frozen:     "badge-status badge-status-frozen",
  degraded:   "badge-status badge-status-degraded",
  rebuilding: "badge-status badge-status-rebuilding",
  active:     "badge-status badge-status-running",
  inactive:   "bg-surface-600 text-text-400 border border-surface-500",
  unknown:    "bg-surface-600 text-text-500 border border-surface-500",
  admin:      "bg-blue-900/40 text-blue-300 border border-blue-800",
  user:       "bg-surface-600 text-text-400 border border-surface-500",
  default:    "bg-surface-600 text-text-300 border border-surface-500",
};

const dots: Partial<Record<BadgeVariant, string>> = {
  running:    "bg-green-400",
  stopped:    "bg-red-400",
  paused:     "bg-yellow-400",
  active:     "bg-green-400",
  inactive:   "bg-surface-400",
  degraded:   "bg-red-400",
  rebuilding: "bg-yellow-400",
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}

export function Badge({ variant = "default", children, dot = false, className = "" }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium ${variants[variant]} ${className}`}>
      {dot && dots[variant] && (
        <span className={`w-1.5 h-1.5 rounded-full ${dots[variant]} inline-block`} />
      )}
      {children}
    </span>
  );
}

export function StatusBadge({ state }: { state: string }) {
  const { t } = useTranslation();
  const normalized = state.toLowerCase() as BadgeVariant;
  const labels: Record<string, string> = {
    running: t("status.running"),
    stopped: t("status.stopped"),
    paused: t("status.paused"),
    frozen: t("status.frozen"),
    active: t("status.active"),
    inactive: t("status.inactive"),
    degraded: t("status.degraded"),
    rebuilding: t("status.rebuilding"),
    failed: t("status.failed"),
    unknown: t("status.unknown"),
  };
  return <Badge variant={normalized} dot>{labels[normalized] ?? state}</Badge>;
}
