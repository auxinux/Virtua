import { describe, expect, it } from "vitest";
import {
  AttachFloppySchema,
  FLOPPY_MAX_BYTES,
  archSupportsFloppy,
  floppySizeLabel,
  isFloppyFilename,
  validateFloppyImage,
} from "./floppy";
import { CreateVmSchema, UpdateVmConfigSchema } from "./vm";

describe("floppy image validation", () => {
  it("recognizes floppy extensions case-insensitively", () => {
    for (const name of ["dos622.img", "DISK1.IMA", "xp-f6.vfd", "boot.FLP"]) {
      expect(isFloppyFilename(name)).toBe(true);
    }
    for (const name of ["win.iso", "disk.qcow2", "img", "a.img.txt"]) {
      expect(isFloppyFilename(name)).toBe(false);
    }
  });

  it("accepts the standard 1.2/1.44/1.68/2.88 MB sizes", () => {
    for (const [bytes, label] of [
      [1228800, "1.2 MB"],
      [1474560, "1.44 MB"],
      [1720320, "1.68 MB (DMF)"],
      [2949120, "2.88 MB"],
    ] as const) {
      expect(validateFloppyImage("a.img", bytes)).toEqual({ ok: true, standard: true, label });
      expect(floppySizeLabel(bytes)).toBe(label);
    }
  });

  it("accepts a non-standard size under the limit but flags it", () => {
    expect(validateFloppyImage("odd.vfd", 1_000_000)).toEqual({ ok: true, standard: false, label: undefined });
  });

  it("rejects images larger than 2.88 MB with a clear message", () => {
    const result = validateFloppyImage("big.img", FLOPPY_MAX_BYTES + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too large.*2\.88 MB/);
  });

  it("rejects empty images and wrong extensions", () => {
    expect(validateFloppyImage("a.img", 0).ok).toBe(false);
    expect(validateFloppyImage("a.iso", 1474560).ok).toBe(false);
  });

  it("knows which architectures have a floppy controller", () => {
    expect(archSupportsFloppy("x86_64")).toBe(true);
    expect(archSupportsFloppy("i686")).toBe(true);
    expect(archSupportsFloppy(undefined)).toBe(true);
    expect(archSupportsFloppy("aarch64")).toBe(false);
  });
});

describe("AttachFloppySchema", () => {
  it("defaults to write-protected", () => {
    expect(AttachFloppySchema.parse({ floppyFile: "drivers.img" })).toEqual({ floppyFile: "drivers.img", readonly: true });
  });

  it("refuses non-floppy files", () => {
    expect(AttachFloppySchema.safeParse({ floppyFile: "win.iso" }).success).toBe(false);
    expect(AttachFloppySchema.safeParse({}).success).toBe(false);
  });
});

describe("CreateVmSchema floppy options", () => {
  const base = { name: "dos", vcpus: 1, memoryMb: 256, os: "other" };

  it("accepts a floppy and floppy-first boot on a BIOS x86 VM", () => {
    const parsed = CreateVmSchema.parse({ ...base, floppyFile: "dos622.img", bootDevice: "fd" });
    expect(parsed.floppyFile).toBe("dos622.img");
    expect(parsed.bootDevice).toBe("fd");
  });

  it("refuses a floppy on aarch64", () => {
    const result = CreateVmSchema.safeParse({ ...base, arch: "aarch64", machine: "virt", floppyFile: "a.img" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/x86/);
  });

  it("refuses floppy boot without an image or with UEFI", () => {
    expect(CreateVmSchema.safeParse({ ...base, bootDevice: "fd" }).success).toBe(false);
    expect(CreateVmSchema.safeParse({ ...base, floppyFile: "a.img", bootDevice: "fd", uefi: true }).success).toBe(false);
  });

  it("refuses a non-floppy file as floppyFile", () => {
    expect(CreateVmSchema.safeParse({ ...base, floppyFile: "win.iso" }).success).toBe(false);
  });

  it("allows fd in config updates", () => {
    expect(UpdateVmConfigSchema.parse({ bootDevice: "fd" }).bootDevice).toBe("fd");
  });
});
