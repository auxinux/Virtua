import { useEffect, useRef, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { disposables, type DisposableAction } from "@/api/disposable";
import type { VirtuaResource } from "@/types";

/**
 * When a disposable VM stops, ask what becomes of it: throw it away, start
 * over from its base, keep it as is (to start it again later) or convert it
 * into an ordinary VM.
 */
export function DisposableStopDialog({ resources, onChanged }: { resources: VirtuaResource[]; onChanged: () => void }) {
  const previous = useRef<Map<string, string>>(new Map());
  const [queue, setQueue] = useState<VirtuaResource[]>([]);
  const [busy, setBusy] = useState<DisposableAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stopped: VirtuaResource[] = [];
    for (const resource of resources) {
      if (!resource.disposable) continue;
      const before = previous.current.get(resource.id);
      if (before === "running" && resource.state === "stopped") stopped.push(resource);
    }
    previous.current = new Map(resources.filter((r) => r.disposable).map((r) => [r.id, r.state]));
    if (stopped.length) setQueue((current) => [...current, ...stopped.filter((s) => !current.some((c) => c.id === s.id))]);
  }, [resources]);

  const vm = queue[0];
  if (!vm) return null;

  const act = async (action: DisposableAction) => {
    setBusy(action);
    setError(null);
    try {
      await disposables.act(vm.id, action);
      setQueue((current) => current.slice(1));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const strict = Boolean(vm.disposable?.strict);
  const choices: Array<{ action: DisposableAction; label: string; detail: string; primary?: boolean }> = [
    { action: "discard", label: "Jeter", detail: "La VM et tout ce qu’elle contient sont effacés.", primary: true },
    { action: "reset", label: "Repartir à neuf", detail: "Garder la VM, mais revenir à l’état de la base." },
    { action: "keep", label: "Garder telle quelle", detail: strict ? "Sandbox stricte : ses changements sont déjà perdus." : "La relancer plus tard dans le même état." },
    ...(strict ? [] : [{ action: "convert" as const, label: "Convertir en VM normale", detail: "Elle quitte les jetables et devient une VM ordinaire." }]),
  ];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="disposable-stop-title">
      <div className="w-full max-w-lg space-y-3 rounded border border-virtua-border bg-virtua-panel p-5 shadow-panel">
        <h2 id="disposable-stop-title" className="flex items-center gap-2 text-lg font-semibold"><FlaskConical className="h-5 w-5 text-virtua-accent" />« {vm.name} » est arrêtée</h2>
        <p className="text-sm text-virtua-muted">Que faire de cette VM jetable ({vm.disposable?.baseLabel}) ?</p>
        <div className="grid gap-2">
          {choices.map((choice) => (
            <button
              key={choice.action}
              type="button"
              disabled={busy !== null}
              onClick={() => void act(choice.action)}
              className={`flex items-center justify-between gap-3 rounded border p-3 text-left ${choice.primary ? "border-virtua-accent bg-virtua-accentSoft" : "border-virtua-border hover:bg-virtua-panelHover"}`}
            >
              <span>
                <span className="block text-sm font-medium">{choice.label}</span>
                <span className="block text-xs text-virtua-muted">{choice.detail}</span>
              </span>
              {busy === choice.action ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
            </button>
          ))}
        </div>
        {error ? <p role="alert" className="text-sm text-virtua-red">{error}</p> : null}
      </div>
    </div>
  );
}
