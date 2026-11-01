import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Rocket } from "lucide-react";

type QuickOs = "windows11" | "debian13";

const offers: Array<{ os: QuickOs; title: string; specs: string; detail: string }> = [
  {
    os: "windows11",
    title: "Windows 11",
    specs: "4 vCPU · 4 Go RAM · 80 Go",
    detail: "Pro, UEFI + Secure Boot + TPM 2.0, pilotes VirtIO, mode Unifié prêt.",
  },
  {
    os: "debian13",
    title: "Debian 13",
    specs: "2 vCPU · 4 Go RAM · 60 Go",
    detail: "Dernière version, serveur SSH, agent invité, mises à jour appliquées.",
  },
];

interface Progress {
  step: number;
  total: number;
  message: string;
}

interface Download {
  name: string;
  received: number;
  total?: number | null;
  progress?: number | null;
  status: string;
}

function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`;
}

/**
 * One click from nothing to an installed system: Virtua downloads the newest
 * installer, creates the VM with the optimal settings for this computer,
 * starts it and installs unattended. Account: virtua / virtua.
 */
export function QuickCreatePanel({
  quickCreate,
  onCreated,
}: {
  quickCreate: (os: QuickOs, name?: string) => Promise<{ id: string }>;
  onCreated: (resourceId: string) => void;
}) {
  const [busy, setBusy] = useState<QuickOs | null>(null);
  const [names, setNames] = useState<Record<QuickOs, string>>({ windows11: "Windows 11", debian13: "Debian 13" });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [download, setDownload] = useState<Download | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (promise: Promise<() => void>) =>
      void promise.then((unlisten) => (disposed ? unlisten() : unlisteners.push(unlisten))).catch(() => undefined);
    keep(listen<Progress>("quick-create-progress", (event) => setProgress(event.payload)));
    keep(listen<Download>("local-download-progress", (event) => setDownload(event.payload)));
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [busy]);

  const start = async (os: QuickOs) => {
    setBusy(os);
    setError(null);
    setProgress({ step: 1, total: 4, message: "Préparation…" });
    setDownload(null);
    try {
      const resource = await quickCreate(os, names[os].trim() || undefined);
      onCreated(resource.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-4 rounded border border-virtua-border bg-virtua-inset p-3">
      <div className="mb-2 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-virtua-accent" />
        <h3 className="text-sm font-semibold">Création rapide</h3>
        <span className="text-xs text-virtua-muted">— téléchargement, configuration optimale et installation automatique · compte virtua / virtua</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {offers.map((offer) => (
          <div key={offer.os} className="flex flex-col gap-2 rounded border border-virtua-border bg-virtua-panel p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium">{offer.title}</p>
              <p className="text-xs text-virtua-muted">{offer.specs}</p>
            </div>
            <p className="text-xs text-virtua-muted">{offer.detail}</p>
            <div className="flex gap-2">
              <input
                aria-label={`Nom de la VM ${offer.title}`}
                className="virtua-input min-w-0 flex-1"
                value={names[offer.os]}
                disabled={busy !== null}
                onChange={(event) => setNames((current) => ({ ...current, [offer.os]: event.target.value }))}
              />
              <button type="button" className="virtua-button-primary shrink-0" disabled={busy !== null} onClick={() => void start(offer.os)}>
                {busy === offer.os ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Créer et installer
              </button>
            </div>
          </div>
        ))}
      </div>
      {busy && progress ? (
        <div role="status" className="mt-3 space-y-2 text-sm">
          <p>
            <span className="text-virtua-muted">Étape {progress.step}/{progress.total} · </span>
            {progress.message}
          </p>
          {download && download.status !== "completed" ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-virtua-muted">
                <span className="truncate">{download.name}</span>
                <span>
                  {formatBytes(download.received)}
                  {download.total ? ` / ${formatBytes(download.total)}` : ""}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-virtua-shade/20">
                <div className="h-full bg-virtua-accent transition-[width]" style={{ width: `${Math.round(download.progress ?? 0)}%` }} />
              </div>
            </div>
          ) : null}
          <p className="text-xs text-virtua-muted">Vous pouvez fermer cette boîte de dialogue : la création continue (gardez Virtua Desktop ouvert). Un téléchargement interrompu reprend où il s’était arrêté.</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 whitespace-pre-wrap rounded border border-virtua-red/50 bg-virtua-red/10 p-2 text-sm text-virtua-red">{error}</p> : null}
    </section>
  );
}
