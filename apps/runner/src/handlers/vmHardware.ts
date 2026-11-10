/**
 * Pure libvirt XML helpers for the VM hardware choices of old and modern
 * guests: CPU model, period speed, chipset change, plus the Virtua metadata
 * block those choices (and the disposable state) are remembered in.
 * Kept free of I/O so the generated XML is unit-tested.
 *
 * Period speed = emulated CPU throttled to its era:
 *   <domain type="qemu">                      → libvirt passes `-accel tcg`
 *   <qemu:commandline> -icount shift=N,sleep=on
 * QEMU refuses MTTCG with icount ("No MTTCG when icount is enabled") but
 * libvirt never asks for `thread=multi`: with icount QEMU's default for plain
 * `-accel tcg` is single-threaded TCG (checked against QEMU 10.0).
 */
import { machineFamily, vintageCpu } from "@auxinux/shared";

export const VIRTUA_METADATA_NS = "https://auxinux.ca/virtua/1.0";
export const QEMU_NS = "http://libvirt.org/schemas/domain/qemu/1.0";

export interface VirtuaMetadata {
  /** CPU model choice as offered to the user (keeps 286 vs 386, both QEMU 486). */
  cpuModel?: string;
  periodSpeed?: boolean;
  disposable?: { baseId: string; baseLabel: string; strict: boolean };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attr(tag: string, name: string): string | undefined {
  const raw = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`))?.slice(1).find((v) => v !== undefined);
  return raw === undefined ? undefined : xmlUnescape(raw);
}

/**
 * The `<prefix:vm xmlns:prefix="…virtua…">` element, whatever prefix libvirt
 * kept when it re-serialized the domain.
 */
function findVirtuaElement(xml: string): { block: string; prefix: string } | undefined {
  const open = new RegExp(`<([A-Za-z_][\\w.-]*):vm\\b[^>]*xmlns:\\1=["']${escapeRegExp(VIRTUA_METADATA_NS)}["'][^>]*?(/?)>`);
  const match = xml.match(open);
  if (!match || match.index === undefined) return undefined;
  const prefix = match[1];
  if (match[2] === "/") return { block: match[0], prefix };
  const closeTag = `</${prefix}:vm>`;
  const end = xml.indexOf(closeTag, match.index);
  if (end < 0) return undefined;
  return { block: xml.slice(match.index, end + closeTag.length), prefix };
}

export function readVirtuaMetadata(xml: string): VirtuaMetadata {
  const found = findVirtuaElement(xml);
  if (!found) return {};
  const { block, prefix } = found;
  const meta: VirtuaMetadata = {};
  const cpuTag = block.match(new RegExp(`<${prefix}:cpu\\b[^>]*>`))?.[0];
  if (cpuTag) {
    const model = attr(cpuTag, "model");
    if (model) meta.cpuModel = model;
    meta.periodSpeed = attr(cpuTag, "periodSpeed") === "yes";
  }
  const disposableTag = block.match(new RegExp(`<${prefix}:disposable\\b[^>]*>`))?.[0];
  if (disposableTag) {
    const baseId = attr(disposableTag, "base");
    if (baseId) {
      meta.disposable = {
        baseId,
        baseLabel: attr(disposableTag, "label") ?? baseId,
        strict: attr(disposableTag, "strict") === "yes",
      };
    }
  }
  return meta;
}

export function buildVirtuaMetadataElement(meta: VirtuaMetadata, indent = "    "): string {
  const children: string[] = [];
  if (meta.cpuModel && meta.cpuModel !== "auto") {
    children.push(`${indent}  <virtua:cpu model="${xmlEscape(meta.cpuModel)}" periodSpeed="${meta.periodSpeed ? "yes" : "no"}"/>`);
  }
  if (meta.disposable) {
    const d = meta.disposable;
    children.push(`${indent}  <virtua:disposable base="${xmlEscape(d.baseId)}" label="${xmlEscape(d.baseLabel)}" strict="${d.strict ? "yes" : "no"}"/>`);
  }
  if (children.length === 0) return "";
  return [`${indent}<virtua:vm xmlns:virtua="${VIRTUA_METADATA_NS}">`, ...children, `${indent}</virtua:vm>`].join("\n");
}

/**
 * Replace the Virtua metadata element (one element per namespace: libvirt
 * keeps only one), leaving other tools' metadata (libosinfo…) untouched.
 */
export function writeVirtuaMetadata(xml: string, meta: VirtuaMetadata): string {
  let out = xml;
  const existing = findVirtuaElement(out);
  if (existing) out = out.replace(new RegExp(`[ \\t]*${escapeRegExp(existing.block)}\\n?`), "");
  // An emptied <metadata> is dropped so the XML stays as libvirt writes it.
  out = out.replace(/\n?[ \t]*<metadata>\s*<\/metadata>/i, "").replace(/\n?[ \t]*<metadata\/>/i, "");
  const element = buildVirtuaMetadataElement(meta);
  if (!element) return out;
  if (/<metadata>/i.test(out)) return out.replace(/<metadata>/i, `<metadata>\n${element}`);
  const block = `  <metadata>\n${element}\n  </metadata>`;
  // libvirt reads by XPath, any position works; next to <name> keeps it readable.
  if (/<\/name>/i.test(out)) return out.replace(/(<\/name>)/i, `$1\n${block}`);
  return out.replace(/(<domain\b[^>]*>)/i, `$1\n${block}`);
}

export function mergeVirtuaMetadata(xml: string, patch: Partial<VirtuaMetadata>): string {
  const current = readVirtuaMetadata(xml);
  const next: VirtuaMetadata = { ...current, ...patch };
  for (const key of Object.keys(patch) as Array<keyof VirtuaMetadata>) {
    if (patch[key] === undefined) delete next[key];
  }
  return writeVirtuaMetadata(xml, next);
}

// ── CPU ─────────────────────────────────────────────────────────────────────

/**
 * `<cpu>` for a CPU choice. `auto`/`host` = host-passthrough (Virtua's
 * historical default), `max` = libvirt "maximum", anything else a custom model
 * with check="none" so libvirt does not refuse a model the host lacks a
 * feature of (KVM simply masks it).
 */
export function buildCpuXml(vcpus: number, cpuModel = "auto"): string {
  const cores = Math.max(1, Math.floor(vcpus));
  const topology = `<topology sockets="1" cores="${cores}" threads="1"/>`;
  if (cpuModel === "auto" || cpuModel === "host" || !cpuModel) {
    return `<cpu mode="host-passthrough" check="none" migratable="on">${topology}</cpu>`;
  }
  if (cpuModel === "max") {
    return `<cpu mode="maximum" check="none" migratable="on">${topology}</cpu>`;
  }
  const vintage = vintageCpu(cpuModel);
  const model = vintage?.model ?? cpuModel;
  const features = (vintage?.features ?? []).map((name) => `<feature policy="require" name="${xmlEscape(name)}"/>`).join("");
  return `<cpu mode="custom" match="exact" check="none"><model fallback="forbid">${xmlEscape(model)}</model>${topology}${features}</cpu>`;
}

/** Replace (or add after <features>) the domain's `<cpu>`. */
export function replaceCpuXml(xml: string, cpuXml: string): string {
  if (/<cpu\b[\s\S]*?<\/cpu>/i.test(xml)) return xml.replace(/<cpu\b[\s\S]*?<\/cpu>/i, cpuXml);
  if (/<cpu\b[^>]*\/>/i.test(xml)) return xml.replace(/<cpu\b[^>]*\/>/i, cpuXml);
  if (/<\/features>/i.test(xml)) return xml.replace(/(<\/features>)/i, `$1\n  ${cpuXml}`);
  return xml.replace(/(<\/os>)/i, `$1\n  ${cpuXml}`);
}

/** Hardware of a domain as shown in the VM list (cheap: from the XML already dumped). */
export function domainListHardware(xml: string): {
  machine: string;
  cpuModel: string;
  periodSpeed: boolean;
  diskBus: string | null;
  mountedFloppy: string | null;
} {
  const meta = readVirtuaMetadata(xml);
  const typeTag = xml.match(/<type\b[^>]*>/i)?.[0] ?? "";
  let diskBus: string | null = null;
  let mountedFloppy: string | null = null;
  for (const match of xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)) {
    const block = match[0];
    const device = block.match(/<disk\b[^>]*\bdevice=['"]([^'"]+)['"]/i)?.[1] ?? "disk";
    if (device === "disk" && diskBus === null) {
      diskBus = block.match(/<target[^>]*\bbus=['"]([^'"]+)['"]/i)?.[1] ?? null;
    } else if (device === "floppy" && mountedFloppy === null) {
      const source = block.match(/<source[^>]*\bfile=['"]([^'"]+)['"]/i)?.[1];
      if (source) mountedFloppy = source.split("/").pop() ?? null;
    }
  }
  return {
    machine: typeTag.match(/\bmachine=['"]([^'"]+)['"]/)?.[1] ?? "",
    cpuModel: meta.cpuModel ?? "auto",
    periodSpeed: !!meta.periodSpeed && domainVirtType(xml) === "qemu",
    diskBus,
    mountedFloppy,
  };
}

/** CPU choice of a domain: the Virtua metadata, else "auto". */
export function domainCpuModel(xml: string): string {
  return readVirtuaMetadata(xml).cpuModel ?? "auto";
}

// ── Period speed ────────────────────────────────────────────────────────────

export function domainVirtType(xml: string): string {
  return xml.match(/<domain\b[^>]*\btype=['"]([^'"]+)['"]/i)?.[1] ?? "kvm";
}

/** The `shift=N` of a `-icount` already in the domain's qemu:commandline. */
export function domainIcountShift(xml: string): number | undefined {
  const m = xml.match(/<qemu:arg\s+value=['"]-icount['"]\s*\/>\s*<qemu:arg\s+value=['"]shift=(\d+)[^'"]*['"]\s*\/>/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function removeIcountArgs(xml: string): string {
  let out = xml.replace(/[ \t]*<qemu:arg\s+value=['"]-icount['"]\s*\/>\s*<qemu:arg\s+value=['"][^'"]*['"]\s*\/>\n?/gi, "");
  // Drop a commandline block left empty.
  out = out.replace(/[ \t]*<qemu:commandline>\s*<\/qemu:commandline>\n?/gi, "");
  return out;
}

/**
 * Turn period speed on (`shift` = icount shift) or off (null): domain type
 * qemu/kvm and the `-icount` passthrough. Other qemu:commandline args are kept.
 */
export function applyPeriodSpeed(xml: string, shift: number | null): string {
  let out = removeIcountArgs(xml);
  const virtType = shift === null ? "kvm" : "qemu";
  out = out.replace(/<domain\b([^>]*)>/i, (_tag, attrs: string) => {
    const withType = /\btype=['"][^'"]*['"]/.test(attrs)
      ? attrs.replace(/\btype=['"][^'"]*['"]/, `type="${virtType}"`)
      : ` type="${virtType}"${attrs}`;
    return `<domain${withType}>`;
  });
  if (shift === null) return out;
  if (!Number.isInteger(shift) || shift < 0 || shift > 10) throw new Error(`Invalid icount shift: ${shift}`);
  if (!/xmlns:qemu=/.test(out.match(/<domain\b[^>]*>/i)?.[0] ?? "")) {
    out = out.replace(/<domain\b([^>]*)>/i, `<domain$1 xmlns:qemu="${QEMU_NS}">`);
  }
  // 2^shift ns per instruction; sleep=on idles the host instead of racing
  // ahead when the guest is faster than its era.
  const args = `    <qemu:arg value="-icount"/>\n    <qemu:arg value="shift=${shift},sleep=on"/>`;
  if (/<qemu:commandline>/i.test(out)) {
    return out.replace(/(<qemu:commandline>)/i, `$1\n${args}`);
  }
  return out.replace(/([ \t]*)<\/domain>/i, `  <qemu:commandline>\n${args}\n  </qemu:commandline>\n</domain>`);
}

/**
 * Apply a CPU choice and period speed to a domain (CPU block, domain type,
 * icount, metadata). `vcpus` sizes the topology. Throws on an impossible combo.
 */
export function applyCpuChoice(xml: string, choice: { cpuModel: string; periodSpeed: boolean; vcpus: number }): string {
  const vintage = vintageCpu(choice.cpuModel);
  if (choice.periodSpeed && !vintage) {
    throw new Error("Period speed needs a period CPU (286, 386, 486, Pentium … Pentium 4)");
  }
  let out = replaceCpuXml(xml, buildCpuXml(choice.vcpus, choice.cpuModel));
  out = applyPeriodSpeed(out, choice.periodSpeed && vintage ? vintage.icountShift : null);
  // Under TCG libvirt refuses vhost-net ("not supported with this QEMU binary").
  if (choice.periodSpeed) out = stripVhostNet(out);
  return mergeVirtuaMetadata(out, {
    cpuModel: choice.cpuModel === "auto" ? undefined : choice.cpuModel,
    periodSpeed: choice.cpuModel === "auto" ? undefined : choice.periodSpeed,
  });
}

/** Remove `<driver name="vhost" …/>` from every interface. */
export function stripVhostNet(xml: string): string {
  return xml.replace(/<interface\b[\s\S]*?<\/interface>/gi, (block) => block.replace(/\s*<driver\b[^>]*name=['"]vhost['"][^>]*\/>/i, ""));
}

// ── Chipset ─────────────────────────────────────────────────────────────────

/**
 * Switch an x86 domain between q35 and i440FX ("pc"). Every PCI address and
 * PCI controller was laid out for the old chipset, so they are dropped and
 * libvirt lays the devices out again on define. Drive addresses go too: the
 * disk controllers are not the same (ICH9 AHCI vs PIIX IDE).
 */
export function applyMachineType(xml: string, target: "q35" | "pc"): string {
  const typeTag = xml.match(/<type\b[^>]*>/i)?.[0] ?? "";
  const arch = typeTag.match(/\barch=['"]([^'"]+)['"]/)?.[1] ?? "x86_64";
  if (arch !== "x86_64" && arch !== "i686") throw new Error(`The machine type can only be changed on x86 VMs (this one is ${arch})`);
  const current = machineFamily(typeTag.match(/\bmachine=['"]([^'"]+)['"]/)?.[1]);
  if (current === target) return xml;

  const diskBuses = [...xml.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)].map((m) => m[0].match(/<target\b[^>]*\bbus=['"]([^'"]+)['"]/i)?.[1]);
  if (target === "q35" && diskBuses.includes("ide")) {
    throw new Error("q35 has no IDE controller: move the IDE disks/CD-ROMs to SATA before switching to q35");
  }
  if (target === "pc" && /<loader[^>]*\bsecure=['"]yes['"]/i.test(xml)) {
    throw new Error("Secure Boot requires the q35 machine type: turn Secure Boot off before switching to i440FX");
  }

  let out = xml.replace(/(<type\b[^>]*\bmachine=['"])[^'"]+(['"])/i, `$1${target}$2`);
  out = out.replace(/[ \t]*<address\b[^>]*\btype=['"](?:pci|drive)['"][^>]*\/>\n?/gi, "");
  // PCI(e) controllers and the chipset-specific disk controllers.
  out = out.replace(/[ \t]*<controller\b[^>]*\btype=['"](?:pci|ide|sata|fdc)['"][^>]*\/>\n?/gi, "");
  out = out.replace(/[ \t]*<controller\b[^>]*\btype=['"](?:pci|ide|sata|fdc)['"][^>]*>[\s\S]*?<\/controller>\n?/gi, "");
  // SMM is a q35 requirement of Secure Boot only; harmless elsewhere, kept.
  return out;
}
