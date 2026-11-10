import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { nodeBaseArch, parseVmtmpListing, registerDisposableRoutes, type DisposableRouteDeps } from "./disposable.js";

describe("parseVmtmpListing", () => {
  it("keeps the .vmtmp files at the folder root of an nginx autoindex", () => {
    const html = `<html><body><h1>Index of /TEMPLATES/VM/AMD64/</h1><pre><a href="../">../</a>
<a href="debian13-amd64.vmtmp">debian13-amd64.vmtmp</a>     01-Nov-2026 12:00   1.1G
<a href="Debian%2013%20(base).vmtmp">Debian 13 (base).vmtmp</a> 01-Nov-2026 12:00   1.0G
<a href="debian-12.tar.gz">debian-12.tar.gz</a>     01-Nov-2026 12:00   900M
<a href="sub/">sub/</a>
<a href="..%2Fevil.vmtmp">x</a>
</pre></body></html>`;
    expect(parseVmtmpListing(html)).toEqual(["debian13-amd64.vmtmp", "Debian 13 (base).vmtmp"]);
  });

  it("maps the node arch", () => {
    expect(nodeBaseArch("x64")).toBe("amd64");
    expect(nodeBaseArch("arm64")).toBe("arm64");
  });
});

function setup(options: { admin?: boolean; local?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE qemu_vms (vm_name TEXT PRIMARY KEY, user_id INTEGER, description TEXT, tags TEXT, node_name TEXT)");
  const runnerCalls: Array<{ action: string; params: unknown }> = [];
  const forgotten: string[] = [];
  const permissionChecks: string[] = [];
  const deps: DisposableRouteDeps = {
    db,
    callRunner: (async (action: string, params?: unknown) => {
      runnerCalls.push({ action, params });
      if (action === "qemu_disposable_launch") return { ok: true, name: "jetable-debian13-1", baseId: "debian13-amd64-1" };
      return { ok: true };
    }) as DisposableRouteDeps["callRunner"],
    requireAuth: () => {},
    requireAdmin: () => {
      if (!options.admin) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    },
    actorOf: () => ({ userId: 7, role: options.admin ? "ADMIN" : "USER", username: "u", ip: "127.0.0.1" }),
    hasVmPermission: (_actor, name, permission) => {
      permissionChecks.push(`${name}:${permission}`);
      return true;
    },
    checkVmCreateAllowed: () => ({ ok: true }),
    checkPermission: () => ({ ok: true }),
    resolveVmDiskPool: (name) => (name === "local" ? { path: "/var/lib/auxinux/pools/local" } : undefined),
    isLocalVm: async () => options.local !== false,
    localNodeName: () => "node1",
    forgetVm: async (name) => { forgotten.push(name); },
    createTask: () => ({ id: "t1" }),
    runInstantTask: (_task, _ip, fn) => fn(),
    runTrackedTask: async (_task, _ip, fn) => { await fn({ update: () => {} }); },
    publicTask: (task) => ({ id: task.id }),
    onRunnerProgress: () => () => {},
    downloadToFile: vi.fn(async () => {}),
    depotBase: () => "https://dep.example/TEMPLATES/",
    scratchDir: "/tmp",
  };
  const app = Fastify();
  // The session decorator is normally added by @fastify/session.
  app.decorateRequest("session", null as never);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { session: unknown }).session = { userId: 7, role: options.admin ? "ADMIN" : "USER", username: "u" };
  });
  registerDisposableRoutes(app, deps);
  return { app, db, runnerCalls, forgotten, permissionChecks };
}

describe("disposable routes", () => {
  it("launches a disposable on the pool path and records its owner", async () => {
    const { app, db, runnerCalls } = setup();
    const res = await app.inject({ method: "POST", url: "/api/disposable/launch", payload: { baseId: "debian13-amd64-1", storagePool: "local", strict: true, noNetwork: true } });
    expect(res.statusCode).toBe(200);
    expect(runnerCalls[0]).toEqual({
      action: "qemu_disposable_launch",
      params: { baseId: "debian13-amd64-1", storagePool: "/var/lib/auxinux/pools/local", strict: true, noNetwork: true, bridge: "virbr0", start: true },
    });
    expect(db.prepare("SELECT user_id, tags FROM qemu_vms WHERE vm_name = ?").get("jetable-debian13-1")).toEqual({ user_id: 7, tags: `["jetable"]` });
  });

  it("refuses an unknown pool and a bad base id before calling the runner", async () => {
    const { app, runnerCalls } = setup();
    expect((await app.inject({ method: "POST", url: "/api/disposable/launch", payload: { baseId: "debian13-amd64-1", storagePool: "nas" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/disposable/launch", payload: { baseId: "../x", storagePool: "local" } })).statusCode).toBe(400);
    expect(runnerCalls).toEqual([]);
  });

  it("reserves base management to admins", async () => {
    const user = setup();
    expect((await user.app.inject({ method: "POST", url: "/api/disposable/bases", payload: { vmName: "win11" } })).statusCode).toBe(403);
    expect((await user.app.inject({ method: "DELETE", url: "/api/disposable/bases/x" })).statusCode).toBe(403);
    const admin = setup({ admin: true });
    const res = await admin.app.inject({ method: "POST", url: "/api/disposable/bases", payload: { vmName: "win11", os: "windows11", removeSource: true } });
    expect(res.statusCode).toBe(202);
    expect(admin.runnerCalls[0]).toMatchObject({ action: "qemu_base_create", params: { name: "win11", os: "windows11", removeSource: true } });
    // The runner deleted the source VM: its ownership/ACL rows go too.
    expect(admin.forgotten).toEqual(["win11"]);
  });

  it("checks the right permission per stop action and cleans up a discarded VM", async () => {
    const { app, runnerCalls, forgotten, permissionChecks } = setup();
    expect((await app.inject({ method: "POST", url: "/api/vms/jetable-1/disposable/discard" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/vms/jetable-1/disposable/reset" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/vms/jetable-1/disposable/convert" })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/vms/jetable-1/disposable/explode" })).statusCode).toBe(400);
    expect(permissionChecks).toEqual(["jetable-1:delete", "jetable-1:modify", "jetable-1:modify"]);
    expect(runnerCalls.map((c) => (c.params as { action: string }).action)).toEqual(["discard", "reset", "convert"]);
    expect(forgotten).toEqual(["jetable-1"]);
  });

  it("refuses disposable actions on a VM of another node", async () => {
    const { app, runnerCalls } = setup({ local: false });
    expect((await app.inject({ method: "POST", url: "/api/vms/remote-vm/disposable/reset" })).statusCode).toBe(400);
    expect(runnerCalls).toEqual([]);
  });
});
