import { Cpu, Lock, PlugZap, RefreshCw, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import { AboutPanel } from "@/components/AboutPanel";
import { StatusBadge } from "@/components/StatusBadge";
import { virtuaClient } from "@/api/virtuaClient";
import type { VirtuaConnection } from "@/types";

const serverKinds = {
  vdm: {
    title: "Virtua Datacenter Manager",
    detail: "Ce serveur gère plusieurs nœuds : l'inventaire, les consoles et les créations passent par lui, et chaque machine indique son nœud.",
  },
  virtua: {
    title: "Nœud Virtua",
    detail: "Ce serveur est un hôte de virtualisation : vous voyez ses propres machines et celles des nœuds qu'il fédère.",
  },
} as const;

function formatMoment(value?: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function SettingsPage({ connection }: { connection: VirtuaConnection | null }) {
  const [deviceName, setDeviceName] = useState(connection?.deviceName ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let disposed = false;
    void virtuaClient.getDeviceNameAsync().then((name) => {
      if (!disposed) setDeviceName(name);
    });
    return () => { disposed = true; };
  }, [connection?.id]);

  const kind = serverKinds[connection?.manager === "vdm" ? "vdm" : "virtua"];
  const rows: Array<[string, string]> = [
    ["Serveur", connection?.endpoint || "—"],
    ["Type", kind.title],
    ["Utilisateur", connection?.username || "—"],
    ["Rôle", connection?.role === "ADMIN" ? "Administrateur" : connection?.role === "USER" ? "Utilisateur" : "—"],
    ["Appareil enregistré", connection?.name || "—"],
    ["Dernière synchronisation", formatMoment(connection?.lastSync)],
  ];

  const saveDeviceName = () => {
    const next = deviceName.trim();
    if (!next) return;
    virtuaClient.setDeviceName(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Connexion Virtua</h1>
        <p className="mt-1 text-sm text-virtua-muted">
          Serveur auquel ce client est appairé. Les identifiants restent dans le coffre natif du
          système; ils ne sont jamais affichés ici.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <section className="rounded border border-virtua-border bg-virtua-panel p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded bg-virtua-accentSoft text-virtua-accent">
              <PlugZap className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium">Session active</p>
              <p className="text-xs text-virtua-muted">{kind.detail}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="rounded border border-virtua-border bg-black/15 p-3">
                <p className="text-xs text-virtua-muted">{label}</p>
                <p className="mt-1 break-all text-sm">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-virtua-border pt-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">
                Nom de cet appareil (visible dans le panneau du serveur)
              </span>
              <div className="flex min-w-0 gap-2">
                <input
                  className="virtua-input min-w-0 flex-1"
                  value={deviceName}
                  maxLength={64}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
                <button
                  type="button"
                  className="virtua-button shrink-0"
                  disabled={!deviceName.trim()}
                  onClick={saveDeviceName}
                >
                  Enregistrer
                </button>
              </div>
            </label>
            <p className="mt-2 text-xs text-virtua-muted">
              {saved
                ? "Nom enregistré. Il sera transmis au serveur à la prochaine connexion."
                : "Pour révoquer cet appareil, utilisez la page Configuration du panneau web du serveur."}
            </p>
          </div>
        </section>

        <aside className="space-y-3">
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-virtua-accent" />
              <p className="text-sm font-medium">Etat</p>
            </div>
            <StatusBadge status={connection?.status ?? "offline"} />
            <p className="mt-3 flex items-center gap-2 text-xs leading-5 text-virtua-muted">
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              L'inventaire est rafraîchi automatiquement toutes les 3 secondes tant que la fenêtre
              est visible.
            </p>
          </div>
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-virtua-accent" />
              <p className="text-sm font-medium">Ce que gère ce serveur</p>
            </div>
            <p className="text-xs leading-5 text-virtua-muted">
              VM, conteneurs LXC et Docker, consoles SPICE/VNC et terminal, snapshots, création et
              suppression — dans la limite des droits de votre compte.
            </p>
          </div>
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <Lock className="h-4 w-4 text-virtua-accent" />
              <p className="text-sm font-medium">Sécurité</p>
            </div>
            <p className="text-xs leading-5 text-virtua-muted">
              Jeton d'accès court renouvelé automatiquement, jeton de rafraîchissement à rotation
              stocké dans le trousseau du système, et révocation immédiate depuis le serveur.
            </p>
          </div>
          <AboutPanel />
        </aside>
      </div>
    </div>
  );
}
