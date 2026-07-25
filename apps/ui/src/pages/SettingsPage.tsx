import React, { useState, useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut, apiPost, apiDelete } from "../api/client";
import { ConfirmModal } from "../components/ui/Modal";
import { ResourceAclPanel } from "../components/acl/ResourceAclPanel";
import { MfaSettingsCard } from "../components/settings/MfaSettingsCard";
import { applyTheme, getStoredTheme, type AppTheme } from "../utils/theme";
import type { DatacenterConfig, DatacenterJoinToken, DatacenterNode } from "@auxinux/shared";

interface Settings {
  siteName?: string;
  defaultStoragePool?: string;
  defaultBridge?: string;
  maxUploadSizeGb?: number;
  sessionTimeoutMinutes?: number;
  enableAuditLog?: boolean;
  enableRateLimit?: boolean;
  "repo.deb"?: string;
  "repo.templates"?: string;
  "repo.kernel"?: string;
  "repo.generic"?: string;
}

const REPO_PLACEHOLDERS: Record<string, string> = {
  "repo.deb": "https://dep.auxinux.ca/debian/",
  "repo.templates": "https://dep.auxinux.ca/TEMPLATES/",
  "repo.kernel": "https://dep.auxinux.ca/VIRTUA/KERNEL/",
  "repo.generic": "https://dep.auxinux.ca/VIRTUA/",
};

interface VdmManagerStatus {
  joined: boolean;
  managerApiUrl: string | null;
  joinedAt: string | null;
  localNodeName: string;
  localDisplayName: string;
  localApiUrl: string | null;
  nodeAuthTokenPresent: boolean;
}

interface ResourceCatalogEntry {
  resourceType: "vm" | "lxc" | "docker";
  resourceName: string;
  displayName: string;
  ownerId: number | null;
  ownerUsername?: string | null;
  nodeName?: string;
}

interface ResourceAclSummaryEntry {
  resourceType: "vm" | "lxc" | "docker";
  resourceName: string;
  entryCount: number;
}

interface SslStatus {
  enabled: boolean;
  certExists: boolean;
  domain?: string;
  email?: string;
  challenge?: "http-01" | "dns-01";
  issuedAt?: string;
  expiresAt?: string;
  daysUntilExpiry?: number;
  autoRenew?: boolean;
  isExpired?: boolean;
  staging?: boolean;
}

type SshAccessMode = "key-only" | "key-and-password" | "password-only";

interface SshAccessStatus {
  mode: SshAccessMode;
  dropinPath: string;
  service: {
    unit: string;
    loadState: string;
    activeState: string;
    unitFileState: string;
  };
  effective: {
    pubkeyAuthentication: string;
    passwordAuthentication: string;
    kbdInteractiveAuthentication: string;
    permitRootLogin: string;
  };
  key: {
    privateKeyExists: boolean;
    publicKeyExists: boolean;
    authorized: boolean;
    fingerprint?: string;
    privateKeyPath: string;
  };
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { name: routeNodeName } = useParams();
  const qc = useQueryClient();
  const [settings, setSettings] = useState<Settings>({});
  const [saved, setSaved] = useState(false);
  const [rebootOpen, setRebootOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [selectedAclKey, setSelectedAclKey] = useState("");
  const [aclSearch, setAclSearch] = useState("");
  const [aclTypeFilter, setAclTypeFilter] = useState<"all" | "vm" | "lxc" | "docker">("all");
  const [datacenterConfig, setDatacenterConfig] = useState<DatacenterConfig>({
    mode: "standalone",
    name: "Datacenter",
    primaryNodeName: "",
  });
  const [newNode, setNewNode] = useState({
    name: "",
    displayName: "",
    apiUrl: "",
    notes: "",
    role: "secondary" as "primary" | "secondary",
    enabled: true,
  });
  const [joinTokenForm, setJoinTokenForm] = useState({ note: "", expiresInMinutes: 60 });
  const [joinForm, setJoinForm] = useState({
    primaryApiUrl: "",
    token: "",
    nodeName: "",
    displayName: "",
    apiUrl: typeof window !== "undefined" ? window.location.origin : "",
  });
  const [vdmManagerForm, setVdmManagerForm] = useState({
    managerApiUrl: "",
    joinToken: "",
    displayName: "",
    apiUrl: typeof window !== "undefined" ? window.location.origin : "",
  });
  const [sslProvisionForm, setSslProvisionForm] = useState({
    domain: "",
    email: "",
    challenge: "http-01" as "http-01" | "dns-01",
    staging: false,
  });
  const [sslImportForm, setSslImportForm] = useState({
    domain: "",
    certPem: "",
    keyPem: "",
  });
  const [sshMode, setSshMode] = useState<SshAccessMode>("key-only");
  const [sshDownloadError, setSshDownloadError] = useState("");

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const nextTheme = (event as CustomEvent<AppTheme>).detail;
      setTheme(nextTheme);
    };
    window.addEventListener("auxinux-theme-change", onThemeChange as EventListener);
    return () => window.removeEventListener("auxinux-theme-change", onThemeChange as EventListener);
  }, []);

  const isNodeSettingsRoute = location.pathname.startsWith("/nodes/") && location.pathname.endsWith("/settings");
  const targetNodeName = routeNodeName || "";

  const { data, isLoading } = useQuery<Settings>({
    queryKey: ["settings", isNodeSettingsRoute ? targetNodeName : "local"],
    queryFn: () => apiGet<Settings>(isNodeSettingsRoute ? `/api/nodes/${encodeURIComponent(targetNodeName)}/settings` : "/api/settings"),
    enabled: !isNodeSettingsRoute || !!targetNodeName,
  });

  const { data: resourceCatalog = [] } = useQuery<ResourceCatalogEntry[]>({
    queryKey: ["resources", "catalog"],
    queryFn: () => apiGet<ResourceCatalogEntry[]>("/api/resources/catalog"),
  });

  const { data: datacenter, isLoading: datacenterLoading } = useQuery<DatacenterConfig>({
    queryKey: ["datacenter", "config"],
    queryFn: () => apiGet<DatacenterConfig>("/api/datacenter"),
    enabled: false,
  });

  const { data: nodes = [] } = useQuery<DatacenterNode[]>({
    queryKey: ["datacenter", "nodes"],
    queryFn: () => apiGet<DatacenterNode[]>("/api/nodes"),
  });

  const { data: joinTokens = [] } = useQuery<DatacenterJoinToken[]>({
    queryKey: ["datacenter", "joinTokens"],
    queryFn: () => apiGet<DatacenterJoinToken[]>("/api/datacenter/join-tokens"),
    enabled: false,
  });

  const { data: vdmManagerStatus } = useQuery<VdmManagerStatus>({
    queryKey: ["vdm-manager", "status"],
    queryFn: () => apiGet<VdmManagerStatus>("/api/vdm-manager/status"),
    enabled: !isNodeSettingsRoute,
  });

  const { data: sslStatus } = useQuery<SslStatus>({
    queryKey: ["ssl", "status"],
    queryFn: () => apiGet<SslStatus>("/api/ssl/status"),
    enabled: !isNodeSettingsRoute,
  });

  const { data: sshStatus } = useQuery<SshAccessStatus>({
    queryKey: ["ssh", "status"],
    queryFn: () => apiGet<SshAccessStatus>("/api/settings/ssh"),
    enabled: !isNodeSettingsRoute,
  });

  const { data: aclSummary = [] } = useQuery<ResourceAclSummaryEntry[]>({
    queryKey: ["resources", "acl-summary"],
    queryFn: () => apiGet<ResourceAclSummaryEntry[]>("/api/resources/acl-summary"),
  });

  useEffect(() => {
    if (data) setSettings(data);
  }, [data]);

  useEffect(() => {
    if (sshStatus?.mode) setSshMode(sshStatus.mode);
  }, [sshStatus]);

  useEffect(() => {
    if (datacenter) setDatacenterConfig(datacenter);
  }, [datacenter]);

  useEffect(() => {
    if (!vdmManagerStatus) return;
    setVdmManagerForm((current) => ({
      ...current,
      managerApiUrl: current.managerApiUrl || vdmManagerStatus.managerApiUrl || "",
      displayName: current.displayName || vdmManagerStatus.localDisplayName || "",
      apiUrl: current.apiUrl || vdmManagerStatus.localApiUrl || current.apiUrl,
    }));
  }, [vdmManagerStatus]);

  useEffect(() => {
    if (!joinForm.nodeName) {
      setJoinForm((current) => ({ ...current, nodeName: nodes.find((node) => node.isLocal)?.name ?? current.nodeName }));
    }
  }, [joinForm.nodeName, nodes]);

  useEffect(() => {
    if (!selectedAclKey && resourceCatalog.length > 0) {
      setSelectedAclKey(`${resourceCatalog[0].resourceType}:${resourceCatalog[0].resourceName}`);
    }
  }, [selectedAclKey, resourceCatalog]);

  const update = useMutation({
    mutationFn: () => apiPut(isNodeSettingsRoute ? `/api/nodes/${encodeURIComponent(targetNodeName)}/settings` : "/api/settings", settings),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const updateDatacenter = useMutation({
    mutationFn: () => apiPut("/api/datacenter", datacenterConfig),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter"] });
    },
  });

  const updateSshMode = useMutation({
    mutationFn: () => apiPut<SshAccessStatus>("/api/settings/ssh", { mode: sshMode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ssh", "status"] }),
  });

  const generateSshKey = useMutation({
    mutationFn: () => apiPost<SshAccessStatus>("/api/settings/ssh/key"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ssh", "status"] }),
  });

  const downloadSshKey = async () => {
    setSshDownloadError("");
    const res = await fetch("/api/settings/ssh/key/download", { credentials: "include" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
      throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "auxinux-virtua-admin_ed25519";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const createNode = useMutation({
    mutationFn: () => apiPost("/api/nodes", {
      ...newNode,
      displayName: newNode.displayName.trim() || undefined,
      apiUrl: newNode.apiUrl.trim() || undefined,
      notes: newNode.notes.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter", "nodes"] });
      setNewNode({
        name: "",
        displayName: "",
        apiUrl: "",
        notes: "",
        role: "secondary",
        enabled: true,
      });
    },
  });

  const deleteNode = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/nodes/${encodeURIComponent(name)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter", "nodes"] });
      qc.invalidateQueries({ queryKey: ["datacenter", "config"] });
    },
  });

  const createJoinToken = useMutation({
    mutationFn: () => apiPost<DatacenterJoinToken>("/api/datacenter/join-tokens", joinTokenForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter", "joinTokens"] });
      setJoinTokenForm({ note: "", expiresInMinutes: 60 });
    },
  });

  const deleteJoinToken = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/datacenter/join-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datacenter", "joinTokens"] }),
  });

  const joinDatacenter = useMutation({
    mutationFn: () => apiPost("/api/datacenter/join", {
      ...joinForm,
      nodeName: joinForm.nodeName.trim() || undefined,
      displayName: joinForm.displayName.trim() || undefined,
      apiUrl: joinForm.apiUrl.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter"] });
      qc.invalidateQueries({ queryKey: ["datacenter", "nodes"] });
    },
  });

  const leaveDatacenter = useMutation({
    mutationFn: () => apiPost("/api/datacenter/leave", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datacenter"] });
      qc.invalidateQueries({ queryKey: ["datacenter", "nodes"] });
      qc.invalidateQueries({ queryKey: ["datacenter", "summary"] });
    },
  });

  const joinVdmManager = useMutation({
    mutationFn: () => apiPost("/api/vdm-manager/join", vdmManagerForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vdm-manager"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const leaveVdmManager = useMutation({
    mutationFn: () => apiPost("/api/vdm-manager/leave", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vdm-manager"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const provisionSsl = useMutation({
    mutationFn: () => apiPost("/api/ssl/provision", sslProvisionForm),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ssl", "status"] }),
  });

  const importSsl = useMutation({
    mutationFn: () => apiPost("/api/ssl/import", sslImportForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ssl", "status"] });
      setSslImportForm({ domain: "", certPem: "", keyPem: "" });
    },
  });

  const renewSsl = useMutation({
    mutationFn: () => apiPost("/api/ssl/renew", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ssl", "status"] }),
  });

  const removeSsl = useMutation({
    mutationFn: () => apiDelete("/api/ssl"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ssl", "status"] }),
  });

  const reboot = useMutation({
    mutationFn: () => apiPost("/api/system/reboot", {}),
    onSuccess: () => setRebootOpen(false),
  });

  const shutdown = useMutation({
    mutationFn: () => apiPost("/api/system/shutdown", {}),
    onSuccess: () => setShutdownOpen(false),
  });

  const set = (key: keyof Settings, value: unknown) =>
    setSettings((s) => ({ ...s, [key]: value }));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const forcedDatacenterScope = false;
  const multiNodeMode = false;
  const pageScope = "node";
  const showNodeSections = true;
  const showDatacenterSections = false;
  const nodeSettingsTarget = isNodeSettingsRoute
    ? (nodes.find((node) => node.name === targetNodeName)?.displayName || targetNodeName)
    : undefined;

  const selectedAclResource = resourceCatalog.find((entry) => `${entry.resourceType}:${entry.resourceName}` === selectedAclKey);
  const aclSummaryMap = new Map(aclSummary.map((entry) => [`${entry.resourceType}:${entry.resourceName}`, entry.entryCount]));
  const filteredAclResources = resourceCatalog.filter((entry) => {
    if (aclTypeFilter !== "all" && entry.resourceType !== aclTypeFilter) return false;
    const haystack = `${entry.resourceType} ${entry.displayName} ${entry.resourceName} ${entry.ownerUsername ?? ""}`.toLowerCase();
    return haystack.includes(aclSearch.trim().toLowerCase());
  });
  const resourcesWithAcl = filteredAclResources.filter((entry) => (aclSummaryMap.get(`${entry.resourceType}:${entry.resourceName}`) ?? 0) > 0);
  const resourcesWithoutAcl = filteredAclResources.filter((entry) => (aclSummaryMap.get(`${entry.resourceType}:${entry.resourceName}`) ?? 0) === 0);

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-bold text-text-100">
        {isNodeSettingsRoute
          ? `${t("nav.nodeSettings")} · ${nodeSettingsTarget || targetNodeName}`
          : t("nav.settings")}
      </h1>

      {isNodeSettingsRoute && (
        <div className="flex items-center gap-3 text-sm">
          <Link to={`/nodes/${encodeURIComponent(targetNodeName)}`} className="text-accent-blue hover:underline">
            {t("action.open")}
          </Link>
        </div>
      )}

      {/* General */}
      {showNodeSections && <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">General</h2>

        <div>
          <label className="label">Site Name</label>
          <input
            className="input"
            value={settings.siteName || ""}
            onChange={(e) => set("siteName", e.target.value)}
            placeholder="AuxiNux Virtua Control"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Default Storage Pool</label>
            <input
              className="input"
              value={settings.defaultStoragePool || ""}
              onChange={(e) => set("defaultStoragePool", e.target.value)}
              placeholder="local"
            />
          </div>
          <div>
            <label className="label">Default Network Bridge</label>
            <input
              className="input font-mono"
              value={settings.defaultBridge || ""}
              onChange={(e) => set("defaultBridge", e.target.value)}
              placeholder="virbr0"
            />
          </div>
        </div>
      </div>}

      {showNodeSections && <div className="card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">Dépôts AuxiNux</h2>
          <p className="mt-1 text-xs text-text-500">URL des dépôts utilisés par le serveur (templates/ISO, miroir Debian, kernel Virtua). Laisser vide pour la valeur par défaut.</p>
        </div>
        {([
          { key: "repo.deb" as const, label: "Dépôt DEB (miroir Debian)" },
          { key: "repo.templates" as const, label: "Dépôt VIRTUA TEMPLATES (ISO + VM)" },
          { key: "repo.kernel" as const, label: "Dépôt VIRTUA KERNEL" },
          { key: "repo.generic" as const, label: "Dépôt VIRTUA GENERIC" },
        ]).map((entry) => (
          <div key={entry.key}>
            <label className="label">{entry.label}</label>
            <input
              className="input font-mono text-sm"
              value={settings[entry.key] || ""}
              onChange={(e) => set(entry.key, e.target.value)}
              placeholder={REPO_PLACEHOLDERS[entry.key]}
            />
          </div>
        ))}
      </div>}

      {showNodeSections && <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">Appearance</h2>
        <div>
          <label className="label">Theme</label>
          <select
            className="input"
            value={theme}
            onChange={(e) => {
              const nextTheme = e.target.value as AppTheme;
              setTheme(nextTheme);
              applyTheme(nextTheme);
            }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <p className="text-xs text-text-500 mt-1">Stored locally in this browser.</p>
        </div>
      </div>}

      {showNodeSections && !isNodeSettingsRoute && <div className="card p-5 space-y-4">
        <div className="border-b border-surface-500 pb-2">
          <h2 className="text-sm font-semibold text-text-300">Accès SSH</h2>
          <p className="mt-1 text-xs text-text-500">
            Contrôle l’authentification SSH du serveur et la clé administrateur générée par Virtua.
          </p>
        </div>

        <div className="rounded border border-surface-500 bg-surface-700/40 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-text-200">
                {sshStatus?.service.activeState === "active" ? "SSH actif" : "SSH non actif"}
              </div>
              <div className="mt-1 text-xs text-text-500">
                {sshStatus ? `${sshStatus.service.unit} · boot=${sshStatus.service.unitFileState}` : "Chargement..."}
              </div>
            </div>
            <span className={`inline-flex rounded px-2 py-1 text-2xs ${sshStatus?.service.activeState === "active" ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
              {sshStatus?.mode ?? "key-only"}
            </span>
          </div>
        </div>

        <div>
          <label className="label">Mode d’authentification</label>
          <select
            className="input"
            value={sshMode}
            onChange={(e) => setSshMode(e.target.value as SshAccessMode)}
          >
            <option value="key-only">Clé uniquement</option>
            <option value="key-and-password">Clé + login/mot de passe</option>
            <option value="password-only">Login/mot de passe uniquement</option>
          </select>
          <p className="mt-1 text-xs text-text-500">
            Changer ce mode recharge SSH immédiatement. Assure-toi d’avoir une session ouverte avant de désactiver une méthode d’accès.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={updateSshMode.isPending || sshMode === sshStatus?.mode}
            onClick={() => updateSshMode.mutate()}
          >
            {updateSshMode.isPending ? "Application..." : "Appliquer le mode SSH"}
          </button>
          <button
            className="btn"
            disabled={generateSshKey.isPending}
            onClick={() => generateSshKey.mutate()}
          >
            {generateSshKey.isPending ? "Génération..." : "Générer une nouvelle clé"}
          </button>
          <button
            className="btn"
            disabled={!sshStatus?.key.privateKeyExists}
            onClick={() => downloadSshKey().catch((err) => setSshDownloadError(err instanceof Error ? err.message : String(err)))}
          >
            Télécharger la clé
          </button>
        </div>

        <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2 text-xs text-text-400 space-y-1">
          <div>Clé privée gérée : <span className="font-mono text-text-200">{sshStatus?.key.privateKeyExists ? sshStatus.key.privateKeyPath : "aucune"}</span></div>
          <div>Clé autorisée pour root : <span className={sshStatus?.key.authorized ? "text-green-300" : "text-yellow-300"}>{sshStatus?.key.authorized ? "oui" : "non"}</span></div>
          {sshStatus?.key.fingerprint && <div className="font-mono break-all">{sshStatus.key.fingerprint}</div>}
          {sshStatus?.effective && (
            <div className="font-mono text-text-500">
              pubkey={sshStatus.effective.pubkeyAuthentication || "?"} · password={sshStatus.effective.passwordAuthentication || "?"} · root={sshStatus.effective.permitRootLogin || "?"}
            </div>
          )}
        </div>

        {(updateSshMode.error || generateSshKey.error || sshDownloadError) && (
          <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {sshDownloadError || (updateSshMode.error instanceof Error ? updateSshMode.error.message : "") || (generateSshKey.error instanceof Error ? generateSshKey.error.message : "")}
          </div>
        )}
        {generateSshKey.isSuccess && <p className="text-xs text-green-300">Nouvelle clé générée et installée dans authorized_keys.</p>}
      </div>}

      {showNodeSections && !isNodeSettingsRoute && <div className="card p-5 space-y-5">
        <div className="border-b border-surface-500 pb-2">
          <h2 className="text-sm font-semibold text-text-300">{t("settings.sslTitle")}</h2>
          <p className="mt-1 text-xs text-text-500">{t("settings.sslDescription")}</p>
        </div>

        <div className="rounded border border-surface-500 bg-surface-700/40 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-text-200">
                {sslStatus?.certExists ? (sslStatus.enabled ? t("settings.sslEnabled") : t("settings.sslExpired")) : t("settings.sslNotConfigured")}
              </div>
              <div className="mt-1 text-xs text-text-500">
                {sslStatus?.certExists
                  ? `${sslStatus.domain || "—"} · ${sslStatus.expiresAt ? new Date(sslStatus.expiresAt).toLocaleString() : "—"}`
                  : t("settings.sslRestartHint")}
              </div>
            </div>
            <span className={`inline-flex rounded px-2 py-1 text-2xs ${sslStatus?.enabled ? "bg-green-500/20 text-green-300" : "bg-surface-600 text-text-400"}`}>
              {sslStatus?.enabled ? "HTTPS" : "HTTP"}
            </span>
          </div>
        </div>

        <div className="rounded border border-surface-500 bg-surface-700/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-300">{t("settings.sslLetsEncrypt")}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">{t("settings.sslDomain")}</label>
              <input
                className="input"
                value={sslProvisionForm.domain}
                onChange={(e) => setSslProvisionForm((current) => ({ ...current, domain: e.target.value }))}
                placeholder="virtua.example.com"
              />
            </div>
            <div>
              <label className="label">{t("settings.sslEmail")}</label>
              <input
                className="input"
                value={sslProvisionForm.email}
                onChange={(e) => setSslProvisionForm((current) => ({ ...current, email: e.target.value }))}
                placeholder="admin@example.com"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">{t("settings.sslChallenge")}</label>
              <select
                className="input"
                value={sslProvisionForm.challenge}
                onChange={(e) => setSslProvisionForm((current) => ({ ...current, challenge: e.target.value as "http-01" | "dns-01" }))}
              >
                <option value="http-01">{t("settings.sslHttpChallenge")}</option>
                <option value="dns-01">{t("settings.sslDnsChallenge")}</option>
              </select>
            </div>
            <label className="flex items-end gap-2 text-sm text-text-300 pb-2">
              <input
                type="checkbox"
                className="w-4 h-4 accent-accent-blue"
                checked={sslProvisionForm.staging}
                onChange={(e) => setSslProvisionForm((current) => ({ ...current, staging: e.target.checked }))}
              />
              {t("settings.sslStaging")}
            </label>
          </div>
          <p className="text-xs text-text-500">{t("settings.sslHttpHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => provisionSsl.mutate()}
              disabled={provisionSsl.isPending || !sslProvisionForm.domain.trim() || !sslProvisionForm.email.trim()}
              className="btn-primary"
            >
              {provisionSsl.isPending ? t("msg.loading") : t("settings.sslRequestCertificate")}
            </button>
            <button onClick={() => renewSsl.mutate()} disabled={renewSsl.isPending || !sslStatus?.certExists} className="btn">
              {renewSsl.isPending ? t("msg.loading") : t("settings.sslRenew")}
            </button>
            <button onClick={() => removeSsl.mutate()} disabled={removeSsl.isPending || !sslStatus?.certExists} className="btn text-red-400">
              {removeSsl.isPending ? t("msg.loading") : t("settings.sslRemove")}
            </button>
          </div>
          {(provisionSsl.error || renewSsl.error || removeSsl.error) && (
            <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {(provisionSsl.error || renewSsl.error || removeSsl.error) instanceof Error
                ? (provisionSsl.error || renewSsl.error || removeSsl.error)?.message
                : t("msg.error")}
            </div>
          )}
        </div>

        <div className="rounded border border-surface-500 bg-surface-700/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-300">{t("settings.sslManualImport")}</h3>
          <div>
            <label className="label">{t("settings.sslDomainOptional")}</label>
            <input
              className="input"
              value={sslImportForm.domain}
              onChange={(e) => setSslImportForm((current) => ({ ...current, domain: e.target.value }))}
              placeholder="virtua.example.com"
            />
          </div>
          <div>
            <label className="label">{t("settings.sslCertificatePem")}</label>
            <textarea
              className="input font-mono min-h-32 resize-y"
              value={sslImportForm.certPem}
              onChange={(e) => setSslImportForm((current) => ({ ...current, certPem: e.target.value }))}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </div>
          <div>
            <label className="label">{t("settings.sslPrivateKeyPem")}</label>
            <textarea
              className="input font-mono min-h-32 resize-y"
              value={sslImportForm.keyPem}
              onChange={(e) => setSslImportForm((current) => ({ ...current, keyPem: e.target.value }))}
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
          </div>
          <button
            onClick={() => importSsl.mutate()}
            disabled={importSsl.isPending || !sslImportForm.certPem.trim() || !sslImportForm.keyPem.trim()}
            className="btn-primary"
          >
            {importSsl.isPending ? t("msg.loading") : t("settings.sslImport")}
          </button>
          {importSsl.error && (
            <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {importSsl.error instanceof Error ? importSsl.error.message : t("msg.error")}
            </div>
          )}
        </div>

        <p className="text-xs text-text-500">{t("settings.sslApplyRestart")}</p>
      </div>}

        {showNodeSections && !isNodeSettingsRoute && <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">VDM Manager</h2>

          <div className="rounded border border-surface-500 bg-surface-700/40 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-text-200 font-medium">
                  {vdmManagerStatus?.joined ? "Connected to a VDM manager" : "This node is not joined to a VDM manager"}
                </div>
                <div className="text-text-500 text-xs mt-1">
                  Local node: {vdmManagerStatus?.localDisplayName || vdmManagerStatus?.localNodeName || "—"}
                  {vdmManagerStatus?.managerApiUrl ? ` · Manager: ${vdmManagerStatus.managerApiUrl}` : ""}
                  {vdmManagerStatus?.joinedAt ? ` · Joined: ${new Date(vdmManagerStatus.joinedAt).toLocaleString()}` : ""}
                </div>
              </div>
              <span className={`inline-flex rounded px-2 py-1 text-2xs ${vdmManagerStatus?.joined ? "bg-green-500/20 text-green-300" : "bg-surface-600 text-text-400"}`}>
                {vdmManagerStatus?.joined ? "Joined" : "Standalone"}
              </span>
            </div>
          </div>

          {!vdmManagerStatus?.nodeAuthTokenPresent && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              This node has no internal auth token configured yet, so VDM manager join cannot work until the local node token is available.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">VDM Manager URL</label>
              <input
                className="input"
                value={vdmManagerForm.managerApiUrl}
                onChange={(e) => setVdmManagerForm((current) => ({ ...current, managerApiUrl: e.target.value }))}
                placeholder="https://vdm-manager.local:8440"
              />
            </div>
            <div>
              <label className="label">Join Token</label>
              <input
                className="input font-mono"
                value={vdmManagerForm.joinToken}
                onChange={(e) => setVdmManagerForm((current) => ({ ...current, joinToken: e.target.value }))}
                placeholder="Paste token from VDM Manager > Nodes"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Node Display Name in VDM</label>
              <input
                className="input"
                value={vdmManagerForm.displayName}
                onChange={(e) => setVdmManagerForm((current) => ({ ...current, displayName: e.target.value }))}
                placeholder={vdmManagerStatus?.localDisplayName || vdmManagerStatus?.localNodeName || "node1"}
              />
            </div>
            <div>
              <label className="label">This Node API URL</label>
              <input
                className="input"
                value={vdmManagerForm.apiUrl}
                onChange={(e) => setVdmManagerForm((current) => ({ ...current, apiUrl: e.target.value }))}
                placeholder={typeof window !== "undefined" ? `${window.location.origin}` : "https://node.local:8441"}
              />
            </div>
          </div>

          <div className="text-xs text-text-500">
            VDM is the manager. This action registers the current node in the VDM manager using the local node API URL and node auth token.
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => joinVdmManager.mutate()}
              disabled={joinVdmManager.isPending || !vdmManagerForm.managerApiUrl.trim() || !vdmManagerForm.joinToken.trim() || !vdmManagerStatus?.nodeAuthTokenPresent}
              className="btn-primary"
            >
              {joinVdmManager.isPending ? "Joining..." : "Join VDM Manager"}
            </button>
            <button
              onClick={() => leaveVdmManager.mutate()}
              disabled={leaveVdmManager.isPending || !vdmManagerStatus?.joined}
              className="btn text-red-400"
            >
              {leaveVdmManager.isPending ? "Leaving..." : "Clear Manager Link"}
            </button>
          </div>
        </div>}

      {showDatacenterSections && <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("nav.datacenter")}</h2>

        {datacenterLoading ? (
          <div className="text-sm text-text-500">{t("msg.loading")}</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="label">{t("datacenter.mode")}</label>
                <select
                  className="input"
                  value={datacenterConfig.mode}
                  onChange={(e) => setDatacenterConfig((current) => ({ ...current, mode: e.target.value as DatacenterConfig["mode"] }))}
                >
                  <option value="standalone">{t("datacenter.modeStandalone")}</option>
                  <option value="datacenter">{t("datacenter.modeDatacenter")}</option>
                </select>
              </div>
              <div>
                <label className="label">{t("datacenter.name")}</label>
                <input
                  className="input"
                  value={datacenterConfig.name}
                  onChange={(e) => setDatacenterConfig((current) => ({ ...current, name: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">{t("datacenter.primaryNode")}</label>
                <select
                  className="input"
                  value={datacenterConfig.primaryNodeName}
                  onChange={(e) => setDatacenterConfig((current) => ({ ...current, primaryNodeName: e.target.value }))}
                >
                  {nodes.map((node) => (
                    <option key={node.name} value={node.name}>{node.displayName || node.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => updateDatacenter.mutate()} disabled={updateDatacenter.isPending} className="btn-primary">
                {updateDatacenter.isPending ? "Saving..." : t("action.save")}
              </button>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4">
              <div className="rounded border border-surface-500 bg-surface-700/50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">{t("datacenter.nodes")}</div>
                <div className="space-y-2">
                  {nodes.map((node) => (
                    <div key={node.name} className="rounded border border-surface-500 bg-surface-800 px-3 py-2 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-text-200">{node.displayName || node.name}</div>
                        <div className="text-xs text-text-500">
                          {node.role} · {node.isLocal ? t("datacenter.localNode") : (node.apiUrl || t("datacenter.remoteNode"))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex rounded px-2 py-1 text-2xs ${node.enabled ? "bg-green-500/20 text-green-300" : "bg-surface-600 text-text-400"}`}>
                          {node.enabled ? t("status.active") : t("status.inactive")}
                        </span>
                        {!node.isLocal && (
                          <button onClick={() => deleteNode.mutate(node.name)} className="btn btn-sm text-red-400">
                            {t("action.delete")}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded border border-surface-500 bg-surface-700/50 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-400">{t("datacenter.joinTokens")}</div>
                  <div className="grid grid-cols-[1fr_110px] gap-2">
                    <input
                      className="input"
                      value={joinTokenForm.note}
                      onChange={(e) => setJoinTokenForm((current) => ({ ...current, note: e.target.value }))}
                      placeholder={t("datacenter.joinTokenNotePlaceholder")}
                    />
                    <input
                      type="number"
                      className="input"
                      min={5}
                      max={10080}
                      value={joinTokenForm.expiresInMinutes}
                      onChange={(e) => setJoinTokenForm((current) => ({ ...current, expiresInMinutes: parseInt(e.target.value, 10) || 60 }))}
                    />
                  </div>
                  <button onClick={() => createJoinToken.mutate()} disabled={createJoinToken.isPending} className="btn-primary w-full">
                    {createJoinToken.isPending ? t("msg.loading") : t("datacenter.createJoinToken")}
                  </button>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {joinTokens.map((token) => (
                      <div key={token.id} className="rounded border border-surface-500 bg-surface-800 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs font-mono text-text-200 break-all">{token.token}</div>
                            <div className="text-2xs text-text-500 mt-1">
                              {(token.note || t("datacenter.noNote"))} · {t("datacenter.expiresAt")} {new Date(token.expiresAt).toLocaleString()}
                            </div>
                          </div>
                          <button onClick={() => deleteJoinToken.mutate(token.id)} className="btn btn-sm text-red-400">{t("action.delete")}</button>
                        </div>
                      </div>
                    ))}
                    {joinTokens.length === 0 && <div className="text-sm text-text-500">{t("datacenter.noJoinTokens")}</div>}
                  </div>
                </div>

                <div className="rounded border border-surface-500 bg-surface-700/50 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-400">{t("datacenter.joinLeave")}</div>
                  <div>
                    <label className="label">{t("datacenter.primaryApiUrl")}</label>
                    <input className="input" value={joinForm.primaryApiUrl} onChange={(e) => setJoinForm((current) => ({ ...current, primaryApiUrl: e.target.value }))} placeholder="https://primary.local:8441" />
                  </div>
                  <div>
                    <label className="label">{t("datacenter.joinToken")}</label>
                    <input className="input font-mono" value={joinForm.token} onChange={(e) => setJoinForm((current) => ({ ...current, token: e.target.value }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Node Name</label>
                      <input className="input" value={joinForm.nodeName} onChange={(e) => setJoinForm((current) => ({ ...current, nodeName: e.target.value }))} placeholder={nodes.find((node) => node.isLocal)?.name || "srv02"} />
                    </div>
                    <div>
                      <label className="label">{t("datacenter.displayName")}</label>
                      <input className="input" value={joinForm.displayName} onChange={(e) => setJoinForm((current) => ({ ...current, displayName: e.target.value }))} />
                    </div>
                  </div>
                  <div>
                    <label className="label">{t("datacenter.thisNodeApiUrl")}</label>
                    <input className="input" value={joinForm.apiUrl} onChange={(e) => setJoinForm((current) => ({ ...current, apiUrl: e.target.value }))} placeholder="https://node2.local:8441" />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => joinDatacenter.mutate()}
                      disabled={joinDatacenter.isPending || !joinForm.primaryApiUrl.trim() || !joinForm.token.trim()}
                      className="btn-primary"
                    >
                      {joinDatacenter.isPending ? t("msg.loading") : t("datacenter.joinDatacenter")}
                    </button>
                    <button
                      onClick={() => leaveDatacenter.mutate()}
                      disabled={leaveDatacenter.isPending || datacenterConfig.mode === "standalone"}
                      className="btn text-red-400"
                    >
                      {leaveDatacenter.isPending ? t("msg.loading") : t("datacenter.leaveDatacenter")}
                    </button>
                  </div>
                </div>

                <div className="rounded border border-surface-500 bg-surface-700/50 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-400">{t("datacenter.addNode")} (legacy)</div>
                  <div>
                    <label className="label">{t("storage.name")}</label>
                    <input className="input" value={newNode.name} onChange={(e) => setNewNode((current) => ({ ...current, name: e.target.value }))} placeholder="srv02" />
                  </div>
                  <div>
                    <label className="label">{t("datacenter.displayName")}</label>
                    <input className="input" value={newNode.displayName} onChange={(e) => setNewNode((current) => ({ ...current, displayName: e.target.value }))} placeholder="Storage Node" />
                  </div>
                  <div>
                    <label className="label">API URL</label>
                    <input className="input" value={newNode.apiUrl} onChange={(e) => setNewNode((current) => ({ ...current, apiUrl: e.target.value }))} placeholder="https://node2.local:8441" />
                  </div>
                  <button onClick={() => createNode.mutate()} disabled={createNode.isPending || !newNode.name.trim()} className="btn">
                    {createNode.isPending ? "Adding..." : t("datacenter.addNode")}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>}

      {/* Security */}
      {showNodeSections && <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">Security</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Session Timeout (minutes)</label>
            <input
              type="number"
              className="input"
              min={5}
              max={10080}
              value={settings.sessionTimeoutMinutes ?? 60}
              onChange={(e) => set("sessionTimeoutMinutes", parseInt(e.target.value, 10))}
            />
          </div>
          <div>
            <label className="label">Max Upload Size (GB)</label>
            <input
              type="number"
              className="input"
              min={1}
              max={100}
              value={settings.maxUploadSizeGb ?? 8}
              onChange={(e) => set("maxUploadSizeGb", parseInt(e.target.value, 10))}
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-accent-blue"
              checked={settings.enableAuditLog ?? true}
              onChange={(e) => set("enableAuditLog", e.target.checked)}
            />
            <span className="text-sm text-text-300">Enable Audit Logging</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-accent-blue"
              checked={settings.enableRateLimit ?? true}
              onChange={(e) => set("enableRateLimit", e.target.checked)}
            />
            <span className="text-sm text-text-300">Enable Login Rate Limiting (5 attempts/15min)</span>
          </label>
        </div>
      </div>}

      {/* Save */}
      {showNodeSections && <div className="flex items-center gap-3">
        <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving..." : "Save Settings"}
        </button>
        {saved && <span className="text-green-400 text-sm">Settings saved!</span>}
      </div>}

      {showNodeSections && !isNodeSettingsRoute && <MfaSettingsCard />}

      {showNodeSections && <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">Resource ACL</h2>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-3">
          <div>
            <label className="label">Search Resource</label>
            <input
              className="input"
              value={aclSearch}
              onChange={(e) => setAclSearch(e.target.value)}
              placeholder="Search by name, type, owner..."
            />
          </div>
          <div>
            <label className="label">Type</label>
            <select
              className="input"
              value={aclTypeFilter}
              onChange={(e) => setAclTypeFilter(e.target.value as "all" | "vm" | "lxc" | "docker")}
            >
              <option value="all">All</option>
              <option value="vm">VM</option>
              <option value="lxc">LXC</option>
              <option value="docker">Docker</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded border border-surface-500 bg-surface-700/50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">With ACL</div>
            <div className="max-h-56 overflow-y-auto space-y-2">
              {resourcesWithAcl.length === 0 ? (
                <div className="text-sm text-text-500">No matching resources with ACL.</div>
              ) : resourcesWithAcl.map((entry) => {
                const key = `${entry.resourceType}:${entry.resourceName}`;
                const active = selectedAclKey === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedAclKey(key)}
                    className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                      active ? "border-accent-blue bg-accent-blue/10" : "border-surface-500 hover:bg-surface-600/60"
                    }`}
                  >
                    <div className="text-sm font-medium text-text-200">{entry.displayName}</div>
                    <div className="text-xs text-text-500">
                      {entry.resourceType.toUpperCase()} · {entry.ownerUsername ? `owner ${entry.ownerUsername} · ` : ""}{aclSummaryMap.get(key)} ACL entries
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded border border-surface-500 bg-surface-700/50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">Without ACL</div>
            <div className="max-h-56 overflow-y-auto space-y-2">
              {resourcesWithoutAcl.length === 0 ? (
                <div className="text-sm text-text-500">No matching resources without ACL.</div>
              ) : resourcesWithoutAcl.map((entry) => {
                const key = `${entry.resourceType}:${entry.resourceName}`;
                const active = selectedAclKey === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedAclKey(key)}
                    className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                      active ? "border-accent-blue bg-accent-blue/10" : "border-surface-500 hover:bg-surface-600/60"
                    }`}
                  >
                    <div className="text-sm font-medium text-text-200">{entry.displayName}</div>
                    <div className="text-xs text-text-500">
                      {entry.resourceType.toUpperCase()} · {entry.ownerUsername ? `owner ${entry.ownerUsername}` : "no owner"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {selectedAclResource ? (
          <ResourceAclPanel
            resourceType={selectedAclResource.resourceType}
            resourceName={selectedAclResource.resourceName}
            title={`${selectedAclResource.resourceType.toUpperCase()} ACL · ${selectedAclResource.displayName}`}
          />
        ) : (
          <div className="rounded border border-surface-500 bg-surface-700 px-4 py-6 text-center text-sm text-text-400">
            Select a VM, LXC, or Docker resource to manage its ACL.
          </div>
        )}
      </div>}

      {/* Danger Zone */}
      {showNodeSections && <div className="card p-5 border-red-900/50">
        <h2 className="text-sm font-semibold text-red-400 border-b border-red-900/50 pb-2 mb-4">
          {t("settings.dangerZone")}
        </h2>
        <p className="text-sm text-text-400 mb-4">
          {t("settings.dangerZoneDescription")}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setRebootOpen(true)}
            className="btn border-yellow-800 text-yellow-400 hover:bg-yellow-900/20"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {t("settings.rebootHost")}
          </button>
          <button
            onClick={() => setShutdownOpen(true)}
            className="btn border-red-900 text-red-400 hover:bg-red-900/20"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728M5.636 5.636a9 9 0 000 12.728M12 8v4m0 4h.01" />
            </svg>
            {t("settings.shutdownHost")}
          </button>
        </div>
      </div>}

      <ConfirmModal
        open={rebootOpen}
        title={t("settings.rebootHost")}
        message={t("settings.rebootMessage")}
        confirmLabel={t("action.reboot")}
        danger
        onConfirm={() => reboot.mutate()}
        onCancel={() => setRebootOpen(false)}
        loading={reboot.isPending}
        errorMessage={reboot.error instanceof Error ? reboot.error.message : undefined}
      />

      <ConfirmModal
        open={shutdownOpen}
        title={t("settings.shutdownHost")}
        message={t("settings.shutdownMessage")}
        confirmLabel={t("settings.shutdown")}
        danger
        onConfirm={() => shutdown.mutate()}
        onCancel={() => setShutdownOpen(false)}
        loading={shutdown.isPending}
        errorMessage={shutdown.error instanceof Error ? shutdown.error.message : undefined}
      />
    </div>
  );
}
