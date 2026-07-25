import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet } from "../api/client";
import { Modal } from "../components/ui/Modal";
import { Terminal } from "../components/Terminal";
import type { AptUpdateStatus, HostServiceStatus } from "@auxinux/shared";

interface HealthPageProps {
  servicesPath?: string;
  updatesPath?: string;
  ticketPath?: string;
  title?: string;
  subtitle?: string;
}

export default function HealthPage({
  servicesPath = "/api/system/services",
  updatesPath = "/api/system/updates",
  ticketPath = "/api/system/host/console-ticket",
  title,
  subtitle,
}: HealthPageProps) {
  const { t } = useTranslation();
  const [maintenanceCommand, setMaintenanceCommand] = useState<string | null>(null);
  const aptSandboxOption = "-o APT::Sandbox::User=root";

  const { data: services = [] } = useQuery<HostServiceStatus[]>({
    queryKey: ["health", "services", servicesPath],
    queryFn: () => apiGet<HostServiceStatus[]>(servicesPath),
    refetchInterval: 10_000,
  });

  const { data: updates } = useQuery<AptUpdateStatus>({
    queryKey: ["health", "updates", updatesPath],
    queryFn: () => apiGet<AptUpdateStatus>(updatesPath),
    refetchInterval: 60_000,
  });

  const counts = useMemo(() => ({
    failed: services.filter((service) => service.status === "failed").length,
    running: services.filter((service) => service.status === "running").length,
  }), [services]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">{title ?? t("node.health")}</h1>
          <p className="text-sm text-text-500">{subtitle ?? t("health.subtitle")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-text-500">{t("health.servicesTitle")}</div>
          <div className="mt-2 text-3xl font-bold text-text-100">{counts.running}</div>
          <div className="text-sm text-text-500">{t("health.running")}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-text-500">{t("health.serviceErrors")}</div>
          <div className={`mt-2 text-3xl font-bold ${counts.failed > 0 ? "text-red-400" : "text-text-100"}`}>{counts.failed}</div>
          <div className="text-sm text-text-500">{t("health.failedOrUnhealthy")}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-text-500">{t("health.updatesTitle")}</div>
          <div className={`mt-2 text-3xl font-bold ${(updates?.upgradableCount ?? 0) > 0 ? "text-yellow-400" : "text-text-100"}`}>{updates?.upgradableCount ?? 0}</div>
          <div className="text-sm text-text-500">{updates?.rebootRequired ? t("health.rebootRequired") : t("health.packagesUpgradable")}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.7fr] gap-4">
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-300">{t("health.services")}</h2>
            <span className="text-xs text-text-500">{t("health.autoRefresh")}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("health.service")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("health.state")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("health.substate")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("health.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.name} className="border-b border-surface-700">
                  <td className="px-4 py-2">
                    <div className="text-text-200 font-medium">{service.description || service.name}</div>
                    <div className="text-xs font-mono text-text-500">{service.name}</div>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      service.status === "running"
                        ? "bg-green-500/15 text-green-400"
                        : service.status === "failed"
                        ? "bg-red-500/15 text-red-400"
                        : "bg-surface-600 text-text-300"
                    }`}>
                      {service.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-400">{service.subState || "—"}</td>
                  <td className="px-4 py-2 text-text-400">{service.errorReason || service.result || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-text-300">{t("health.systemUpdates")}</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-text-500">{t("health.upgradablePackages")}</span>
                <span className="font-mono text-text-200">{updates?.upgradableCount ?? 0}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-text-500">{t("health.aptCacheUpdated")}</span>
                <span className="font-mono text-text-200">{updates?.cacheUpdatedAt ? new Date(updates.cacheUpdatedAt).toLocaleString() : t("status.unknown")}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-text-500">{t("health.rebootNeeded")}</span>
                <span className={`font-mono ${updates?.rebootRequired ? "text-yellow-400" : "text-text-200"}`}>{updates?.rebootRequired ? t("generic.yes") : t("generic.no")}</span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => setMaintenanceCommand(`apt ${aptSandboxOption} update`)} className="btn-secondary">{t("health.runAptUpdate")}</button>
              <button onClick={() => setMaintenanceCommand(`apt ${aptSandboxOption} upgrade`)} className="btn-primary">{t("health.interactiveUpgrade")}</button>
              <button onClick={() => setMaintenanceCommand(`apt ${aptSandboxOption} full-upgrade`)} className="btn-secondary">{t("health.interactiveFullUpgrade")}</button>
            </div>
            <p className="mt-3 text-xs text-text-500">
              {t("health.maintenanceHint")}
            </p>
          </div>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-text-300">{t("health.upgradablePackagesTitle")}</h2>
            {updates?.packages?.length ? (
              <div className="mt-3 max-h-64 overflow-y-auto space-y-1">
                {updates.packages.map((pkg) => (
                  <div key={pkg} className="rounded bg-surface-700 px-2 py-1 font-mono text-xs text-text-300">{pkg}</div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-text-500">{t("health.noPendingUpdates")}</p>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!maintenanceCommand}
        onClose={() => setMaintenanceCommand(null)}
        title={maintenanceCommand ? `Maintenance Terminal · ${maintenanceCommand}` : "Maintenance Terminal"}
        size="xl"
      >
        {maintenanceCommand && (
          <div className="space-y-3">
            <p className="text-sm text-text-400">
              {t("health.maintenanceTerminalHint")}
            </p>
            <div className="card p-2" style={{ height: "70vh" }}>
              <Terminal ticketPath={ticketPath} ticketBody={{ initialCommand: maintenanceCommand }} className="h-full" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
