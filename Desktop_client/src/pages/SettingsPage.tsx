import { Lock, PlugZap, ServerCog } from "lucide-react";
import { AboutPanel } from "@/components/AboutPanel";
import { StatusBadge } from "@/components/StatusBadge";
import type { VirtuaConnection } from "@/types";

export function SettingsPage({ connection }: { connection: VirtuaConnection | null }) {
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Connexion Virtua</h1>
        <p className="mt-1 text-sm text-virtua-muted">Frame de configuration pour le futur backend desktop.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <form className="rounded border border-virtua-border bg-virtua-panel p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded bg-virtua-accentSoft text-virtua-accent">
              <PlugZap className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium">Profil de connexion</p>
              <p className="text-xs text-virtua-muted">Ces champs seront branches sur le coffre natif plus tard.</p>
            </div>
          </div>

          <div className="grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">Nom</span>
              <input className="virtua-input" defaultValue={connection?.name ?? ""} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">Endpoint API</span>
              <input className="virtua-input" defaultValue={connection?.endpoint ?? ""} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">Utilisateur</span>
              <input className="virtua-input" defaultValue={connection?.username ?? ""} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">Jeton ou mot de passe</span>
              <input className="virtua-input" type="password" defaultValue="placeholder" />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="virtua-button-primary">Tester</button>
            <button type="button" className="virtua-button">Sauvegarder</button>
          </div>
        </form>

        <aside className="space-y-3">
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-virtua-accent" />
              <p className="text-sm font-medium">Etat actuel</p>
            </div>
            <StatusBadge status={connection?.status ?? "offline"} />
            <p className="mt-3 text-xs leading-5 text-virtua-muted">
              Le frame utilise des donnees locales en attendant les routes desktop finales de Virtua.
            </p>
          </div>
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <Lock className="h-4 w-4 text-virtua-accent" />
              <p className="text-sm font-medium">Securite prevue</p>
            </div>
            <p className="text-xs leading-5 text-virtua-muted">
              Stockage des secrets via API native, isolation des commandes et permissions Tauri a durcir par action.
            </p>
          </div>
          <AboutPanel />
        </aside>
      </div>
    </div>
  );
}
