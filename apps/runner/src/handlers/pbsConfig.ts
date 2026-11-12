/**
 * Proxmox Backup Server (PBS) → Virtua translation layer.
 *
 * Pure functions only (no I/O) so the whole Proxmox config parsing and the
 * libvirt / LXC config generation are unit-testable without a PBS at hand.
 * The I/O side (proxmox-backup-client, qemu-img, virsh, lxc) lives in pbs.ts,
 * qemu.ts and lxc.ts.
 */

// ── Connection / snapshot references ─────────────────────────────────────────

export interface PbsConnection {
  server: string;
  port?: number;
  datastore: string;
  namespace?: string;
  /** user@realm or user@realm!tokenname */
  authId: string;
  /** password or API token secret */
  secret: string;
  /** sha256 certificate fingerprint (xx:xx:…) — required for self-signed PBS */
  fingerprint?: string;
}

export function validatePbsConnection(raw: unknown): PbsConnection {
  const c = (raw ?? {}) as Record<string, unknown>;
  const server = String(c.server ?? "").trim();
  const datastore = String(c.datastore ?? "").trim();
  const authId = String(c.authId ?? "").trim();
  const secret = String(c.secret ?? "");
  const namespace = String(c.namespace ?? "").trim() || undefined;
  const fingerprint = String(c.fingerprint ?? "").trim().toLowerCase() || undefined;
  const port = c.port === undefined || c.port === null || c.port === "" ? undefined : Number(c.port);

  if (!/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}|[0-9a-fA-F:]+)$/.test(server)) throw new Error("Invalid PBS server address");
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(datastore)) throw new Error("Invalid PBS datastore name");
  if (!/^[A-Za-z0-9._@-]{1,64}@[A-Za-z0-9._-]{1,32}(![A-Za-z0-9._-]{1,64})?$/.test(authId)) {
    throw new Error("Invalid PBS user / token id (expected user@realm or user@realm!token)");
  }
  if (!secret) throw new Error("PBS password / token secret is required");
  if (namespace && !/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$/.test(namespace)) {
    throw new Error("Invalid PBS namespace");
  }
  if (fingerprint && !/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(fingerprint)) {
    throw new Error("Invalid PBS fingerprint (expected 32 hex bytes separated by ':')");
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid PBS port");
  return { server, port, datastore, namespace, authId, secret, fingerprint };
}

/** PBS_REPOSITORY value: `[[auth-id@]server[:port]:]datastore`. */
export function buildPbsRepository(c: PbsConnection): string {
  // Bare IPv6 addresses must be bracketed, otherwise the ':' are ambiguous.
  const host = c.server.includes(":") && !c.server.startsWith("[") ? `[${c.server}]` : c.server;
  return `${c.authId}@${host}:${c.port ?? 8007}:${c.datastore}`;
}

const SNAPSHOT_RE = /^(vm|ct)\/([A-Za-z0-9_][A-Za-z0-9._-]{0,127})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

export function parseSnapshotRef(ref: string): { type: "vm" | "ct"; id: string; time: string } {
  const m = SNAPSHOT_RE.exec(ref);
  if (!m) throw new Error("Invalid PBS snapshot reference (expected vm|ct/<id>/<RFC3339 time>)");
  return { type: m[1] as "vm" | "ct", id: m[2], time: m[3] };
}

export function snapshotRef(type: string, id: string, epochSeconds: number): string {
  return `${type}/${id}/${new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export interface PbsSnapshotFile {
  filename: string;
  sizeBytes?: number;
  encrypted: boolean;
}

export interface PbsSnapshot {
  ref: string;
  type: "vm" | "ct";
  id: string;
  time: string;
  sizeBytes?: number;
  comment?: string;
  protected: boolean;
  encrypted: boolean;
  files: PbsSnapshotFile[];
}

/**
 * Parse `proxmox-backup-client snapshot list --output-format json`. Accepts both
 * the object form of `files` ({filename, size, crypt-mode}) and the plain string
 * form older clients print. Host backups are dropped — Virtua cannot restore them.
 */
export function parseSnapshotList(json: string): PbsSnapshot[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error("Unexpected PBS snapshot list output");
  const out: PbsSnapshot[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const type = entry["backup-type"];
    const id = entry["backup-id"];
    const time = Number(entry["backup-time"]);
    if ((type !== "vm" && type !== "ct") || typeof id !== "string" || !Number.isFinite(time)) continue;
    const files: PbsSnapshotFile[] = (Array.isArray(entry.files) ? entry.files : []).map((f: unknown) => {
      if (typeof f === "string") return { filename: f, encrypted: false };
      const o = f as Record<string, unknown>;
      return {
        filename: String(o.filename ?? ""),
        sizeBytes: typeof o.size === "number" ? o.size : undefined,
        encrypted: o["crypt-mode"] === "encrypt",
      };
    }).filter((f: PbsSnapshotFile) => f.filename);
    const ref = snapshotRef(type, id, time);
    out.push({
      ref,
      type,
      id,
      time: parseSnapshotRef(ref).time,
      sizeBytes: typeof entry.size === "number" ? entry.size : undefined,
      comment: typeof entry.comment === "string" && entry.comment ? entry.comment : undefined,
      protected: entry.protected === true,
      encrypted: files.some((f) => f.encrypted),
      files,
    });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Strip the server-side index suffix: `drive-scsi0.img.fidx` → `drive-scsi0.img`. */
export function archiveBaseName(filename: string): string {
  return filename.replace(/\.(fidx|didx|blob)$/, "");
}

// ── Proxmox config files ──────────────────────────────────────────────────────

export interface ProxmoxConfig {
  values: Record<string, string>;
  description?: string;
}

/**
 * Parse a qemu-server.conf / pct.conf. Only the main section is read: snapshot
 * sections (`[name]`) and the pending section describe other states.
 */
export function parseProxmoxConfig(text: string): ProxmoxConfig {
  const values: Record<string, string> = {};
  const description: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) break;
    if (!line) continue;
    if (line.startsWith("#")) {
      const body = line.slice(1);
      try { description.push(decodeURIComponent(body)); } catch { description.push(body); }
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim();
  }
  return { values, description: description.length ? description.join("\n") : undefined };
}

/**
 * Parse a Proxmox property string (`local-lvm:vm-100-disk-0,size=32G,ssd=1`).
 * A first element without `=` is returned as `positional`.
 */
export function parsePropertyString(value: string): { positional?: string; props: Record<string, string> } {
  const props: Record<string, string> = {};
  let positional: string | undefined;
  value.split(",").forEach((part, index) => {
    const p = part.trim();
    if (!p) return;
    const eq = p.indexOf("=");
    if (eq < 0) {
      if (index === 0) positional = p;
      else props[p] = "1";
      return;
    }
    props[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  return { positional, props };
}

function parseSizeBytes(value?: string): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(value.trim());
  if (!m) return undefined;
  const mult: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * mult[m[2].toUpperCase()]);
}

const truthy = (v?: string) => v === "1" || v === "on" || v === "yes" || v === "true";

/** Turn a Proxmox guest name into something valid as a Virtua VM/CT name. */
export function sanitizeGuestName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/-+$/, "").slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : fallback;
}

// ── QEMU / VM ─────────────────────────────────────────────────────────────────

export type PveDiskBus = "scsi" | "virtio" | "sata" | "ide";

export interface PveDisk {
  key: string;
  bus: PveDiskBus;
  index: number;
  /** archive name in the PBS snapshot, without index suffix */
  archive: string;
  sizeBytes?: number;
  ssd: boolean;
  /** backup=0 disks are not in the snapshot */
  inBackup: boolean;
}

export interface PveNic {
  key: string;
  index: number;
  model: string;
  mac?: string;
  bridge?: string;
  tag?: number;
  linkDown: boolean;
}

export interface PveVmSpec {
  name?: string;
  vcpus: number;
  memoryMb: number;
  uefi: boolean;
  machine: "q35" | "pc";
  secureBoot: boolean;
  efiType?: "2m" | "4m";
  /** efidisk content is in the snapshot (drive-efidisk0.img) */
  hasEfiDisk: boolean;
  tpm?: "1.2" | "2.0";
  ostype?: string;
  isWindows: boolean;
  agent: boolean;
  video: "vga" | "virtio" | "qxl";
  scsiModel: string;
  disks: PveDisk[];
  nics: PveNic[];
  /** device keys (scsi0, net0, …) in boot order */
  bootOrder: string[];
  onboot: boolean;
  smbiosUuid?: string;
  description?: string;
  warnings: string[];
}

const NIC_MODELS = ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "i82551", "i82557b", "i82559er", "ne2k_pci", "pcnet"];

function parseVmNic(key: string, value: string): PveNic {
  const { positional, props } = parsePropertyString(value);
  let model = props.model;
  let mac = props.macaddr;
  for (const m of NIC_MODELS) {
    if (props[m]) { model = m; mac = props[m]; break; }
  }
  if (!model && positional && NIC_MODELS.includes(positional)) model = positional;
  return {
    key,
    index: Number(key.slice(3)),
    model: model ?? "virtio",
    mac: mac && /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(mac) ? mac.toLowerCase() : undefined,
    bridge: props.bridge,
    tag: props.tag ? Number(props.tag) : undefined,
    linkDown: truthy(props.link_down),
  };
}

function parseBootOrder(values: Record<string, string>, deviceKeys: string[]): string[] {
  const boot = values.boot;
  if (boot) {
    const { props, positional } = parsePropertyString(boot);
    if (props.order) return props.order.split(";").map((k) => k.trim()).filter((k) => deviceKeys.includes(k));
    // Legacy `boot: cdn` + `bootdisk: scsi0`.
    const legacy = positional ?? props.legacy;
    if (legacy && /^[acdn]+$/.test(legacy)) {
      const order: string[] = [];
      for (const ch of legacy) {
        if (ch === "c" && values.bootdisk && deviceKeys.includes(values.bootdisk)) order.push(values.bootdisk);
        if (ch === "n") order.push(...deviceKeys.filter((k) => k.startsWith("net")));
      }
      return [...new Set(order)];
    }
  }
  if (values.bootdisk && deviceKeys.includes(values.bootdisk)) return [values.bootdisk];
  return [];
}

export function parsePveVmConfig(text: string): PveVmSpec {
  const { values, description } = parseProxmoxConfig(text);
  const warnings: string[] = [];

  const cores = Math.max(1, parseInt(values.cores ?? "1", 10) || 1);
  const sockets = Math.max(1, parseInt(values.sockets ?? "1", 10) || 1);
  const memRaw = values.memory ? parsePropertyString(values.memory) : undefined;
  const memoryMb = Math.max(64, parseInt(memRaw?.props.current ?? memRaw?.positional ?? "512", 10) || 512);

  const machineRaw = values.machine ? (parsePropertyString(values.machine).props.type ?? parsePropertyString(values.machine).positional ?? "") : "";
  const machine: "q35" | "pc" = /q35/.test(machineRaw) ? "q35" : "pc";
  const uefi = values.bios === "ovmf";

  let efiType: "2m" | "4m" | undefined;
  let secureBoot = false;
  let hasEfiDisk = false;
  if (values.efidisk0) {
    const { props } = parsePropertyString(values.efidisk0);
    efiType = props.efitype === "4m" ? "4m" : "2m";
    secureBoot = efiType === "4m" && truthy(props["pre-enrolled-keys"]);
    hasEfiDisk = true;
  }
  if (secureBoot && machine !== "q35") {
    secureBoot = false;
    warnings.push("Secure Boot needs the q35 machine type in Virtua — restored without Secure Boot.");
  }

  let tpm: "1.2" | "2.0" | undefined;
  if (values.tpmstate0) {
    tpm = parsePropertyString(values.tpmstate0).props.version === "v1.2" ? "1.2" : "2.0";
    warnings.push("A new empty TPM is attached: TPM contents (BitLocker / Windows Hello keys) are not carried over. Have the BitLocker recovery key at hand.");
  }

  const ostype = values.ostype;
  // Windows 11 needs a TPM; Virtua-made backups don't ship tpmstate0.
  if (!tpm && ostype === "win11") tpm = "2.0";
  const isWindows = !!ostype && /^(win|w2k|wxp|wvista)/.test(ostype);
  const agentRaw = values.agent ? parsePropertyString(values.agent) : undefined;
  const agent = !!agentRaw && truthy(agentRaw.props.enabled ?? agentRaw.positional);

  const vgaType = values.vga ? (parsePropertyString(values.vga).props.type ?? parsePropertyString(values.vga).positional ?? "std") : "std";
  const video: "vga" | "virtio" | "qxl" = /^qxl/.test(vgaType) ? "qxl" : /^virtio/.test(vgaType) ? "virtio" : "vga";

  const scsihw = values.scsihw ?? "lsi";
  const scsiModel = /^virtio-scsi/.test(scsihw) ? "virtio-scsi" : scsihw === "megasas" ? "megasas" : scsihw === "pvscsi" ? "vmpvscsi" : "lsilogic";

  const disks: PveDisk[] = [];
  const nics: PveNic[] = [];
  for (const [key, value] of Object.entries(values)) {
    const dm = /^(scsi|virtio|sata|ide)(\d+)$/.exec(key);
    if (dm) {
      const { positional, props } = parsePropertyString(value);
      if (props.media === "cdrom" || positional === "none" || positional?.startsWith("cdrom")) continue;
      const inBackup = props.backup === undefined || truthy(props.backup);
      if (!inBackup) warnings.push(`Disk ${key} is excluded from Proxmox backups (backup=0) — it is not restored.`);
      disks.push({
        key,
        bus: dm[1] as PveDiskBus,
        index: Number(dm[2]),
        archive: `drive-${key}.img`,
        sizeBytes: parseSizeBytes(props.size),
        ssd: truthy(props.ssd),
        inBackup,
      });
      continue;
    }
    if (/^net\d+$/.test(key)) {
      const nic = parseVmNic(key, value);
      if (nic.tag !== undefined) warnings.push(`${key}: VLAN tag ${nic.tag} is not applied — attach the VM to a bridge that already carries that VLAN.`);
      nics.push(nic);
      continue;
    }
    if (/^hostpci\d+$/.test(key)) warnings.push(`PCI passthrough ${key} (${value}) is not restored.`);
    else if (/^usb\d+$/.test(key)) warnings.push(`USB device ${key} (${value}) is not restored — re-attach it from Virtua.`);
    else if (key === "args") warnings.push("Custom QEMU arguments (args:) are not restored.");
    else if (/^virtiofs\d+$/.test(key)) warnings.push(`Shared folder ${key} is not restored.`);
  }
  const busRank: Record<PveDiskBus, number> = { virtio: 0, scsi: 1, sata: 2, ide: 3 };
  disks.sort((a, b) => busRank[a.bus] - busRank[b.bus] || a.index - b.index);
  nics.sort((a, b) => a.index - b.index);

  const smbios = values.smbios1 ? parsePropertyString(values.smbios1).props.uuid : undefined;

  return {
    name: values.name,
    vcpus: cores * sockets,
    memoryMb,
    uefi,
    machine,
    secureBoot,
    efiType,
    hasEfiDisk,
    tpm,
    ostype,
    isWindows,
    agent,
    video,
    scsiModel,
    disks,
    nics,
    bootOrder: parseBootOrder(values, [...disks.map((d) => d.key), ...nics.map((n) => n.key)]),
    onboot: truthy(values.onboot),
    smbiosUuid: smbios && /^[0-9a-fA-F-]{36}$/.test(smbios) ? smbios.toLowerCase() : undefined,
    description,
    warnings,
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function diskLetter(n: number): string {
  // 0 → a, 25 → z, 26 → aa (same scheme as the Linux sd/vd naming)
  let s = "";
  let i = n;
  do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}

export interface PveVmXmlOptions {
  name: string;
  arch: string;
  /** final qcow2 path per PVE disk key */
  diskPaths: Record<string, string>;
  /** PVE bridge name → host bridge; unknown bridges fall back to defaultBridge */
  bridgeMap?: Record<string, string>;
  defaultBridge: string;
  firmware?: { loader: string; nvramTemplate?: string; nvramPath?: string };
  uuid?: string;
  /** <cpu> element, built by the caller (shared with VM creation) */
  cpuXml: string;
  /** graphics / audio / video / input elements, built by the caller */
  displayXml: string;
}

export function buildPveVmXml(spec: PveVmSpec, opts: PveVmXmlOptions): string {
  const restoredDisks = spec.disks.filter((d) => opts.diskPaths[d.key]);
  const bootIndex = new Map<string, number>();
  const order = spec.bootOrder.filter((k) => opts.diskPaths[k] || spec.nics.some((n) => n.key === k));
  if (order.length === 0 && restoredDisks[0]) order.push(restoredDisks[0].key);
  order.forEach((k, i) => bootIndex.set(k, i + 1));

  let sdCount = 0;
  let vdCount = 0;
  let hdCount = 0;
  const diskXml = restoredDisks.map((d) => {
    // q35 has no IDE controller: Proxmox exposes "ide" disks through AHCI there.
    const bus = d.bus === "ide" && spec.machine === "q35" ? "sata" : d.bus;
    const dev = bus === "virtio" ? `vd${diskLetter(vdCount++)}` : bus === "ide" ? `hd${diskLetter(hdCount++)}` : `sd${diskLetter(sdCount++)}`;
    const boot = bootIndex.get(d.key);
    return [
      `    <disk type="file" device="disk">`,
      `      <driver name="qemu" type="qcow2" cache="none" io="native" discard="unmap"/>`,
      `      <source file="${xmlEscape(opts.diskPaths[d.key])}"/>`,
      `      <target dev="${dev}" bus="${bus}"${d.ssd && bus !== "virtio" ? ` rotation_rate="1"` : ""}/>`,
      boot ? `      <boot order="${boot}"/>` : "",
      `    </disk>`,
    ].filter(Boolean).join("\n");
  });

  const nicXml = spec.nics.map((n) => {
    const bridge = (n.bridge && opts.bridgeMap?.[n.bridge]) || opts.defaultBridge;
    const boot = bootIndex.get(n.key);
    return [
      `    <interface type="bridge">`,
      n.mac ? `      <mac address="${n.mac}"/>` : "",
      `      <source bridge="${xmlEscape(bridge)}"/>`,
      `      <model type="${xmlEscape(n.model)}"/>`,
      n.linkDown ? `      <link state="down"/>` : "",
      boot ? `      <boot order="${boot}"/>` : "",
      `    </interface>`,
    ].filter(Boolean).join("\n");
  });

  const fw = spec.uefi ? opts.firmware : undefined;
  const loaderXml = fw ? [
    `    <loader readonly="yes"${spec.secureBoot ? ` secure="yes"` : ""} type="pflash">${xmlEscape(fw.loader)}</loader>`,
    fw.nvramPath
      ? `    <nvram${fw.nvramTemplate ? ` template="${xmlEscape(fw.nvramTemplate)}"` : ""}>${xmlEscape(fw.nvramPath)}</nvram>`
      : fw.nvramTemplate ? `    <nvram template="${xmlEscape(fw.nvramTemplate)}"/>` : "",
  ].filter(Boolean).join("\n") : "";

  const features = [
    "<acpi/>",
    "<apic/>",
    spec.isWindows ? `<hyperv mode="custom"><relaxed state="on"/><vapic state="on"/><spinlocks state="on" retries="8191"/></hyperv>` : "",
    spec.secureBoot && fw ? `<smm state="on"/>` : "",
  ].join("");

  const needsScsiController = restoredDisks.some((d) => d.bus === "scsi");

  return [
    `<domain type="kvm">`,
    `  <name>${xmlEscape(opts.name)}</name>`,
    opts.uuid ? `  <uuid>${opts.uuid}</uuid>` : "",
    spec.description ? `  <description>${xmlEscape(spec.description)}</description>` : "",
    `  <memory unit="MiB">${spec.memoryMb}</memory>`,
    `  <currentMemory unit="MiB">${spec.memoryMb}</currentMemory>`,
    `  <vcpu>${spec.vcpus}</vcpu>`,
    `  <os>`,
    `    <type arch="${xmlEscape(opts.arch)}" machine="${spec.machine}">hvm</type>`,
    loaderXml,
    `  </os>`,
    `  <features>${features}</features>`,
    `  ${opts.cpuXml}`,
    spec.isWindows
      ? `  <clock offset="localtime"><timer name="rtc" tickpolicy="catchup"/><timer name="pit" tickpolicy="delay"/><timer name="hpet" present="no"/><timer name="hypervclock" present="yes"/></clock>`
      : `  <clock offset="utc"/>`,
    `  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>`,
    `  <devices>`,
    `    <emulator>/usr/bin/qemu-system-${xmlEscape(opts.arch)}</emulator>`,
    needsScsiController ? `    <controller type="scsi" index="0" model="${spec.scsiModel}"/>` : "",
    ...diskXml,
    ...nicXml,
    opts.displayXml,
    spec.tpm ? `    <tpm model="${spec.tpm === "1.2" ? "tpm-tis" : "tpm-crb"}"><backend type="emulator" version="${spec.tpm}"/></tpm>` : "",
    `    <input type="tablet" bus="usb"/>`,
    `    <channel type="spicevmc"><target type="virtio" name="com.redhat.spice.0"/></channel>`,
    spec.agent ? `    <channel type="unix"><source mode="bind"/><target type="virtio" name="org.qemu.guest_agent.0"/></channel>` : "",
    `    <memballoon model="virtio"/>`,
    `    <rng model="virtio"><backend model="random">/dev/urandom</backend></rng>`,
    `  </devices>`,
    `</domain>`,
  ].filter(Boolean).join("\n");
}

// ── LXC / CT ──────────────────────────────────────────────────────────────────

export interface PveCtNic {
  key: string;
  index: number;
  name: string;
  bridge?: string;
  hwaddr?: string;
  /** "dhcp", "manual" or an IPv4 CIDR */
  ip?: string;
  gw?: string;
  tag?: number;
  mtu?: number;
}

export interface PveCtSpec {
  hostname?: string;
  arch: string;
  ostype?: string;
  cores?: number;
  cpuLimit?: number;
  memoryMb: number;
  swapMb: number;
  unprivileged: boolean;
  nesting: boolean;
  nics: PveCtNic[];
  nameservers: string[];
  searchdomain?: string;
  onboot: boolean;
  rootfsSizeGb?: number;
  description?: string;
  warnings: string[];
}

export function parsePveCtConfig(text: string): PveCtSpec {
  const { values, description } = parseProxmoxConfig(text);
  const warnings: string[] = [];
  const nics: PveCtNic[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (/^net\d+$/.test(key)) {
      const { props } = parsePropertyString(value);
      const nic: PveCtNic = {
        key,
        index: Number(key.slice(3)),
        name: props.name && /^[A-Za-z0-9_.-]{1,15}$/.test(props.name) ? props.name : `eth${key.slice(3)}`,
        bridge: props.bridge,
        hwaddr: props.hwaddr && /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(props.hwaddr) ? props.hwaddr.toLowerCase() : undefined,
        ip: props.ip,
        gw: props.gw,
        tag: props.tag ? Number(props.tag) : undefined,
        mtu: props.mtu ? Number(props.mtu) : undefined,
      };
      if (nic.tag !== undefined) warnings.push(`${key}: VLAN tag ${nic.tag} is not applied — attach the container to a bridge that already carries that VLAN.`);
      if (props.ip6 && props.ip6 !== "manual") warnings.push(`${key}: IPv6 setting (${props.ip6}) is not applied by Virtua — check the container's network config.`);
      nics.push(nic);
    } else if (/^mp\d+$/.test(key)) {
      const { props, positional } = parsePropertyString(value);
      const target = props.mp ?? "?";
      if (props.backup !== undefined && truthy(props.backup)) {
        warnings.push(`Mount point ${key} (${target}) is restored inside the container's root filesystem.`);
      } else {
        warnings.push(`Mount point ${key} (${target}${positional ? `, ${positional}` : ""}) is not in Proxmox backups — its data is not restored.`);
      }
    } else if (/^dev\d+$/.test(key) || /^lxc\./.test(key)) {
      warnings.push(`Raw / device setting "${key}: ${value}" is not restored.`);
    }
  }
  nics.sort((a, b) => a.index - b.index);

  const features = values.features ? parsePropertyString(values.features).props : {};
  const unprivileged = truthy(values.unprivileged);
  const rootfs = values.rootfs ? parsePropertyString(values.rootfs).props : {};
  const rootfsBytes = parseSizeBytes(rootfs.size);

  return {
    hostname: values.hostname,
    arch: values.arch ?? "amd64",
    ostype: values.ostype,
    cores: values.cores ? Math.max(1, parseInt(values.cores, 10) || 1) : undefined,
    cpuLimit: values.cpulimit && parseFloat(values.cpulimit) > 0 ? parseFloat(values.cpulimit) : undefined,
    memoryMb: Math.max(16, parseInt(values.memory ?? "512", 10) || 512),
    swapMb: Math.max(0, parseInt(values.swap ?? "512", 10) || 0),
    unprivileged,
    nesting: truthy(features.nesting),
    nics,
    nameservers: (values.nameserver ?? "").split(/[\s,]+/).filter((s) => /^[0-9a-fA-F.:]+$/.test(s)),
    searchdomain: values.searchdomain,
    onboot: truthy(values.onboot),
    rootfsSizeGb: rootfsBytes ? Math.ceil(rootfsBytes / 1024 ** 3) : undefined,
    description,
    warnings,
  };
}

/** Static IPv4 of a CT NIC, or undefined for dhcp / manual / IPv6-only. */
export function ctNicIpv4(nic: PveCtNic): string | undefined {
  return nic.ip && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(nic.ip) ? nic.ip : undefined;
}

export interface PveLxcConfigOptions {
  name: string;
  rootfsPath: string;
  /** lxc.include line target, e.g. /usr/share/lxc/config/debian.common.conf */
  include: string;
  bridgeMap?: Record<string, string>;
  defaultBridge: string;
  autostart: boolean;
  /** MACs to use for NICs that had none in the Proxmox config */
  generateMac: () => string;
}

export function buildPveLxcConfig(spec: PveCtSpec, opts: PveLxcConfigOptions): string {
  const lines = [
    `# Restored from Proxmox Backup Server by Virtua`,
    `lxc.include = ${opts.include}`,
    `lxc.arch = ${spec.arch}`,
    `lxc.uts.name = ${opts.name}`,
    `lxc.rootfs.path = dir:${opts.rootfsPath}`,
  ];
  spec.nics.forEach((nic, i) => {
    lines.push(
      `lxc.net.${i}.type = veth`,
      `lxc.net.${i}.link = ${(nic.bridge && opts.bridgeMap?.[nic.bridge]) || opts.defaultBridge}`,
      `lxc.net.${i}.flags = up`,
      `lxc.net.${i}.name = ${nic.name}`,
      `lxc.net.${i}.hwaddr = ${nic.hwaddr ?? opts.generateMac()}`,
    );
    if (nic.mtu) lines.push(`lxc.net.${i}.mtu = ${nic.mtu}`);
    const ipv4 = ctNicIpv4(nic);
    if (ipv4) {
      lines.push(`lxc.net.${i}.ipv4.address = ${ipv4}`);
      // Same rule as renderLxcNic(): only the primary NIC carries a gateway.
      if (i === 0) lines.push(`lxc.net.${i}.ipv4.gateway = ${nic.gw || "auto"}`);
    }
  });
  const cpus = spec.cpuLimit ?? spec.cores;
  if (cpus) lines.push(`lxc.cgroup2.cpu.max = ${Math.round(cpus * 100000)} 100000`);
  lines.push(`lxc.cgroup2.memory.max = ${spec.memoryMb}M`);
  lines.push(`lxc.cgroup2.memory.swap.max = ${spec.swapMb}M`);
  if (opts.autostart) lines.push(`lxc.start.auto = 1`);
  if (spec.nesting) lines.push(`lxc.apparmor.allow_nesting = 1`);
  return `${lines.join("\n")}\n`;
}

/** LXC distro config to include for a Proxmox ostype (falls back to common.conf). */
export function lxcIncludeCandidates(ostype?: string): string[] {
  const map: Record<string, string> = { devuan: "debian", nixos: "common", unmanaged: "common" };
  const distro = ostype ? (map[ostype] ?? ostype) : "common";
  return [
    ...(distro !== "common" && /^[a-z0-9]+$/.test(distro) ? [`/usr/share/lxc/config/${distro}.common.conf`] : []),
    "/usr/share/lxc/config/common.conf",
  ];
}

// ── Virtua → Proxmox (backup to PBS) ─────────────────────────────────────────
// Backups are written in Proxmox VE's own layout (vm/<id>, ct/<id>,
// qemu-server.conf / pct.conf, drive-*.img, root.pxar) so that both Virtua and
// a real Proxmox VE can restore them.

export interface VirtuaVmDisk {
  /** libvirt target bus */
  bus: string;
  /** libvirt source file */
  source: string;
  sizeBytes?: number;
}

export interface VirtuaVmInfo {
  name: string;
  vcpus: number;
  memoryMb: number;
  uefi: boolean;
  secureBoot: boolean;
  machine: "q35" | "pc";
  isWindows: boolean;
  agent: boolean;
  video: "vga" | "virtio" | "qxl";
  tpm: boolean;
  uuid?: string;
  nvramPath?: string;
  disks: VirtuaVmDisk[];
  nics: Array<{ model: string; mac?: string; bridge?: string }>;
  description?: string;
}

const attr = (block: string, re: RegExp) => re.exec(block)?.[1];

/** Read what Proxmox needs from a libvirt domain XML (`virsh dumpxml`). */
export function parseLibvirtForPve(xml: string): VirtuaVmInfo {
  const memMatch = /<memory\b[^>]*?(?:unit=['"](\w+)['"])?[^>]*>(\d+)<\/memory>/i.exec(xml);
  const unit = (memMatch?.[1] ?? "KiB").toLowerCase();
  const memRaw = Number(memMatch?.[2] ?? 524288);
  const memoryMb = Math.round(unit === "mib" ? memRaw : unit === "gib" ? memRaw * 1024 : unit === "b" || unit === "bytes" ? memRaw / 1024 / 1024 : memRaw / 1024);
  const os = /<os\b[\s\S]*?<\/os>/i.exec(xml)?.[0] ?? "";
  const loader = /<loader\b[^>]*>/i.exec(os)?.[0] ?? "";
  const devices = /<devices>[\s\S]*<\/devices>/i.exec(xml)?.[0] ?? "";
  const video = /<video>[\s\S]*?<\/video>/i.exec(devices)?.[0] ?? "";
  const videoModel = attr(video, /<model[^>]*type=['"]([^'"]+)['"]/i);

  const disks: VirtuaVmDisk[] = [...devices.matchAll(/<disk\b[\s\S]*?<\/disk>/gi)]
    .map((m) => m[0])
    .filter((b) => /device=['"]disk['"]/i.test(b) && !/<readonly\s*\/?>/i.test(b))
    .map((b) => ({ bus: attr(b, /<target[^>]*bus=['"]([^'"]+)['"]/i) ?? "virtio", source: attr(b, /<source[^>]*file=['"]([^'"]+)['"]/i) ?? "" }))
    .filter((d) => d.source);

  const nics = [...devices.matchAll(/<interface\b[\s\S]*?<\/interface>/gi)].map((m) => ({
    model: attr(m[0], /<model[^>]*type=['"]([^'"]+)['"]/i) ?? "virtio",
    mac: attr(m[0], /<mac[^>]*address=['"]([^'"]+)['"]/i)?.toLowerCase(),
    bridge: attr(m[0], /<source[^>]*bridge=['"]([^'"]+)['"]/i),
  }));

  const nvram = /<nvram\b[^>]*>([^<]+)<\/nvram>/i.exec(os)?.[1]?.trim();
  return {
    name: /<name>([^<]+)<\/name>/i.exec(xml)?.[1] ?? "vm",
    vcpus: Number(/<vcpu\b[^>]*>(\d+)<\/vcpu>/i.exec(xml)?.[1] ?? 1),
    memoryMb,
    uefi: !!loader || /firmware=['"]efi['"]/i.test(os),
    secureBoot: /secure=['"]yes['"]/i.test(loader),
    machine: /machine=['"][^'"]*q35/i.test(os) ? "q35" : "pc",
    isWindows: /<hyperv\b/i.test(xml),
    agent: /org\.qemu\.guest_agent\.0/.test(devices),
    video: videoModel === "qxl" ? "qxl" : videoModel === "virtio" ? "virtio" : "vga",
    tpm: /<tpm\b/i.test(devices),
    uuid: /<uuid>([0-9a-fA-F-]{36})<\/uuid>/.exec(xml)?.[1]?.toLowerCase(),
    nvramPath: nvram,
    disks,
    nics,
    description: /<description>([\s\S]*?)<\/description>/i.exec(xml)?.[1],
  };
}

function pveDescription(text?: string): string[] {
  if (!text) return [];
  const decoded = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return decoded.split(/\r?\n/).map((l) => `#${encodeURIComponent(l).replace(/%20/g, " ")}`);
}

/** OVMF 4M variable store size — only that size can be handed to Proxmox as efidisk. */
export const OVMF_VARS_4M_SIZE = 540672;

export interface PveVmBackupPlan {
  conf: string;
  /** archive name → libvirt disk index (order of info.disks) */
  disks: Array<{ key: string; archive: string; index: number }>;
  /** include drive-efidisk0.img from info.nvramPath */
  efidisk: boolean;
}

export function buildPveQemuConf(info: VirtuaVmInfo, opts: { autostart: boolean; nvramSize?: number }): PveVmBackupPlan {
  const counters: Record<string, number> = {};
  const disks = info.disks.map((d, index) => {
    // Proxmox q35 has no real IDE either; keep the bus otherwise.
    const pveBus = d.bus === "virtio" || d.bus === "scsi" || d.bus === "sata" || d.bus === "ide" ? d.bus : "virtio";
    const n = counters[pveBus] ?? 0;
    counters[pveBus] = n + 1;
    return { key: `${pveBus}${n}`, archive: `drive-${pveBus}${n}.img`, index };
  });
  const efidisk = info.uefi && !!info.nvramPath && opts.nvramSize === OVMF_VARS_4M_SIZE;
  const lines = [
    ...pveDescription(info.description),
    `name: ${info.name}`,
    // Virtua-created Windows VMs carry no OS marker in libvirt; a TPM almost
    // always means Windows 11, and win11 is what makes a restore re-add one.
    `ostype: ${info.tpm ? "win11" : info.isWindows ? "win10" : "l26"}`,
    `cores: ${info.vcpus}`,
    `sockets: 1`,
    `cpu: host`,
    `memory: ${info.memoryMb}`,
    `bios: ${info.uefi ? "ovmf" : "seabios"}`,
    `machine: ${info.machine}`,
    `vga: ${info.video === "vga" ? "std" : info.video}`,
    `agent: ${info.agent ? 1 : 0}`,
    `onboot: ${opts.autostart ? 1 : 0}`,
  ];
  if (disks.some((d) => d.key.startsWith("scsi"))) lines.push("scsihw: virtio-scsi-single");
  disks.forEach((d) => {
    const size = info.disks[d.index].sizeBytes;
    lines.push(`${d.key}: virtua:${d.key},discard=on${size ? `,size=${Math.max(1, Math.ceil(size / 1024 ** 3))}G` : ""}`);
  });
  if (efidisk) lines.push(`efidisk0: virtua:efidisk0,efitype=4m,pre-enrolled-keys=${info.secureBoot ? 1 : 0},size=528K`);
  // No tpmstate0 line: it would point Proxmox at a volume that is not in the
  // backup. "ostype: win11" carries the TPM need instead (see parsePveVmConfig).
  info.nics.forEach((nic, i) => {
    const model = NIC_MODELS.includes(nic.model) ? nic.model : "virtio";
    lines.push(`net${i}: ${model}${nic.mac ? `=${nic.mac.toUpperCase()}` : ""},bridge=${nic.bridge ?? "vmbr0"}`);
  });
  const bootKeys = [...(disks[0] ? [disks[0].key] : []), ...info.nics.map((_, i) => `net${i}`)];
  if (bootKeys.length) lines.push(`boot: order=${bootKeys.join(";")}`);
  if (info.uuid) lines.push(`smbios1: uuid=${info.uuid}`);
  return { conf: `${lines.join("\n")}\n`, disks, efidisk };
}

export interface VirtuaCtInfo {
  hostname: string;
  arch: string;
  ostype?: string;
  cpuCores?: number;
  memoryMb: number;
  swapMb: number;
  nesting: boolean;
  /** pxar holds in-container ids (archived from inside the user namespace) */
  unprivileged?: boolean;
  autostart: boolean;
  rootfsSizeGb: number;
  nics: Array<{ name?: string; link?: string; hwaddr?: string; ipv4?: string; ipv4Gateway?: string }>;
  nameservers: string[];
}

const PVE_CT_OSTYPES = ["debian", "devuan", "ubuntu", "centos", "fedora", "opensuse", "archlinux", "alpine", "gentoo", "nixos"];

/** Map /etc/os-release ID (+ ID_LIKE) to a Proxmox CT ostype. */
export function pveOstypeFromOsRelease(osRelease: string): string {
  const get = (k: string) => new RegExp(`^${k}=["']?([^"'\\n]*)`, "m").exec(osRelease)?.[1]?.toLowerCase() ?? "";
  const aliases: Record<string, string> = { rocky: "centos", almalinux: "centos", rhel: "centos", ol: "centos", arch: "archlinux", "opensuse-leap": "opensuse", "opensuse-tumbleweed": "opensuse", sles: "opensuse" };
  for (const id of [get("ID"), ...get("ID_LIKE").split(/\s+/)]) {
    const mapped = aliases[id] ?? id;
    if (PVE_CT_OSTYPES.includes(mapped)) return mapped;
  }
  return "unmanaged";
}

export function buildPveCtConf(info: VirtuaCtInfo): string {
  const lines = [
    `arch: ${info.arch === "x86_64" || info.arch === "linux64" ? "amd64" : info.arch}`,
    `hostname: ${info.hostname}`,
    `ostype: ${info.ostype ?? "unmanaged"}`,
    ...(info.cpuCores ? [`cores: ${info.cpuCores}`] : []),
    `memory: ${info.memoryMb}`,
    `swap: ${info.swapMb}`,
    `rootfs: virtua:subvol-rootfs,size=${info.rootfsSizeGb}G`,
    `onboot: ${info.autostart ? 1 : 0}`,
  ];
  if (info.unprivileged) lines.push("unprivileged: 1");
  if (info.nesting) lines.push("features: nesting=1");
  info.nics.forEach((nic, i) => {
    const ip = nic.ipv4 ? `ip=${nic.ipv4}${i === 0 && nic.ipv4Gateway ? `,gw=${nic.ipv4Gateway}` : ""}` : "ip=dhcp";
    lines.push(`net${i}: name=${nic.name ?? `eth${i}`},bridge=${nic.link ?? "vmbr0"}${nic.hwaddr ? `,hwaddr=${nic.hwaddr.toUpperCase()}` : ""},${ip},type=veth`);
  });
  if (info.nameservers.length) lines.push(`nameserver: ${info.nameservers.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/** `Starting backup: [ns/x/]vm/web/2026-10-30T02:00:00Z` → snapshot ref */
export function parseBackupStartLine(output: string): string | undefined {
  return /Starting backup:\s*(?:\S*\/)?((?:vm|ct)\/[^/\s]+\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(output)?.[1];
}

export interface PruneKeep {
  keepLast?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
}

export function pruneArgs(keep: PruneKeep): string[] {
  const args: string[] = [];
  const add = (flag: string, v?: number) => {
    if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 1000) args.push(flag, String(v));
  };
  add("--keep-last", keep.keepLast);
  add("--keep-daily", keep.keepDaily);
  add("--keep-weekly", keep.keepWeekly);
  add("--keep-monthly", keep.keepMonthly);
  return args;
}
