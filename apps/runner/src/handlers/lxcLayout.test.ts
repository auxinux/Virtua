import { describe, expect, it } from "vitest";
import { isExternalRootfs, buildBackupTarArgs, checkSnapshotRestorable } from "./lxcLayout";

describe("isExternalRootfs", () => {
  it("treats the classic layout as internal", () => {
    expect(isExternalRootfs("/var/lib/lxc/web", "/var/lib/lxc/web/rootfs")).toBe(false);
  });

  it("detects a rootfs relocated onto a storage pool", () => {
    expect(isExternalRootfs("/var/lib/lxc/web", "/srv/pool/web/rootfs")).toBe(true);
  });

  it("is not fooled by a sibling directory sharing the prefix", () => {
    expect(isExternalRootfs("/var/lib/lxc/web", "/var/lib/lxc/web-old/rootfs")).toBe(true);
  });
});

describe("buildBackupTarArgs", () => {
  it("archives only the container directory in the classic layout", () => {
    const args = buildBackupTarArgs("/var/lib/lxc/web");
    expect(args).toEqual([
      "--warning=no-file-changed", "--warning=no-file-removed", "-cf", "-",
      "-C", "/var/lib/lxc", "web",
    ]);
  });

  // The regression: a pool-backed container produced an archive holding only
  // the config, so restoring it gave an empty container.
  it("also archives a relocated rootfs as a sibling member", () => {
    const args = buildBackupTarArgs("/var/lib/lxc/web", "/srv/pool/web/rootfs");
    expect(args).toEqual([
      "--warning=no-file-changed", "--warning=no-file-removed", "-cf", "-",
      "-C", "/var/lib/lxc", "web",
      "-C", "/srv/pool/web", "rootfs",
    ]);
  });

  it("never emits absolute members, so the archive stays self-describing", () => {
    const args = buildBackupTarArgs("/var/lib/lxc/web", "/srv/pool/web/rootfs");
    const members = args.filter((a, i) => i > 3 && args[i - 2] === "-C" && a !== "-C");
    expect(members.every((m) => !m.startsWith("/"))).toBe(true);
  });
});

describe("checkSnapshotRestorable", () => {
  it("accepts a snapshot of a container whose rootfs was never relocated", () => {
    expect(checkSnapshotRestorable("before-install", undefined, false)).toEqual({ ok: true });
  });

  it("accepts a v2 snapshot that captured the relocated rootfs", () => {
    expect(checkSnapshotRestorable("before-install", "/srv/pool/web/rootfs", true)).toEqual({ ok: true });
  });

  // A v1 snapshot of a pool-backed container reported success while restoring
  // nothing — the user rolled back and kept every change.
  it("refuses a snapshot that captured no filesystem data", () => {
    const result = checkSnapshotRestorable("before-install", "/srv/pool/web/rootfs", false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("contains no filesystem data");
    expect(result.reason).toContain("/srv/pool/web/rootfs");
  });
});
