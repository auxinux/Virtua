import { describe, it, expect } from "vitest";
import { isManagedStorageLocation, shouldSkipDirectory, isInside } from "./storageScan.js";

const DATA_DIR = "/var/lib/auxinux";
const MANAGED = [DATA_DIR, "/var/lib/libvirt/images/isos", `${DATA_DIR}/images/vm-disks`, "/var/lib/libvirt/images", "/var/lib/lxc"];

describe("isManagedStorageLocation", () => {
  it("keeps a VM disk created straight in the pool root", () => {
    expect(isManagedStorageLocation("/", "/vm1.qcow2", MANAGED)).toBe(true);
    expect(isManagedStorageLocation("/srv/pool", "/srv/pool/vm1.qcow2", MANAGED)).toBe(true);
  });

  it("keeps backups under <pool>/backups", () => {
    expect(isManagedStorageLocation("/srv/pool", "/srv/pool/backups/lxc-web.tar.gz", MANAGED)).toBe(true);
  });

  it("keeps content under Virtua's own directories", () => {
    expect(isManagedStorageLocation("/", "/var/lib/libvirt/images/isos/debian.iso", MANAGED)).toBe(true);
    expect(isManagedStorageLocation("/", `${DATA_DIR}/images/vm-disks/d.qcow2`, MANAGED)).toBe(true);
  });

  // The regression from the screenshot: Go's archive/tar fixtures listed as
  // "Archive", and a 12 KB regexp fixture listed as a "Disk", both with a
  // working Delete button.
  it.each([
    "/usr/local/go/src/archive/tar/testdata/gnu-multi-hdrs.tar",
    "/usr/local/go/src/archive/tar/testdata/gnu-nil-sparse-hole.tar",
    "/usr/local/go/src/archive/tar/testdata/file-and-dir.tar",
    "/usr/local/go/src/regexp/testdata/expressions.raw",
    "/home/user/project/node_modules/tar/test/fixtures/gnu.tar",
  ])("rejects unrelated host file %s", (file) => {
    expect(isManagedStorageLocation("/", file, MANAGED)).toBe(false);
  });
});

describe("shouldSkipDirectory", () => {
  it("prunes system trees when a pool is rooted at /", () => {
    for (const dir of ["/proc", "/sys", "/usr", "/etc", "/boot", "/var/log", "/var/lib/dpkg"]) {
      expect(shouldSkipDirectory(dir, "/", dir.split("/").pop()!), dir).toBe(true);
    }
  });

  it("does not prune /var/lib itself — real VM disks live under it", () => {
    expect(shouldSkipDirectory("/var/lib", "/", "lib")).toBe(false);
    expect(shouldSkipDirectory("/var/lib/libvirt/images", "/", "images")).toBe(false);
  });

  it("prunes vendored directories at any depth", () => {
    expect(shouldSkipDirectory("/srv/pool/app/node_modules", "/srv/pool", "node_modules")).toBe(true);
  });

  it("never prunes the pool root itself", () => {
    expect(shouldSkipDirectory("/usr", "/usr", "usr")).toBe(false);
  });
});

describe("isInside", () => {
  it("treats a directory as inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  it("rejects siblings sharing a prefix", () => {
    expect(isInside("/a/b", "/a/bc/d")).toBe(false);
  });
});
