import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiDelete, apiGet, apiPost, apiUpload } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { AccessDenied } from "../../components/auth/AccessDenied";
import { formatBytes } from "../../utils/formatBytes";
import { useAuth } from "../../utils/useAuth";
import type { StoragePool, TaskProgress, TemplateSummary } from "@auxinux/shared";

interface DepotItem {
  id: string;
  type: "iso" | "vm";
  arch: "amd64" | "arm64";
  name: string;
  description: string;
  cpu?: number;
  memory?: number;
  filename: string;
  sizeBytes?: number;
  sizeLabel?: string;
  alreadyImported: boolean;
}

interface ActiveTask { id: string; depotId: string; label: string; handled?: boolean }

const PATCH_HEADERS = { "Content-Type": "application/json" };

type TemplateType = "vm" | "iso";

interface UploadProgress {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full bg-surface-700 rounded-full h-2 overflow-hidden">
      <div className="bg-accent-blue h-2 rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(percent, 100))}%` }} />
    </div>
  );
}

/** PATCH helper (the shared api client has no apiPatch). */
async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const csrfRes = await fetch("/api/auth/csrf", { credentials: "include" });
  const { token } = (await csrfRes.json()) as { token: string };
  const res = await fetch(path, {
    method: "PATCH",
    headers: { ...PATCH_HEADERS, "X-CSRF-Token": token },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export default function TemplatesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<TemplateType>("vm");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TemplateSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateSummary | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Upload form state
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fArch, setFArch] = useState<"amd64" | "arm64">("amd64");
  const [fVisibility, setFVisibility] = useState<"public" | "restricted">("restricted");
  const [fCpu, setFCpu] = useState("");
  const [fMem, setFMem] = useState("");
  const [fDisk, setFDisk] = useState("");
  const [fPool, setFPool] = useState("");

  const { data: templates = [] } = useQuery<TemplateSummary[]>({
    queryKey: ["templates", tab],
    queryFn: () => apiGet<TemplateSummary[]>(`/api/templates?type=${tab}`),
    refetchInterval: 15_000,
    enabled: isAdmin,
  });

  const { data: pools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools"],
    queryFn: () => apiGet<StoragePool[]>("/api/storage/pools"),
    enabled: isAdmin,
    staleTime: 30_000,
  });

  const compatiblePools = useMemo(
    () => pools.filter((p) => p.content.includes(tab === "iso" ? "iso" : "template")),
    [pools, tab],
  );

  // ── Remote depot catalog ──
  const [depotOpen, setDepotOpen] = useState(false);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);

  const { data: depot, isFetching: depotLoading, refetch: refetchDepot, error: depotError } = useQuery<{ base: string; items: DepotItem[] }>({
    queryKey: ["templates", "depot"],
    queryFn: () => apiGet<{ base: string; items: DepotItem[] }>("/api/templates/depot"),
    enabled: depotOpen,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [depotArch, setDepotArch] = useState<"amd64" | "arm64">("amd64");
  const depotItems = useMemo(
    () => (depot?.items ?? []).filter((it) => it.type === tab && it.arch === depotArch),
    [depot, tab, depotArch],
  );

  const importTaskQueries = useQueries({
    queries: activeTasks.map((task) => ({
      queryKey: ["tasks", task.id],
      queryFn: () => apiGet<TaskProgress>(`/api/tasks/${task.id}`),
      refetchInterval: 1_500,
      staleTime: 0,
    })),
  });

  const importMutation = useMutation({
    mutationFn: (item: DepotItem) => apiPost<TaskProgress>("/api/templates/depot/import", { id: item.id }),
    onSuccess: (task, item) => {
      setActiveTasks((cur) => cur.some((e) => e.depotId === item.id) ? cur : [...cur, { id: task.id, depotId: item.id, label: task.label }]);
    },
  });

  const importStates = useMemo(
    () => activeTasks.map((task, i) => ({ task, progress: importTaskQueries[i]?.data })),
    [activeTasks, importTaskQueries],
  );

  // depotId → live progress, so each row can show its own bar.
  const progressByDepotId = useMemo(() => {
    const map = new Map<string, { percent: number; status: TaskProgress["status"]; error?: string }>();
    for (const { task, progress } of importStates) {
      if (task.handled) continue;
      map.set(task.depotId, {
        percent: progress?.progressPercent ?? 0,
        status: progress?.status ?? "pending",
        error: progress?.error,
      });
    }
    return map;
  }, [importStates]);

  useEffect(() => {
    for (const { task, progress } of importStates) {
      if (!progress || task.handled) continue;
      if (progress.status === "completed" || progress.status === "failed") {
        if (progress.status === "completed") {
          qc.invalidateQueries({ queryKey: ["templates"] });
          void refetchDepot();
        }
        setActiveTasks((cur) => cur.map((e) => e.id === task.id ? { ...e, handled: true } : e));
      }
    }
  }, [importStates, qc, refetchDepot]);

  const resetUploadForm = () => {
    setFName(""); setFDesc(""); setFArch("amd64"); setFVisibility("restricted");
    setFCpu(""); setFMem(""); setFDisk(""); setFPool("");
    setUploadError(null); setUploadProgress(null);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadProgress({ percent: 0, loadedBytes: 0, totalBytes: file.size });

    const fd = new FormData();
    fd.append("type", tab);
    fd.append("file", file);
    if (fName.trim()) fd.append("name", fName.trim());
    if (fDesc.trim()) fd.append("description", fDesc.trim());
    fd.append("arch", fArch);
    fd.append("visibility", fVisibility);
    if (fCpu) fd.append("cpu", fCpu);
    if (fMem) fd.append("memoryMb", fMem);
    if (fDisk) fd.append("diskGb", fDisk);
    if (fPool) fd.append("storagePool", fPool);

    try {
      await apiUpload("/api/templates", fd, (p) => setUploadProgress(p));
      qc.invalidateQueries({ queryKey: ["templates"] });
      setUploadOpen(false);
      resetUploadForm();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadProgress(null);
    }
    e.target.value = "";
  };

  const editMutation = useMutation({
    mutationFn: (payload: { id: string; body: Record<string, unknown> }) =>
      apiPatch(`/api/templates/${encodeURIComponent(payload.id)}`, payload.body),
    onSuccess: () => {
      setEditTarget(null);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (tpl: TemplateSummary) => apiDelete(`/api/templates/${encodeURIComponent(tpl.id)}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });

  const downloadTemplate = (tpl: TemplateSummary) => {
    const link = document.createElement("a");
    link.href = `/api/templates/${encodeURIComponent(tpl.id)}/download`;
    link.download = tpl.type === "vm" ? `${tpl.name || tpl.filename}-bundle.tar.gz` : tpl.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  if (!isAdmin) return <AccessDenied message={t("templates.adminOnly", "Templates are managed by administrators only.")} />;

  const tabs: Array<{ key: TemplateType; label: string; icon: string }> = [
    { key: "vm", label: t("templates.vmTab", "VM Templates"), icon: "🖥️" },
    { key: "iso", label: t("templates.isoTab", "ISO"), icon: "💿" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("templates.title", "Templates")}</h1>
          <p className="text-sm text-text-400 mt-1">
            {t("templates.subtitle", "Server-managed VM templates and ISO images. The server is the source of truth in Cloud mode.")}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setDepotOpen(true)} className="btn">
            {t("templates.depot", "Depot catalog")}
          </button>
          <button onClick={() => { resetUploadForm(); setUploadOpen(true); }} className="btn-primary">
            {t("action.upload", "Upload")}
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-surface-600">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === entry.key ? "border-accent-blue text-accent-blue" : "border-transparent text-text-400 hover:text-text-200"
            }`}
          >
            {entry.icon} {entry.label}
          </button>
        ))}
      </div>

      {uploadProgress && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-text-200">{t("action.upload", "Upload")}</div>
            <div className="text-sm font-mono text-text-300">{uploadProgress.percent}%</div>
          </div>
          <ProgressBar percent={uploadProgress.percent} />
          <div className="text-xs text-text-500">
            {formatBytes(uploadProgress.loadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
          </div>
        </div>
      )}

      {templates.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-4xl mb-3">{tab === "vm" ? "🖥️" : "💿"}</div>
          <div className="text-text-300">{t("templates.empty", "No templates yet")}</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.name", "Name")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("templates.arch", "Arch")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("templates.specs", "CPU / RAM")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.size", "Size")}</th>
                <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.visibility", "Visibility")}</th>
                <th className="px-4 py-3 text-right text-text-400 font-medium">{t("storage.actions", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => (
                <tr key={tpl.id} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-text-200 font-medium">{tpl.name}</div>
                    {tpl.description && <div className="text-xs text-text-500 mt-0.5 line-clamp-1">{tpl.description}</div>}
                    <div className="text-xs font-mono text-text-500 mt-0.5">{tpl.filename}</div>
                  </td>
                  <td className="px-4 py-3 text-text-300">{tpl.architecture}</td>
                  <td className="px-4 py-3 text-text-300 font-mono text-xs">
                    {tpl.type === "vm" ? `${tpl.cpu ?? "—"} / ${tpl.memory ? `${tpl.memory} MB` : "—"}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-text-300">{tpl.size ? formatBytes(tpl.size) : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      tpl.visibility === "public" ? "bg-green-900/20 text-green-400" : "bg-surface-700 text-text-400"
                    }`}>
                      {tpl.visibility === "public" ? t("storage.public", "Public") : t("storage.private", "Restricted")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => downloadTemplate(tpl)} className="p-1.5 rounded text-accent-blue hover:bg-accent-blue/10 transition-colors" title={t("action.download", "Download")}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                        </svg>
                      </button>
                      <button onClick={() => setEditTarget(tpl)} className="p-1.5 rounded text-text-400 hover:bg-surface-700 transition-colors" title={t("action.edit", "Edit")}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button onClick={() => setDeleteTarget(tpl)} className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors" title={t("action.delete", "Delete")}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upload modal */}
      <Modal open={uploadOpen} title={t("templates.uploadTitle", "Upload template")} onClose={() => { setUploadOpen(false); resetUploadForm(); }}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("storage.name", "Name")}</label>
              <input className="input" value={fName} onChange={(e) => setFName(e.target.value)} placeholder={tab === "vm" ? "Debian 13.5 AMD64" : "debian-13.iso"} />
            </div>
            <div>
              <label className="label">{t("templates.arch", "Arch")}</label>
              <select className="input" value={fArch} onChange={(e) => setFArch(e.target.value as "amd64" | "arm64")}>
                <option value="amd64">amd64</option>
                <option value="arm64">arm64</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">{t("storage.description", "Description")}</label>
            <input className="input" value={fDesc} onChange={(e) => setFDesc(e.target.value)} />
          </div>
          {tab === "vm" && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">CPU</label>
                <input className="input" type="number" min={1} value={fCpu} onChange={(e) => setFCpu(e.target.value)} placeholder="auto" />
              </div>
              <div>
                <label className="label">RAM (MB)</label>
                <input className="input" type="number" min={64} value={fMem} onChange={(e) => setFMem(e.target.value)} placeholder="auto" />
              </div>
              <div>
                <label className="label">{t("templates.diskGb", "Disk (GB)")}</label>
                <input className="input" type="number" min={1} value={fDisk} onChange={(e) => setFDisk(e.target.value)} placeholder="—" />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("storage.visibility", "Visibility")}</label>
              <select className="input" value={fVisibility} onChange={(e) => setFVisibility(e.target.value as "public" | "restricted")}>
                <option value="restricted">{t("storage.private", "Restricted")}</option>
                <option value="public">{t("storage.public", "Public")}</option>
              </select>
            </div>
            <div>
              <label className="label">{t("storage.pool", "Storage pool")}</label>
              <select className="input" value={fPool} onChange={(e) => setFPool(e.target.value)}>
                <option value="">{t("templates.defaultStore", "Default store")}</option>
                {compatiblePools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <div
            className="border-2 border-dashed border-surface-500 rounded-lg p-8 text-center cursor-pointer hover:border-accent-blue transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <div className="text-3xl mb-2">{tab === "vm" ? "🖥️" : "💿"}</div>
            <div className="text-text-300">{t("storage.selectFile", "Select a file")}</div>
            <div className="text-xs text-text-500 mt-1">{tab === "vm" ? "*.tar.gz, *.tgz" : "*.iso, *.img"}</div>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept={tab === "vm" ? ".tar.gz,.tgz" : ".iso,.img"}
              onChange={handleUpload}
            />
          </div>
          {uploadError && (
            <div className="rounded-md bg-red-900/30 border border-red-700 px-3 py-2 text-sm text-red-300">{uploadError}</div>
          )}
          {uploadProgress && uploadProgress.percent > 0 && uploadProgress.percent < 100 && (
            <ProgressBar percent={uploadProgress.percent} />
          )}
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editTarget} title={t("templates.editTitle", "Edit template")} onClose={() => setEditTarget(null)}>
        {editTarget && (
          <EditTemplateForm
            template={editTarget}
            saving={editMutation.isPending}
            error={editMutation.error instanceof Error ? editMutation.error.message : null}
            onSave={(body) => editMutation.mutate({ id: editTarget.id, body })}
            onCancel={() => setEditTarget(null)}
            t={t}
          />
        )}
      </Modal>

      {/* Depot catalog modal */}
      <Modal open={depotOpen} title={t("templates.depotTitle", "Depot catalog")} onClose={() => setDepotOpen(false)} size="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-text-400">
              {t("templates.depotSubtitle", "Download ready-made templates and ISOs from the AuxiNux depot.")}
              {depot?.base ? <span className="block text-xs font-mono text-text-500 mt-0.5">{depot.base}</span> : null}
            </p>
            <button onClick={() => refetchDepot()} disabled={depotLoading} className="btn">
              {depotLoading ? t("msg.loading", "Loading…") : t("action.refresh", "Refresh")}
            </button>
          </div>

          <div className="flex gap-1 border-b border-surface-600">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setTab(entry.key)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === entry.key ? "border-accent-blue text-accent-blue" : "border-transparent text-text-400 hover:text-text-200"
                }`}
              >
                {entry.icon} {entry.label}
              </button>
            ))}
          </div>

          {/* Architecture sub-tabs */}
          <div className="flex gap-2">
            {([
              { key: "amd64" as const, label: "AMD64" },
              { key: "arm64" as const, label: "ARM" },
            ]).map((a) => (
              <button
                key={a.key}
                onClick={() => setDepotArch(a.key)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  depotArch === a.key ? "bg-accent-blue/20 border-accent-blue text-accent-blue" : "border-surface-600 text-text-400 hover:text-text-200"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          {/* Fixed-height viewport (~5 rows) so the modal never resizes on tab switch */}
          <div className="h-[360px] overflow-y-auto space-y-2 pr-1">
            {depotError ? (
              <div className="rounded-md bg-red-900/30 border border-red-700 px-3 py-2 text-sm text-red-300">
                {depotError instanceof Error ? depotError.message : t("templates.depotError", "Depot unreachable")}
              </div>
            ) : depotLoading && depotItems.length === 0 ? (
              <div className="card p-6 text-center text-sm text-text-400">{t("msg.loading", "Loading…")}</div>
            ) : depotItems.length === 0 ? (
              <div className="card p-6 text-center text-sm text-text-400">{t("templates.depotEmpty", "Nothing available for this type")}</div>
            ) : (
              depotItems.map((item) => {
                const prog = progressByDepotId.get(item.id);
                const downloading = !!prog && prog.status !== "completed" && prog.status !== "failed";
                const failed = prog?.status === "failed";
                return (
                  <div key={item.id} className="card p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-text-200 font-medium truncate">{item.name}</div>
                      <div className="text-xs text-text-500 truncate">
                        {item.arch}
                        {item.cpu ? ` · ${item.cpu} vCPU` : ""}
                        {item.memory ? ` · ${item.memory} MB` : ""}
                        {item.sizeLabel ? ` · ${item.sizeLabel}` : item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}
                      </div>
                      {downloading ? (
                        <div className="mt-2">
                          <div className="flex justify-between text-xs text-text-400 mb-1">
                            <span>{t("templates.downloading", "Downloading…")}</span>
                            <span className="font-mono">{prog!.percent}%</span>
                          </div>
                          <div className="w-full bg-surface-700 rounded-full h-1.5 overflow-hidden">
                            <div className="bg-accent-blue h-1.5 rounded-full transition-all" style={{ width: `${Math.max(2, Math.min(prog!.percent, 100))}%` }} />
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs font-mono text-text-500 truncate">{item.filename}</div>
                      )}
                      {failed && <div className="text-xs text-red-400 mt-1">{prog?.error ?? t("templates.downloadFailed", "Download failed")}</div>}
                    </div>
                    {item.alreadyImported ? (
                      <span className="shrink-0 text-xs px-3 py-1.5 rounded-full bg-green-900/20 text-green-400 cursor-default">
                        {t("templates.available", "Available")}
                      </span>
                    ) : (
                      <button
                        onClick={() => importMutation.mutate(item)}
                        disabled={downloading || importMutation.isPending}
                        className="btn shrink-0"
                      >
                        {downloading ? `${prog!.percent}%` : failed ? t("action.retry", "Retry") : t("templates.download", "Download")}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title={t("templates.deleteTitle", "Delete template")}
        message={deleteTarget ? t("templates.deleteMessage", { name: deleteTarget.name, defaultValue: `Delete "${deleteTarget.name}" and its files? This cannot be undone.` }) : ""}
        confirmLabel={t("action.delete", "Delete")}
        danger
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}

function EditTemplateForm({
  template,
  saving,
  error,
  onSave,
  onCancel,
  t,
}: {
  template: TemplateSummary;
  saving: boolean;
  error: string | null;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [visibility, setVisibility] = useState(template.visibility);
  const [arch, setArch] = useState(template.architecture);
  const [tags, setTags] = useState((template.tags ?? []).join(", "));

  const submit = () => {
    const body: Record<string, unknown> = {
      name,
      description,
      visibility,
      arch,
      tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
    };
    onSave(body);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="label">{t("storage.name", "Name")}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label">{t("storage.description", "Description")}</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("storage.visibility", "Visibility")}</label>
          <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "restricted")}>
            <option value="restricted">{t("storage.private", "Restricted")}</option>
            <option value="public">{t("storage.public", "Public")}</option>
          </select>
        </div>
        <div>
          <label className="label">{t("templates.arch", "Arch")}</label>
          <select className="input" value={arch} onChange={(e) => setArch(e.target.value as "amd64" | "arm64")}>
            <option value="amd64">amd64</option>
            <option value="arm64">arm64</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">{t("templates.tags", "Tags (comma-separated)")}</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="debian, server" />
      </div>
      {error && <div className="rounded-md bg-red-900/30 border border-red-700 px-3 py-2 text-sm text-red-300">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button onClick={submit} disabled={saving} className="btn-primary">{saving ? t("msg.loading", "Saving…") : t("action.save", "Save")}</button>
        <button onClick={onCancel} className="btn">{t("action.cancel", "Cancel")}</button>
      </div>
    </div>
  );
}
