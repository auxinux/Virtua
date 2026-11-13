import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { isReleaseWindowsIso, parseWindowsIsoListing, pickLibraryWindowsIso, registerQuickCreateRoutes, uniqueVmName, type QuickCreateDeps } from "./quickCreate.js";

const GB = 1024 ** 3;

describe("quick create helpers", () => {
  it("picks a big enough library ISO of the right architecture", () => {
    const isos = [
      { filename: "Win11_25H2_French_x64.iso", sizeBytes: 6 * GB },
      { filename: "Windows11-FR_CA-25h2.iso", sizeBytes: 8 * GB },
      { filename: "Win11_Arm64.iso", sizeBytes: 6 * GB },
      { filename: "win11-tools.iso", sizeBytes: 200 * 1024 ** 2 },
      { filename: "debian-13.iso", sizeBytes: 4 * GB },
    ];
    expect(pickLibraryWindowsIso(isos, false)?.filename).toBe("Windows11-FR_CA-25h2.iso");
    expect(pickLibraryWindowsIso(isos, true)?.filename).toBe("Win11_Arm64.iso");
    expect(pickLibraryWindowsIso([isos[3]], false)).toBeUndefined();
  });

  it("prefers a released Windows build to a bigger Insider one", () => {
    expect(isReleaseWindowsIso("Windows11-FR_CA-25h2.iso")).toBe(true);
    expect(isReleaseWindowsIso("Win11_24H2_French_x64.iso")).toBe(true);
    expect(isReleaseWindowsIso("Windows11_Client_x64_fr-ca_26300_9457.iso")).toBe(false);
    const isos = [
      { filename: "Windows11_Client_x64_fr-ca_26300_9457.iso", sizeBytes: 8.7 * GB },
      { filename: "Windows11-FR_CA-25h2.iso", sizeBytes: 8.3 * GB },
    ];
    expect(pickLibraryWindowsIso(isos, false)?.filename).toBe("Windows11-FR_CA-25h2.iso");
    // Only an Insider build: still used (ARM64 today).
    expect(pickLibraryWindowsIso([{ filename: "Windows11_Client_arm64_en-us_26300_9457.iso", sizeBytes: 6 * GB }], true)?.filename).toContain("26300");
  });

  it("reads the depot listing and names VMs uniquely", () => {
    const html = `<a href="../">../</a><a href="Windows11-FR_CA-25h2.iso">x</a><a href="debian.iso">d</a><a href="sub/Win11.iso">s</a>`;
    expect(parseWindowsIsoListing(html)).toEqual(["Windows11-FR_CA-25h2.iso"]);
    expect(uniqueVmName("debian-13", new Set())).toBe("debian-13");
    expect(uniqueVmName("debian-13", new Set(["debian-13", "debian-13-2"]))).toBe("debian-13-3");
  });
});

describe("POST /api/vms/quick-create", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE qemu_vms (vm_name TEXT PRIMARY KEY, user_id INTEGER, description TEXT, tags TEXT, node_name TEXT)");
    const runnerCalls: Array<{ action: string; params: unknown }> = [];
    const netbootDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-netboot-"));
    let finished: Promise<void> = Promise.resolve();
    const downloads: string[] = [];
    const deps: QuickCreateDeps = {
      db,
      callRunner: (async (action: string, params?: unknown) => {
        runnerCalls.push({ action, params });
        if (action === "qemu_vms") return [{ name: "debian-13" }];
        return { ok: true };
      }) as QuickCreateDeps["callRunner"],
      requireAuth: () => {},
      actorOf: () => ({ userId: 3, role: "USER", username: "u", ip: "127.0.0.1" }),
      checkVmCreateAllowed: () => ({ ok: true }),
      resolveVmDiskPool: (name) => (name === "local" ? { path: "/pools/local" } : undefined),
      localNodeName: () => "node1",
      createTask: () => ({ id: "t1" }),
      runTrackedTask: (_task, _ip, fn) => { finished = fn({ update: () => {} }).then(() => {}); return finished; },
      publicTask: (task) => ({ id: task.id }),
      listLibraryIsos: async () => [],
      downloadIso: async (_t, url) => { downloads.push(url); return "/isos/w.iso"; },
      ensureVirtioWin: async () => "/isos/virtio-win.iso",
      downloadToFile: async (_t, url, file) => { fs.writeFileSync(file, `content of ${path.basename(url)}`); },
      depotBase: () => "https://dep.example/TEMPLATES/",
      netbootDir,
      hostArch: "x64",
    };
    const app = Fastify();
    app.decorateRequest("session", null as never);
    registerQuickCreateRoutes(app, deps);
    return { app, db, runnerCalls, netbootDir, downloads, done: () => finished };
  }

  it("downloads and verifies the Debian netboot files, then creates the VM under a free name", async () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const sums = `${sha("content of linux")}  ./netboot/debian-installer/amd64/linux\n${sha("content of initrd.gz")}  ./netboot/debian-installer/amd64/initrd.gz\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sums, { status: 200 })));
    const { app, db, runnerCalls, netbootDir, done } = setup();
    const res = await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "debian13", storagePool: "local" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().name).toBe("debian-13-2");
    await done();
    const create = runnerCalls.find((c) => c.action === "qemu_quick_create")!;
    expect(create.params).toMatchObject({
      os: "debian13",
      name: "debian-13-2",
      storagePool: "/pools/local",
      kernelPath: path.join(netbootDir, "debian-13-amd64", "linux"),
      initrdPath: path.join(netbootDir, "debian-13-amd64", "initrd.gz"),
      makeBase: false,
    });
    expect(db.prepare("SELECT user_id FROM qemu_vms WHERE vm_name = ?").get("debian-13-2")).toEqual({ user_id: 3 });
  });

  it("refuses a checksum mismatch", async () => {
    const sums = `${"0".repeat(64)}  ./netboot/debian-installer/amd64/linux\n${"0".repeat(64)}  ./netboot/debian-installer/amd64/initrd.gz\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sums, { status: 200 })));
    const { app, runnerCalls, done } = setup();
    await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "debian13", storagePool: "local" } });
    await expect(done()).rejects.toThrow(/Checksum mismatch/);
    expect(runnerCalls.some((c) => c.action === "qemu_quick_create")).toBe(false);
  });

  it("takes the largest Windows 11 ISO of the depot by its Content-Length header", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        const size = url.includes("FR_CA") ? 8 * GB : 5 * GB;
        return new Response(null, { status: 200, headers: { "content-length": String(size) } });
      }
      return new Response(`<a href="Win11_English_x64.iso">a</a><a href="Windows11-FR_CA-25h2.iso">b</a>`, { status: 200 });
    }));
    const { app, runnerCalls, downloads, done } = setup();
    const res = await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "windows11", storagePool: "local", makeBase: true } });
    expect(res.statusCode).toBe(202);
    await done();
    expect(downloads).toEqual(["https://dep.example/TEMPLATES/ISO/AMD64/Windows11-FR_CA-25h2.iso"]);
    const create = runnerCalls.find((c) => c.action === "qemu_quick_create")!;
    expect(create.params).toMatchObject({ os: "windows11", name: "base-windows11", isoPath: "/isos/w.iso", driverIsoPath: "/isos/virtio-win.iso", makeBase: true });
  });

  it("validates before doing anything", async () => {
    const { app, runnerCalls } = setup();
    expect((await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "debian13", storagePool: "nas" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "macos", storagePool: "local" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/vms/quick-create", payload: { os: "debian13", storagePool: "local", name: "debian-13" } })).statusCode).toBe(409);
    expect(runnerCalls.filter((c) => c.action !== "qemu_vms")).toEqual([]);
  });
});
