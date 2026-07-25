import React from "react";
import { FirewallRulesPanel } from "../../components/firewall/FirewallRulesPanel";
import { useTranslation } from "react-i18next";
import { ScopeNotice } from "../../components/ui/ScopeNotice";

export default function FirewallPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-text-100">Firewall</h1>
      <ScopeNotice title={t("scope.localNodeTitle")} tone="warning">
        {t("scope.firewallNodeDesc")}
      </ScopeNotice>
      <FirewallRulesPanel title="Host Firewall" showHostControls />
    </div>
  );
}
