import { describe, it, expect } from "vitest";
import {
  DesktopCreateResourceSchema,
  DesktopUpdateResourceSchema,
  DesktopQuickCreateSchema,
  DesktopLaunchDisposableSchema,
  DesktopDisposableActionSchema,
} from "./desktop";
import { hardwareChoicesForArch } from "./hardware";

describe("DesktopCreateResourceSchema", () => {
  it("accepts gpuModel and networkModel for a VM", () => {
    const result = DesktopCreateResourceSchema.safeParse({
      type: "vm",
      name: "test-vm",
      gpuModel: "qxl",
      networkModel: "e1000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gpuModel).toBe("qxl");
      expect(result.data.networkModel).toBe("e1000");
    }
  });

  it("rejects an unknown gpuModel value", () => {
    const result = DesktopCreateResourceSchema.safeParse({
      type: "vm",
      name: "test-vm",
      gpuModel: "nvidia-passthrough",
    });
    expect(result.success).toBe(false);
  });
});

describe("DesktopUpdateResourceSchema", () => {
  it("accepts an update that only changes gpuModel (regression: used to strip to {} and fail the refine)", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ gpuModel: "qxl" });
    expect(result.success).toBe(true);
  });

  it("accepts an update that only changes networkModel", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ networkModel: "virtio" });
    expect(result.success).toBe(true);
  });

  it("still rejects a fully empty update", () => {
    const result = DesktopUpdateResourceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("still rejects an update containing only unknown fields", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ somethingUnsupported: "x" });
    expect(result.success).toBe(false);
  });
});

describe("Desktop hardware fields (old computers)", () => {
  it("accepts a period PC on create (machine, CPU, period speed, IDE, NE2000, floppy)", () => {
    const result = DesktopCreateResourceSchema.safeParse({
      type: "vm",
      name: "dos622",
      machine: "pc",
      cpuModel: "486",
      periodSpeed: true,
      diskBus: "ide",
      networkModel: "ne2k_pci",
      floppyId: "dos622-disk1.img",
    });
    expect(result.success).toBe(true);
  });

  it("refuses period speed without a period CPU, an unknown CPU/machine and a non-floppy file", () => {
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", periodSpeed: true }).success).toBe(false);
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", cpuModel: "host", periodSpeed: true }).success).toBe(false);
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", cpuModel: "z80" }).success).toBe(false);
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", machine: "virt" }).success).toBe(false);
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", floppyId: "../../etc/passwd" }).success).toBe(false);
    expect(DesktopCreateResourceSchema.safeParse({ type: "vm", name: "a", floppyId: "win.iso" }).success).toBe(false);
  });

  it("accepts hardware changes and a floppy eject on update", () => {
    expect(DesktopUpdateResourceSchema.safeParse({ machine: "q35" }).success).toBe(true);
    expect(DesktopUpdateResourceSchema.safeParse({ cpuModel: "pentium2", periodSpeed: true }).success).toBe(true);
    // Period speed alone: the server checks it against the VM's current CPU.
    expect(DesktopUpdateResourceSchema.safeParse({ periodSpeed: true }).success).toBe(true);
    expect(DesktopUpdateResourceSchema.safeParse({ floppyId: "" }).success).toBe(true);
    expect(DesktopUpdateResourceSchema.safeParse({ floppyId: "boot.vfd" }).success).toBe(true);
    expect(DesktopUpdateResourceSchema.safeParse({ cpuModel: "max", periodSpeed: true }).success).toBe(false);
    expect(DesktopUpdateResourceSchema.safeParse({ floppyId: "a/b.img" }).success).toBe(false);
  });
});

describe("Desktop quick create / disposable schemas", () => {
  it("validates quick create", () => {
    expect(DesktopQuickCreateSchema.safeParse({ os: "debian13" }).success).toBe(true);
    expect(DesktopQuickCreateSchema.safeParse({ os: "windows11", name: "win-11", node: "srv02" }).success).toBe(true);
    expect(DesktopQuickCreateSchema.safeParse({ os: "macos" }).success).toBe(false);
    expect(DesktopQuickCreateSchema.safeParse({ os: "debian13", name: "1bad" }).success).toBe(false);
  });

  it("validates a disposable launch and the stop actions", () => {
    expect(DesktopLaunchDisposableSchema.safeParse({ baseId: "debian13-amd64-1", strict: true, network: "isolated" }).success).toBe(true);
    expect(DesktopLaunchDisposableSchema.safeParse({ baseId: "../x" }).success).toBe(false);
    expect(DesktopLaunchDisposableSchema.safeParse({ baseId: "b", network: "bridge" }).success).toBe(false);
    expect(DesktopDisposableActionSchema.options).toEqual(["discard", "reset", "keep", "convert"]);
  });
});

describe("hardwareChoicesForArch", () => {
  it("offers the period PC choices on x86", () => {
    const x86 = hardwareChoicesForArch("x86_64");
    expect(x86.machines).toEqual(["auto", "q35", "pc"]);
    expect(x86.cpus).toEqual(expect.arrayContaining(["auto", "host", "max", "286", "386", "486", "pentium", "pentium4"]));
    expect(x86.diskBuses).toEqual(["virtio", "sata", "ide", "scsi"]);
    expect(x86.networkModels).toEqual(["virtio", "e1000", "rtl8139", "ne2k_pci", "pcnet"]);
    expect(x86.periodSpeed).toBe(true);
  });

  it("offers only what KVM on ARM64 accepts", () => {
    expect(hardwareChoicesForArch("aarch64")).toEqual({
      machines: ["auto"],
      cpus: ["auto", "host", "max"],
      diskBuses: ["virtio", "sata", "scsi"],
      networkModels: ["virtio", "e1000", "rtl8139"],
      periodSpeed: false,
    });
  });
});
