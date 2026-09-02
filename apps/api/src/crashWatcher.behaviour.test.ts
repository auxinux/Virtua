import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// Même contrainte que crashWatcher.test.ts : le chemin de la base doit être
// fixé avant l'évaluation des modules importés.
vi.hoisted(() => {
  const dir = `/tmp/virtua-crash-behaviour-${process.pid}-${Date.now()}`;
  process.env.AUXINUX_DATA_DIR = dir;
  process.env.AUXINUX_DB = `${dir}/test.sqlite`;
});

// Le runner est remplacé : on pilote à la main ce que « voit » le surveillant.
vi.mock("./runnerClient.js", () => ({ callRunner: vi.fn() }));

import { callRunner } from "./runnerClient.js";
import { startCrashWatcher, markExpectedTransition } from "./crashWatcher.js";

const mockedCallRunner = vi.mocked(callRunner);

/** État courant des invités tel que le runner le rapporterait. */
let vmState: Array<{ name: string; state: string }> = [];
let stopReason = { raw: "shut off (crashed)", reason: "crashed" };

function wireRunner() {
  mockedCallRunner.mockImplementation(async (action: string) => {
    switch (action) {
      case "qemu_vms": return vmState as never;
      case "lxc_containers": return [] as never;
      case "qemu_stop_reason": return stopReason as never;
      case "qemu_logs": return "qemu: terminating on signal\n" as never;
      case "lxc_logs": return "" as never;
      default: throw new Error(`action inattendue: ${action}`);
    }
  });
}

describe("surveillant de pannes (bout en bout, runner simulé)", () => {
  let db: import("better-sqlite3").Database;
  let helpers: typeof import("./db.js");
  let watcher: { stop: () => void } | null = null;
  let started: string[] = [];

  const startWatcher = () => {
    started = [];
    watcher = startCrashWatcher({
      db,
      getNodeName: () => "node-test",
      startGuest: async (type, name) => { started.push(`${type}:${name}`); },
      intervalMs: 20,
    });
  };

  const eventsFor = (name: string) =>
    db.prepare("SELECT event, reason, attempt FROM guest_crash_events WHERE resource_name = ? ORDER BY id")
      .all(name) as Array<{ event: string; reason: string | null; attempt: number | null }>;

  beforeAll(async () => {
    helpers = await import("./db.js");
    db = helpers.getDb();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM guest_crash_events").run();
    db.prepare("DELETE FROM guest_crash_policy").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('crash.autoRestartDefault', '1')").run();
    stopReason = { raw: "shut off (crashed)", reason: "crashed" };
    wireRunner();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    vi.clearAllMocks();
  });

  /** Attend que le surveillant ait relevé l'état de départ (aucun événement). */
  async function captureBaseline(name: string, state = "running") {
    vmState = [{ name, state }];
    startWatcher();
    await vi.waitFor(() => expect(mockedCallRunner).toHaveBeenCalledWith("qemu_vms", expect.anything(), expect.anything()), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(eventsFor(name)).toHaveLength(0);
  }

  it("journalise la panne et redémarre l'invité", async () => {
    await captureBaseline("vm-crash");

    vmState = [{ name: "vm-crash", state: "stopped" }];
    await vi.waitFor(() => expect(eventsFor("vm-crash").length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    const events = eventsFor("vm-crash");
    expect(events[0]).toMatchObject({ event: "crash", reason: "crashed" });
    expect(events[1]).toMatchObject({ event: "restart", attempt: 1 });
    expect(started).toContain("vm:vm-crash");

    const detail = db.prepare("SELECT detail FROM guest_crash_events WHERE resource_name = 'vm-crash' AND event = 'crash'").get() as { detail: string };
    // La cause doit être exploitable par l'utilisateur : état libvirt + journal.
    expect(detail.detail).toContain("shut off (crashed)");
    expect(detail.detail).toContain("terminating on signal");
  });

  it("ignore un arrêt demandé depuis Virtua", async () => {
    await captureBaseline("vm-stopped");

    markExpectedTransition("vm", "vm-stopped");
    vmState = [{ name: "vm-stopped", state: "stopped" }];
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(eventsFor("vm-stopped")).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("ignore une extinction propre décidée par l'invité", async () => {
    await captureBaseline("vm-poweroff");

    stopReason = { raw: "shut off (shutdown)", reason: "shutdown" };
    vmState = [{ name: "vm-poweroff", state: "stopped" }];
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(eventsFor("vm-poweroff")).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("ne relance pas une machine en boucle : abandon après 3 tentatives", async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      helpers.recordCrashEvent(db, { resourceType: "vm", resourceName: "vm-loop", event: "restart", attempt });
    }
    await captureBaselineWithExisting("vm-loop");

    vmState = [{ name: "vm-loop", state: "stopped" }];
    await vi.waitFor(() => expect(eventsFor("vm-loop").some((e) => e.event === "gave-up")).toBe(true), { timeout: 3000 });

    expect(started).toHaveLength(0);
    expect(eventsFor("vm-loop").filter((e) => e.event === "restart")).toHaveLength(3); // aucun 4e essai
  });

  it("respecte le refus explicite d'une machine malgré le défaut global", async () => {
    helpers.setGuestCrashPolicy(db, "vm", "vm-optout", false);
    await captureBaseline("vm-optout");

    vmState = [{ name: "vm-optout", state: "stopped" }];
    await vi.waitFor(() => expect(eventsFor("vm-optout").length).toBeGreaterThanOrEqual(1), { timeout: 3000 });

    // La panne est bien journalisée, mais rien n'est redémarré.
    expect(eventsFor("vm-optout").map((e) => e.event)).toEqual(["crash"]);
    expect(started).toHaveLength(0);
  });

  /** Variante de captureBaseline pour un invité qui a déjà un historique. */
  async function captureBaselineWithExisting(name: string) {
    const before = eventsFor(name).length;
    vmState = [{ name, state: "running" }];
    startWatcher();
    await vi.waitFor(() => expect(mockedCallRunner).toHaveBeenCalledWith("qemu_vms", expect.anything(), expect.anything()), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(eventsFor(name)).toHaveLength(before);
  }
});
