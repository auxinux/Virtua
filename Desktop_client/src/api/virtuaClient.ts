import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { secureStore } from "@/api/secureStore";
import type {
  ConsoleMode,
  DesktopConsoleTicketResponse,
  DesktopCreateOptionsResponse,
  DesktopMeResponse,
  DesktopResourceResponse,
  DesktopTokenResponse,
  PowerAction,
  ResourceKind,
  VirtuaConnection,
  VirtuaResource,
  VirtuaTask,
  VirtuaUser,
  VmArchitecture,
} from "@/types";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
};

type ServerTemplateResponse = {
  id: string;
  type?: "vm" | "iso" | "VM" | "ISO";
  name?: string;
  displayName?: string;
  description?: string;
  architecture?: VmArchitecture | string;
  cpu?: number;
  memory?: number;
  ram?: number;
  disk?: number | string;
  size?: number | string;
};

export type CreateResourcePayload = {
  type: ResourceKind;
  name: string;
  architecture?: VmArchitecture;
  node?: string;
  image?: string;
  templateId?: string;
  isoId?: string;
  network?: string;
  networkModel?: string;
  gpuModel?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  tpm2?: boolean;
  secureBoot?: boolean;
  qemuGuestAgent?: boolean;
  autostart?: boolean;
  privileged?: boolean;
  nesting?: boolean;
  restartPolicy?: "no" | "unless-stopped" | "always" | "on-failure";
  ports?: string;
  rootPassword?: string;
};

let baseUrl = secureStore.getEndpoint();
let accessToken: string | null = null;
let refreshToken: string | null = null;
let accessExpiresAt = 0;
const taskStorageKey = "auxinux-virtua-desktop-tasks";

const isTauri = () => "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

function normalizeEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function normalizeConsoleUrl(rawUrl: string) {
  const endpoint = normalizeEndpoint(baseUrl || secureStore.getEndpoint());
  if (!endpoint) return rawUrl;

  try {
    const endpointUrl = new URL(endpoint);
    const consoleUrl = new URL(rawUrl, endpointUrl);
    const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(consoleUrl.hostname);

    if (isLocalHost || rawUrl.startsWith("/")) {
      consoleUrl.protocol = endpointUrl.protocol === "https:" ? "wss:" : "ws:";
      consoleUrl.hostname = endpointUrl.hostname;
      consoleUrl.port = endpointUrl.port;
    }

    return consoleUrl.toString();
  } catch {
    return rawUrl;
  }
}

function deviceName() {
  return secureStore.getDeviceName().slice(0, 64);
}

function installationId() {
  return secureStore.getInstallationId();
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function percentFrom(...values: Array<number | string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "number") return clampPercent(value);
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace("%", "").trim());
      if (Number.isFinite(parsed)) return clampPercent(parsed);
    }
  }
  return undefined;
}

function numberFrom(...values: Array<number | string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function textFrom(...values: Array<string | null | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function formatUptimeSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function uptimeFrom(resource: DesktopResourceResponse) {
  if (typeof resource.uptime === "string" && resource.uptime.trim()) return resource.uptime.trim();
  if (typeof resource.uptime === "number") return formatUptimeSeconds(resource.uptime);
  if (typeof resource.uptimeSeconds === "number") return formatUptimeSeconds(resource.uptimeSeconds);
  return undefined;
}

function imageMatchesResourceType(item: { type?: string; kind?: string }, type: ResourceKind) {
  const marker = `${item.type ?? ""} ${item.kind ?? ""}`.toLowerCase();
  if (!marker.trim()) return true;
  if (type === "vm") return !marker.includes("lxc") && !marker.includes("docker");
  if (type === "lxc") return marker.includes("lxc") || marker.includes("container-template") || marker.includes("template");
  return marker.includes("docker") || marker.includes("image");
}

function guestAgentFrom(resource: DesktopResourceResponse): VirtuaResource["guestAgent"] {
  if (resource.type !== "vm") return undefined;
  const status = textFrom(
    resource.guestAgent?.status ?? undefined,
    resource.qemuGuestAgentStatus ?? undefined,
    resource.guestAgentStatus ?? undefined,
  );
  const installed = resource.guestAgent?.installed ?? resource.qemuGuestAgentEnabled ?? resource.qemuGuestAgent ?? undefined;
  const running = resource.guestAgent?.running ?? resource.qemuGuestAgentRunning ?? (status ? ["running", "active", "connected", "ok"].includes(status.toLowerCase()) : undefined);
  return { installed, running, status };
}

function readTasks(): VirtuaTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(taskStorageKey) ?? "[]") as VirtuaTask[];
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks: VirtuaTask[]) {
  localStorage.setItem(taskStorageKey, JSON.stringify(tasks.slice(0, 100)));
  window.dispatchEvent(new CustomEvent("virtua-tasks-changed"));
}

function pushTask(task: Omit<VirtuaTask, "id" | "createdAt">) {
  const nextTask: VirtuaTask = {
    ...task,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  writeTasks([nextTask, ...readTasks()]);
  return nextTask.id;
}

function updateTask(taskId: string, patch: Partial<VirtuaTask>) {
  writeTasks(readTasks().map((task) => task.id === taskId ? { ...task, ...patch } : task));
}

function apiUnavailableMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Action impossible";
  if (message === "HTTP 404" || message === "HTTP 405" || message.toLowerCase().includes("not found")) {
    return "Action non disponible cote API Desktop";
  }
  if (message.includes("Renaming an existing resource is not supported")) {
    return "Virtua serveur ne supporte pas encore le renommage reel de cette ressource";
  }
  return message;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mapResource(resource: DesktopResourceResponse): VirtuaResource {
  const ipAddress = textFrom(resource.ipAddress ?? undefined, resource.ip ?? undefined, resource.ipAddresses?.[0]);

  return {
    id: resource.id,
    kind: resource.type,
    name: resource.name,
    displayName: resource.displayName ?? resource.name,
    node: resource.node,
    state: resource.state,
    cpu: percentFrom(resource.cpuPercent, resource.cpuUsage, resource.cpu),
    memory: percentFrom(resource.memoryPercent, resource.memPercent, resource.ramPercent, resource.memory),
    cpuCores: numberFrom(resource.cpuCores, resource.vcpus, resource.vcpu),
    memoryMib: numberFrom(resource.memoryMib, resource.memoryMiB, resource.ramMib),
    diskGib: numberFrom(resource.diskGib, resource.diskGiB),
    ip: ipAddress,
    uptime: uptimeFrom(resource),
    image: textFrom(resource.image ?? undefined) ?? (resource.type === "vm" ? "VM console" : resource.type === "lxc" ? "LXC shell" : "Docker shell"),
    tpm2: resource.tpm2 ?? undefined,
    secureBoot: resource.secureBoot ?? undefined,
    owner: textFrom(resource.owner ?? undefined),
    assignedUsers: resource.assignedUsers ?? undefined,
    guestAgent: guestAgentFrom(resource),
    consoleModes: resource.type === "vm" ? ["text", "graphical"] : ["text"],
    permissions: resource.permissions,
  };
}

async function nativeFetch(url: string, init: RequestInit = {}) {
  if (isTauri()) {
    return tauriFetch(url, {
      ...init,
      connectTimeout: 15_000,
      maxRedirections: 5,
    });
  }
  const requestUrl = import.meta.env.DEV ? `/__virtua_proxy?url=${encodeURIComponent(url)}` : url;
  try {
    return await fetch(requestUrl, init);
  } catch (error) {
    if (!isTauri()) {
      throw new Error("Connexion impossible en mode web. Lance l'app Desktop ou utilise le serveur dev avec proxy.");
    }
    throw error;
  }
}

async function applyTokens(tokens: DesktopTokenResponse) {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  accessExpiresAt = Date.now() + Math.max(5, tokens.expiresIn - 10) * 1000;
  await secureStore.setRefreshToken(tokens.refreshToken);
}

async function refreshAccessToken() {
  if (!refreshToken) refreshToken = await secureStore.getRefreshToken();
  if (!refreshToken) throw new Error("Aucune session desktop enregistree");

  const endpoint = normalizeEndpoint(baseUrl || secureStore.getEndpoint());
  if (!endpoint) throw new Error("Endpoint Virtua non configure");

  const response = await nativeFetch(`${endpoint}/api/desktop/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, installationId: await secureStore.getInstallationIdAsync() }),
  });

  if (!response.ok) {
    await secureStore.clearRefreshToken();
    refreshToken = null;
    accessToken = null;
    throw new Error("Session expiree ou appareil revoque");
  }

  await applyTokens(await response.json() as DesktopTokenResponse);
}

async function request<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
  const endpoint = normalizeEndpoint(baseUrl || secureStore.getEndpoint());
  if (!endpoint) throw new Error("Endpoint Virtua non configure");

  if (options.auth !== false && (!accessToken || Date.now() >= accessExpiresAt)) {
    await refreshAccessToken();
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await nativeFetch(`${endpoint}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401 && retry && options.auth !== false) {
    await refreshAccessToken();
    return request<T>(path, options, false);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({})) as { error?: string; message?: string };
    const message = errorBody.error ?? errorBody.message ?? `HTTP ${response.status}`;
    if (message === "Invalid credentials") throw new Error("Utilisateur ou mot de passe invalide");
    if (message === "Invalid or expired pairing code") throw new Error("Code d'apparage invalide ou expire");
    if (response.status === 429) throw new Error("Trop de tentatives. Reessaie dans une minute.");
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const virtuaClient = {
  configure(endpoint: string) {
    baseUrl = normalizeEndpoint(endpoint);
    secureStore.setEndpoint(baseUrl);
  },

  getEndpoint() {
    return normalizeEndpoint(baseUrl || secureStore.getEndpoint());
  },

  getDeviceName() {
    return deviceName();
  },

  async getDeviceNameAsync() {
    return (await secureStore.getDeviceNameAsync()).slice(0, 64);
  },

  setDeviceName(name: string) {
    secureStore.setDeviceName(name);
  },

  async restoreSession() {
    baseUrl = normalizeEndpoint(await secureStore.getEndpointAsync());
    await secureStore.getInstallationIdAsync();
    refreshToken = await secureStore.getRefreshToken();
    if (!baseUrl || !refreshToken) return false;
    await refreshAccessToken();
    return true;
  },

  async login(endpoint: string, username: string, password: string, name = deviceName()) {
    this.configure(endpoint);
    this.setDeviceName(name);
    const tokens = await request<DesktopTokenResponse>("/api/desktop/auth/login", {
      method: "POST",
      auth: false,
      body: {
        username: username.trim(),
        password,
        deviceName: name.trim() || deviceName(),
        installationId: await secureStore.getInstallationIdAsync(),
      },
    });
    await secureStore.setEndpointAsync(baseUrl);
    await secureStore.setDeviceNameAsync(name.trim() || deviceName());
    await applyTokens(tokens);
  },

  async pair(endpoint: string, pairingCode: string, name = deviceName()) {
    this.configure(endpoint);
    this.setDeviceName(name);
    const tokens = await request<DesktopTokenResponse>("/api/desktop/devices/pair", {
      method: "POST",
      auth: false,
      body: {
        pairingCode: pairingCode.trim().toUpperCase(),
        deviceName: name.trim() || deviceName(),
        installationId: await secureStore.getInstallationIdAsync(),
      },
    });
    await secureStore.setEndpointAsync(baseUrl);
    await secureStore.setDeviceNameAsync(name.trim() || deviceName());
    await applyTokens(tokens);
  },

  async logout() {
    const token = refreshToken ?? await secureStore.getRefreshToken();
    if (token && this.getEndpoint()) {
      await request<{ ok: boolean }>("/api/desktop/auth/logout", {
        method: "POST",
        auth: false,
        body: { refreshToken: token, installationId: installationId() },
      }).catch(() => undefined);
    }
    refreshToken = null;
    accessToken = null;
    accessExpiresAt = 0;
    await secureStore.clearRefreshToken();
  },

  async getCurrentUser(): Promise<VirtuaUser> {
    const me = await request<DesktopMeResponse>("/api/desktop/me");
    return {
      username: me.user.username,
      displayName: me.user.displayName ?? me.user.username,
      role: me.user.role,
    };
  },

  async getConnection(): Promise<VirtuaConnection> {
    const endpoint = this.getEndpoint();
    const me = await request<DesktopMeResponse>("/api/desktop/me");
    return {
      id: me.device.id,
      name: me.device.name,
      endpoint,
      status: "connected",
      username: me.user.username,
      lastSync: new Date().toISOString(),
    };
  },

  async listNodes() {
    const resources = await this.listAccessibleResources();
    const names = Array.from(new Set(resources.map((resource) => resource.node)));
    return names.map((name) => ({
      id: name,
      name,
      host: name,
      role: "worker" as const,
      status: "online" as const,
      cpuUsage: 0,
      memoryUsage: 0,
      storageUsage: 0,
      vmCount: resources.filter((resource) => resource.node === name && resource.kind === "vm").length,
      lxcCount: resources.filter((resource) => resource.node === name && resource.kind === "lxc").length,
      dockerCount: resources.filter((resource) => resource.node === name && resource.kind === "docker").length,
    }));
  },

  async listResources() {
    return this.listAccessibleResources();
  },

  async listAccessibleResources() {
    const resources = await request<DesktopResourceResponse[]>("/api/desktop/resources");
    return resources.map(mapResource);
  },

  async listCreateOptions(type: ResourceKind): Promise<DesktopCreateOptionsResponse> {
    try {
      const options = await request<DesktopCreateOptionsResponse>(`/api/desktop/resources/create-options?type=${encodeURIComponent(type)}`);
      const typedOptions = {
        ...options,
        images: (options.images ?? []).filter((item) => imageMatchesResourceType(item, type)),
      };
      if (type !== "vm") return typedOptions;
      const templates = await this.listUsableTemplates().catch(() => []);
      if (templates.length === 0) return typedOptions;
      const existingIds = new Set((typedOptions.images ?? []).map((item) => item.id));
      const templateOptions = templates
        .filter((template) => {
          const marker = template.type?.toString().toLowerCase() ?? "";
          return marker === "vm" || marker === "iso" || marker === "";
        })
        .map((template) => ({
          id: template.id,
          name: template.displayName ?? template.name ?? template.id,
          label: `${template.type?.toString().toLowerCase() === "iso" ? "ISO" : "Template"} - ${template.displayName ?? template.name ?? template.id}`,
          kind: template.type?.toString().toLowerCase() === "iso" ? "iso" : "template",
          type: template.type?.toString().toLowerCase() === "iso" ? "iso" : "vm",
          description: template.description,
          architecture: template.architecture,
          cpu: template.cpu,
          memory: template.memory ?? template.ram,
          ram: template.ram,
          disk: template.disk,
          size: template.size,
        }))
        .filter((item) => !existingIds.has(item.id));
      return { ...typedOptions, images: [...(typedOptions.images ?? []), ...templateOptions] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "HTTP 404" || message === "HTTP 405" || message.toLowerCase().includes("not found")) {
        return {};
      }
      throw error;
    }
  },

  async listUsableTemplates(): Promise<ServerTemplateResponse[]> {
    try {
      const result = await request<ServerTemplateResponse[] | { templates?: ServerTemplateResponse[]; items?: ServerTemplateResponse[] }>("/api/templates");
      if (Array.isArray(result)) return result;
      return result.templates ?? result.items ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "HTTP 404" || message === "HTTP 405" || message.toLowerCase().includes("not found")) return [];
      throw error;
    }
  },

  async listTasks(): Promise<VirtuaTask[]> {
    return readTasks();
  },

  clearTasks() {
    writeTasks([]);
  },

  async runAction(resourceId: string, action: PowerAction) {
    const serverAction = action === "shutdown" ? "stop" : action;
    const labels = { start: "Demarrage", stop: "Arret force", restart: "Redemarrage", shutdown: "Arret propre" };
    const taskId = pushTask({ label: labels[action], target: resourceId, status: "running", progress: 25 });
    try {
      const result = await request<{ ok: boolean; result?: unknown }>(`/api/desktop/resources/${encodeURIComponent(resourceId)}/actions/${serverAction}`, {
        method: "POST",
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return result;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(apiUnavailableMessage(error));
    }
  },

  async snapshot(resourceId: string, name: string, description?: string) {
    const taskId = pushTask({ label: "Snapshot", target: resourceId, status: "running", progress: 25 });
    try {
      const result = await request<{ ok: boolean; result?: unknown }>(`/api/desktop/resources/${encodeURIComponent(resourceId)}/actions/snapshot`, {
        method: "POST",
        body: { name, description },
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return result;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(apiUnavailableMessage(error));
    }
  },

  async createResource(payload: CreateResourcePayload) {
    const taskId = pushTask({ label: "Creation machine", target: payload.name, status: "running", progress: 20 });
    try {
      const result = await request<{ ok: boolean; resource?: DesktopResourceResponse }>("/api/desktop/resources", {
        method: "POST",
        body: payload,
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return result;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(apiUnavailableMessage(error));
    }
  },

  async updateResource(resourceId: string, payload: { name?: string; displayName?: string; image?: string; cpu?: number; memory?: number; disk?: number; network?: string; networkModel?: string; gpuModel?: string; tpm2?: boolean; secureBoot?: boolean }) {
    const taskId = pushTask({ label: "Modification machine", target: resourceId, status: "running", progress: 20 });
    try {
      const result = await request<{ ok: boolean; resource?: DesktopResourceResponse }>(`/api/desktop/resources/${encodeURIComponent(resourceId)}`, {
        method: "PATCH",
        body: payload,
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return result;
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(apiUnavailableMessage(error));
    }
  },

  async deleteResource(resourceId: string) {
    const taskId = pushTask({ label: "Suppression machine", target: resourceId, status: "running", progress: 20 });
    try {
      const result = await request<{ ok: boolean }>(`/api/desktop/resources/${encodeURIComponent(resourceId)}`, {
        method: "DELETE",
      });
      for (const [index, waitMs] of [700, 1200, 1800, 2500].entries()) {
        await delay(waitMs);
        updateTask(taskId, { progress: 35 + index * 15 });
        const resources = await request<DesktopResourceResponse[]>("/api/desktop/resources");
        if (!resources.some((resource) => resource.id === resourceId)) {
          updateTask(taskId, { status: "completed", progress: 100 });
          return result;
        }
      }
      throw new Error("Suppression envoyee, mais Virtua retourne encore cette ressource");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Suppression envoyee")) {
        updateTask(taskId, { status: "failed", progress: 100 });
        throw error;
      }
      updateTask(taskId, { status: "failed", progress: 100 });
      throw new Error(apiUnavailableMessage(error));
    }
  },

  async getConsoleTicket(resourceId: string, mode: ConsoleMode) {
    const taskId = pushTask({ label: mode === "graphical" ? "Console graphique" : "Terminal texte", target: resourceId, status: "running", progress: 30 });
    try {
      const ticket = await request<DesktopConsoleTicketResponse>(`/api/desktop/resources/${encodeURIComponent(resourceId)}/console/${mode}-ticket`, {
        method: "POST",
      });
      updateTask(taskId, { status: "completed", progress: 100 });
      return { ...ticket, url: normalizeConsoleUrl(ticket.url) };
    } catch (error) {
      updateTask(taskId, { status: "failed", progress: 100 });
      throw error;
    }
  },
};
