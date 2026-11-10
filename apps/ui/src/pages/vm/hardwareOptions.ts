// Mirrors packages/shared/src/schemas/hardware.ts (the API enforces it): the
// UI bundle does not import shared runtime code, only its types.
const X86_CPU_MODELS = [
  "auto", "host", "max", "qemu64", "qemu32", "kvm64",
  "286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4", "athlon",
  "core2duo", "Nehalem", "SandyBridge", "Haswell", "Skylake-Client", "Cascadelake-Server", "EPYC",
];
const ARM_CPU_MODELS = ["auto", "host", "max"];
const VINTAGE_CPUS = ["286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4"];

export function isVintageCpu(value: string | undefined): boolean {
  return !!value && VINTAGE_CPUS.includes(value);
}

export function cpuModelsForArch(arch: string): string[] {
  return arch === "aarch64" ? ARM_CPU_MODELS : X86_CPU_MODELS;
}

/** French labels of the CPU models (QEMU names stay visible for the modern ones). */
const CPU_LABELS: Record<string, string> = {
  auto: "Automatique (CPU de l'hôte)",
  host: "Hôte (host-passthrough)",
  max: "Maximum (toutes les fonctions de QEMU)",
  "286": "Intel 286 (émulé en 486)",
  "386": "Intel 386 (émulé en 486)",
  "486": "Intel 486",
  pentium: "Pentium",
  pentium2: "Pentium II",
  pentium3: "Pentium III",
  pentium4: "Pentium 4 (Pentium III + SSE2)",
  athlon: "AMD Athlon",
  core2duo: "Core 2 Duo",
};

export interface CpuOptionGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

/** CPU choices for an arch, grouped for a <select>. */
export function cpuOptionGroups(arch: string): CpuOptionGroup[] {
  const models = cpuModelsForArch(arch);
  const label = (value: string) => CPU_LABELS[value] ?? value;
  const general: string[] = models.filter((m) => m === "auto" || m === "host" || m === "max");
  const period = models.filter((m) => isVintageCpu(m));
  const modern = models.filter((m) => !general.includes(m) && !period.includes(m));
  return [
    { label: "Général", options: general.map((value) => ({ value, label: label(value) })) },
    { label: "Époque (DOS, Windows 3.x/9x/XP)", options: period.map((value) => ({ value, label: label(value) })) },
    { label: "Modèles x86", options: modern.map((value) => ({ value, label: label(value) })) },
  ].filter((group) => group.options.length > 0);
}

export function cpuLabel(value: string | undefined): string {
  return CPU_LABELS[value ?? "auto"] ?? value ?? "auto";
}

export const NIC_MODEL_OPTIONS: Array<{ value: string; label: string; x86Only?: boolean }> = [
  { value: "virtio", label: "VirtIO (recommandé)" },
  { value: "e1000", label: "Intel E1000" },
  { value: "rtl8139", label: "Realtek RTL8139" },
  { value: "ne2k_pci", label: "NE2000 PCI (DOS, Windows 3.x/9x)", x86Only: true },
  { value: "pcnet", label: "AMD PCnet (DOS, Windows 9x)", x86Only: true },
];

export function nicModelOptions(arch: string | undefined) {
  return NIC_MODEL_OPTIONS.filter((option) => !option.x86Only || arch !== "aarch64");
}

/** "pc-q35-10.0" → "q35", "pc-i440fx-10.0" → "pc". */
export function machineChoice(machine: string | undefined): "q35" | "pc" | string {
  const value = (machine ?? "").toLowerCase();
  if (value.includes("q35")) return "q35";
  if (value === "pc" || value.includes("i440fx")) return "pc";
  return machine ?? "";
}
