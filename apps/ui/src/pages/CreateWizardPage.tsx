import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet } from "../api/client";
import type { DatacenterNode } from "@auxinux/shared";

type WizardType = "vm" | "lxc" | "docker";

const TYPE_OPTIONS: Array<{ id: WizardType; label: string; descriptionKey: string }> = [
  { id: "vm", label: "VM", descriptionKey: "wizard.vmDescription" },
  { id: "lxc", label: "LXC", descriptionKey: "wizard.lxcDescription" },
  { id: "docker", label: "Docker", descriptionKey: "wizard.dockerDescription" },
];

export default function CreateWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedNode = searchParams.get("node") ?? "";
  const [resourceType, setResourceType] = useState<WizardType>("vm");
  const [nodeName, setNodeName] = useState("");
  const { data: nodes = [], isLoading } = useQuery<DatacenterNode[]>({
    queryKey: ["datacenter", "nodes"],
    queryFn: () => apiGet<DatacenterNode[]>("/api/nodes"),
  });

  React.useEffect(() => {
    if (!nodeName && nodes.length > 0) {
      setNodeName(
        nodes.find((node) => node.name === requestedNode)?.name
          ?? nodes.find((node) => node.isLocal)?.name
          ?? nodes[0].name,
      );
    }
  }, [nodeName, nodes, requestedNode]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.name === nodeName),
    [nodeName, nodes],
  );
  const canContinue = !!selectedNode?.enabled;
  const nextPath = resourceType === "vm"
    ? `/vms/create?node=${encodeURIComponent(nodeName)}`
    : resourceType === "lxc"
      ? `/lxc/create?node=${encodeURIComponent(nodeName)}`
      : `/docker/create?node=${encodeURIComponent(nodeName)}`;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("wizard.new")}</h1>
          <p className="text-sm text-text-500 mt-0.5">{t("wizard.subtitle")}</p>
        </div>
        <Link to="/dashboard" className="btn">{t("action.cancel")}</Link>
      </div>

      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300">{t("wizard.selectType")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setResourceType(option.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                resourceType === option.id
                  ? "border-accent-blue bg-accent-blue/10"
                  : "border-surface-500 bg-surface-800 hover:border-surface-400"
              }`}
            >
              <div className="text-base font-semibold text-text-100">{option.label}</div>
              <div className="text-sm text-text-500 mt-1">{t(option.descriptionKey)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300">{t("wizard.selectNode")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {nodes.map((node) => (
            <button
              key={node.name}
              type="button"
              onClick={() => setNodeName(node.name)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                nodeName === node.name
                  ? "border-accent-blue bg-accent-blue/10"
                  : "border-surface-500 bg-surface-800 hover:border-surface-400"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-text-100">{node.displayName || node.name}</div>
                  <div className="text-xs text-text-500 mt-1">{node.role}</div>
                </div>
                {node.isLocal && <span className="inline-flex rounded px-2 py-1 text-2xs bg-green-500/20 text-green-300">{t("datacenter.localNode")}</span>}
              </div>
              {!node.isLocal && <p className="text-xs text-text-500 mt-3">{node.status === "online" ? t("wizard.remoteReady") : t("wizard.remoteNodePending")}</p>}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-5 flex items-center justify-between gap-4">
        <div className="text-sm text-text-500">
          {canContinue
            ? (selectedNode?.isLocal ? t("wizard.localReady") : t("wizard.remoteReady"))
            : t("wizard.remoteNotAvailableYet")}
        </div>
        <button
          type="button"
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!canContinue || !nodeName}
          onClick={() => navigate(nextPath)}
        >
          {t("wizard.continue")}
        </button>
      </div>
    </div>
  );
}
