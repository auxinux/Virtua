import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { ScopeNotice } from "../../components/ui/ScopeNotice";
import type { NetworkBridge, LibvirtNetwork, NetworkInterface, DockerNetwork } from "@auxinux/shared";

// ─── Create Bridge Modal ───────────────────────────────────────────────────────
function CreateBridgeModal({ open, onClose, onCreated, interfaces }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  interfaces: NetworkInterface[];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("vmbr");
  const [uplinkInterface, setUplinkInterface] = useState("");
  const [hostIpMode, setHostIpMode] = useState<"none" | "dhcp" | "static" | "copy">("none");
  const [ipAddress, setIpAddress] = useState("");
  const [gateway, setGateway] = useState("");
  const [mtu, setMtu] = useState("");
  const [stp, setStp] = useState(false);
  const [persist, setPersist] = useState(true);
  const [preset, setPreset] = useState<"custom" | "cloud-routed" | "cloud-bridged">("custom");
  const [error, setError] = useState("");

  const uplinkChoices = interfaces.filter((entry) => entry.type === "physical" || entry.type === "vlan");

  // Presets tuned for OVH / Online / cloud hosts where IPs are routed (failover).
  function applyPreset(value: "custom" | "cloud-routed" | "cloud-bridged") {
    setPreset(value);
    setError("");
    if (value === "cloud-routed") {
      // Routed bridge: NO physical uplink → the host NIC is never touched, so the
      // server can't be locked out. Failover IPs are routed to guests in /32.
      setName("vmbr0");
      setUplinkInterface("");
      setHostIpMode("static");
      setIpAddress("");      // the user fills the bridge gateway IP, e.g. 203.0.113.254/32
      setGateway("");
    } else if (value === "cloud-bridged") {
      // Bridged + vMAC: enslave the physical NIC and MIGRATE the host IP onto the
      // bridge (mode "copy"), the official OVH bridge method. Auto-rollback guards it.
      setHostIpMode("copy");
      setIpAddress("");
      setGateway("");
    }
  }

  const create = useMutation({
    mutationFn: () => apiPost("/api/network/bridges", {
      name,
      uplinkInterface: uplinkInterface || undefined,
      hostIpMode,
      ipAddress: ipAddress || undefined,
      gateway: gateway || undefined,
      stp,
      mtu: mtu ? parseInt(mtu, 10) : undefined,
      persist,
    }),
    onSuccess: () => {
      onCreated();
      onClose();
      setName("vmbr");
      setUplinkInterface("");
      setHostIpMode("none");
      setIpAddress("");
      setGateway("");
      setMtu("");
      setPersist(true);
      setStp(false);
      setPreset("custom");
      setError("");
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={open} title={t("modal.createNetworkBridge")} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div>
          <label className="label">Preset</label>
          <select className="select" value={preset} onChange={(e) => applyPreset(e.target.value as "custom" | "cloud-routed" | "cloud-bridged")}>
            <option value="custom">Custom</option>
            <option value="cloud-routed">Cloud / provider — Routed additional IPs (recommended)</option>
            <option value="cloud-bridged">Cloud / provider — Bridged + virtual MAC</option>
          </select>
          {preset === "cloud-routed" && (
            <p className="text-xs text-text-500 mt-1">
              No physical uplink: the host NIC is never touched (no lock-out risk). Set the bridge Host IP to a gateway address
              for your guests, e.g. <span className="font-mono">203.0.113.254/32</span>. Then give each LXC/VM an additional IP in
              <span className="font-mono"> /32</span> with this bridge IP as its gateway.
            </p>
          )}
          {preset === "cloud-bridged" && (
            <p className="text-xs text-text-500 mt-1">
              Enslaves your physical NIC and migrates the host IP onto the bridge (mode <span className="font-mono">copy</span>),
              the Proxmox-style method. The bridge automatically <span className="text-text-300">pins the NIC's MAC</span> and sends a
              gratuitous ARP so the upstream switch keeps routing to the host — no more false lock-outs. Guests then use their
              provider-assigned virtual MAC and the block gateway (<span className="font-mono">….254</span>). Auto-rollback still
              restores the network if anything goes wrong.
            </p>
          )}
        </div>

        <div>
          <label className="label">Bridge Name *</label>
          <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="vmbr0" />
          <p className="text-xs text-text-500 mt-1">e.g. vmbr0, vmbr1, br-lan</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Physical Uplink (optional)</label>
            <select className="select font-mono" value={uplinkInterface} onChange={(e) => setUplinkInterface(e.target.value)}>
              <option value="">No uplink / isolated bridge</option>
              {uplinkChoices.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}{entry.addresses?.length ? ` · ${entry.addresses.join(", ")}` : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-500 mt-1">Select the host NIC to bridge, for example `enp3s0`</p>
          </div>
          <div>
            <label className="label">Bridge MTU (optional)</label>
            <input className="input font-mono" value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1500" />
            <p className="text-xs text-text-500 mt-1">Leave empty to keep the current interface MTU</p>
          </div>
        </div>

        <div>
          <label className="label">Host IP on Bridge</label>
          <select className="select" value={hostIpMode} onChange={(e) => setHostIpMode(e.target.value as "none" | "dhcp" | "static" | "copy")}>
            <option value="none">None</option>
            <option value="dhcp">DHCP</option>
            <option value="static">Static IPv4</option>
            <option value="copy">Migrate current uplink IPv4 (advanced)</option>
          </select>
          <p className="text-xs text-text-500 mt-1">
            `copy` is useful for Proxmox/cloud-style bridge migration from the current host NIC to the bridge.
          </p>
        </div>

        {hostIpMode === "static" && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Bridge IPv4 (CIDR)</label>
              <input className="input font-mono" value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} placeholder={preset === "cloud-routed" ? "203.0.113.254/32" : "192.168.100.10/24"} />
            </div>
            <div>
              <label className="label">Default Gateway (optional)</label>
              <input className="input font-mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="192.168.100.1" />
              {uplinkInterface && (
                <p className="text-xs text-text-500 mt-1">Leave empty to reuse the uplink's current default gateway.</p>
              )}
            </div>
          </div>
        )}

        {hostIpMode === "copy" && (
          <div>
            <label className="label">Default Gateway (optional override)</label>
            <input className="input font-mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="auto-detected from current uplink" />
            <p className="text-xs text-text-500 mt-1">Leave empty to reuse the uplink's current default gateway.</p>
          </div>
        )}

        {uplinkInterface && (hostIpMode === "dhcp" || hostIpMode === "static" || hostIpMode === "copy") && (
          <div className="rounded border border-yellow-700/60 bg-yellow-900/20 px-3 py-3 text-sm text-yellow-200">
            This enslaves <span className="font-mono">{uplinkInterface}</span> and moves the host IP onto the bridge. The bridge
            pins the NIC's MAC and announces it (gratuitous ARP) so the upstream provider keeps routing to the host. If connectivity
            is still lost, it auto-rolls back within a few seconds. Use <span className="font-mono">copy</span> to migrate the current
            host IPv4 (Proxmox-style).
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-accent-blue" checked={stp} onChange={(e) => setStp(e.target.checked)} />
          <span className="text-sm text-text-300">Enable STP (Spanning Tree Protocol)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-accent-blue" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          <span className="text-sm text-text-300">Persist bridge in Debian network config</span>
        </label>
        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={() => create.mutate()} disabled={!name || create.isPending || (hostIpMode === "static" && !ipAddress)} className="btn-primary">
            {create.isPending ? "Creating..." : "Create Bridge"}
          </button>
          <button onClick={onClose} className="btn">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Create NAT Network Modal ──────────────────────────────────────────────────
function CreateNatModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [subnet, setSubnet] = useState("192.168.100.0/24");
  const [dhcp, setDhcp] = useState(true);
  const [mode, setMode] = useState<"nat" | "isolated">("nat");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => apiPost("/api/network/nat", { name, subnet, dhcp, mode }),
    onSuccess: () => { onCreated(); onClose(); setName(""); setError(""); },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={open} title={t("modal.createNatNetwork")} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Network Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-network" />
        </div>
        <div>
          <label className="label">Subnet (CIDR)</label>
          <input className="input font-mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="192.168.100.0/24" />
        </div>
        <div>
          <label className="label">Mode</label>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as "nat" | "isolated")}>
            <option value="nat">NAT / private</option>
            <option value="isolated">Isolated only</option>
          </select>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-accent-blue" checked={dhcp} onChange={(e) => setDhcp(e.target.checked)} />
          <span className="text-sm text-text-300">Enable DHCP for this network</span>
        </label>
        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={() => create.mutate()} disabled={!name || create.isPending} className="btn-primary">
            {create.isPending ? "Creating..." : "Create Network"}
          </button>
          <button onClick={onClose} className="btn">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Create Docker Network Modal ───────────────────────────────────────────────
function CreateDockerNetworkModal({ open, onClose, onCreated, interfaces, bridges }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  interfaces: NetworkInterface[];
  bridges: NetworkBridge[];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("public-net");
  const [driver, setDriver] = useState<"bridge" | "macvlan" | "ipvlan">("macvlan");
  const [parent, setParent] = useState("");
  const [subnet, setSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [ipRange, setIpRange] = useState("");
  const [error, setError] = useState("");

  const parentChoices = [
    ...interfaces.map((entry) => ({ name: entry.name, detail: entry.addresses?.join(", ") || entry.type || "" })),
    ...bridges.map((entry) => ({ name: entry.name, detail: "bridge" })),
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.name === entry.name) === index);

  const create = useMutation({
    mutationFn: () => apiPost("/api/docker/networks", {
      name,
      driver,
      parent: parent || undefined,
      subnet: subnet || undefined,
      gateway: gateway || undefined,
      ipRange: ipRange || undefined,
    }),
    onSuccess: () => {
      onCreated();
      onClose();
      setName("public-net");
      setDriver("macvlan");
      setParent("");
      setSubnet("");
      setGateway("");
      setIpRange("");
      setError("");
    },
    onError: (err: Error) => setError(err.message),
  });

  const parentRequired = driver === "macvlan" || driver === "ipvlan";

  return (
    <Modal open={open} title={t("network.createDockerNetwork")} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="rounded border border-blue-800/50 bg-blue-900/20 px-3 py-2 text-xs text-blue-200">
          {t("network.ovhDockerHelp")}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t("network.networkName")} *</label>
            <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="public-net" />
          </div>
          <div>
            <label className="label">{t("network.driver")}</label>
            <select className="input" value={driver} onChange={(e) => setDriver(e.target.value as "bridge" | "macvlan" | "ipvlan")}>
              <option value="macvlan">macvlan</option>
              <option value="ipvlan">ipvlan</option>
              <option value="bridge">bridge</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">{t("network.parentInterfaceBridge")} {parentRequired ? "*" : ""}</label>
          <select className="input font-mono" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t("network.selectParent")}</option>
            {parentChoices.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}{entry.detail ? ` · ${entry.detail}` : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-500 mt-1">{t("network.parentHelp")}</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">{t("network.subnetCidr")}</label>
            <input className="input font-mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="203.0.113.0/24" />
          </div>
          <div>
            <label className="label">{t("network.gateway")}</label>
            <input className="input font-mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="203.0.113.254" />
          </div>
          <div>
            <label className="label">{t("network.ipRangeCidr")}</label>
            <input className="input font-mono" value={ipRange} onChange={(e) => setIpRange(e.target.value)} placeholder="203.0.113.245/32" />
          </div>
        </div>

        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={() => create.mutate()} disabled={!name || (parentRequired && !parent) || create.isPending} className="btn-primary">
            {create.isPending ? t("common.creating") : t("network.createDockerNetwork")}
          </button>
          <button onClick={onClose} className="btn">{t("action.cancel")}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function NetworkPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createBridgeOpen, setCreateBridgeOpen] = useState(false);
  const [createNatOpen, setCreateNatOpen] = useState(false);
  const [createDockerNetworkOpen, setCreateDockerNetworkOpen] = useState(false);
  const [deleteBridgeTarget, setDeleteBridgeTarget] = useState<string | null>(null);
  const [deleteNatTarget, setDeleteNatTarget] = useState<string | null>(null);
  const [deleteDockerNetworkTarget, setDeleteDockerNetworkTarget] = useState<DockerNetwork | null>(null);

  const { data: bridges = [] } = useQuery<NetworkBridge[]>({
    queryKey: ["network", "bridges"],
    queryFn: () => apiGet<NetworkBridge[]>("/api/network/bridges"),
    refetchInterval: 15_000,
  });

  const { data: natNetworks = [] } = useQuery<LibvirtNetwork[]>({
    queryKey: ["network", "nat"],
    queryFn: () => apiGet<LibvirtNetwork[]>("/api/network/nat"),
    refetchInterval: 15_000,
  });

  const { data: interfaces = [] } = useQuery<NetworkInterface[]>({
    queryKey: ["network", "interfaces"],
    queryFn: () => apiGet<NetworkInterface[]>("/api/network/interfaces"),
    refetchInterval: 30_000,
  });

  const { data: dockerNetworks = [] } = useQuery<DockerNetwork[]>({
    queryKey: ["docker", "networks"],
    queryFn: () => apiGet<DockerNetwork[]>("/api/docker/networks"),
    refetchInterval: 15_000,
  });

  const deleteBridge = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/network/bridges/${name}`),
    onSuccess: () => {
      setDeleteBridgeTarget(null);
      qc.invalidateQueries({ queryKey: ["network"] });
    },
  });

  const deleteNat = useMutation({
    mutationFn: (name: string) => apiDelete(`/api/network/nat/${name}`),
    onSuccess: () => {
      setDeleteNatTarget(null);
      qc.invalidateQueries({ queryKey: ["network"] });
    },
  });

  const deleteDockerNetwork = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/docker/networks/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setDeleteDockerNetworkTarget(null);
      qc.invalidateQueries({ queryKey: ["docker", "networks"] });
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold text-text-100">Network</h1>
      <ScopeNotice title={t("scope.localNodeTitle")} tone="warning">
        {t("scope.networkNodeDesc")}
      </ScopeNotice>

      {/* Host Interfaces */}
      <section>
        <h2 className="text-sm font-semibold text-text-300 mb-3">Host Interfaces</h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">Interface</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">Type</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">IP Addresses</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">MAC</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {interfaces.map((iface) => (
                <tr key={iface.name} className="border-b border-surface-700">
                  <td className="px-4 py-2 font-mono text-text-200 font-medium">{iface.name}</td>
                  <td className="px-4 py-2 text-text-400 text-xs">{iface.type || "—"}</td>
                  <td className="px-4 py-2 font-mono text-text-300 text-xs">
                    {iface.addresses?.length ? iface.addresses.join(", ") : "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-text-400 text-xs">{iface.macAddress || "—"}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs ${iface.state === "UP" ? "text-green-400" : "text-red-400"}`}>
                      {iface.state || "—"}
                    </span>
                  </td>
                </tr>
              ))}
              {interfaces.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-4 text-center text-text-500">No interfaces detected</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Network Bridges */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">Network Bridges ({bridges.length})</h2>
          <button onClick={() => setCreateBridgeOpen(true)} className="btn-primary text-sm">
            + Create Bridge
          </button>
        </div>
        {bridges.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">No bridges configured</div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-600">
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Bridge</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Uplink</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Host IP</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">IP</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Gateway</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Members</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">STP</th>
                  <th className="px-4 py-2 text-right text-text-400 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bridges.map((b) => (
                  <tr key={b.name} className="border-b border-surface-700">
                    <td className="px-4 py-2 font-mono text-text-200 font-medium">{b.name}</td>
                    <td className="px-4 py-2 font-mono text-text-300 text-xs">{b.uplinkInterface || "—"}</td>
                    <td className="px-4 py-2 text-text-300 text-xs">
                      {b.hostIpMode || "—"}
                      {b.persistent ? <span className="ml-2 text-emerald-400">persistent</span> : null}
                    </td>
                    <td className="px-4 py-2 font-mono text-text-300 text-xs">{b.ipAddress || "—"}</td>
                    <td className="px-4 py-2 font-mono text-text-300 text-xs">{b.gateway || "—"}</td>
                    <td className="px-4 py-2 text-text-400 text-xs">
                      {b.interfaces?.length ? b.interfaces.join(", ") : "none"}
                    </td>
                    <td className="px-4 py-2 text-text-400">{b.stpEnabled ? "on" : "off"}</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end">
                        <button
                          onClick={() => setDeleteBridgeTarget(b.name)}
                          className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                          title={t("modal.delete")}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Virtual Networks */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">Virtual Networks ({natNetworks.length})</h2>
          <button onClick={() => setCreateNatOpen(true)} className="btn-primary text-sm">
            + Create Virtual Network
          </button>
        </div>
        {natNetworks.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">No virtual networks configured</div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-600">
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Name</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Mode</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Subnet</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">Bridge</th>
                  <th className="px-4 py-2 text-left text-text-400 font-medium">State</th>
                  <th className="px-4 py-2 text-right text-text-400 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {natNetworks.map((net) => (
                  <tr key={net.name} className="border-b border-surface-700">
                    <td className="px-4 py-2 text-text-200 font-medium">{net.name}</td>
                    <td className="px-4 py-2 text-text-300">{net.mode ?? "isolated"}</td>
                    <td className="px-4 py-2 font-mono text-text-300 text-xs">{net.subnet || "—"}</td>
                    <td className="px-4 py-2 font-mono text-text-400 text-xs">{net.bridge || "—"}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs ${net.active ? "text-green-400" : "text-text-400"}`}>
                        {net.active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end">
                        <button
                          onClick={() => setDeleteNatTarget(net.name)}
                          className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                          title={t("modal.delete")}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-300">{t("network.dockerNetworks")} ({dockerNetworks.length})</h2>
          <button onClick={() => setCreateDockerNetworkOpen(true)} className="btn-primary text-sm">
            + {t("network.createDockerNetwork")}
          </button>
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("common.name")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("network.driver")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("network.parent")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("network.subnet")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("network.gateway")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("docker.containers")}</th>
                <th className="px-4 py-2 text-right text-text-400 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {dockerNetworks.map((network) => (
                <tr key={network.id} className="border-b border-surface-700">
                  <td className="px-4 py-2 text-text-200 font-medium">{network.name}</td>
                  <td className="px-4 py-2 text-text-300">{network.driver}</td>
                  <td className="px-4 py-2 font-mono text-text-400 text-xs">{network.parent || "—"}</td>
                  <td className="px-4 py-2 font-mono text-text-400 text-xs">{network.subnet || "—"}</td>
                  <td className="px-4 py-2 font-mono text-text-400 text-xs">{network.gateway || "—"}</td>
                  <td className="px-4 py-2 text-text-400 text-xs">{network.containers?.join(", ") || "—"}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end">
                      {!["bridge", "host", "none"].includes(network.name) && (
                        <button
                          onClick={() => setDeleteDockerNetworkTarget(network)}
                          className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                          title={t("action.delete")}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {dockerNetworks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-4 text-center text-text-500">{t("network.noDockerNetworks")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <CreateBridgeModal
        open={createBridgeOpen}
        onClose={() => setCreateBridgeOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["network"] })}
        interfaces={interfaces}
      />
      <CreateNatModal
        open={createNatOpen}
        onClose={() => setCreateNatOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["network"] })}
      />
      <CreateDockerNetworkModal
        open={createDockerNetworkOpen}
        onClose={() => setCreateDockerNetworkOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["docker", "networks"] })}
        interfaces={interfaces}
        bridges={bridges}
      />
      <ConfirmModal
        open={!!deleteBridgeTarget}
        title={t("modal.deleteBridge")}
        message={`Delete bridge "${deleteBridgeTarget}"? VMs using this bridge may lose connectivity.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteBridgeTarget && deleteBridge.mutate(deleteBridgeTarget)}
        onCancel={() => setDeleteBridgeTarget(null)}
        loading={deleteBridge.isPending}
      />
      <ConfirmModal
        open={!!deleteNatTarget}
        title={t("modal.deleteNatNetwork")}
        message={`Delete NAT network "${deleteNatTarget}"? VMs using this network will lose connectivity.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteNatTarget && deleteNat.mutate(deleteNatTarget)}
        onCancel={() => setDeleteNatTarget(null)}
        loading={deleteNat.isPending}
      />
      <ConfirmModal
        open={!!deleteDockerNetworkTarget}
        title={t("network.deleteDockerNetwork")}
        message={t("network.deleteDockerNetworkMessage", { name: deleteDockerNetworkTarget?.name ?? "" })}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteDockerNetworkTarget && deleteDockerNetwork.mutate(deleteDockerNetworkTarget.id)}
        onCancel={() => setDeleteDockerNetworkTarget(null)}
        loading={deleteDockerNetwork.isPending}
      />
    </div>
  );
}
