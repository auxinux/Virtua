/**
 * Pure builder of a new libvirt domain XML. Used by every path that defines a
 * fresh VM (create, disposable launch, quick create) so their hardware stays
 * identical and is unit-tested without libvirt.
 */
import { buildFloppyDiskXml, bootOrderXmlLines, type BootDevice } from "./floppy.js";
import { applyCpuChoice, buildCpuXml, mergeVirtuaMetadata, type VirtuaMetadata } from "./vmHardware.js";

export type VideoModel = "vga" | "virtio" | "qxl";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildVideoBlock(model: VideoModel) {
  if (model === "virtio") {
    // virtio-gpu WITHOUT 3D acceleration. Enabling accel3d="yes" makes
    // libvirt instantiate `virtio-vga-gl` on the QEMU side, which only
    // works if the display backend has OpenGL turned on (SPICE+gl, or
    // -display egl-headless). VNC — the default we expose via noVNC —
    // does not support GL, and QEMU refuses to start with:
    //   "The display backend does not have OpenGL support enabled"
    // VirGL acceleration belongs to a future SPICE-graphics code path,
    // not the default headless-server experience.
    return `    <video><model type="virtio" heads="1" primary="yes" vram="65536"/></video>`;
  }
  if (model === "qxl") {
    // vgamem bounds the primary surface: 16M tops out around 1920x1080, which
    // silently breaks SPICE auto-resize above that. 64M covers 4K (3840x2160x4).
    return `    <video><model type="qxl" ram="131072" vram="131072" vgamem="65536" heads="1" primary="yes"/></video>`;
  }
  return `    <video><model type="vga" vram="16384" heads="1" primary="yes"/></video>`;
}

export function buildSpiceGraphicsBlock(indent = "    ") {
  return [
    `${indent}<graphics type="spice" port="-1" autoport="yes" listen="127.0.0.1">`,
    `${indent}  <listen type="address" address="127.0.0.1"/>`,
    `${indent}  <playback compression="on"/>`,
    `${indent}  <clipboard copypaste="no"/>`,
    `${indent}  <filetransfer enable="no"/>`,
    `${indent}</graphics>`,
  ].join("\n");
}

export function buildSpiceAudioBlocks(indent = "    ", id = 1) {
  return [
    `${indent}<sound model="ich9">`,
    `${indent}  <codec type="duplex"/>`,
    `${indent}  <audio id="${id}"/>`,
    `${indent}</sound>`,
    `${indent}<audio id="${id}" type="spice"/>`,
  ].join("\n");
}

export interface VmDomainSpec {
  name: string;
  vcpus: number;
  memoryMb: number;
  arch: string;
  machine: string;
  /** Pre-rendered `<loader>`/`<nvram>` lines (UEFI), empty for BIOS. */
  firmwareLines?: string;
  secureBoot?: boolean;
  bootDevice: BootDevice;
  disk?: {
    path: string;
    bus: string;
    /** Strict sandbox: libvirt drops every write when the VM stops. */
    transient?: boolean;
  };
  /** CD-ROMs in order (first = installer). */
  cdroms?: string[];
  floppy?: { path: string; readonly: boolean };
  /** null = no network card at all. */
  network?: { bridge: string; mac?: string; model: string } | null;
  tpm?: boolean;
  videoModel: VideoModel;
  qemuAgent?: boolean;
  cpuModel?: string;
  periodSpeed?: boolean;
  /** Direct kernel boot (unattended Debian installer). */
  directKernel?: { kernel: string; initrd: string; cmdline: string };
  metadata?: VirtuaMetadata;
}

/** Target device name of the primary disk for a bus. */
export function primaryDiskDevice(bus: string): string {
  return bus === "virtio" ? "vda" : bus === "ide" ? "hda" : "sda";
}

/**
 * CD-ROM targets that cannot collide with the primary disk:
 * virtio disk vda → sda, sdb…; sata disk sda → sdb, sdc…; ide disk hda →
 * hdb, hdc… (IDE: 4 devices max on the two channels).
 */
export function cdromTargets(diskBus: string | undefined, count: number): Array<{ dev: string; bus: string }> {
  const bus = diskBus === "ide" ? "ide" : "sata";
  const prefix = bus === "ide" ? "hd" : "sd";
  const first = diskBus === "sata" || diskBus === "ide" ? 1 : 0;
  const out: Array<{ dev: string; bus: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const index = first + i;
    if (bus === "ide" && index > 3) throw new Error("IDE has room for four drives only (disk + three CD-ROMs)");
    out.push({ dev: `${prefix}${String.fromCharCode(97 + index)}`, bus });
  }
  return out;
}

export function buildVmDomainXml(spec: VmDomainSpec): string {
  const diskBus = spec.disk?.bus;
  const cdroms = spec.cdroms ?? [];
  const cdTargets = cdromTargets(diskBus, cdroms.length);
  const typeLine = `    <type arch="${xmlEscape(spec.arch)}" machine="${xmlEscape(spec.machine)}">hvm</type>`;
  const kernelLines = spec.directKernel ? [
    `    <kernel>${xmlEscape(spec.directKernel.kernel)}</kernel>`,
    `    <initrd>${xmlEscape(spec.directKernel.initrd)}</initrd>`,
    `    <cmdline>${xmlEscape(spec.directKernel.cmdline)}</cmdline>`,
  ].join("\n") : "";
  const network = spec.network;

  const xml = [
    `<domain type="kvm">`,
    `  <name>${xmlEscape(spec.name)}</name>`,
    `  <memory unit="MiB">${spec.memoryMb}</memory>`,
    `  <currentMemory unit="MiB">${spec.memoryMb}</currentMemory>`,
    `  <vcpu>${spec.vcpus}</vcpu>`,
    `  <os>`,
    spec.firmwareLines ? `${typeLine}\n${spec.firmwareLines}` : typeLine,
    kernelLines,
    bootOrderXmlLines(spec.bootDevice),
    `  </os>`,
    `  <features><acpi/><apic/>${spec.secureBoot ? `<smm state="on"/>` : ""}</features>`,
    `  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>`,
    `  ${buildCpuXml(spec.vcpus)}`,
    `  <devices>`,
    `    <emulator>/usr/bin/qemu-system-${xmlEscape(spec.arch)}</emulator>`,
    spec.disk ? [
      `    <disk type="file" device="disk">`,
      `      <driver name="qemu" type="qcow2" cache="none" io="native" discard="unmap"/>`,
      `      <source file="${xmlEscape(spec.disk.path)}"/>`,
      `      <target dev="${primaryDiskDevice(spec.disk.bus)}" bus="${xmlEscape(spec.disk.bus)}"/>`,
      spec.disk.transient ? `      <transient/>` : "",
      `    </disk>`,
    ].filter(Boolean).join("\n") : "",
    ...cdroms.map((iso, i) => [
      `    <disk type="file" device="cdrom">`,
      `      <driver name="qemu" type="raw"/>`,
      `      <source file="${xmlEscape(iso)}"/>`,
      `      <target dev="${cdTargets[i].dev}" bus="${cdTargets[i].bus}"/>`,
      `      <readonly/>`,
      `    </disk>`,
    ].join("\n")),
    spec.floppy ? buildFloppyDiskXml({ path: spec.floppy.path, readonly: spec.floppy.readonly }) : "",
    network ? [
      `    <interface type="bridge">`,
      network.mac ? `      <mac address="${xmlEscape(network.mac)}"/>` : "",
      `      <source bridge="${xmlEscape(network.bridge)}"/>`,
      `      <model type="${xmlEscape(network.model)}"/>`,
      `    </interface>`,
    ].filter(Boolean).join("\n") : "",
    `    <graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1">`,
    `      <listen type="address" address="127.0.0.1"/>`,
    `    </graphics>`,
    buildSpiceGraphicsBlock(),
    buildSpiceAudioBlocks(),
    spec.tpm ? `    <tpm model="tpm-crb"><backend type="emulator" version="2.0"/></tpm>` : "",
    buildVideoBlock(spec.videoModel),
    `    <input type="tablet" bus="usb"/>`,
    `    <channel type="spicevmc"><target type="virtio" name="com.redhat.spice.0"/></channel>`,
    `    <serial type="pty">`,
    `      <target port="0"/>`,
    `    </serial>`,
    `    <console type="pty">`,
    `      <target type="serial" port="0"/>`,
    `    </console>`,
    spec.qemuAgent !== false ? `    <channel type="unix">\n      <source mode="bind"/>\n      <target type="virtio" name="org.qemu.guest_agent.0"/>\n    </channel>` : "",
    `    <memballoon model="virtio"/>`,
    `    <rng model="virtio"><backend model="random">/dev/urandom</backend></rng>`,
    `  </devices>`,
    `</domain>`,
  ].filter(Boolean).join("\n");

  const cpuModel = spec.cpuModel ?? "auto";
  let out = xml;
  if (cpuModel !== "auto" || spec.periodSpeed) {
    out = applyCpuChoice(out, { cpuModel, periodSpeed: !!spec.periodSpeed, vcpus: spec.vcpus });
  }
  if (spec.metadata) out = mergeVirtuaMetadata(out, spec.metadata);
  return out;
}
