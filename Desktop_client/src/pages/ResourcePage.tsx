import { open } from "@tauri-apps/plugin-dialog";
import { Boxes, Container, Loader2, Monitor, Plus, Play, RotateCcw, Square, Terminal } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { virtuaClient, type CreateResourcePayload } from "@/api/virtuaClient";
import { StatusBadge } from "@/components/StatusBadge";
import type { DesktopCreateOptionsResponse, PowerAction, ResourceKind, UsageMode, VirtuaResource, VirtuaUser, VmArchitecture } from "@/types";

const labels: Record<ResourceKind | "all", string> = {
  all: "Inventaire",
  vm: "Machines virtuelles",
  lxc: "Conteneurs LXC",
  docker: "Conteneurs Docker",
};

const icons: Record<ResourceKind, typeof Monitor> = {
  vm: Monitor,
  lxc: Container,
  docker: Boxes,
};

function isRunning(state: string) {
  return ["running", "run", "active", "started", "up"].includes(state.toLowerCase());
}

function isStopped(state: string) {
  return ["stopped", "stop", "inactive", "shutoff", "shut off", "down", "exited"].includes(state.toLowerCase());
}

function formatPercent(value?: number) {
  return typeof value === "number" ? `${value}%` : "n/a";
}

function normalizeHostArch(value?: string | null): VmArchitecture | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  return null;
}

const defaultListCreateOptions = (type: ResourceKind) => virtuaClient.listCreateOptions(type);
const defaultCreateResource = (payload: CreateResourcePayload) => virtuaClient.createResource(payload);

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function ActionButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof Play;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-2 rounded border border-virtua-border px-3 text-xs text-virtua-muted transition-colors hover:bg-virtua-panelHover hover:text-virtua-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function StopChoiceDialog({
  resource,
  onClose,
  onChoose,
}: {
  resource: VirtuaResource;
  onClose: () => void;
  onChoose: (action: PowerAction) => void;
}) {
  const local = resource.source === "local";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded border border-virtua-border bg-virtua-panel p-4 shadow-xl">
        <h2 className="text-lg font-semibold">Arreter {resource.name}</h2>
        <p className="mt-2 text-sm text-virtua-muted">Choisis comment Virtua Desktop doit arreter cette machine.</p>
        <div className="mt-4 space-y-2">
          <button
            onClick={() => onChoose(local ? "shutdown" : "stop")}
            className="w-full rounded border border-virtua-border bg-black/15 px-3 py-3 text-left hover:bg-virtua-panelHover"
          >
            <span className="block text-sm font-medium">Envoyer un signal a l'OS</span>
            <span className="mt-1 block text-xs text-virtua-muted">Demande un arret propre a l'OS invite.</span>
          </button>
          {local ? (
            <button
              onClick={() => onChoose("stop")}
              className="w-full rounded border border-virtua-red/50 bg-virtua-red/10 px-3 py-3 text-left text-virtua-red hover:bg-virtua-red/15"
            >
              <span className="block text-sm font-medium">Fermer la machine maintenant</span>
              <span className="mt-1 block text-xs text-virtua-red/80">Force la fermeture QEMU. Equivalent a couper le courant.</span>
            </button>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="virtua-button">Annuler</button>
        </div>
      </div>
    </div>
  );
}

function CreateResourceDialog({
  defaultKind,
  resources,
  usageMode = "cloud",
  hostArch,
  listCreateOptions = defaultListCreateOptions,
  createResource = defaultCreateResource,
  onClose,
  onCreated,
}: {
  defaultKind: ResourceKind;
  resources: VirtuaResource[];
  usageMode?: UsageMode;
  hostArch?: string | null;
  listCreateOptions?: (type: ResourceKind) => Promise<DesktopCreateOptionsResponse>;
  createResource?: (payload: CreateResourcePayload) => Promise<unknown>;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [form, setForm] = useState({
    type: defaultKind,
    name: "",
    architecture: (hostArch === "amd64" ? "amd64" : "arm64") as VmArchitecture,
    node: "",
    image: "",
    network: "",
    networkModel: "virtio",
    gpuModel: "virtio",
    cpu: "2",
    memory: "2048",
    disk: "20",
    tpm2: true,
    secureBoot: false,
    qemuGuestAgent: true,
    autostart: false,
    privileged: false,
    nesting: true,
    restartPolicy: "unless-stopped",
    ports: "",
    rootPassword: "",
  });
  const [options, setOptions] = useState<DesktopCreateOptionsResponse>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isLoadingOptions, setLoadingOptions] = useState(false);
  const dirtyFieldsRef = useRef<Set<string>>(new Set());

  const fallbackNodes = useMemo(
    () => Array.from(new Set(resources.map((resource) => resource.node))).map((node) => ({ id: node, name: node, label: node })),
    [resources],
  );
  const nodes = options.nodes?.length ? options.nodes : fallbackNodes;
  const images = options.images ?? [];
  const networks = options.networks ?? [];
  const hostArchitecture = normalizeHostArch(hostArch);
  const architectures = options.architectures?.length ? options.architectures : [
    { id: "arm64", name: "ARM64", label: "ARM64 - natif sur Apple Silicon" },
    { id: "amd64", name: "AMD64", label: "AMD64 / x86_64 - emulation" },
  ];
  const isEmulatedArchitecture = form.type === "vm" && hostArchitecture !== null && hostArchitecture !== form.architecture;
  const selectedImage = images.find((image) => image.id === form.image);
  const selectedImageKind = selectedImage?.kind?.toLowerCase() || selectedImage?.type?.toLowerCase() || "";
  const selectedCloudTemplateId = usageMode === "cloud" && form.type === "vm" && (selectedImageKind.includes("template") || selectedImageKind === "vm") ? selectedImage?.id : undefined;
  const selectedCloudIsoId = usageMode === "cloud" && form.type === "vm" && selectedImageKind === "iso" ? selectedImage?.id : undefined;

  const setField = <Key extends keyof typeof form>(field: Key, value: (typeof form)[Key]) => {
    dirtyFieldsRef.current.add(field);
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "architecture" && usageMode === "local" && current.type === "vm" && !dirtyFieldsRef.current.has("networkModel")) {
        next.networkModel = value === "amd64" ? "e1000" : "virtio";
      }
      return next;
    });
  };

  useEffect(() => {
    let isCurrent = true;
    setLoadingOptions(true);
    void listCreateOptions(form.type).then((nextOptions) => {
      if (!isCurrent) return;
      setOptions(nextOptions);
      setForm((current) => ({
        ...current,
        architecture: dirtyFieldsRef.current.has("architecture")
          ? current.architecture
          : nextOptions.defaults?.architecture ?? current.architecture,
        node: dirtyFieldsRef.current.has("node") ? current.node : current.node || nextOptions.nodes?.[0]?.id || nextOptions.nodes?.[0]?.name || "",
        image: dirtyFieldsRef.current.has("image") ? current.image : current.image,
        network: dirtyFieldsRef.current.has("network") ? current.network : nextOptions.defaults?.network ?? current.network,
        cpu: dirtyFieldsRef.current.has("cpu") ? current.cpu : String(nextOptions.defaults?.cpu ?? current.cpu),
        memory: dirtyFieldsRef.current.has("memory") ? current.memory : String(nextOptions.defaults?.memory ?? current.memory),
        disk: dirtyFieldsRef.current.has("disk") ? current.disk : String(nextOptions.defaults?.disk ?? current.disk),
        networkModel: dirtyFieldsRef.current.has("networkModel") ? current.networkModel : current.architecture === "amd64" ? "e1000" : "virtio",
      }));
    }).catch((err) => {
      if (isCurrent) setError(err instanceof Error ? err.message : "Options de creation indisponibles");
    }).finally(() => {
      if (isCurrent) setLoadingOptions(false);
    });
    return () => {
      isCurrent = false;
    };
  }, [form.type, listCreateOptions]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await waitForPaint();
      await createResource({
        type: form.type,
        name: form.name.trim(),
        architecture: form.type === "vm" ? form.architecture : undefined,
        node: form.node.trim() || undefined,
        image: selectedCloudTemplateId || selectedCloudIsoId ? undefined : form.image.trim() || undefined,
        templateId: selectedCloudTemplateId,
        isoId: selectedCloudIsoId,
        network: form.network.trim() || undefined,
        networkModel: form.type === "vm" ? form.networkModel : undefined,
        gpuModel: form.type === "vm" ? form.gpuModel : undefined,
        cpu: Number(form.cpu),
        memory: Number(form.memory),
        disk: usageMode === "local" && form.type === "lxc" ? 0 : Number(form.disk),
        tpm2: form.type === "vm" ? form.tpm2 : undefined,
        secureBoot: form.type === "vm" ? form.secureBoot : undefined,
        qemuGuestAgent: form.type === "vm" ? form.qemuGuestAgent : undefined,
        autostart: form.autostart,
        privileged: form.type === "lxc" ? form.privileged : undefined,
        nesting: form.type === "lxc" ? form.nesting : undefined,
        restartPolicy: form.type === "docker" ? form.restartPolicy as "no" | "unless-stopped" | "always" | "on-failure" : undefined,
        ports: form.type === "docker" ? form.ports.trim() || undefined : undefined,
        rootPassword: form.type === "lxc" ? form.rootPassword : undefined,
      });
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation impossible");
    } finally {
      setSaving(false);
    }
  };

  const browseIso = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Selectionner une ISO",
        filters: [{ name: "Images disque", extensions: ["iso", "img", "qcow2"] }],
      });
      if (typeof selected !== "string") return;
      setField("image", selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Selection ISO impossible");
    }
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
      {isSaving ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded border border-virtua-border bg-virtua-panel p-5 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded bg-virtua-accentSoft text-virtua-accent">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Creation en cours</h2>
                <p className="mt-1 text-sm text-virtua-muted">
                  {usageMode === "local" ? `Preparation ${form.type.toUpperCase()} locale.` : "Envoi de la demande au serveur Virtua."}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded border border-virtua-border bg-black/20 px-3 py-2 text-sm leading-6 text-virtua-muted">
              Cette operation peut prendre un moment selon la taille du disque et le stockage choisi.
            </div>
          </div>
        </div>
      ) : null}
      <form onSubmit={submit} className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded border border-virtua-border bg-virtua-panel p-4 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Creer une machine</h2>
          <p className="mt-1 text-xs text-virtua-muted">
              {isLoadingOptions ? "Chargement des options..." : usageMode === "local" ? "Creation locale sur ce Mac." : "Noeud, image, reseau et options selon le type."}
            </p>
          </div>
          <button type="button" onClick={onClose} className="virtua-button">Fermer</button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-virtua-muted">
            Type
            <select
              className="virtua-input w-full"
              value={form.type}
              onChange={(event) => setField("type", event.target.value as ResourceKind)}
            >
              <option value="vm">VM</option>
              <option value="lxc">LXC</option>
              <option value="docker">Docker</option>
            </select>
          </label>
          {usageMode === "cloud" && form.type === "vm" && selectedImage ? (
            <div className="rounded border border-virtua-border bg-black/15 p-3 text-sm sm:col-span-2">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{selectedImage.label ?? selectedImage.name}</span>
                <span className="rounded border border-virtua-border px-2 py-0.5 text-xs uppercase text-virtua-muted">{selectedImageKind || "image"}</span>
              </div>
              {selectedImage.description ? <p className="mb-2 text-virtua-muted">{selectedImage.description}</p> : null}
              <div className="flex flex-wrap gap-2 text-xs text-virtua-muted">
                {selectedImage.architecture ? <span className="rounded bg-black/20 px-2 py-1">ARCH {selectedImage.architecture}</span> : null}
                {selectedImage.cpu ? <span className="rounded bg-black/20 px-2 py-1">CPU {selectedImage.cpu}</span> : null}
                {selectedImage.memory ?? selectedImage.ram ? <span className="rounded bg-black/20 px-2 py-1">RAM {selectedImage.memory ?? selectedImage.ram} MiB</span> : null}
                {selectedImage.disk ? <span className="rounded bg-black/20 px-2 py-1">DISK {selectedImage.disk}</span> : null}
                {selectedImage.size ? <span className="rounded bg-black/20 px-2 py-1">SIZE {selectedImage.size}</span> : null}
              </div>
            </div>
          ) : null}
          <label className="space-y-1 text-xs text-virtua-muted">
            Nom
            <input className="virtua-input w-full" required value={form.name} onChange={(event) => setField("name", event.target.value)} />
          </label>
          {form.type === "vm" ? (
            <label className="space-y-1 text-xs text-virtua-muted">
              Architecture
              <select className="virtua-input w-full" value={form.architecture} onChange={(event) => setField("architecture", event.target.value as VmArchitecture)}>
                {architectures.map((arch) => (
                  <option key={arch.id} value={arch.id}>{arch.label ?? arch.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="space-y-1 text-xs text-virtua-muted">
            Noeud
            {nodes.length > 0 ? (
              <select className="virtua-input w-full" value={form.node} onChange={(event) => setField("node", event.target.value)}>
                <option value="">Selectionner</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>{node.label ?? node.name}</option>
                ))}
              </select>
            ) : (
              <input className="virtua-input w-full" value={form.node} onChange={(event) => setField("node", event.target.value)} />
            )}
          </label>
          <label className="space-y-1 text-xs text-virtua-muted">
            {form.type === "vm" ? "ISO / image VM" : form.type === "lxc" ? "Template LXC" : "Image Docker"}
            {images.length > 0 ? (
              <select className="virtua-input w-full" value={form.image} onChange={(event) => setField("image", event.target.value)}>
                <option value="">Selectionner</option>
                {images.map((image) => (
                  <option key={image.id} value={image.id}>{image.label ?? image.name}</option>
                ))}
              </select>
            ) : (
              usageMode === "local" && form.type === "vm" ? (
                <div className="flex gap-2">
                  <input className="virtua-input min-w-0 flex-1" placeholder="/chemin/vers/install.iso" value={form.image} onChange={(event) => setField("image", event.target.value)} />
                  <button type="button" className="virtua-button shrink-0" onClick={() => void browseIso()}>Parcourir</button>
                </div>
              ) : (
                <input className="virtua-input w-full" placeholder={form.type === "docker" ? "nginx:latest" : "Selection via API Virtua requise"} value={form.image} onChange={(event) => setField("image", event.target.value)} />
              )
            )}
          </label>
          <label className="space-y-1 text-xs text-virtua-muted">
            Reseau
            {networks.length > 0 ? (
              <select className="virtua-input w-full" value={form.network} onChange={(event) => setField("network", event.target.value)}>
                <option value="">Par defaut</option>
                {networks.map((network) => (
                  <option key={network.id} value={network.id}>{network.label ?? network.name}</option>
                ))}
              </select>
            ) : (
              <input className="virtua-input w-full" placeholder="bridge / network" value={form.network} onChange={(event) => setField("network", event.target.value)} />
            )}
          </label>
          {form.type === "vm" ? (
            <>
              <label className="space-y-1 text-xs text-virtua-muted">
                Carte reseau
                <select className="virtua-input w-full" value={form.networkModel} onChange={(event) => setField("networkModel", event.target.value)}>
                  <option value="virtio">VirtIO</option>
                  <option value="e1000">Intel e1000{form.architecture === "amd64" ? " - recommande AMD64" : ""}</option>
                  {usageMode === "local" ? <option value="rtl8139">Realtek RTL8139</option> : null}
                </select>
              </label>
              <label className="space-y-1 text-xs text-virtua-muted">
                Carte graphique
                <select className="virtua-input w-full" value={form.gpuModel} onChange={(event) => setField("gpuModel", event.target.value)}>
                  <option value="virtio">VirtIO GPU</option>
                  <option value={usageMode === "local" ? "std" : "vga"}>VGA standard</option>
                  <option value="qxl">QXL (acceleration via SPICE)</option>
                  {usageMode === "local" ? <option value="cirrus">Cirrus</option> : null}
                </select>
              </label>
            </>
          ) : null}
          <label className="space-y-1 text-xs text-virtua-muted">
            CPU
            <input className="virtua-input w-full" type="number" min="1" value={form.cpu} onChange={(event) => setField("cpu", event.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-virtua-muted">
            RAM MiB
            <input className="virtua-input w-full" type="number" min="128" value={form.memory} onChange={(event) => setField("memory", event.target.value)} />
          </label>
          {form.type !== "docker" && !(usageMode === "local" && form.type === "lxc") ? (
            <label className="space-y-1 text-xs text-virtua-muted">
              Disque GiB
              <input className="virtua-input w-full" type="number" min="1" value={form.disk} onChange={(event) => setField("disk", event.target.value)} />
            </label>
          ) : null}
        </div>

        {isEmulatedArchitecture ? (
          <div className="mt-4 rounded border border-virtua-yellow/50 bg-virtua-yellow/15 px-3 py-2 text-sm text-virtua-yellow">
            Architecture differente du host ({hostArchitecture} vers {form.architecture}) : cette VM utilisera l'emulation CPU et sera beaucoup plus lente qu'une VM native.
          </div>
        ) : null}

        <div className="mt-4 rounded border border-virtua-border bg-black/10 p-3">
          <h3 className="mb-3 text-sm font-medium">Options {form.type.toUpperCase()}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {form.type === "vm" ? (
              <>
                <label className="flex items-center gap-2 text-sm text-virtua-muted">
                  <input type="checkbox" checked={form.qemuGuestAgent} onChange={(event) => setField("qemuGuestAgent", event.target.checked)} />
                  Agent invite
                </label>
                <label className="flex items-center gap-2 text-sm text-virtua-muted">
                  <input type="checkbox" checked={form.tpm2} onChange={(event) => setField("tpm2", event.target.checked)} />
                  TPM 2.0
                </label>
                <label className="flex items-center gap-2 text-sm text-virtua-muted">
                  <input type="checkbox" checked={form.secureBoot} onChange={(event) => setField("secureBoot", event.target.checked)} />
                  Secure Boot
                </label>
              </>
            ) : null}

            {form.type === "lxc" ? (
              <>
                <label className="space-y-1 text-xs text-virtua-muted sm:col-span-2 lg:col-span-3">
                  Mot de passe root
                  <input
                    className="virtua-input w-full"
                    type="password"
                    required={usageMode === "local"}
                    value={form.rootPassword}
                    onChange={(event) => setField("rootPassword", event.target.value)}
                    placeholder="Mot de passe root du conteneur"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-virtua-muted">
                  <input type="checkbox" checked={form.nesting} onChange={(event) => setField("nesting", event.target.checked)} />
                  Nesting
                </label>
                <label className="flex items-center gap-2 text-sm text-virtua-muted">
                  <input type="checkbox" checked={form.privileged} onChange={(event) => setField("privileged", event.target.checked)} />
                  Privilegie
                </label>
              </>
            ) : null}

            {form.type === "docker" ? (
              <>
                <label className="space-y-1 text-xs text-virtua-muted">
                  Restart policy
                  <select className="virtua-input w-full" value={form.restartPolicy} onChange={(event) => setField("restartPolicy", event.target.value)}>
                    <option value="no">Aucun</option>
                    <option value="unless-stopped">Unless stopped</option>
                    <option value="always">Always</option>
                    <option value="on-failure">On failure</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-virtua-muted lg:col-span-2">
                  Ports
                  <input className="virtua-input w-full" placeholder="8080:80, 8443:443" value={form.ports} onChange={(event) => setField("ports", event.target.value)} />
                </label>
              </>
            ) : null}

            <label className="flex items-center gap-2 text-sm text-virtua-muted">
              <input type="checkbox" checked={form.autostart} onChange={(event) => setField("autostart", event.target.checked)} />
              Demarrage automatique
            </label>
          </div>
        </div>

        {error ? <div className="mt-4 rounded border border-virtua-red/50 bg-virtua-red/15 px-3 py-2 text-sm text-virtua-red">{error}</div> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="virtua-button">Annuler</button>
          <button disabled={isSaving} className="virtua-button-primary" type="submit">{isSaving ? "Creation..." : "Creer"}</button>
        </div>
      </form>
    </div>
  );
}

export function ResourcePage({
  kind,
  resources,
  user,
  usageMode = "cloud",
  hostArch,
  listCreateOptions,
  createResource,
  runResourceAction = (resourceId, action) => virtuaClient.runAction(resourceId, action),
  onChanged,
}: {
  kind: ResourceKind | "all";
  resources: VirtuaResource[];
  user: VirtuaUser | null;
  usageMode?: UsageMode;
  hostArch?: string | null;
  listCreateOptions?: (type: ResourceKind) => Promise<DesktopCreateOptionsResponse>;
  createResource?: (payload: CreateResourcePayload) => Promise<unknown>;
  runResourceAction?: (resourceId: string, action: PowerAction) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
}) {
  const navigate = useNavigate();
  const visibleResources = useMemo(() => kind === "all" ? resources : resources.filter((resource) => resource.kind === kind), [kind, resources]);
  const [selectedId, setSelectedId] = useState<string | null>(visibleResources[0]?.id ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showStopChoice, setShowStopChoice] = useState(false);
  const selectedResource = visibleResources.find((resource) => resource.id === selectedId) ?? visibleResources[0];
  const canCreate = user?.role === "ADMIN" || resources.some((resource) => resource.permissions.canCreate);
  const canPower = Boolean(selectedResource?.permissions.canPower) && pendingAction === null;
  const canStart = Boolean(selectedResource && canPower && isStopped(selectedResource.state));
  const canStop = Boolean(selectedResource && canPower && isRunning(selectedResource.state));
  const canRestart = canStop;

  const runAction = async (action: PowerAction) => {
    if (!selectedResource) return;
    setPendingAction(action);
    setError(null);
    try {
      await runResourceAction(selectedResource.id, action);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action impossible");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{labels[kind]}</h1>
          <p className="mt-1 text-sm text-virtua-muted">Liste centralisee des ressources gerees par Virtua.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreate ? <ActionButton label="Creer" icon={Plus} onClick={() => setShowCreate(true)} /> : null}
          <ActionButton label="Demarrer" icon={Play} disabled={!canStart} onClick={() => void runAction("start")} />
          <ActionButton label="Arreter" icon={Square} disabled={!canStop} onClick={() => setShowStopChoice(true)} />
          <ActionButton label="Redemarrer" icon={RotateCcw} disabled={!canRestart} onClick={() => void runAction("restart")} />
          <ActionButton label="Console" icon={Terminal} disabled={!selectedResource?.permissions.canConsole} onClick={() => selectedResource && navigate(`/console/${selectedResource.id}`)} />
        </div>
      </div>

      {error ? <div className="rounded border border-virtua-red/50 bg-virtua-red/15 px-3 py-2 text-sm text-virtua-red">{error}</div> : null}
      {showStopChoice && selectedResource ? (
        <StopChoiceDialog
          resource={selectedResource}
          onClose={() => setShowStopChoice(false)}
          onChoose={(action) => {
            setShowStopChoice(false);
            void runAction(action);
          }}
        />
      ) : null}

      <div className="overflow-hidden rounded border border-virtua-border bg-virtua-panel">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-wider text-virtua-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Nom</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Noeud</th>
              <th className="px-4 py-3 font-medium">Etat</th>
              <th className="px-4 py-3 font-medium">CPU</th>
              <th className="px-4 py-3 font-medium">RAM</th>
              <th className="px-4 py-3 font-medium">IP</th>
              <th className="px-4 py-3 font-medium">Uptime</th>
              <th className="px-4 py-3 font-medium">Image</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-virtua-border">
            {visibleResources.map((resource) => {
              const Icon = icons[resource.kind];
              return (
                <tr
                  key={resource.id}
                  onClick={() => navigate(`/resources/${resource.id}`)}
                  className={`cursor-pointer transition-colors hover:bg-virtua-panelHover ${selectedResource?.id === resource.id ? "bg-virtua-accentSoft/35" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-virtua-accent" />
                      <Link
                        to={`/resources/${resource.id}`}
                        className="font-medium text-virtua-text hover:text-virtua-accent"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(resource.id);
                        }}
                      >
                        {resource.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-virtua-muted">{resource.kind.toUpperCase()}</td>
                  <td className="px-4 py-3 text-virtua-muted">{resource.node}</td>
                  <td className="px-4 py-3"><StatusBadge status={resource.state} /></td>
                  <td className="px-4 py-3 text-virtua-muted">{formatPercent(resource.cpu)}</td>
                  <td className="px-4 py-3 text-virtua-muted">{formatPercent(resource.memory)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-virtua-muted">{resource.ip ?? "n/a"}</td>
                  <td className="px-4 py-3 text-virtua-muted">{resource.uptime ?? "n/a"}</td>
                  <td className="px-4 py-3 text-virtua-muted">{resource.image}</td>
                </tr>
              );
            })}
            {visibleResources.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-virtua-muted">
                  Aucune ressource accessible.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canCreate && showCreate ? (
        <CreateResourceDialog
          defaultKind={kind === "all" ? "vm" : kind}
          resources={resources}
          usageMode={usageMode}
          hostArch={hostArch}
          listCreateOptions={listCreateOptions}
          createResource={createResource}
          onClose={() => setShowCreate(false)}
          onCreated={onChanged}
        />
      ) : null}
    </div>
  );
}
