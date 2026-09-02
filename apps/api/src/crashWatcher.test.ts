import { describe, it, expect, beforeAll, vi } from "vitest";
import { __testing } from "./crashWatcher.js";

// db.ts fige le chemin de la base à l'évaluation du module, et crashWatcher.ts
// l'importe : l'environnement doit donc être posé AVANT tout import, sans quoi
// le test taperait dans la vraie base de production (/var/lib/auxinux).
vi.hoisted(() => {
  const dir = `/tmp/virtua-crash-test-${process.pid}-${Date.now()}`;
  process.env.AUXINUX_DATA_DIR = dir;
  process.env.AUXINUX_DB = `${dir}/test.sqlite`;
});

const { classifyLibvirtReason, isLiveState } = __testing;

describe("classifyLibvirtReason", () => {
  it("reconnaît les arrêts que libvirt attribue à une panne", () => {
    expect(classifyLibvirtReason("shut off (crashed)")).toBe("crashed");
    expect(classifyLibvirtReason("crashed (panicked)")).toBe("panicked");
    expect(classifyLibvirtReason("shut off (failed)")).toBe("failed");
    expect(classifyLibvirtReason("shut off (destroyed)")).toBe("killed");
  });

  it("ne signale PAS une extinction propre ou un déplacement d'état", () => {
    // L'invité s'est éteint lui-même : le redémarrer irait contre la volonté
    // de l'utilisateur.
    expect(classifyLibvirtReason("shut off (shutdown)")).toBeNull();
    expect(classifyLibvirtReason("shut off (saved)")).toBeNull();
    expect(classifyLibvirtReason("shut off (migrated)")).toBeNull();
    expect(classifyLibvirtReason("shut off (from snapshot)")).toBeNull();
  });

  it("retombe sur « unexpected » quand libvirt ne dit rien d'exploitable", () => {
    expect(classifyLibvirtReason("shut off (unknown)")).toBe("unexpected");
    expect(classifyLibvirtReason("")).toBe("unexpected");
  });
});

describe("isLiveState", () => {
  it("ne compte comme arrêt ni la pause ni le gel", () => {
    expect(isLiveState("running")).toBe(true);
    expect(isLiveState("paused")).toBe(true);
    expect(isLiveState("suspended")).toBe(true);
    expect(isLiveState("frozen")).toBe(true);
    expect(isLiveState("stopped")).toBe(false);
    expect(isLiveState("unknown")).toBe(false);
  });
});

describe("politique et journal de reprise après panne", () => {
  let db: import("better-sqlite3").Database;
  let helpers: typeof import("./db.js");

  beforeAll(async () => {
    helpers = await import("./db.js");
    db = helpers.getDb();
  });

  it("crée les tables de reprise après panne", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("guest_crash_policy");
    expect(names).toContain("guest_crash_events");
  });

  it("applique 3 tentatives / 10 minutes par défaut", () => {
    const settings = helpers.getCrashSettings(db);
    expect(settings.maxAttempts).toBe(3);
    expect(settings.windowMinutes).toBe(10);
    expect(settings.autoRestartDefault).toBe(false);
  });

  it("fait suivre le défaut global tant que la machine n'a pas de politique propre", () => {
    expect(helpers.getGuestCrashPolicy(db, "vm", "web1")).toBeNull();
    expect(helpers.resolveGuestCrashPolicy(db, "vm", "web1")).toBe(false);

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('crash.autoRestartDefault', '1')").run();
    expect(helpers.resolveGuestCrashPolicy(db, "vm", "web1")).toBe(true);
  });

  it("laisse une machine ignorer le défaut global, puis y revenir", () => {
    helpers.setGuestCrashPolicy(db, "vm", "web1", false);
    expect(helpers.getGuestCrashPolicy(db, "vm", "web1")).toBe(false);
    expect(helpers.resolveGuestCrashPolicy(db, "vm", "web1")).toBe(false); // malgré le défaut à true

    helpers.setGuestCrashPolicy(db, "vm", "web1", null);
    expect(helpers.getGuestCrashPolicy(db, "vm", "web1")).toBeNull();
    expect(helpers.resolveGuestCrashPolicy(db, "vm", "web1")).toBe(true);
  });

  it("ne compte que les redémarrages de la fenêtre pour le garde-fou anti-boucle", () => {
    helpers.recordCrashEvent(db, { resourceType: "lxc", resourceName: "ct1", event: "crash", reason: "unexpected" });
    helpers.recordCrashEvent(db, { resourceType: "lxc", resourceName: "ct1", event: "restart", attempt: 1 });
    helpers.recordCrashEvent(db, { resourceType: "lxc", resourceName: "ct1", event: "restart-failed", attempt: 2 });
    // Une panne n'est pas une tentative de redémarrage.
    expect(helpers.countRecentRestarts(db, "lxc", "ct1", 10)).toBe(2);
    // Une autre machine a son propre compteur.
    expect(helpers.countRecentRestarts(db, "lxc", "ct2", 10)).toBe(0);

    // Hors fenêtre : le compteur repart à zéro.
    db.prepare("UPDATE guest_crash_events SET created_at = datetime('now', '-2 hours') WHERE resource_name = 'ct1'").run();
    expect(helpers.countRecentRestarts(db, "lxc", "ct1", 10)).toBe(0);
  });

  it("borne le détail pour qu'une machine qui recrashe en boucle ne gonfle pas la base", () => {
    helpers.recordCrashEvent(db, {
      resourceType: "vm",
      resourceName: "big",
      event: "crash",
      detail: "x".repeat(50_000),
    });
    const row = db.prepare("SELECT detail FROM guest_crash_events WHERE resource_name = 'big'").get() as { detail: string };
    expect(row.detail.length).toBe(8000);
  });

  it("purge les entrées plus vieilles que la rétention", () => {
    helpers.recordCrashEvent(db, { resourceType: "vm", resourceName: "old", event: "crash" });
    db.prepare("UPDATE guest_crash_events SET created_at = datetime('now', '-200 days') WHERE resource_name = 'old'").run();
    const removed = helpers.pruneCrashEvents(db, 90);
    expect(removed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM guest_crash_events WHERE resource_name = 'old'").get()).toEqual({ c: 0 });
  });
});
