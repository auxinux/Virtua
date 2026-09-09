import { engines } from "@/api/engines";
import { invoke } from "@tauri-apps/api/core";
import type {
  DesktopCreateOptionsResponse,
  LocalHostMetrics,
  LocalQemuDiagnostics,
  LocalSnapshot,
  LocalStorageFile,
  LocalStorageConfig,
  LocalStorageInventory,
  LocalVm,
  LocalContainerResource,
  RemoteTemplateItem,
  VirtuaConnection,
  VirtuaNode,
  VirtuaResource,
  VirtuaTask,
  VirtuaUser,
  VmArchitecture,
  PowerAction,
  ConsoleMode,
} from "@/types";
import type { CreateResourcePayload } from "@/api/virtuaClient";

/** Asks the user before a setup that may raise an administrator prompt. */
export type EngineInstallPrompt = (
  engine: "qemu" | "lxc" | "docker",
  detail: string,
) => boolean | Promise<boolean>;

const modeKey = "auxinux-virtua-desktop-mode";
const taskKey = "auxinux-virtua-local-tasks";

function pushTask(task: Omit<VirtuaTask, "id" | "createdAt">) {
  const tasks = listLocalTasks();
  const nextTask: VirtuaTask = {
    source: "device",
    ...task,
    id: `local-task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(taskKey, JSON.stringify([nextTask, ...tasks].slice(0, 80)));
  window.dispatchEvent(new Event("virtua-tasks-changed"));
  return nextTask.id;
}

function updateTask(taskId: string, patch: Partial<VirtuaTask>) {
  const tasks = listLocalTasks().map((task) => task.id === taskId ? { ...task, ...patch } : task);
  localStorage.setItem(taskKey, JSON.stringify(tasks));
  window.dispatchEvent(new Event("virtua-tasks-changed"));
}

function listLocalTasks(): VirtuaTask[] {
  try {
    const raw = localStorage.getItem(taskKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VirtuaTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function roundPercent(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.round(value * 10) / 10;
}

function formatDuration(seconds?: number | null) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function mapLocalVm(vm: LocalVm): VirtuaResource {
  return {
    id: vm.id,
    kind: "vm",
    source: "local",
    name: vm.name,
    displayName: vm.name,
    node: "Ordinateur local",
    state: vm.state,
    architecture: vm.architecture,
    ip: vm.guestIp ?? undefined,
    cpu: roundPercent(vm.cpuUsage),
    memory: roundPercent(vm.memoryUsage),
    cpuCores: vm.cpu,
    memoryMib: vm.memoryMib,
    diskGib: vm.diskGib,
    uptime: formatDuration(vm.uptimeSeconds),
    image: vm.isoPath || undefined,
    network: vm.network,
    networkModel: vm.networkModel ?? "virtio",
    gpuModel: vm.gpuModel ?? "virtio",
    diskBus: vm.diskBus ?? "virtio",
    tpm2: Boolean(vm.tpm2),
    secureBoot: Boolean(vm.secureBoot),
    startupNotes: vm.startupNotes ?? undefined,
    owner: "local",
    guestAgent: {
      installed: vm.guestAgentRunning ?? false,
      running: vm.guestAgentRunning ?? false,
      status: vm.guestAgentRunning ? "actif" : "non installe",
    },
    // SPICE is preferred and falls back to VNC inside the graphical console.
    consoleModes: ["graphical"],
    permissions: {
      canView: true,
      canConsole: true,
      canPower: true,
      canSnapshot: true,
      canModify: true,
      canDelete: true,
      canCreate: true,
    },
  };
}

function mapLocalContainer(resource: LocalContainerResource): VirtuaResource {
  const kind = resource.kind === "docker" ? "docker" : "lxc";
  return {
    id: resource.id,
    kind,
    source: "local",
    name: resource.name,
    displayName: resource.name,
    node: "Ordinateur local",
    state: resource.state,
    ip: resource.ip ?? undefined,
    cpu: roundPercent(resource.cpuUsage),
    memory: roundPercent(resource.memoryUsage),
    uptime: formatDuration(resource.uptimeSeconds),
    image: resource.image || (kind === "docker" ? "Docker" : "LXC"),
    network: resource.ports ?? undefined,
    owner: "local",
    consoleModes: ["text"],
    permissions: {
      canView: true,
      canConsole: true,
      canPower: true,
      canSnapshot: false,
      canModify: false,
      canDelete: true,
      canCreate: true,
    },
  };
}

function normalizeArchitecture(value: unknown): VmArchitecture {
  return value === "amd64" || value === "x86_64" ? "amd64" : "arm64";
}

export const modeStore = {
  get(): "unset" | "local" | "cloud" {
    const value = localStorage.getItem(modeKey);
    return value === "local" || value === "cloud" ? value : "unset";
  },

  set(mode: "local" | "cloud") {
    localStorage.setItem(modeKey, mode);
  },

  clear() {
    localStorage.removeItem(modeKey);
  },
};

export const localVirtua = {
  async diagnostics() {
    return invoke<LocalQemuDiagnostics>("local_qemu_diagnostics");
  },

  async hostMetrics() {
    return invoke<LocalHostMetrics>("local_host_metrics");
  },

  async getStorageConfig() {
    return invoke<LocalStorageConfig>("local_load_storage_config");
  },

  async saveStorageConfig(config: LocalStorageConfig) {
    return invoke<LocalStorageConfig>("local_save_storage_config", { config });
  },

  async storageInventory() {
    return invoke<LocalStorageInventory>("local_storage_inventory");
  },

  async listRemoteTemplates(category: "ISO" | "VM", architecture: VmArchitecture) {
    return invoke<RemoteTemplateItem[]>("local_list_remote_templates", {
      request: { category, architecture },
    });
  },

  async downloadTemplate(item: RemoteTemplateItem) {
    const label = item.category === "ISO" ? "Telechargement ISO" : "Import template VM";
    const taskId = pushTask({ label, target: item.name, status: "running", progress: 20 });
    try {
      const vm = await invoke<LocalVm | null>("local_download_template", {
        payload: {
          category: item.category,
          architecture: item.architecture,
          name: item.name,
          url: item.url,
          metadataUrl: item.metadataUrl ?? undefined,
        },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return vm ? mapLocalVm(vm) : null;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async exportVmTemplate(vmId: string, templateName: string, description?: string) {
    const taskId = pushTask({ label: "Export template VM", target: templateName, status: "running", progress: 20 });
    try {
      const file = await invoke<LocalStorageFile>("local_export_vm_template", {
        payload: { vmId, templateName, description },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return file;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async deleteStorageFile(kind: "iso" | "template" | "disk" | "snapshot", path: string) {
    return invoke<void>("local_delete_storage_file", {
      payload: { kind, path },
    });
  },

  async listVms() {
    return invoke<LocalVm[]>("local_list_vms");
  },

  async listContainers() {
    return invoke<LocalContainerResource[]>("local_list_containers");
  },

  async listResources() {
    const [vms, containers] = await Promise.all([
      this.listVms(),
      this.listContainers().catch(() => []),
    ]);
    return [...vms.map(mapLocalVm), ...containers.map(mapLocalContainer)];
  },

  async createResource(
    payload: CreateResourcePayload,
    confirmInstall?: EngineInstallPrompt,
  ) {
    const taskId = pushTask({ label: payload.type === "vm" ? "Creation VM locale" : `Creation ${payload.type.toUpperCase()} local`, target: payload.name, status: "running", progress: 20 });
    try {
      await this.ensureEngineReady(payload.type, confirmInstall);
      if (payload.type === "lxc" || payload.type === "docker") {
        const resource = await invoke<LocalContainerResource>("local_create_container", {
          payload: {
            kind: payload.type,
            name: payload.name,
            image: payload.image || undefined,
            cpu: payload.cpu,
            memoryMib: payload.memory,
            diskGib: payload.disk,
            network: payload.network,
            restartPolicy: payload.restartPolicy,
            ports: payload.ports,
            privileged: payload.privileged,
            nesting: payload.nesting,
            autostart: payload.autostart,
            rootPassword: payload.rootPassword,
          },
        });
        updateTask(taskId, { status: "completed", progress: 100 });
        return { ok: true, resource: mapLocalContainer(resource) };
      }

      const image = payload.image || "";
      if (image.startsWith("template:")) {
        let vm = await invoke<LocalVm>("local_import_vm_template", {
          payload: {
            templatePath: image.slice("template:".length),
            architecture: normalizeArchitecture(payload.architecture),
          },
        });
        const requestedName = payload.name.trim();
        const updatePayload: { name?: string; tpm2?: boolean; secureBoot?: boolean } = {};
        if (requestedName && requestedName !== vm.name) updatePayload.name = requestedName;
        if (typeof payload.tpm2 === "boolean") updatePayload.tpm2 = payload.tpm2;
        if (typeof payload.secureBoot === "boolean") updatePayload.secureBoot = payload.secureBoot;
        if (Object.keys(updatePayload).length > 0) {
          vm = await invoke<LocalVm>("local_update_vm", {
            id: vm.id,
            payload: updatePayload,
          });
        }
        updateTask(taskId, { status: "completed", progress: 100 });
        return { ok: true, resource: mapLocalVm(vm) };
      }

      const isoPath = image.startsWith("iso:") ? image.slice("iso:".length) : image;
      const vm = await invoke<LocalVm>("local_create_vm", {
        payload: {
          name: payload.name,
          architecture: normalizeArchitecture(payload.architecture),
          cpu: payload.cpu ?? 2,
          memoryMib: payload.memory ?? 2048,
          diskGib: payload.disk ?? 20,
          isoPath: isoPath || undefined,
          network: payload.network || "user",
          networkModel: (payload as CreateResourcePayload & { networkModel?: string }).networkModel || "virtio",
          gpuModel: (payload as CreateResourcePayload & { gpuModel?: string }).gpuModel || "virtio",
          diskBus: (payload as CreateResourcePayload & { diskBus?: string }).diskBus,
          tpm2: payload.tpm2 ?? false,
          secureBoot: payload.secureBoot ?? false,
        },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return { ok: true, resource: mapLocalVm(vm) };
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async deleteResource(resourceId: string, deleteDisks = false) {
    const isContainer = resourceId.startsWith("docker:") || resourceId.startsWith("lxc:");
    const taskId = pushTask({ label: isContainer ? "Suppression conteneur local" : "Suppression VM locale", target: resourceId, status: "running", progress: 20 });
    try {
      if (isContainer) {
        await invoke("local_delete_container", { id: resourceId });
      } else {
        await invoke("local_delete_vm", { id: resourceId, deleteDisks });
      }
      updateTask(taskId, { status: "completed", progress: 100 });
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async updateResource(resourceId: string, payload: { name?: string; displayName?: string; image?: string; cpu?: number; memory?: number; disk?: number; network?: string; networkModel?: string; gpuModel?: string; diskBus?: string; tpm2?: boolean; secureBoot?: boolean }) {
    const taskId = pushTask({ label: "Modification VM locale", target: resourceId, status: "running", progress: 25 });
    try {
      const vm = await invoke<LocalVm>("local_update_vm", {
        id: resourceId,
        payload: {
          name: payload.name ?? payload.displayName,
          image: payload.image,
          cpu: payload.cpu,
          memoryMib: payload.memory,
          network: payload.network,
          networkModel: payload.networkModel,
          gpuModel: payload.gpuModel,
          diskBus: payload.diskBus,
          tpm2: payload.tpm2,
          secureBoot: payload.secureBoot,
        },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return { ok: true, resource: mapLocalVm(vm) };
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Make sure the engine a requested feature needs is installed and running.
   * `confirmInstall` lets the UI ask before a setup that may raise an
   * administrator prompt; without a handler nothing is installed silently.
   */
  async ensureEngineReady(kind: "vm" | "lxc" | "docker", confirmInstall: EngineInstallPrompt = () => false) {
    const engineId = kind === "vm" ? "qemu" : kind;
    const labels = { qemu: "QEMU", lxc: "LXC", docker: "Docker" } as const;

    // QEMU has its own cheap diagnostic; the full engine overview also probes
    // Docker and the LXC companion VM, which is slow and irrelevant here.
    if (engineId === "qemu" && (await this.diagnostics()).ready) return;

    let engine = engineId === "qemu"
      ? undefined
      : (await engines.status()).engines.find((item) => item.id === engineId);
    if (engine?.state === "ready") return;

    const detail = engine?.detail ?? `${labels[engineId]} n'est pas encore disponible.`;
    if (!(await confirmInstall(engineId, detail))) {
      throw new Error(
        `${labels[engineId]} n'est pas prêt : ${detail} Ouvrez Configuration → Moteurs locaux pour l'installer.`,
      );
    }

    const taskId = pushTask({ label: `Installation ${labels[engineId]}`, target: labels[engineId], status: "running", progress: 10 });
    try {
      const status = await engines.prepare(engineId);
      engine = status.engines.find((item) => item.id === engineId);
      if (engine?.state !== "ready") {
        throw new Error(engine?.detail ?? `${labels[engineId]} reste indisponible.`);
      }
      updateTask(taskId, { status: "completed", progress: 100 });
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async installQemu() {
    const taskId = pushTask({ label: "Installation hyperviseur", target: "QEMU", status: "running", progress: 10 });
    try {
      await engines.prepare("qemu");
      const output = "QEMU prêt";
      updateTask(taskId, { status: "completed", progress: 100 });
      return output;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async runAction(resourceId: string, action: PowerAction) {
    const isContainer = resourceId.startsWith("docker:") || resourceId.startsWith("lxc:");
    const taskId = pushTask({ label: `${isContainer ? "Conteneur" : "VM"} ${action}`, target: resourceId, status: "running", progress: 25 });
    try {
      if (isContainer) {
        const resource = await invoke<LocalContainerResource>("local_run_container_action", { id: resourceId, action });
        updateTask(taskId, { status: "completed", progress: 100 });
        return { ok: true, resource: mapLocalContainer(resource) };
      }
      const vm = await invoke<LocalVm>("local_run_action", { id: resourceId, action });
      updateTask(taskId, { status: "completed", progress: 100 });
      return { ok: true, resource: mapLocalVm(vm) };
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async listSnapshots(resourceId: string) {
    return invoke<LocalSnapshot[]>("local_list_snapshots", { vmId: resourceId });
  },

  async createSnapshot(resourceId: string, name: string) {
    const taskId = pushTask({ label: "Creation snapshot", target: name, status: "running", progress: 20 });
    try {
      const snapshot = await invoke<LocalSnapshot>("local_create_snapshot", {
        payload: { vmId: resourceId, name },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return snapshot;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async deleteSnapshot(resourceId: string, snapshotId: string) {
    const taskId = pushTask({ label: "Suppression snapshot", target: snapshotId, status: "running", progress: 20 });
    try {
      await invoke("local_delete_snapshot", {
        payload: { vmId: resourceId, snapshotId },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async rollbackSnapshot(resourceId: string, snapshotId: string) {
    const taskId = pushTask({ label: "Rollback snapshot", target: snapshotId, status: "running", progress: 20 });
    try {
      await invoke("local_rollback_snapshot", {
        payload: { vmId: resourceId, snapshotId },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },

  async getConsoleTicket(resourceId: string, mode: ConsoleMode = "graphical") {
    if (mode === "spice") {
      const result = await invoke<{ url: string; password?: string }>("local_spice_console_url", { id: resourceId });
      return {
        ticket: "local",
        url: result.url,
        password: result.password,
        expiresInMs: 60_000,
        kind: mode,
      };
    }
    const url = await invoke<string>(mode === "text" ? "local_text_console_url" : "local_console_url", { id: resourceId });
    return {
      ticket: "local",
      url,
      expiresInMs: 60_000,
      kind: mode,
    };
  },

  async listCreateOptions(type: "vm" | "lxc" | "docker" = "vm"): Promise<DesktopCreateOptionsResponse> {
    const [diagnostics, inventory] = await Promise.all([
      this.diagnostics(),
      this.storageInventory().catch(() => null),
    ]);
    const node = { id: "local", name: "Ordinateur local", label: "Ordinateur local" };

    if (type === "lxc") {
      return {
        nodes: [node],
        images: [
          { id: "images:debian/13", name: "debian/13", label: "Debian 13 - officiel LXC", kind: "lxc-template", type: "lxc", source: "images.linuxcontainers.org" },
          { id: "images:debian/12", name: "debian/12", label: "Debian 12 - officiel LXC", kind: "lxc-template", type: "lxc", source: "images.linuxcontainers.org" },
          { id: "images:ubuntu/24.04", name: "ubuntu/24.04", label: "Ubuntu 24.04 - officiel LXC", kind: "lxc-template", type: "lxc", source: "images.linuxcontainers.org" },
          { id: "images:alpine/3.20", name: "alpine/3.20", label: "Alpine 3.20 - officiel LXC", kind: "lxc-template", type: "lxc", source: "images.linuxcontainers.org" },
        ],
        networks: [{ id: "default", name: "Default", label: "Reseau LXC par defaut" }],
        defaults: { cpu: 1, memory: 512, disk: 0, network: "default" },
      };
    }

    if (type === "docker") {
      const localImages = (inventory?.dockerImages ?? [])
        .filter((image) => image.repository && image.repository !== "<none>" && image.tag && image.tag !== "<none>")
        .map((image) => ({
          id: `${image.repository}:${image.tag}`,
          name: `${image.repository}:${image.tag}`,
          label: `Local - ${image.repository}:${image.tag}`,
          kind: "docker-image",
          type: "docker",
          source: "local-docker",
        }));
      const hubImages = [
        "nginx:latest",
        "traefik:v3.0",
        "postgres:16",
        "mariadb:11",
        "redis:7",
        "node:22-alpine",
        "ubuntu:24.04",
        "debian:13",
      ].map((name) => ({
        id: name,
        name,
        label: `Docker Hub - ${name}`,
        kind: "docker-image",
        type: "docker",
        source: "docker-hub",
      }));
      return {
        nodes: [node],
        images: [...localImages, ...hubImages.filter((image) => !localImages.some((local) => local.id === image.id))],
        networks: [{ id: "bridge", name: "Bridge", label: "Docker bridge" }, { id: "host", name: "Host", label: "Host" }, { id: "none", name: "None", label: "Aucun reseau" }],
        defaults: { cpu: 1, memory: 512, disk: 0, network: "bridge" },
      };
    }

    const architectures = [
      diagnostics.qemuSystemArm64.available ? { id: "arm64", name: "ARM64", label: "ARM64" } : null,
      diagnostics.qemuSystemAmd64.available ? { id: "amd64", name: "AMD64", label: "AMD64 / x86_64" } : null,
    ].filter(Boolean) as DesktopCreateOptionsResponse["architectures"];

    return {
      nodes: [node],
      images: [
        ...(inventory?.templates ?? []).map((file) => ({
          id: `template:${file.path}`,
          name: file.name,
          label: `Template VM - ${file.name}`,
          kind: "template",
          type: "vm",
          source: "auxinux-local",
        })),
        ...(inventory?.iso ?? []).map((file) => ({
          id: `iso:${file.path}`,
          name: file.name,
          label: `ISO - ${file.name}`,
          kind: "iso",
          type: "iso",
          source: "auxinux-local",
        })),
      ],
      networks: [
        { id: "user", name: "NAT utilisateur", label: "NAT utilisateur" },
        { id: "isolated", name: "Isole", label: "Isole - aucune carte reseau" },
        ...(diagnostics.os === "macos" ? [
          { id: "vmnet-shared", name: "vmnet shared", label: "macOS vmnet shared" },
          { id: "vmnet-bridged", name: "Bridge en0", label: "Bridge macOS en0" },
        ] : []),
      ],
      architectures,
      defaults: {
        architecture: diagnostics.hostArch === "amd64" ? "amd64" : "arm64",
        cpu: 2,
        memory: 2048,
        disk: 40,
        network: "user",
      },
    };
  },

  getUser(): VirtuaUser {
    return {
      username: "local",
      displayName: "Mode local",
      role: "ADMIN",
    };
  },

  getConnection(): VirtuaConnection {
    return {
      id: "local",
      name: "Virtua Local",
      endpoint: "",
      status: "connected",
      username: "local",
      lastSync: new Date().toISOString(),
    };
  },

  nodesFromResources(resources: VirtuaResource[], metrics?: LocalHostMetrics | null): VirtuaNode[] {
    return [{
      id: "local",
      name: "Ordinateur local",
      host: "localhost",
      role: "primary",
      status: "online",
      cpuUsage: roundPercent(metrics?.cpuUsage) ?? 0,
      memoryUsage: roundPercent(metrics?.memoryUsage) ?? 0,
      storageUsage: roundPercent(metrics?.storageUsage) ?? 0,
      uptime: formatDuration(metrics?.uptimeSeconds),
      vmCount: resources.filter((resource) => resource.kind === "vm").length,
      lxcCount: resources.filter((resource) => resource.kind === "lxc").length,
      dockerCount: resources.filter((resource) => resource.kind === "docker").length,
      computerName: metrics?.computerName,
      totalCores: metrics?.totalCores,
      virtualizationCores: metrics?.virtualizationCores,
      totalMemoryGib: metrics?.totalMemoryGib,
      virtualizationMemoryGib: metrics?.virtualizationMemoryGib,
    }];
  },

  listTasks: listLocalTasks,

  clearTasks() {
    localStorage.removeItem(taskKey);
    window.dispatchEvent(new Event("virtua-tasks-changed"));
  },
};
