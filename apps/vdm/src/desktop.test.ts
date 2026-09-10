import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import * as argon2 from "argon2";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatUptime,
  parseDockerUptimeSeconds,
  permissionsForRole,
  registerVdmDesktopApi,
  taskStatusForDesktop,
  vdmRoleToDesktopRole,
} from "./desktop.js";
import { NodeRequestError, type VdmNodeRow } from "./nodeClient.js";

describe("VDM ↔ Desktop role mapping", () => {
  it("only a VDM admin gets the desktop admin role", () => {
    expect(vdmRoleToDesktopRole("admin")).toBe("ADMIN");
    expect(vdmRoleToDesktopRole("viewer")).toBe("USER");
    expect(vdmRoleToDesktopRole("anything-else")).toBe("USER");
  });

  it("a viewer may look and open a console, nothing more", () => {
    const viewer = permissionsForRole("USER");
    expect(viewer.canView).toBe(true);
    expect(viewer.canConsole).toBe(true);
    expect(viewer.canPower).toBe(false);
    expect(viewer.canSnapshot).toBe(false);
    expect(viewer.canModify).toBe(false);
    expect(viewer.canDelete).toBe(false);
    expect(viewer.canCreate).toBe(false);
  });

  it("an admin gets everything", () => {
    expect(Object.values(permissionsForRole("ADMIN")).every(Boolean)).toBe(true);
  });
});

describe("presentation helpers", () => {
  it("maps every VDM task state onto one the client knows", () => {
    expect(taskStatusForDesktop("pending")).toBe("queued");
    expect(taskStatusForDesktop("running")).toBe("running");
    expect(taskStatusForDesktop("completed")).toBe("completed");
    expect(taskStatusForDesktop("failed")).toBe("failed");
    // A VDM restart leaves tasks needing attention: that is a failure, not limbo.
    expect(taskStatusForDesktop("recovery-required")).toBe("failed");
  });

  it("reads Docker's human uptime string", () => {
    expect(parseDockerUptimeSeconds("Up 3 hours")).toBe(10800);
    expect(parseDockerUptimeSeconds("Up About an hour")).toBeUndefined();
    expect(parseDockerUptimeSeconds("Up 2 days (healthy)")).toBe(172800);
    expect(parseDockerUptimeSeconds("Exited (0) 5 minutes ago")).toBeUndefined();
    expect(parseDockerUptimeSeconds(undefined)).toBeUndefined();
  });

  it("formats uptime the way the client displays it", () => {
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3700)).toBe("1h 1m");
    expect(formatUptime(90061)).toBe("1j 1h");
    expect(formatUptime(undefined)).toBeUndefined();
  });
});

// ── End-to-end over the real routes, an in-process DB and a fake node ───────
describe("desktop API served by the VDM", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let dataDir: string;
  const settings = new Map<string, string>();

  const node: VdmNodeRow = {
    id: 1, name: "node-a", display_name: "Node A", api_url: "http://10.0.0.10:8441",
    auth_token: "token", enabled: 1, status: "online", last_seen_at: null, notes: null,
    created_at: "", updated_at: "",
  };

  /** Minimal stand-in for a Virtua node's internal API. */
  const nodeResponses: Record<string, unknown> = {
    "/api/internal/vms": [{ name: "web-01", state: "running", vcpus: 4, memoryMb: 8192, qemuAgentEnabled: true }],
    "/api/internal/vms/web-01/stats": { cpuPercent: 12.34, memPercent: 42, uptimeSeconds: 7200, ipAddresses: ["10.0.0.50"] },
    "/api/internal/lxc": [{ name: "dns-01", state: "running", cpus: 1, memoryMb: 512, ipAddress: "10.0.0.60/24" }],
    "/api/internal/lxc/dns-01/stats": { cpuPercent: 1, memUsedBytes: 128, memTotalBytes: 512, uptimeSeconds: 60 },
    "/api/internal/docker/containers": [{ id: "abc123", name: "traefik", state: "running", image: "traefik:v3.0", status: "Up 3 hours" }],
    "/api/internal/docker/containers/abc123/stats": { cpuPercent: 2, memPercent: 5 },
  };
  const nodeCalls: Array<{ path: string; method: string }> = [];
  /** Set to make the next node call fail, then cleared. */
  let failNextNodeCall: NodeRequestError | null = null;
  /** Counts full inventory sweeps, to prove the shared snapshot works. */
  let inventorySweeps = 0;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdm-desktop-"));
    process.env.AUXINUX_VDM_DATA_DIR = dataDir;
    process.env.AUXINUX_VDM_DB = path.join(dataDir, "vdm.sqlite");
    // Import after the env is set so the real migration runs on a temp file.
    const { getDb } = await import("./db.js");
    db = getDb();
    db.prepare("INSERT INTO vdm_users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)")
      .run("admin", await argon2.hash("correct-horse"));
    db.prepare("INSERT INTO vdm_users (username, password_hash, role, must_change_password) VALUES (?, ?, 'viewer', 0)")
      .run("watcher", await argon2.hash("watch-only"));
    db.prepare("INSERT INTO vdm_users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 1)")
      .run("fresh", await argon2.hash("admin123"));

    app = Fastify();
    registerVdmDesktopApi({
      app,
      db,
      getClientIp: () => "10.0.0.9",
      enabledNodes: () => [node],
      getEnabledNode: (name) => {
        if (name !== node.name) throw Object.assign(new Error("Node not found"), { statusCode: 404 });
        return node;
      },
      fetchNode: async <T>(_node: VdmNodeRow, pathname: string, init?: RequestInit) => {
        if (failNextNodeCall) {
          const error = failNextNodeCall;
          failNextNodeCall = null;
          throw error;
        }
        nodeCalls.push({ path: pathname, method: (init?.method ?? "GET").toUpperCase() });
        return (nodeResponses[pathname] ?? { ok: true }) as T;
      },
      tryFetchNode: async <T>(_node: VdmNodeRow, pathname: string, fallback: T) => {
        if (pathname === "/api/internal/vms") inventorySweeps += 1;
        return (nodeResponses[pathname] ?? fallback) as T;
      },
      relayConsoleTicket: async (_node, internalPath, kind) => {
        nodeCalls.push({ path: internalPath, method: "POST" });
        return { ticket: `vdm-ticket-${kind}`, kind, ...(kind === "spice" ? { password: "spice-pw" } : {}) };
      },
      getWebSessionUser: () => ({ userId: 1, role: "ADMIN", username: "admin" }),
      getSetting: (key) => settings.get(key) ?? null,
      setSetting: (key, value) => { settings.set(key, value); },
      log: () => {},
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AUXINUX_VDM_DATA_DIR;
    delete process.env.AUXINUX_VDM_DB;
  });

  const login = async (username: string, password: string) => app.inject({
    method: "POST",
    url: "/api/desktop/auth/login",
    payload: { username, password, deviceName: "Test Desktop", installationId: `install-${username}` },
  });

  it("accepts a username/password login without any CSRF token", async () => {
    const res = await login("admin", "correct-horse");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.device.name).toBe("Test Desktop");
  });

  it("refuses a wrong password and an unknown user alike", async () => {
    expect((await login("admin", "wrong")).statusCode).toBe(401);
    expect((await login("ghost", "whatever")).statusCode).toBe(401);
  });

  it("tells a fresh account to change its password in the web panel first", async () => {
    const res = await login("fresh", "admin123");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/web panel/i);
  });

  it("reports the account and its creation rights", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({ method: "GET", url: "/api/desktop/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { username: "admin", role: "ADMIN" },
      capabilities: { isAdmin: true, manager: "vdm", canCreate: { vm: true, lxc: true, docker: true } },
    });
  });

  it("refuses a request without a bearer token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/desktop/resources" })).statusCode).toBe(401);
  });

  it("aggregates every node's VMs, containers and Docker services", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const resources = res.json() as Array<Record<string, unknown>>;
    expect(resources.map((r) => r.type).sort()).toEqual(["docker", "lxc", "vm"]);

    const vm = resources.find((r) => r.type === "vm")!;
    expect(vm).toMatchObject({ name: "web-01", node: "node-a", state: "running", cpuCores: 4, memoryMib: 8192 });
    expect(vm.cpuPercent).toBe(12.3);
    expect(vm.ipAddress).toBe("10.0.0.50");
    expect(vm.uptime).toBe("2h 0m");
    // The client only ever receives an opaque handle, never (node, name).
    expect(String(vm.id)).toMatch(/^[0-9a-f-]{36}$/);

    const container = resources.find((r) => r.type === "lxc")!;
    expect(container.ipAddress).toBe("10.0.0.60");
    const docker = resources.find((r) => r.type === "docker")!;
    expect(docker).toMatchObject({ name: "abc123", displayName: "traefik", image: "traefik:v3.0" });
    expect(docker.uptimeSeconds).toBe(10800);
  });

  it("resolves a handle back to the right node for a power action", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const resources = (await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string; type: string }>;
    const vmId = resources.find((r) => r.type === "vm")!.id;
    nodeCalls.length = 0;
    const res = await app.inject({ method: "POST", url: `/api/desktop/resources/${vmId}/actions/stop`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    // "stop" from the desktop is the guest's own clean shutdown.
    expect(nodeCalls).toEqual([{ path: "/api/internal/vms/web-01/shutdown", method: "POST" }]);
  });

  it("refuses an unknown handle without saying whether it exists", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/resources/00000000-0000-4000-8000-000000000000/actions/start",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets a viewer look but not act", async () => {
    const adminToken = (await login("admin", "correct-horse")).json().accessToken;
    const resources = (await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${adminToken}` } })).json() as Array<{ id: string; type: string }>;
    const vmId = resources.find((r) => r.type === "vm")!.id;

    const viewerToken = (await login("watcher", "watch-only")).json().accessToken;
    const list = await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${viewerToken}` } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ permissions: { canPower: boolean } }>)[0].permissions.canPower).toBe(false);

    for (const url of [
      `/api/desktop/resources/${vmId}/actions/start`,
      `/api/desktop/resources/${vmId}/actions/snapshot`,
    ]) {
      const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${viewerToken}` }, payload: { name: "snap" } });
      expect(res.statusCode).toBe(403);
    }
    const del = await app.inject({ method: "DELETE", url: `/api/desktop/resources/${vmId}`, headers: { authorization: `Bearer ${viewerToken}` } });
    expect(del.statusCode).toBe(403);
    const options = await app.inject({ method: "GET", url: "/api/desktop/resources/create-options?type=vm", headers: { authorization: `Bearer ${viewerToken}` } });
    expect(options.statusCode).toBe(403);
  });

  it("issues console tickets the client can turn into a WebSocket URL", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const resources = (await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string; type: string }>;
    const vmId = resources.find((r) => r.type === "vm")!.id;
    const dockerId = resources.find((r) => r.type === "docker")!.id;

    const spice = await app.inject({ method: "POST", url: `/api/desktop/resources/${vmId}/console/spice-ticket`, headers: { authorization: `Bearer ${token}` } });
    expect(spice.statusCode).toBe(200);
    expect(spice.json()).toMatchObject({ kind: "spice", password: "spice-pw" });
    // A relative URL lets the client rebuild it on whatever endpoint it uses.
    expect(spice.json().url).toBe("/api/vdm/ws/console?ticket=vdm-ticket-spice");

    const graphical = await app.inject({ method: "POST", url: `/api/desktop/resources/${vmId}/console/graphical-ticket`, headers: { authorization: `Bearer ${token}` } });
    expect(graphical.json()).toMatchObject({ kind: "graphical" });

    const text = await app.inject({ method: "POST", url: `/api/desktop/resources/${dockerId}/console/text-ticket`, headers: { authorization: `Bearer ${token}` } });
    expect(text.json()).toMatchObject({ kind: "text" });

    // Only VMs have a screen.
    const wrong = await app.inject({ method: "POST", url: `/api/desktop/resources/${dockerId}/console/graphical-ticket`, headers: { authorization: `Bearer ${token}` } });
    expect(wrong.statusCode).toBe(400);
  });

  it("pairs a device with a code minted from the web panel", async () => {
    const minted = await app.inject({ method: "POST", url: "/api/desktop/pairing-codes" });
    expect(minted.statusCode).toBe(200);
    const code = minted.json().code as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const paired = await app.inject({
      method: "POST",
      url: "/api/desktop/devices/pair",
      payload: { pairingCode: code.toLowerCase(), deviceName: "Paired Desktop", installationId: "install-paired" },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.json().accessToken).toBeTruthy();

    // One code, one device.
    const replay = await app.inject({
      method: "POST",
      url: "/api/desktop/devices/pair",
      payload: { pairingCode: code, deviceName: "Thief", installationId: "install-thief" },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rotates the refresh token and rejects the spent one", async () => {
    const first = (await login("admin", "correct-horse")).json();
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/desktop/auth/refresh",
      payload: { refreshToken: first.refreshToken, installationId: "install-admin" },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(first.refreshToken);

    const replay = await app.inject({
      method: "POST",
      url: "/api/desktop/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("cuts a device off as soon as it is revoked", async () => {
    const tokens = (await login("admin", "correct-horse")).json();
    const before = await app.inject({ method: "GET", url: "/api/desktop/me", headers: { authorization: `Bearer ${tokens.accessToken}` } });
    expect(before.statusCode).toBe(200);

    const revoked = await app.inject({ method: "DELETE", url: `/api/desktop/my-devices/${tokens.device.id}` });
    expect(revoked.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/desktop/me", headers: { authorization: `Bearer ${tokens.accessToken}` } });
    expect(after.statusCode).toBe(401);
    const refresh = await app.inject({ method: "POST", url: "/api/desktop/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
    expect(refresh.statusCode).toBe(401);
  });

  it("lists the manager's own tasks", async () => {
    db.prepare(`INSERT INTO vdm_tasks (id, kind, label, source_node, target_node, resource_type, resource_name, status, progress, created_at, updated_at)
      VALUES ('task-1', 'migrate', 'Migrate web-01', 'node-a', 'node-b', 'vm', 'web-01', 'running', 40, datetime('now'), datetime('now'))`).run();
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({ method: "GET", url: "/api/desktop/tasks", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "task-1", label: "Migrate web-01", target: "web-01", status: "running", progress: 40 }),
    ]);
  });

  it("builds the create catalog from what the nodes actually have", async () => {
    nodeResponses["/api/internal/storage/isos"] = [
      { filename: "debian-13.iso", displayName: "Debian 13", type: "iso" },
      { filename: "alpine.tar.gz", type: "lxc_template" },
    ];
    nodeResponses["/api/internal/templates"] = [{ id: "tpl-1", name: "debian-golden", displayName: "Debian doré" }];
    nodeResponses["/api/internal/network/bridges"] = [{ name: "virbr0" }, { name: "br0" }];
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({ method: "GET", url: "/api/desktop/resources/create-options?type=vm", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const options = res.json() as { nodes: Array<{ id: string }>; images: Array<{ id: string; type?: string }>; networks: Array<{ id: string }>; defaults: Record<string, number> };
    expect(options.nodes).toEqual([{ id: "node-a", name: "node-a", label: "Node A" }]);
    expect(options.images.map((i) => i.id)).toEqual(["debian-13.iso", "tpl-1"]);
    expect(options.networks.map((n) => n.id)).toEqual(["virbr0", "br0"]);
    expect(options.defaults).toMatchObject({ cpu: 2, memory: 2048, disk: 20 });

    const badType = await app.inject({ method: "GET", url: "/api/desktop/resources/create-options?type=router", headers: { authorization: `Bearer ${token}` } });
    expect(badType.statusCode).toBe(400);
  });

  it("creates a VM on the chosen node and applies the NIC model afterwards", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    nodeResponses["/api/internal/vms/new-vm"] = { networks: [{ mac: "52:54:00:aa:bb:cc" }] };
    nodeCalls.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/resources",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "vm", name: "new-vm", node: "node-a", cpu: 2, memory: 2048, disk: 20, architecture: "amd64", networkModel: "e1000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource).toMatchObject({ type: "vm", name: "new-vm", node: "node-a" });
    expect(nodeCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/internal/vms",
      "PUT /api/internal/vms/new-vm/network/52%3A54%3A00%3Aaa%3Abb%3Acc",
    ]);
  });

  it("reports a node rejecting the manager's token as a gateway error, not a 401", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const resources = (await app.inject({ method: "GET", url: "/api/desktop/resources", headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string; type: string }>;
    const vmId = resources.find((r) => r.type === "vm")!.id;

    failNextNodeCall = new NodeRequestError("Invalid node token", "node-a", "unauthorized", 401);
    const res = await app.inject({ method: "POST", url: `/api/desktop/resources/${vmId}/actions/start`, headers: { authorization: `Bearer ${token}` } });
    // A 401 here would send the client into a token-refresh loop it can never win.
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("node-a");
  });

  it("shares one inventory sweep between close-together polls", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const headers = { authorization: `Bearer ${token}` };
    // Let any cached snapshot from earlier assertions expire first.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    inventorySweeps = 0;
    await Promise.all([
      app.inject({ method: "GET", url: "/api/desktop/resources", headers }),
      app.inject({ method: "GET", url: "/api/desktop/resources", headers }),
    ]);
    await app.inject({ method: "GET", url: "/api/desktop/resources", headers });
    expect(inventorySweeps).toBe(1);
  });

  it("refuses to create on a node this datacenter does not manage", async () => {
    const token = (await login("admin", "correct-horse")).json().accessToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/resources",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "vm", name: "elsewhere", node: "node-zzz" },
    });
    expect(res.statusCode).toBe(404);
  });
});
