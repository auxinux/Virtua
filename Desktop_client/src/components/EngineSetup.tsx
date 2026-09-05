import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, Download, Loader2, RefreshCw, Server } from "lucide-react";
import { engines, type EngineId, type EngineOverview } from "@/api/engines";

const names: Record<EngineId, string> = { qemu: "Machines virtuelles · QEMU", docker: "Conteneurs Docker", lxc: "Conteneurs LXC" };
const stateNames = { ready: "Disponible", missing: "À installer", stopped: "À démarrer ou configurer", unavailable: "À vérifier" };
export function EngineSetup({ requiredOnly = false, onReady }: { requiredOnly?: boolean; onReady?: () => void }) {
  const [overview, setOverview] = useState<EngineOverview | null>(null);
  const [busy, setBusy] = useState<EngineId | "stop" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshing(true); setError("");
    try { setOverview(await engines.status()); }
    catch (e) { setError(String(e)); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let disposed = false;
    const subscription = listen<{ engine: EngineId; message: string }>("engine-setup-progress", event => {
      if (!disposed) setMessage(event.payload.message);
    });
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => undefined); };
  }, []);
  useEffect(() => {
    if (!overview?.busy || busy) return;
    const timer = window.setInterval(() => { void engines.status().then(setOverview).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [overview?.busy, busy]);
  const prepare = async (id: EngineId) => {
    setBusy(id); setError(""); setMessage("Préparation en cours…");
    try {
      const next = await engines.prepare(id); setOverview(next);
      setMessage(next.engines.find(e => e.id === id)?.state === "ready" ? "Le moteur est prêt." : "Préparation terminée. Consultez le diagnostic.");
    } catch (e) {
      setError(String(e)); setMessage("");
      try { setOverview(await engines.status()); } catch { /* Preserve the original setup error. */ }
    } finally { setBusy(null); }
  };
  const stop = async () => {
    if (!window.confirm("Arrêter la VM Debian et tous les conteneurs LXC qu’elle héberge ?")) return;
    setBusy("stop"); setError(""); setMessage("Arrêt de Debian et de ses conteneurs…");
    try { await engines.stopLxc(); setOverview(await engines.status()); setMessage("VM Debian arrêtée."); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  };
  const locked = Boolean(busy || refreshing || overview?.busy);
  const ready = overview?.engines.find(e => e.id === "qemu")?.state === "ready";
  return <section className="space-y-4 rounded border border-virtua-border bg-virtua-panel p-5">
    <div className="flex items-center justify-between gap-4">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Server className="h-5 w-5 text-virtua-accent" />{requiredOnly ? "Préparer cet ordinateur" : "Moteurs locaux"}</h2>
        <p className="mt-1 text-sm text-virtua-muted">{overview ? `${overview.os} · ${overview.architecture.toUpperCase()} · accélération QEMU : ${overview.accelerator.toUpperCase()}` : "Détection du système…"}</p></div>
      <button disabled={locked} onClick={() => void refresh()} className="virtua-button" aria-label="Actualiser les moteurs"><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /></button>
    </div>
    {requiredOnly && <p className="text-sm text-virtua-muted">QEMU est nécessaire pour créer et exécuter vos VM locales. Docker et LXC pourront être activés ensuite, à votre demande.</p>}
    {error && <div role="alert" className="whitespace-pre-wrap rounded border border-virtua-red/50 bg-virtua-red/10 p-3 text-sm text-virtua-red">{error}</div>}
    {message && <p role="status" className="flex items-center gap-2 text-sm text-virtua-accent">{busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}{message}</p>}
    {overview?.engines.filter(e => !requiredOnly || e.id === "qemu").map(engine => <div key={engine.id} className="rounded border border-virtua-border bg-black/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{names[engine.id]}</h3><span className={`text-xs ${engine.state === "ready" ? "text-virtua-green" : "text-virtua-yellow"}`}>{stateNames[engine.state]}</span></div>
      <p className="mt-2 text-sm text-virtua-muted">{engine.detail}</p>
      {engine.id === "lxc" && overview.os !== "linux" && <p className="mt-2 text-xs text-virtua-muted">Une seule VM Debian 13 pour tous vos LXC, avec le noyau Debian standard et l’architecture du poste. Les disques sont conservés à l’arrêt. Les IP des conteneurs restent internes à cette VM.</p>}
      {engine.id === "docker" && engine.state !== "ready" && <p className="mt-2 text-xs text-virtua-muted">L’installation existante est réutilisée. Docker Desktop peut demander de terminer son assistant ou de redémarrer Windows.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {engine.state !== "ready" ? <button disabled={locked} onClick={() => void prepare(engine.id)} className="virtua-button-primary"><Download className="mr-2 h-4 w-4" />{busy === engine.id ? "Préparation…" : engine.state === "missing" ? "Installer et préparer" : "Démarrer / préparer"}</button> : <span className="flex items-center gap-2 text-sm text-virtua-green"><CheckCircle2 className="h-4 w-4" />Prêt à utiliser</span>}
        {engine.id === "lxc" && overview.os !== "linux" && engine.state !== "missing" && <>
          <button disabled={locked} onClick={() => void stop()} className="virtua-button">Arrêter Debian</button>
          <button disabled={locked} onClick={() => void engines.lxcLogs().then(setLogs).catch(e => setError(String(e)))} className="virtua-button">Journaux Debian</button>
        </>}
      </div>
    </div>)}
    {logs !== null && <div><button onClick={() => setLogs(null)} className="virtua-button mb-2">Fermer les journaux</button><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-xs">{logs || "Aucun journal disponible."}</pre></div>}
    {requiredOnly && ready && <button disabled={locked} onClick={onReady} className="virtua-button-primary w-full justify-center">Ouvrir le mode local</button>}
    {overview?.accelerator === "tcg" && <p className="text-xs text-virtua-yellow">QEMU utilisera l’émulation logicielle. Vérifiez les droits KVM sous Linux ou l’activation de Windows Hypervisor Platform sous Windows pour bénéficier de l’accélération sur les architectures compatibles.</p>}
  </section>;
}
