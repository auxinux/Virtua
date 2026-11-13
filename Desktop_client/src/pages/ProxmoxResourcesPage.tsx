import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Container, Monitor, Play, Plus, Power, RotateCcw, Search, Settings2, Square, TerminalSquare } from "lucide-react";
import { proxmoxClient } from "@/api/proxmoxClient";
import { StatusBadge } from "@/components/StatusBadge";
import { useLanguage } from "@/i18n";
import type { PowerAction, VirtuaResource } from "@/types";

type Kind = "all" | "vm" | "lxc";

function useTr() {
  const { language } = useLanguage();
  return (fr: string, en: string) => (language === "fr" ? fr : en);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** VMs and containers of the Proxmox server, with power actions and creation. */
export function ProxmoxResourcesPage({ kind, resources, onChanged }: { kind: Kind; resources: VirtuaResource[]; onChanged: () => void | Promise<void> }) {
  const tr = useTr();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"vm" | "lxc" | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return resources
      .filter((r) => r.source === "proxmox" && (kind === "all" || r.kind === kind))
      .filter((r) => !q || r.displayName.toLowerCase().includes(q) || r.node.toLowerCase().includes(q) || (r.proxmox?.tags ?? "").toLowerCase().includes(q));
  }, [resources, kind, query]);

  const act = async (resource: VirtuaResource, action: PowerAction) => {
    setBusy(`${resource.id}:${action}`);
    setError(null);
    try {
      await proxmoxClient.runAction(resource.id, action);
      await onChanged();
    } catch (e) {
      setError(`${resource.displayName} : ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const title = kind === "vm" ? tr("Machines virtuelles", "Virtual machines") : kind === "lxc" ? tr("Conteneurs LXC", "LXC containers") : tr("Inventaire", "Inventory");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-xs text-virtua-muted">Proxmox VE · {rows.length} {tr("élément(s)", "item(s)")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 items-center gap-2 rounded border border-virtua-border bg-virtua-shade/20 px-2.5">
            <Search className="h-3.5 w-3.5 text-virtua-muted" />
            <input className="w-44 bg-transparent text-xs outline-none placeholder:text-virtua-muted" placeholder={tr("Rechercher…", "Search…")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {kind !== "lxc" ? (
            <button className="virtua-button-primary" onClick={() => setCreating("vm")}>
              <Plus className="mr-1.5 h-4 w-4" /> {tr("Créer une VM", "Create VM")}
            </button>
          ) : null}
          {kind !== "vm" ? (
            <button className="virtua-button-primary" onClick={() => setCreating("lxc")}>
              <Plus className="mr-1.5 h-4 w-4" /> {tr("Créer un conteneur", "Create container")}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="rounded border border-virtua-red/50 bg-virtua-red/10 p-2 text-xs text-virtua-red" role="alert">{error}</p> : null}

      <div className="overflow-x-auto rounded border border-virtua-border bg-virtua-panel">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-virtua-border text-xs uppercase text-virtua-muted">
            <tr>
              <th className="px-3 py-2">{tr("Nom", "Name")}</th>
              <th className="px-3 py-2">{tr("Nœud", "Node")}</th>
              <th className="px-3 py-2">{tr("État", "State")}</th>
              <th className="px-3 py-2">CPU</th>
              <th className="px-3 py-2">RAM</th>
              <th className="px-3 py-2">{tr("Durée", "Uptime")}</th>
              <th className="px-3 py-2 text-right">{tr("Actions", "Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const Icon = r.kind === "lxc" ? Container : Monitor;
              const running = r.state.startsWith("running");
              const iconButton = (action: PowerAction, label: string, I: typeof Play, enabled: boolean) => (
                <button
                  key={action}
                  className="virtua-icon-button !h-8 !w-8"
                  title={label}
                  aria-label={`${label} ${r.name}`}
                  disabled={!enabled || busy !== null}
                  onClick={() => void act(r, action)}
                >
                  <I className="h-4 w-4" />
                </button>
              );
              return (
                <tr key={r.id} className="border-b border-virtua-border/60 last:border-0 hover:bg-virtua-panelHover/50">
                  <td className="px-3 py-2">
                    <Link to={`/resources/${r.id}`} className="flex items-center gap-2 hover:text-virtua-accent">
                      <Icon className="h-4 w-4 text-virtua-muted" />
                      <span className="font-medium">{r.displayName}</span>
                      {r.proxmox?.template ? <span className="rounded border border-virtua-border px-1.5 text-[10px] uppercase text-virtua-muted">template</span> : null}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-virtua-muted">{r.node}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.state.split(" ")[0]} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{running ? `${r.cpu ?? 0}%` : "—"} <span className="text-virtua-muted">/ {r.cpuCores ?? "?"} vCPU</span></td>
                  <td className="px-3 py-2 font-mono text-xs">{running ? `${r.memory ?? 0}%` : "—"} <span className="text-virtua-muted">/ {r.memoryMib ?? "?"} Mio</span></td>
                  <td className="px-3 py-2 text-xs text-virtua-muted">{r.uptime ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {iconButton("start", tr("Démarrer", "Start"), Play, !running && !r.proxmox?.template)}
                      {iconButton("shutdown", tr("Éteindre", "Shut down"), Power, running)}
                      {iconButton("restart", tr("Redémarrer", "Reboot"), RotateCcw, running)}
                      {iconButton("stop", tr("Arrêt forcé", "Force stop"), Square, running)}
                      <Link to={`/console/${r.id}`} className="virtua-icon-button !h-8 !w-8" title="Console" aria-label={`Console ${r.name}`}>
                        <TerminalSquare className="h-4 w-4" />
                      </Link>
                      <Link to={`/resources/${r.id}`} className="virtua-icon-button !h-8 !w-8" title={tr("Configuration", "Settings")} aria-label={`${tr("Configuration", "Settings")} ${r.name}`}>
                        <Settings2 className="h-4 w-4" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-virtua-muted">{tr("Aucune machine.", "No machine.")}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {creating ? <ProxmoxCreateDialog kind={creating} onClose={() => setCreating(null)} onCreated={async () => { setCreating(null); await onChanged(); }} /> : null}
    </div>
  );
}

const OS_TYPES = [
  { value: "l26", label: "Linux 6.x / 2.6+" },
  { value: "win11", label: "Windows 11 / 2022 / 2025" },
  { value: "win10", label: "Windows 10 / 2016 / 2019" },
  { value: "other", label: "Autre / Other" },
];

/** Create a VM (qemu) or a container (lxc) on a node of the server. */
export function ProxmoxCreateDialog({ kind, onClose, onCreated }: { kind: "vm" | "lxc"; onClose: () => void; onCreated: () => void | Promise<void> }) {
  const tr = useTr();
  const nodes = proxmoxClient.nodes();
  const [node, setNode] = useState(nodes[0] ?? "");
  const [vmid, setVmid] = useState<number | "">("");
  const [name, setName] = useState("");
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(kind === "vm" ? 2048 : 1024);
  const [diskGb, setDiskGb] = useState(kind === "vm" ? 32 : 8);
  const [diskStorages, setDiskStorages] = useState<Array<{ storage: string; availGib?: number }>>([]);
  const [diskStorage, setDiskStorage] = useState("");
  const [media, setMedia] = useState<Array<{ volid: string; label: string }>>([]);
  const [medium, setMedium] = useState("");
  const [bridges, setBridges] = useState<string[]>([]);
  const [bridge, setBridge] = useState("");
  const [ostype, setOstype] = useState("l26");
  const [password, setPassword] = useState("");
  const [unprivileged, setUnprivileged] = useState(true);
  const [startAfter, setStartAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void proxmoxClient.nextId().then(setVmid).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!node) return;
    let stale = false;
    setError(null);
    const mediaContent = kind === "vm" ? "iso" : "vztmpl";
    void (async () => {
      try {
        const [disks, mediaStores, nets] = await Promise.all([
          proxmoxClient.storages(node, kind === "vm" ? "images" : "rootdir"),
          proxmoxClient.storages(node, mediaContent),
          proxmoxClient.bridges(node),
        ]);
        const items = (await Promise.all(mediaStores.map((s) => proxmoxClient.content(node, s.storage, mediaContent).catch(() => [])))).flat();
        if (stale) return;
        setDiskStorages(disks);
        setDiskStorage((cur) => (disks.some((d) => d.storage === cur) ? cur : disks[0]?.storage ?? ""));
        setMedia(items);
        setMedium((cur) => (items.some((m) => m.volid === cur) ? cur : kind === "vm" ? "" : items[0]?.volid ?? ""));
        setBridges(nets);
        setBridge((cur) => (nets.includes(cur) ? cur : nets.includes("vmbr0") ? "vmbr0" : nets[0] ?? ""));
      } catch (e) {
        if (!stale) setError(errorText(e));
      }
    })();
    return () => { stale = true; };
  }, [node, kind]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const net = bridge ? `virtio,bridge=${bridge}` : undefined;
      if (kind === "vm") {
        const windows = ostype.startsWith("win");
        await proxmoxClient.createVm(node, {
          vmid, name: name.trim() || undefined, cores, memory, ostype,
          machine: "q35", bios: "ovmf", cpu: "host", agent: "enabled=1", scsihw: "virtio-scsi-single",
          efidisk0: `${diskStorage}:1,efitype=4m,pre-enrolled-keys=${windows ? 1 : 0}`,
          ...(windows ? { tpmstate0: `${diskStorage}:1,version=v2.0` } : {}),
          scsi0: `${diskStorage}:${diskGb},iothread=1,discard=on`,
          ide2: medium ? `${medium},media=cdrom` : "none,media=cdrom",
          boot: medium ? "order=scsi0;ide2" : "order=scsi0",
          net0: net,
          start: startAfter,
        });
      } else {
        await proxmoxClient.createContainer(node, {
          vmid, hostname: name.trim() || undefined, ostemplate: medium, cores, memory, swap: 512,
          rootfs: `${diskStorage}:${diskGb}`,
          net0: bridge ? `name=eth0,bridge=${bridge},ip=dhcp,ip6=auto` : undefined,
          password: password || undefined,
          unprivileged, features: unprivileged ? "nesting=1" : undefined,
          start: startAfter,
        });
      }
      await onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = node && vmid && diskStorage && (kind === "vm" || (medium && password.length >= 5));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="max-h-full w-full max-w-xl overflow-auto rounded border border-virtua-border bg-virtua-panel p-5 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">{kind === "vm" ? tr("Nouvelle VM Proxmox", "New Proxmox VM") : tr("Nouveau conteneur Proxmox", "New Proxmox container")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">{tr("Nœud", "Node")}</span>
            <select className="virtua-input" value={node} onChange={(e) => setNode(e.target.value)}>{nodes.map((n) => <option key={n}>{n}</option>)}</select>
          </label>
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">VMID</span>
            <input className="virtua-input" type="number" min={100} value={vmid} onChange={(e) => setVmid(e.target.value ? Number(e.target.value) : "")} />
          </label>
          <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{kind === "vm" ? tr("Nom", "Name") : tr("Nom d'hôte", "Hostname")}</span>
            <input className="virtua-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "vm" ? "web-01" : "ct-01"} />
          </label>
          <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{kind === "vm" ? tr("ISO d'installation", "Install ISO") : tr("Modèle (template)", "Template")}</span>
            <select className="virtua-input" value={medium} onChange={(e) => setMedium(e.target.value)}>
              {kind === "vm" ? <option value="">{tr("Aucun", "None")}</option> : null}
              {media.map((m) => <option key={m.volid} value={m.volid}>{m.label}</option>)}
            </select>
            {kind === "lxc" && media.length === 0 ? <span className="text-[11px] text-virtua-muted">{tr("Aucun modèle : téléchargez-en un dans Proxmox (stockage → CT Templates → Templates).", "No template: download one in Proxmox (storage → CT Templates → Templates).")}</span> : null}
          </label>
          {kind === "vm" ? (
            <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{tr("Système invité", "Guest OS")}</span>
              <select className="virtua-input" value={ostype} onChange={(e) => setOstype(e.target.value)}>{OS_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </label>
          ) : null}
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">vCPU</span>
            <input className="virtua-input" type="number" min={1} max={128} value={cores} onChange={(e) => setCores(Number(e.target.value))} />
          </label>
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">{tr("Mémoire (Mio)", "Memory (MiB)")}</span>
            <input className="virtua-input" type="number" min={64} step={64} value={memory} onChange={(e) => setMemory(Number(e.target.value))} />
          </label>
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">{tr("Stockage du disque", "Disk storage")}</span>
            <select className="virtua-input" value={diskStorage} onChange={(e) => setDiskStorage(e.target.value)}>
              {diskStorages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}{s.availGib !== undefined ? ` (${s.availGib} Gio ${tr("libres", "free")})` : ""}</option>)}
            </select>
          </label>
          <label className="grid gap-1"><span className="text-xs text-virtua-muted">{tr("Disque (Gio)", "Disk (GiB)")}</span>
            <input className="virtua-input" type="number" min={1} value={diskGb} onChange={(e) => setDiskGb(Number(e.target.value))} />
          </label>
          <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{tr("Pont réseau", "Network bridge")}</span>
            <select className="virtua-input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
              <option value="">{tr("Sans réseau", "No network")}</option>
              {bridges.map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
          {kind === "lxc" ? (
            <>
              <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{tr("Mot de passe root (5 caractères min.)", "Root password (5+ characters)")}</span>
                <input className="virtua-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input type="checkbox" checked={unprivileged} onChange={(e) => setUnprivileged(e.target.checked)} />
                {tr("Conteneur non privilégié (recommandé)", "Unprivileged container (recommended)")}
              </label>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" checked={startAfter} onChange={(e) => setStartAfter(e.target.checked)} />
            {tr("Démarrer après la création", "Start after creation")}
          </label>
        </div>
        {error ? <p className="mt-3 rounded border border-virtua-red/50 bg-virtua-red/10 p-2 text-xs text-virtua-red" role="alert">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="virtua-button" onClick={onClose} disabled={busy}>{tr("Annuler", "Cancel")}</button>
          <button type="submit" className="virtua-button-primary" disabled={busy || !canSubmit}>{busy ? tr("Création…", "Creating…") : tr("Créer", "Create")}</button>
        </div>
      </form>
    </div>
  );
}
