import { open } from "@tauri-apps/plugin-dialog";
import { Boxes, Camera, Container, Edit3, Monitor, RotateCcw, Save, Terminal, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { virtuaClient } from "@/api/virtuaClient";
import { localVirtua } from "@/api/localVirtua";
import { MetricBar } from "@/components/MetricBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { LocalSnapshot, LocalStorageFile, ResourceKind, VirtuaResource, VirtuaUser } from "@/types";

const icons: Record<ResourceKind, typeof Monitor> = {
  vm: Monitor,
  lxc: Container,
  docker: Boxes,
};

function guestAgentLabel(resource: VirtuaResource) {
  if (resource.kind !== "vm") return "n/a";
  const agent = resource.guestAgent;
  if (!agent) return "inconnu";
  if (agent.running) return "actif";
  if (agent.installed === false) return "non installe";
  if (agent.installed) return agent.status ?? "installe";
  return agent.status ?? "inconnu";
}

function formatSnapshotBytes(bytes: number) {
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

function formatSnapshotDate(value: string) {
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000).toLocaleString();
  }
  return value;
}

function isStoppedState(state: string) {
  return ["stopped", "stop", "inactive", "shutoff", "shut off", "down", "exited"].includes(state.toLowerCase());
}

function formatMemoryMib(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1024) return `${Math.round((value / 1024) * 10) / 10} GiB`;
  return `${value} MiB`;
}

function formatDiskGib(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "n/a";
  return `${value} GiB`;
}

function yesNo(value?: boolean) {
  return value ? "actif" : "inactif";
}

type UpdateResourcePayload = {
  name?: string;
  displayName?: string;
  image?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  network?: string;
  networkModel?: string;
  gpuModel?: string;
  tpm2?: boolean;
  secureBoot?: boolean;
};

export function ResourceDetailPage({
  resources,
  user,
  updateResource = (resourceId, payload) => virtuaClient.updateResource(resourceId, payload),
  deleteResource: deleteResourceAction = (resourceId) => virtuaClient.deleteResource(resourceId),
  listSnapshots,
  createSnapshot,
  deleteSnapshot,
  rollbackSnapshot,
  onChanged,
}: {
  resources: VirtuaResource[];
  user: VirtuaUser | null;
  updateResource?: (resourceId: string, payload: UpdateResourcePayload) => Promise<unknown>;
  deleteResource?: (resourceId: string, deleteDisks?: boolean) => Promise<unknown>;
  listSnapshots?: (resourceId: string) => Promise<LocalSnapshot[]>;
  createSnapshot?: (resourceId: string, name: string) => Promise<LocalSnapshot>;
  deleteSnapshot?: (resourceId: string, snapshotId: string) => Promise<void>;
  rollbackSnapshot?: (resourceId: string, snapshotId: string) => Promise<void>;
  onChanged?: () => void | Promise<void>;
}) {
  const { resourceId } = useParams();
  const navigate = useNavigate();
  const resource = resources.find((item) => item.id === resourceId);
  const [form, setForm] = useState({
    name: resource?.name ?? "",
    displayName: resource?.displayName ?? "",
    image: resource?.image ?? "",
    cpu: resource?.cpuCores ? String(resource.cpuCores) : "",
    memory: resource?.memoryMib ? String(resource.memoryMib) : "",
    disk: resource?.diskGib ? String(resource.diskGib) : "",
    network: resource?.network ?? "user",
    networkModel: resource?.networkModel ?? "virtio",
    gpuModel: resource?.gpuModel ?? "virtio",
    tpm2: Boolean(resource?.tpm2),
    secureBoot: Boolean(resource?.secureBoot),
  });
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteDisks, setDeleteDisks] = useState(false);
  const [localIsoFiles, setLocalIsoFiles] = useState<LocalStorageFile[]>([]);
  const [snapshots, setSnapshots] = useState<LocalSnapshot[]>([]);
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotPending, setSnapshotPending] = useState<string | null>(null);

  useEffect(() => {
    if (!resource) return;
    setForm({
      name: resource.name,
      displayName: resource.displayName,
      image: resource.image ?? "",
      cpu: resource.cpuCores ? String(resource.cpuCores) : "",
      memory: resource.memoryMib ? String(resource.memoryMib) : "",
      disk: resource.diskGib ? String(resource.diskGib) : "",
      network: resource.network ?? "user",
      networkModel: resource.networkModel ?? "virtio",
      gpuModel: resource.gpuModel ?? "virtio",
      tpm2: Boolean(resource.tpm2),
      secureBoot: Boolean(resource.secureBoot),
    });
  }, [resource?.id]);

  useEffect(() => {
    if (resource?.source !== "local") {
      setLocalIsoFiles([]);
      return;
    }
    let isCurrent = true;
    void localVirtua.storageInventory().then((inventory) => {
      if (isCurrent) setLocalIsoFiles(inventory.iso);
    }).catch(() => {
      if (isCurrent) setLocalIsoFiles([]);
    });
    return () => {
      isCurrent = false;
    };
  }, [resource?.id, resource?.source]);

  useEffect(() => {
    if (!resource || !listSnapshots) {
      setSnapshots([]);
      return;
    }
    let isCurrent = true;
    void listSnapshots(resource.id).then((items) => {
      if (isCurrent) setSnapshots(items);
    }).catch(() => {
      if (isCurrent) setSnapshots([]);
    });
    return () => {
      isCurrent = false;
    };
  }, [resource?.id, listSnapshots]);

  if (!resource) {
    return (
      <div className="grid min-h-[28rem] place-items-center rounded border border-virtua-border bg-virtua-panel">
        <div className="text-center">
          <p className="text-sm text-virtua-muted">Machine introuvable ou non accessible.</p>
          <Link to="/inventory" className="mt-3 inline-flex virtua-button">Retour inventaire</Link>
        </div>
      </div>
    );
  }

  const Icon = icons[resource.kind];
  const canModify = user?.role === "ADMIN" || Boolean(resource.permissions.canModify);
  const canDelete = user?.role === "ADMIN" || Boolean(resource.permissions.canDelete);
  const canSnapshot = Boolean(resource.permissions.canSnapshot && listSnapshots && createSnapshot && deleteSnapshot && rollbackSnapshot);
  const snapshotsAllowedNow = isStoppedState(resource.state);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canModify) return;
    setSaving(true);
    setError(null);
    try {
      const nextName = form.name.trim();
      const nextDisplayName = form.displayName.trim();
      const nextImage = form.image.trim();
      const payload: UpdateResourcePayload = {};

      if (nextName && nextName !== resource.name) payload.name = nextName;
      if (nextDisplayName && nextDisplayName !== resource.displayName) payload.displayName = nextDisplayName;
      if (nextImage !== (resource.image ?? "")) payload.image = nextImage;
      if (form.cpu && Number(form.cpu) !== resource.cpuCores) payload.cpu = Number(form.cpu);
      if (form.memory && Number(form.memory) !== resource.memoryMib) payload.memory = Number(form.memory);
      if (form.network !== (resource.network ?? "user")) payload.network = form.network;
      if (form.networkModel !== (resource.networkModel ?? "virtio")) payload.networkModel = form.networkModel;
      if (form.gpuModel !== (resource.gpuModel ?? "virtio")) payload.gpuModel = form.gpuModel;
      if (form.tpm2 !== Boolean(resource.tpm2)) payload.tpm2 = form.tpm2;
      if (form.secureBoot !== Boolean(resource.secureBoot)) payload.secureBoot = form.secureBoot;

      if (Object.keys(payload).length === 0) {
        setError("Aucune modification a sauvegarder");
        return;
      }

      await updateResource(resource.id, payload);
      await onChanged?.();
      setEditing(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Modification impossible";
      setError(message.includes("Renaming an existing resource is not supported")
        ? "Virtua serveur ne supporte pas encore le renommage reel de cette ressource"
        : message);
    } finally {
      setSaving(false);
    }
  };

  const deleteResource = async () => {
    if (!canDelete || isDeleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteResourceAction(resource.id, deleteDisks);
      await onChanged?.();
      navigate("/inventory");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const browseIso = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Selectionner une ISO",
        filters: [{ name: "Images disque", extensions: ["iso", "img"] }],
      });
      if (typeof selected === "string") {
        setForm((current) => ({ ...current, image: selected }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Selection ISO impossible");
    }
  };

  const refreshSnapshots = async () => {
    if (!listSnapshots) return;
    setSnapshots(await listSnapshots(resource.id));
  };

  const submitSnapshot = async () => {
    if (!canSnapshot || !createSnapshot || snapshotPending || !snapshotName.trim()) return;
    setSnapshotPending("create");
    setError(null);
    try {
      await createSnapshot(resource.id, snapshotName.trim());
      setSnapshotName("");
      await refreshSnapshots();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Snapshot impossible");
    } finally {
      setSnapshotPending(null);
    }
  };

  const removeSnapshot = async (snapshotId: string) => {
    if (!deleteSnapshot || snapshotPending) return;
    setSnapshotPending(snapshotId);
    setError(null);
    try {
      await deleteSnapshot(resource.id, snapshotId);
      await refreshSnapshots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suppression snapshot impossible");
    } finally {
      setSnapshotPending(null);
    }
  };

  const restoreSnapshot = async (snapshotId: string) => {
    if (!rollbackSnapshot || snapshotPending) return;
    const confirmed = window.confirm("Restaurer ce snapshot? Le disque courant de la VM sera remplace.");
    if (!confirmed) return;
    setSnapshotPending(snapshotId);
    setError(null);
    try {
      await rollbackSnapshot(resource.id, snapshotId);
      await refreshSnapshots();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback snapshot impossible");
    } finally {
      setSnapshotPending(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded border border-virtua-border bg-black/20 text-virtua-accent">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold">{resource.name}</h1>
              <StatusBadge status={resource.state} />
            </div>
            <p className="mt-1 text-sm text-virtua-muted">{resource.kind.toUpperCase()} / {resource.node}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/console/${resource.id}`} className="virtua-button">
            <Terminal className="mr-2 h-4 w-4" />
            Console
          </Link>
          <button onClick={() => setEditing((current) => !current)} className="virtua-button">
            <Edit3 className="mr-2 h-4 w-4" />
            {isEditing ? "Sommaire" : "Edit"}
          </button>
          {canDelete ? (
            <button onClick={() => setShowDeleteConfirm(true)} disabled={isDeleting} className="virtua-button text-virtua-red">
              <Trash2 className="mr-2 h-4 w-4" />
              {isDeleting ? "Suppression..." : "Supprimer"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="rounded border border-virtua-red/50 bg-virtua-red/15 px-3 py-2 text-sm text-virtua-red">{error}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        {isEditing ? (
        <form onSubmit={submit} className="rounded border border-virtua-border bg-virtua-panel p-4">
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-virtua-border pb-3">
            <div>
              <h2 className="text-lg font-semibold">Configuration</h2>
              <p className="mt-1 text-xs text-virtua-muted">{canModify ? "Edition autorisee par vos droits." : "Lecture seule pour cet utilisateur."}</p>
            </div>
            <button disabled={!canModify || isSaving} className="virtua-button-primary" type="submit">
              <Save className="mr-2 h-4 w-4" />
              {isSaving ? "Sauvegarde..." : "Sauvegarder"}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-virtua-muted">
              Nom
              <input className="virtua-input w-full" disabled={!canModify} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="space-y-1 text-xs text-virtua-muted">
              Nom affiche
              <input className="virtua-input w-full" disabled={!canModify} value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} />
            </label>
            {resource.source === "local" && resource.kind === "vm" ? (
              <div className="space-y-2 text-xs text-virtua-muted">
                ISO montee
                <select
                  className="virtua-input w-full"
                  disabled={!canModify}
                  value={localIsoFiles.some((file) => file.path === form.image) ? form.image : ""}
                  onChange={(event) => setForm((current) => ({ ...current, image: event.target.value }))}
                >
                  <option value="">Aucune ISO du Storage</option>
                  {localIsoFiles.map((file) => (
                    <option key={file.path} value={file.path}>{file.name}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input
                    className="virtua-input min-w-0 flex-1"
                    disabled={!canModify}
                    placeholder="Aucune ISO montee"
                    value={form.image}
                    onChange={(event) => setForm((current) => ({ ...current, image: event.target.value }))}
                  />
                  <button type="button" disabled={!canModify} onClick={() => void browseIso()} className="virtua-button shrink-0">Parcourir</button>
                  <button type="button" disabled={!canModify || !form.image} onClick={() => setForm((current) => ({ ...current, image: "" }))} className="virtua-button shrink-0">Ejecter</button>
                </div>
                <p className="text-xs text-virtua-muted">Sauvegarde requise. Si la VM est demarree, le changement ISO s'applique au prochain demarrage.</p>
              </div>
            ) : (
              <label className="space-y-1 text-xs text-virtua-muted">
                Image
                <input className="virtua-input w-full" disabled={!canModify} value={form.image} onChange={(event) => setForm((current) => ({ ...current, image: event.target.value }))} />
              </label>
            )}
            <label className="space-y-1 text-xs text-virtua-muted">
              Noeud
              <input className="virtua-input w-full" disabled value={resource.node} />
            </label>
            {resource.source === "local" && resource.kind === "vm" ? (
              <>
                <label className="space-y-1 text-xs text-virtua-muted">
                  Reseau
                  <select className="virtua-input w-full" disabled={!canModify} value={form.network} onChange={(event) => setForm((current) => ({ ...current, network: event.target.value }))}>
                    <option value="user">NAT utilisateur</option>
                    <option value="isolated">Isole - aucune carte reseau</option>
                    <option value="vmnet-shared">macOS vmnet shared</option>
                    <option value="vmnet-bridged">Bridge macOS en0</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-virtua-muted">
                  Carte reseau
                  <select className="virtua-input w-full" disabled={!canModify} value={form.networkModel} onChange={(event) => setForm((current) => ({ ...current, networkModel: event.target.value }))}>
                    <option value="virtio">VirtIO</option>
                    <option value="e1000">Intel e1000{resource.architecture === "amd64" ? " - recommande AMD64" : ""}</option>
                    <option value="rtl8139">Realtek RTL8139</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-virtua-muted">
                  Carte graphique
                  <select className="virtua-input w-full" disabled={!canModify} value={form.gpuModel} onChange={(event) => setForm((current) => ({ ...current, gpuModel: event.target.value }))}>
                    <option value="virtio">VirtIO GPU</option>
                    <option value="std">VGA standard</option>
                    <option value="qxl">QXL</option>
                    <option value="cirrus">Cirrus</option>
                  </select>
                </label>
              </>
            ) : null}
            <label className="space-y-1 text-xs text-virtua-muted">
              CPU
              <input className="virtua-input w-full" disabled={!canModify} type="number" min="1" value={form.cpu} placeholder="inchange" onChange={(event) => setForm((current) => ({ ...current, cpu: event.target.value }))} />
            </label>
            <label className="space-y-1 text-xs text-virtua-muted">
              RAM MiB
              <input className="virtua-input w-full" disabled={!canModify} type="number" min="128" value={form.memory} placeholder="inchange" onChange={(event) => setForm((current) => ({ ...current, memory: event.target.value }))} />
            </label>
            <label className="space-y-1 text-xs text-virtua-muted">
              Disque GiB
              <input className="virtua-input w-full" disabled type="number" min="1" value={form.disk} placeholder="n/a" />
              <span className="block text-[11px] text-virtua-muted">Redimensionnement du disque non disponible dans cette version.</span>
            </label>
            {resource.source === "local" && resource.kind === "vm" ? (
              <div className="sm:col-span-2 grid gap-2 border-t border-virtua-border pt-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded border border-virtua-border bg-black/15 px-3 py-2 text-sm">
                  <span>
                    <span className="block">TPM 2.0</span>
                    <span className="text-xs text-virtua-muted">Etat applique au prochain demarrage.</span>
                  </span>
                  <input type="checkbox" disabled={!canModify} checked={form.tpm2} onChange={(event) => setForm((current) => ({ ...current, tpm2: event.target.checked }))} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded border border-virtua-border bg-black/15 px-3 py-2 text-sm">
                  <span>
                    <span className="block">Secure Boot</span>
                    <span className="text-xs text-virtua-muted">Etat applique au prochain demarrage.</span>
                  </span>
                  <input type="checkbox" disabled={!canModify} checked={form.secureBoot} onChange={(event) => setForm((current) => ({ ...current, secureBoot: event.target.checked }))} />
                </label>
              </div>
            ) : null}
          </div>
        </form>
        ) : (
        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <div className="mb-4 border-b border-virtua-border pb-3">
            <h2 className="text-lg font-semibold">Sommaire</h2>
            <p className="mt-1 text-xs text-virtua-muted">Etat courant et informations principales de la machine.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["Nom", resource.name],
              ["Nom affiche", resource.displayName],
              ["Type", resource.kind.toUpperCase()],
              ["Noeud", resource.node],
              ["Etat", resource.state],
              ["Architecture", resource.architecture ?? "n/a"],
              ["vCPU", resource.cpuCores ? String(resource.cpuCores) : "n/a"],
              ["RAM allouee", formatMemoryMib(resource.memoryMib)],
              ["Disque", formatDiskGib(resource.diskGib)],
              ["Reseau", resource.network ?? "n/a"],
              ["Carte reseau", resource.networkModel ?? "n/a"],
              ["Carte graphique", resource.gpuModel ?? "n/a"],
              ["TPM 2.0", yesNo(resource.tpm2)],
              ["Secure Boot", yesNo(resource.secureBoot)],
              ["Image", resource.image ?? "n/a"],
              ["Proprietaire", resource.owner ?? "local"],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-virtua-border bg-black/15 p-3">
                <p className="text-xs text-virtua-muted">{label}</p>
                <p className="mt-1 truncate text-sm">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to={`/console/${resource.id}`} className="virtua-button-primary">
              <Terminal className="mr-2 h-4 w-4" />
              Ouvrir la console
            </Link>
            <button onClick={() => setEditing(true)} className="virtua-button">
              <Edit3 className="mr-2 h-4 w-4" />
              Modifier
            </button>
          </div>
        </section>
        )}

        <aside className="space-y-4">
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <h2 className="mb-3 text-sm font-semibold">Etat temps reel</h2>
            <div className="space-y-3">
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-virtua-muted">IP</span>
                <span className="font-mono text-xs">{resource.ip ?? "n/a"}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-virtua-muted">Uptime</span>
                <span>{resource.uptime ?? "n/a"}</span>
              </div>
              {resource.kind === "vm" ? (
                <div className="flex justify-between gap-3 text-sm">
                  <span className="text-virtua-muted">Agent invite</span>
                  <span>{guestAgentLabel(resource)}</span>
                </div>
              ) : null}
              <div className="space-y-2 pt-1">
                <MetricBar label="CPU" value={resource.cpu ?? 0} />
                <MetricBar label="RAM" value={resource.memory ?? 0} />
              </div>
            </div>
          </div>

          {canSnapshot ? (
            <div className="rounded border border-virtua-border bg-virtua-panel p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Snapshots</h2>
                <span className="text-xs text-virtua-muted">{snapshots.length}</span>
              </div>
              <div className="flex gap-2">
                <input
                  className="virtua-input min-w-0 flex-1"
                  placeholder="Nom du snapshot"
                  value={snapshotName}
                  onChange={(event) => setSnapshotName(event.target.value)}
                  disabled={!snapshotsAllowedNow || snapshotPending === "create"}
                />
                <button
                  type="button"
                  onClick={() => void submitSnapshot()}
                  disabled={!snapshotsAllowedNow || !snapshotName.trim() || snapshotPending === "create"}
                  className="virtua-button-primary shrink-0"
                  title={snapshotsAllowedNow ? "Creer un snapshot" : "Arreter la VM avant un snapshot local"}
                >
                  <Camera className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 max-h-72 overflow-auto divide-y divide-virtua-border rounded border border-virtua-border bg-black/15">
                {snapshots.map((snapshot) => (
                  <div key={snapshot.id} className="p-3">
                    <div className="mb-2 min-w-0">
                      <p className="truncate text-sm font-medium">{snapshot.name}</p>
                      <p className="text-xs text-virtua-muted">{formatSnapshotDate(snapshot.createdAt)} / {formatSnapshotBytes(snapshot.size)}</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void restoreSnapshot(snapshot.id)}
                        disabled={!snapshotsAllowedNow || snapshotPending === snapshot.id}
                        className="virtua-button h-8 flex-1 justify-center text-xs"
                      >
                        <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        Rollback
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeSnapshot(snapshot.id)}
                        disabled={snapshotPending === snapshot.id}
                        className="virtua-button h-8 justify-center text-xs text-virtua-red"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {snapshots.length === 0 ? <div className="px-3 py-8 text-center text-sm text-virtua-muted">Aucun snapshot.</div> : null}
              </div>
              {!snapshotsAllowedNow ? <p className="mt-2 text-xs text-virtua-muted">Snapshots locaux disponibles quand la VM est arretee.</p> : null}
            </div>
          ) : null}

          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <h2 className="mb-3 text-sm font-semibold">Droits</h2>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["Voir", resource.permissions.canView],
                ["Console", resource.permissions.canConsole],
                ["Power", resource.permissions.canPower],
                ["Snapshot", resource.permissions.canSnapshot],
                ["Modifier", canModify],
                ["Supprimer", canDelete],
              ].map(([label, allowed]) => (
                <div key={String(label)} className="flex items-center justify-between rounded border border-virtua-border bg-black/15 px-2 py-2">
                  <span className="text-virtua-muted">{label}</span>
                  <span className={allowed ? "text-virtua-green" : "text-virtua-muted"}>{allowed ? "oui" : "non"}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {showDeleteConfirm ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded border border-virtua-border bg-virtua-panel p-4 shadow-xl">
            <h2 className="text-lg font-semibold">Supprimer la machine</h2>
            <p className="mt-2 text-sm text-virtua-muted">
              Supprimer {resource.name} ? Cette action peut detruire les donnees associees selon le type de machine.
            </p>
            {resource.source === "local" ? (
              <label className="mt-4 flex items-center gap-2 rounded border border-virtua-border bg-black/15 px-3 py-2 text-sm text-virtua-muted">
                <input type="checkbox" checked={deleteDisks} onChange={(event) => setDeleteDisks(event.target.checked)} />
                Supprimer aussi le disque qcow2 local
              </label>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setShowDeleteConfirm(false)} className="virtua-button">Annuler</button>
              <button type="button" onClick={() => void deleteResource()} disabled={isDeleting} className="virtua-button text-virtua-red">
                <Trash2 className="mr-2 h-4 w-4" />
                {isDeleting ? "Suppression..." : "Confirmer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
