import { describe, expect, it } from "vitest";
import { validateMountPath } from "./storage";

describe("validateMountPath", () => {
  it("accepts a normal mountpoint", () => {
    expect(validateMountPath("/mnt/hdd-storage", "path")).toBe("/mnt/hdd-storage");
  });

  it("strips a trailing slash", () => {
    expect(validateMountPath("/mnt/hdd/", "path")).toBe("/mnt/hdd");
  });

  // The report: typing /dev/sda1 as a Directory pool path passed validation and
  // failed much later with a bare "EEXIST: mkdir '/dev/sda1'".
  it("rejects a block device node with an actionable message", () => {
    let message = "";
    try {
      validateMountPath("/dev/sda1", "path");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("block device");
    expect(message).toContain("/mnt/sda1");
    expect(message).not.toContain("EEXIST");
  });

  it.each(["/proc/self", "/sys/block/sda", "/run/lock"])("rejects kernel-managed tree %s", (p) => {
    expect(() => validateMountPath(p, "path")).toThrow(/managed by the kernel/);
  });

  it("still rejects the system directories themselves", () => {
    for (const dir of ["/", "/etc", "/usr", "/dev"]) {
      expect(() => validateMountPath(dir, "path"), dir).toThrow(/cannot mount over system directory/);
    }
  });

  it("does not reject paths that merely start with a forbidden name", () => {
    expect(validateMountPath("/development/pool", "path")).toBe("/development/pool");
    expect(validateMountPath("/devices", "path")).toBe("/devices");
  });
});
