/**
 * Pure libvirt XML helpers for the virtual floppy drive (A: = fda on the
 * ISA floppy controller). Kept free of I/O so the generated XML is unit-tested.
 *
 * libvirt adds the FDC itself: on i440fx it is built in; on q35 libvirt emits
 * `-device isa-fdc` when a `<disk device="floppy">` with `bus="fdc"` exists.
 * ARM (`virt`), POWER and s390x machines have no FDC at all, so a floppy there
 * is refused instead of producing XML libvirt/QEMU would reject at start.
 */

export const FLOPPY_TARGET_DEV = "fda";

export type BootDevice = "hd" | "cdrom" | "network" | "fd";

const FLOPPY_ARCHES = new Set(["x86_64", "i686"]);
/** x86 machine types without an ISA bus (no floppy controller possible). */
const NO_ISA_MACHINES = /^microvm/;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class FloppyUnsupportedError extends Error {}

/** Throw a clear error when the domain's arch/machine has no floppy controller. */
export function assertFloppySupported(arch: string, machine: string): void {
  const a = arch || "x86_64";
  if (!FLOPPY_ARCHES.has(a)) {
    throw new FloppyUnsupportedError(
      `Floppy drives are not available on ${a} VMs: this machine type has no floppy controller (x86 only)`,
    );
  }
  if (NO_ISA_MACHINES.test(machine || "")) {
    throw new FloppyUnsupportedError(`Floppy drives are not available on machine type ${machine} (no ISA bus)`);
  }
}

/** Read `<type arch=… machine=…>` from a domain XML. */
export function domainArchMachine(xml: string): { arch: string; machine: string } {
  const typeTag = xml.match(/<type\b[^>]*>/i)?.[0] ?? "";
  return {
    arch: typeTag.match(/\barch=['"]([^'"]+)['"]/)?.[1] ?? "x86_64",
    machine: typeTag.match(/\bmachine=['"]([^'"]+)['"]/)?.[1] ?? "",
  };
}

/**
 * `<disk device="floppy">` for drive A:. Without a path the drive is present
 * but empty (media ejected). Raw format only: floppy images are sector dumps.
 */
export function buildFloppyDiskXml(options: { path?: string | null; readonly?: boolean; indent?: string } = {}): string {
  const indent = options.indent ?? "    ";
  const lines = [
    `${indent}<disk type="file" device="floppy">`,
    `${indent}  <driver name="qemu" type="raw"/>`,
    options.path ? `${indent}  <source file="${xmlEscape(options.path)}"/>` : "",
    `${indent}  <target dev="${FLOPPY_TARGET_DEV}" bus="fdc"/>`,
    options.readonly !== false ? `${indent}  <readonly/>` : "",
    `${indent}</disk>`,
  ];
  return lines.filter(Boolean).join("\n");
}

export interface FloppyDiskInfo {
  block: string;
  device: string;
  source: string | null;
  readonly: boolean;
}

/** The domain's floppy drive (first `<disk device="floppy">`), if any. */
export function findFloppyDisk(xml: string): FloppyDiskInfo | undefined {
  for (const match of xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)) {
    const block = match[0];
    const openTag = block.match(/<disk\b[^>]*>/i)?.[0] ?? "";
    if (!/\bdevice=['"]floppy['"]/i.test(openTag)) continue;
    return {
      block,
      device: block.match(/<target[^>]*dev=['"]([^'"]+)['"]/i)?.[1] ?? FLOPPY_TARGET_DEV,
      source: block.match(/<source[^>]*file=['"]([^'"]+)['"]/i)?.[1] ?? null,
      readonly: /<readonly\s*\/?>/i.test(block),
    };
  }
  return undefined;
}

/**
 * Set (path) or empty (null) drive A: in a persistent domain XML, adding the
 * drive if missing. `remove: true` deletes the drive itself. Used for the
 * offline `virsh define` path and for the "applies at next start" case.
 */
export function applyFloppyToDomainXml(
  xml: string,
  change: { path: string | null; readonly?: boolean; remove?: boolean },
): string {
  const existing = findFloppyDisk(xml);
  if (change.remove) {
    if (!existing) return xml;
    return xml.replace(new RegExp(`[ \\t]*${escapeRegExp(existing.block)}\\n?`), "");
  }
  const { arch, machine } = domainArchMachine(xml);
  assertFloppySupported(arch, machine);
  const block = buildFloppyDiskXml({
    path: change.path,
    readonly: change.readonly ?? existing?.readonly ?? true,
  });
  if (existing) {
    return xml.replace(new RegExp(`[ \\t]*${escapeRegExp(existing.block)}`), block);
  }
  // Insert after the last <disk> so the device list stays grouped, else before </devices>.
  const disks = [...xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)];
  const last = disks[disks.length - 1];
  if (last && last.index !== undefined) {
    const at = last.index + last[0].length;
    return `${xml.slice(0, at)}\n${block}${xml.slice(at)}`;
  }
  if (!/<\/devices>/i.test(xml)) throw new Error("Domain XML has no <devices> section");
  return xml.replace(/([ \t]*)<\/devices>/i, `${block}\n$1</devices>`);
}

/**
 * `<boot dev>` order. Floppy is only listed when it is the primary device, so
 * VMs that never use drive A: keep their historical hd/cdrom/network order.
 */
export function bootOrderDevices(primary: BootDevice): BootDevice[] {
  const rest = (["hd", "cdrom", "network"] as BootDevice[]).filter((entry) => entry !== primary);
  return [primary, ...rest];
}

export function bootOrderXmlLines(primary: BootDevice, indent = "    "): string {
  return bootOrderDevices(primary).map((device) => `${indent}<boot dev="${device}"/>`).join("\n");
}

/** OVMF/AAVMF have no floppy boot: refuse "fd first" on a UEFI domain. */
export function assertFloppyBootable(uefi: boolean): void {
  if (uefi) {
    throw new FloppyUnsupportedError("UEFI firmware cannot boot from a floppy: switch the VM to BIOS to boot from drive A:");
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
