import { listen } from "@tauri-apps/api/event";
import { Archive, Boxes, CheckCircle2, Download, FileArchive, HardDrive, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { localVirtua } from "@/api/localVirtua";
import { StatusBadge } from "@/components/StatusBadge";
import type { LocalDockerImage, LocalStorageFile, LocalStorageInventory, RemoteTemplateItem, VirtuaResource, VmArchitecture } from "@/types";

type StorageTab = "iso" | "templates" | "disks" | "snapshots" | "docker" | "depot";
type DeletableStorageKind = "iso" | "template" | "disk" | "snapshot";

interface DownloadProgressEvent {
  id: string;
  name: string;
  received: number;
  total?: number | null;
  progress?: number | null;
  status: "downloading" | "extracting" | "completed" | string;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "n/a";
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp * 1000).toLocaleString();
  return value;
}

function isStopped(state: string) {
  return ["stopped", "stop", "inactive", "shutoff", "shut off", "down", "exited"].includes(state.toLowerCase());
}

function isDiskUsed(file: LocalStorageFile, resources: VirtuaResource[]) {
  return resources.some((resource) => resource.source === "local" && resource.image !== file.path && resource.id && file.name.includes(resource.id.replace("local-vm-", "")));
}

function remoteItemExists(item: RemoteTemplateItem, inventory: LocalStorageInventory | null) {
  const localFiles = item.category === "ISO" ? inventory?.iso : inventory?.templates;
  return Boolean(localFiles?.some((file) => file.name === item.name));
}

function progressLabel(progress: DownloadProgressEvent) {
  if (progress.status === "extracting") return "Extraction du template...";
  if (typeof progress.progress === "number") return `${Math.round(progress.progress)}%`;
  if (progress.received > 0) return `${formatBytes(progress.received)} telecharges`;
  return "Preparation...";
}

function FilesTable({
  files,
  kind,
  resources,
  onDelete,
  pending,
}: {
  files: LocalStorageFile[];
  kind: DeletableStorageKind;
  resources: VirtuaResource[];
  onDelete: (kind: DeletableStorageKind, file: LocalStorageFile) => void;
  pending: string | null;
}) {
  return (
    <div className="overflow-hidden rounded border border-virtua-border bg-black/10">
      <div className="grid grid-cols-[1fr_7rem_10rem_7rem] items-center gap-3 border-b border-virtua-border px-3 py-2 text-xs uppercase tracking-wide text-virtua-muted">
        <span>Nom</span>
        <span>Taille</span>
        <span>Modifie</span>
        <span className="text-right">Actions</span>
      </div>
      <div className="max-h-[34rem] overflow-auto divide-y divide-virtua-border">
        {files.map((file) => {
          const diskUsed = kind === "disk" && isDiskUsed(file, resources);
          return (
            <div key={file.path} className="grid grid-cols-[1fr_7rem_10rem_7rem] items-center gap-3 px-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{file.name}</p>
                <p className="truncate text-xs text-virtua-muted">{file.path}</p>
                {diskUsed ? <p className="mt-1 text-xs text-virtua-yellow">Utilise par une VM</p> : null}
              </div>
              <span className="text-xs text-virtua-muted">{formatBytes(file.size)}</span>
              <span className="text-xs text-virtua-muted">{formatDate(file.modifiedAt)}</span>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="virtua-button h-8 px-2 text-virtua-red"
                  disabled={pending === file.path || diskUsed}
                  onClick={() => onDelete(kind, file)}
                  title={diskUsed ? "Disque utilise par une VM" : "Supprimer"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
        {files.length === 0 ? <div className="px-3 py-12 text-center text-sm text-virtua-muted">Aucun fichier.</div> : null}
      </div>
    </div>
  );
}

function DockerTable({ images }: { images: LocalDockerImage[] }) {
  return (
    <div className="overflow-hidden rounded border border-virtua-border bg-black/10">
      <div className="grid grid-cols-[1fr_10rem_8rem] items-center gap-3 border-b border-virtua-border px-3 py-2 text-xs uppercase tracking-wide text-virtua-muted">
        <span>Image</span>
        <span>ID</span>
        <span>Taille</span>
      </div>
      <div className="max-h-[34rem] overflow-auto divide-y divide-virtua-border">
        {images.map((image) => (
          <div key={`${image.repository}:${image.tag}:${image.imageId}`} className="grid grid-cols-[1fr_10rem_8rem] items-center gap-3 px-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{image.repository}:{image.tag}</p>
            </div>
            <span className="truncate font-mono text-xs text-virtua-muted">{image.imageId}</span>
            <span className="text-xs text-virtua-muted">{image.size}</span>
          </div>
        ))}
        {images.length === 0 ? <div className="px-3 py-12 text-center text-sm text-virtua-muted">Aucune image Docker.</div> : null}
      </div>
    </div>
  );
}

export function StoragePage({ resources, hostArch, onChanged }: { resources: VirtuaResource[]; hostArch?: string | null; onChanged?: () => void | Promise<void> }) {
  const [inventory, setInventory] = useState<LocalStorageInventory | null>(null);
  const [activeTab, setActiveTab] = useState<StorageTab>("iso");
  const [category, setCategory] = useState<"ISO" | "VM">("ISO");
  const [architecture, setArchitecture] = useState<VmArchitecture>((hostArch === "amd64" ? "amd64" : "arm64"));
  const [remoteItems, setRemoteItems] = useState<RemoteTemplateItem[]>([]);
  const [query, setQuery] = useState("");
  const [selectedVmId, setSelectedVmId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgressEvent>>({});
  const [downloadedRemoteUrls, setDownloadedRemoteUrls] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const stoppedVms = resources.filter((resource) => resource.kind === "vm" && isStopped(resource.state));
  const filteredRemote = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return remoteItems;
    return remoteItems.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [query, remoteItems]);

  const tabs = [
    { id: "iso" as const, label: "ISO", count: inventory?.iso.length ?? 0 },
    { id: "templates" as const, label: "Templates", count: inventory?.templates.length ?? 0 },
    { id: "disks" as const, label: "Disques", count: inventory?.disks.length ?? 0 },
    { id: "snapshots" as const, label: "Snapshots", count: inventory?.snapshots.length ?? 0 },
    { id: "docker" as const, label: "Docker", count: inventory?.dockerImages.length ?? 0 },
    { id: "depot" as const, label: "Depot", count: remoteItems.length },
  ];

  const refreshInventory = async () => {
    setError(null);
    const nextInventory = await localVirtua.storageInventory();
    setInventory(nextInventory);
    return nextInventory;
  };

  const refreshRemote = async () => {
    setPending("remote");
    setError(null);
    try {
      const nextRemoteItems = await localVirtua.listRemoteTemplates(category, architecture);
      setRemoteItems(nextRemoteItems);
      return nextRemoteItems;
    } catch (err) {
      setRemoteItems([]);
      setError(err instanceof Error ? err.message : "Depot template inaccessible");
      return [];
    } finally {
      setPending(null);
    }
  };

  const refreshAll = async () => {
    const nextInventory = await refreshInventory();
    if (activeTab === "depot") {
      await refreshRemote();
    }
    return nextInventory;
  };

  useEffect(() => {
    void refreshInventory();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<DownloadProgressEvent>("local-download-progress", (event) => {
      setDownloadProgress((current) => ({
        ...current,
        [event.payload.id]: event.payload,
      }));
    }).then((handler) => {
      unlisten = handler;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void refreshRemote();
  }, [category, architecture]);

  useEffect(() => {
    if (!inventory || remoteItems.length === 0) return;
    setDownloadedRemoteUrls((current) => {
      const next = new Set<string>();
      for (const item of remoteItems) {
        if (current.has(item.url) && remoteItemExists(item, inventory)) {
          next.add(item.url);
        }
      }
      return next;
    });
  }, [inventory, remoteItems]);

  const download = async (item: RemoteTemplateItem) => {
    setPending(item.url);
    setError(null);
    setInfo(null);
    setDownloadProgress((current) => ({
      ...current,
      [item.url]: {
        id: item.url,
        name: item.name,
        received: 0,
        total: null,
        progress: 0,
        status: "downloading",
      },
    }));
    try {
      const vm = await localVirtua.downloadTemplate(item);
      const nextInventory = await refreshInventory();
      if (activeTab === "depot") {
        await refreshRemote();
      }
      await onChanged?.();
      if (remoteItemExists(item, nextInventory)) {
        setDownloadedRemoteUrls((current) => {
          const next = new Set(current);
          next.add(item.url);
          return next;
        });
      }
      setInfo(vm ? `VM creee depuis le template: ${vm.name}` : `ISO telechargee: ${item.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Telechargement impossible");
    } finally {
      setPending(null);
      window.setTimeout(() => {
        setDownloadProgress((current) => {
          const next = { ...current };
          delete next[item.url];
          return next;
        });
      }, 1800);
    }
  };

  const exportTemplate = async () => {
    if (!selectedVmId || !templateName.trim()) return;
    setPending("export");
    setError(null);
    setInfo(null);
    try {
      const file = await localVirtua.exportVmTemplate(selectedVmId, templateName.trim(), templateDescription.trim() || undefined);
      await refreshInventory();
      setActiveTab("templates");
      setTemplateDescription("");
      setInfo(`Template cree: ${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export template impossible");
    } finally {
      setPending(null);
    }
  };

  const deleteFile = async (kind: DeletableStorageKind, file: LocalStorageFile) => {
    const confirmed = window.confirm(`Supprimer ${file.name}?`);
    if (!confirmed) return;
    setPending(file.path);
    setError(null);
    setInfo(null);
    try {
      await localVirtua.deleteStorageFile(kind, file.path);
      const nextInventory = await refreshInventory();
      if (activeTab === "depot") {
        await refreshRemote();
      }
      setDownloadedRemoteUrls((current) => {
        const next = new Set<string>();
        for (const item of remoteItems) {
          if (current.has(item.url) && remoteItemExists(item, nextInventory)) {
            next.add(item.url);
          }
        }
        return next;
      });
      setInfo(`${file.name} supprime`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setPending(null);
    }
  };

  const renderTab = () => {
    if (activeTab === "iso") return <FilesTable files={inventory?.iso ?? []} kind="iso" resources={resources} onDelete={deleteFile} pending={pending} />;
    if (activeTab === "templates") {
      return (
        <div className="space-y-4">
          <FilesTable files={inventory?.templates ?? []} kind="template" resources={resources} onDelete={deleteFile} pending={pending} />
          <div className="rounded border border-virtua-border bg-black/10 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Archive className="h-4 w-4 text-virtua-accent" />
              <h3 className="text-sm font-semibold">Creer un template depuis une VM arretee</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <select className="virtua-input" value={selectedVmId} onChange={(event) => setSelectedVmId(event.target.value)}>
                <option value="">Choisir une VM</option>
                {stoppedVms.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
              <input className="virtua-input" placeholder="Nom_Du_Template" value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
              <button disabled={!selectedVmId || !templateName.trim() || pending === "export"} onClick={() => void exportTemplate()} className="virtua-button-primary">
                <Save className="mr-2 h-4 w-4" />
                Exporter
              </button>
              <textarea
                className="virtua-input min-h-20 md:col-span-3"
                placeholder="Description du template"
                value={templateDescription}
                onChange={(event) => setTemplateDescription(event.target.value)}
              />
            </div>
            <p className="mt-2 text-xs text-virtua-muted">Genere config.virtua + disque + metadata JSON dans Templates.</p>
          </div>
        </div>
      );
    }
    if (activeTab === "disks") return <FilesTable files={inventory?.disks ?? []} kind="disk" resources={resources} onDelete={deleteFile} pending={pending} />;
    if (activeTab === "snapshots") return <FilesTable files={inventory?.snapshots ?? []} kind="snapshot" resources={resources} onDelete={deleteFile} pending={pending} />;
    if (activeTab === "docker") return <DockerTable images={inventory?.dockerImages ?? []} />;
    return (
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <div className="rounded border border-virtua-border bg-black/10 p-4">
          <div className="mb-4 flex items-center gap-2">
            <FileArchive className="h-4 w-4 text-virtua-accent" />
            <h2 className="text-sm font-semibold">Depot AuxiNux Templates</h2>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className="virtua-input" value={category} onChange={(event) => setCategory(event.target.value as "ISO" | "VM")}>
              <option value="ISO">ISO</option>
              <option value="VM">Template VM</option>
            </select>
            <select className="virtua-input" value={architecture} onChange={(event) => setArchitecture(event.target.value as VmArchitecture)}>
              <option value="arm64">ARM</option>
              <option value="amd64">AMD64</option>
            </select>
          </div>
          <label className="mt-3 flex h-10 items-center gap-2 rounded border border-virtua-border bg-black/20 px-3">
            <Search className="h-4 w-4 text-virtua-muted" />
            <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-virtua-muted" placeholder="Rechercher" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button onClick={() => void refreshRemote()} disabled={pending === "remote"} className="virtua-button mt-3 w-full justify-center">
            <RefreshCw className="mr-2 h-4 w-4" />
            Lire le depot
          </button>
        </div>

        <div className="max-h-[38rem] overflow-auto divide-y divide-virtua-border rounded border border-virtua-border bg-black/10">
          {filteredRemote.map((item) => {
            const isLocal = downloadedRemoteUrls.has(item.url) || remoteItemExists(item, inventory);
            const progress = downloadProgress[item.url];
            const progressValue = typeof progress?.progress === "number" ? progress.progress : progress ? 8 : 0;
            return (
              <div key={item.url} className="grid gap-3 p-3 md:grid-cols-[1fr_11rem] md:items-center">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{item.displayName || item.name}</p>
                    <StatusBadge status={item.category} />
                  </div>
                  <p className="text-xs text-virtua-muted">{item.category} / {item.architecture} / {item.size ?? "taille inconnue"}{item.displayName ? ` / ${item.name}` : ""}</p>
                  {item.description ? <p className="mt-1 max-w-3xl text-sm text-virtua-muted">{item.description}</p> : null}
                  {item.category === "VM" && (item.cpu || item.ram || item.disk) ? (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {item.cpu ? <span className="rounded border border-virtua-border bg-black/20 px-2 py-1 text-virtua-muted">CPU {item.cpu}</span> : null}
                      {item.ram ? <span className="rounded border border-virtua-border bg-black/20 px-2 py-1 text-virtua-muted">RAM {item.ram} MiB</span> : null}
                      {item.disk ? <span className="max-w-xs truncate rounded border border-virtua-border bg-black/20 px-2 py-1 text-virtua-muted">DISK {item.disk}</span> : null}
                      <span className="rounded border border-virtua-border bg-black/20 px-2 py-1 text-virtua-muted">ARCH {item.architecture}</span>
                    </div>
                  ) : null}
                  {progress ? (
                    <div className="mt-2 max-w-lg">
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs text-virtua-muted">
                        <span>{progressLabel(progress)}</span>
                        <span>{progress.total ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}` : formatBytes(progress.received)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded bg-black/40">
                        <div className="h-full rounded bg-virtua-accent transition-all" style={{ width: `${Math.max(4, Math.min(100, progressValue))}%` }} />
                      </div>
                    </div>
                  ) : null}
                </div>
                {isLocal ? (
                  <div className="inline-flex h-9 items-center justify-center rounded border border-virtua-green/40 bg-virtua-green/15 px-3 text-xs text-virtua-green">
                    <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                    Deja local
                  </div>
                ) : (
                  <button disabled={pending === item.url} onClick={() => void download(item)} className="virtua-button-primary h-9 justify-center text-xs">
                    <Download className="mr-2 h-3.5 w-3.5" />
                    {pending === item.url ? "Telechargement" : item.category === "ISO" ? "Telecharger ISO" : "Importer template"}
                  </button>
                )}
              </div>
            );
          })}
          {filteredRemote.length === 0 ? (
            <div className="px-3 py-12 text-center text-sm text-virtua-muted">
              {pending === "remote" ? "Lecture du depot..." : "Aucun fichier disponible."}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Storage</h1>
          <p className="mt-1 text-sm text-virtua-muted">Gestion locale des ISO, templates, disques, snapshots et images Docker.</p>
        </div>
        <button onClick={() => void refreshAll()} className="virtua-button">
          <RefreshCw className="mr-2 h-4 w-4" />
          Actualiser
        </button>
      </div>

      {error ? <div className="rounded border border-virtua-red/50 bg-virtua-red/15 px-3 py-2 text-sm text-virtua-red">{error}</div> : null}
      {info ? <div className="rounded border border-virtua-accent/40 bg-virtua-accentSoft/40 px-3 py-2 text-sm text-virtua-text">{info}</div> : null}

      <section className="rounded border border-virtua-border bg-virtua-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-virtua-border p-3">
          <HardDrive className="h-4 w-4 text-virtua-accent" />
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex h-9 items-center gap-2 rounded px-3 text-sm ${activeTab === tab.id ? "bg-virtua-accent text-white" : "bg-black/20 text-virtua-muted hover:text-virtua-text"}`}
            >
              {tab.label}
              <span className="rounded bg-black/25 px-1.5 py-0.5 text-[11px]">{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="p-4">
          {activeTab === "docker" ? <div className="mb-3 flex items-center gap-2 text-sm text-virtua-muted"><Boxes className="h-4 w-4" /> Images locales detectees par Docker.</div> : null}
          {renderTab()}
        </div>
      </section>
    </div>
  );
}
