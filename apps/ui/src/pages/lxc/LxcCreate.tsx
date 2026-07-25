import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../../api/client";
import type { LxcTemplate, StoragePool } from "@auxinux/shared";

const MAX_LXC_DISK_GB = 65536;
const INTERNAL_BRIDGES = new Set(["lxcbr0", "virbr0", "docker0"]);

interface CreateLxcPayload {
  name: string;
  template: string;
  cpus: number;
  memoryMiB: number;
  diskGb: number;
  storagePool: string;
  rootPassword: string;
  networkMode: "dhcp" | "static";
  ipAddress?: string;
  gateway?: string;
  dnsMode: "auto" | "custom";
  dnsServers: string;
  bridge: string;
  macAddress?: string;
  autostart: boolean;
  overwriteSources: boolean;
}

interface CreateLxcApiPayload {
  name: string;
  dist: string;
  release: string;
  arch: string;
  variant?: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  bridge: string;
  macAddress?: string;
  ipv4?: string;
  ipv4Gateway?: string;
  dnsServers: string[];
  password: string;
  autostart: boolean;
  overwriteSources?: boolean;
}

export default function LxcCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedTemplate = searchParams.get("template") ?? "";
  const targetNode = searchParams.get("node");

  const [form, setForm] = useState<CreateLxcPayload>({
    name: "",
    template: selectedTemplate,
    cpus: 1,
    memoryMiB: 512,
    diskGb: 8,
    storagePool: "",
    rootPassword: "",
    networkMode: "dhcp",
    dnsMode: "auto",
    dnsServers: "",
    bridge: "lxcbr0",
    macAddress: "",
    autostart: false,
    overwriteSources: false,
  });
  const [error, setError] = useState("");

  const { data: templates = [] } = useQuery<LxcTemplate[]>({
    queryKey: ["lxc", "templates", targetNode || "local"],
    queryFn: () => apiGet<LxcTemplate[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/lxc/templates` : "/api/lxc/templates"),
  });

  const { data: pools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools", targetNode || "local"],
    queryFn: () => apiGet<StoragePool[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/storage/pools` : "/api/storage/pools"),
  });

  const { data: bridges = [] } = useQuery<string[]>({
    queryKey: ["network", "bridges-list", targetNode || "local"],
    queryFn: async () => {
      const res = await apiGet<{ name: string }[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/network/bridges` : "/api/network/bridges");
      return res.map((b) => b.name);
    },
  });

  const create = useMutation({
    mutationFn: (payload: CreateLxcApiPayload) => apiPost(`/api/lxc${targetNode ? `?node=${encodeURIComponent(targetNode)}` : ""}`, payload),
    onSuccess: () => navigate("/lxc"),
    onError: (err: Error) => setError(err.message),
  });

  const set = (field: keyof CreateLxcPayload, value: unknown) =>
    setForm((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    if (selectedTemplate) {
      setForm((current) => current.template === selectedTemplate ? current : { ...current, template: selectedTemplate });
    }
  }, [selectedTemplate]);

  // When the bridge list loads, auto-select the best available bridge:
  // prefer lxcbr0 (native LXC bridge with DHCP) > br0 > virbr0 > first in list
  useEffect(() => {
    if (bridges.length === 0) return;
    setForm((f) => {
      if (bridges.includes(f.bridge)) return f; // already valid
      const preferred = ["lxcbr0", "br0", "virbr0"].find((b) => bridges.includes(b)) ?? bridges[0];
      return { ...f, bridge: preferred };
    });
  }, [bridges]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!form.name.match(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/)) {
      setError(t("lxc.containerNameInvalid"));
      return;
    }
    if (!form.template) { setError(t("lxc.selectTemplateRequired")); return; }
    if (!form.storagePool) { setError(t("vm.storagePoolRequired")); return; }
    if (form.rootPassword.length < 6) { setError(t("lxc.rootPasswordRequired")); return; }
    if (form.networkMode === "static" && !form.ipAddress) {
      setError(t("lxc.staticIpRequired")); return;
    }
    if (form.macAddress && !form.macAddress.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)) {
      setError(t("vm.macInvalid")); return;
    }
    const [dist = "", release = "", arch = "amd64", variant = "default"] = form.template.split(":");
    if (!dist || !release) {
      setError(t("lxc.invalidTemplate"));
      return;
    }
    create.mutate({
      name: form.name,
      dist,
      release,
      arch,
      variant,
      cpuCores: form.cpus,
      memoryMb: form.memoryMiB,
      diskGb: form.diskGb,
      bridge: form.bridge,
      macAddress: form.macAddress || undefined,
      ipv4: form.networkMode === "static" ? form.ipAddress : undefined,
      ipv4Gateway: form.networkMode === "static" ? form.gateway : undefined,
      dnsServers: form.dnsMode === "custom" ? form.dnsServers.split(/[\n,\s]+/).filter(Boolean) : [],
      password: form.rootPassword,
      autostart: form.autostart,
      overwriteSources: dist.toLowerCase() === "debian" ? form.overwriteSources : false,
    });
  };

  const isDebianTemplate = form.template.toLowerCase().startsWith("debian");

  const publicStaticOnInternalBridge =
    form.networkMode === "static" &&
    Boolean(form.ipAddress) &&
    INTERNAL_BRIDGES.has(form.bridge);

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/lxc")}
          className="text-text-400 hover:text-text-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("lxc.createContainer")}</h1>
          {targetNode && <p className="text-xs text-text-500 mt-1">{t("datacenter.node")}: {targetNode}</p>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("common.details")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("lxc.containerName")} *</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. ct-nginx"
                required
              />
            </div>
            <div>
              <label className="label">{t("lxc.template")} *</label>
              <select
                className="input"
                value={form.template}
                onChange={(e) => set("template", e.target.value)}
                required
              >
                <option value="">— {t("lxc.selectTemplate")} —</option>
                {templates.map((tmpl) => (
                  <option key={tmpl.name} value={tmpl.name}>
                    {tmpl.name}{tmpl.size ? ` (${(tmpl.size / 1024 / 1024).toFixed(0)} MB)` : ""}
                  </option>
                ))}
              </select>
              {templates.length === 0 && (
                <p className="text-xs text-yellow-400 mt-1">{t("lxc.noCachedTemplatesCreate")}</p>
              )}
            </div>
          </div>

          <div>
            <label className="label">{t("lxc.rootPassword")} *</label>
            <input
              type="password"
              className="input"
              value={form.rootPassword}
              onChange={(e) => set("rootPassword", e.target.value)}
              placeholder={t("lxc.rootPasswordPlaceholder")}
              required
            />
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("vm.resources")}</h2>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label">{t("res.cpu")}</label>
              <input
                type="number"
                className="input"
                min={1}
                max={64}
                value={form.cpus}
                onChange={(e) => set("cpus", parseInt(e.target.value, 10))}
              />
            </div>
            <div>
              <label className="label">{t("res.memory")} (MiB)</label>
              <input
                type="number"
                className="input"
                min={64}
                step={64}
                value={form.memoryMiB}
                onChange={(e) => set("memoryMiB", parseInt(e.target.value, 10))}
              />
            </div>
            <div>
              <label className="label">{t("res.disk")} (GB)</label>
              <input
                type="number"
                className="input"
                min={1}
                max={MAX_LXC_DISK_GB}
                value={form.diskGb}
                onChange={(e) => set("diskGb", parseInt(e.target.value, 10))}
              />
            </div>
          </div>

          <div>
            <label className="label">{t("storage.pool")} *</label>
            <select
              className="input"
              value={form.storagePool}
              onChange={(e) => set("storagePool", e.target.value)}
              required
            >
              <option value="">— {t("common.select")} —</option>
              {pools.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("res.network")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("lxc.networkMode")}</label>
              <select
                className="input"
                value={form.networkMode}
                onChange={(e) => set("networkMode", e.target.value as "dhcp" | "static")}
              >
                <option value="dhcp">DHCP</option>
                <option value="static">{t("lxc.staticIp")}</option>
              </select>
            </div>
            <div>
              <label className="label">{t("vm.networkBridge")}</label>
              <select
                className="input"
                value={form.bridge}
                onChange={(e) => set("bridge", e.target.value)}
              >
                {bridges.length === 0 && <option value="lxcbr0">lxcbr0 (default)</option>}
                {bridges.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">{t("lxc.manualMac")}</label>
            <input
              className="input font-mono"
              value={form.macAddress || ""}
              onChange={(e) => set("macAddress", e.target.value.toLowerCase())}
              placeholder="aa:bb:cc:dd:ee:ff"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("lxc.dnsMode")}</label>
              <select
                className="input"
                value={form.dnsMode}
                onChange={(e) => set("dnsMode", e.target.value as "auto" | "custom")}
              >
                <option value="auto">{t("lxc.dnsAuto")}</option>
                <option value="custom">{t("lxc.dnsCustom")}</option>
              </select>
            </div>
            {form.dnsMode === "custom" && (
              <div>
                <label className="label">{t("lxc.dnsServers")}</label>
                <input
                  className="input font-mono"
                  value={form.dnsServers}
                  onChange={(e) => set("dnsServers", e.target.value)}
                  placeholder="1.1.1.1, 8.8.8.8"
                />
              </div>
            )}
          </div>

          {form.networkMode === "static" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t("lxc.ipAddressCidr")}</label>
                <input
                  className="input font-mono"
                  value={form.ipAddress || ""}
                  onChange={(e) => set("ipAddress", e.target.value)}
                  placeholder="192.168.1.100/24"
                />
              </div>
              <div>
                <label className="label">{t("lxc.gateway")}</label>
                <input
                  className="input font-mono"
                  value={form.gateway || ""}
                  onChange={(e) => set("gateway", e.target.value)}
                  placeholder="192.168.1.1"
                />
              </div>
            </div>
          )}

          {publicStaticOnInternalBridge && (
            <div className="rounded border border-yellow-800/60 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-300">
              {t("network.publicIpInternalBridgeWarning")}
            </div>
          )}
        </div>

        <div className="card p-5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
              checked={form.autostart}
              onChange={(e) => set("autostart", e.target.checked)}
            />
            <span className="text-sm text-text-300">{t("vm.autostart")}</span>
          </label>
          {isDebianTemplate && (
            <label className="flex items-start gap-2 cursor-pointer mt-3">
              <input
                type="checkbox"
                className="w-4 h-4 mt-0.5 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                checked={form.overwriteSources}
                onChange={(e) => set("overwriteSources", e.target.checked)}
              />
              <span className="text-sm text-text-300">
                Écraser les sources APT avec le dépôt AuxiNux (DEB + VIRTUA KERNEL)
                <span className="block text-xs text-text-500">Remplace /etc/apt/sources.list par le miroir Debian AuxiNux et ajoute le dépôt kernel Virtua.</span>
              </span>
            </label>
          )}
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>
        )}

        <div className="flex gap-3">
          <button type="submit" disabled={create.isPending} className="btn-primary">
            {create.isPending ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {t("common.creating")}
              </span>
            ) : (
              `${t("action.create")} ${t("lxc.container")}`
            )}
          </button>
          <button type="button" onClick={() => navigate("/lxc")} className="btn">
            {t("action.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
