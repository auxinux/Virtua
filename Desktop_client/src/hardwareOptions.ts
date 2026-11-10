/** Machine types and CPU models offered for local VMs (same lists as platform.rs). */
export const machineOptions = [
  { value: "auto", label: "Automatique (q35)" },
  { value: "q35", label: "q35 — PC moderne (PCIe, UEFI, Windows 10/11)" },
  { value: "pc", label: "pc / i440FX — PC classique (DOS, Windows 9x/XP, vieux Linux)" },
];

const x86Cpus = [
  { value: "auto", label: "Automatique (le meilleur pour cet ordinateur)" },
  { value: "host", label: "host — le processeur de cet ordinateur (KVM/HVF/WHPX)" },
  { value: "max", label: "max — toutes les fonctions émulées" },
  { value: "qemu64", label: "qemu64 — x86-64 générique" },
  { value: "qemu32", label: "qemu32 — x86 32 bits générique" },
  { value: "kvm64", label: "kvm64" },
  { value: "286", label: "80286 — DOS (approché : 486 ralenti à ~2 MIPS)" },
  { value: "386", label: "80386 — DOS, Windows 3.x (approché : 486 ralenti à ~8 MIPS)" },
  { value: "486", label: "80486 — DOS, Windows 3.x/95" },
  { value: "pentium", label: "80586 / Pentium — Windows 95" },
  { value: "pentium2", label: "Pentium II — Windows 98" },
  { value: "pentium3", label: "Pentium III — Windows 98/2000/XP" },
  { value: "pentium4", label: "Pentium 4 — Windows XP (Pentium III + SSE2)" },
  { value: "athlon", label: "AMD Athlon" },
  { value: "core2duo", label: "Core 2 Duo — Windows XP/Vista/7" },
  { value: "Nehalem", label: "Nehalem (Core i7, 2008)" },
  { value: "SandyBridge", label: "Sandy Bridge (2011)" },
  { value: "Haswell", label: "Haswell (2013)" },
  { value: "Skylake-Client", label: "Skylake (2015) — Windows 11" },
  { value: "Cascadelake-Server", label: "Cascade Lake (serveur)" },
  { value: "EPYC", label: "AMD EPYC" },
];

const armCpus = [
  { value: "auto", label: "Automatique (le meilleur pour cet ordinateur)" },
  { value: "host", label: "host — le processeur de cet ordinateur (HVF/KVM)" },
  { value: "max", label: "max — toutes les fonctions émulées" },
  { value: "cortex-a53", label: "Cortex-A53" },
  { value: "cortex-a57", label: "Cortex-A57" },
  { value: "cortex-a72", label: "Cortex-A72 (Raspberry Pi 4)" },
  { value: "neoverse-n1", label: "Neoverse N1" },
];

export function cpuOptions(architecture?: string | null) {
  return architecture === "arm64" ? armCpus : x86Cpus;
}

export const legacyNetworkOptions = [
  { value: "ne2k_pci", label: "NE2000 (PCI) — DOS, Windows 3.x/9x" },
  { value: "pcnet", label: "AMD PCnet — Windows 9x/NT, vieux Linux" },
];

/** CPUs that can run at the speed of their time ("Vitesse d'époque"). */
export const periodCpus = new Set(["286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4"]);
