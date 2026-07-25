import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiDelete, apiGet, apiPost, apiUpload } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { formatBytes } from "../../utils/formatBytes";
import { useAuth } from "../../utils/useAuth";
import type { DatacenterStorageEntry, DockerHubDetail, DockerImage, DockerRegistryImage, IsoFile, LxcTemplate, StoragePool, TaskProgress } from "@auxinux/shared";

type FileType = "iso" | "lxc_template" | "docker_image" | "vm_disk";

const TYPE_LABELS: Record<FileType, string> = {
  iso: "ISO",
  lxc_template: "LXC Template",
  docker_image: "Docker Image Archive",
  vm_disk: "VM Disk Image",
};

const TYPE_ICONS: Record<FileType, string> = {
  iso: "💿",
  lxc_template: "📦",
  docker_image: "🐳",
  vm_disk: "💾",
};

interface LocalUploadProgress {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
}

interface ActiveTask {
  id: string;
  kind: TaskProgress["kind"];
  label: string;
  handled?: boolean;
}

function ProgressBar({
  percent,
  colorClass = "bg-accent-blue",
}: {
  percent: number;
  colorClass?: string;
}) {
  return (
    <div className="w-full bg-surface-700 rounded-full h-2 overflow-hidden">
      <div className={`${colorClass} h-2 rounded-full transition-all`} style={{ width: `${Math.max(0, Math.min(percent, 100))}%` }} />
    </div>
  );
}

function ManagedFilesTable({
  files,
  onDelete,
  onToggleVisibility,
  canDelete,
  canManageVisibility,
  t,
}: {
  files: IsoFile[];
  onDelete: (file: IsoFile) => void;
  onToggleVisibility: (file: IsoFile) => void;
  canDelete: boolean;
  canManageVisibility: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (files.length === 0) {
    return (
      <div className="card p-6 text-center text-sm text-text-400">
        {t("storage.noUploadedFiles")}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-600">
            <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.name")}</th>
            <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.filename")}</th>
            <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.size")}</th>
            <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.pool")}</th>
            <th className="px-4 py-3 text-left text-text-400 font-medium">{t("storage.visibility")}</th>
            <th className="px-4 py-3 text-right text-text-400 font-medium">{t("storage.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={`${file.type}:${file.filename}`} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
              <td className="px-4 py-3 text-text-200 font-medium">
                {TYPE_ICONS[file.type]} {file.displayName || file.filename}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-400">{file.filename}</td>
              <td className="px-4 py-3 font-mono text-text-300">{file.sizeBytes ? formatBytes(file.sizeBytes) : "—"}</td>
              <td className="px-4 py-3 text-text-400">{file.storagePool || "local"}</td>
              <td className="px-4 py-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  file.isPublic ? "bg-green-900/20 text-green-400" : "bg-surface-700 text-text-400"
                }`}>
                  {file.isPublic
                    ? t("storage.public")
                    : `${t("storage.private")}${file.ownerUsername ? ` · ${file.ownerUsername}` : ""}`}
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-2">
                  {canManageVisibility && (
                    <button
                      onClick={() => onToggleVisibility(file)}
                      className="p-1.5 rounded text-text-400 hover:bg-surface-700 transition-colors"
                      title={file.isPublic ? "Make Private" : "Make Public"}
                    >
                      {file.isPublic ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V7a4 4 0 10-8 0v3m-1 0h10a2 2 0 012 2v5a2 2 0 01-2 2H4a2 2 0 01-2-2v-5a2 2 0 012-2z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-7 4h8a2 2 0 012 2v5a2 2 0 01-2 2H9a2 2 0 01-2-2v-5a2 2 0 012-2z" />
                        </svg>
                      )}
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => onDelete(file)}
                      className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                      title={t("action.delete")}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatPullCount(pulls: number): string {
  if (pulls >= 1_000_000_000) return `${(pulls / 1_000_000_000).toFixed(1)}B pulls`;
  if (pulls >= 1_000_000) return `${(pulls / 1_000_000).toFixed(1)}M pulls`;
  if (pulls >= 1_000) return `${(pulls / 1_000).toFixed(0)}K pulls`;
  return `${pulls} pulls`;
}

function DockerHubCard({
  image,
  canUpload,
  isPulling,
  onPull,
  navigate,
  t,
}: {
  image: DockerRegistryImage;
  canUpload: boolean;
  isPulling: boolean;
  onPull: (name: string) => void;
  navigate: (path: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [showDetail, setShowDetail] = useState(false);

  const { data: detail, isFetching: loadingDetail } = useQuery<DockerHubDetail>({
    queryKey: ["docker", "hub-detail", image.name],
    queryFn: () => apiGet<DockerHubDetail>(`/api/docker/hub-detail?image=${encodeURIComponent(image.name)}`),
    enabled: showDetail,
    staleTime: 15 * 60_000,
    retry: false,
  });

  const handleCreate = () => {
    const portsParam = detail?.exposedPorts?.length
      ? `&ports=${encodeURIComponent(detail.exposedPorts.join(","))}`
      : "";
    navigate(`/docker/create?image=${encodeURIComponent(image.name)}${portsParam}`);
  };

  return (
    <div className="card p-5 space-y-3">
      {/* Header: name + stars + pulls */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-text-100 font-semibold truncate">{image.name}</div>
          <div className="text-sm text-text-400 mt-1 min-h-[2.5rem] line-clamp-3">
            {image.description || t("storage.noDescription")}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-xs text-amber-300 whitespace-nowrap">★ {image.stars.toLocaleString()}</div>
          {(image.pulls ?? 0) > 0 && (
            <div className="text-xs text-text-500 mt-0.5">{formatPullCount(image.pulls!)}</div>
          )}
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-2 text-xs">
        {image.isOfficial && <span className="px-2 py-1 rounded bg-blue-900/20 text-blue-300">{t("storage.official")}</span>}
        {image.isAutomated && <span className="px-2 py-1 rounded bg-green-900/20 text-green-400">{t("storage.automated")}</span>}
        {!image.isOfficial && !image.isAutomated && <span className="px-2 py-1 rounded bg-surface-700 text-text-400">{t("storage.community")}</span>}
      </div>

      {/* Exposed ports — lazy loaded on demand */}
      <div className="text-xs">
        {!showDetail ? (
          <button
            onClick={() => setShowDetail(true)}
            className="text-accent-blue hover:text-accent-blue-light underline underline-offset-2"
          >
            {t("storage.showPorts")}
          </button>
        ) : loadingDetail ? (
          <span className="text-text-500 italic">{t("storage.loadingPorts")}</span>
        ) : detail && detail.exposedPorts.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-text-500 mr-1">{t("storage.exposedPorts")}:</span>
            {detail.exposedPorts.map((p) => (
              <span key={p} className="px-1.5 py-0.5 rounded bg-surface-600 text-text-200 font-mono">{p}</span>
            ))}
          </div>
        ) : (
          <span className="text-text-500">{t("storage.noExposedPorts")}</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {canUpload && (
          <button onClick={() => onPull(image.name)} disabled={isPulling} className="btn">
            {isPulling ? t("storage.downloading") : t("action.pullImage")}
          </button>
        )}
        <button onClick={handleCreate} className="btn-primary">
          {t("action.newContainer")}
        </button>
      </div>
    </div>
  );
}

export default function IsoManager() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { capabilities, isAdmin } = useAuth();

  const [tab, setTab] = useState<FileType>("iso");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IsoFile | null>(null);
  const [uploadProgress, setUploadProgress] = useState<LocalUploadProgress | null>(null);
  const [uploadMoving, setUploadMoving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [selectedPool, setSelectedPool] = useState("");
  const [lxcSearch, setLxcSearch] = useState("");
  const [dockerHubSearch, setDockerHubSearch] = useState("");
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);

  const canUploadFiles = isAdmin || !!capabilities?.limits.allowIsoUpload || !!capabilities?.limits.allowStorageManage;
  const canDeleteFiles = isAdmin || !!capabilities?.limits.allowIsoDelete || !!capabilities?.limits.allowStorageManage;
  const canManageExtendedLibrary = isAdmin || !!capabilities?.limits.allowStorageManage;

  const { data: files = [] } = useQuery<IsoFile[]>({
    queryKey: ["storage", "isos"],
    queryFn: () => apiGet<IsoFile[]>("/api/storage/isos"),
    refetchInterval: 10_000,
  });

  const { data: localPools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools"],
    queryFn: () => apiGet<StoragePool[]>("/api/storage/pools"),
    enabled: canUploadFiles,
    staleTime: 30_000,
  });

  const { data: sharedPools = [] } = useQuery<DatacenterStorageEntry[]>({
    queryKey: ["datacenter", "storage", "library"],
    queryFn: () => apiGet<DatacenterStorageEntry[]>("/api/datacenter/storage"),
    enabled: canUploadFiles && !!capabilities?.sections.datacenter,
    staleTime: 30_000,
  });

  const { data: lxcTemplates = [], isLoading: lxcLoading } = useQuery<LxcTemplate[]>({
    queryKey: ["lxc", "templates", "catalog"],
    queryFn: () => apiGet<LxcTemplate[]>("/api/lxc/templates"),
    enabled: tab === "lxc_template",
    staleTime: 5 * 60_000,
  });

  const { data: dockerResults = [], isFetching: dockerSearching } = useQuery<DockerRegistryImage[]>({
    queryKey: ["docker", "search", dockerHubSearch.trim()],
    queryFn: () => apiGet<DockerRegistryImage[]>(`/api/docker/search?q=${encodeURIComponent(dockerHubSearch.trim())}&limit=30`),
    enabled: tab === "docker_image" && dockerHubSearch.trim().length >= 2,
    staleTime: 60_000,
  });

  const { data: dockerImages = [] } = useQuery<DockerImage[]>({
    queryKey: ["docker", "images"],
    queryFn: () => apiGet<DockerImage[]>("/api/docker/images"),
    enabled: tab === "docker_image",
    refetchInterval: 10_000,
  });

  const taskQueries = useQueries({
    queries: activeTasks.map((task) => ({
      queryKey: ["tasks", task.id],
      queryFn: () => apiGet<TaskProgress>(`/api/tasks/${task.id}`),
      refetchInterval: 1_000,
      staleTime: 0,
    })),
  });

  const deleteFile = useMutation({
    mutationFn: (file: IsoFile) =>
      apiDelete(`/api/storage/isos/${encodeURIComponent(file.filename)}?type=${encodeURIComponent(file.type)}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["storage", "isos"] });
    },
  });

  const toggleVisibility = useMutation({
    mutationFn: (file: IsoFile) =>
      apiPost("/api/storage/isos/visibility", {
        filename: file.filename,
        type: file.type,
        isPublic: !file.isPublic,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage", "isos"] });
    },
  });

  const deleteLxcCache = useMutation({
    mutationFn: (template: LxcTemplate) => {
      if (!template.dist || !template.release) {
        throw new Error("Template cache entry is missing dist/release metadata");
      }
      return apiDelete(`/api/lxc/templates/cache/${encodeURIComponent(template.dist)}/${encodeURIComponent(template.release)}`);
    },
    onSuccess: async () => {
      const data = await apiGet<LxcTemplate[]>("/api/lxc/templates?refresh=true");
      qc.setQueryData(["lxc", "templates", "catalog"], data);
    },
  });

  const deleteDockerImage = useMutation({
    mutationFn: (imageId: string) => apiDelete(`/api/docker/images/${encodeURIComponent(imageId)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["docker", "images"] });
    },
  });

  const refreshLxcCatalog = useMutation({
    mutationFn: () => apiGet<LxcTemplate[]>("/api/lxc/templates?refresh=true"),
    onSuccess: (data) => {
      qc.setQueryData(["lxc", "templates", "catalog"], data);
    },
  });

  const cacheLxcTemplate = useMutation({
    mutationFn: (template: { dist: string; release: string; arch?: string; variant?: string }) => apiPost<TaskProgress>("/api/lxc/templates/cache", template),
    onSuccess: (task) => {
      setActiveTasks((current) => current.some((entry) => entry.id === task.id) ? current : [...current, { id: task.id, kind: task.kind, label: task.label }]);
    },
  });

  const pullDockerImage = useMutation({
    mutationFn: (image: string) => apiPost<TaskProgress>("/api/docker/images/pull", { image }),
    onSuccess: (task) => {
      setActiveTasks((current) => current.some((entry) => entry.id === task.id) ? current : [...current, { id: task.id, kind: task.kind, label: task.label }]);
    },
  });

  const downloadFromUrl = useMutation({
    mutationFn: () => apiPost<TaskProgress>("/api/storage/isos/from-url", {
      url: downloadUrl,
      displayName: downloadName || undefined,
      type: tab,
      storagePool: selectedPool || undefined,
    }),
    onSuccess: (task) => {
      setUrlOpen(false);
      setDownloadUrl("");
      setDownloadName("");
      setActiveTasks((current) => current.some((entry) => entry.id === task.id) ? current : [...current, { id: task.id, kind: task.kind, label: task.label }]);
    },
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadMoving(false);
    setUploadProgress({ percent: 0, loadedBytes: 0, totalBytes: file.size });

    const formData = new FormData();
    if (selectedPool) formData.append("storagePool", selectedPool);
    formData.append("type", tab);
    formData.append("file", file);

    try {
      await apiUpload("/api/storage/isos/upload", formData, (progress) => {
        setUploadProgress(progress);
        if (progress.percent >= 99) setUploadMoving(true);
      });
      qc.invalidateQueries({ queryKey: ["storage", "isos"] });
      setUploadOpen(false);
      setUploadProgress(null);
      setUploadMoving(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t("storage.uploadFailed"));
      setUploadProgress(null);
      setUploadMoving(false);
    }
    e.target.value = "";
  };

  const filteredFiles = useMemo(
    () => files.filter((file) => file.type === tab),
    [files, tab],
  );

  const uploadPools = useMemo(() => {
    const mappedLocal = localPools.map((pool) => ({
      name: pool.name,
      label: `${pool.name} · local`,
      content: pool.content,
    }));
    const mappedShared = sharedPools.map((pool) => ({
      name: pool.name,
      label: `${pool.displayName} · ${t("datacenter.availableOnAllNodes")}`,
      content: pool.content ?? [],
    }));
    const seen = new Set<string>();
    return [...mappedShared, ...mappedLocal].filter((pool) => {
      if (seen.has(pool.name)) return false;
      seen.add(pool.name);
      return true;
    });
  }, [localPools, sharedPools, t]);

  const desiredPoolContent = tab === "iso"
    ? "iso"
    : tab === "vm_disk"
      ? "disk"
      : "template";

  const compatibleUploadPools = useMemo(
    () => uploadPools.filter((pool) => pool.content.includes(desiredPoolContent)),
    [desiredPoolContent, uploadPools],
  );

  useEffect(() => {
    if (!compatibleUploadPools.length) {
      setSelectedPool("");
      return;
    }
    if (!selectedPool || !compatibleUploadPools.some((pool) => pool.name === selectedPool)) {
      setSelectedPool(compatibleUploadPools[0].name);
    }
  }, [compatibleUploadPools, selectedPool]);

  const visibleTemplates = useMemo(() => {
    const query = lxcSearch.trim().toLowerCase();
    if (!query) return lxcTemplates;
    return lxcTemplates.filter((template) =>
      [
        template.name,
        template.dist,
        template.release,
        template.arch,
        template.variant,
        template.description,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [lxcSearch, lxcTemplates]);

  const cachedTemplates = useMemo(
    () => lxcTemplates.filter((template) => template.cached),
    [lxcTemplates],
  );

  const remoteTemplateResults = useMemo(() => {
    if (lxcSearch.trim().length === 0) return [];
    return visibleTemplates;
  }, [lxcSearch, visibleTemplates]);

  const localDockerImages = useMemo(
    () => dockerImages.filter((image) => (image.repoTags?.length ?? 0) > 0),
    [dockerImages],
  );

  const tabs: Array<{ key: FileType; label: string; icon: string }> = [
    { key: "iso", label: t("storage.isoType"), icon: "💿" },
    { key: "lxc_template", label: t("storage.lxcTemplateType"), icon: "📦" },
    { key: "vm_disk", label: t("storage.vmDiskType"), icon: "💾" },
    { key: "docker_image", label: `${t("storage.dockerHubSearch")} / ${t("storage.dockerArchiveType")}`, icon: "🐳" },
  ];

  const visibleTabs = useMemo(
    () => tabs.filter((entry) => entry.key === "iso" || canManageExtendedLibrary),
    [canManageExtendedLibrary, tabs],
  );

  const taskStates = useMemo(() => activeTasks.map((task, index) => ({
    task,
    progress: taskQueries[index]?.data,
  })), [activeTasks, taskQueries]);

  useEffect(() => {
    for (const taskState of taskStates) {
      const progress = taskState.progress;
      if (!progress || taskState.task.handled) continue;
      if (progress.status === "completed" || progress.status === "failed") {
          if (progress.status === "completed") {
            if (progress.kind === "url-download") {
              qc.invalidateQueries({ queryKey: ["storage", "isos"] });
            } else if (progress.kind === "docker-pull") {
              qc.invalidateQueries({ queryKey: ["docker", "images"] });
          } else if (progress.kind === "lxc-cache") {
            void apiGet<LxcTemplate[]>("/api/lxc/templates?refresh=true").then((data) => {
              qc.setQueryData(["lxc", "templates", "catalog"], data);
            }).catch(() => undefined);
          }
        }
        setActiveTasks((current) => current.map((entry) => entry.id === taskState.task.id ? { ...entry, handled: true } : entry));
      }
    }
  }, [qc, taskStates]);

  useEffect(() => {
    if (!uploadProgress || uploadProgress.percent < 100) return;
    const timer = window.setTimeout(() => setUploadProgress(null), 3000);
    return () => window.clearTimeout(timer);
  }, [uploadProgress]);

  useEffect(() => {
    if (tab !== "iso" && !canManageExtendedLibrary) {
      setTab("iso");
    }
  }, [canManageExtendedLibrary, tab]);

  const isTemplateTaskActive = (template: LxcTemplate) => activeTasks.some((task) =>
    task.kind === "lxc-cache" && task.label.includes(`${template.dist}:${template.release}:${template.arch}:${template.variant ?? "default"}`)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("storage.libraryTitle")}</h1>
          <p className="text-sm text-text-400 mt-1">
            {t("storage.librarySubtitle")}
          </p>
        </div>
        {canUploadFiles && (
          <div className="flex gap-2">
            <button onClick={() => setUrlOpen(true)} className="btn">
              {t("action.downloadFromUrl")}
            </button>
            <button onClick={() => setUploadOpen(true)} className="btn-primary">
              {t("action.upload")}
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-surface-600 pb-0">
        {visibleTabs.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === entry.key
                ? "border-accent-blue text-accent-blue"
                : "border-transparent text-text-400 hover:text-text-200"
            }`}
          >
            {entry.icon} {entry.label}
          </button>
        ))}
      </div>

      {(uploadProgress || taskStates.length > 0) && (
        <div className="space-y-3">
          {uploadProgress && (
            <div className="card p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-text-200">{t("action.upload")}</div>
                  <div className="text-xs text-text-500">
                    {formatBytes(uploadProgress.loadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                  </div>
                </div>
                <div className="text-sm font-mono text-text-300">{uploadProgress.percent}%</div>
              </div>
              <ProgressBar percent={uploadProgress.percent} />
            </div>
          )}

          {taskStates.map(({ task, progress }) => {
            const status = progress?.status ?? "pending";
            const percent = progress?.progressPercent ?? 0;
            const bytesLine = progress?.bytesTotal
              ? `${formatBytes(progress.bytesCurrent ?? 0)} / ${formatBytes(progress.bytesTotal)}`
              : undefined;
            const colorClass = status === "failed"
              ? "bg-red-500"
              : status === "completed"
                ? "bg-green-500"
                : "bg-accent-blue";

            return (
              <div key={task.id} className="card p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-text-200">{progress?.label ?? task.label}</div>
                    <div className="text-xs text-text-500">
                      {progress?.message ?? t("task.waiting")}{progress?.detail ? ` · ${progress.detail}` : ""}
                    </div>
                    {progress?.error && <div className="text-xs text-red-400 mt-1">{progress.error}</div>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-sm font-mono text-text-300">{percent}%</div>
                    {(status === "completed" || status === "failed") && (
                      <button
                        onClick={() => setActiveTasks((current) => current.filter((entry) => entry.id !== task.id))}
                        className="btn"
                      >
                        {t("action.dismiss")}
                      </button>
                    )}
                  </div>
                </div>
                <ProgressBar percent={percent} colorClass={colorClass} />
                {bytesLine && <div className="text-xs text-text-500">{bytesLine}</div>}
              </div>
            );
          })}
        </div>
      )}

      {tab === "iso" && (
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-200">{t("storage.isoLibrary")}</h2>
            <p className="text-sm text-text-400 mt-1">
              {t("storage.isoLibraryDescription")}
            </p>
          </div>
          <ManagedFilesTable
            files={filteredFiles}
            onDelete={setDeleteTarget}
            onToggleVisibility={(file) => toggleVisibility.mutate(file)}
            canDelete={canDeleteFiles}
            canManageVisibility={isAdmin}
            t={t}
          />
        </div>
      )}

      {tab === "vm_disk" && (
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-200">{t("storage.vmDiskLibrary")}</h2>
            <p className="text-sm text-text-400 mt-1">
              {t("storage.vmDiskLibraryDescription")}
            </p>
          </div>
          <ManagedFilesTable
            files={filteredFiles}
            onDelete={setDeleteTarget}
            onToggleVisibility={(file) => toggleVisibility.mutate(file)}
            canDelete={canDeleteFiles}
            canManageVisibility={isAdmin}
            t={t}
          />
        </div>
      )}

      {tab === "lxc_template" && (
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-text-200">{t("storage.cachedTemplatesTitle")}</h2>
                <p className="text-sm text-text-400 mt-1">{t("storage.cachedTemplatesDescription")}</p>
              </div>
              <span className="text-xs text-text-500">{t("storage.templatesVisible", { count: cachedTemplates.length })}</span>
            </div>

            {cachedTemplates.length === 0 ? (
              <div className="card p-6 text-sm text-text-400">{t("storage.noCachedTemplates")}</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {cachedTemplates.map((template) => (
                  <div key={template.name} className="card p-5 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-text-100 font-semibold">{template.name}</div>
                        <div className="text-sm text-text-400 mt-1">{template.description || t("storage.lxcTemplateType")}</div>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/20 text-green-400">
                        {t("storage.cached")}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {template.dist && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.dist}</span>}
                      {template.release && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.release}</span>}
                      {template.arch && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.arch}</span>}
                      {template.variant && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.variant}</span>}
                    </div>
                    <div className="pt-1">
                      <div className="flex gap-2">
                        <button
                          onClick={() => navigate(`/lxc/create?template=${encodeURIComponent(template.name)}`)}
                          className="btn-primary"
                        >
                          {t("action.useTemplate")}
                        </button>
                        {canDeleteFiles && (
                          <button
                            onClick={() => deleteLxcCache.mutate(template)}
                            disabled={deleteLxcCache.isPending}
                            className="btn"
                            title={t("action.delete")}
                          >
                            {t("action.delete")}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-text-200">{t("storage.remoteCatalog")}</h2>
                <p className="text-sm text-text-400 mt-1">
                  {t("storage.remoteCatalogDescription")}
                </p>
              </div>
              <button onClick={() => refreshLxcCatalog.mutate()} disabled={refreshLxcCatalog.isPending} className="btn">
                {refreshLxcCatalog.isPending ? t("msg.loading") : t("action.refresh")}
              </button>
            </div>
            <input
              className="input"
              value={lxcSearch}
              onChange={(e) => setLxcSearch(e.target.value)}
              placeholder={t("storage.searchTemplatesPlaceholder")}
            />
            <div className="flex items-center justify-between text-xs text-text-500">
              <span>
                {lxcSearch.trim().length >= 1
                  ? t("storage.templatesVisible", { count: remoteTemplateResults.length })
                  : t("storage.remoteSearchHint")}
              </span>
              <span>{t("storage.templatesCachedHint")}</span>
            </div>
          </div>

          {lxcSearch.trim().length === 0 ? (
            <div className="card p-6 text-sm text-text-400">{t("storage.remoteSearchHint")}</div>
          ) : lxcLoading ? (
            <div className="card p-6 text-sm text-text-400">{t("storage.loadingCatalog")}</div>
          ) : remoteTemplateResults.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-4xl mb-3">📦</div>
              <div className="text-text-300">{t("storage.noTemplateMatches")}</div>
              <p className="text-sm text-text-500 mt-1">{t("storage.tryAnotherTemplateSearch")}</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {remoteTemplateResults.map((template) => (
                <div key={template.name} className="card p-5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-text-100 font-semibold">{template.name}</div>
                      <div className="text-sm text-text-400 mt-1">{template.description || t("storage.lxcTemplateType")}</div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      template.cached ? "bg-green-900/20 text-green-400" : "bg-surface-700 text-text-400"
                    }`}>
                      {template.cached ? t("storage.cached") : t("storage.remote")}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {template.dist && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.dist}</span>}
                    {template.release && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.release}</span>}
                    {template.arch && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.arch}</span>}
                    {template.variant && <span className="px-2 py-1 rounded bg-surface-700 text-text-300">{template.variant}</span>}
                  </div>
                  <div className="flex gap-2 pt-1">
                    {canUploadFiles && (
                      <button
                        onClick={() => template.dist && template.release && cacheLxcTemplate.mutate({ dist: template.dist, release: template.release, arch: template.arch, variant: template.variant })}
                        disabled={template.cached || isTemplateTaskActive(template) || cacheLxcTemplate.isPending}
                        className="btn"
                      >
                        {template.cached ? t("storage.cached") : isTemplateTaskActive(template) ? t("storage.downloading") : t("storage.cacheTemplate")}
                      </button>
                    )}
                    <button
                      onClick={() => navigate(`/lxc/create?template=${encodeURIComponent(template.name)}`)}
                      className="btn-primary"
                    >
                      {t("action.useTemplate")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-200">{t("storage.uploadedLxcArchives")}</h2>
              <span className="text-xs text-text-500">{t("storage.uploadedLxcArchivesHint")}</span>
            </div>
            <ManagedFilesTable
              files={filteredFiles}
              onDelete={setDeleteTarget}
              onToggleVisibility={(file) => toggleVisibility.mutate(file)}
              canDelete={canDeleteFiles}
              canManageVisibility={isAdmin}
              t={t}
            />
          </div>
        </div>
      )}

      {tab === "docker_image" && (
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-text-200">{t("storage.localDockerImagesTitle")}</h2>
                <p className="text-sm text-text-400 mt-1">{t("storage.localDockerImagesDescription")}</p>
              </div>
              <span className="text-xs text-text-500">{t("storage.resultsCount", { count: localDockerImages.length })}</span>
            </div>

            {localDockerImages.length === 0 ? (
              <div className="card p-6 text-sm text-text-400">{t("storage.noLocalDockerImages")}</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {localDockerImages.map((image) => {
                  const primaryTag = image.repoTags?.[0] ?? image.id;
                  return (
                    <div key={image.id} className="card p-5 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-text-100 font-semibold break-all">{primaryTag}</div>
                          <div className="text-sm text-text-400 mt-1 font-mono">{image.id.slice(0, 12)}</div>
                        </div>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/20 text-green-400">
                          {t("storage.cached")}
                        </span>
                      </div>
                      {image.repoTags && image.repoTags.length > 1 && (
                        <div className="flex flex-wrap gap-2 text-xs">
                          {image.repoTags.slice(1, 5).map((tag) => (
                            <span key={tag} className="px-2 py-1 rounded bg-surface-700 text-text-300 break-all">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between text-xs text-text-500">
                        <span>{formatBytes(image.size)}</span>
                        <span>{image.repoTags?.length ?? 0} tag(s)</span>
                      </div>
                      <div className="pt-1">
                        <div className="flex gap-2">
                          <button
                            onClick={() => navigate(`/docker/create?image=${encodeURIComponent(primaryTag)}`)}
                            className="btn-primary"
                          >
                            {t("action.newContainer")}
                          </button>
                          {canDeleteFiles && (
                            <button
                              onClick={() => deleteDockerImage.mutate(image.id)}
                              disabled={deleteDockerImage.isPending}
                              className="btn"
                              title={t("action.delete")}
                            >
                              {t("action.delete")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-text-200">{t("storage.dockerHubSearch")}</h2>
              <p className="text-sm text-text-400 mt-1">
                {t("storage.dockerHubDescription")}
              </p>
            </div>
            <input
              className="input"
              value={dockerHubSearch}
              onChange={(e) => setDockerHubSearch(e.target.value)}
              placeholder={t("storage.searchDockerPlaceholder")}
            />
            <div className="text-xs text-text-500">
              {dockerHubSearch.trim().length < 2 ? t("storage.searchHint") : dockerSearching ? t("storage.searching") : t("storage.resultsCount", { count: dockerResults.length })}
            </div>
          </div>

          {dockerHubSearch.trim().length >= 2 && dockerResults.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {dockerResults.map((image) => (
                <DockerHubCard
                  key={image.name}
                  image={image}
                  canUpload={canUploadFiles}
                  isPulling={pullDockerImage.isPending && pullDockerImage.variables === image.name}
                  onPull={(name) => pullDockerImage.mutate(name)}
                  navigate={navigate}
                  t={t}
                />
              ))}
            </div>
          )}

          {dockerHubSearch.trim().length >= 2 && !dockerSearching && dockerResults.length === 0 && (
            <div className="card p-8 text-center">
              <div className="text-4xl mb-3">🐳</div>
              <div className="text-text-300">{t("storage.noDockerImageFound")}</div>
              <p className="text-sm text-text-500 mt-1">{t("storage.tryBroaderSearch")}</p>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-200">{t("storage.uploadedDockerArchives")}</h2>
              <span className="text-xs text-text-500">{t("storage.uploadedDockerArchivesHint")}</span>
            </div>
            <ManagedFilesTable
              files={filteredFiles}
              onDelete={setDeleteTarget}
              onToggleVisibility={(file) => toggleVisibility.mutate(file)}
              canDelete={canDeleteFiles}
              canManageVisibility={isAdmin}
              t={t}
            />
          </div>
        </div>
      )}

      <Modal open={uploadOpen} title={t("storage.uploadTitle", { type: TYPE_LABELS[tab] })} onClose={() => { setUploadOpen(false); setUploadError(null); setUploadMoving(false); setUploadProgress(null); }}>
        <div className="space-y-4">
          <p className="text-sm text-text-400">
            {t("storage.maxFileSize")}
          </p>
          <div>
            <label className="label">{t("storage.pool")}</label>
            <select className="input" value={selectedPool} onChange={(e) => setSelectedPool(e.target.value)}>
              {compatibleUploadPools.map((pool) => (
                <option key={pool.name} value={pool.name}>{pool.label}</option>
              ))}
            </select>
          </div>
          <div
            className="border-2 border-dashed border-surface-500 rounded-lg p-8 text-center cursor-pointer hover:border-accent-blue transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <div className="text-3xl mb-2">{TYPE_ICONS[tab]}</div>
            <div className="text-text-300">{t("storage.selectFile")}</div>
            <div className="text-xs text-text-500 mt-1">
              {tab === "iso" && "*.iso, *.img"}
              {tab === "vm_disk" && "*.qcow2, *.img, *.raw, *.vmdk, *.vhd, *.vhdx"}
              {tab === "lxc_template" && "*.tar.gz, *.tar.xz, *.tar.zst, *.tar"}
              {tab === "docker_image" && "*.tar"}
            </div>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept={
                tab === "iso"
                  ? ".iso,.img"
                  : tab === "vm_disk"
                    ? ".qcow2,.img,.raw,.vmdk,.vhd,.vhdx"
                    : tab === "lxc_template"
                      ? ".tar.gz,.tar.xz,.tar.zst,.tar"
                      : ".tar"
              }
              onChange={handleUpload}
            />
          </div>
          {uploadError && (
            <div className="rounded-md bg-red-900/30 border border-red-700 px-3 py-2 text-sm text-red-300">
              {uploadError}
            </div>
          )}
          {uploadMoving && !uploadError && (
            <div className="text-xs text-text-400 text-center animate-pulse">
              {t("storage.movingToPool")}
            </div>
          )}
          {uploadProgress && uploadProgress.percent > 0 && uploadProgress.percent < 100 && (
            <div>
              <div className="flex justify-between text-xs text-text-400 mb-1">
                <span>{t("storage.uploading")}</span>
                <span>{uploadProgress.percent}%</span>
              </div>
              <ProgressBar percent={uploadProgress.percent} />
            </div>
          )}
        </div>
      </Modal>

      <Modal open={urlOpen} title={t("storage.downloadUrlTitle")} onClose={() => setUrlOpen(false)}>
        <div className="space-y-4">
          <div>
            <label className="label">URL *</label>
            <input
              className="input font-mono text-sm"
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder={t("storage.downloadUrlPlaceholder")}
            />
          </div>
          <div>
            <label className="label">{t("storage.filenameOptional")}</label>
            <input
              className="input"
              value={downloadName}
              onChange={(e) => setDownloadName(e.target.value)}
              placeholder={t("storage.displayNamePlaceholder")}
            />
          </div>
          <div>
            <label className="label">{t("storage.fileType")}</label>
            <select className="input" value={tab} onChange={(e) => setTab(e.target.value as FileType)}>
              <option value="iso">{t("storage.isoType")}</option>
              <option value="lxc_template">{t("storage.lxcTemplateType")}</option>
              <option value="vm_disk">{t("storage.vmDiskType")}</option>
              <option value="docker_image">{t("storage.dockerArchiveType")}</option>
            </select>
          </div>
          <div>
            <label className="label">{t("storage.pool")}</label>
            <select className="input" value={selectedPool} onChange={(e) => setSelectedPool(e.target.value)}>
              {compatibleUploadPools.map((pool) => (
                <option key={pool.name} value={pool.name}>{pool.label}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => downloadFromUrl.mutate()}
              disabled={!downloadUrl || downloadFromUrl.isPending || !canUploadFiles}
              className="btn-primary"
            >
              {downloadFromUrl.isPending ? t("storage.downloading") : t("action.download")}
            </button>
            <button onClick={() => setUrlOpen(false)} className="btn">{t("action.cancel")}</button>
          </div>
          {downloadFromUrl.isSuccess && (
            <p className="text-sm text-green-400">{t("storage.downloadCompleted")}</p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title={t("storage.deleteFileTitle")}
        message={deleteTarget ? t("storage.deleteFileMessage", { name: deleteTarget.filename, type: TYPE_LABELS[deleteTarget.type] }) : ""}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && deleteFile.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteFile.isPending}
      />
    </div>
  );
}
