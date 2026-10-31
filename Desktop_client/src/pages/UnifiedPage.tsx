import { useCallback, useEffect, useMemo, useState } from "react";
import { AppWindow, CheckCircle2, CircleAlert, Download, Loader2, MonitorUp, Play, Power, RefreshCw, Search, Unplug } from "lucide-react";
import { localVirtua } from "@/api/localVirtua";
import { unified, type UnifiedApp, type UnifiedOverview, type UnifiedVm } from "@/api/unified";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function AppIcon({ app }: { app: UnifiedApp }) {
  if (app.icon) {
    return <img src={`data:image/png;base64,${app.icon}`} alt="" className="h-8 w-8 shrink-0" draggable={false} />;
  }
  return <AppWindow className="h-8 w-8 shrink-0 text-virtua-muted" />;
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-virtua-green" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-virtua-yellow" />}
      <span className={done ? "text-virtua-text" : "text-virtua-muted"}>{children}</span>
    </li>
  );
}

function SetupForm({ vm, busy, onSubmit }: { vm: UnifiedVm; busy: boolean; onSubmit: (user: string, password: string) => void }) {
  const [user, setUser] = useState(vm.user ?? "");
  const [password, setPassword] = useState("");
  const running = vm.state === "running";
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        <Step done={running}>Windows est démarré dans la VM.</Step>
        <Step done={vm.agent}>
          QEMU Guest Agent actif dans Windows — installez <em>virtio-win-guest-tools</em> depuis le disque de pilotes VirtIO.
        </Step>
        <Step done={false}>
          Windows 11 Professionnel, Entreprise ou Éducation (l’édition Famille n’a pas de Bureau à distance) et un compte avec mot de passe.
        </Step>
      </ol>
      <form
        className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(user, password);
          setPassword("");
        }}
      >
        <input className="virtua-input" placeholder="Compte Windows (ex. alex ou alex@outlook.com)" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
        <input className="virtua-input" type="password" placeholder="Mot de passe Windows" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button type="submit" className="virtua-button-primary justify-center" disabled={busy || !running || !vm.agent || !user.trim() || !password}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MonitorUp className="mr-2 h-4 w-4" />}
          Activer le mode Unifié
        </button>
      </form>
      <p className="text-xs text-virtua-muted">
        Le mot de passe est rangé dans le trousseau du système (Keychain, Gestionnaire d’identifiants Windows, Secret Service), jamais dans les fichiers de Virtua.
      </p>
    </div>
  );
}

function VmCard({ vm, clientReady, onChanged, report }: { vm: UnifiedVm; clientReady: boolean; onChanged: () => Promise<void>; report: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const running = vm.state === "running";

  const run = async (key: string, work: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await work();
      if (success) report(success);
      await onChanged();
    } catch (error) {
      report(errorText(error), true);
    } finally {
      setBusy(null);
    }
  };

  const apps = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? vm.apps.filter((app) => app.name.toLowerCase().includes(needle)) : vm.apps;
  }, [filter, vm.apps]);

  const launch = (app?: UnifiedApp) =>
    run(
      `launch:${app?.id ?? "desktop"}`,
      () => unified.launch(vm.id, app?.id),
      running ? `${app?.name ?? "Bureau Windows"} s’ouvre…` : `Démarrage de ${vm.name}, ${app?.name ?? "le bureau"} s’ouvrira dès que Windows sera prêt…`,
    );

  return (
    <section className="space-y-4 rounded border border-virtua-border bg-virtua-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{vm.name}</h2>
          <p className="text-xs text-virtua-muted">
            {vm.architecture.toUpperCase()} · {running ? "en marche" : "arrêtée"}
            {vm.enabled ? ` · mode Unifié actif (${vm.user ?? "?"})` : ""}
            {vm.enabled && running ? (vm.rdpReady ? " · Windows prêt" : " · Windows démarre…") : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!running && (
            <button className="virtua-button" disabled={!!busy} onClick={() => void run("start", () => localVirtua.runAction(vm.id, "start"), `${vm.name} démarre.`)}>
              <Power className="mr-2 h-4 w-4" />Démarrer
            </button>
          )}
          {vm.enabled && (
            <>
              <button className="virtua-button" disabled={!!busy || !clientReady} onClick={() => void launch()}>
                <MonitorUp className="mr-2 h-4 w-4" />Bureau Windows complet
              </button>
              <button className="virtua-button" disabled={!!busy || !running} title={running ? undefined : "Windows doit être démarré"} onClick={() => void run("apps", () => unified.refreshApps(vm.id), "Liste des applications mise à jour.")}>
                <RefreshCw className={`mr-2 h-4 w-4 ${busy === "apps" ? "animate-spin" : ""}`} />Actualiser les applications
              </button>
              <button className="virtua-button" disabled={!!busy} onClick={() => {
                if (window.confirm(`Désactiver le mode Unifié pour ${vm.name} ? Les raccourcis créés sur cet ordinateur seront retirés.`)) {
                  void run("disable", () => unified.disable(vm.id), "Mode Unifié désactivé.");
                }
              }}>
                <Unplug className="mr-2 h-4 w-4" />Désactiver
              </button>
            </>
          )}
        </div>
      </div>

      {vm.needsRestart && (
        <p className="rounded border border-virtua-yellow/40 bg-virtua-yellow/10 p-3 text-sm text-virtua-yellow">
          Cette VM a démarré avant l’activation du port Bureau à distance : redémarrez-la une fois.
        </p>
      )}

      {!vm.enabled ? (
        <SetupForm vm={vm} busy={busy === "prepare"} onSubmit={(user, password) => void run("prepare", () => unified.prepare(vm.id, user, password), "Mode Unifié activé : vos applications Windows sont listées ci-dessous.")} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={vm.integrated}
                disabled={!!busy || vm.apps.length === 0}
                onChange={(event) => void run("integrate", () => unified.integrate(vm.id, event.target.checked), event.target.checked ? "Raccourcis ajoutés au menu des applications de cet ordinateur." : "Raccourcis retirés.")}
              />
              Ajouter ces applications au menu de cet ordinateur
            </label>
            {vm.apps.length > 8 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-virtua-muted" />
                <input className="virtua-input pl-8" placeholder="Rechercher une application" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            )}
          </div>
          {vm.apps.length === 0 ? (
            <p className="text-sm text-virtua-muted">Aucune application listée : démarrez Windows puis « Actualiser les applications ».</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
              {apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  disabled={!!busy || !clientReady}
                  onClick={() => void launch(app)}
                  title={app.path}
                  className="flex items-center gap-3 rounded border border-virtua-border bg-black/10 p-3 text-left text-sm transition-colors hover:border-virtua-accent hover:bg-virtua-panelHover disabled:opacity-50"
                >
                  {busy === `launch:${app.id}` ? <Loader2 className="h-8 w-8 shrink-0 animate-spin text-virtua-accent" /> : <AppIcon app={app} />}
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  <Play className="h-3.5 w-3.5 shrink-0 text-virtua-muted" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Unified mode: each Windows app of a local VM opens in its own window on
 * this computer, next to native apps — like Parallels Coherence.
 */
export function UnifiedPage({ onChanged }: { onChanged?: () => void }) {
  const [overview, setOverview] = useState<UnifiedOverview | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await unified.overview());
    } catch (error) {
      setMessage({ text: errorText(error), error: true });
    }
  }, []);

  useEffect(() => {
    void load();
    // Windows boots in the background: follow it until RDP answers.
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const report = (text: string, error = false) => setMessage({ text, error });
  const refresh = async () => {
    await load();
    onChanged?.();
  };

  const installClient = async () => {
    setInstalling(true);
    try {
      const client = await unified.installClient();
      setOverview((current) => (current ? { ...current, client } : current));
      report(client.available ? "Client Bureau à distance prêt." : client.detail, !client.available);
    } catch (error) {
      report(errorText(error), true);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Mode Unifié</h1>
        <p className="mt-1 text-sm text-virtua-muted">
          Lancez une application installée dans une VM Windows : elle s’ouvre dans sa propre fenêtre sur cet ordinateur, comme une application native. La VM démarre toute seule si besoin.
        </p>
      </div>

      {message && (
        <div role={message.error ? "alert" : "status"} className={`whitespace-pre-wrap rounded border p-3 text-sm ${message.error ? "border-virtua-red/50 bg-virtua-red/10 text-virtua-red" : "border-virtua-accent/40 bg-virtua-accentSoft text-virtua-text"}`}>
          {message.text}
        </div>
      )}

      {overview && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded border border-virtua-border bg-virtua-panel p-4">
          <div className="flex items-center gap-2 text-sm">
            {overview.client.available ? <CheckCircle2 className="h-4 w-4 text-virtua-green" /> : <CircleAlert className="h-4 w-4 text-virtua-yellow" />}
            <span>{overview.client.detail}</span>
          </div>
          {!overview.client.available && overview.client.installable && (
            <button className="virtua-button-primary" disabled={installing} onClick={() => void installClient()}>
              {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Installer
            </button>
          )}
        </section>
      )}

      {!overview ? (
        <div className="flex items-center gap-2 text-sm text-virtua-muted"><Loader2 className="h-4 w-4 animate-spin" />Chargement…</div>
      ) : overview.vms.length === 0 ? (
        <p className="rounded border border-virtua-border bg-virtua-panel p-5 text-sm text-virtua-muted">
          Aucune VM Windows sur cet ordinateur. Créez-en une (système invité « Windows ») dans Machines virtuelles, installez Windows 11 Pro et les outils VirtIO, puis revenez ici.
        </p>
      ) : (
        overview.vms.map((vm) => <VmCard key={vm.id} vm={vm} clientReady={overview.client.available} onChanged={refresh} report={report} />)
      )}
    </div>
  );
}
