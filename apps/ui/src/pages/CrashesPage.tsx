import React from "react";
import { useTranslation } from "react-i18next";
import { CrashLog } from "../components/CrashLog";
import { ScopeNotice } from "../components/ui/ScopeNotice";

/**
 * Page « Pannes » : arrêts inattendus de toutes les VMs et conteneurs du nœud,
 * avec leur cause et les redémarrages automatiques qui ont suivi.
 */
export default function CrashesPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-text-100">{t("crash.title")}</h1>

      <ScopeNotice title={t("crash.scopeTitle")}>
        {t("crash.scopeDesc")}
      </ScopeNotice>

      <CrashLog />
    </div>
  );
}
