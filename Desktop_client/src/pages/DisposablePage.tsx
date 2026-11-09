import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, FlaskConical, Loader2, Package, Play, RefreshCw, Shield, Trash2, Wrench } from "lucide-react";
import { disposables, type BaseInfo, type DepotBase, type DisposableAction } from "@/api/disposable";
import type { VirtuaResource } from "@/types";

function formatSize(bytes?: number | null) {
  if (!bytes) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Disposable VMs ("Jetables"): a ready system in seconds from an installed
 * base, kept or thrown away afterwards. Windows bases are built on this
 * computer; Debian bases can also be downloaded from the AuxiNux depot.
 */
export function DisposablePage({ resources, onChanged }: { resources: VirtuaResource[]; onChanged?: () => void }) {
  const navigate = useNavigate();
  const [bases, setBases] = useState<BaseInfo[] | null>(null);
  const [depot, setDepot] = useState<DepotBase[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [strict, setStrict] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      setBases(await disposables.bases());
    } catch (error) {
      setMessage({ text: errorText(error), error: true });
    }
    disposables.depot().then(setDepot).catch(() => setDepot([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, work: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const result = await work();
      if (success) setMessage({ text: success, error: false });
      await load();
      onChanged?.();
      return result;
    } catch (error) {
      setMessage({ text: errorText(error), error: true });
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const launch = async (base: BaseInfo) => {
    const vm = await run(`launch:${base.id}`, () => disposables.launch(base.id, strict, offline ? "isolated" : "user"));
    if (vm && typeof vm === "object" && "id" in vm) navigate(`/console/${encodeURIComponent(String((vm as { id: string }).id))}`);
  };

  const running = resources.filter((resource) => resource.disposable);
  const building = resources.filter((resource) => resource.name.startsWith("Base jetable"));
  const localNames = new Set((bases ?? []).map((base) => `${base.os}-${base.architecture}.vmtmp`));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><FlaskConical className="h-6 w-6 text-virtua-accent" />VM jetables</h1>
        <p className="mt-1 text-sm text-virtua-muted">
          Une VM prête en quelques secondes, copiée d’une base déjà installée. À l’arrêt : la jeter, repartir à neuf, la garder ou la convertir en VM normale. Compte : virtua / virtua.
        </p>
      </div>

      {message ? (
        <div role={message.error ? "alert" : "status"} className={`whitespace-pre-wrap rounded border p-3 text-sm ${message.error ? "border-virtua-red/50 bg-virtua-red/10 text-virtua-red" : "border-virtua-accent/40 bg-virtua-accentSoft text-virtua-text"}`}>
          {message.text}
        </div>
      ) : null}

      <section className="rounded border border-virtua-border bg-virtua-panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Bases sur cet ordinateur</h2>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2" title="Rien n’est écrit sur le disque : tout disparaît à l’arrêt.">
              <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
              <Shield className="h-4 w-4 text-virtua-muted" />Sandbox stricte
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
              Sans réseau
            </label>
            <button className="virtua-icon-button" aria-label="Actualiser" onClick={() => void load()}><RefreshCw className="h-4 w-4" /></button>
          </div>
        </div>
        {!bases ? (
          <div className="flex items-center gap-2 text-sm text-virtua-muted"><Loader2 className="h-4 w-4 animate-spin" />Chargement…</div>
        ) : bases.length === 0 ? (
          <p className="text-sm text-virtua-muted">Aucune base pour l’instant : préparez-en une ci-dessous ou téléchargez-la depuis le dépôt AuxiNux.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {bases.map((base) => (
              <div key={base.id} className="flex flex-col gap-2 rounded border border-virtua-border bg-virtua-inset p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium">{base.label}</p>
                  <p className="text-xs text-virtua-muted">{base.cpu} vCPU · {Math.round(base.memoryMib / 1024)} Go · {formatSize(base.size)}</p>
                </div>
                <p className="text-xs text-virtua-muted">
                  {base.source === "depot" ? "Téléchargée du dépôt AuxiNux" : "Préparée sur cet ordinateur"}
                  {base.inUse ? ` · ${base.inUse} jetable(s) en cours` : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button className="virtua-button-primary" disabled={!!busy} onClick={() => void launch(base)}>
                    {busy === `launch:${base.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    Lancer une jetable
                  </button>
                  <button className="virtua-button" disabled={!!busy} title="Fichier .vmtmp dans le dossier des exports" onClick={() => void run(`export:${base.id}`, () => disposables.exportBase(base.id).then((path) => setMessage({ text: `Exportée : ${path}`, error: false })))}>
                    {busy === `export:${base.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}
                    Exporter .vmtmp
                  </button>
                  <button className="virtua-button" disabled={!!busy || base.inUse > 0} onClick={() => {
                    if (window.confirm(`Supprimer la base « ${base.label} » ?`)) void run(`delete:${base.id}`, () => disposables.deleteBase(base.id), "Base supprimée.");
                  }}>
                    <Trash2 className="mr-2 h-4 w-4" />Supprimer
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-virtua-accent" />Préparer une base ici</h2>
          <p className="mb-3 text-xs text-virtua-muted">
            Installation automatique (comme la création rapide), puis le système installé devient une base. Une seule fois ; Windows : 20 à 40 minutes. Les Windows installés ne se redistribuent pas, ils restent sur cet ordinateur.
          </p>
          <div className="flex flex-wrap gap-2">
            {(["windows11", "debian13"] as const).map((os) => (
              <button key={os} className="virtua-button" disabled={!!busy} onClick={() => void run(`prepare:${os}`, () => disposables.prepare(os), "Installation de la base lancée : elle apparaîtra ici une fois terminée (la VM « Base jetable … » s’éteint toute seule).")}>
                {busy === `prepare:${os}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {os === "windows11" ? "Base Windows 11" : "Base Debian 13"}
              </button>
            ))}
          </div>
          {building.length ? <p className="mt-2 text-xs text-virtua-yellow">En préparation : {building.map((b) => b.name).join(", ")}</p> : null}
        </div>

        <div className="rounded border border-virtua-border bg-virtua-panel p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Download className="h-4 w-4 text-virtua-accent" />Dépôt AuxiNux</h2>
          <p className="mb-3 text-xs text-virtua-muted">Bases prêtes à l’emploi pour l’architecture de cet ordinateur (fichiers .vmtmp, vérifiés à l’import).</p>
          {!depot ? (
            <div className="flex items-center gap-2 text-sm text-virtua-muted"><Loader2 className="h-4 w-4 animate-spin" />Recherche…</div>
          ) : depot.length === 0 ? (
            <p className="text-sm text-virtua-muted">Aucune base sur le dépôt pour cette architecture.</p>
          ) : (
            <div className="space-y-2">
              {depot.map((item) => (
                <div key={item.url} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{item.name} <span className="text-xs text-virtua-muted">{formatSize(item.size)}</span></span>
                  <button className="virtua-button shrink-0" disabled={!!busy} onClick={() => void run(`download:${item.name}`, () => disposables.download(item), "Base téléchargée et prête.")}>
                    {busy === `download:${item.name}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    {localNames.has(item.name) ? "Retélécharger" : "Télécharger"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="rounded border border-virtua-border bg-virtua-panel p-4">
        <h2 className="mb-3 text-sm font-semibold">Jetables existantes</h2>
        {running.length === 0 ? (
          <p className="text-sm text-virtua-muted">Aucune VM jetable.</p>
        ) : (
          <div className="space-y-2">
            {running.map((vm) => (
              <DisposableRow key={vm.id} vm={vm} busy={busy} onAct={(action) => void run(`${action}:${vm.id}`, () => disposables.act(vm.id, action), actionDone[action])} onOpen={() => navigate(`/console/${encodeURIComponent(vm.id)}`)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const actionDone: Record<DisposableAction, string> = {
  discard: "VM jetée.",
  reset: "VM remise à neuf depuis sa base.",
  convert: "VM convertie : c’est maintenant une VM normale.",
  keep: "VM gardée.",
};

function DisposableRow({ vm, busy, onAct, onOpen }: { vm: VirtuaResource; busy: string | null; onAct: (action: DisposableAction) => void; onOpen: () => void }) {
  const running = vm.state === "running";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-virtua-border bg-virtua-inset p-3 text-sm">
      <div>
        <p className="font-medium">{vm.name} {vm.disposable?.strict ? <span className="ml-1 rounded bg-virtua-accentSoft px-1.5 py-0.5 text-xs">sandbox stricte</span> : null}</p>
        <p className="text-xs text-virtua-muted">{vm.disposable?.baseLabel} · {running ? "en marche" : "arrêtée"}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="virtua-button" onClick={onOpen}>Console</button>
        <button className="virtua-button" disabled={!!busy || running} onClick={() => onAct("reset")}>Repartir à neuf</button>
        <button className="virtua-button" disabled={!!busy || running || vm.disposable?.strict} onClick={() => onAct("convert")}>Convertir en VM normale</button>
        <button className="virtua-button" disabled={!!busy} onClick={() => {
          if (window.confirm(`Jeter « ${vm.name} » ? Tout ce qu’elle contient sera effacé.`)) onAct("discard");
        }}>Jeter</button>
      </div>
    </div>
  );
}
