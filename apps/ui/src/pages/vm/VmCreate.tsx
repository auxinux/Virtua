import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../../api/client";
import type { StoragePool, IsoFile, TemplateSummary } from "@auxinux/shared";

interface CreateVmPayload {
  name: string;
  vcpus: number;
  memoryMb: number;
  diskGb?: number;
  existingPath?: string;
  diskBus: string;
  storagePool?: string;
  os: string;
  isoFile?: string;
  bridge: string;
  mac?: string;
  arch: "x86_64" | "aarch64";
  machine: string;
  uefi: boolean;
  secureBoot: boolean;
  bootDevice: "hd" | "cdrom" | "network";
  tpmEnabled: boolean;
  qemuAgentEnabled: boolean;
  videoModel: "vga" | "virtio" | "qxl";
  autostart: boolean;
}

const OS_TYPES = [
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" },
  { value: "freebsd", label: "FreeBSD" },
  { value: "other", label: "Other" },
];

const DISK_BUS_DEFAULTS: Record<string, string> = {
  linux: "virtio",
  windows: "sata",
  freebsd: "virtio",
  other: "virtio",
};

const VIDEO_MODEL_DEFAULTS: Record<string, "vga" | "virtio" | "qxl"> = {
  linux: "virtio",
  // QXL: the only Windows display driver whose resolution the SPICE agent can
  // drive dynamically (auto-resize); the Windows virtio-gpu driver cannot.
  windows: "qxl",
  freebsd: "virtio",
  other: "virtio",
};

const ARCH_OPTIONS = [
  { value: "x86_64", label: "x86_64" },
  { value: "aarch64", label: "ARM64 / aarch64" },
];

const MACHINE_OPTIONS: Record<"x86_64" | "aarch64", string[]> = {
  x86_64: ["q35", "pc"],
  aarch64: ["virt"],
};

export default function VmCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const targetNode = searchParams.get("node");

  const [form, setForm] = useState<CreateVmPayload>({
    name: "",
    vcpus: 2,
    memoryMb: 2048,
    diskGb: 20,
    existingPath: "",
    diskBus: "virtio",
    storagePool: "",
    os: "linux",
    isoFile: "",
    bridge: "virbr0", // overridden once bridge list loads
    mac: "",
    arch: "x86_64",
    machine: "q35",
    uefi: false,
    secureBoot: false,
    bootDevice: "hd",
    tpmEnabled: false,
    qemuAgentEnabled: true,
    videoModel: "virtio",
    autostart: false,
  });
  const [noDisk, setNoDisk] = useState(false);
  const [useExistingDisk, setUseExistingDisk] = useState(false);
  const [error, setError] = useState("");
  // When a VM template is selected, creation switches to /api/resources (disk
  // import) instead of the classic /api/vms flow. Templates live on the node, so
  // we only offer them for the local node (no ?node= target).
  const [templateId, setTemplateId] = useState("");

  const { data: templates = [] } = useQuery<TemplateSummary[]>({
    queryKey: ["templates", "vm", "usable"],
    queryFn: () => apiGet<TemplateSummary[]>("/api/templates?type=vm"),
    staleTime: 30_000,
  });

  // Downloaded ISO templates (depot imports) — selectable as boot media.
  const { data: isoTemplates = [] } = useQuery<TemplateSummary[]>({
    queryKey: ["templates", "iso", "usable"],
    queryFn: () => apiGet<TemplateSummary[]>("/api/templates?type=iso"),
    staleTime: 30_000,
  });

  const { data: pools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools", targetNode || "local"],
    queryFn: () => apiGet<StoragePool[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/storage/pools` : "/api/storage/pools"),
  });

  const { data: isos = [] } = useQuery<IsoFile[]>({
    queryKey: ["storage", "isos", targetNode || "local"],
    queryFn: () => apiGet<IsoFile[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/storage/isos` : "/api/storage/isos"),
  });

  const { data: bridges = [] } = useQuery<string[]>({
    queryKey: ["network", "bridges-list", targetNode || "local"],
    queryFn: async () => {
      const res = await apiGet<{ name: string }[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/network/bridges` : "/api/network/bridges");
      return res.map((b) => b.name);
    },
  });

  // Auto-select best bridge once list loads: prefer virbr0/br0, else first
  useEffect(() => {
    if (bridges.length === 0) return;
    setForm((f) => {
      if (bridges.includes(f.bridge)) return f;
      const best = ["virbr0", "br0"].find((b) => bridges.includes(b)) ?? bridges[0];
      return { ...f, bridge: best };
    });
  }, [bridges]);

  const create = useMutation({
    mutationFn: (payload: CreateVmPayload) => apiPost(`/api/vms${targetNode ? `?node=${encodeURIComponent(targetNode)}` : ""}`, payload),
    onSuccess: () => navigate("/vms"),
    onError: (err: Error) => setError(err.message),
  });

  // Template-based creation (VM template → disk import via /api/resources).
  const createFromTemplate = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiPost("/api/resources", payload),
    onSuccess: () => navigate("/vms"),
    onError: (err: Error) => setError(err.message),
  });

  const selectedTemplate = templates.find((tpl) => tpl.id === templateId);

  // Picking a template pre-fills CPU/RAM/disk/arch (still editable below).
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((entry) => entry.id === id);
    if (!tpl) return;
    setUseExistingDisk(false);
    setNoDisk(false);
    setForm((current) => ({
      ...current,
      vcpus: tpl.cpu ?? current.vcpus,
      memoryMb: tpl.memory ?? current.memoryMb,
      diskGb: tpl.diskGb ?? current.diskGb,
      existingPath: "",
      arch: tpl.architecture === "arm64" ? "aarch64" : "x86_64",
      machine: tpl.architecture === "arm64" ? "virt" : current.machine,
      isoFile: "",
    }));
  };

  const set = (field: keyof CreateVmPayload, value: unknown) =>
    setForm((f) => ({ ...f, [field]: value }));

  const setOs = (os: string) => {
    setForm((current) => ({
      ...current,
      os,
      videoModel: VIDEO_MODEL_DEFAULTS[os] ?? current.videoModel,
      // Windows installers don't ship virtio-blk drivers; Linux uses virtio natively.
      diskBus: DISK_BUS_DEFAULTS[os] ?? current.diskBus,
      // Windows 11 refuses to install without UEFI + Secure Boot + TPM 2.0.
      ...(os === "windows" ? { uefi: true, secureBoot: true, tpmEnabled: true } : {}),
    }));
  };

  const setUefi = (uefi: boolean) =>
    setForm((current) => ({ ...current, uefi, ...(uefi ? {} : { secureBoot: false }) }));

  const setSecureBoot = (secureBoot: boolean) =>
    setForm((current) => ({ ...current, secureBoot, ...(secureBoot ? { uefi: true } : {}) }));

  const setArch = (arch: "x86_64" | "aarch64") => {
    setForm((current) => ({
      ...current,
      arch,
      machine: MACHINE_OPTIONS[arch][0],
      uefi: arch === "aarch64" ? true : current.uefi,
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!form.name.match(/^[a-zA-Z0-9_-]{1,64}$/)) {
      setError(t("vm.nameInvalid"));
      return;
    }
    if (form.mac && !form.mac.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)) {
      setError(t("vm.macInvalid"));
      return;
    }
    if (useExistingDisk) {
      const existingPath = (form.existingPath ?? "").trim();
      if (!existingPath) {
        setError(t("vm.existingDiskRequired", "Existing disk path is required"));
        return;
      }
    } else if (!noDisk) {
      if (!form.storagePool) { setError(t("vm.storagePoolRequired")); return; }
      if (!form.diskGb) { setError(t("vm.diskRequired", "Disk size is required")); return; }
    }
    if (selectedTemplate) {
      createFromTemplate.mutate({
        type: "vm",
        name: form.name,
        templateId: selectedTemplate.id,
        cpu: form.vcpus,
        memory: form.memoryMb,
        disk: noDisk ? undefined : form.diskGb,
        architecture: form.arch === "aarch64" ? "arm64" : "amd64",
        storagePool: form.storagePool,
        network: form.bridge,
        gpuModel: form.videoModel,
      });
      return;
    }
    create.mutate({
      ...form,
      mac: form.mac || undefined,
      diskGb: noDisk || useExistingDisk ? undefined : form.diskGb,
      existingPath: useExistingDisk ? (form.existingPath ?? "").trim() : undefined,
      storagePool: noDisk || useExistingDisk ? undefined : form.storagePool,
    });
  };

  const submitting = create.isPending || createFromTemplate.isPending;

  const vmPools = pools.filter((p) => p.content.includes("vm") || p.content.includes("disk"));

  // ISO media: server ISOs + downloaded ISO templates (the latter arch-filtered).
  const archMatches = (tplArch: "amd64" | "arm64") =>
    (form.arch === "aarch64" ? "arm64" : "amd64") === tplArch;
  const templateIsoNames = new Set(isoTemplates.map((it) => it.filename));
  const serverIsos = isos.filter((i) => i.type === "iso" && !templateIsoNames.has(i.filename));
  const archIsoTemplates = isoTemplates.filter((it) => archMatches(it.architecture));

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/vms")}
          className="text-text-400 hover:text-text-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("vm.createVm")}</h1>
          {targetNode && <p className="text-xs text-text-500 mt-1">{t("datacenter.node")}: {targetNode}</p>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Template source — always shown; creation via /api/resources is always local */}
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("templates.source", "Source")}</h2>
          <div>
            <label className="label">{t("templates.vmTab", "Template VM")}</label>
            <select className="input" value={templateId} onChange={(e) => applyTemplate(e.target.value)} disabled={templates.length === 0}>
              <option value="">{t("templates.fromScratch", "Disque vierge / installation par ISO")}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} · {tpl.architecture}{tpl.cpu ? ` · ${tpl.cpu} vCPU` : ""}{tpl.memory ? ` · ${tpl.memory} MB` : ""}
                </option>
              ))}
            </select>
            {templates.length === 0 ? (
              <p className="text-xs text-text-500 mt-1">
                {t("templates.empty", "Aucun template VM disponible.")}
                {" "}<a href="/templates" className="text-accent-blue hover:underline">{t("templates.importHint", "Importez-en un depuis Templates → Catalogue dépôt")}</a>
                {", "}{t("templates.orIso", "ou installez via une ISO ci-dessous.")}
              </p>
            ) : selectedTemplate ? (
              <p className="text-xs text-text-500 mt-1">
                {selectedTemplate.description || t("templates.willImport", "Le disque du template sera importé. CPU/RAM/réseau ci-dessous restent modifiables.")}
              </p>
            ) : (
              <p className="text-xs text-text-500 mt-1">{t("templates.pickHint", "Choisissez un template pour déployer une VM prête à l'emploi, ou laissez vide pour installer depuis une ISO.")}</p>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("common.details")}</h2>

          <div>
            <label className="label">{t("vm.name")} *</label>
            <input
              className="input"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. vm-debian12"
              required
            />
            <p className="text-xs text-text-500 mt-1">{t("vm.nameHelp")}</p>
          </div>

          <div>
            <label className="label">{t("vm.osType")}</label>
            <select className="input" value={form.os} onChange={(e) => setOs(e.target.value)}>
              {OS_TYPES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("vm.resources")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("vm.vcpus")}</label>
              <input
                type="number"
                className="input"
                min={1}
                max={128}
                value={form.vcpus}
                onChange={(e) => set("vcpus", parseInt(e.target.value, 10))}
              />
            </div>
            <div>
              <label className="label">{t("res.memory")} (MiB)</label>
              <input
                type="number"
                className="input"
                min={256}
                step={256}
                value={form.memoryMb}
                onChange={(e) => set("memoryMb", parseInt(e.target.value, 10))}
              />
              <p className="text-xs text-text-500 mt-1">{(form.memoryMb / 1024).toFixed(1)} GiB</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 rounded accent-accent-blue"
                checked={noDisk}
                onChange={(e) => {
                  setNoDisk(e.target.checked);
                  if (e.target.checked) setUseExistingDisk(false);
                }}
              />
              <span className="text-sm text-text-300">{t("vm.noDisk", "Aucun disque (VM diskless)")}</span>
            </label>

            {!noDisk && !selectedTemplate && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded accent-accent-blue"
                  checked={useExistingDisk}
                  onChange={(e) => {
                    setUseExistingDisk(e.target.checked);
                    if (e.target.checked) setNoDisk(false);
                  }}
                />
                <span className="text-sm text-text-300">{t("vm.useExistingDisk", "Utiliser un disque existant")}</span>
              </label>
            )}

            {!noDisk && !useExistingDisk && (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="label">{t("vm.diskSize")} (GB)</label>
                  <input
                    type="number"
                    className="input"
                    min={1}
                    max={10000}
                    value={form.diskGb ?? 20}
                    onChange={(e) => set("diskGb", parseInt(e.target.value, 10))}
                  />
                </div>
                <div>
                  <label className="label">{t("vm.diskBus", "Type de bus disque")}</label>
                  <select className="input" value={form.diskBus} onChange={(e) => set("diskBus", e.target.value)}>
                    <option value="virtio">VirtIO (recommandé Linux)</option>
                    <option value="sata">SATA (Windows/FreeBSD)</option>
                    <option value="ide">IDE (anciens OS)</option>
                    <option value="scsi">SCSI</option>
                  </select>
                </div>
                <div>
                  <label className="label">{t("storage.pool")} *</label>
                  <select
                    className="input"
                    value={form.storagePool}
                    onChange={(e) => set("storagePool", e.target.value)}
                    required
                  >
                    <option value="">— {t("common.select")} —</option>
                    {vmPools.map((p) => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {!noDisk && useExistingDisk && !selectedTemplate && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">{t("vm.existingDiskPath", "Chemin du disque existant")}</label>
                  <input
                    className="input w-full"
                    placeholder="/var/lib/libvirt/images/vm-disk.qcow2"
                    value={form.existingPath}
                    onChange={(e) => set("existingPath", e.target.value)}
                  />
                  <p className="text-xs text-text-500 mt-1">{t("vm.existingDiskHelp", "Le chemin doit être accessible sur l’hôte qui héberge la VM.")}</p>
                </div>
                <div>
                  <label className="label">{t("vm.diskBus", "Type de bus disque")}</label>
                  <select className="input" value={form.diskBus} onChange={(e) => set("diskBus", e.target.value)}>
                    <option value="virtio">VirtIO (recommandé Linux)</option>
                    <option value="sata">SATA (Windows/FreeBSD)</option>
                    <option value="ide">IDE (anciens OS)</option>
                    <option value="scsi">SCSI</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("vm.bootInstallation")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Architecture</label>
              <select className="input" value={form.arch} onChange={(e) => setArch(e.target.value as "x86_64" | "aarch64")}>
                {ARCH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t("vm.machineType")}</label>
              <select className="input" value={form.machine} onChange={(e) => set("machine", e.target.value)}>
                {MACHINE_OPTIONS[form.arch].map((machine) => <option key={machine} value={machine}>{machine}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">{t("vm.bootIso")}</label>
            <select
              className="input"
              value={form.isoFile}
              onChange={(e) => {
                const iso = e.target.value;
                // Picking an ISO should boot from it; clearing it (when we had
                // auto-switched to CD-ROM) falls back to disk boot.
                setForm((f) => ({
                  ...f,
                  isoFile: iso,
                  bootDevice: iso ? "cdrom" : (f.bootDevice === "cdrom" ? "hd" : f.bootDevice),
                }));
              }}
              disabled={!!selectedTemplate}
            >
              <option value="">— {t("vm.noIsoBootDisk")} —</option>
              {archIsoTemplates.length > 0 && (
                <optgroup label={`Templates ISO (${form.arch === "aarch64" ? "ARM64" : "AMD64"})`}>
                  {archIsoTemplates.map((it) => (
                    <option key={`tpl-${it.id}`} value={it.filename}>{it.name}</option>
                  ))}
                </optgroup>
              )}
              {serverIsos.length > 0 && (
                <optgroup label="ISO du serveur">
                  {serverIsos.map((iso) => (
                    <option key={iso.filename} value={iso.filename}>{iso.displayName || iso.filename}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className="text-xs text-text-500 mt-1">Les ISO de templates sont filtrées selon l'architecture choisie ci-dessus.</p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label">{t("vm.firstBootDevice")}</label>
              <select className="input" value={form.bootDevice} onChange={(e) => set("bootDevice", e.target.value)}>
                <option value="hd">{t("vm.bootDisk")}</option>
                <option value="cdrom">{t("vm.bootCdrom")}</option>
                <option value="network">{t("vm.bootNetwork")} (PXE)</option>
              </select>
              {form.bootDevice === "network" && form.uefi && (
                <p className="mt-1.5 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded px-2 py-1.5">
                  ⚠ PXE UEFI : utilise le modèle NIC <strong>e1000</strong> (onglet Réseau). VirtIO n'a pas de ROM PXE UEFI — SCCM/WDS ne sera pas contacté.
                </p>
              )}
            </div>
            <div>
              <label className="label">{t("vm.displayModel")}</label>
              <select className="input" value={form.videoModel} onChange={(e) => set("videoModel", e.target.value)}>
                <option value="vga">VGA</option>
                <option value="virtio">VirtIO GPU</option>
                <option value="qxl">QXL</option>
              </select>
            </div>
            <div>
              <label className="label">{t("vm.firmware")}</label>
              <select className="input" value={form.uefi ? "uefi" : "bios"} onChange={(e) => setUefi(e.target.value === "uefi")} disabled={form.arch === "aarch64"}>
                <option value="bios">BIOS</option>
                <option value="uefi">UEFI</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                checked={form.uefi}
                onChange={(e) => setUefi(e.target.checked)}
                disabled={form.arch === "aarch64"}
              />
              <span className="text-sm text-text-300">{t("vm.uefiFirmware")}</span>
            </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                  checked={form.secureBoot}
                  onChange={(e) => setSecureBoot(e.target.checked)}
                  disabled={form.arch === "aarch64"}
                />
                <span className="text-sm text-text-300">{t("vm.secureBoot", "Secure Boot")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                  checked={form.tpmEnabled}
                  onChange={(e) => set("tpmEnabled", e.target.checked)}
                />
                <span className="text-sm text-text-300">{t("vm.tpm")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                  checked={form.qemuAgentEnabled}
                  onChange={(e) => set("qemuAgentEnabled", e.target.checked)}
                />
                <span className="text-sm text-text-300">{t("vm.qemuAgent")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
                checked={form.autostart}
                onChange={(e) => set("autostart", e.target.checked)}
              />
              <span className="text-sm text-text-300">{t("vm.autostart")}</span>
            </label>
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("res.network")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("vm.networkBridge")}</label>
              <select
                className="input"
                value={form.bridge}
                onChange={(e) => set("bridge", e.target.value)}
              >
                {bridges.length === 0 && <option value={form.bridge}>{form.bridge || "—"}</option>}
                {bridges.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <p className="text-xs text-text-500 mt-1">{t("vm.bridgeHelp")}</p>
            </div>
            <div>
              <label className="label">{t("vm.manualMac")}</label>
              <input
                className="input font-mono"
                value={form.mac}
                onChange={(e) => set("mac", e.target.value.toLowerCase())}
                placeholder="aa:bb:cc:dd:ee:ff"
              />
              <p className="text-xs text-text-500 mt-1">{t("vm.manualMacHelp")}</p>
            </div>
          </div>
        </div>

        <div className="card p-4 bg-surface-900/50">
          <div className="text-xs text-text-400 space-y-1">
            <div className="font-medium text-text-300 mb-2">{t("vm.summary")}</div>
            <div className="flex gap-4 flex-wrap">
              <span>{t("common.name")}: <strong className="text-text-200">{form.name || "—"}</strong></span>
              <span>OS: <strong className="text-text-200">{form.os}</strong></span>
              <span>Arch: <strong className="text-text-200">{form.arch}</strong></span>
              <span>vCPUs: <strong className="text-text-200">{form.vcpus}</strong></span>
              <span>{t("res.memory")}: <strong className="text-text-200">{(form.memoryMb / 1024).toFixed(1)} GiB</strong></span>
              {noDisk
                ? <span>{t("res.disk")}: <strong className="text-text-200">Aucun</strong></span>
                : useExistingDisk
                  ? <span>{t("res.disk")}: <strong className="text-text-200">Existant ({form.diskBus})</strong></span>
                  : <span>{t("res.disk")}: <strong className="text-text-200">{form.diskGb} GB ({form.diskBus})</strong></span>}
              {!noDisk && !useExistingDisk && <span>{t("storage.pool")}: <strong className="text-text-200">{form.storagePool || "—"}</strong></span>}
              {!noDisk && useExistingDisk && <span>{t("vm.existingDiskPath", "Disque existant")}: <strong className="text-text-200 truncate">{form.existingPath || "—"}</strong></span>}
              <span>{t("vm.networkBridge")}: <strong className="text-text-200">{form.bridge}</strong></span>
              {form.mac && <span>MAC: <strong className="text-text-200 font-mono">{form.mac}</strong></span>}
              <span>Boot: <strong className="text-text-200">{form.bootDevice}</strong></span>
              <span>Video: <strong className="text-text-200">{form.videoModel}</strong></span>
              {form.uefi && <span className="text-accent-blue">UEFI</span>}
              {form.secureBoot && <span className="text-accent-blue">Secure Boot</span>}
              {form.tpmEnabled && <span className="text-emerald-400">TPM 2.0</span>}
              {form.qemuAgentEnabled && <span className="text-cyan-400">QEMU Agent</span>}
              {form.autostart && <span className="text-green-400">Autostart</span>}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary"
          >
            {submitting ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {t("common.creating")}
              </span>
            ) : (
              t("vm.createVm")
            )}
          </button>
          <button type="button" onClick={() => navigate("/vms")} className="btn">
            {t("action.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
