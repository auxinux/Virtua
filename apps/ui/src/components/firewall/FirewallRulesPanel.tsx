import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "../../api/client";
import { ConfirmModal, Modal } from "../ui/Modal";
import type { FirewallRule, FirewallStatus } from "@auxinux/shared";

interface FirewallRulesPanelProps {
  title?: string;
  linkedResourceType?: "vm" | "lxc" | "docker" | "host";
  linkedResourceName?: string;
  defaultTargetIp?: string;
  showHostControls?: boolean;
}

type RuleForm = {
  enabled: boolean;
  type: "allow" | "forward";
  protocol: "tcp" | "udp";
  hostPort: string;
  targetIp: string;
  targetPort: string;
  sourceCidr: string;
  description: string;
  relation: string;
};

const emptyForm = (defaultTargetIp?: string): RuleForm => ({
  enabled: true,
  type: "allow",
  protocol: "tcp",
  hostPort: "",
  targetIp: defaultTargetIp ?? "",
  targetPort: "",
  sourceCidr: "",
  description: "",
  relation: "",
});

export function FirewallRulesPanel({
  title = "Firewall Rules",
  linkedResourceType,
  linkedResourceName,
  defaultTargetIp,
  showHostControls = false,
}: FirewallRulesPanelProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FirewallRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FirewallRule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm(defaultTargetIp));
  const [error, setError] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (linkedResourceType) params.set("linkedResourceType", linkedResourceType);
    if (linkedResourceName) params.set("linkedResourceName", linkedResourceName);
    return params.toString() ? `/api/firewall/rules?${params.toString()}` : "/api/firewall/rules";
  }, [linkedResourceName, linkedResourceType]);

  const { data: status } = useQuery<FirewallStatus>({
    queryKey: ["firewall", "status"],
    queryFn: () => apiGet<FirewallStatus>("/api/firewall/status"),
    enabled: showHostControls,
    refetchInterval: 10_000,
  });

  const { data: rules = [] } = useQuery<FirewallRule[]>({
    queryKey: ["firewall", "rules", linkedResourceType ?? "all", linkedResourceName ?? "all"],
    queryFn: () => apiGet<FirewallRule[]>(query),
    refetchInterval: 10_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["firewall"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const saveRule = useMutation({
    mutationFn: () => {
      const payload = {
        enabled: form.enabled,
        type: form.type,
        protocol: form.protocol,
        hostPort: parseInt(form.hostPort, 10),
        targetIp: form.type === "forward" ? (form.targetIp || undefined) : undefined,
        targetPort: form.type === "forward" && form.targetPort ? parseInt(form.targetPort, 10) : undefined,
        sourceCidr: form.sourceCidr || undefined,
        description: form.description || undefined,
        linkedResourceType,
        linkedResourceName,
        relation: form.relation || (linkedResourceName ? `${linkedResourceType?.toUpperCase()} ${linkedResourceName}` : undefined),
      };
      return editing
        ? apiPut(`/api/firewall/rules/${editing.id}`, payload)
        : apiPost("/api/firewall/rules", payload);
    },
    onSuccess: () => {
      setModalOpen(false);
      setEditing(null);
      setForm(emptyForm(defaultTargetIp));
      setError("");
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => apiDelete(`/api/firewall/rules/${ruleId}`),
    onSuccess: () => {
      setDeleteTarget(null);
      refresh();
    },
  });

  const updateFirewall = useMutation({
    mutationFn: ({ enabled, protectSsh }: { enabled: boolean; protectSsh?: boolean }) => apiPut("/api/firewall/settings", { enabled, protectSsh }),
    onSuccess: () => refresh(),
  });

  const syncFirewall = useMutation({
    mutationFn: () => apiPost("/api/firewall/sync", {}),
    onSuccess: () => refresh(),
  });

  useEffect(() => {
    if (!modalOpen) return;
    if (!editing) {
      setForm(emptyForm(defaultTargetIp));
      setError("");
      return;
    }
    setForm({
      enabled: editing.enabled,
      type: editing.type,
      protocol: editing.protocol,
      hostPort: String(editing.hostPort),
      targetIp: editing.targetIp ?? defaultTargetIp ?? "",
      targetPort: editing.targetPort ? String(editing.targetPort) : "",
      sourceCidr: editing.sourceCidr ?? "",
      description: editing.description ?? "",
      relation: editing.relation ?? "",
    });
    setError("");
  }, [defaultTargetIp, editing, modalOpen]);

  const manualRules = rules.filter((rule) => rule.sourceKind === "manual");

  return (
    <div className="space-y-4">
      {showHostControls && status && (
        <div className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-text-200">{title}</h3>
              <div className="mt-2 space-y-1 text-sm text-text-400">
                <div>Backend: <span className="font-mono text-text-200">{status.backend}</span></div>
                <div>Protected ports: <span className="font-mono text-text-200">{status.protectedPorts.join(", ")}</span></div>
                <div>SSH: <span className="font-mono text-text-200">{status.protectSsh ? `open on ${status.sshPort}` : "closed"}</span></div>
                <div>Rules: <span className="font-mono text-text-200">{status.rulesCount}</span></div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => updateFirewall.mutate({ enabled: !status.enabled, protectSsh: status.protectSsh })} disabled={updateFirewall.isPending} className={status.enabled ? "btn-danger" : "btn-primary"}>
                {status.enabled ? "Disable Firewall" : "Enable Firewall"}
              </button>
              <button onClick={() => updateFirewall.mutate({ enabled: status.enabled, protectSsh: !status.protectSsh })} disabled={updateFirewall.isPending} className="btn-secondary">
                {status.protectSsh ? "Close SSH Port" : "Open SSH Port"}
              </button>
              <button onClick={() => syncFirewall.mutate()} disabled={syncFirewall.isPending} className="btn-secondary">
                {syncFirewall.isPending ? "Syncing..." : "Resync"}
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-text-500">
            SSH and the Virtua web port stay protected automatically. Docker published ports are synchronized while containers are running.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-300">
          {title} ({rules.length})
        </h3>
        <button
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          className="btn-primary text-sm"
        >
          + Add Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="card p-6 text-center text-text-400 text-sm">No firewall rules configured</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">Status</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Type</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Port</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Target</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Linked To</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Source</th>
                <th className="px-4 py-2 text-right text-text-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-surface-700">
                  <td className="px-4 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      rule.enabled ? "bg-green-500/15 text-green-400" : "bg-surface-600 text-text-400"
                    }`}>
                      {rule.sourceKind === "auto" ? "Auto" : "Manual"} · {rule.enabled ? "Ready" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-200 uppercase">{rule.type}</td>
                  <td className="px-4 py-2 font-mono text-text-200">{rule.hostPort}/{rule.protocol}</td>
                  <td className="px-4 py-2 font-mono text-text-300">
                    {rule.type === "forward" ? `${rule.targetIp}:${rule.targetPort}` : "Host"}
                  </td>
                  <td className="px-4 py-2 text-text-300">
                    {rule.linkedResourceType && rule.linkedResourceName ? `${rule.linkedResourceType}:${rule.linkedResourceName}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-text-400">{rule.description || rule.relation || "—"}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {rule.sourceKind === "manual" && (
                        <>
                          <button onClick={() => { setEditing(rule); setModalOpen(true); }} className="btn-secondary btn-sm">Edit</button>
                          <button onClick={() => setDeleteTarget(rule)} className="btn-danger btn-sm">Delete</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        title={editing ? "Edit Firewall Rule" : "Add Firewall Rule"}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        footer={
          <>
            <button onClick={() => { setModalOpen(false); setEditing(null); }} className="btn-secondary">Cancel</button>
            <button onClick={() => saveRule.mutate()} disabled={saveRule.isPending || !form.hostPort} className="btn-primary">
              {saveRule.isPending ? "Saving..." : "Save"}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Rule Type</label>
              <select className="select" value={form.type} onChange={(e) => setForm((current) => ({ ...current, type: e.target.value as "allow" | "forward" }))}>
                <option value="allow">Allow host port</option>
                <option value="forward">Forward to guest</option>
              </select>
            </div>
            <div>
              <label className="label">Protocol</label>
              <select className="select" value={form.protocol} onChange={(e) => setForm((current) => ({ ...current, protocol: e.target.value as "tcp" | "udp" }))}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Host Port</label>
              <input className="input font-mono" value={form.hostPort} onChange={(e) => setForm((current) => ({ ...current, hostPort: e.target.value }))} placeholder="8080" />
            </div>
            <div>
              <label className="label">Allowed Source (optional)</label>
              <input className="input font-mono" value={form.sourceCidr} onChange={(e) => setForm((current) => ({ ...current, sourceCidr: e.target.value }))} placeholder="0.0.0.0/0 or 192.168.1.0/24" />
            </div>
          </div>

          {form.type === "forward" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Target IP</label>
                <input className="input font-mono" value={form.targetIp} onChange={(e) => setForm((current) => ({ ...current, targetIp: e.target.value }))} placeholder="192.168.122.10" />
              </div>
              <div>
                <label className="label">Target Port</label>
                <input className="input font-mono" value={form.targetPort} onChange={(e) => setForm((current) => ({ ...current, targetPort: e.target.value }))} placeholder="80" />
              </div>
            </div>
          )}

          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} placeholder="Public HTTPS for this VM" />
          </div>

          {!linkedResourceName && (
            <div>
              <label className="label">Relation</label>
              <input className="input" value={form.relation} onChange={(e) => setForm((current) => ({ ...current, relation: e.target.value }))} placeholder="Host app / VM / service name" />
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-accent-blue" checked={form.enabled} onChange={(e) => setForm((current) => ({ ...current, enabled: e.target.checked }))} />
            <span className="text-sm text-text-300">Rule enabled</span>
          </label>

          {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteRule.mutate(deleteTarget.id)}
        title={t("modal.deleteFirewallRule")}
        message={`Delete firewall rule on port ${deleteTarget?.hostPort}/${deleteTarget?.protocol}?`}
        confirmLabel="Delete"
        dangerous
        loading={deleteRule.isPending}
      />
    </div>
  );
}
