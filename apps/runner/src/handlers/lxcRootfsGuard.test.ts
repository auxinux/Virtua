import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LxcRootfsGuardError,
  assertOutsideLxcRootfs,
  auditLxcRootfsPermissions,
  auditRootfsPermissions,
  isProtectedHostDir,
  isRootfsName,
  lxcRootfsViolation,
  rootfsSpecHostPaths,
} from "./lxcRootfsGuard";

// A supplementary group lets an unprivileged run observe a group change.
const secondaryGid = process.getgroups?.().find((gid) => gid !== process.getgid?.());
const isRoot = process.getuid?.() === 0;

let tmp: string;
let lxcDir: string;
let pool: string;

function mkdir(target: string, mode = 0o755) {
  fs.mkdirSync(target, { recursive: true });
  fs.chmodSync(target, mode);
}

function declareContainer(name: string, rootfsSpec: string) {
  mkdir(path.join(lxcDir, name));
  fs.writeFileSync(path.join(lxcDir, name, "config"), `lxc.uts.name = ${name}\nlxc.rootfs.path = ${rootfsSpec}\n`);
}

/** The permissions of a healthy Debian guest, on the paths the audit inspects. */
function makeRootfs(root: string) {
  const dirs: Array<[string, number]> = [
    ["", 0o755], ["etc", 0o755], ["etc/sudoers.d", 0o755], ["usr", 0o755], ["usr/bin", 0o755],
    ["var", 0o755], ["var/lib", 0o755], ["var/log", 0o755], ["var/tmp", 0o1777],
    ["root", 0o700], ["home", 0o755], ["tmp", 0o1777],
  ];
  for (const [rel, mode] of dirs) mkdir(path.join(root, rel), mode);
  fs.writeFileSync(path.join(root, "etc/shadow"), "root:*:19000:0:99999:7:::\n");
  fs.chmodSync(path.join(root, "etc/shadow"), 0o640);
  fs.writeFileSync(path.join(root, "usr/bin/sudo"), "");
  fs.chmodSync(path.join(root, "usr/bin/sudo"), 0o4755);
}

/** What the pre-0.8.3 installer left behind. */
function damageRootfs(root: string) {
  for (const rel of ["", "etc", "etc/sudoers.d", "usr", "var", "tmp"]) fs.chmodSync(path.join(root, rel), 0o2775);
  fs.chmodSync(path.join(root, "etc/shadow"), 0o755);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "virtua-rootfs-guard-"));
  lxcDir = path.join(tmp, "lxc");
  pool = path.join(tmp, "pools", "local");
  mkdir(pool);
  makeRootfs(path.join(pool, "web", "rootfs"));
  declareContainer("web", `dir:${path.join(pool, "web", "rootfs")}`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("rootfs naming and config parsing", () => {
  it("recognises a rootfs and the rollback copies kept beside it", () => {
    expect(isRootfsName("rootfs")).toBe(true);
    expect(isRootfsName("rootfs.rollback-1700000000")).toBe(true);
    expect(isRootfsName("myrootfs")).toBe(false);
    expect(isRootfsName("rootfsdata")).toBe(false);
  });

  it("extracts host paths from lxc.rootfs.path, but not from block-backed specs", () => {
    expect(rootfsSpecHostPaths("dir:/srv/pool/web/rootfs")).toEqual(["/srv/pool/web/rootfs"]);
    expect(rootfsSpecHostPaths("/var/lib/lxc/web/rootfs ")).toEqual(["/var/lib/lxc/web/rootfs"]);
    expect(rootfsSpecHostPaths("btrfs:/pool/web")).toEqual(["/pool/web"]);
    expect(rootfsSpecHostPaths("overlay:/lower:/upper")).toEqual(["/lower", "/upper"]);
    expect(rootfsSpecHostPaths("zfs:tank/lxc/web")).toEqual([]);
  });
});

describe("lxcRootfsViolation", () => {
  it("lets plain pool storage through", async () => {
    expect(await lxcRootfsViolation(pool, { lxcDir })).toBeNull();
    expect(await lxcRootfsViolation(path.join(pool, "vm.qcow2"), { lxcDir })).toBeNull();
    expect(await lxcRootfsViolation(path.join(pool, "web"), { lxcDir })).toBeNull();
  });

  it("refuses anything inside a declared rootfs, existing or not", async () => {
    expect(await lxcRootfsViolation(path.join(pool, "web", "rootfs"), { lxcDir })).toContain("LXC container web");
    expect(await lxcRootfsViolation(path.join(pool, "web", "rootfs", "etc", "sudoers.d"), { lxcDir })).toContain("LXC container web");
    expect(await lxcRootfsViolation(path.join(pool, "web", "rootfs", "new", "dir"), { lxcDir })).toContain("LXC container web");
  });

  it("refuses a relocated rootfs whatever its name", async () => {
    mkdir(path.join(pool, "data-db", "srv"));
    declareContainer("db", `dir:${path.join(pool, "data-db")}`);
    expect(await lxcRootfsViolation(path.join(pool, "data-db", "srv"), { lxcDir })).toContain("LXC container db");
  });

  it("refuses an undeclared rootfs, by name or by shape", async () => {
    mkdir(path.join(pool, "other", "rootfs", "etc"));
    mkdir(path.join(pool, "foreign", "etc", "sudoers.d"));
    mkdir(path.join(pool, "foreign", "usr"));
    expect(await lxcRootfsViolation(path.join(pool, "other", "rootfs", "etc"), { lxcDir })).toContain("inside an LXC rootfs");
    expect(await lxcRootfsViolation(path.join(pool, "foreign", "etc", "sudoers.d"), { lxcDir })).toContain("Linux root filesystem");
  });

  it("follows symlinks to where the change would really land", async () => {
    fs.symlinkSync(path.join(pool, "web", "rootfs", "etc"), path.join(pool, "etc-link"));
    expect(await lxcRootfsViolation(path.join(pool, "etc-link"), { lxcDir })).toContain("LXC container web");
  });

  it("only lets an LXC operation opt in for its own container", async () => {
    mkdir(path.join(pool, "data-db", "srv"));
    declareContainer("db", `dir:${path.join(pool, "data-db")}`);
    expect(await lxcRootfsViolation(path.join(pool, "web", "rootfs", "etc"), { lxcDir, allowRootfsOf: "web" })).toBeNull();
    expect(await lxcRootfsViolation(path.join(pool, "data-db", "srv"), { lxcDir, allowRootfsOf: "web" })).toContain("LXC container db");
  });

  it("throws a dedicated error from the assertion", async () => {
    await expect(assertOutsideLxcRootfs(path.join(pool, "web", "rootfs", "etc"), "test chmod", { lxcDir }))
      .rejects.toBeInstanceOf(LxcRootfsGuardError);
    await expect(assertOutsideLxcRootfs(pool, "test chmod", { lxcDir })).resolves.toBeUndefined();
  });
});

describe("isProtectedHostDir", () => {
  it("covers system directories but not storage locations", () => {
    expect(isProtectedHostDir("/dev")).toBe(true);
    expect(isProtectedHostDir("/dev/")).toBe(true);
    expect(isProtectedHostDir("/var/lib")).toBe(true);
    expect(isProtectedHostDir("/var/lib/auxinuxvirtual/pools/local")).toBe(false);
    expect(isProtectedHostDir("/var/lib/libvirt/images")).toBe(false);
  });
});

describe("auditRootfsPermissions", () => {
  it("finds nothing in a healthy rootfs", async () => {
    expect(await auditRootfsPermissions(path.join(pool, "web", "rootfs"), null)).toEqual([]);
  });

  it("reports the traces of the old installer", async () => {
    const rootfs = path.join(pool, "web", "rootfs");
    damageRootfs(rootfs);
    const issues = await auditRootfsPermissions(rootfs, null);
    expect(issues).toContainEqual({ code: "setgid-2775", path: "/", mode: "2775" });
    expect(issues).toContainEqual({ code: "setgid-2775", path: "/etc/sudoers.d", mode: "2775" });
    expect(issues).toContainEqual({ code: "sticky-missing", path: "/tmp", mode: "2775" });
    expect(issues).toContainEqual({ code: "shadow-readable", path: "/etc/shadow", mode: "755" });
  });

  it.runIf(secondaryGid !== undefined)("flags directories handed to the QEMU group", async () => {
    const rootfs = path.join(pool, "web", "rootfs");
    fs.chownSync(path.join(rootfs, "etc/sudoers.d"), process.getuid!(), secondaryGid!);
    const issues = await auditRootfsPermissions(rootfs, secondaryGid!);
    expect(issues).toContainEqual({ code: "qemu-group", path: "/etc/sudoers.d", mode: "755", gid: secondaryGid });
  });

  it.runIf(isRoot)("flags a root-owned sudo that lost its setuid bit", async () => {
    const rootfs = path.join(pool, "web", "rootfs");
    fs.chownSync(path.join(rootfs, "usr/bin/sudo"), 0, 0);
    fs.chmodSync(path.join(rootfs, "usr/bin/sudo"), 0o755);
    expect(await auditRootfsPermissions(rootfs, null)).toContainEqual({ code: "setuid-missing", path: "/usr/bin/sudo", mode: "755" });
  });
});

describe("auditLxcRootfsPermissions", () => {
  it("reports damaged containers, undeclared rootfs and snapshots — and nothing healthy", async () => {
    damageRootfs(path.join(pool, "web", "rootfs"));
    makeRootfs(path.join(pool, "healthy", "rootfs"));
    declareContainer("healthy", `dir:${path.join(pool, "healthy", "rootfs")}`);
    makeRootfs(path.join(pool, "orphan", "rootfs"));
    damageRootfs(path.join(pool, "orphan", "rootfs"));
    const snapshotDir = path.join(tmp, "snapshots", "lxc");
    makeRootfs(path.join(snapshotDir, "web", "before-upgrade", "rootfs"));
    damageRootfs(path.join(snapshotDir, "web", "before-upgrade", "rootfs"));

    const report = await auditLxcRootfsPermissions({ lxcDir, snapshotDir, poolPaths: [pool], qemu: null });

    expect(report.checked).toBe(4);
    expect(report.affected.map((entry) => [entry.container, entry.snapshot ?? null, entry.unregistered ?? false])).toEqual([
      ["web", null, false],
      ["orphan", null, true],
      ["web", "before-upgrade", false],
    ]);
  });
});
