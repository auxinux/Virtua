// Mirrors packages/shared/src/schemas/hardware.ts (the node API enforces it):
// the VDM UI bundle only imports shared types, never runtime code.
export const X86_CPU_MODELS = [
  "auto", "host", "max", "qemu64", "qemu32", "kvm64",
  "286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4", "athlon",
  "core2duo", "Nehalem", "SandyBridge", "Haswell", "Skylake-Client", "Cascadelake-Server", "EPYC",
];
const ARM_CPU_MODELS = ["auto", "host", "max"];
const VINTAGE_CPUS = ["286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4"];

const CPU_LABELS: Record<string, string> = {
  auto: "Auto (host CPU)",
  host: "Host (passthrough)",
  max: "Max (all QEMU features)",
  "286": "Intel 286 (runs as a 486)",
  "386": "Intel 386 (runs as a 486)",
  "486": "Intel 486",
  pentium: "Pentium",
  pentium2: "Pentium II",
  pentium3: "Pentium III",
  pentium4: "Pentium 4 (Pentium III + SSE2)",
};

export function isVintageCpu(value: string | undefined): boolean {
  return !!value && VINTAGE_CPUS.includes(value);
}

export function cpuModelsForArch(arch: string | undefined): string[] {
  return arch === "aarch64" ? ARM_CPU_MODELS : X86_CPU_MODELS;
}

export function cpuLabel(value: string | undefined): string {
  return CPU_LABELS[value ?? "auto"] ?? value ?? "auto";
}

export const NIC_MODELS: Array<{ value: string; label: string; x86Only?: boolean }> = [
  { value: "virtio", label: "virtio" },
  { value: "e1000", label: "e1000" },
  { value: "rtl8139", label: "rtl8139" },
  { value: "ne2k_pci", label: "NE2000 (ne2k_pci)", x86Only: true },
  { value: "pcnet", label: "AMD PCnet", x86Only: true },
];

export function nicModelsForArch(arch: string | undefined) {
  return NIC_MODELS.filter((m) => !m.x86Only || arch !== "aarch64");
}

/** "pc-q35-10.0" → "q35", "pc-i440fx-10.0" → "pc". */
export function machineChoice(machine: unknown): string {
  const value = String(machine ?? "").toLowerCase();
  if (value.includes("q35")) return "q35";
  if (value === "pc" || value.includes("i440fx")) return "pc";
  return String(machine ?? "");
}
