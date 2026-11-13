/**
 * Proxmox VE mode: Virtua Desktop connected straight to a Proxmox VE 9.x
 * server. Every call goes through the Rust side (src-tauri/src/proxmox.rs),
 * which pins the server's self-signed certificate and keeps the credentials.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  ConsoleMode,
  DesktopConsoleTicketResponse,
  PowerAction,
  VirtuaConnection,
  VirtuaNode,
  VirtuaResource,
  VirtuaTask,
  VirtuaUser,
} from "@/types";

export type PveKind = "qemu" | "lxc";

export interface PveProbe {
  base: string;
  fingerprint: string;
}

export interface PveSessionInfo {
  base: string;
  fingerprint: string;
  username: string;
  auth: "ticket" | "token";
  version: string;
  release: string;
}

export interface PveLoginInput {
  url: string;
  fingerprint: string;
  username: string;
  password?: string;
  tokenId?: string;
  tokenSecret?: string;
  remember?: boolean;
}

/** Non-secret connection details kept between runs (the token secret lives in the keyring). */
interface SavedProfile {
  base: string;
  fingerprint: string;
  username: string;
  tokenId?: string;
}

const profileKey = "auxinux-virtua-desktop-proxmox";

/** Raised by Rust when the certificate is not the pinned one. */
export const CERT_CHANGED = "PVE_CERT_CHANGED:";

export function changedFingerprint(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const at = text.indexOf(CERT_CHANGED);
  return at >= 0 ? text.slice(at + CERT_CHANGED.length).trim() : null;
}

/** `pve-100` ↔ vmid 100 (ids are unique in a Proxmox cluster). */
export function resourceId(vmid: number) {
  return `pve-${vmid}`;
}

export function vmidOf(id: string): number {
  const vmid = Number(id.replace(/^pve-/, ""));
  if (!Number.isInteger(vmid) || vmid < 100) throw new Error(`Machine Proxmox inconnue : ${id}`);
  return vmid;
}

function percent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 10 : 0;
}

function ratio(used: unknown, total: unknown) {
  return typeof used === "number" && typeof total === "number" && total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
}

export function formatUptime(seconds: unknown) {
  if (typeof seconds !== "number" || seconds <= 0) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

/** One row of GET /cluster/resources. */
export interface PveClusterRow {
  id: string;
  type: "qemu" | "lxc" | "node" | "storage" | string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  template?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  tags?: string;
  lock?: string;
  storage?: string;
  content?: string;
}

export function mapGuest(row: PveClusterRow): VirtuaResource {
  const kind = row.type === "lxc" ? "lxc" : "vm";
  const vmid = row.vmid ?? 0;
  const name = row.name || `${kind === "vm" ? "VM" : "CT"} ${vmid}`;
  return {
    id: resourceId(vmid),
    kind,
    source: "proxmox",
    name,
    displayName: `${vmid} · ${name}`,
    node: row.node ?? "",
    state: row.lock ? `${row.status ?? "unknown"} (${row.lock})` : row.status ?? "unknown",
    cpu: percent(row.cpu),
    memory: ratio(row.mem, row.maxmem),
    cpuCores: row.maxcpu,
    memoryMib: row.maxmem ? Math.round(row.maxmem / 1024 / 1024) : undefined,
    diskGib: row.maxdisk ? Math.round((row.maxdisk / 1024 ** 3) * 10) / 10 : undefined,
    uptime: formatUptime(row.uptime),
    // A container's shell is its natural console; VMs get the screen.
    consoleModes: kind === "lxc" ? ["text", "graphical"] : ["graphical"],
    // Proxmox enforces its own ACLs: a refused action comes back as an error.
    permissions: { canView: true, canConsole: true, canPower: true, canSnapshot: true, canModify: true, canDelete: true, canCreate: true },
    proxmox: { vmid, type: kind === "lxc" ? "lxc" : "qemu", template: Boolean(row.template), tags: row.tags },
  };
}

export function mapNode(row: PveClusterRow, guests: VirtuaResource[]): VirtuaNode {
  const name = row.node ?? row.id;
  return {
    id: row.id,
    name,
    host: name,
    role: "worker",
    status: row.status === "online" ? "online" : "offline",
    cpuUsage: percent(row.cpu),
    memoryUsage: ratio(row.mem, row.maxmem),
    storageUsage: ratio(row.disk, row.maxdisk),
    uptime: formatUptime(row.uptime),
    vmCount: guests.filter((g) => g.node === name && g.kind === "vm").length,
    lxcCount: guests.filter((g) => g.node === name && g.kind === "lxc").length,
    dockerCount: 0,
    totalCores: row.maxcpu,
    totalMemoryGib: row.maxmem ? Math.round((row.maxmem / 1024 ** 3) * 10) / 10 : undefined,
  };
}

/** GET /cluster/tasks row → Virtua task. */
export function mapTask(row: { upid: string; type?: string; id?: string; node?: string; status?: string; starttime?: number; endtime?: number; user?: string }): VirtuaTask {
  const running = !row.endtime;
  const failed = !running && row.status !== undefined && row.status !== "OK" && !/^WARNINGS/.test(row.status);
  return {
    id: row.upid,
    label: [row.type, row.id].filter(Boolean).join(" ") || row.upid,
    target: `${row.node ?? ""}${row.user ? ` · ${row.user}` : ""}${failed && row.status ? ` · ${row.status}` : ""}`,
    status: running ? "running" : failed ? "failed" : "completed",
    progress: running ? 50 : 100,
    createdAt: new Date((row.starttime ?? 0) * 1000).toISOString(),
    source: "server",
  };
}

const powerPath: Record<PowerAction, string> = {
  start: "start",
  stop: "stop",
  shutdown: "shutdown",
  restart: "reboot",
};

let cachedRows: PveClusterRow[] = [];
let sessionInfo: PveSessionInfo | null = null;

function api<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, unknown>) {
  return invoke<T>("pve_api", { method, path, params: params ?? null });
}

function guestRow(id: string): PveClusterRow {
  const vmid = vmidOf(id);
  const row = cachedRows.find((r) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc"));
  if (!row?.node) throw new Error(`Machine ${vmid} introuvable sur le serveur Proxmox (actualisez).`);
  return row;
}

function guestPath(id: string) {
  const row = guestRow(id);
  return { node: row.node!, type: row.type as PveKind, vmid: row.vmid!, base: `/nodes/${row.node}/${row.type}/${row.vmid}` };
}

export const proxmoxProfile = {
  get(): SavedProfile | null {
    try {
      const raw = localStorage.getItem(profileKey);
      return raw ? (JSON.parse(raw) as SavedProfile) : null;
    } catch {
      return null;
    }
  },
  set(profile: SavedProfile) {
    localStorage.setItem(profileKey, JSON.stringify(profile));
  },
  clear() {
    localStorage.removeItem(profileKey);
  },
};

export const proxmoxClient = {
  probe(url: string) {
    return invoke<PveProbe>("pve_probe", { url });
  },

  async login(input: PveLoginInput) {
    const info = await invoke<PveSessionInfo>("pve_login", { input });
    sessionInfo = info;
    proxmoxProfile.set({
      base: info.base,
      fingerprint: info.fingerprint,
      username: input.username.trim(),
      tokenId: input.tokenId?.trim() && input.remember ? input.tokenId.trim() : undefined,
    });
    return info;
  },

  /** Reconnect at start-up — only an API token kept in the keyring allows it. */
  async restore(): Promise<PveSessionInfo | null> {
    const profile = proxmoxProfile.get();
    if (!profile?.tokenId) return null;
    const info = await invoke<PveSessionInfo | null>("pve_restore", {
      input: { url: profile.base, fingerprint: profile.fingerprint, username: profile.username, tokenId: profile.tokenId },
    });
    sessionInfo = info;
    return info;
  },

  /** Sign out and drop the keyring token; the address and trusted certificate stay. */
  async logout() {
    sessionInfo = null;
    cachedRows = [];
    await invoke("pve_logout", { forget: true });
    const profile = proxmoxProfile.get();
    if (profile) proxmoxProfile.set({ base: profile.base, fingerprint: profile.fingerprint, username: profile.username });
  },

  session() {
    return sessionInfo;
  },

  getUser(): VirtuaUser {
    const username = sessionInfo?.username ?? proxmoxProfile.get()?.username ?? "proxmox";
    return { username, displayName: username, role: "ADMIN", canCreate: { vm: true, lxc: true, docker: false } };
  },

  getConnection(): VirtuaConnection {
    const info = sessionInfo;
    return {
      id: "proxmox",
      name: info ? `Proxmox VE ${info.version}` : "Proxmox VE",
      endpoint: info?.base ?? proxmoxProfile.get()?.base ?? "",
      status: info ? "connected" : "offline",
      username: info?.username ?? "",
      lastSync: new Date().toISOString(),
    };
  },

  async inventory(): Promise<{ resources: VirtuaResource[]; nodes: VirtuaNode[] }> {
    const rows = await api<PveClusterRow[]>("GET", "/cluster/resources");
    cachedRows = rows;
    const resources = rows
      .filter((r) => (r.type === "qemu" || r.type === "lxc") && typeof r.vmid === "number")
      .map(mapGuest)
      .sort((a, b) => (a.proxmox!.vmid - b.proxmox!.vmid));
    const nodes = rows.filter((r) => r.type === "node").map((r) => mapNode(r, resources));
    return { resources, nodes };
  },

  async listTasks(): Promise<VirtuaTask[]> {
    const rows = await api<Array<Parameters<typeof mapTask>[0]>>("GET", "/cluster/tasks");
    return rows.slice(0, 50).map(mapTask);
  },

  runAction(id: string, action: PowerAction) {
    const guest = guestPath(id);
    return api<string>("POST", `${guest.base}/status/${powerPath[action]}`);
  },

  async getConsoleTicket(resource: VirtuaResource, mode: ConsoleMode): Promise<DesktopConsoleTicketResponse> {
    if (mode === "spice") throw new Error("SPICE passe par le proxy de Proxmox : console VNC utilisée.");
    const guest = guestPath(resource.id);
    const console = await invoke<{ url: string; password?: string | null }>("pve_console", {
      node: guest.node,
      kind: guest.type,
      vmid: guest.vmid,
      mode: mode === "text" ? "text" : "vnc",
    });
    return { ticket: "", url: console.url, expiresInMs: 45_000, kind: mode, password: console.password ?? undefined };
  },

  // ── Details / modification ────────────────────────────────────────────────

  guest(id: string) {
    return guestPath(id);
  },

  config(id: string) {
    const guest = guestPath(id);
    return api<Record<string, unknown>>("GET", `${guest.base}/config`);
  },

  /** qemu: POST (async), lxc: PUT. `delete` lists keys to remove. */
  updateConfig(id: string, changes: Record<string, unknown>) {
    const guest = guestPath(id);
    return api("PUT", `${guest.base}/config`, changes);
  },

  resizeDisk(id: string, disk: string, size: string) {
    const guest = guestPath(id);
    return api("PUT", `${guest.base}/resize`, { disk, size });
  },

  async listSnapshots(id: string) {
    const guest = guestPath(id);
    const rows = await api<Array<{ name: string; description?: string; snaptime?: number; parent?: string; vmstate?: number }>>("GET", `${guest.base}/snapshot`);
    return rows
      .filter((r) => r.name !== "current")
      .map((r) => ({ id: r.name, name: r.name, description: r.description ?? "", createdAt: r.snaptime ? new Date(r.snaptime * 1000).toISOString() : "", parent: r.parent }));
  },

  createSnapshot(id: string, name: string, description?: string) {
    const guest = guestPath(id);
    return api("POST", `${guest.base}/snapshot`, { snapname: name, description });
  },

  rollbackSnapshot(id: string, name: string) {
    const guest = guestPath(id);
    return api("POST", `${guest.base}/snapshot/${name}/rollback`);
  },

  deleteSnapshot(id: string, name: string) {
    const guest = guestPath(id);
    return api("DELETE", `${guest.base}/snapshot/${name}`);
  },

  deleteGuest(id: string) {
    const guest = guestPath(id);
    return api("DELETE", guest.base, { purge: true, "destroy-unreferenced-disks": true });
  },

  // ── Creation ──────────────────────────────────────────────────────────────

  nodes() {
    return cachedRows.filter((r) => r.type === "node" && r.status === "online").map((r) => r.node!).filter(Boolean);
  },

  nextId() {
    return api<string | number>("GET", "/cluster/nextid").then((v) => Number(v));
  },

  /** Storages of a node able to hold `content` (images, rootdir, iso, vztmpl). */
  async storages(node: string, content: "images" | "rootdir" | "iso" | "vztmpl") {
    const rows = await api<Array<{ storage: string; type: string; avail?: number; total?: number; active?: number; enabled?: number }>>("GET", `/nodes/${node}/storage`, { content, enabled: 1 });
    return rows.filter((r) => r.active !== 0).map((r) => ({ storage: r.storage, type: r.type, availGib: r.avail ? Math.round((r.avail / 1024 ** 3) * 10) / 10 : undefined }));
  },

  async content(node: string, storage: string, content: "iso" | "vztmpl") {
    const rows = await api<Array<{ volid: string; size?: number }>>("GET", `/nodes/${node}/storage/${storage}/content`, { content });
    return rows.map((r) => ({ volid: r.volid, label: r.volid.replace(/^[^/]*\//, ""), sizeGib: r.size ? Math.round((r.size / 1024 ** 3) * 10) / 10 : undefined }));
  },

  async bridges(node: string) {
    const rows = await api<Array<{ iface: string; type: string; active?: number }>>("GET", `/nodes/${node}/network`, { type: "any_bridge" });
    return rows.map((r) => r.iface).sort();
  },

  createVm(node: string, params: Record<string, unknown>) {
    return api<string>("POST", `/nodes/${node}/qemu`, params);
  },

  createContainer(node: string, params: Record<string, unknown>) {
    return api<string>("POST", `/nodes/${node}/lxc`, params);
  },
};
