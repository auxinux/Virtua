import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Non-regression for INSTALL/storage-permissions.sh, which install.sh runs on
 * every install, update (each apt upgrade) and repair. Up to 0.8.2 that pass
 * walked into the LXC root filesystems stored on the pools and rewrote them.
 * Runs unprivileged: the current user stands in for root and a supplementary
 * group for libvirt-qemu, which is enough to observe any change.
 */

const LIB = path.resolve(__dirname, "../../../../INSTALL/storage-permissions.sh");
const USER = os.userInfo().username;
const PRIMARY_GROUP = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
const QEMU_GROUP = execFileSync("id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/).find((group) => group !== PRIMARY_GROUP) ?? PRIMARY_GROUP;
const QEMU_GID = Number(execFileSync("getent", ["group", QEMU_GROUP], { encoding: "utf8" }).split(":")[2]);
const IS_ROOT = process.getuid?.() === 0;
const ROOTFS = "pools/local/TestLXC/rootfs";

let tmp: string;
let data: string;
let lxcDir: string;

function bash(script: string, env: Record<string, string> = {}): string {
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nsource "$VIRTUA_LIB"\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      VIRTUA_LIB: LIB,
      DATA: data,
      LXC_DIR: lxcDir,
      VIRTUA_ROOT_USER: USER,
      VIRTUA_ROOT_GROUP: PRIMARY_GROUP,
      VIRTUA_QEMU_USER: USER,
      VIRTUA_QEMU_GROUP: QEMU_GROUP,
      ...env,
    },
  });
  if (result.status !== 0) throw new Error(`bash exited with ${result.status}: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function mk(rel: string, mode: number): string {
  const target = path.join(data, rel);
  fs.mkdirSync(target, { recursive: true });
  fs.chmodSync(target, mode);
  return target;
}

function file(rel: string, mode: number): string {
  const target = path.join(data, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "");
  fs.chmodSync(target, mode);
  return target;
}

function mode(rel: string): string {
  return (fs.statSync(path.join(data, rel)).mode & 0o7777).toString(8);
}

/** uid, gid and permission bits of `rel` and everything below it. */
function snapshotTree(rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    const st = fs.lstatSync(abs);
    out[path.relative(data, abs)] = `${st.uid}:${st.gid} ${(st.mode & 0o7777).toString(8)}`;
    if (st.isDirectory()) for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
  };
  walk(path.join(data, rel));
  return out;
}

/** Nothing here is QEMU storage: container filesystems, snapshots, plain files. */
const UNTOUCHABLE = [
  "pools/local/TestLXC",
  "pools/local/Relocated",
  "pools/local/Foreign",
  "pools/local/notes",
  "pools/backups/lxc-TestLXC.tar.zst",
  "snapshots",
  "db/auxinux.sqlite",
];

function snapshotUntouchable(): Record<string, string> {
  return Object.assign({}, ...UNTOUCHABLE.map(snapshotTree));
}

/** What create_data_dirs + fix_libvirt_storage_permissions run in install.sh. */
const INSTALL_PASS = `
virtua_prepare_data_dirs "$DATA" "$DATA/templates" "$DATA/images" "$DATA/db" "$DATA/ssl"
virtua_fix_pool_permissions "$DATA/pools"
virtua_report_damaged_lxc_rootfs "$DATA/pools" "$DATA/snapshots/lxc"
`;

/** The 0.8.2 create_data_dirs / fix_libvirt_storage_permissions, owner made configurable. */
const LEGACY_PASS = `
chown -R "$VIRTUA_ROOT_USER:$VIRTUA_ROOT_GROUP" "$DATA"
chmod -R 0755 "$DATA"
chmod 0711 "$DATA"
find "$DATA/pools" -type d -exec chown "$VIRTUA_ROOT_USER:$VIRTUA_QEMU_GROUP" {} \\; -exec chmod 2775 {} \\; 2>/dev/null || true
find "$DATA/pools" -type f \\( -iname '*.qcow2' -o -iname '*.img' -o -iname '*.raw' -o -iname '*.vmdk' \\) \\
    -exec chown "$VIRTUA_QEMU_USER:$VIRTUA_QEMU_GROUP" {} \\; -exec chmod 0660 {} \\; 2>/dev/null || true
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "virtua-install-perms-"));
  data = path.join(tmp, "auxinuxvirtual");
  lxcDir = path.join(tmp, "lxc");

  // The layout from the incident report.
  file("pools/local/vm-disk.qcow2", 0o644);
  mk(ROOTFS, 0o755);
  mk(`${ROOTFS}/etc`, 0o755);
  mk(`${ROOTFS}/etc/sudoers.d`, 0o755);
  file(`${ROOTFS}/etc/shadow`, 0o640);
  mk(`${ROOTFS}/home/test`, 0o700);
  mk(`${ROOTFS}/root`, 0o700);
  mk(`${ROOTFS}/tmp`, 0o1777);
  mk(`${ROOTFS}/var/tmp`, 0o1777);
  mk(`${ROOTFS}/usr/bin`, 0o755);
  // Disk-image-looking files inside a guest belong to the guest (grub, nested VMs).
  file(`${ROOTFS}/usr/lib/grub/i386-pc/boot.img`, 0o644);
  file(`${ROOTFS}/var/lib/libvirt/images/nested.qcow2`, 0o600);
  // A rollback copy left beside the live rootfs.
  mk("pools/local/TestLXC/rootfs.rollback-1700000000/etc", 0o755);
  // A relocated rootfs under another name, known only from its config.
  file("pools/local/Relocated/data/srv/app.img", 0o640);
  // A container of another node on a shared pool: undeclared, not named rootfs.
  mk("pools/local/Foreign/etc", 0o755);
  mk("pools/local/Foreign/usr", 0o755);
  file("pools/local/Foreign/var/lib/vm.raw", 0o600);
  // Plain storage: a directory without disks, a nested VM disk, a backup archive.
  file("pools/local/notes/readme.txt", 0o644);
  file("pools/local/vms/web/disk.img", 0o644);
  fs.chmodSync(path.join(data, "pools/local/vms"), 0o750);
  file("pools/backups/lxc-TestLXC.tar.zst", 0o640);
  // A Virtua snapshot of the container, and portal state.
  mk("snapshots/lxc/TestLXC/before-upgrade/rootfs/etc/sudoers.d", 0o755);
  file("snapshots/lxc/TestLXC/before-upgrade/rootfs/etc/shadow", 0o640);
  mk("snapshots/lxc/TestLXC/before-upgrade/rootfs/tmp", 0o1777);
  file("db/auxinux.sqlite", 0o640);
  file("ssl/key.pem", 0o755);

  if (IS_ROOT) {
    // Real owners, as in a Debian guest: root everywhere, the user in its home.
    const walk = (abs: string) => {
      fs.lchownSync(abs, 0, 0);
      if (fs.lstatSync(abs).isDirectory()) for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
    };
    walk(path.join(data, ROOTFS));
    fs.chownSync(path.join(data, ROOTFS, "home/test"), 1000, 1000);
  }
  // Last, so that no chown can have cleared it.
  file(`${ROOTFS}/usr/bin/sudo`, 0o4755);

  fs.mkdirSync(path.join(lxcDir, "TestLXC"), { recursive: true });
  fs.writeFileSync(path.join(lxcDir, "TestLXC", "config"), `lxc.rootfs.path = dir:${path.join(data, ROOTFS)}\n`);
  fs.mkdirSync(path.join(lxcDir, "Relocated"), { recursive: true });
  fs.writeFileSync(path.join(lxcDir, "Relocated", "config"), `lxc.rootfs.path = dir:${path.join(data, "pools/local/Relocated/data")}\n`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("install / update / repair permission pass", () => {
  it("leaves every LXC rootfs, snapshot and non-storage path strictly unchanged", () => {
    const before = snapshotUntouchable();
    expect(before[`${ROOTFS}/etc`]).toMatch(/ 755$/);
    expect(before[`${ROOTFS}/etc/sudoers.d`]).toMatch(/ 755$/);
    if (IS_ROOT) expect(before[`${ROOTFS}/home/test`]).toBe("1000:1000 700");

    bash(INSTALL_PASS);
    expect(snapshotUntouchable()).toEqual(before);
    // A second upgrade must not drift either.
    bash(INSTALL_PASS);
    expect(snapshotUntouchable()).toEqual(before);
  });

  it("still gives QEMU the storage it actually uses", () => {
    bash(INSTALL_PASS);
    for (const dir of ["pools", "pools/local", "pools/backups", "pools/local/vms", "pools/local/vms/web"]) {
      expect(mode(dir), dir).toBe("2775");
      expect(fs.statSync(path.join(data, dir)).gid, dir).toBe(QEMU_GID);
    }
    for (const disk of ["pools/local/vm-disk.qcow2", "pools/local/vms/web/disk.img"]) {
      expect(mode(disk), disk).toBe("660");
      expect(fs.statSync(path.join(data, disk)).gid, disk).toBe(QEMU_GID);
    }
    expect(mode("pools/local/notes")).not.toBe("2775");
  });

  it("refuses a direct permission change inside LXC territory", () => {
    const before = snapshotUntouchable();
    const out = bash(`
if virtua_guarded_chmod 2775 "$DATA/${ROOTFS}/etc/sudoers.d"; then exit 9; fi
if virtua_guarded_chown "$VIRTUA_ROOT_USER:$VIRTUA_QEMU_GROUP" "$DATA/pools/local/Relocated/data/srv"; then exit 9; fi
if virtua_guarded_chmod 2775 "$DATA/pools/local/Foreign/etc"; then exit 9; fi
`);
    expect(out).toContain("Refusing to chmod");
    expect(out).toContain("Refusing to chown");
    expect(snapshotUntouchable()).toEqual(before);
  });

  it("restores 0600 on the private keys the old recursive chmod exposed", () => {
    bash(INSTALL_PASS);
    expect(mode("ssl/key.pem")).toBe("600");
  });

  it("control: the 0.8.2 pass does rewrite the rootfs this suite protects", () => {
    const before = snapshotTree(ROOTFS);
    bash(LEGACY_PASS);
    const after = snapshotTree(ROOTFS);
    expect(after[`${ROOTFS}/etc/sudoers.d`]).toMatch(/ 2775$/);
    expect(after[`${ROOTFS}/tmp`]).not.toBe(before[`${ROOTFS}/tmp`]);
    expect(after[`${ROOTFS}/etc/shadow`]).toMatch(/ 755$/);
  });
});

describe("damage report", () => {
  it("names each container the old installer damaged, and changes nothing", () => {
    bash(LEGACY_PASS);
    const damaged = snapshotUntouchable();
    const out = bash(`virtua_report_damaged_lxc_rootfs "$DATA/pools" "$DATA/snapshots/lxc"`);

    expect(out).toContain("LXC container TestLXC");
    expect(out).toContain("/etc/sudoers.d: mode 2775 on a system directory");
    expect(out).toContain("/tmp: sticky bit missing");
    expect(out).toContain("/etc/shadow: readable by every user");
    expect(out).toContain("LXC snapshot TestLXC/before-upgrade");
    if (QEMU_GROUP !== PRIMARY_GROUP) {
      expect(out).toContain(`/etc/sudoers.d: group ${QEMU_GROUP} (gid ${QEMU_GID})`);
    }
    expect(snapshotUntouchable()).toEqual(damaged);
  });

  it("stays quiet about healthy containers", () => {
    // A group owning nothing here, so only the mode-based checks can fire.
    const out = bash(`virtua_report_damaged_lxc_rootfs "$DATA/pools" "$DATA/snapshots/lxc"`, {
      VIRTUA_QEMU_GROUP: "virtua-test-no-such-group",
    });
    expect(out).not.toContain("permission damage");
  });
});

describe("reset / clean", () => {
  it("removes portal state but keeps pools, snapshots and other guest data", () => {
    file(".install-completed", 0o644);
    mk("templates/lxc", 0o755);
    mk("images/vm-disks", 0o755);
    mk("compose/stack", 0o755);
    mk("usb", 0o755);

    bash(`virtua_remove_portal_data "$DATA"`);

    for (const kept of [`${ROOTFS}/etc/sudoers.d`, "pools/local/vm-disk.qcow2", "pools/backups/lxc-TestLXC.tar.zst",
      "snapshots/lxc/TestLXC/before-upgrade", "templates/lxc", "images/vm-disks", "compose/stack"]) {
      expect(fs.existsSync(path.join(data, kept)), kept).toBe(true);
    }
    for (const removed of ["db", "ssl", "usb", ".install-completed"]) {
      expect(fs.existsSync(path.join(data, removed)), removed).toBe(false);
    }
  });
});
