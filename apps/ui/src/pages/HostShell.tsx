import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet } from "../api/client";
import { Terminal } from "../components/Terminal";
import type { SystemInfo } from "@auxinux/shared";

interface HostShellProps {
  infoPath?: string;
  ticketPath?: string;
  title?: string;
  subtitle?: string;
}

export default function HostShell({
  infoPath = "/api/system/info",
  ticketPath = "/api/system/host/console-ticket",
  title,
  subtitle,
}: HostShellProps) {
  const { t } = useTranslation();
  const { data: info } = useQuery<SystemInfo>({
    queryKey: ["system", "info", infoPath],
    queryFn: () => apiGet<SystemInfo>(infoPath),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">{title ?? t("hostShell.title")}</h1>
          <p className="text-sm text-text-500">
            {subtitle ?? t("hostShell.subtitle")}
          </p>
        </div>
        {info && (
          <div className="text-right text-xs text-text-500">
            <div>{info.hostname}</div>
            <div>{info.os}</div>
          </div>
        )}
      </div>

      <div className="card p-2" style={{ height: "calc(100vh - 220px)" }}>
        <Terminal ticketPath={ticketPath} className="h-full" />
      </div>
    </div>
  );
}
