import * as fs from "fs";
import Fastify, { type FastifyInstance } from "fastify";
import * as argon2 from "argon2";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseInfo, DesktopCreateResourceInput, DesktopUpdateResourceInput } from "@auxinux/shared";
import { desktopVmCreateInput, registerDesktopApi, type DesktopActor, type DesktopResourceRow } from "./desktop.js";
import { getDb } from "./db.js";

// db.ts reads its path at import time (desktop.ts imports it): point it at a
// temp directory before any import runs, so the real migration runs there.
const dataDir = await vi.hoisted(async () => {
  const fsMod = await import("fs");
  const osMod = await import("os");
  const pathMod = await import("path");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "api-desktop-"));
  process.env.AUXINUX_DATA_DIR = dir;
  process.env.AUXINUX_DB = pathMod.join(dir, "auxinux.sqlite");
  return dir;
});

describe("desktopVmCreateInput (desktop body → POST /api/vms schema)", () => {
  const vm = (extra: Partial<DesktopCreateResourceInput>): DesktopCreateResourceInput => ({ type: "vm", name: "dos622", ...extra });

  it("forwards the period PC choices", () => {
    const result = desktopVmCreateInput(vm({ machine: "pc", cpuModel: "386", periodSpeed: true, diskBus: "ide", networkModel: "ne2k_pci", floppyId: "dos622-1.img" }), "local");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      name: "dos622", machine: "pc", cpuModel: "386", periodSpeed: true, diskBus: "ide",
      networkModel: "ne2k_pci", floppyFile: "dos622-1.img", storagePool: "local", arch: "x86_64",
    });
  });

  it("keeps the old defaults and lets `auto` pick i440FX for an IDE disk", () => {
    const plain = desktopVmCreateInput(vm({}), "local");
    expect(plain.ok && plain.data).toMatchObject({ machine: "q35", cpuModel: "auto", periodSpeed: false, diskBus: "virtio", networkModel: "virtio" });
    const ide = desktopVmCreateInput(vm({ machine: "auto", diskBus: "ide" }), "local");
    expect(ide.ok && ide.data.machine).toBe("pc");
    const arm = desktopVmCreateInput(vm({ architecture: "arm64" }), "local");
    expect(arm.ok && arm.data).toMatchObject({ arch: "aarch64", machine: "virt", uefi: true });
  });

  it("applies the web route's hardware rules", () => {
    const ideOnQ35 = desktopVmCreateInput(vm({ machine: "q35", diskBus: "ide" }), "local");
    expect(ideOnQ35).toMatchObject({ ok: false, error: expect.stringMatching(/IDE/) });
    expect(desktopVmCreateInput(vm({ machine: "pc", secureBoot: true }), "local")).toMatchObject({ ok: false, error: expect.stringMatching(/Secure Boot/) });
    expect(desktopVmCreateInput(vm({ architecture: "arm64", machine: "pc" }), "local").ok).toBe(false);
    expect(desktopVmCreateInput(vm({ architecture: "arm64", cpuModel: "486" }), "local").ok).toBe(false);
    expect(desktopVmCreateInput(vm({ architecture: "arm64", networkModel: "pcnet" }), "local").ok).toBe(false);
  });
});

// ── Over the real routes with an in-process DB and fake node services ───────
describe("desktop API: old computers, quick create, disposable VMs", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let makerId = 0;
  let viewerId = 0;

  const calls = {
    create: [] as DesktopCreateResourceInput[],
    update: [] as DesktopUpdateResourceInput[],
    createOptionsCtx: [] as Array<{ userId: number; role: string }>,
    quickCreate: [] as Array<{ actor: DesktopActor; input: unknown }>,
    launch: [] as Array<{ actor: DesktopActor; input: unknown }>,
    disposable: [] as Array<{ name: string; action: string }>,
  };
  let vmState = "running";

  const rows = (): DesktopResourceRow[] => [
    {
      type: "vm", node: "node1", name: "dos", state: vmState, cpuCores: 1, memoryMib: 32,
      machine: "pc", cpuModel: "486", periodSpeed: true, diskBus: "ide", floppy: "dos622-1.img",
      disposable: null, autoInstall: false,
    },
    {
      type: "vm", node: "node1", name: "jetable-debian13-1", state: "running",
      machine: "q35", cpuModel: "auto", periodSpeed: false, diskBus: "virtio", floppy: null,
      disposable: { baseId: "debian13-amd64-1", baseLabel: "Debian 13", strict: true }, autoInstall: false,
    },
  ];

  const base: BaseInfo = {
    id: "debian13-amd64-1", label: "Debian 13", os: "debian13", architecture: "amd64", guestOs: "linux",
    cpu: 2, memoryMib: 4096, diskGib: 60, diskBus: "virtio", networkModel: "virtio", gpuModel: "virtio",
    tpm2: false, secureBoot: false, createdAt: "", source: "local", format: 1,
    sizeBytes: 3_000_000_000, inUse: 1, usedBy: ["jetable-debian13-1"],
  };

  /** Owner of "dos" and of the disposable VM: maker. The viewer may only look. */
  const owns = (userId: number, name: string) => userId === makerId && (name === "dos" || name === "jetable-debian13-1");

  async function login(username: string, password: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/desktop/auth/login", payload: { username, password, deviceName: "test" } });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  async function handleOf(token: string, name: string): Promise<string> {
    const list = await app.inject({ method: "GET", url: "/api/desktop/resources", headers: bearer(token) });
    return (list.json() as Array<{ id: string; name: string }>).find((r) => r.name === name)!.id;
  }
  const auditRows = (action: string) =>
    db.prepare("SELECT username, action, result, resource_name FROM audit_logs WHERE action = ? ORDER BY id").all(action) as Array<{ username: string; action: string; result: string; resource_name: string | null }>;

  beforeAll(async () => {
    db = getDb();
    makerId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'USER')").run("maker", await argon2.hash("maker-pass")).lastInsertRowid);
    viewerId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'USER')").run("viewer", await argon2.hash("viewer-pass")).lastInsertRowid);

    app = Fastify();
    registerDesktopApi({
      app,
      db,
      getTokenSecret: () => "s".repeat(64),
      getClientIp: () => "10.0.0.9",
      hasResourcePermission: (userId, role, _type, name, perm) =>
        role === "ADMIN" || owns(userId, name) || (perm === "view" && userId === viewerId),
      // Quota + allow_vm_create: only the maker may create.
      userCanCreate: (userId) => userId === makerId,
      listResourcesForDesktop: async () => rows(),
      runResourceAction: async () => ({ ok: true }),
      createSnapshotForResource: async () => ({ ok: true }),
      createResource: async (_ctx, input) => {
        calls.create.push(input);
        return { node: "node1", name: input.name };
      },
      updateResource: async (res, patch) => {
        calls.update.push(patch);
        // Like the runner: adding drive A: to a running VM waits for the next start.
        if (patch.floppyId) return { node: res.node, name: res.name, pendingRestart: true, messages: ["drive A: added"] };
        return { node: res.node, name: res.name };
      },
      deleteResource: async () => {},
      getCreateOptions: async (_type, ctx) => {
        calls.createOptionsCtx.push(ctx);
        return {
          nodes: [{ id: "node1", name: "node1" }], images: [], networks: [], defaults: {},
          hardware: { machines: ["auto", "q35", "pc"], cpus: ["auto", "486"], diskBuses: ["virtio", "ide"], networkModels: ["virtio", "ne2k_pci"], periodSpeed: true },
          floppies: [{ id: "dos622-1.img", name: "dos622-1.img", label: "MS-DOS 6.22 (1)" }],
          features: { quickCreate: true, disposable: true },
        };
      },
      listRecentTasks: () => [],
      getTask: () => null,
      issueConsoleTicket: async () => ({ ticketId: "t", url: "wss://x", ttlMs: 1000 }),
      getWebSessionUser: () => null,
      quickCreate: async (actor, input) => {
        calls.quickCreate.push({ actor, input });
        if (input.node && input.node !== "node1") throw Object.assign(new Error("Quick create is only available on node1"), { desktopError: true, statusCode: 400 });
        return { taskId: "task-1", node: "node1", name: input.name ?? "debian-13" };
      },
      listDisposableBases: async () => [base],
      launchDisposable: async (actor, input) => {
        calls.launch.push({ actor, input });
        return { node: "node1", name: "jetable-debian13-1" };
      },
      disposableAction: async (_actor, res, action) => {
        calls.disposable.push({ name: res.name, action });
        return action === "convert" ? { status: 202, body: { id: "task-9", status: "running" } } : { status: 200, body: { ok: true } };
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const list of Object.values(calls)) list.length = 0;
    vmState = "running";
  });

  it("serves the hardware catalog to a user who may create VMs, scoped to that user", async () => {
    const token = await login("maker", "maker-pass");
    const res = await app.inject({ method: "GET", url: "/api/desktop/resources/create-options?type=vm", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hardware: { machines: ["auto", "q35", "pc"], periodSpeed: true },
      floppies: [{ id: "dos622-1.img" }],
      features: { quickCreate: true, disposable: true },
    });
    expect(calls.createOptionsCtx).toEqual([{ userId: makerId, role: "USER" }]);
  });

  it("forwards machine, CPU model, period speed, disk bus and floppy on create", async () => {
    const token = await login("maker", "maker-pass");
    const res = await app.inject({
      method: "POST", url: "/api/desktop/resources", headers: bearer(token),
      payload: { type: "vm", name: "win311", machine: "pc", cpuModel: "386", periodSpeed: true, diskBus: "ide", floppyId: "dos622-1.img", networkModel: "pcnet" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.create).toEqual([expect.objectContaining({ machine: "pc", cpuModel: "386", periodSpeed: true, diskBus: "ide", floppyId: "dos622-1.img", networkModel: "pcnet" })]);
    expect(auditRows("desktop.vm.create").at(-1)).toMatchObject({ username: "maker", result: "success", resource_name: "win311" });
  });

  it("validates hardware fields before anything runs", async () => {
    const token = await login("maker", "maker-pass");
    const bad = [
      { type: "vm", name: "a", cpuModel: "host", periodSpeed: true },
      { type: "vm", name: "a", cpuModel: "z80" },
      { type: "vm", name: "a", machine: "virt" },
      { type: "vm", name: "a", diskBus: "floppy" },
      { type: "vm", name: "a", floppyId: "../secret.img" },
    ];
    for (const payload of bad) {
      expect((await app.inject({ method: "POST", url: "/api/desktop/resources", headers: bearer(token), payload })).statusCode).toBe(400);
    }
    expect(calls.create).toEqual([]);
  });

  it("refuses create, quick create and disposable launch to a user without create rights (and audits it)", async () => {
    const token = await login("viewer", "viewer-pass");
    const create = await app.inject({ method: "POST", url: "/api/desktop/resources", headers: bearer(token), payload: { type: "vm", name: "dos2", cpuModel: "486", periodSpeed: true } });
    expect(create.statusCode).toBe(403);
    const quick = await app.inject({ method: "POST", url: "/api/desktop/quick-create", headers: bearer(token), payload: { os: "debian13" } });
    expect(quick.statusCode).toBe(403);
    const launch = await app.inject({ method: "POST", url: "/api/desktop/disposable/launch", headers: bearer(token), payload: { baseId: base.id } });
    expect(launch.statusCode).toBe(403);
    const options = await app.inject({ method: "GET", url: "/api/desktop/resources/create-options?type=vm", headers: bearer(token) });
    expect(options.statusCode).toBe(403);
    expect(calls.create).toEqual([]);
    expect(calls.quickCreate).toEqual([]);
    expect(calls.launch).toEqual([]);
    expect(auditRows("desktop.vm.create").at(-1)).toMatchObject({ username: "viewer", result: "error" });
    expect(auditRows("desktop.vm.quick-create").at(-1)).toMatchObject({ username: "viewer", result: "error" });
    expect(auditRows("desktop.vm.disposable.launch").at(-1)).toMatchObject({ username: "viewer", result: "error" });
  });

  it("lists VMs with their hardware, floppy, disposable and install state", async () => {
    const token = await login("viewer", "viewer-pass");
    const list = (await app.inject({ method: "GET", url: "/api/desktop/resources", headers: bearer(token) })).json() as Array<Record<string, unknown>>;
    expect(list.find((r) => r.name === "dos")).toMatchObject({
      machine: "pc", cpuModel: "486", periodSpeed: true, diskBus: "ide", floppy: "dos622-1.img", disposable: null, autoInstall: false,
    });
    const jetable = list.find((r) => r.name === "jetable-debian13-1")!;
    expect(jetable.disposable).toEqual({ baseId: "debian13-amd64-1", baseLabel: "Debian 13", strict: true });
    const one = await app.inject({ method: "GET", url: `/api/desktop/resources/${jetable.id as string}`, headers: bearer(token) });
    expect(one.json()).toMatchObject({ id: jetable.id, floppy: null, disposable: { strict: true } });
  });

  it("changes hardware on PATCH, says it waits for the next start, and needs the media right for drive A:", async () => {
    const maker = await login("maker", "maker-pass");
    const id = await handleOf(maker, "dos");
    const hw = await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(maker), payload: { machine: "q35", cpuModel: "pentium", periodSpeed: true } });
    expect(hw.statusCode).toBe(200);
    expect(hw.json()).toMatchObject({ ok: true, pendingRestart: true, resource: { id } });
    expect(calls.update).toEqual([{ machine: "q35", cpuModel: "pentium", periodSpeed: true }]);

    vmState = "stopped";
    const stopped = await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(maker), payload: { cpuModel: "486" } });
    expect(stopped.json().pendingRestart).toBe(false);

    const floppy = await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(maker), payload: { floppyId: "dos622-2.img" } });
    expect(floppy.json()).toMatchObject({ pendingRestart: true, messages: ["drive A: added"] });
    expect((await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(maker), payload: { floppyId: "" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(maker), payload: { cpuModel: "max", periodSpeed: true } })).statusCode).toBe(400);

    // The viewer has neither modify nor media on "dos".
    const viewer = await login("viewer", "viewer-pass");
    expect((await app.inject({ method: "PATCH", url: `/api/desktop/resources/${id}`, headers: bearer(viewer), payload: { floppyId: "" } })).statusCode).toBe(403);
    expect(calls.update).toHaveLength(4);
  });

  it("quick-creates on the local node and answers a task + an opaque handle", async () => {
    const token = await login("maker", "maker-pass");
    const res = await app.inject({ method: "POST", url: "/api/desktop/quick-create", headers: bearer(token), payload: { os: "debian13", name: "deb" } });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { taskId: string; resourceId: string; name: string };
    expect(body).toMatchObject({ taskId: "task-1", name: "deb" });
    expect(db.prepare("SELECT resource_type, node_name, resource_name FROM desktop_resource_handles WHERE id = ?").get(body.resourceId))
      .toEqual({ resource_type: "vm", node_name: "node1", resource_name: "deb" });
    expect(calls.quickCreate[0].actor).toEqual({ userId: makerId, role: "USER", username: "maker", ip: "10.0.0.9" });

    const remote = await app.inject({ method: "POST", url: "/api/desktop/quick-create", headers: bearer(token), payload: { os: "debian13", node: "srv02" } });
    expect(remote.statusCode).toBe(400);
    expect(remote.json().error).toMatch(/only available/);
    expect((await app.inject({ method: "POST", url: "/api/desktop/quick-create", headers: bearer(token), payload: { os: "macos" } })).statusCode).toBe(400);
  });

  it("lists bases, launches a disposable VM and runs its stop actions by handle", async () => {
    const token = await login("maker", "maker-pass");
    const bases = await app.inject({ method: "GET", url: "/api/desktop/disposable/bases", headers: bearer(token) });
    expect(bases.json()).toEqual([{ id: base.id, label: "Debian 13", os: "debian13", architecture: "amd64", cpu: 2, memoryMib: 4096, diskGib: 60, size: 3_000_000_000, inUse: 1 }]);

    const launch = await app.inject({ method: "POST", url: "/api/desktop/disposable/launch", headers: bearer(token), payload: { baseId: base.id, strict: true, network: "isolated" } });
    expect(launch.statusCode).toBe(200);
    expect(launch.json()).toMatchObject({ type: "vm", name: "jetable-debian13-1", disposable: { baseId: base.id }, permissions: { canDelete: true } });
    expect(calls.launch[0].input).toEqual({ baseId: base.id, strict: true, network: "isolated" });
    expect((await app.inject({ method: "POST", url: "/api/desktop/disposable/launch", headers: bearer(token), payload: { baseId: base.id, network: "bridge" } })).statusCode).toBe(400);

    const id = launch.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/desktop/resources/${id}/disposable/reset`, headers: bearer(token) })).json()).toEqual({ ok: true, result: { ok: true } });
    const convert = await app.inject({ method: "POST", url: `/api/desktop/resources/${id}/disposable/convert`, headers: bearer(token) });
    expect(convert.statusCode).toBe(202);
    expect(convert.json()).toMatchObject({ ok: true, taskId: "task-9" });
    expect((await app.inject({ method: "POST", url: `/api/desktop/resources/${id}/disposable/explode`, headers: bearer(token) })).statusCode).toBe(400);
    expect(calls.disposable).toEqual([{ name: "jetable-debian13-1", action: "reset" }, { name: "jetable-debian13-1", action: "convert" }]);
    expect(auditRows("desktop.vm.disposable.convert").at(-1)).toMatchObject({ username: "maker", result: "success" });

    // Someone who cannot even see the VM gets nothing done.
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'USER')").run("stranger", await argon2.hash("stranger-pass"));
    const stranger = await login("stranger", "stranger-pass");
    expect((await app.inject({ method: "POST", url: `/api/desktop/resources/${id}/disposable/discard`, headers: bearer(stranger) })).statusCode).toBe(403);
    expect(calls.disposable).toHaveLength(2);
  });
});
