import { z } from "zod";

/**
 * Virtual hardware choices for old and modern guests (chipset, CPU model,
 * period speed, classic NICs). Ported from the Virtua Desktop client
 * (platform.rs `X86_CPUS`/`vintage_cpu`) so a VM described on one side means
 * the same machine on the other.
 *
 * Kept free of I/O: the API validates with these rules, the runner applies
 * them to the libvirt XML, and the UIs use them to grey out impossible combos.
 */

/** x86 chipsets offered: q35 (PCIe, default) and i440FX "pc" (PCI + ISA, IDE). */
export const X86_MACHINE_TYPES = ["q35", "pc"] as const;
export type X86MachineType = (typeof X86_MACHINE_TYPES)[number];

/**
 * CPU models offered on x86 (QEMU/libvirt names). `auto` keeps Virtua's
 * choice (host-passthrough). 286 and 386 have no QEMU model: they run as a
 * 486 and only differ by their period speed; "pentium4" is a Pentium III
 * with SSE2 (QEMU has no Pentium 4 model).
 */
export const X86_CPU_MODELS = [
  "auto", "host", "max", "qemu64", "qemu32", "kvm64",
  "286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4", "athlon",
  "core2duo", "Nehalem", "SandyBridge", "Haswell", "Skylake-Client", "Cascadelake-Server", "EPYC",
] as const;

/**
 * ARM64 nodes run their VMs under KVM, which only exposes the host CPU: a
 * named Cortex model (offered by the Desktop client, which emulates) would be
 * refused by KVM, so the server offers the host-equivalent choices only.
 */
export const ARM_CPU_MODELS = ["auto", "host", "max"] as const;

export const CPU_MODELS = [...new Set<string>([...X86_CPU_MODELS, ...ARM_CPU_MODELS])] as [string, ...string[]];
export const CpuModelSchema = z.enum(CPU_MODELS as [string, ...string[]]);
export type CpuModel = (typeof X86_CPU_MODELS)[number] | (typeof ARM_CPU_MODELS)[number];

export interface VintageCpu {
  /** libvirt `<model>` (QEMU `-cpu` name). */
  model: string;
  /** CPU features forced on (libvirt `<feature policy="require">`). */
  features: string[];
  /** `-icount shift=N`: 2^N ns per guest instruction (period speed). */
  icountShift: number;
}

/**
 * Period CPUs: the QEMU model used and the `-icount` shift giving roughly the
 * speed of the time (same table as Desktop's `vintage_cpu`).
 */
const VINTAGE_CPUS: Record<string, VintageCpu> = {
  "286": { model: "486", features: [], icountShift: 9 }, // ~2 MIPS
  "386": { model: "486", features: [], icountShift: 7 }, // ~8 MIPS
  "486": { model: "486", features: [], icountShift: 4 }, // ~60 MIPS (DX2/DX4)
  pentium: { model: "pentium", features: [], icountShift: 3 },
  pentium2: { model: "pentium2", features: [], icountShift: 2 },
  pentium3: { model: "pentium3", features: [], icountShift: 1 },
  pentium4: { model: "pentium3", features: ["sse2"], icountShift: 0 },
};

export function vintageCpu(choice: string | null | undefined): VintageCpu | undefined {
  return choice ? VINTAGE_CPUS[choice] : undefined;
}

export function isVintageCpu(choice: string | null | undefined): boolean {
  return !!vintageCpu(choice);
}

/** CPU models allowed for a QEMU arch (x86_64/aarch64). */
export function cpuModelsForArch(arch: string): readonly string[] {
  return arch === "aarch64" ? ARM_CPU_MODELS : X86_CPU_MODELS;
}

/** NIC models. NE2000 (ne2k_pci) and AMD PCnet: DOS packet drivers, Windows 3.x/9x. */
export const NETWORK_MODELS = ["virtio", "e1000", "rtl8139", "ne2k_pci", "pcnet"] as const;
export const NetworkModelSchema = z.enum(NETWORK_MODELS);
export type NetworkModel = z.infer<typeof NetworkModelSchema>;
/** Classic PC NICs: no ARM64 guest ships a driver for them. */
export const X86_ONLY_NETWORK_MODELS: readonly string[] = ["ne2k_pci", "pcnet"];

/** Disk buses that only exist on x86 PCs (the ARM `virt` machine has no IDE controller). */
export const X86_ONLY_DISK_BUSES: readonly string[] = ["ide"];

/**
 * Chipset family of a libvirt machine string: `pc-q35-10.0` → q35,
 * `pc-i440fx-10.0` / `pc` → pc, `virt-9.2` → virt.
 */
export function machineFamily(machine: string | null | undefined): "q35" | "pc" | "virt" | "other" {
  const value = (machine ?? "").toLowerCase();
  if (value.includes("q35")) return "q35";
  if (value === "pc" || value.includes("i440fx")) return "pc";
  if (value.startsWith("virt")) return "virt";
  return "other";
}

export interface HardwareChoice {
  arch: string;
  machine?: string;
  cpuModel?: string;
  periodSpeed?: boolean;
  diskBus?: string;
  networkModel?: string;
  secureBoot?: boolean;
}

/**
 * Every rule a hardware combination must follow, as user-facing messages
 * (empty = valid). Shared by the API schemas, the runner and the UIs.
 */
export function hardwareProblems(choice: HardwareChoice): Array<{ field: string; message: string }> {
  const problems: Array<{ field: string; message: string }> = [];
  const arm = choice.arch === "aarch64";
  const family = machineFamily(choice.machine ?? (arm ? "virt" : "q35"));
  const cpu = choice.cpuModel ?? "auto";

  if (arm) {
    if (!(ARM_CPU_MODELS as readonly string[]).includes(cpu)) {
      problems.push({ field: "cpuModel", message: `CPU model ${cpu} is x86 only (ARM64 VMs run the host CPU under KVM)` });
    }
    if (choice.periodSpeed) {
      problems.push({ field: "periodSpeed", message: "Period speed is for x86 period CPUs (286 to Pentium 4)" });
    }
    if (choice.diskBus && X86_ONLY_DISK_BUSES.includes(choice.diskBus)) {
      problems.push({ field: "diskBus", message: `The ${choice.diskBus.toUpperCase()} disk bus does not exist on ARM64 (virt has no IDE controller)` });
    }
    if (choice.networkModel && X86_ONLY_NETWORK_MODELS.includes(choice.networkModel)) {
      problems.push({ field: "networkModel", message: `${choice.networkModel} is a PC network card (x86 only)` });
    }
    return problems;
  }

  if (!(X86_CPU_MODELS as readonly string[]).includes(cpu)) {
    problems.push({ field: "cpuModel", message: `Unknown CPU model ${cpu}` });
  }
  if (choice.periodSpeed && !isVintageCpu(cpu)) {
    problems.push({ field: "periodSpeed", message: "Period speed needs a period CPU (286, 386, 486, Pentium … Pentium 4)" });
  }
  // libvirt refuses an IDE controller on q35 ("IDE controllers are unsupported
  // for this QEMU binary or machine type"): IDE means the i440FX chipset.
  if (choice.diskBus === "ide" && family === "q35") {
    problems.push({ field: "diskBus", message: "The IDE disk bus needs the i440FX (pc) machine type: q35 has no IDE controller" });
  }
  if (choice.secureBoot && family !== "q35") {
    problems.push({ field: "secureBoot", message: "Secure Boot requires the q35 machine type" });
  }
  return problems;
}

/** Zod `superRefine` adapter for `hardwareProblems`. */
export function refineHardware(choice: HardwareChoice, ctx: z.RefinementCtx): void {
  for (const problem of hardwareProblems(choice)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message, path: [problem.field] });
  }
}

/** Disk buses offered for a new VM's system disk. */
export const DISK_BUSES = ["virtio", "sata", "ide", "scsi"] as const;

export interface HardwareChoices {
  /** `auto` = the default chipset of the arch (q35 on x86, virt on ARM64). */
  machines: string[];
  cpus: string[];
  diskBuses: string[];
  networkModels: string[];
  /** Whether period speed (286 … Pentium 4 at their own pace) exists here. */
  periodSpeed: boolean;
}

/**
 * Every hardware id a node of QEMU arch `arch` (x86_64/aarch64) accepts, as
 * offered to clients (Virtua Desktop's cloud mode): the same ids the API
 * validates with `hardwareProblems`.
 */
export function hardwareChoicesForArch(arch: string): HardwareChoices {
  const arm = arch === "aarch64";
  return {
    machines: arm ? ["auto"] : ["auto", ...X86_MACHINE_TYPES],
    cpus: [...cpuModelsForArch(arch)],
    diskBuses: DISK_BUSES.filter((bus) => !arm || !X86_ONLY_DISK_BUSES.includes(bus)),
    networkModels: NETWORK_MODELS.filter((model) => !arm || !X86_ONLY_NETWORK_MODELS.includes(model)),
    periodSpeed: !arm,
  };
}
