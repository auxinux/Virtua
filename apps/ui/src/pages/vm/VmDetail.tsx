import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete, apiPut } from "../../api/client";
import { Tabs } from "../../components/ui/Tabs";
import { StatusBadge } from "../../components/ui/Badge";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { Terminal } from "../../components/Terminal";
import { NoVncConsole } from "../../components/NoVncConsole";
import { SpiceConsole } from "../../components/SpiceConsole";
import { MiniGauge } from "../../components/ui/Gauge";
import { NotesCard } from "../../components/NotesCard";
import { LockBadge, LockButton, useResourceLock } from "../../components/LockControl";
import { FirewallRulesPanel } from "../../components/firewall/FirewallRulesPanel";
import { ResourceAclPanel } from "../../components/acl/ResourceAclPanel";
import { HostUsbDevicesPanel } from "../../components/HostUsbDevicesPanel";
import { formatBytes, formatDate } from "../../utils/formatBytes";
import { useAuth } from "../../utils/useAuth";
import { useSimpleMode } from "../../utils/useSimpleMode";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Play, Square, RefreshCcw, Zap, Power, ShieldAlert,
  Settings2, Activity, Database, Monitor, Network, Lock,
  History, Archive, FileText, ChevronRight, Maximize2, ExternalLink,
  Copy, PackagePlus, Pencil, Download
} from "lucide-react";
import type { IsoFile, TaskProgress, VmInfo, VmRdpConsoleInfo, VmStats, VmSnapshot } from "@auxinux/shared";

type TabId = "summary" | "console" | "hardware" | "network" | "firewall" | "acl" | "snapshots" | "backup" | "logs";
type VmDiskLibraryEntry = IsoFile & { path: string };

export default function VmDetail() {
  const { name } = useParams<{ name: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const { getResourcePermissions, isAdmin } = useAuth();
  const { isSimpleMode } = useSimpleMode();
  const [tab, setTab] = useState<TabId>("summary");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [exportTplOpen, setExportTplOpen] = useState(false);
  const [exportTplName, setExportTplName] = useState("");
  const [exportTplDesc, setExportTplDesc] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteDisks, setDeleteDisks] = useState(true);

  const { data: vm, isLoading } = useQuery<VmInfo>({
    queryKey: ["vm", name],
    queryFn: () => apiGet<VmInfo>(`/api/vms/${name}`),
    refetchInterval: tab === "summary" ? 10_000 : false,
    enabled: !!name,
  });

  const { data: stats } = useQuery<VmStats>({
    queryKey: ["vm", name, "stats"],
    queryFn: () => apiGet<VmStats>(`/api/vms/${name}/stats`),
    refetchInterval: tab === "summary" ? 5_000 : false,
    enabled: !!name && tab === "summary",
  });

  const { data: snapshots = [] } = useQuery<VmSnapshot[]>({
    queryKey: ["vm", name, "snapshots"],
    queryFn: () => apiGet<VmSnapshot[]>(`/api/vms/${name}/snapshots`),
    enabled: !!name && tab === "snapshots",
  });

  const { data: logsData } = useQuery<{ logs: string }>({
    queryKey: ["vm", name, "logs"],
    queryFn: () => apiGet<{ logs: string }>(`/api/vms/${name}/logs?tail=200`),
    enabled: !!name && tab === "logs",
    refetchInterval: tab === "logs" ? 5_000 : false,
  });

  const vmAction = useMutation({
    mutationFn: (action: string) => apiPost(`/api/vms/${name}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", name] }),
  });

  const deleteVm = useMutation({
    mutationFn: (wipeDisks: boolean) => apiDelete(`/api/vms/${name}?deleteDisks=${wipeDisks ? "true" : "false"}`),
    onSuccess: () => navigate("/vms"),
  });

  const repairDisk = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; repaired: boolean; message: string }>(`/api/vms/${name}/repair-disk`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", name] }),
  });

  const createSnapshot = useMutation({
    mutationFn: ({ snapName, desc }: { snapName: string; desc: string }) =>
      apiPost(`/api/vms/${name}/snapshot/create`, { name: snapName, description: desc }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", name, "snapshots"] }),
  });

  const rollbackSnap = useMutation({
    mutationFn: (snapName: string) => apiPost(`/api/vms/${name}/snapshot/${snapName}/rollback`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", name, "snapshots"] }),
  });

  const deleteSnap = useMutation({
    mutationFn: (snapName: string) => apiDelete(`/api/vms/${name}/snapshot/${snapName}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", name, "snapshots"] }),
  });

  const cloneVm = useMutation({
    mutationFn: (newName: string) => apiPost(`/api/vms/${name}/clone`, { newName }),
    onSuccess: () => { setCloneOpen(false); setCloneName(""); qc.invalidateQueries({ queryKey: ["sidebar", "vms"] }); },
  });

  const exportTemplate = useMutation({
    mutationFn: ({ templateName, description }: { templateName: string; description: string }) =>
      apiPost(`/api/vms/${name}/export-template`, { templateName, description }),
    onSuccess: () => { setExportTplOpen(false); setExportTplName(""); setExportTplDesc(""); qc.invalidateQueries({ queryKey: ["templates"] }); },
  });

  const renameVm = useMutation({
    mutationFn: (newName: string) => apiPost<{ ok: boolean; name: string }>(`/api/vms/${name}/rename`, { newName }),
    onSuccess: (result) => {
      setRenameOpen(false);
      qc.invalidateQueries({ queryKey: ["vms"] });
      qc.invalidateQueries({ queryKey: ["sidebar", "vms"] });
      navigate(`/vms/${encodeURIComponent(result.name)}`);
    },
  });

  const perms = name ? getResourcePermissions("vm", name) : null;
  const { locked, lockEntry } = useResourceLock("vm", name);

  const tabs = [
    { id: "summary", label: isSimpleMode ? "Général" : t("tab.summary") },
    perms?.canConsole ? { id: "console", label: isSimpleMode ? "Écran" : t("tab.console") } : null,
    !isSimpleMode && (perms?.canModify || perms?.canMedia) ? { id: "hardware", label: t("tab.hardware") } : null,
    !isSimpleMode && perms?.canModify ? { id: "network", label: t("tab.network") } : null,
    !isSimpleMode && perms?.canModify ? { id: "firewall", label: "Firewall" } : null,
    !isSimpleMode && perms?.canAdmin ? { id: "acl", label: "Resource ACL" } : null,
    !isSimpleMode && perms?.canSnapshot ? { id: "snapshots", label: t("tab.snapshots") } : null,
    !isSimpleMode && perms?.canBackup ? { id: "backup", label: t("tab.backup") } : null,
    { id: "logs", label: isSimpleMode ? "Journal" : t("tab.logs") },
  ].filter(Boolean) as Array<{ id: TabId; label: string }>;

  const detached = searchParams.get("detached");
  const fullscreen = searchParams.get("fullscreen") === "1";

  useEffect(() => {
    if (detached === "serial" || detached === "vnc" || detached === "spice") {
      setTab("console");
    }
  }, [detached]);

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab && tabs.some((entry) => entry.id === requestedTab)) {
      setTab(requestedTab as TabId);
      return;
    }
    if (!tabs.some((entry) => entry.id === tab)) {
      setTab("summary");
    }
  }, [searchParams, tab, tabs]);

  if (isLoading || !vm) {
    return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" /></div>;
  }

  const isRunning = vm.state === "running";
  const isPaused = vm.state === "paused";

  if (detached === "serial" || detached === "vnc" || detached === "spice") {
    return (
        <DetachedVmConsole
          vm={vm}
          mode={detached}
          isRunning={isRunning}
          fullscreen={fullscreen}
          onBack={() => navigate(`/vms/${name}`)}
        />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate("/vms")} className="p-2 hover:bg-surface-700 rounded-xl transition-colors group">
            <ArrowLeft className="w-5 h-5 text-text-400 group-hover:text-text-100" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-text-100">{vm.name}</h1>
              <StatusBadge state={vm.state} />
              {locked && <LockBadge reason={lockEntry?.reason} />}
            </div>
            {!isSimpleMode && <p className="text-xs text-text-500 font-mono mt-1 opacity-70">{vm.uuid}</p>}
            {isSimpleMode && <p className="text-sm text-text-400 mt-0.5">Ordinateur Virtuel</p>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {perms?.canPower && !isRunning && !isPaused && (
            <button onClick={() => vmAction.mutate("start")} disabled={vmAction.isPending} className="btn-primary px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg shadow-accent-blue/20">
              <Play className="w-4 h-4 fill-current" />
              <span>{t("action.start")}</span>
            </button>
          )}

          {perms?.canPower && isPaused && (
            <button onClick={() => vmAction.mutate("resume")} disabled={vmAction.isPending} className="btn-primary px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg shadow-accent-blue/20">
              <Play className="w-4 h-4 fill-current" />
              <span>Reprendre</span>
            </button>
          )}

          {perms?.canPower && (isRunning || isPaused) && (
            <button onClick={() => vmAction.mutate("stop")} disabled={vmAction.isPending} className="btn-secondary px-4 py-2 rounded-xl flex items-center gap-2">
              <Square className="w-4 h-4 fill-current" />
              <span>{t("action.stop")}</span>
            </button>
          )}

          {perms?.canPower && isRunning && (
            <button onClick={() => vmAction.mutate("reboot")} disabled={vmAction.isPending} className="btn-secondary p-2 rounded-xl" title={t("action.reboot", "Redémarrer")}>
              <RefreshCcw className="w-5 h-5" />
            </button>
          )}

          {perms?.canPower && isRunning && (
            <button
              onClick={() => vmAction.mutate("reset")}
              disabled={vmAction.isPending}
              className="p-2 rounded-xl text-orange-400 hover:bg-orange-900/20 transition-all border border-transparent hover:border-orange-800"
              title={t("action.reset", "Reset forcé (hard reset)")}
            >
              <Zap className="w-5 h-5" />
            </button>
          )}

          {perms?.canPower && (isRunning || isPaused) && (
            <button
              onClick={() => vmAction.mutate("forceStop")}
              disabled={vmAction.isPending}
              className="p-2 rounded-xl text-red-500 hover:bg-red-950/40 transition-all border border-transparent hover:border-red-900"
              title={t("action.forceStop", "Forcer l'arrêt (virsh destroy)")}
            >
              <Power className="w-5 h-5" />
            </button>
          )}

          <div className="h-8 w-px bg-surface-600 mx-2" />

          {perms?.canModify && (
            <button
              onClick={() => { setRenameName(vm.name); setRenameOpen(true); }}
              disabled={renameVm.isPending || locked}
              className="p-2 rounded-xl text-text-400 hover:text-accent-blue hover:bg-accent-blue/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              title={locked ? "Ressource verrouillée" : t("action.rename", "Renommer")}
            >
              <Pencil className="w-5 h-5" />
            </button>
          )}

          {perms?.canModify && (
            <button
              onClick={() => { setCloneName(`${vm.name}-clone`); setCloneOpen(true); }}
              disabled={cloneVm.isPending}
              className="p-2 rounded-xl text-text-400 hover:text-accent-blue hover:bg-accent-blue/10 transition-all"
              title={t("action.clone", "Cloner la VM")}
            >
              <Copy className="w-5 h-5" />
            </button>
          )}

          {isAdmin && (
            <button
              onClick={() => { setExportTplName(vm.name); setExportTplOpen(true); }}
              disabled={exportTemplate.isPending}
              className="p-2 rounded-xl text-text-400 hover:text-purple-400 hover:bg-purple-900/20 transition-all"
              title={t("action.exportTemplate", "Exporter comme template (admin)")}
            >
              <PackagePlus className="w-5 h-5" />
            </button>
          )}

          <div className="h-8 w-px bg-surface-600 mx-2" />

          {perms?.canAdmin && <LockButton type="vm" name={name} />}

          {perms?.canDelete && (
            <button
              onClick={() => {
                setDeleteDisks(true);
                setDeleteOpen(true);
              }}
              disabled={locked}
              className="p-2 text-text-500 hover:text-state-stopped hover:bg-state-stopped/10 rounded-xl transition-all"
              title={t("action.delete")}
            >
              <ShieldAlert className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Disk repair feedback */}
      <AnimatePresence>
        {repairDisk.isSuccess && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="p-4 rounded-xl border border-green-500/40 bg-green-500/10 text-sm text-green-200 flex items-center gap-3">
            <Activity className="w-5 h-5 text-green-400" />
            {repairDisk.data?.message ?? t("vm.repairDone", "Disque réparé. Tu peux redémarrer la VM.")}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <div className="border-b border-surface-600">
        <div className="flex gap-8">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`pb-3 text-sm font-semibold transition-all relative ${
                tab === t.id ? "text-accent-blue" : "text-text-400 hover:text-text-200"
              }`}
            >
              {t.label}
              {tab === t.id && (
                <motion.div layoutId="tab-active" className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-blue" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="py-2">
        {tab === "summary" && <VmSummaryTab vm={vm} stats={stats} isSimple={isSimpleMode} />}
        {tab === "console" && perms?.canConsole && <VmConsoleTab vmName={name!} isRunning={isRunning} />}
        {tab === "hardware" && (perms?.canModify || perms?.canMedia) && <VmHardwareTab vm={vm} vmName={name!} permissions={perms} />}
        {tab === "network" && perms?.canModify && <VmNetworkTab vm={vm} vmName={name!} />}
        {tab === "firewall" && perms?.canModify && (
          <FirewallRulesPanel
            title={`VM Firewall · ${name}`}
            linkedResourceType="vm"
            linkedResourceName={name!}
            defaultTargetIp={vm.networks.flatMap((net) => net.ipAddresses ?? []).find((entry) => /^\d+\.\d+\.\d+\.\d+/.test(entry))?.split("/")[0]}
          />
        )}
        {tab === "acl" && perms?.canAdmin && <ResourceAclPanel resourceType="vm" resourceName={name!} title={`VM ACL · ${name}`} />}
        {tab === "snapshots" && perms?.canSnapshot && (
          <VmSnapshotsTab
            snapshots={snapshots}
            vmName={name!}
            onCreate={createSnapshot.mutate}
            onRollback={rollbackSnap.mutate}
            onDelete={deleteSnap.mutate}
            isCreating={createSnapshot.isPending}
          />
        )}
        {tab === "backup" && perms?.canBackup && <VmBackupTab vmName={name!} nodeName={vm.nodeName} />}
        {tab === "logs" && (
          <div className="card p-6 bg-black/30">
            <div className="flex items-center gap-2 mb-4 text-text-400 text-sm">
               <FileText className="w-4 h-4" />
               Journal d'activité système
            </div>
            <pre className="text-xs font-mono text-text-300 whitespace-pre-wrap max-h-[500px] overflow-y-auto custom-scrollbar">
              {logsData?.logs || "Aucun log disponible pour le moment."}
            </pre>
          </div>
        )}
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t("modal.deleteVm")}
        footer={
          <>
            <button onClick={() => setDeleteOpen(false)} className="btn-secondary">Cancel</button>
            <button
              onClick={() => deleteVm.mutate(deleteDisks)}
              disabled={deleteVm.isPending}
              className="btn-danger"
            >
              {deleteVm.isPending ? "Deleting..." : "Delete VM"}
            </button>
          </>
        }
      >
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-300">
            Attention : cette action est irréversible. Choisis si tu veux supprimer seulement la VM ou aussi ses disques.
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
              checked={deleteDisks}
              onChange={(e) => setDeleteDisks(e.target.checked)}
            />
            <span className="text-sm text-text-300">Supprimer aussi les disques associés</span>
          </label>
          <p className="text-xs text-text-500">
            Désactive cette option pour conserver les fichiers de disque et les rattacher plus tard.
          </p>
        </div>
      </Modal>

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title={t("action.rename", "Renommer")}>
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-400">
            {t("modal.renameVmDesc", "La VM doit être arrêtée pour être renommée. Les ACL, snapshots, backups et règles firewall seront repointés vers le nouveau nom.")}
          </p>
          <div>
            <label className="block text-xs font-medium text-text-300 mb-1">{t("form.newName", "Nouveau nom")}</label>
            <input
              className="input w-full"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder={vm.name}
              autoFocus
            />
            <p className="text-xs text-text-500 mt-1">Lettre au début, puis lettres, chiffres, tirets, underscores ou points.</p>
          </div>
          {renameVm.isError && <p className="text-xs text-red-400">{String((renameVm.error as Error)?.message ?? "Erreur")}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setRenameOpen(false)}>{t("action.cancel", "Annuler")}</button>
            <button
              className="btn-primary"
              disabled={!/^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(renameName.trim()) || renameName.trim() === vm.name || renameVm.isPending}
              onClick={() => renameVm.mutate(renameName.trim())}
            >
              {renameVm.isPending ? t("action.renaming", "Renommage…") : t("action.rename", "Renommer")}
            </button>
          </div>
        </div>
      </Modal>

      {/* Clone VM Modal */}
      <Modal open={cloneOpen} onClose={() => setCloneOpen(false)} title={t("modal.cloneVm", "Cloner la VM")}>
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-400">
            {t("modal.cloneVmDesc", `Une copie complète de "${vm.name}" sera créée.`)}
          </p>
          <div>
            <label className="block text-xs font-medium text-text-300 mb-1">{t("form.newName", "Nom de la nouvelle VM")}</label>
            <input
              className="input w-full"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder={`${vm.name}-clone`}
              autoFocus
            />
          </div>
          {cloneVm.isError && <p className="text-xs text-red-400">{String((cloneVm.error as Error)?.message ?? "Erreur")}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setCloneOpen(false)}>{t("action.cancel", "Annuler")}</button>
            <button
              className="btn-primary"
              disabled={!cloneName.trim() || cloneVm.isPending}
              onClick={() => cloneVm.mutate(cloneName.trim())}
            >
              {cloneVm.isPending ? t("action.cloning", "Clonage…") : t("action.clone", "Cloner")}
            </button>
          </div>
        </div>
      </Modal>

      {/* Export as Template Modal (admin only) */}
      <Modal open={exportTplOpen} onClose={() => setExportTplOpen(false)} title={t("modal.exportTemplate", "Exporter comme template")}>
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-400">
            {t("modal.exportTemplateDesc", "Le disque sera converti en .tar.gz + JSON sidecar et ajouté à la bibliothèque de templates.")}
          </p>
          <div>
            <label className="block text-xs font-medium text-text-300 mb-1">{t("form.templateName", "Nom du template")}</label>
            <input
              className="input w-full"
              value={exportTplName}
              onChange={(e) => setExportTplName(e.target.value)}
              placeholder={vm.name}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-300 mb-1">{t("form.description", "Description")}</label>
            <textarea
              className="input w-full resize-none"
              rows={3}
              value={exportTplDesc}
              onChange={(e) => setExportTplDesc(e.target.value)}
              placeholder={t("form.descriptionPlaceholder", "Description optionnelle…")}
            />
          </div>
          {exportTemplate.isError && <p className="text-xs text-red-400">{String((exportTemplate.error as Error)?.message ?? "Erreur")}</p>}
          {exportTemplate.isSuccess && <p className="text-xs text-green-400">{t("msg.exportStarted", "Export démarré — voir les Tâches pour le suivi.")}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setExportTplOpen(false)}>{t("action.cancel", "Annuler")}</button>
            <button
              className="btn-primary"
              disabled={!exportTplName.trim() || exportTemplate.isPending}
              onClick={() => exportTemplate.mutate({ templateName: exportTplName.trim(), description: exportTplDesc })}
            >
              {exportTemplate.isPending ? t("action.exporting", "Export…") : t("action.export", "Exporter")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function AgentStatusRow({ label, tone, text }: { label: string; tone: "ok" | "warn" | "bad" | "off"; text: string }) {
  const dot = tone === "ok" ? "bg-green-400" : tone === "warn" ? "bg-amber-400" : tone === "bad" ? "bg-red-400" : "bg-surface-500";
  const color = tone === "ok" ? "text-green-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "text-text-500";
  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-surface-700/50">
      <span className="text-xs text-text-400">{label}</span>
      <span className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        {text}
      </span>
    </div>
  );
}

function VmSummaryTab({ vm, stats, isSimple }: { vm: VmInfo; stats?: VmStats; isSimple?: boolean }) {
  const { t } = useTranslation();
  const qemuAgent: { tone: "ok" | "warn" | "bad" | "off"; text: string } = !stats?.guestAgentEnabled
    ? { tone: "off", text: "Canal absent" }
    : stats.guestAgentRunning
      ? { tone: "ok", text: "Communique ✓" }
      : stats.guestAgentConnected
        ? { tone: "warn", text: "Connecté — ne répond pas" }
        : { tone: "bad", text: "Non détecté dans l'invité" };
  const spiceAgent: { tone: "ok" | "warn" | "bad" | "off"; text: string } = !stats?.spiceAgentPresent
    ? { tone: "off", text: "Canal absent — arrêt/démarrage requis" }
    : stats.spiceAgentConnected
      ? { tone: "ok", text: "Connecté ✓" }
      : { tone: "bad", text: "Non détecté dans l'invité" };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        {/* Simple Health / Status Card */}
        {isSimple && (
          <div className="card p-6 border-l-4 border-l-accent-blue bg-accent-blue/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                 <div className={`p-3 rounded-2xl ${vm.state === "running" ? "bg-green-500/20 text-green-400" : "bg-surface-600 text-text-500"}`}>
                    <Monitor className="w-8 h-8" />
                 </div>
                 <div>
                    <h3 className="text-lg font-bold text-text-100">{vm.name}</h3>
                    <p className="text-text-400">{vm.state === "running" ? "Opérationnel" : "À l'arrêt"}</p>
                 </div>
              </div>
              <div className="text-right">
                 <div className="text-xs uppercase tracking-widest text-text-500 mb-1">Performance</div>
                 <div className="text-xl font-mono font-bold text-accent-blue">{stats?.cpuPercent.toFixed(0) ?? 0}% CPU</div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
           <div className="card p-6">
             <h3 className="text-sm font-bold text-text-300 mb-4 flex items-center gap-2">
                <Settings2 className="w-4 h-4" /> Configuration
             </h3>
             <div className="space-y-4">
                <div className="flex justify-between items-center py-2 border-b border-surface-700/50">
                   <span className="text-text-500 text-sm">Processeur</span>
                   <span className="text-text-200 font-semibold">{vm.vcpus} Cœurs</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-surface-700/50">
                   <span className="text-text-500 text-sm">Mémoire vive</span>
                   <span className="text-text-200 font-semibold">{formatBytes(vm.maxMemoryKiB * 1024)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-surface-700/50">
                   <span className="text-text-500 text-sm">Démarrage auto</span>
                   <span className={`text-xs px-2 py-0.5 rounded-full ${vm.autostart ? "bg-accent-blue/10 text-accent-blue" : "bg-surface-600 text-text-400"}`}>
                      {vm.autostart ? "Oui" : "Non"}
                   </span>
                </div>
                {!isSimple && (
                  <>
                    <div className="flex justify-between items-center py-2 border-b border-surface-700/50">
                      <span className="text-text-500 text-sm">Architecture</span>
                      <span className="text-text-200">{vm.arch}</span>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="text-text-500 text-sm">Type machine</span>
                      <span className="text-text-200">{vm.machine}</span>
                    </div>
                  </>
                )}
             </div>
           </div>

           {stats && (
             <div className="card p-6">
               <h3 className="text-sm font-bold text-text-300 mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Statistiques en direct
               </h3>
               <div className="space-y-6">
                  <MiniGauge value={stats.cpuPercent} label="Utilisation CPU" />
                  <MiniGauge
                    value={stats.memPercent}
                    label="Utilisation RAM"
                    detail={`${formatBytes(stats.memoryUsedKiB * 1024)} utilisés`}
                  />

                  <div className="grid grid-cols-2 gap-4 mt-4">
                     <div className="p-3 bg-surface-700/50 rounded-xl">
                        <div className="text-[10px] uppercase text-text-500 mb-1">Réseau (Reçu)</div>
                        <div className="text-sm font-mono font-bold text-text-200">{formatBytes(stats.netRxBytes)}</div>
                     </div>
                     <div className="p-3 bg-surface-700/50 rounded-xl">
                        <div className="text-[10px] uppercase text-text-500 mb-1">Réseau (Envoyé)</div>
                        <div className="text-sm font-mono font-bold text-text-200">{formatBytes(stats.netTxBytes)}</div>
                     </div>
                  </div>

                  {vm.state === "running" && (
                    <div className="space-y-2 mt-4">
                      <div className="text-[10px] uppercase text-text-500">Agents invité</div>
                      <AgentStatusRow label="Agent QEMU" tone={qemuAgent.tone} text={qemuAgent.text} />
                      <AgentStatusRow label="Agent SPICE" tone={spiceAgent.tone} text={spiceAgent.text} />
                    </div>
                  )}
               </div>
             </div>
           )}
        </div>

        <NotesCard type="vm" id={vm.name} />
      </div>

      <div className="space-y-6">
         {/* Network summary card */}
         <div className="card p-6">
            <h3 className="text-sm font-bold text-text-300 mb-4 flex items-center gap-2">
               <Network className="w-4 h-4" /> Adresses Réseau
            </h3>
            <div className="space-y-3">
               {vm.networks.map((net, i) => (
                  <div key={i} className="p-3 rounded-xl bg-surface-700/30 border border-surface-600">
                     <div className="text-xs text-text-500 mb-1">{net.source || "virtua-bridge"}</div>
                     <div className="font-mono text-sm text-accent-blue-light break-all">
                        {(net.ipAddresses?.length ? net.ipAddresses : (i === 0 ? stats?.ipAddresses ?? [] : []))
                          .join(", ") || "Pas d'adresse IP"}
                     </div>
                  </div>
               ))}
               {vm.networks.length === 0 && <p className="text-sm text-text-500 italic">Aucun réseau configuré</p>}
            </div>
         </div>

         {/* Storage summary card */}
         <div className="card p-6">
            <h3 className="text-sm font-bold text-text-300 mb-4 flex items-center gap-2">
               <Database className="w-4 h-4" /> Stockage
            </h3>
            <div className="space-y-3">
               {vm.disks.map((disk, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface-700/30">
                     <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-surface-600 flex items-center justify-center text-text-400">
                           <Database className="w-4 h-4" />
                        </div>
                        <div>
                           <div className="text-sm font-bold text-text-200">{disk.device}</div>
                           <div className="text-xs text-text-500">{disk.format || "raw"}</div>
                        </div>
                     </div>
                     <div className="text-right">
                        <div className="text-sm font-mono text-text-300">{formatBytes(disk.sizeBytes)}</div>
                     </div>
                  </div>
               ))}
            </div>
         </div>
      </div>
    </div>
  );
}

function ConsolePanel({
  title,
  onDetach,
  onFullscreen,
  headerExtra,
  children,
}: {
  title: string;
  onDetach: () => void;
  onFullscreen: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panelHeight = "clamp(32rem, calc(100vh - 14rem), 78rem)";

  return (
    <div className="card p-2 flex flex-col gap-2" style={{ height: panelHeight }}>
      <div className="flex items-center justify-between px-2 pt-1">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold text-text-200">{title}</div>
          {headerExtra}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onFullscreen} className="btn-secondary btn-sm">Fullscreen</button>
          <button onClick={onDetach} className="btn-secondary btn-sm">Detach</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function VmRdpRemotePanel({ vmName, isRunning }: { vmName: string; isRunning: boolean }) {
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: info, isLoading, error } = useQuery<VmRdpConsoleInfo>({
    queryKey: ["vm", vmName, "rdp-info"],
    queryFn: () => apiGet<VmRdpConsoleInfo>(`/api/vms/${encodeURIComponent(vmName)}/rdp-info`),
    enabled: isRunning,
    refetchInterval: isRunning ? 10_000 : false,
  });
  const prepare = useMutation({
    mutationFn: () => apiPost<VmRdpConsoleInfo>(`/api/vms/${encodeURIComponent(vmName)}/rdp-prepare`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", vmName, "rdp-info"] }),
  });

  const downloadRdp = async () => {
    setActionError(null);
    try {
      await prepare.mutateAsync();
      window.location.href = `/api/vms/${encodeURIComponent(vmName)}/rdp-file`;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "RDP preparation failed");
    }
  };

  if (!isRunning) {
    return <div className="flex items-center justify-center h-full text-text-500">VM must be running to prepare an RDP remote console</div>;
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="card p-4 space-y-4 max-w-3xl">
        <div>
          <h3 className="text-base font-semibold text-text-100">RDP Remote Console</h3>
          <p className="mt-1 text-sm text-text-400">
            Starts a dedicated RDP gateway on the host for this VM (its own port, direct connection to the VM screen). Nothing needs to be installed inside the VM.
          </p>
        </div>

        {isLoading && <div className="text-sm text-text-500">Checking xrdp and VM console status...</div>}
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error instanceof Error ? error.message : "RDP status failed"}</div>}
        {(prepare.error || actionError) && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {actionError ?? (prepare.error instanceof Error ? prepare.error.message : "RDP preparation failed")}
          </div>
        )}

        {info && (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2">
                <div className="text-2xs uppercase text-text-500">Profile</div>
                <div className="font-mono text-text-100">{info.profileName}</div>
              </div>
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2">
                <div className="text-2xs uppercase text-text-500">Host RDP</div>
                <div className="font-mono text-text-100">RDPS/RDP :{info.xrdpPort}</div>
              </div>
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2">
                <div className="text-2xs uppercase text-text-500">QEMU VNC</div>
                <div className="font-mono text-text-100">{info.vncHost}:{info.vncPort ?? "not active"}</div>
              </div>
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2">
                <div className="text-2xs uppercase text-text-500">RDP gateway</div>
                <div className="font-mono text-text-100">{info.xrdpInstalled ? (info.xrdpActive ? "active" : "not started") : "xrdp not installed"}</div>
              </div>
            </div>

            {info.warnings.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
                <div className="font-medium">Before RDP can connect:</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {info.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            )}

            {prepare.data?.consolePassword && (
              <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <div className="font-medium">Console password (requested by the RDP client):</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-base text-emerald-50">{prepare.data.consolePassword}</span>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(prepare.data.consolePassword ?? "")}
                    className="btn-secondary btn-sm"
                  >
                    Copy
                  </button>
                </div>
                <div className="mt-1 text-xs text-emerald-200/80">The gateway now supplies this console password directly to QEMU; RDP client credentials are used only to open the gateway session.</div>
              </div>
            )}

            <div className="rounded border border-surface-500 bg-surface-800 p-3 text-xs text-text-400">
              The .rdp connects straight to <span className="font-mono text-text-200">{info.profileName}</span> on its dedicated port. The gateway injects the QEMU console secret itself, avoiding password conversion differences between RDP clients. This is a console bridge, not a native Windows/Linux RDP session.
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setActionError(null);
                  prepare.mutate();
                }}
                disabled={prepare.isPending || !info.xrdpInstalled || !info.xrdpLibVnc || !info.vncPort}
                className="btn-secondary btn-sm"
              >
                {prepare.isPending ? "Preparing..." : "Prepare RDP profile"}
              </button>
              <button
                onClick={() => void downloadRdp()}
                disabled={prepare.isPending || (!info.ready && (!info.xrdpInstalled || !info.xrdpLibVnc || !info.vncPort))}
                className="btn-primary btn-sm inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download .rdp
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VmConsoleTab({ vmName, isRunning }: { vmName: string; isRunning: boolean }) {
  const [mode, setMode] = useState<"vnc" | "spice" | "rdp" | "serial">("vnc");
  const navigate = useNavigate();

  const openDetached = (mode: "serial" | "vnc" | "spice", fullscreen = false) => {
    const params = new URLSearchParams({ detached: mode });
    if (fullscreen) params.set("fullscreen", "1");
    const url = `${window.location.origin}/vms/${encodeURIComponent(vmName)}?${params.toString()}`;
    window.open(url, `_blank`, "noopener,noreferrer,width=1440,height=900");
  };

  const openFullscreen = async (mode: "serial" | "vnc" | "spice") => {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Ignore browser fullscreen denials; we still switch to the chrome-free console route.
    }
    const params = new URLSearchParams({ detached: mode, fullscreen: "1" });
    navigate(`/vms/${encodeURIComponent(vmName)}?${params.toString()}`);
  };

  const modeTabs = (
    <div className="flex items-center gap-2">
    <div className="inline-flex items-center rounded-md border border-surface-500 bg-surface-700/70 p-0.5 text-2xs">
      <button
        onClick={() => setMode("vnc")}
        className={`rounded px-2.5 py-1 transition-colors ${mode === "vnc" ? "bg-surface-500 text-text-100" : "text-text-400 hover:text-text-200"}`}
      >
        Graphical
      </button>
      <button
        onClick={() => setMode("spice")}
        className={`rounded px-2.5 py-1 transition-colors ${mode === "spice" ? "bg-surface-500 text-text-100" : "text-text-400 hover:text-text-200"}`}
      >
        SPICE
      </button>
      <button
        onClick={() => setMode("rdp")}
        className={`rounded px-2.5 py-1 transition-colors ${mode === "rdp" ? "bg-surface-500 text-text-100" : "text-text-400 hover:text-text-200"}`}
      >
        RDP Remote
      </button>
      <button
        onClick={() => setMode("serial")}
        className={`rounded px-2.5 py-1 transition-colors ${mode === "serial" ? "bg-surface-500 text-text-100" : "text-text-400 hover:text-text-200"}`}
      >
        Serial
      </button>
    </div>
    <div id="vm-detail-spice-toolbar" className="flex items-center gap-2" />
    </div>
  );

  return (
    <div>
      <ConsolePanel
        title={mode === "vnc" ? "Graphical Console" : mode === "spice" ? "SPICE Console" : mode === "rdp" ? "RDP Remote Console" : "Serial Console"}
        headerExtra={modeTabs}
        onFullscreen={() => mode === "rdp" ? undefined : openFullscreen(mode)}
        onDetach={() => mode === "rdp" ? undefined : openDetached(mode)}
      >
        {isRunning ? (
          mode === "vnc"
            ? <NoVncConsole ticketPath={`/api/vms/${vmName}/vnc-ticket`} className="h-full" />
            : mode === "spice"
              ? <SpiceConsole ticketPath={`/api/vms/${vmName}/spice-ticket`} className="h-full" toolbarId="vm-detail-spice-toolbar" />
              : mode === "rdp"
                ? <VmRdpRemotePanel vmName={vmName} isRunning={isRunning} />
                : <Terminal ticketPath={`/api/vms/${vmName}/console-ticket`} className="h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-text-500">
            {mode === "vnc"
              ? "VM must be running to access the graphical console"
              : mode === "spice"
                ? "VM must be running to access the SPICE console"
                : mode === "rdp"
                  ? "VM must be running to prepare an RDP remote console"
                : "VM must be running to access the serial console"}
          </div>
        )}
      </ConsolePanel>
    </div>
  );
}

function DetachedVmConsole({
  vm,
  mode,
  isRunning,
  fullscreen,
  onBack,
}: {
  vm: VmInfo;
  mode: "serial" | "vnc" | "spice";
  isRunning: boolean;
  fullscreen: boolean;
  onBack: () => void;
}) {
  const title = mode === "serial" ? "Serial Console" : mode === "spice" ? "SPICE Console" : "Graphical Console";
  const wrapperRef = useRef<HTMLDivElement>(null);
  const showOverlay = !fullscreen;
  const [controlsOpen, setControlsOpen] = useState(!fullscreen);

  useEffect(() => {
    setControlsOpen(!fullscreen);
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen || !wrapperRef.current) return;
    const node = wrapperRef.current;
    if (!document.fullscreenElement) {
      void node.requestFullscreen?.().catch(() => undefined);
    }

    return () => {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [fullscreen]);

  return (
    <div
      ref={wrapperRef}
      className={fullscreen ? "fixed inset-0 z-50 flex flex-col bg-black" : "h-full flex flex-col bg-surface-800"}
    >
      {showOverlay && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-500">
          <div>
            <div className="text-lg font-semibold text-text-100">{vm.name} · {title}</div>
            <div className="text-xs text-text-500 font-mono">{vm.uuid}</div>
          </div>
          <div className="flex items-center gap-2">
            <div id="detached-spice-toolbar" className="flex items-center gap-2" />
            <button onClick={onBack} className="btn-secondary btn-sm">Back to VM</button>
          </div>
        </div>
      )}
      <div className={`relative flex-1 min-h-0 ${fullscreen ? "" : "p-4"}`}>
        {fullscreen && (
          <>
            {controlsOpen ? (
              <div className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-lg bg-black/55 p-2 backdrop-blur-sm">
                <button onClick={() => setControlsOpen(false)} className="btn-secondary btn-sm">
                  Hide Bar
                </button>
                <div id="detached-spice-toolbar" className="flex items-center gap-2" />
                <button onClick={() => void document.exitFullscreen?.().catch(() => undefined)} className="btn-secondary btn-sm">
                  Exit Fullscreen
                </button>
                <button
                  onClick={() => {
                    void document.exitFullscreen?.().catch(() => undefined);
                    onBack();
                  }}
                  className="btn-secondary btn-sm"
                >
                  Back to VM
                </button>
              </div>
            ) : (
              <button
                onClick={() => setControlsOpen(true)}
                className="absolute right-4 top-4 z-20 rounded-full bg-black/60 px-3 py-2 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-black/75"
              >
                Open Bar
              </button>
            )}
          </>
        )}
        <div className={fullscreen ? "h-full w-full min-h-0" : "card p-2 h-full"}>
          {isRunning ? (
            mode === "serial"
              ? <Terminal ticketPath={`/api/vms/${vm.name}/console-ticket`} className="h-full w-full" />
              : mode === "spice"
                ? <SpiceConsole ticketPath={`/api/vms/${vm.name}/spice-ticket`} className="h-full w-full min-h-0" bare={fullscreen} toolbarId="detached-spice-toolbar" />
                : (
                <NoVncConsole
                  ticketPath={`/api/vms/${vm.name}/vnc-ticket`}
                  className="h-full w-full min-h-0"
                  bare={fullscreen}
                  resizeSession={fullscreen && vm.qemuAgentEnabled !== false}
                />
              )
          ) : (
            <div className="flex items-center justify-center h-full text-text-500">
              VM must be running to access this console
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VmHardwareTab({
  vm,
  vmName,
  permissions,
}: {
  vm: VmInfo;
  vmName: string;
  permissions: {
    canModify: boolean;
    canMedia: boolean;
  };
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [addDiskOpen, setAddDiskOpen] = useState(false);
  const [editResourcesOpen, setEditResourcesOpen] = useState(false);
  const [isoOpen, setIsoOpen] = useState(false);
  const [newDiskSize, setNewDiskSize] = useState(20);
  const [newDiskBus, setNewDiskBus] = useState("virtio");
  const [diskAttachMode, setDiskAttachMode] = useState<"new" | "existing">("new");
  const [existingDiskPath, setExistingDiskPath] = useState("");
  const [existingDiskPool, setExistingDiskPool] = useState("");
  const [editVcpus, setEditVcpus] = useState(vm.vcpus);
  const [editMemoryMb, setEditMemoryMb] = useState(Math.max(128, Math.round(vm.maxMemoryKiB / 1024)));
  const [editBootDevice, setEditBootDevice] = useState<"hd" | "cdrom" | "network">(vm.bootOrder?.[0] ?? "hd");
  const [editTpmEnabled, setEditTpmEnabled] = useState(Boolean(vm.tpmEnabled));
  const [editQemuAgentEnabled, setEditQemuAgentEnabled] = useState(vm.qemuAgentEnabled !== false);
  const [editVideoModel, setEditVideoModel] = useState<"vga" | "virtio" | "qxl">(vm.videoModel ?? "vga");
  const [editUefi, setEditUefi] = useState<boolean>(vm.uefi ?? false);
  const [editSecureBoot, setEditSecureBoot] = useState<boolean>(vm.secureBoot ?? false);
  const [editAutostart, setEditAutostart] = useState<boolean>(vm.autostart);
  const [selectedIso, setSelectedIso] = useState("");

  const { data: pools = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ["storage", "pools"],
    queryFn: () => apiGet<Array<{ name: string }>>("/api/storage/pools"),
  });

  const { data: isos = [] } = useQuery<IsoFile[]>({
    queryKey: ["storage", "isos"],
    queryFn: () => apiGet<IsoFile[]>("/api/storage/isos"),
  });

  const { data: availableVmDisks = [] } = useQuery<VmDiskLibraryEntry[]>({
    queryKey: ["storage", "vm-disks", "available"],
    queryFn: () => apiGet<VmDiskLibraryEntry[]>("/api/storage/vm-disks/available"),
    enabled: permissions.canModify && addDiskOpen && diskAttachMode === "existing",
  });

  const [diskPool, setDiskPool] = useState("");

  useEffect(() => {
    setEditVcpus(vm.vcpus);
    setEditMemoryMb(Math.max(128, Math.round(vm.maxMemoryKiB / 1024)));
    setEditBootDevice(vm.bootOrder?.[0] ?? "hd");
    setEditTpmEnabled(Boolean(vm.tpmEnabled));
    setEditQemuAgentEnabled(vm.qemuAgentEnabled !== false);
    setEditVideoModel(vm.videoModel ?? "vga");
    setEditUefi(vm.uefi ?? false);
    setEditSecureBoot(vm.secureBoot ?? false);
    setEditAutostart(vm.autostart);
  }, [vm.autostart, vm.bootOrder, vm.maxMemoryKiB, vm.qemuAgentEnabled, vm.tpmEnabled, vm.vcpus, vm.videoModel, vm.uefi, vm.secureBoot]);

  const attachDisk = useMutation({
    mutationFn: () => diskAttachMode === "existing"
      ? apiPost(`/api/vms/${vmName}/disk/attach`, { existingPath: existingDiskPath.trim(), storagePool: existingDiskPool || undefined, bus: newDiskBus })
      : apiPost(`/api/vms/${vmName}/disk/attach`, { sizeGb: newDiskSize, bus: newDiskBus, storagePool: diskPool }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      qc.invalidateQueries({ queryKey: ["storage", "vm-disks", "available"] });
      setAddDiskOpen(false);
      setExistingDiskPath("");
      setExistingDiskPool("");
      setDiskAttachMode("new");
    },
  });

  const detachDisk = useMutation({
    mutationFn: (device: string) => apiPost(`/api/vms/${vmName}/disk/detach`, { device }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", vmName] }),
  });

  const updateResources = useMutation({
    mutationFn: () => apiPut(`/api/vms/${vmName}/config`, {
      vcpus: editVcpus,
      memoryMb: editMemoryMb,
      bootDevice: editBootDevice,
      tpmEnabled: editTpmEnabled,
      qemuAgentEnabled: editQemuAgentEnabled,
      videoModel: editVideoModel,
      uefi: editUefi,
      secureBoot: editSecureBoot && editUefi,
      autostart: editAutostart,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      setEditResourcesOpen(false);
    },
  });

  const attachIso = useMutation({
    mutationFn: () => apiPost(`/api/vms/${vmName}/iso/attach`, { isoFile: selectedIso }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      setIsoOpen(false);
      setSelectedIso("");
    },
  });

  const ejectIso = useMutation({
    mutationFn: () => apiPost(`/api/vms/${vmName}/iso/eject`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", vmName] }),
  });

  // Insert the virtio-win guest tools ISO; the server downloads it first when
  // the ISO library doesn't have it yet (long task with progress in Journaux).
  const [guestToolsNote, setGuestToolsNote] = useState("");
  const guestTools = useMutation({
    mutationFn: () => apiPost<{ kind?: string }>(`/api/vms/${vmName}/guest-tools`),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      setGuestToolsNote(task?.kind === "url-download"
        ? "virtio-win.iso absent du stockage : téléchargement lancé — l'ISO sera insérée automatiquement à la fin (progression dans Journaux → Tâches)."
        : "");
    },
  });

  const currentIso = vm.disks.find((disk) => disk.readonly);
  const availableIsos = useMemo(() => {
    const managedIsos = isos.filter((iso) => iso.type === "iso");
    if (!currentIso?.source) return managedIsos;

    const currentFilename = currentIso.source.split("/").pop() ?? currentIso.source;
    if (managedIsos.some((iso) => iso.filename === currentFilename)) {
      return managedIsos;
    }

    return [
      ...managedIsos,
      {
        filename: currentFilename,
        displayName: `${currentFilename} (attached)`,
        type: "iso" as const,
        sizeBytes: 0,
        isPublic: false,
      },
    ];
  }, [currentIso?.source, isos]);
  const existingDiskSelection = existingDiskPath ? `${existingDiskPool}::${existingDiskPath}` : "";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {permissions.canModify && <button onClick={() => setEditResourcesOpen(true)} className="btn-secondary btn-sm">Edit Resources</button>}
        {permissions.canMedia && <button onClick={() => setIsoOpen(true)} className="btn-secondary btn-sm">Insert ISO</button>}
        {permissions.canMedia && (
          <button onClick={() => { setGuestToolsNote(""); guestTools.mutate(); }} disabled={guestTools.isPending} className="btn-secondary btn-sm" title="Insère virtio-win.iso (pilotes VirtIO + agents Windows) ; le télécharge d'abord s'il est absent du stockage">
            {guestTools.isPending ? "Guest Tools..." : "Guest Tools (VirtIO)"}
          </button>
        )}
        {permissions.canMedia && currentIso && (
          <button onClick={() => ejectIso.mutate()} disabled={ejectIso.isPending} className="btn-secondary btn-sm">
            {ejectIso.isPending ? "Ejecting..." : "Eject ISO"}
          </button>
        )}
      </div>
      {guestToolsNote && (
        <p className="text-xs text-cyan-300 bg-cyan-900/20 border border-cyan-800/40 rounded px-2 py-1.5 text-right">{guestToolsNote}</p>
      )}
      {guestTools.isError && (
        <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-2 py-1.5 text-right">
          Guest tools : {(guestTools.error as Error)?.message ?? "échec de l'insertion"}
        </p>
      )}

      {permissions.canModify && (
        <HostUsbDevicesPanel
          resourceType="vm"
          resourceName={vmName}
          nodeName={vm.nodeName}
          attachedDevices={vm.usbDevices ?? []}
          invalidateKey={["vm", vmName]}
        />
      )}

      {/* Disks */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-500">
          <h3 className="text-sm font-semibold text-text-300">Disks</h3>
          {permissions.canModify && (
            <button
              onClick={() => {
                setDiskAttachMode("new");
                setExistingDiskPath("");
                setExistingDiskPool("");
                setAddDiskOpen(true);
              }}
              className="btn-secondary btn-sm"
            >
              + Add Disk
            </button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-surface-600/50">
            <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
              <th className="px-4 py-2">Device</th>
              <th className="px-4 py-2">Bus</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2">Format</th>
              <th className="px-4 py-2">Size</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-600">
            {vm.disks.map((disk) => (
              <tr key={disk.device} className="hover:bg-surface-600/20">
                <td className="px-4 py-2 font-mono text-text-200">{disk.device}</td>
                <td className="px-4 py-2 text-text-400">{disk.bus}</td>
                <td className="px-4 py-2 text-text-400 max-w-xs truncate text-xs">{disk.source || "Empty removable drive"}</td>
                <td className="px-4 py-2 text-text-400">{disk.format}</td>
                <td className="px-4 py-2 text-text-400">{disk.sizeBytes > 0 ? formatBytes(disk.sizeBytes) : "—"}</td>
                <td className="px-4 py-2 text-right">
                  {disk.readonly ? (
                    <span className="text-xs text-text-500">CD-ROM</span>
                  ) : permissions.canModify && !disk.readonly ? (
                    <button onClick={() => detachDisk.mutate(disk.device)} className="btn-ghost btn-sm text-red-400">Remove</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {vm.disks.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-500">No disks attached</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-text-300 mb-3">ISO / CD-ROM</h3>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-500">Current media</span>
          <span className="text-text-200 font-mono">{currentIso?.source || "No ISO inserted"}</span>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-text-300 mb-3">Boot & Security</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-text-500">Firmware</span><span className="text-text-200">{vm.uefi ? "UEFI" : "BIOS"}</span></div>
          <div className="flex justify-between"><span className="text-text-500">Secure Boot</span><span className="text-text-200">{vm.secureBoot ? "Enabled" : "Disabled"}</span></div>
          <div className="flex justify-between"><span className="text-text-500">Primary Boot</span><span className="text-text-200">{vm.bootOrder?.[0] ?? "hd"}</span></div>
          <div className="flex justify-between"><span className="text-text-500">Video Model</span><span className="text-text-200">{vm.videoModel ?? "vga"}</span></div>
          <div className="flex justify-between"><span className="text-text-500">TPM 2.0</span><span className="text-text-200">{vm.tpmEnabled ? "Enabled" : "Disabled"}</span></div>
          <div className="flex justify-between"><span className="text-text-500">QEMU Guest Agent</span><span className="text-text-200">{vm.qemuAgentEnabled !== false ? "Enabled" : "Disabled"}</span></div>
        </div>
      </div>

      {/* CPU/Memory quick info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-text-300 mb-3">Processor</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-text-500">vCPUs</span><span className="text-text-200">{vm.vcpus}</span></div>
            <div className="flex justify-between"><span className="text-text-500">CPU Type</span><span className="text-text-200">host</span></div>
          </div>
        </div>
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-text-300 mb-3">Memory</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-text-500">Max</span><span className="text-text-200">{formatBytes(vm.maxMemoryKiB * 1024)}</span></div>
            <div className="flex justify-between"><span className="text-text-500">Current</span><span className="text-text-200">{formatBytes(vm.currentMemoryKiB * 1024)}</span></div>
          </div>
        </div>
      </div>

      {/* Add Disk Modal */}
      <Modal open={addDiskOpen && permissions.canModify} onClose={() => setAddDiskOpen(false)} title={t("modal.addDisk")}
        footer={
          <>
            <button onClick={() => setAddDiskOpen(false)} className="btn-secondary">Cancel</button>
            <button
              onClick={() => attachDisk.mutate()}
              disabled={attachDisk.isPending || (diskAttachMode === "existing" ? !existingDiskPath.trim() : !diskPool)}
              className="btn-primary"
            >
              {attachDisk.isPending ? "Adding..." : "Add Disk"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Source</label>
            <select
              value={diskAttachMode}
              onChange={(e) => {
                setDiskAttachMode(e.target.value as "new" | "existing");
                setExistingDiskPath("");
                setExistingDiskPool("");
              }}
              className="select"
            >
              <option value="new">Create a new disk</option>
              <option value="existing">Attach an existing disk</option>
            </select>
          </div>
          {diskAttachMode === "existing" ? (
            <div>
              <label className="label">Available disk</label>
              <select
                value={existingDiskSelection}
                onChange={(e) => {
                  const selected = availableVmDisks.find((disk) => `${disk.storagePool ?? ""}::${disk.filename}` === e.target.value);
                  setExistingDiskPath(selected?.filename ?? "");
                  setExistingDiskPool(selected?.storagePool ?? "");
                }}
                className="select"
              >
                <option value="">Select unattached disk...</option>
                {availableVmDisks.map((disk) => (
                  <option key={`${disk.storagePool ?? "local"}:${disk.filename}`} value={`${disk.storagePool ?? ""}::${disk.filename}`}>
                    {disk.displayName || disk.filename} · {disk.storagePool || "local"} · {formatBytes(disk.sizeBytes)}
                  </option>
                ))}
              </select>
              {availableVmDisks.length === 0 && (
                <p className="mt-1 text-xs text-text-500">No unattached VM disk is available in the library.</p>
              )}
            </div>
          ) : (
          <div>
            <label className="label">Size (GB)</label>
            <input type="number" value={newDiskSize} onChange={(e) => setNewDiskSize(parseInt(e.target.value))} className="input" min={1} max={65536} />
          </div>
          )}
          <div>
            <label className="label">Bus</label>
            <select value={newDiskBus} onChange={(e) => setNewDiskBus(e.target.value)} className="select">
              <option value="virtio">VirtIO (recommended)</option>
              <option value="sata">SATA</option>
              <option value="ide">IDE</option>
              <option value="scsi">SCSI</option>
            </select>
          </div>
          {diskAttachMode === "new" && (
            <div>
            <label className="label">Storage Pool</label>
            <select value={diskPool} onChange={(e) => setDiskPool(e.target.value)} className="select">
              <option value="">Select pool...</option>
              {pools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          )}
        </div>
      </Modal>

      <Modal
        open={editResourcesOpen && permissions.canModify}
        onClose={() => setEditResourcesOpen(false)}
        title={t("modal.editResources")}
        footer={
          <>
            <button onClick={() => setEditResourcesOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={() => updateResources.mutate()} disabled={updateResources.isPending} className="btn-primary">
              {updateResources.isPending ? "Saving..." : "Save"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">vCPUs</label>
            <input type="number" value={editVcpus} onChange={(e) => setEditVcpus(parseInt(e.target.value, 10) || 1)} className="input" min={1} max={256} />
          </div>
          <div>
            <label className="label">Memory (MiB)</label>
            <input type="number" value={editMemoryMb} onChange={(e) => setEditMemoryMb(parseInt(e.target.value, 10) || 128)} className="input" min={128} step={128} />
          </div>
          <div>
            <label className="label">Primary Boot Device</label>
            <select value={editBootDevice} onChange={(e) => setEditBootDevice(e.target.value as "hd" | "cdrom" | "network")} className="select">
              <option value="hd">Disk</option>
              <option value="cdrom">CD-ROM / ISO</option>
              <option value="network">Network (PXE)</option>
            </select>
            {editBootDevice === "network" && editUefi && vm.networks.some((n) => n.model === "virtio") && (
              <p className="mt-1.5 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded px-2 py-1.5">
                ⚠ PXE UEFI + VirtIO NIC : OVMF n'a pas de ROM PXE pour VirtIO. Le boot réseau échouera (SCCM/WDS inclus). Passe le modèle NIC en <strong>e1000</strong> dans l'onglet Réseau.
              </p>
            )}
          </div>
          <div>
            <label className="label">Display Model</label>
            <select value={editVideoModel} onChange={(e) => setEditVideoModel(e.target.value as "vga" | "virtio" | "qxl")} className="select">
              <option value="vga">VGA</option>
              <option value="virtio">VirtIO GPU</option>
              <option value="qxl">QXL</option>
            </select>
          </div>
          <div>
            <label className="label">Firmware</label>
            <select value={editUefi ? "uefi" : "bios"} onChange={(e) => { const uefi = e.target.value === "uefi"; setEditUefi(uefi); if (!uefi) setEditSecureBoot(false); }} className="select" disabled={vm.arch === "aarch64"}>
              <option value="bios">BIOS (SeaBIOS)</option>
              <option value="uefi">UEFI (OVMF)</option>
            </select>
            <p className="text-xs text-text-500 mt-1">Requires VM to be stopped. Switching UEFI→BIOS removes NVRAM variables.</p>
          </div>
          <label className={`flex items-center gap-2 ${editUefi ? "cursor-pointer" : "opacity-50"}`}>
            <input type="checkbox" className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue" checked={editSecureBoot && editUefi} disabled={!editUefi || vm.arch === "aarch64"} onChange={(e) => setEditSecureBoot(e.target.checked)} />
            <span className="text-sm text-text-300">Secure Boot (required by Windows 11)</span>
          </label>
          {editSecureBoot && editUefi && !vm.secureBoot && (
            <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded px-2 py-1.5">
              ⚠ Enabling Secure Boot resets the VM's UEFI variables (NVRAM) so the Microsoft keys get enrolled. Boot entries will be rebuilt on next start. Requires VM to be stopped.
            </p>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue" checked={editTpmEnabled} onChange={(e) => setEditTpmEnabled(e.target.checked)} />
            <span className="text-sm text-text-300">Emulate TPM 2.0</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue" checked={editQemuAgentEnabled} onChange={(e) => setEditQemuAgentEnabled(e.target.checked)} />
            <span className="text-sm text-text-300">Enable QEMU Guest Agent</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue" checked={editAutostart} onChange={(e) => setEditAutostart(e.target.checked)} />
            <span className="text-sm text-text-300">Start VM automatically with host</span>
          </label>
          <p className="text-xs text-text-500">
            The guest OS still needs the <code>qemu-guest-agent</code> package installed to use the agent inside the VM.
          </p>
        </div>
      </Modal>

      <Modal
        open={isoOpen && permissions.canMedia}
        onClose={() => setIsoOpen(false)}
        title="Insert ISO"
        footer={
          <>
            <button onClick={() => setIsoOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={() => attachIso.mutate()} disabled={attachIso.isPending || !selectedIso} className="btn-primary">
              {attachIso.isPending ? "Inserting..." : "Insert"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">ISO image</label>
            <select value={selectedIso} onChange={(e) => setSelectedIso(e.target.value)} className="select">
              <option value="">Select ISO...</option>
              {availableIsos.map((iso) => (
                <option key={iso.filename} value={iso.filename}>{iso.displayName || iso.filename}</option>
              ))}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function VmNetworkTab({ vm, vmName }: { vm: VmInfo; vmName: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTargetMac, setEditTargetMac] = useState<string | null>(null);
  const [bridge, setBridge] = useState("virbr0");
  const [model, setModel] = useState("virtio");
  const [customMac, setCustomMac] = useState("");
  const [networkError, setNetworkError] = useState("");

  const { data: bridges = [] } = useQuery<string[]>({
    queryKey: ["network", "bridges", "list"],
    queryFn: () => apiGet<Array<{ name: string }>>("/api/network/bridges").then((b) => b.map((br) => br.name)),
  });

  /** Pick the best default bridge: prefer virbr0/br0, else first in list */
  const defaultBridge = (list: string[]) =>
    ["br0", "virbr0"].find((b) => list.includes(b)) ?? list[0] ?? "virbr0";

  const resetForm = () => {
    setBridge(defaultBridge(bridges));
    setModel("virtio");
    setCustomMac("");
    setNetworkError("");
  };

  const openEdit = (nic: VmInfo["networks"][number]) => {
    setEditTargetMac(nic.mac);
    setBridge(nic.source || defaultBridge(bridges));
    setModel(nic.model || "virtio");
    setCustomMac(nic.mac);
    setNetworkError("");
    setEditOpen(true);
  };

  const attachNetwork = useMutation({
    mutationFn: () => apiPost(`/api/vms/${vmName}/network/attach`, { bridge, model, mac: customMac || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      setAddOpen(false);
      resetForm();
    },
    onError: (error: Error) => setNetworkError(error.message),
  });

  const updateNetwork = useMutation({
    mutationFn: () => {
      if (!editTargetMac) throw new Error("No NIC selected");
      return apiPut(`/api/vms/${vmName}/network/${editTargetMac}`, { bridge, model, mac: customMac || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      setEditOpen(false);
      setEditTargetMac(null);
      resetForm();
    },
    onError: (error: Error) => setNetworkError(error.message),
  });

  const detachNetwork = useMutation({
    mutationFn: (mac: string) => apiDelete(`/api/vms/${vmName}/network/${mac}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vm", vmName] }),
  });

  const submitAdd = () => {
    setNetworkError("");
    if (customMac && !customMac.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)) {
      setNetworkError("MAC address must use aa:bb:cc:dd:ee:ff format");
      return;
    }
    attachNetwork.mutate();
  };

  const submitEdit = () => {
    setNetworkError("");
    if (customMac && !customMac.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)) {
      setNetworkError("MAC address must use aa:bb:cc:dd:ee:ff format");
      return;
    }
    updateNetwork.mutate();
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-500">
        <h3 className="text-sm font-semibold text-text-300">Network Interfaces</h3>
        <button onClick={() => { resetForm(); setAddOpen(true); }} className="btn-secondary btn-sm">+ Add NIC</button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-surface-600/50">
          <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
            <th className="px-4 py-2">MAC Address</th>
            <th className="px-4 py-2">Model</th>
            <th className="px-4 py-2">Bridge</th>
            <th className="px-4 py-2">IP Addresses</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-600">
          {vm.networks.map((nic) => (
            <tr key={nic.mac} className="hover:bg-surface-600/20">
              <td className="px-4 py-2 font-mono text-text-200">{nic.mac}</td>
              <td className="px-4 py-2 text-text-400">{nic.model}</td>
              <td className="px-4 py-2 text-text-400">{nic.source}</td>
              <td className="px-4 py-2 text-text-400">{(nic.ipAddresses ?? []).join(", ") || "—"}</td>
              <td className="px-4 py-2 text-right">
                <button onClick={() => openEdit(nic)} className="btn-ghost btn-sm text-text-300">Edit</button>
                <button onClick={() => detachNetwork.mutate(nic.mac)} className="btn-ghost btn-sm text-red-400">Remove</button>
              </td>
            </tr>
          ))}
          {vm.networks.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-6 text-center text-text-500">No network interfaces</td></tr>
          )}
        </tbody>
      </table>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t("modal.addNetworkInterface")}
        footer={
          <>
            <button onClick={() => { setAddOpen(false); resetForm(); }} className="btn-secondary">Cancel</button>
            <button onClick={submitAdd} disabled={attachNetwork.isPending} className="btn-primary">
              {attachNetwork.isPending ? "Adding..." : "Add NIC"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Bridge</label>
            <select value={bridge} onChange={(e) => setBridge(e.target.value)} className="select">
              {bridges.map((b) => <option key={b} value={b}>{b}</option>)}
              {bridges.length === 0 && <option value={bridge}>{bridge || "—"}</option>}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="select">
              <option value="virtio">VirtIO (recommended)</option>
              <option value="e1000">Intel E1000</option>
              <option value="rtl8139">Realtek RTL8139</option>
            </select>
          </div>
          <div>
            <label className="label">Manual MAC (optional)</label>
            <input value={customMac} onChange={(e) => setCustomMac(e.target.value.toLowerCase())} className="input font-mono" placeholder="aa:bb:cc:dd:ee:ff" />
            <p className="text-xs text-text-500 mt-1">Useful for provider-assigned virtual MAC (vMAC) and static MAC requirements</p>
          </div>
          {networkError && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{networkError}</div>}
        </div>
      </Modal>

      <Modal open={editOpen} onClose={() => { setEditOpen(false); setEditTargetMac(null); resetForm(); }} title={t("modal.editNetworkInterface")}
        footer={
          <>
            <button onClick={() => { setEditOpen(false); setEditTargetMac(null); resetForm(); }} className="btn-secondary">Cancel</button>
            <button onClick={submitEdit} disabled={updateNetwork.isPending || !editTargetMac} className="btn-primary">
              {updateNetwork.isPending ? "Saving..." : "Save Changes"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Bridge</label>
            <select value={bridge} onChange={(e) => setBridge(e.target.value)} className="select">
              {bridges.map((b) => <option key={b} value={b}>{b}</option>)}
              {bridges.length === 0 && <option value={bridge}>{bridge || "—"}</option>}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="select">
              <option value="virtio">VirtIO (recommended)</option>
              <option value="e1000">Intel E1000</option>
              <option value="rtl8139">Realtek RTL8139</option>
            </select>
          </div>
          <div>
            <label className="label">MAC Address</label>
            <input value={customMac} onChange={(e) => setCustomMac(e.target.value.toLowerCase())} className="input font-mono" placeholder="aa:bb:cc:dd:ee:ff" />
          </div>
          {networkError && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{networkError}</div>}
        </div>
      </Modal>
    </div>
  );
}

function VmSnapshotsTab({ snapshots, vmName, onCreate, onRollback, onDelete, isCreating }: {
  snapshots: VmSnapshot[];
  vmName: string;
  onCreate: (p: { snapName: string; desc: string }) => void;
  onRollback: (n: string) => void;
  onDelete: (n: string) => void;
  isCreating: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [snapName, setSnapName] = useState("");
  const [snapDesc, setSnapDesc] = useState("");
  const { data: tasks = [] } = useQuery<TaskProgress[]>({
    queryKey: ["tasks", "vm-snapshots", vmName],
    queryFn: () => apiGet<TaskProgress[]>("/api/tasks?limit=50"),
    refetchInterval: 2_000,
  });

  const taskForSnapshot = (name: string) => tasks.find((task) =>
    task.resourceName === vmName &&
    task.detail === name &&
    (task.status === "pending" || task.status === "running") &&
    (task.action === "vm.snapshot.create" || task.action === "vm.snapshot.delete" || task.action === "vm.snapshot.rollback")
  );

  const formatSnapshotStatus = (snap: VmSnapshot) => {
    const task = taskForSnapshot(snap.name);
    if (task?.action === "vm.snapshot.create") return "Creating";
    if (task?.action === "vm.snapshot.delete") return "Deleting";
    if (task?.action === "vm.snapshot.rollback") return "Restoring";
    if (snap.isCurrent) return "Current";
    return "Ready";
  };

  const canActOnSnapshot = (snap: VmSnapshot) => !taskForSnapshot(snap.name);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setCreateOpen(true)} className="btn-primary">+ Create Snapshot</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-600/50">
            <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-600">
            {snapshots.map((snap) => (
              <tr key={snap.name} className={`hover:bg-surface-600/20 ${snap.isCurrent ? "bg-accent-blue/5" : ""}`}>
                <td className="px-4 py-2 font-mono text-text-200">
                  {snap.name}
                </td>
                <td className="px-4 py-2 text-text-400">{snap.createdAt ? formatDate(snap.createdAt) : "—"}</td>
                <td className="px-4 py-2 text-text-400">{formatSnapshotStatus(snap)}</td>
                <td className="px-4 py-2 text-right flex gap-1 justify-end">
                  <button onClick={() => onRollback(snap.name)} disabled={!canActOnSnapshot(snap)} className="btn-secondary btn-sm">Rollback</button>
                  <button onClick={() => onDelete(snap.name)} disabled={!canActOnSnapshot(snap)} className="btn-danger btn-sm">Delete</button>
                </td>
              </tr>
            ))}
            {snapshots.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-text-500">No snapshots</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Snapshot"
        footer={
          <>
            <button onClick={() => setCreateOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={() => { onCreate({ snapName, desc: snapDesc }); setCreateOpen(false); setSnapName(""); setSnapDesc(""); }} disabled={isCreating || !snapName} className="btn-primary">
              {isCreating ? "Creating..." : "Create"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Snapshot Name</label>
            <input value={snapName} onChange={(e) => setSnapName(e.target.value)} className="input" placeholder="snap1" pattern="[a-zA-Z0-9_-]+" />
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <input value={snapDesc} onChange={(e) => setSnapDesc(e.target.value)} className="input" placeholder="Before update..." />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function VmBackupTab({ vmName, nodeName }: { vmName: string; nodeName?: string }) {
  const qc = useQueryClient();
  const [backupOpen, setBackupOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; filename: string } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; filename: string; storagePool: string; format: string } | null>(null);
  const [format, setFormat] = useState<"tar.gz" | "qcow2">("qcow2");
  const [compress, setCompress] = useState(true);
  const [compressionLevel, setCompressionLevel] = useState(9);
  const [pool, setPool] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [restorePool, setRestorePool] = useState("");
  const [restoreBridge, setRestoreBridge] = useState("virbr0");
  const [restoreMac, setRestoreMac] = useState("");
  const [restoreVcpus, setRestoreVcpus] = useState(2);
  const [restoreMemoryMb, setRestoreMemoryMb] = useState(2048);
  // "asIs" keeps the VM's original CPU/RAM from the backup; "modify" overrides.
  // qcow2 backups carry no stored config, so they always go through "modify".
  const [restoreMode, setRestoreMode] = useState<"asIs" | "modify">("asIs");
  const restoreForcesModify = restoreTarget?.format === "qcow2";
  const restoreEffectiveMode = restoreForcesModify ? "modify" : restoreMode;

  const { data: pools = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ["storage", "pools", nodeName ?? "local"],
    queryFn: () => apiGet<Array<{ name: string }>>(nodeName ? `/api/nodes/${encodeURIComponent(nodeName)}/storage/pools` : "/api/storage/pools"),
  });

  useEffect(() => {
    if (!pool && pools.length > 0) {
      setPool(pools[0].name);
    }
  }, [pool, pools]);

  const { data: backups = [] } = useQuery<Array<{ id: string; filename: string; sizeBytes: number; createdAt: string; format: string; storagePool: string }>>({
    queryKey: ["vm", vmName, "backups"],
    queryFn: () => apiGet(`/api/backups?resourceType=vm&resourceName=${encodeURIComponent(vmName)}`),
    refetchInterval: 5_000,
  });

  const createBackup = useMutation({
    mutationFn: () => apiPost(`/api/vms/${vmName}/backup`, { storagePool: pool, format, compress, compressionLevel }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vm", vmName, "backups"] }); setBackupOpen(false); },
  });

  const deleteBackup = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/backups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vm", vmName, "backups"] });
      qc.invalidateQueries({ queryKey: ["backups"] });
      setDeleteTarget(null);
    },
  });

  const restoreBackup = useMutation({
    mutationFn: (id: string) => apiPost(`/api/backups/${id}/restore`, {
      name: restoreName,
      storagePool: restorePool || pool,
      bridge: restoreBridge,
      mac: restoreMac || undefined,
      // Only override CPU/RAM when modifying; otherwise keep the originals.
      ...(restoreEffectiveMode === "modify" ? { vcpus: restoreVcpus, memoryMb: restoreMemoryMb } : {}),
      autostart: false,
    }),
    onSuccess: () => {
      setRestoreTarget(null);
      qc.invalidateQueries({ queryKey: ["backups"] });
    },
  });

  useEffect(() => {
    if (!restoreTarget) return;
    setRestoreMode("asIs");
    setRestoreName(`${vmName}-restore`);
    setRestorePool(restoreTarget.storagePool || pool);
    setRestoreBridge("virbr0");
    setRestoreMac("");
    setRestoreVcpus(2);
    setRestoreMemoryMb(2048);
  }, [restoreTarget, vmName, pool]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setBackupOpen(true)} className="btn-primary">+ Create Backup</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-600/50">
            <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
              <th className="px-4 py-2">Filename</th>
              <th className="px-4 py-2">Format</th>
              <th className="px-4 py-2">Size</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-600">
            {backups.map((bk) => (
              <tr key={bk.id} className="hover:bg-surface-600/20">
                <td className="px-4 py-2 font-mono text-xs text-text-200">{bk.filename}</td>
                <td className="px-4 py-2 text-text-400">{bk.format}</td>
                <td className="px-4 py-2 text-text-400">{formatBytes(bk.sizeBytes)}</td>
                <td className="px-4 py-2 text-text-400">{formatDate(bk.createdAt)}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-2">
                    <button onClick={() => setRestoreTarget(bk)} className="btn-secondary btn-sm">Restore</button>
                    <button onClick={() => setDeleteTarget(bk)} className="btn-danger btn-sm">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-text-500">No backups</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={backupOpen} onClose={() => setBackupOpen(false)} title="Create Backup"
        footer={
          <>
            <button onClick={() => setBackupOpen(false)} className="btn-secondary">Cancel</button>
            <button onClick={() => createBackup.mutate()} disabled={createBackup.isPending || !pool} className="btn-primary">
              {createBackup.isPending ? "Backing up..." : "Backup"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Storage Pool</label>
            <select value={pool} onChange={(e) => setPool(e.target.value)} className="select">
              <option value="">Select pool...</option>
              {pools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as "tar.gz" | "qcow2")} className="select">
              <option value="qcow2">qcow2 (native image)</option>
              <option value="tar.gz">.tar.zst (portable archive)</option>
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
              checked={compress}
              onChange={(e) => setCompress(e.target.checked)}
              disabled={format === "tar.gz"}
            />
            <span className="text-sm text-text-300">
              Compress qcow2 backup (zstd)
            </span>
          </label>
          {format === "tar.gz" && (
            <div>
              <label className="label">Niveau de compression (zstd)</label>
              <select className="select" value={compressionLevel} onChange={(e) => setCompressionLevel(parseInt(e.target.value, 10))}>
                <option value={3}>3 — Rapide (ratio faible)</option>
                <option value={9}>9 — Équilibré (recommandé)</option>
                <option value={19}>19 — Maximum (plus lent)</option>
              </select>
            </div>
          )}
          <p className="text-xs text-text-500">
            L'archive <span className="font-mono">.tar.zst</span> (zstd) compresse les disques + la définition XML.
            Le format <span className="font-mono">qcow2</span> compresse en interne (zstd) au prix d'un backup plus long.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        title="Restore VM Backup"
        footer={
          <>
            <button onClick={() => setRestoreTarget(null)} className="btn-secondary">Cancel</button>
            <button onClick={() => restoreTarget && restoreBackup.mutate(restoreTarget.id)} disabled={restoreBackup.isPending || !restoreName} className="btn-primary">
              {restoreBackup.isPending ? "Starting..." : "Restore"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-xs text-text-500 font-mono">{restoreTarget?.filename}</div>
          {!restoreForcesModify && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRestoreMode("asIs")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  restoreEffectiveMode === "asIs"
                    ? "border-accent-blue bg-accent-blue/10 text-text-100"
                    : "border-surface-600 text-text-400 hover:text-text-200"
                }`}
              >
                Restaurer tel quel
              </button>
              <button
                type="button"
                onClick={() => setRestoreMode("modify")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  restoreEffectiveMode === "modify"
                    ? "border-accent-blue bg-accent-blue/10 text-text-100"
                    : "border-surface-600 text-text-400 hover:text-text-200"
                }`}
              >
                Modifier (nom + CPU/RAM)
              </button>
            </div>
          )}
          <div>
            <label className="label">New VM Name</label>
            <input value={restoreName} onChange={(e) => setRestoreName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Storage Pool</label>
            <select value={restorePool} onChange={(e) => setRestorePool(e.target.value)} className="select">
              <option value="">Select pool...</option>
              {pools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Bridge</label>
              <input value={restoreBridge} onChange={(e) => setRestoreBridge(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">MAC (optional)</label>
              <input value={restoreMac} onChange={(e) => setRestoreMac(e.target.value)} className="input" placeholder="aa:bb:cc:dd:ee:ff" />
            </div>
          </div>
          {restoreEffectiveMode === "modify" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">vCPUs</label>
                <input type="number" min={1} value={restoreVcpus} onChange={(e) => setRestoreVcpus(parseInt(e.target.value, 10) || 2)} className="input" />
              </div>
              <div>
                <label className="label">Memory (MiB)</label>
                <input type="number" min={512} step={256} value={restoreMemoryMb} onChange={(e) => setRestoreMemoryMb(parseInt(e.target.value, 10) || 2048)} className="input" />
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteBackup.mutate(deleteTarget.id)}
        loading={deleteBackup.isPending}
        dangerous
        title="Delete Backup"
        message={deleteTarget ? `Delete backup ${deleteTarget.filename}?` : ""}
        confirmLabel="Delete"
      />
    </div>
  );
}
