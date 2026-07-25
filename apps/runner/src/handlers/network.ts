import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";

const execFileAsync = promisify(execFile);
const INTERFACES_DIR = "/etc/network/interfaces.d";
const BRIDGE_CONFIG_PREFIX = "auxinuxvirtual-bridge-";

function validateIfName(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}: must be a string`);
  const trimmed = value.trim();
  // Linux interface names: 1-15 chars, alphanumeric + _ -, must not start with dot/number
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: must be 1-15 alphanumeric/underscore/hyphen chars starting with a letter`);
  }
  return trimmed;
}

function validateOptionalIfName(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateIfName(value, field);
}

function validateMtu(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 68 || num > 65535) {
    throw new Error("Invalid MTU: must be an integer between 68 and 65535");
  }
  return num;
}

function validateIpv4Cidr(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (!/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\/(?:[0-9]|[12]\d|3[0-2]))?$/.test(value)) {
    throw new Error(`Invalid ${field}: must be a valid IPv4 address (optionally with /CIDR)`);
  }
  return value;
}

function validateIpv4(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (!/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/.test(value)) {
    throw new Error(`Invalid ${field}: must be a valid IPv4 address`);
  }
  return value;
}

export async function handleNetwork(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case "network_bridges_list": return listBridges();
    case "network_bridge_create": return createBridge(p);
    case "network_bridge_delete": return deleteBridge(p.name as string);
    case "network_nat_list": return listVirtualNetworks();
    case "network_nat_create": return createVirtualNetwork(p);
    case "network_nat_delete": return deleteVirtualNetwork(p.name as string);
    case "network_interfaces_list": return listInterfaces();
    case "network_firewall_status": return getFirewallStatus();
    case "network_firewall_apply": return applyFirewall(p);
    default: throw new Error(`Unknown network action: ${action}`);
  }
}

type FirewallRuleType = "allow" | "forward";
type FirewallProtocol = "tcp" | "udp";

interface FirewallRuleParams {
  enabled: boolean;
  type: FirewallRuleType;
  protocol: FirewallProtocol;
  hostPort: number;
  targetIp?: string;
  targetPort?: number;
  sourceCidr?: string;
}

const FIREWALL_INPUT_CHAIN = "AUXINUX_INPUT";
const FIREWALL_FORWARD_CHAIN = "AUXINUX_FORWARD";
const FIREWALL_NAT_CHAIN = "AUXINUX_PREROUTING";
const FIREWALL_NAT_OUTPUT_CHAIN = "AUXINUX_OUTPUT";

async function iptables(table: "filter" | "nat", ...args: string[]) {
  const base = table === "nat" ? ["-t", "nat"] : [];
  await execFileAsync("iptables", [...base, ...args]);
}

async function iptablesTry(table: "filter" | "nat", ...args: string[]) {
  try {
    await iptables(table, ...args);
    return true;
  } catch {
    return false;
  }
}

async function ensureChain(table: "filter" | "nat", chain: string) {
  const exists = await iptablesTry(table, "-S", chain);
  if (!exists) {
    await iptables(table, "-N", chain);
  }
}

async function ensureJump(table: "filter" | "nat", parent: string, chain: string) {
  const exists = await iptablesTry(table, "-C", parent, "-j", chain);
  if (!exists) {
    await iptables(table, "-I", parent, "1", "-j", chain);
  }
}

async function removeJump(table: "filter" | "nat", parent: string, chain: string) {
  while (await iptablesTry(table, "-C", parent, "-j", chain)) {
    await iptables(table, "-D", parent, "-j", chain);
  }
}

async function flushAndDeleteChain(table: "filter" | "nat", chain: string) {
  const exists = await iptablesTry(table, "-S", chain);
  if (!exists) return;
  await iptables(table, "-F", chain).catch(() => {});
  await iptables(table, "-X", chain).catch(() => {});
}

async function readSshPort() {
  const sshdConfig = await fs.readFile("/etc/ssh/sshd_config", "utf8").catch(() => "");
  const match = sshdConfig.match(/^\s*Port\s+(\d+)\s*$/m);
  return match ? parseInt(match[1], 10) : 22;
}

async function getFirewallStatus() {
  const sshPort = await readSshPort();
  const inputExists = await iptablesTry("filter", "-S", FIREWALL_INPUT_CHAIN);
  const { stdout } = await execFileAsync("iptables", ["-S", FIREWALL_INPUT_CHAIN]).catch(() => ({ stdout: "" }));
  const enabled = inputExists && stdout.includes("-j DROP");
  const protectSsh = stdout.includes(`--dport ${sshPort} -j ACCEPT`);
  return {
    backend: "iptables",
    enabled,
    sshPort,
    protectSsh,
    protectedPorts: [8441, sshPort],
  };
}

function buildSourceArgs(rule: FirewallRuleParams) {
  return rule.sourceCidr ? ["-s", rule.sourceCidr] : [];
}

async function applyFirewall(params: Record<string, unknown>) {
  const enabled = Boolean(params.enabled);
  const apiPort = Math.max(1, Math.min(65535, Number(params.apiPort ?? 8441)));
  const sshPort = Math.max(1, Math.min(65535, Number(params.sshPort ?? 22)));
  const protectSsh = params.protectSsh !== false;
  const rawRules = (params.rules as FirewallRuleParams[] | undefined) ?? [];
  const rules = rawRules.filter((rule) => rule.enabled);

  await ensureChain("filter", FIREWALL_INPUT_CHAIN);
  await ensureChain("filter", FIREWALL_FORWARD_CHAIN);
  await ensureChain("nat", FIREWALL_NAT_CHAIN);
  await ensureChain("nat", FIREWALL_NAT_OUTPUT_CHAIN);

  if (!enabled) {
    await removeJump("filter", "INPUT", FIREWALL_INPUT_CHAIN);
    await removeJump("filter", "FORWARD", FIREWALL_FORWARD_CHAIN);
    await removeJump("nat", "PREROUTING", FIREWALL_NAT_CHAIN);
    await removeJump("nat", "OUTPUT", FIREWALL_NAT_OUTPUT_CHAIN);
    await flushAndDeleteChain("filter", FIREWALL_INPUT_CHAIN);
    await flushAndDeleteChain("filter", FIREWALL_FORWARD_CHAIN);
    await flushAndDeleteChain("nat", FIREWALL_NAT_CHAIN);
    await flushAndDeleteChain("nat", FIREWALL_NAT_OUTPUT_CHAIN);
    return { ok: true, enabled: false, appliedRules: 0 };
  }

  await ensureJump("filter", "INPUT", FIREWALL_INPUT_CHAIN);
  await ensureJump("filter", "FORWARD", FIREWALL_FORWARD_CHAIN);
  await ensureJump("nat", "PREROUTING", FIREWALL_NAT_CHAIN);
  await ensureJump("nat", "OUTPUT", FIREWALL_NAT_OUTPUT_CHAIN);

  await iptables("filter", "-F", FIREWALL_INPUT_CHAIN);
  await iptables("filter", "-F", FIREWALL_FORWARD_CHAIN);
  await iptables("nat", "-F", FIREWALL_NAT_CHAIN);
  await iptables("nat", "-F", FIREWALL_NAT_OUTPUT_CHAIN);

  await execFileAsync("sysctl", ["-w", "net.ipv4.ip_forward=1"]).catch(() => {});

  await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT");
  await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-i", "lo", "-j", "ACCEPT");
  await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-p", "icmp", "-j", "ACCEPT");
  for (const bridgePattern of ["lxcbr+", "virbr+"]) {
    await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-i", bridgePattern, "-p", "udp", "--dport", "67", "-j", "ACCEPT");
    await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-i", bridgePattern, "-p", "udp", "--dport", "53", "-j", "ACCEPT");
    await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-i", bridgePattern, "-p", "tcp", "--dport", "53", "-j", "ACCEPT");
  }
  if (protectSsh) {
    await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-p", "tcp", "--dport", String(sshPort), "-j", "ACCEPT");
  }
  await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-p", "tcp", "--dport", String(apiPort), "-j", "ACCEPT");

  await iptables("filter", "-A", FIREWALL_FORWARD_CHAIN, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT");

  for (const rule of rules) {
    if (rule.type === "allow") {
      await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, ...buildSourceArgs(rule), "-p", rule.protocol, "--dport", String(rule.hostPort), "-j", "ACCEPT");
      continue;
    }
    if (!rule.targetIp || !rule.targetPort) continue;
    await iptables("nat", "-A", FIREWALL_NAT_CHAIN, ...buildSourceArgs(rule), "-p", rule.protocol, "--dport", String(rule.hostPort), "-j", "DNAT", "--to-destination", `${rule.targetIp}:${rule.targetPort}`);
    await iptables("nat", "-A", FIREWALL_NAT_OUTPUT_CHAIN, "-m", "addrtype", "--dst-type", "LOCAL", ...buildSourceArgs(rule), "-p", rule.protocol, "--dport", String(rule.hostPort), "-j", "DNAT", "--to-destination", `${rule.targetIp}:${rule.targetPort}`);
    await iptables("filter", "-A", FIREWALL_FORWARD_CHAIN, ...buildSourceArgs(rule), "-p", rule.protocol, "-d", rule.targetIp, "--dport", String(rule.targetPort), "-j", "ACCEPT");
  }

  await iptables("filter", "-A", FIREWALL_INPUT_CHAIN, "-j", "DROP");
  return { ok: true, enabled: true, appliedRules: rules.length };
}

async function listBridges() {
  try {
    const { stdout } = await execFileAsync("ip", ["-j", "link", "show", "type", "bridge"]);
    const bridges = JSON.parse(stdout) as Array<{ ifname: string; flags: string[]; address: string; mtu?: number }>;
    const { stdout: bridgeLinks } = await execFileAsync("bridge", ["link", "show"]).catch(() => ({ stdout: "" }));

    return Promise.all(bridges.map(async (bridge) => {
      const { stdout: addrOut } = await execFileAsync("ip", ["-j", "addr", "show", bridge.ifname]);
      const addrData = JSON.parse(addrOut) as Array<{ addr_info?: Array<{ family: string; local: string; prefixlen: number }> }>;
      const firstIpv4 = (addrData[0]?.addr_info ?? []).find((entry) => entry.family === "inet");
      const members = bridgeLinks.split("\n").filter((line) => line.includes(`master ${bridge.ifname}`)).map((line) => {
        const m = line.match(/^\d+:\s+(\S+):/);
        return m ? m[1].replace(/@.+$/, "") : null;
      }).filter(Boolean) as string[];
      const stpEnabled = await fs.readFile(`/sys/class/net/${bridge.ifname}/bridge/stp_state`, "utf8")
        .then((value) => value.trim() === "1")
        .catch(() => false);
      const routeOut = await execFileAsync("ip", ["route", "show", "default", "dev", bridge.ifname]).catch(() => ({ stdout: "" }));
      const gateway = routeOut.stdout.match(/default via (\S+)/)?.[1];
      const persisted = await readBridgeConfig(bridge.ifname);
      const uplinkInterface = persisted?.uplinkInterface ?? members.find((member) => !member.startsWith("vnet") && !member.startsWith("tap") && !member.startsWith("veth"));

      return {
        name: bridge.ifname,
        state: bridge.flags.includes("UP") ? "up" : "down",
        ipAddress: firstIpv4 ? `${firstIpv4.local}/${firstIpv4.prefixlen}` : undefined,
        gateway,
        macAddress: bridge.address,
        interfaces: members,
        uplinkInterface,
        hostIpMode: persisted?.hostIpMode ?? inferHostIpMode(Boolean(firstIpv4), uplinkInterface),
        stpEnabled,
        mtu: bridge.mtu,
        persistent: Boolean(persisted),
      };
    }));
  } catch {
    return [];
  }
}

type HostIpMode = "none" | "dhcp" | "static" | "copy";

function bridgeConfigPath(name: string) {
  return path.join(INTERFACES_DIR, `${BRIDGE_CONFIG_PREFIX}${name}.cfg`);
}

function inferHostIpMode(hasIp: boolean, uplinkInterface?: string) {
  if (!uplinkInterface) return hasIp ? "static" : "none";
  return hasIp ? "unknown" : "none";
}

async function readBridgeConfig(name: string) {
  const file = bridgeConfigPath(name);
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return null;
  return {
    uplinkInterface: raw.match(/^\s*bridge_ports\s+(.+)$/m)?.[1]?.trim()?.split(/\s+/)?.[0] ?? undefined,
    hostIpMode: (raw.match(/^\s*#\s*AUXINUX_HOST_IP_MODE=(.+)$/m)?.[1]?.trim() as HostIpMode | undefined) ?? undefined,
  };
}

async function getInterfaceIPv4(name: string) {
  const { stdout } = await execFileAsync("ip", ["-j", "addr", "show", "dev", name]);
  const data = JSON.parse(stdout) as Array<{ addr_info?: Array<{ family: string; local: string; prefixlen: number }> }>;
  return (data[0]?.addr_info ?? [])
    .filter((entry) => entry.family === "inet")
    .map((entry) => `${entry.local}/${entry.prefixlen}`);
}

async function getDefaultGateway(dev: string) {
  const { stdout } = await execFileAsync("ip", ["route", "show", "default", "dev", dev]).catch(() => ({ stdout: "" }));
  return stdout.match(/default via (\S+)/)?.[1];
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return NaN;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True when the gateway lives inside the CIDR's subnet (i.e. it is the address's "primary" network). */
function cidrContainsGateway(cidr: string, gateway: string): boolean {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr ?? "32", 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  if (prefix >= 31) return false; // /31, /32 can't contain a distinct gateway
  const a = ipv4ToInt(ip);
  const g = ipv4ToInt(gateway);
  if (Number.isNaN(a) || Number.isNaN(g)) return false;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (g & mask);
}

/**
 * Pick the host's PRIMARY address to migrate onto the bridge. On OVH/cloud the
 * primary IP is the one whose subnet contains the default gateway (e.g. a /24);
 * additional "failover" IPs are /32s meant to be assigned to guests, so they
 * must NOT be re-pinned on the host bridge — we leave them free. Returns the
 * primary address(es) to keep on the bridge and the ones we intentionally drop.
 */
function selectPrimaryAddresses(addresses: string[], gateway?: string): { primary: string[]; freed: string[] } {
  if (addresses.length <= 1 || !gateway) return { primary: addresses, freed: [] };
  const primary = addresses.filter((a) => cidrContainsGateway(a, gateway));
  if (primary.length === 0) return { primary: addresses, freed: [] }; // can't tell → keep all (safe)
  const freed = addresses.filter((a) => !primary.includes(a));
  return { primary, freed };
}

/** Returns an interface's current MAC (link/ether) address, or undefined. */
async function getInterfaceMac(name: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync("ip", ["-j", "link", "show", "dev", name]).catch(() => ({ stdout: "" }));
  try {
    const data = JSON.parse(stdout) as Array<{ address?: string }>;
    const mac = data[0]?.address;
    // Ignore all-zero / empty MACs.
    return mac && mac !== "00:00:00:00:00:00" ? mac : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Announce the given IP on the wire so the upstream switch/gateway updates its
 * MAC↔port mapping immediately. This is essential on OVH/cloud hosts: after the
 * host IP moves onto the bridge, the gateway keeps the stale ARP entry pointing
 * at the old port until it ages out (often 30-60s) — during which the host is
 * unreachable and our connectivity check would wrongly roll the bridge back.
 * Sending a gratuitous ARP fixes the mapping in well under a second.
 */
async function announceGratuitousArp(dev: string, ...ipCidrs: Array<string | undefined>) {
  // Clear any stale local neighbour entries first.
  await execFileAsync("ip", ["neigh", "flush", "dev", dev]).catch(() => {});
  for (const cidr of ipCidrs) {
    if (!cidr) continue;
    const ip = cidr.split("/")[0];
    if (!ip) continue;
    // -U = unsolicited/gratuitous ARP, -c 3 = three announcements, -I = interface.
    // arping (iputils) — best-effort; absence of the tool must not break bridging.
    await execFileAsync("arping", ["-U", "-c", "3", "-w", "2", "-I", dev, ip]).catch(() => {});
  }
}

async function assertInterfaceExists(name: string) {
  try {
    await execFileAsync("ip", ["link", "show", "dev", name]);
  } catch {
    throw new Error(`Interface ${name} does not exist`);
  }
}

/** Returns the interface that currently carries the system default route, if any. */
async function getDefaultRouteInterface(): Promise<string | undefined> {
  const { stdout } = await execFileAsync("ip", ["route", "show", "default"]).catch(() => ({ stdout: "" }));
  return stdout.match(/\bdev\s+(\S+)/)?.[1];
}

const NETWORKD_DIR = "/etc/systemd/network";
const NETPLAN_DIR = "/etc/netplan";

type NetworkManager = "ifupdown" | "systemd-networkd" | "netplan" | "networkmanager" | "cloud-init" | "unknown";

/**
 * Detect which subsystem actually manages the host networking. Persisting an
 * ifupdown bridge config on a systemd-networkd/cloud-init host means the config
 * is ignored on reboot (bridge vanishes) or both stacks fight over the NIC and
 * the public IP goes unreachable. We must write the NATIVE format instead.
 */
async function detectNetworkManager(): Promise<NetworkManager> {
  const isActive = async (unit: string) =>
    execFileAsync("systemctl", ["is-active", unit]).then(() => true).catch(() => false);
  const isEnabled = async (unit: string) =>
    execFileAsync("systemctl", ["is-enabled", unit]).then(() => true).catch(() => false);
  const hasFiles = async (glob: string) =>
    execFileAsync("bash", ["-lc", `ls ${glob} >/dev/null 2>&1`]).then(() => true).catch(() => false);
  const hasCmd = async (cmd: string) =>
    execFileAsync("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`]).then(() => true).catch(() => false);

  // Netplan FIRST: on cloud/OVH hosts (and Ubuntu Server) netplan is the source of
  // truth and REGENERATES the systemd-networkd / NetworkManager backend config on
  // EVERY boot. Writing raw networkd or ifupdown there is silently overwritten on
  // reboot (the classic "bridge had no uplink after reboot, server offline" bug).
  // So if netplan owns the box, we must write netplan — even though networkd renders it.
  if ((await hasCmd("netplan")) && (await hasFiles("/etc/netplan/*.yaml /etc/netplan/*.yml"))) {
    return "netplan";
  }
  // Pure systemd-networkd (no netplan layer above it).
  if ((await isEnabled("systemd-networkd.service")) || (await isActive("systemd-networkd.service"))) {
    if (await hasFiles("/etc/systemd/network/*.network /run/systemd/network/*.network")) return "systemd-networkd";
  }
  // NetworkManager (typical home/desktop Linux: Ubuntu desktop, Fedora, …).
  if ((await isActive("NetworkManager.service")) || (await isEnabled("NetworkManager.service"))) {
    return "networkmanager";
  }
  // Classic Debian ifupdown.
  const hasIfupdown = await execFileAsync("bash", ["-lc",
    "grep -rqsE '^[[:space:]]*(auto|iface|allow-hotplug)[[:space:]]' /etc/network/interfaces /etc/network/interfaces.d 2>/dev/null"])
    .then(() => true).catch(() => false);
  if (hasIfupdown) return "ifupdown";
  return "unknown";
}

/** Whether cloud-init is present on the host (so we know to neutralize its network regen). */
async function cloudInitPresent(): Promise<boolean> {
  return execFileAsync("bash", ["-lc", "[ -f /etc/cloud/cloud.cfg ] && command -v cloud-init >/dev/null 2>&1"])
    .then(() => true).catch(() => false);
}

/** True when the interface's primary IPv4 is a DHCP lease (kernel "dynamic" flag). */
async function interfaceIsDhcp(name: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ip", ["-o", "-4", "addr", "show", "dev", name, "scope", "global"]).catch(() => ({ stdout: "" }));
  return /\bdynamic\b/.test(stdout);
}

/**
 * Capture the host's CURRENT DNS servers BEFORE we migrate the IP. On a DHCP
 * host the resolvers came with the lease on the uplink; once we move the IP onto
 * the bridge that lease is gone and the host loses DNS ("can't ping domains").
 * We grab them here so we can re-apply them on the bridge.
 */
async function captureDnsServers(): Promise<string[]> {
  const servers = new Set<string>();
  // systemd-resolved (most Debian 13 / cloud hosts).
  const status = await execFileAsync("resolvectl", ["status"]).then((r) => r.stdout).catch(() => "");
  for (const m of status.matchAll(/Current DNS Server:\s*([0-9.]+)/g)) servers.add(m[1]);
  for (const m of status.matchAll(/DNS Servers:\s*([0-9.\s]+)/g)) {
    for (const ip of m[1].trim().split(/\s+/)) if (/^[0-9.]+$/.test(ip)) servers.add(ip);
  }
  // Fallback: /etc/resolv.conf (skip the resolved stub 127.0.0.53).
  if (servers.size === 0) {
    const resolv = await fs.readFile("/etc/resolv.conf", "utf8").catch(() => "");
    for (const m of resolv.matchAll(/^\s*nameserver\s+([0-9.]+)/gm)) {
      if (m[1] !== "127.0.0.53") servers.add(m[1]);
    }
  }
  return [...servers];
}

/**
 * Keep DNS working on the freshly-bridged host. Uses systemd-resolved per-link
 * DNS when available (doesn't clobber a resolv.conf symlink); always falls back
 * to public resolvers so the host is NEVER left unable to resolve names.
 */
async function applyLiveDns(dev: string, servers: string[]): Promise<void> {
  const list = servers.length ? servers : ["1.1.1.1", "9.9.9.9"];
  const hasResolvectl = await execFileAsync("sh", ["-c", "command -v resolvectl"]).then(() => true).catch(() => false);
  if (hasResolvectl) {
    await execFileAsync("resolvectl", ["dns", dev, ...list]).catch(() => {});
    await execFileAsync("resolvectl", ["domain", dev, "~."]).catch(() => {});
  }
  // If resolv.conf is a regular file (not the resolved stub symlink) and has no
  // usable nameserver, write a fallback so resolution works immediately.
  try {
    const st = await fs.lstat("/etc/resolv.conf");
    if (!st.isSymbolicLink()) {
      const current = await fs.readFile("/etc/resolv.conf", "utf8").catch(() => "");
      const hasUsable = /^\s*nameserver\s+(?!127\.0\.0\.53)[0-9.]+/m.test(current);
      if (!hasUsable) {
        await fs.writeFile("/etc/resolv.conf", list.map((s) => `nameserver ${s}`).join("\n") + "\n");
      }
    }
  } catch {}
}

/**
 * Stop cloud-init from regenerating network config on boot once AuxiNux manages
 * the bridge — otherwise it can overwrite our config and strand the host.
 */
async function disableCloudInitNetwork(): Promise<void> {
  await fs.mkdir("/etc/cloud/cloud.cfg.d", { recursive: true }).catch(() => {});
  await fs.writeFile(
    "/etc/cloud/cloud.cfg.d/99-auxinux-disable-network.cfg",
    "# Managed by AuxiNux Virtua — bridge is managed by the host network stack\nnetwork: {config: disabled}\n",
  ).catch(() => {});
}

/**
 * Anti-lockout guard. Enslaving the interface that carries the host's default
 * route into a bridge WITHOUT migrating its IP (hostIpMode "none") removes the
 * host's connectivity — this is the classic "created a bridge and the server
 * went offline" footgun (typical on OVH/cloud hosts). Refuse it loudly.
 */
async function assertBridgeWontLockOutHost(uplinkInterface: string | undefined, hostIpMode: HostIpMode) {
  if (process.env.AUXINUX_ALLOW_UNSAFE_BRIDGE === "1") return; // explicit opt-out
  if (!uplinkInterface) return; // internal/routed bridge: never touches the uplink
  const defaultDev = await getDefaultRouteInterface();
  if (defaultDev && defaultDev === uplinkInterface && (hostIpMode === "none" || hostIpMode === "dhcp")) {
    throw new Error(
      `Refusing to bridge ${uplinkInterface}: it carries the host's default route and Host IP mode is "${hostIpMode}", ` +
      `which would cut off the server. Use Host IP mode "copy" (migrate the host IP to the bridge) or "static" with the ` +
      `host IP+gateway, or pick a routed bridge with no uplink. (Override with AUXINUX_ALLOW_UNSAFE_BRIDGE=1 if you know what you are doing.)`,
    );
  }
}

interface BridgePersistParams {
  name: string;
  uplinkInterface?: string;
  hostIpMode: HostIpMode;
  ipAddress?: string;
  gateway?: string;
  stp: boolean;
  mtu?: number;
  hwaddress?: string;
  /** The migrated uplink IP came from DHCP → persist DHCP, never freeze it static. */
  dhcpLease?: boolean;
  /** DNS servers to persist so the bridged host keeps resolving names. */
  dns?: string[];
  /** Static global IPv6 address(es) captured from the uplink, to keep on the bridge. */
  ipv6Addresses?: string[];
  /** IPv6 default gateway captured from the uplink. */
  ipv6Gateway?: string;
  /** The IPv6 gateway is off-link (OVH-style) and needs an on-link route. */
  ipv6OnLink?: boolean;
  /** No static IPv6 captured but the uplink used SLAAC → let the bridge accept RA. */
  ipv6AcceptRa?: boolean;
}

interface CapturedIpv6 {
  /** Static (non-SLAAC, non-temporary) global addresses, as addr/prefix. */
  addresses: string[];
  gateway?: string;
  onLink: boolean;
  /** The uplink had a dynamic/SLAAC global address (so the bridge should accept RA). */
  slaac: boolean;
}

/**
 * Capture the uplink's IPv6 so migrating it into a bridge doesn't silently drop
 * IPv6 connectivity. STATIC addresses (e.g. OVH's /128 with an off-link gateway)
 * are carried onto the bridge verbatim; a SLAAC/dynamic address instead means the
 * bridge should simply accept Router Advertisements.
 */
async function captureUplinkIpv6(uplink: string): Promise<CapturedIpv6> {
  const result: CapturedIpv6 = { addresses: [], onLink: false, slaac: false };
  const { stdout } = await execFileAsync("ip", ["-o", "-6", "addr", "show", "dev", uplink, "scope", "global"]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const m = line.match(/inet6\s+([0-9a-fA-F:]+\/\d+)/);
    if (!m) continue;
    if (/\b(dynamic|temporary|mngtmpaddr)\b/.test(line)) { result.slaac = true; continue; }
    result.addresses.push(m[1]);
  }
  const { stdout: routes } = await execFileAsync("ip", ["-6", "route", "show", "default"]).catch(() => ({ stdout: "" }));
  const line = routes.split("\n").find((l) => l.includes(`dev ${uplink}`) && l.includes("via"));
  if (line) {
    const gm = line.match(/via\s+([0-9a-fA-F:]+)/);
    if (gm) { result.gateway = gm[1]; result.onLink = /\bonlink\b/.test(line); }
  }
  return result;
}

/** ifupdown persistence (/etc/network/interfaces.d/). */
async function writeBridgeConfigIfupdown(params: BridgePersistParams) {
  await fs.mkdir(INTERFACES_DIR, { recursive: true });
  const configPath = bridgeConfigPath(params.name);
  // For "copy" of a DHCP lease, keep DHCP (the upstream reservation tied to the
  // pinned MAC re-delivers the same IP) instead of freezing a now-stale address.
  const useDhcp = params.hostIpMode === "dhcp" || (params.hostIpMode === "copy" && params.dhcpLease === true);
  const inetMode = useDhcp ? "dhcp" : (params.hostIpMode === "static" || params.hostIpMode === "copy") ? "static" : "manual";
  const lines = [
    `# Managed by AuxiNux Virtua`,
    `# AUXINUX_HOST_IP_MODE=${useDhcp ? "dhcp" : params.hostIpMode}`,
    `auto ${params.name}`,
    `iface ${params.name} inet ${inetMode}`,
    `    bridge_ports ${params.uplinkInterface ?? "none"}`,
    `    bridge_stp ${params.stp ? "on" : "off"}`,
    `    bridge_fd 0`,
  ];
  if (params.hwaddress) lines.push(`    hwaddress ether ${params.hwaddress}`);
  if (params.mtu) lines.push(`    mtu ${params.mtu}`);
  if (!useDhcp && (params.hostIpMode === "static" || params.hostIpMode === "copy") && params.ipAddress) {
    lines.push(`    address ${params.ipAddress}`);
  }
  if (!useDhcp && (params.hostIpMode === "static" || params.hostIpMode === "copy") && params.gateway) {
    lines.push(`    gateway ${params.gateway}`);
  }
  // Persist DNS for static bridges (needs the `resolvconf` package to take
  // effect via ifupdown; harmless otherwise). DHCP bridges get DNS from the lease.
  if (!useDhcp && params.dns && params.dns.length > 0) {
    lines.push(`    dns-nameservers ${params.dns.join(" ")}`);
  }
  lines.push("");
  await fs.writeFile(configPath, `${lines.join("\n")}\n`);
}

/**
 * Neutralize any EXISTING (cloud-init / vendor) systemd-networkd config that
 * matches the uplink, so it doesn't fight our bridge-bind file on reboot (which
 * would re-grab the NIC with DHCP and strand the bridge). Foreign files matching
 * the uplink are renamed to *.auxinux-disabled (kept as a backup, never deleted).
 */
async function neutralizeForeignUplinkNetworkdConfig(uplink: string) {
  for (const dir of [NETWORKD_DIR, "/run/systemd/network"]) {
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(".network")) continue;
      const full = `${dir}/${f}`;
      const content = await fs.readFile(full, "utf8").catch(() => "");
      if (!content) continue;
      // Skip our own files.
      if (content.includes("Managed by AuxiNux Virtua")) continue;
      // Does it match the uplink by Name= (exact or glob like en*)?
      const nameMatch = content.match(/^\s*Name=(.+)$/m)?.[1]?.trim();
      if (!nameMatch) continue;
      const matchesUplink = nameMatch.split(/\s+/).some((pat) => {
        if (pat === uplink) return true;
        // simple glob: en* matches enp3s0
        if (pat.endsWith("*") && uplink.startsWith(pat.slice(0, -1))) return true;
        return false;
      });
      if (matchesUplink) {
        await fs.rename(full, `${full}.auxinux-disabled`).catch(() => {});
      }
    }
  }
}

/** systemd-networkd persistence (.netdev + .network) so the bridge survives reboot. */
async function writeBridgeConfigNetworkd(params: BridgePersistParams) {
  await fs.mkdir(NETWORKD_DIR, { recursive: true });
  if (params.uplinkInterface) await neutralizeForeignUplinkNetworkdConfig(params.uplinkInterface);
  const useDhcp = params.hostIpMode === "dhcp" || (params.hostIpMode === "copy" && params.dhcpLease === true);

  // 1) The bridge netdev (pin MAC so cloud switch port-security keeps matching).
  const netdev = [
    `# Managed by AuxiNux Virtua`,
    `[NetDev]`,
    `Name=${params.name}`,
    `Kind=bridge`,
    ...(params.hwaddress ? [`MACAddress=${params.hwaddress}`] : []),
    ``,
    `[Bridge]`,
    `STP=${params.stp ? "true" : "false"}`,
    `ForwardDelaySec=0`,
    ``,
  ];
  await fs.writeFile(`${NETWORKD_DIR}/10-${params.name}.netdev`, netdev.join("\n"));

  // 2) Bind the uplink into the bridge (no IP on the port itself).
  if (params.uplinkInterface) {
    const uplinkNet = [
      `# Managed by AuxiNux Virtua`,
      `[Match]`,
      `Name=${params.uplinkInterface}`,
      ``,
      `[Network]`,
      `Bridge=${params.name}`,
      ``,
    ];
    await fs.writeFile(`${NETWORKD_DIR}/10-${params.uplinkInterface}-bind.network`, uplinkNet.join("\n"));
  }

  // 3) The bridge's own L3 config (DHCP or static).
  const bridgeNet = [
    `# Managed by AuxiNux Virtua`,
    `[Match]`,
    `Name=${params.name}`,
    ``,
    `[Network]`,
  ];
  if (useDhcp) {
    bridgeNet.push(`DHCP=ipv4`);
    // Keep a DNS fallback even on DHCP so resolution survives a slow/again lease.
    for (const d of params.dns ?? []) bridgeNet.push(`DNS=${d}`);
  } else {
    if (params.ipAddress) bridgeNet.push(`Address=${params.ipAddress}`);
    if (params.gateway) bridgeNet.push(`Gateway=${params.gateway}`);
    // Static bridge MUST carry DNS explicitly or the host loses name resolution.
    const dnsList = (params.dns && params.dns.length > 0) ? params.dns : ["1.1.1.1", "9.9.9.9"];
    for (const d of dnsList) bridgeNet.push(`DNS=${d}`);
  }
  // IPv6: carry the captured static addresses (OVH /128 etc.) or accept RA (SLAAC).
  for (const a of params.ipv6Addresses ?? []) bridgeNet.push(`Address=${a}`);
  bridgeNet.push(`IPv6AcceptRA=${(!params.ipv6Addresses?.length && params.ipv6AcceptRa) ? "yes" : "no"}`);
  // An off-link IPv6 gateway (OVH-style) needs an explicit on-link route.
  if (params.ipv6Gateway) {
    bridgeNet.push(``, `[Route]`, `Destination=::/0`, `Gateway=${params.ipv6Gateway}`);
    if (params.ipv6OnLink) bridgeNet.push(`GatewayOnLink=true`);
  }
  if (params.mtu) { bridgeNet.push(``, `[Link]`, `MTUBytes=${params.mtu}`); }
  bridgeNet.push(``);
  await fs.writeFile(`${NETWORKD_DIR}/20-${params.name}.network`, bridgeNet.join("\n"));
}

/**
 * Neutralize any EXISTING netplan yaml that configures the uplink (e.g. the OVH/
 * cloud `50-cloud-init.yaml` putting the NIC on standalone DHCP). Netplan MERGES
 * every yaml on `netplan generate`, so a leftover file claiming the uplink would
 * fight our bridge on reboot. Matching files are renamed *.auxinux-disabled
 * (kept as a reversible backup, never deleted). Our own file is left untouched.
 */
async function neutralizeForeignUplinkNetplan(uplink: string, ourFileBase: string) {
  const files = await fs.readdir(NETPLAN_DIR).catch(() => [] as string[]);
  for (const f of files) {
    if (!(f.endsWith(".yaml") || f.endsWith(".yml"))) continue;
    if (f === ourFileBase) continue;
    const full = `${NETPLAN_DIR}/${f}`;
    const content = await fs.readFile(full, "utf8").catch(() => "");
    if (!content) continue;
    if (content.includes("Managed by AuxiNux Virtua")) continue;
    // Reference to the uplink by interface name (key, set-name, or interfaces list).
    if (new RegExp(`(^|[\\s\\[:'"])${uplink}([\\s\\]:'"]|$)`, "m").test(content)) {
      await fs.rename(full, `${full}.auxinux-disabled`).catch(() => {});
    }
  }
}

/** netplan persistence (/etc/netplan/*.yaml) — the source of truth on cloud/OVH/Ubuntu hosts. */
async function writeBridgeConfigNetplan(params: BridgePersistParams) {
  await fs.mkdir(NETPLAN_DIR, { recursive: true });
  const base = `90-auxinux-${params.name}.yaml`;
  if (params.uplinkInterface) await neutralizeForeignUplinkNetplan(params.uplinkInterface, base);
  const useDhcp = params.hostIpMode === "dhcp" || (params.hostIpMode === "copy" && params.dhcpLease === true);

  const lines: string[] = [];
  lines.push(`# Managed by AuxiNux Virtua`);
  lines.push(`network:`);
  lines.push(`  version: 2`);
  lines.push(`  renderer: networkd`);
  if (params.uplinkInterface) {
    lines.push(`  ethernets:`);
    lines.push(`    ${params.uplinkInterface}:`);
    lines.push(`      dhcp4: false`);
    lines.push(`      dhcp6: false`);
    lines.push(`      accept-ra: false`);
  }
  lines.push(`  bridges:`);
  lines.push(`    ${params.name}:`);
  if (params.uplinkInterface) lines.push(`      interfaces: [${params.uplinkInterface}]`);
  if (params.hwaddress) lines.push(`      macaddress: "${params.hwaddress}"`);
  if (params.mtu) lines.push(`      mtu: ${params.mtu}`);
  lines.push(`      dhcp4: ${useDhcp ? "true" : "false"}`);
  lines.push(`      dhcp6: false`);
  // Static addresses: IPv4 (when not DHCP) + captured static IPv6.
  const addresses: string[] = [];
  if (!useDhcp && params.ipAddress) addresses.push(params.ipAddress);
  for (const a of params.ipv6Addresses ?? []) addresses.push(a);
  if (addresses.length) {
    lines.push(`      addresses:`);
    for (const a of addresses) lines.push(`        - "${a}"`);
  }
  // SLAAC only when no static IPv6 was captured.
  if (!(params.ipv6Addresses && params.ipv6Addresses.length)) {
    lines.push(`      accept-ra: ${params.ipv6AcceptRa ? "true" : "false"}`);
  }
  // Routes: static IPv4 default + IPv6 default (with on-link for OVH off-link gw).
  const routes: string[] = [];
  if (!useDhcp && params.gateway) routes.push(`        - to: default\n          via: "${params.gateway}"`);
  if (params.ipv6Gateway) {
    routes.push(`        - to: default\n          via: "${params.ipv6Gateway}"${params.ipv6OnLink ? "\n          on-link: true" : ""}`);
  }
  if (routes.length) {
    lines.push(`      routes:`);
    for (const r of routes) lines.push(r);
  }
  // DNS: keep the host resolving names after the migration.
  const dnsList = useDhcp ? (params.dns ?? []) : ((params.dns && params.dns.length > 0) ? params.dns : ["1.1.1.1", "9.9.9.9"]);
  if (dnsList.length) {
    lines.push(`      nameservers:`);
    lines.push(`        addresses: [${dnsList.join(", ")}]`);
  }
  lines.push(`      parameters:`);
  lines.push(`        stp: ${params.stp ? "true" : "false"}`);
  lines.push(`        forward-delay: 0`);
  lines.push(``);

  const file = `${NETPLAN_DIR}/${base}`;
  await fs.writeFile(file, lines.join("\n"));
  await fs.chmod(file, 0o600).catch(() => {});
  // Stop cloud-init from regenerating a conflicting netplan on the next boot.
  if (await cloudInitPresent()) await disableCloudInitNetwork();
  // Validate the merged config now (surfaces YAML/structure errors immediately).
  await execFileAsync("netplan", ["generate"]).catch(() => {});
}

/**
 * A competing autoconnect profile bound to the uplink (e.g. the distro's default
 * "Wired connection 1") races our bridge-port profile at boot. When it wins, the
 * NIC comes up standalone and the bridge is left WITHOUT its port — guests keep
 * a dead bridge. Turn autoconnect off on every non-AuxiNux profile of the uplink
 * (profiles are kept, never deleted, so this stays reversible with nmcli).
 */
async function neutralizeForeignUplinkNmProfiles(uplink: string) {
  const { stdout } = await execFileAsync("nmcli", ["-t", "-f", "UUID,NAME", "connection", "show"]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const uuid = line.slice(0, sep);
    const name = line.slice(sep + 1);
    if (name.startsWith("auxinux-")) continue;
    const { stdout: ifname } = await execFileAsync("nmcli", ["-g", "connection.interface-name", "connection", "show", "uuid", uuid]).catch(() => ({ stdout: "" }));
    if (ifname.trim() === uplink) {
      await execFileAsync("nmcli", ["connection", "modify", "uuid", uuid, "connection.autoconnect", "no"]).catch(() => {});
    }
  }
}

/** NetworkManager persistence (nmcli connection profiles) — typical home/desktop hosts. */
async function writeBridgeConfigNetworkManager(params: BridgePersistParams) {
  const con = `auxinux-${params.name}`;
  const useDhcp = params.hostIpMode === "dhcp" || (params.hostIpMode === "copy" && params.dhcpLease === true);
  if (params.uplinkInterface) await neutralizeForeignUplinkNmProfiles(params.uplinkInterface);
  // Recreate idempotently. autoconnect-priority beats any leftover default
  // profile of the uplink at boot (priority defaults to 0 everywhere else).
  await execFileAsync("nmcli", ["-t", "connection", "delete", con]).catch(() => {});
  await execFileAsync("nmcli", [
    "connection", "add", "type", "bridge", "con-name", con, "ifname", params.name,
    "bridge.stp", params.stp ? "yes" : "no",
    "connection.autoconnect", "yes",
    "connection.autoconnect-priority", "100",
  ]);
  if (params.hwaddress) {
    await execFileAsync("nmcli", ["connection", "modify", con, "bridge.mac-address", params.hwaddress]).catch(() => {});
  }
  if (params.mtu) {
    await execFileAsync("nmcli", ["connection", "modify", con, "802-3-ethernet.mtu", String(params.mtu)]).catch(() => {});
  }
  // IPv4
  if (useDhcp) {
    await execFileAsync("nmcli", ["connection", "modify", con, "ipv4.method", "auto"]).catch(() => {});
  } else if (params.ipAddress) {
    const args = ["connection", "modify", con, "ipv4.method", "manual", "ipv4.addresses", params.ipAddress];
    if (params.gateway) args.push("ipv4.gateway", params.gateway);
    const dnsList = (params.dns && params.dns.length > 0) ? params.dns : ["1.1.1.1", "9.9.9.9"];
    args.push("ipv4.dns", dnsList.join(" "));
    await execFileAsync("nmcli", args).catch(() => {});
  }
  // IPv6: static captured addresses, else accept RA.
  if (params.ipv6Addresses && params.ipv6Addresses.length) {
    const args = ["connection", "modify", con, "ipv6.method", "manual", "ipv6.addresses", params.ipv6Addresses.join(",")];
    if (params.ipv6Gateway) args.push("ipv6.gateway", params.ipv6Gateway);
    await execFileAsync("nmcli", args).catch(() => {});
  } else {
    await execFileAsync("nmcli", ["connection", "modify", con, "ipv6.method", params.ipv6AcceptRa ? "auto" : "ignore"]).catch(() => {});
  }
  // Enslave the uplink as a bridge port.
  if (params.uplinkInterface) {
    const port = `auxinux-${params.name}-port-${params.uplinkInterface}`;
    await execFileAsync("nmcli", ["-t", "connection", "delete", port]).catch(() => {});
    await execFileAsync("nmcli", [
      "connection", "add", "type", "ethernet", "con-name", port, "ifname", params.uplinkInterface,
      "master", params.name, "connection.autoconnect", "yes",
      "connection.autoconnect-priority", "100",
    ]).catch(() => {});
  }
}

/**
 * Persist the bridge in the host's NATIVE network manager format so it survives
 * reboot without conflicts. Returns the manager used (for reporting).
 */
async function writeBridgeConfig(params: BridgePersistParams): Promise<NetworkManager> {
  const manager = await detectNetworkManager();
  switch (manager) {
    case "netplan":
      // Netplan is the source of truth on cloud/OVH/Ubuntu — write netplan so the
      // bridge survives reboot (writing raw networkd here gets overwritten on boot).
      await writeBridgeConfigNetplan(params);
      break;
    case "systemd-networkd":
    case "cloud-init":
      // Pure networkd (or cloud-init rendering networkd directly without netplan).
      await writeBridgeConfigNetworkd(params);
      if (await cloudInitPresent()) await disableCloudInitNetwork();
      break;
    case "networkmanager":
      await writeBridgeConfigNetworkManager(params);
      break;
    case "ifupdown":
      await writeBridgeConfigIfupdown(params);
      break;
    default:
      // Truly unknown stack: write ifupdown as a best effort; the caller warns that
      // the bridge may be live-only until configured natively.
      await writeBridgeConfigIfupdown(params);
      break;
  }
  return manager;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connectivity check used by the bridge auto-rollback, tuned for OVH/cloud hosts.
 *
 * Why this is more than "ping the gateway": OVH (and many cloud) gateways DO NOT
 * answer ICMP echo, so a naive `ping gateway` fails even when the network is
 * perfectly healthy — causing a false rollback (the exact "ça chie" symptom).
 *
 * We instead consider the host reachable if ANY of these succeed, after giving
 * the freshly-bridged link a moment to settle:
 *   1. arping the gateway over the bridge — works at L2 even when ICMP is filtered.
 *   2. ping the gateway — the common case on normal datacenters.
 *   3. ping a public anycast resolver (1.1.1.1 / 9.9.9.9) — proves real egress.
 * Each probe is retried a few times over several seconds before giving up.
 */
async function hostHasConnectivity(gateway: string | undefined, bridgeDev?: string): Promise<boolean> {
  // Give the bridge/port time to reach forwarding state and the gratuitous ARP
  // to propagate before we judge connectivity.
  await sleep(2500);

  const arpingGateway = async (): Promise<boolean> => {
    if (!gateway || !bridgeDev) return false;
    // -f finish on first reply, -c count, -w deadline, -I interface.
    return execFileAsync("arping", ["-f", "-c", "2", "-w", "3", "-I", bridgeDev, gateway])
      .then(() => true)
      .catch(() => false);
  };
  const pingHost = async (host: string): Promise<boolean> =>
    execFileAsync("ping", ["-c", "1", "-W", "2", host])
      .then(() => true)
      .catch(() => false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await arpingGateway()) return true;
    if (gateway && (await pingHost(gateway))) return true;
    if (await pingHost("1.1.1.1")) return true;
    if (await pingHost("9.9.9.9")) return true;
    await sleep(1500);
  }

  // Last resort: if we cannot actively prove egress (some OVH/cloud setups filter
  // BOTH ICMP and ARP replies from exotic gateways) we only refrain from rolling
  // back when the default route is actually installed ON THE BRIDGE — i.e. the
  // migration structurally succeeded. If the route is missing or on another
  // device, treat it as a failure so the rollback restores the host.
  if (bridgeDev) {
    const defaultDev = await getDefaultRouteInterface();
    return defaultDev === bridgeDev;
  }
  return (await getDefaultRouteInterface()) !== undefined;
}

/**
 * Undo a freshly-created uplink bridge after a failed connectivity check:
 * detach + delete the bridge, restore the migrated IP(s) onto the uplink, and
 * re-add the default route through the uplink. Best-effort but ordered so the
 * host regains reachability.
 */
async function revertUplinkBridge(bridgeName: string, uplinkInterface: string, migratedAddresses: string[], gateway?: string) {
  await execFileAsync("ip", ["link", "set", "dev", uplinkInterface, "nomaster"]).catch(() => {});
  await execFileAsync("ip", ["link", "delete", bridgeName, "type", "bridge"]).catch(() => {});
  await execFileAsync("ip", ["link", "set", "dev", uplinkInterface, "up"]).catch(() => {});
  for (const address of migratedAddresses) {
    await execFileAsync("ip", ["addr", "add", address, "dev", uplinkInterface]).catch(() => {});
  }
  if (gateway) {
    await execFileAsync("ip", ["route", "replace", "default", "via", gateway, "dev", uplinkInterface]).catch(() => {});
  }
  // Re-announce the IPs on the original NIC so the upstream switch/gateway drops
  // the bridge mapping immediately and the host comes back without waiting for ARP aging.
  await announceGratuitousArp(uplinkInterface, ...migratedAddresses);
}

async function createBridge(p: Record<string, unknown>) {
  const name = validateIfName(p.name, "bridge name");
  const uplinkInterface = validateOptionalIfName((p.uplinkInterface as string | undefined)?.trim(), "uplink interface");
  const rawHostIpMode = ((p.hostIpMode as HostIpMode | undefined) ?? "none");
  if (!["none", "dhcp", "static", "copy"].includes(rawHostIpMode)) {
    throw new Error("Invalid hostIpMode: must be none, dhcp, static, or copy");
  }
  const hostIpMode: HostIpMode = rawHostIpMode;
  const ipAddress = validateIpv4Cidr((p.ipAddress as string | undefined)?.trim() || undefined, "ipAddress");
  const gateway = validateIpv4((p.gateway as string | undefined)?.trim() || undefined, "gateway");
  const stp = Boolean(p.stp);
  const mtu = validateMtu(p.mtu);
  const persist = p.persist !== false;

  try {
    await execFileAsync("ip", ["link", "show", "dev", name]);
    throw new Error(`Interface ${name} already exists`);
  } catch (error) {
    if (error instanceof Error && error.message === `Interface ${name} already exists`) {
      throw error;
    }
  }
  if (uplinkInterface) await assertInterfaceExists(uplinkInterface);
  if ((hostIpMode === "static") && !ipAddress) throw new Error("Static bridge mode requires an IP address");
  // Prevent the "bridge bricked my server" footgun (esp. on OVH/cloud hosts).
  await assertBridgeWontLockOutHost(uplinkInterface, hostIpMode);

  let runtimeIpAddresses: string[] = [];
  let runtimeGateway = gateway;
  let freedAddresses: string[] = [];
  let persistedVia: NetworkManager | undefined;
  if (uplinkInterface && hostIpMode === "copy") {
    const allAddresses = await getInterfaceIPv4(uplinkInterface);
    runtimeGateway = gateway ?? await getDefaultGateway(uplinkInterface);
    if (allAddresses.length === 0) {
      throw new Error(`No IPv4 address found on ${uplinkInterface} to migrate`);
    }
    // Migrate ONLY the primary IP (the gateway's subnet). OVH failover /32s are
    // left unbound so they can be assigned to a VM/LXC/Docker guest instead.
    const selection = selectPrimaryAddresses(allAddresses, runtimeGateway);
    runtimeIpAddresses = selection.primary;
    freedAddresses = selection.freed;
  } else if (hostIpMode === "static" && ipAddress) {
    runtimeIpAddresses = [ipAddress];
    if (uplinkInterface && !runtimeGateway) {
      runtimeGateway = await getDefaultGateway(uplinkInterface);
    }
  }
  if (uplinkInterface && hostIpMode === "static" && !runtimeGateway) {
    throw new Error(`Static bridge mode with uplink ${uplinkInterface} requires a default gateway, or an existing default route on that uplink to auto-detect it`);
  }

  // Capture the uplink's MAC so we can PIN it on the bridge. This is THE fix for
  // OVH/cloud "bridge kills the host" failures: the upstream switch enforces port
  // security on the NIC's MAC, so the bridge must present the SAME MAC once the
  // host IP migrates onto it (this is exactly what Proxmox does on OVH).
  const uplinkMac = uplinkInterface ? await getInterfaceMac(uplinkInterface) : undefined;

  // Capture DHCP status BEFORE flushing the uplink (the flush clears the lease
  // and its "dynamic" flag). If the migrated IP was DHCP, we must persist the
  // bridge as DHCP — never freeze a lease as a static address (stale-IP footgun).
  const uplinkWasDhcp = uplinkInterface && hostIpMode === "copy" ? await interfaceIsDhcp(uplinkInterface) : false;

  // Capture DNS servers BEFORE migrating — on a DHCP host they came with the
  // uplink lease and would otherwise be lost (host can no longer resolve names).
  const dnsServers = uplinkInterface && (hostIpMode === "copy" || hostIpMode === "static")
    ? await captureDnsServers()
    : [];

  // Capture the uplink's IPv6 BEFORE the flush so migrating IPv4 onto the bridge
  // doesn't silently kill IPv6 (e.g. OVH's static /128 with an off-link gateway).
  const capturedIpv6: CapturedIpv6 = uplinkInterface && hostIpMode === "copy"
    ? await captureUplinkIpv6(uplinkInterface)
    : { addresses: [], onLink: false, slaac: false };

  await execFileAsync("ip", ["link", "add", name, "type", "bridge", "stp_state", stp ? "1" : "0"]);
  try {
    // Pin the bridge MAC to the uplink MAC BEFORE bringing it up, so the bridge
    // never advertises a random MAC on the wire (which OVH would filter/blackhole).
    if (uplinkMac) {
      await execFileAsync("ip", ["link", "set", "dev", name, "address", uplinkMac]).catch(() => {});
    }

    if (mtu) {
      await execFileAsync("ip", ["link", "set", "dev", name, "mtu", String(mtu)]);
      if (uplinkInterface) {
        await execFileAsync("ip", ["link", "set", "dev", uplinkInterface, "mtu", String(mtu)]).catch(() => {});
      }
    }

    await execFileAsync("ip", ["link", "set", "dev", name, "up"]);

    if (uplinkInterface) {
      if (hostIpMode === "dhcp") {
        await execFileAsync("dhclient", ["-r", uplinkInterface]).catch(() => {});
      }
      if (hostIpMode === "copy" || hostIpMode === "static" || hostIpMode === "dhcp") {
        await execFileAsync("ip", ["addr", "flush", "dev", uplinkInterface]).catch(() => {});
      }
      await execFileAsync("ip", ["link", "set", "dev", uplinkInterface, "master", name]);
      await execFileAsync("ip", ["link", "set", "dev", uplinkInterface, "up"]);
      // Re-assert the pinned MAC after enslaving (the kernel may have recomputed
      // the bridge MAC from its ports — we want it deterministic).
      if (uplinkMac) {
        await execFileAsync("ip", ["link", "set", "dev", name, "address", uplinkMac]).catch(() => {});
      }
    }

    for (const address of runtimeIpAddresses) {
      await execFileAsync("ip", ["addr", "add", address, "dev", name]);
    }

    if ((hostIpMode === "copy" || hostIpMode === "static") && runtimeGateway) {
      await execFileAsync("ip", ["route", "replace", "default", "via", runtimeGateway, "dev", name]);
    }

    // Carry the captured static IPv6 onto the bridge — the uplink flush dropped it.
    for (const a of capturedIpv6.addresses) {
      await execFileAsync("ip", ["-6", "addr", "add", a, "dev", name]).catch(() => {});
    }
    if (capturedIpv6.gateway) {
      if (capturedIpv6.onLink) {
        await execFileAsync("ip", ["-6", "route", "replace", capturedIpv6.gateway, "dev", name]).catch(() => {});
      }
      await execFileAsync("ip", ["-6", "route", "replace", "default", "via", capturedIpv6.gateway, "dev", name,
        ...(capturedIpv6.onLink ? ["onlink"] : [])]).catch(() => {});
    }

    if (hostIpMode === "dhcp") {
      await execFileAsync("dhclient", ["-4", "-v", name]);
    }

    // Tell the upstream switch/gateway about the move RIGHT NOW (gratuitous ARP),
    // instead of waiting up to a minute for its ARP cache to age out. Without this
    // the host appears offline during the gap and we'd roll back a healthy bridge.
    if (uplinkInterface && (hostIpMode === "copy" || hostIpMode === "static")) {
      await announceGratuitousArp(name, ...runtimeIpAddresses);
      // Re-apply DNS on the bridge so the host keeps resolving names (the DHCP
      // lease that provided them on the uplink is gone after the migration).
      await applyLiveDns(name, dnsServers);
    }

    // Auto-rollback safety net: when we just enslaved a live uplink and migrated
    // the host IP onto the bridge, verify the host still has a usable path out.
    // If not (mis-detected gateway, wrong IP mode, …) we undo everything so the
    // box stays reachable instead of going dark until reboot.
    if (uplinkInterface && (hostIpMode === "copy" || hostIpMode === "static") && process.env.AUXINUX_SKIP_BRIDGE_VERIFY !== "1") {
      const reachable = await hostHasConnectivity(runtimeGateway, name);
      if (!reachable) {
        await revertUplinkBridge(name, uplinkInterface, runtimeIpAddresses, runtimeGateway);
        throw new Error(
          `Bridge ${name} was rolled back automatically: the host lost connectivity after migrating ${uplinkInterface} ` +
          `onto the bridge. The previous network configuration has been restored. On OVH/cloud, verify the gateway is the block's ` +
          `.254 address and that the NIC MAC is allowed; the bridge now pins the NIC MAC automatically. ` +
          `(Override the check with AUXINUX_SKIP_BRIDGE_VERIFY=1.)`,
        );
      }
    }

    if (persist) {
      persistedVia = await writeBridgeConfig({
        name,
        uplinkInterface,
        hostIpMode,
        ipAddress: hostIpMode === "copy" ? runtimeIpAddresses[0] : ipAddress,
        gateway: runtimeGateway,
        stp,
        mtu,
        hwaddress: uplinkMac,
        dhcpLease: uplinkWasDhcp,
        dns: dnsServers,
        ipv6Addresses: capturedIpv6.addresses.length ? capturedIpv6.addresses : undefined,
        ipv6Gateway: capturedIpv6.gateway,
        ipv6OnLink: capturedIpv6.onLink,
        ipv6AcceptRa: capturedIpv6.slaac,
      });
    }
  } catch (error) {
    await execFileAsync("ip", ["link", "delete", name, "type", "bridge"]).catch(() => {});
    throw error;
  }

  // Warn when persistence may not survive reboot in this host's network manager.
  const persistWarning =
    persist && uplinkInterface && persistedVia === "unknown"
      ? `Bridge is live now, but AuxiNux could not detect this host's network manager, so persistence was written ` +
        `as ifupdown (best effort). It may not survive a reboot — verify ${name} in your network config.`
      : undefined;

  return {
    ok: true,
    name,
    uplinkInterface,
    hostIpMode,
    ipAddress: (hostIpMode === "copy" ? runtimeIpAddresses[0] : ipAddress) ?? undefined,
    gateway: runtimeGateway,
    hwaddress: uplinkMac,
    persistedVia,
    persistWarning,
    // IPs intentionally NOT moved onto the bridge (OVH failover /32s) — now free
    // to assign to a VM/LXC/Docker guest with its OVH vMAC.
    freedAddresses: freedAddresses.length ? freedAddresses : undefined,
  };
}

async function deleteBridge(rawName: string) {
  const name = validateIfName(rawName, "bridge name");
  const bridge = (await listBridges()).find((entry) => entry.name === name) as { interfaces?: string[] } | undefined;
  for (const member of bridge?.interfaces ?? []) {
    await execFileAsync("ip", ["link", "set", "dev", member, "nomaster"]).catch(() => {});
  }
  await execFileAsync("ip", ["link", "set", name, "down"]).catch(() => {});
  await execFileAsync("ip", ["link", "delete", name, "type", "bridge"]);
  // Remove persistence in ALL supported formats so the bridge does not come back
  // on reboot (ifupdown drop-in AND systemd-networkd .netdev/.network).
  await fs.rm(bridgeConfigPath(name), { force: true }).catch(() => {});
  await fs.rm(`${NETWORKD_DIR}/10-${name}.netdev`, { force: true }).catch(() => {});
  await fs.rm(`${NETWORKD_DIR}/20-${name}.network`, { force: true }).catch(() => {});
  // Remove any uplink-bind .network files that reference this bridge.
  const files = await fs.readdir(NETWORKD_DIR).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith("-bind.network")) continue;
    const content = await fs.readFile(`${NETWORKD_DIR}/${f}`, "utf8").catch(() => "");
    if (content.includes("Managed by AuxiNux Virtua") && content.includes(`Bridge=${name}`)) {
      await fs.rm(`${NETWORKD_DIR}/${f}`, { force: true }).catch(() => {});
    }
  }
  // netplan persistence + restore any vendor file we neutralized (so the host's
  // ORIGINAL network config comes back — otherwise it would boot with no config).
  await fs.rm(`${NETPLAN_DIR}/90-auxinux-${name}.yaml`, { force: true }).catch(() => {});
  await restoreNeutralizedBackups(NETPLAN_DIR);
  await restoreNeutralizedBackups(NETWORKD_DIR);
  await restoreNeutralizedBackups("/run/systemd/network");
  if (await execFileAsync("bash", ["-lc", "command -v netplan >/dev/null 2>&1"]).then(() => true).catch(() => false)) {
    await execFileAsync("netplan", ["generate"]).catch(() => {});
  }
  // NetworkManager persistence (bridge + its port connections).
  await execFileAsync("nmcli", ["-t", "connection", "delete", `auxinux-${name}`]).catch(() => {});
  const nmList = await execFileAsync("nmcli", ["-t", "-f", "NAME", "connection", "show"]).then((r) => r.stdout).catch(() => "");
  for (const con of nmList.split("\n")) {
    if (con.startsWith(`auxinux-${name}-port-`)) {
      await execFileAsync("nmcli", ["-t", "connection", "delete", con]).catch(() => {});
    }
  }
  return { ok: true };
}

/** Restore *.auxinux-disabled vendor backups in a directory back to their original names. */
async function restoreNeutralizedBackups(dir: string) {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".auxinux-disabled")) continue;
    const original = `${dir}/${f.slice(0, -".auxinux-disabled".length)}`;
    // Don't clobber an existing file with the restored backup.
    if (await fs.access(original).then(() => true).catch(() => false)) continue;
    await fs.rename(`${dir}/${f}`, original).catch(() => {});
  }
}

function netmaskToCidr(netmask: string): number {
  return netmask.split(".").map(Number).reduce((acc, octet) => {
    let bits = 0;
    let value = octet;
    while (value > 0) {
      bits += value & 1;
      value >>= 1;
    }
    return acc + bits;
  }, 0);
}

async function listVirtualNetworks() {
  try {
    const { stdout } = await execFileAsync("virsh", ["net-list", "--all"]);
    const rows = stdout.split("\n").slice(2).map((line) => line.trim()).filter(Boolean);
    const networks = await Promise.all(rows.map(async (row) => {
      const parts = row.split(/\s{2,}/);
      const name = parts[0];
      if (!name) return null;

      try {
        const { stdout: xml } = await execFileAsync("virsh", ["net-dumpxml", name]);
        const mode = xml.match(/<forward mode="([^"]+)"/)?.[1] ?? "isolated";
        const subnet = xml.match(/<ip address="([^"]+)" netmask="([^"]+)"/);
        const dhcpRange = xml.match(/<range start="([^"]+)" end="([^"]+)"/);
        return {
          name,
          active: parts[1] === "active",
          autostart: parts[2] === "yes",
          persistent: true,
          bridge: xml.match(/<bridge name="([^"]+)"/)?.[1],
          mode: mode === "nat" || mode === "route" || mode === "bridge" ? mode : "isolated",
          subnet: subnet ? `${subnet[1]}/${netmaskToCidr(subnet[2])}` : undefined,
          gateway: subnet ? subnet[1] : undefined,
          dhcpStart: dhcpRange?.[1],
          dhcpEnd: dhcpRange?.[2],
        };
      } catch {
        return { name, active: parts[1] === "active", autostart: parts[2] === "yes", persistent: true, mode: "isolated" };
      }
    }));
    return networks.filter(Boolean);
  } catch {
    return [];
  }
}

function validateNetworkName(value: string, field: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`Invalid ${field}: only alphanumeric characters, hyphens, and underscores are allowed`);
  }
  return value;
}

async function createVirtualNetwork(p: Record<string, unknown>) {
  const name = validateNetworkName(p.name as string, "network name");
  const subnet = (p.subnet as string) ?? "192.168.100.0/24";
  const rawMode = (p.mode as string) ?? "nat";
  if (!["nat", "route", "bridge", "isolated"].includes(rawMode)) {
    throw new Error("Invalid network mode: must be nat, route, bridge, or isolated");
  }
  const mode = rawMode;
  const dhcp = (p.dhcp as boolean) ?? true;
  const bridgeName = validateNetworkName((p.bridgeName as string) ?? `vnet-${name}`, "bridge name");
  const [networkIp, cidrStr] = subnet.split("/");
  const cidr = parseInt(cidrStr ?? "24", 10);
  const parts = networkIp.split(".");
  const gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
  const dhcpStart = `${parts[0]}.${parts[1]}.${parts[2]}.100`;
  const dhcpEnd = `${parts[0]}.${parts[1]}.${parts[2]}.200`;
  const netmask = cidr >= 24 ? "255.255.255.0" : "255.255.0.0";

  const forward = mode === "isolated" ? "" : `<forward mode="${mode}"/>`;
  const dhcpSection = dhcp ? `<dhcp><range start="${dhcpStart}" end="${dhcpEnd}"/></dhcp>` : "";
  const xml = `<network>
  <name>${name}</name>
  ${forward}
  <bridge name="${bridgeName}" stp="on" delay="0"/>
  <ip address="${gateway}" netmask="${netmask}">
    ${dhcpSection}
  </ip>
</network>`;

  const tmp = `/tmp/auxinux-net-${Date.now()}.xml`;
  await fs.writeFile(tmp, xml);
  try {
    await execFileAsync("virsh", ["net-define", tmp]);
    await execFileAsync("virsh", ["net-start", name]);
    await execFileAsync("virsh", ["net-autostart", name]);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return { ok: true };
}

async function deleteVirtualNetwork(name: string) {
  await execFileAsync("virsh", ["net-destroy", name]).catch(() => {});
  await execFileAsync("virsh", ["net-undefine", name]);
  return { ok: true };
}

async function listInterfaces() {
  try {
    const { stdout } = await execFileAsync("ip", ["-j", "addr", "show"]);
    const ifaces = JSON.parse(stdout) as Array<{
      ifname: string;
      flags: string[];
      address: string;
      mtu: number;
      addr_info?: Array<{ family: string; local: string; prefixlen: number }>;
    }>;
    return ifaces.map((iface) => ({
      name: iface.ifname,
      state: iface.flags.includes("UP") ? "UP" : "DOWN",
      macAddress: iface.address,
      addresses: (iface.addr_info ?? []).filter((entry) => entry.family === "inet").map((entry) => `${entry.local}/${entry.prefixlen}`),
      mtu: iface.mtu,
      type: detectIfaceType(iface.ifname),
    }));
  } catch {
    return [];
  }
}

function detectIfaceType(name: string): "physical" | "bridge" | "vlan" | "loopback" | "virtual" {
  if (name === "lo") return "loopback";
  if (name.startsWith("br") || name.startsWith("vmbr")) return "bridge";
  if (name.startsWith("veth") || name.startsWith("vir") || name.startsWith("docker")) return "virtual";
  if (name.match(/\.\d+$/)) return "vlan";
  return "physical";
}
