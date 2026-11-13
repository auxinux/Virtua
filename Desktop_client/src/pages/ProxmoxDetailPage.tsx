import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Camera, HardDrive, RotateCcw, Save, TerminalSquare, Trash2 } from "lucide-react";
import { proxmoxClient } from "@/api/proxmoxClient";
import { StatusBadge } from "@/components/StatusBadge";
import { MetricBar } from "@/components/MetricBar";
import { useLanguage } from "@/i18n";
import type { VirtuaResource } from "@/types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Disk keys of a config (scsi0, virtio1, rootfs, mp0…) with their size. */
export function configDisks(config: Record<string, unknown>) {
  return Object.entries(config)
    .filter(([key, value]) => /^(scsi|virtio|sata|ide)\d+$|^rootfs$|^mp\d+$/.test(key) && typeof value === "string" && !value.includes("media=cdrom"))
    .map(([key, value]) => ({ key, value: String(value), size: /size=([0-9.]+[KMGT]?)/.exec(String(value))?.[1] ?? "?" }));
}

type Snapshot = { id: string; name: string; description: string; createdAt: string; parent?: string };

export function ProxmoxDetailPage({ resources, onChanged }: { resources: VirtuaResource[]; onChanged: () => void | Promise<void> }) {
  const { resourceId = "" } = useParams();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const tr = (fr: string, en: string) => (language === "fr" ? fr : en);
  const resource = resources.find((r) => r.id === resourceId);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [name, setName] = useState("");
  const [cores, setCores] = useState(1);
  const [memory, setMemory] = useState(512);
  const [onboot, setOnboot] = useState(false);
  const [description, setDescription] = useState("");
  const [grow, setGrow] = useState<Record<string, number>>({});
  const [snapName, setSnapName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const isLxc = resource?.kind === "lxc";

  const load = useCallback(async () => {
    if (!resource) return;
    try {
      const [cfg, snaps] = await Promise.all([proxmoxClient.config(resource.id), proxmoxClient.listSnapshots(resource.id).catch(() => [])]);
      setConfig(cfg);
      setSnapshots(snaps);
      setName(String((resource.kind === "lxc" ? cfg.hostname : cfg.name) ?? ""));
      setCores(Number(cfg.cores ?? 1));
      setMemory(Number(cfg.memory ?? 512));
      setOnboot(Number(cfg.onboot ?? 0) === 1);
      setDescription(String(cfg.description ?? ""));
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
    // The resource object changes on every poll; its id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.id]);

  useEffect(() => { void load(); }, [load]);

  if (!resource) {
    return <div className="rounded border border-virtua-border bg-virtua-panel p-6 text-sm text-virtua-muted">{tr("Machine introuvable.", "Machine not found.")} <Link className="text-virtua-accent" to="/vms">{tr("Retour", "Back")}</Link></div>;
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: label });
      await load();
      await onChanged();
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(tr("Configuration enregistrée.", "Settings saved."), () => proxmoxClient.updateConfig(resource.id, {
    [isLxc ? "hostname" : "name"]: name.trim() || undefined,
    cores,
    memory,
    onboot,
    description,
  }));

  const running = resource.state.startsWith("running");
  const disks = config ? configDisks(config) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button className="virtua-icon-button" onClick={() => navigate(isLxc ? "/lxc" : "/vms")} title={tr("Retour", "Back")}><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <h1 className="text-lg font-semibold">{resource.displayName}</h1>
            <p className="text-xs text-virtua-muted">{isLxc ? "LXC" : "VM"} · {resource.node} · Proxmox VE</p>
          </div>
          <StatusBadge status={resource.state.split(" ")[0]} />
        </div>
        <Link to={`/console/${resource.id}`} className="virtua-button"><TerminalSquare className="mr-1.5 h-4 w-4" /> Console</Link>
      </div>

      {message ? <p className={`rounded border p-2 text-xs ${message.ok ? "border-virtua-green/40 bg-virtua-green/10 text-virtua-green" : "border-virtua-red/50 bg-virtua-red/10 text-virtua-red"}`} role={message.ok ? "status" : "alert"}>{message.text}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{tr("Ressources", "Resources")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{isLxc ? tr("Nom d'hôte", "Hostname") : tr("Nom", "Name")}</span>
              <input className="virtua-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="grid gap-1"><span className="text-xs text-virtua-muted">vCPU</span>
              <input className="virtua-input" type="number" min={1} value={cores} onChange={(e) => setCores(Number(e.target.value))} />
            </label>
            <label className="grid gap-1"><span className="text-xs text-virtua-muted">{tr("Mémoire (Mio)", "Memory (MiB)")}</span>
              <input className="virtua-input" type="number" min={64} step={64} value={memory} onChange={(e) => setMemory(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <input type="checkbox" checked={onboot} onChange={(e) => setOnboot(e.target.checked)} />
              {tr("Démarrer avec le serveur", "Start at boot")}
            </label>
            <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-virtua-muted">{tr("Notes", "Notes")}</span>
              <textarea className="virtua-input min-h-[4rem] py-2" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <p className="mt-2 text-[11px] text-virtua-muted">{running && !isLxc ? tr("VM en marche : Proxmox applique certains changements au prochain redémarrage.", "Running VM: Proxmox applies some changes at the next reboot.") : null}</p>
          <button className="virtua-button-primary mt-3" disabled={busy || !config} onClick={() => void save()}><Save className="mr-1.5 h-4 w-4" /> {tr("Enregistrer", "Save")}</button>
        </section>

        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{tr("Activité", "Activity")}</h2>
          <div className="space-y-3">
            <MetricBar label="CPU" value={running ? resource.cpu ?? 0 : 0} />
            <MetricBar label="RAM" value={running ? resource.memory ?? 0 : 0} />
          </div>
          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex justify-between"><dt className="text-virtua-muted">{tr("Durée", "Uptime")}</dt><dd>{resource.uptime ?? "—"}</dd></div>
            {config?.ostype ? <div className="flex justify-between"><dt className="text-virtua-muted">OS</dt><dd>{String(config.ostype)}</dd></div> : null}
            {isLxc ? <div className="flex justify-between"><dt className="text-virtua-muted">{tr("Non privilégié", "Unprivileged")}</dt><dd>{Number(config?.unprivileged ?? 0) === 1 ? tr("oui", "yes") : tr("non", "no")}</dd></div> : null}
            {config?.net0 ? <div className="flex justify-between gap-3"><dt className="text-virtua-muted">net0</dt><dd className="truncate font-mono">{String(config.net0)}</dd></div> : null}
          </dl>
        </section>

        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><HardDrive className="h-4 w-4 text-virtua-muted" /> {tr("Disques", "Disks")}</h2>
          <div className="space-y-2">
            {disks.map((disk) => (
              <div key={disk.key} className="flex flex-wrap items-center gap-2 rounded bg-virtua-shade/15 p-2 text-xs">
                <span className="w-16 font-mono font-medium">{disk.key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-virtua-muted" title={disk.value}>{disk.value.split(",")[0]} · {disk.size}</span>
                <input className="virtua-input !h-8 w-20" type="number" min={1} placeholder="+Gio" value={grow[disk.key] ?? ""} onChange={(e) => setGrow({ ...grow, [disk.key]: Number(e.target.value) })} aria-label={`${tr("Agrandir", "Grow")} ${disk.key}`} />
                <button className="virtua-button !h-8" disabled={busy || !grow[disk.key]} onClick={() => void run(tr("Disque agrandi.", "Disk grown."), () => proxmoxClient.resizeDisk(resource.id, disk.key, `+${grow[disk.key]}G`))}>
                  {tr("Agrandir", "Grow")}
                </button>
              </div>
            ))}
            {config && disks.length === 0 ? <p className="text-xs text-virtua-muted">{tr("Aucun disque.", "No disk.")}</p> : null}
          </div>
        </section>

        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Camera className="h-4 w-4 text-virtua-muted" /> {tr("Instantanés", "Snapshots")}</h2>
          <div className="mb-3 flex gap-2">
            <input className="virtua-input min-w-0 flex-1" placeholder={tr("nom (lettres, chiffres, - _)", "name (letters, digits, - _)")} value={snapName} onChange={(e) => setSnapName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} />
            <button className="virtua-button-primary" disabled={busy || !/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(snapName)} onClick={() => void run(tr("Instantané créé.", "Snapshot created."), async () => { await proxmoxClient.createSnapshot(resource.id, snapName); setSnapName(""); })}>
              {tr("Prendre", "Take")}
            </button>
          </div>
          <div className="space-y-1.5">
            {snapshots.map((snap) => (
              <div key={snap.id} className="flex items-center gap-2 rounded bg-virtua-shade/15 p-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">{snap.name}</span>
                <span className="text-virtua-muted">{snap.createdAt ? new Date(snap.createdAt).toLocaleString() : ""}</span>
                <button className="virtua-icon-button !h-7 !w-7" title={tr("Revenir à cet instantané", "Roll back")} disabled={busy} onClick={() => window.confirm(tr(`Revenir à « ${snap.name} » ? L'état actuel sera perdu.`, `Roll back to “${snap.name}”? The current state is lost.`)) && void run(tr("Retour à l'instantané lancé.", "Rollback started."), () => proxmoxClient.rollbackSnapshot(resource.id, snap.name))}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button className="virtua-icon-button !h-7 !w-7" title={tr("Supprimer", "Delete")} disabled={busy} onClick={() => window.confirm(tr(`Supprimer l'instantané « ${snap.name} » ?`, `Delete snapshot “${snap.name}”?`)) && void run(tr("Instantané supprimé.", "Snapshot deleted."), () => proxmoxClient.deleteSnapshot(resource.id, snap.name))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {snapshots.length === 0 ? <p className="text-xs text-virtua-muted">{tr("Aucun instantané.", "No snapshot.")}</p> : null}
          </div>
        </section>
      </div>

      <section className="rounded border border-virtua-red/40 bg-virtua-panel p-4">
        <h2 className="mb-1 text-sm font-semibold text-virtua-red">{tr("Supprimer", "Delete")}</h2>
        <p className="mb-3 text-xs text-virtua-muted">{tr("Supprime la machine et ses disques sur le serveur Proxmox. Elle doit être arrêtée.", "Deletes the machine and its disks on the Proxmox server. It must be stopped.")}</p>
        <button
          className="virtua-button border-virtua-red/50 text-virtua-red"
          disabled={busy || running}
          onClick={() => {
            const typed = window.prompt(tr(`Tapez ${resource.proxmox?.vmid} pour supprimer définitivement « ${resource.name} ».`, `Type ${resource.proxmox?.vmid} to permanently delete “${resource.name}”.`));
            if (typed !== String(resource.proxmox?.vmid)) return;
            void run(tr("Suppression lancée.", "Deletion started."), async () => {
              await proxmoxClient.deleteGuest(resource.id);
              navigate(isLxc ? "/lxc" : "/vms");
            });
          }}
        >
          <Trash2 className="mr-1.5 h-4 w-4" /> {tr("Supprimer la machine", "Delete machine")}
        </button>
      </section>
    </div>
  );
}
