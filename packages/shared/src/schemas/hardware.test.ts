import { describe, expect, it } from "vitest";
import { AttachNetworkSchema, CreateVmSchema, UpdateNetworkSchema, UpdateVmConfigSchema } from "./vm";
import { cpuModelsForArch, hardwareProblems, machineFamily, vintageCpu } from "./hardware";

const vm = { name: "dos", vcpus: 1, memoryMb: 256, os: "other" };

describe("vintageCpu", () => {
  it("maps period CPUs like the Desktop client", () => {
    expect(vintageCpu("286")).toEqual({ model: "486", features: [], icountShift: 9 });
    expect(vintageCpu("386")?.icountShift).toBe(7);
    expect(vintageCpu("486")?.icountShift).toBe(4);
    expect(vintageCpu("pentium4")).toEqual({ model: "pentium3", features: ["sse2"], icountShift: 0 });
    expect(vintageCpu("Haswell")).toBeUndefined();
    expect(vintageCpu(undefined)).toBeUndefined();
  });

  it("offers only host-equivalent CPUs on ARM64 (KVM)", () => {
    expect(cpuModelsForArch("aarch64")).toEqual(["auto", "host", "max"]);
    expect(cpuModelsForArch("x86_64")).toContain("286");
  });
});

describe("machineFamily", () => {
  it("recognises libvirt's expanded machine names", () => {
    expect(machineFamily("pc-q35-10.0")).toBe("q35");
    expect(machineFamily("q35")).toBe("q35");
    expect(machineFamily("pc-i440fx-10.0")).toBe("pc");
    expect(machineFamily("pc")).toBe("pc");
    expect(machineFamily("virt-9.2")).toBe("virt");
    expect(machineFamily("microvm")).toBe("other");
  });
});

describe("hardwareProblems", () => {
  it("accepts an old PC (i440FX, IDE, NE2000, 286 at period speed)", () => {
    expect(hardwareProblems({ arch: "x86_64", machine: "pc", cpuModel: "286", periodSpeed: true, diskBus: "ide", networkModel: "ne2k_pci" })).toEqual([]);
  });

  it("refuses IDE on q35 and Secure Boot outside q35", () => {
    expect(hardwareProblems({ arch: "x86_64", machine: "q35", diskBus: "ide" })[0].field).toBe("diskBus");
    expect(hardwareProblems({ arch: "x86_64", machine: "pc-i440fx-10.0", secureBoot: true })[0].field).toBe("secureBoot");
  });

  it("refuses x86-only choices on ARM64", () => {
    const fields = hardwareProblems({ arch: "aarch64", cpuModel: "486", periodSpeed: true, diskBus: "ide", networkModel: "pcnet" }).map((p) => p.field);
    expect(fields).toEqual(["cpuModel", "periodSpeed", "diskBus", "networkModel"]);
    expect(hardwareProblems({ arch: "aarch64", cpuModel: "host", diskBus: "virtio", networkModel: "virtio" })).toEqual([]);
  });

  it("needs a period CPU for period speed", () => {
    expect(hardwareProblems({ arch: "x86_64", cpuModel: "Skylake-Client", periodSpeed: true })[0].field).toBe("periodSpeed");
    expect(hardwareProblems({ arch: "x86_64", cpuModel: "auto", periodSpeed: true })[0].field).toBe("periodSpeed");
  });
});

describe("CreateVmSchema hardware", () => {
  it("defaults to the historical hardware", () => {
    const parsed = CreateVmSchema.parse(vm);
    expect(parsed).toMatchObject({ cpuModel: "auto", periodSpeed: false, networkModel: "virtio", machine: "q35" });
  });

  it("accepts a DOS PC and rejects the same disk on q35", () => {
    const dos = { ...vm, diskGb: 1, storagePool: "local", machine: "pc", diskBus: "ide", cpuModel: "386", periodSpeed: true, networkModel: "pcnet" };
    expect(CreateVmSchema.safeParse(dos).success).toBe(true);
    const onQ35 = CreateVmSchema.safeParse({ ...dos, machine: "q35" });
    expect(onQ35.success).toBe(false);
    expect(onQ35.error?.issues[0].path).toEqual(["diskBus"]);
    // Diskless: no disk bus to check.
    expect(CreateVmSchema.safeParse({ ...vm, machine: "q35", diskBus: "ide" }).success).toBe(true);
  });

  it("rejects unknown CPU models (no option smuggled into -cpu) and ARM period speed", () => {
    expect(CreateVmSchema.safeParse({ ...vm, cpuModel: "486,+vmx" }).success).toBe(false);
    expect(CreateVmSchema.safeParse({ ...vm, arch: "aarch64", machine: "virt", cpuModel: "486" }).success).toBe(false);
    expect(CreateVmSchema.safeParse({ ...vm, arch: "aarch64", machine: "virt", networkModel: "ne2k_pci" }).success).toBe(false);
  });
});

describe("UpdateVmConfigSchema hardware", () => {
  it("accepts chipset/CPU/period changes and refuses period speed with a modern CPU", () => {
    expect(UpdateVmConfigSchema.safeParse({ machine: "pc", cpuModel: "pentium", periodSpeed: true }).success).toBe(true);
    expect(UpdateVmConfigSchema.safeParse({ periodSpeed: true }).success).toBe(true); // checked against the VM by the runner
    expect(UpdateVmConfigSchema.safeParse({ cpuModel: "EPYC", periodSpeed: true }).success).toBe(false);
    expect(UpdateVmConfigSchema.safeParse({ machine: "virt" }).success).toBe(false);
  });
});

describe("NIC schemas", () => {
  it("offer NE2000 and PCnet", () => {
    expect(AttachNetworkSchema.parse({ bridge: "virbr0", model: "ne2k_pci" }).model).toBe("ne2k_pci");
    expect(UpdateNetworkSchema.parse({ model: "pcnet" }).model).toBe("pcnet");
    expect(AttachNetworkSchema.safeParse({ bridge: "virbr0", model: "ne2k_isa" }).success).toBe(false);
  });
});
