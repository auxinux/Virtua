import { EngineSetup } from "@/components/EngineSetup";
import { open } from "@tauri-apps/plugin-dialog";
import { Cpu, FolderCog, FolderOpen, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { localVirtua } from "@/api/localVirtua";
import { AboutPanel } from "@/components/AboutPanel";
import type { LocalQemuDiagnostics, LocalStorageConfig } from "@/types";

const storageFields: Array<[keyof LocalStorageConfig, string]> = [
  ["vmConfigDir", "Configurations VM"],
  ["diskDir", "Disques"],
  ["isoDir", "ISO"],
  ["snapshotDir", "Snapshots"],
  ["exportDir", "Exports / backups"],
];

export function LocalSettingsPage() {
  const [diagnostics, setDiagnostics] = useState<LocalQemuDiagnostics | null>(null);
  const [storage, setStorage] = useState<LocalStorageConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const refresh = async () => {
    setError(null);
    setInfo(null);
    try {
      const [nextDiagnostics, nextStorage] = await Promise.all([
        localVirtua.diagnostics(),
        localVirtua.getStorageConfig(),
      ]);
      setDiagnostics(nextDiagnostics);
      setStorage(nextStorage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnostic local impossible");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    if (!storage) return;
    setSaving(true);
    setError(null);
    try {
      const nextStorage = await localVirtua.saveStorageConfig(storage);
      setStorage(nextStorage);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sauvegarde impossible");
    } finally {
      setSaving(false);
    }
  };

  const browseFolder = async (key: keyof LocalStorageConfig) => {
    if (!storage) return;
    setError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: storage[key],
        title: "Selectionner un dossier",
      });
      if (typeof selected !== "string") return;
      setStorage((current) => current ? { ...current, [key]: selected } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Selection du dossier impossible");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Configuration</h1>
        <p className="mt-1 text-sm text-virtua-muted">Diagnostic hyperviseur et stockage des VM locales.</p>
      </div>

      {error ? <div className="rounded border border-virtua-red/50 bg-virtua-red/15 px-3 py-2 text-sm text-virtua-red">{error}</div> : null}
      {info ? <div className="rounded border border-virtua-accent/40 bg-virtua-accentSoft/40 px-3 py-2 text-sm text-virtua-text">{info}</div> : null}

      <EngineSetup />

      <div className="grid gap-5 lg:grid-cols-[24rem_1fr]">
        <aside className="space-y-4">
          <div className="rounded border border-virtua-border bg-virtua-panel p-4">
            <div className="mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-virtua-accent" />
              <h2 className="text-sm font-semibold">Host</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-virtua-muted">OS</span>
                <span>{diagnostics?.os ?? "..."}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-virtua-muted">Architecture</span>
                <span>{diagnostics?.hostArch ?? "..."}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-virtua-muted">Acceleration</span>
                <span>{diagnostics?.accelerator ?? "n/a"}</span>
              </div>
            </div>
          </div>

          <AboutPanel />
        </aside>

        <section className="rounded border border-virtua-border bg-virtua-panel p-4">
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-virtua-border pb-3">
            <div className="flex items-center gap-2">
              <FolderCog className="h-4 w-4 text-virtua-accent" />
              <h2 className="text-sm font-semibold">Stockage local</h2>
            </div>
            <button type="button" disabled={!storage || isSaving} onClick={() => void save()} className="virtua-button-primary">
              <Save className="mr-2 h-4 w-4" />
              {isSaving ? "Sauvegarde..." : "Sauvegarder"}
            </button>
          </div>

          {storage ? (
            <div className="grid gap-4">
              {storageFields.map(([key, label]) => (
                <label key={key} className="grid gap-1.5">
                  <span className="text-xs font-medium text-virtua-muted">{label}</span>
                  <div className="flex min-w-0 gap-2">
                    <input
                      className="virtua-input min-w-0 flex-1"
                      value={storage[key]}
                      onChange={(event) => setStorage((current) => current ? { ...current, [key]: event.target.value } : current)}
                    />
                    <button type="button" onClick={() => void browseFolder(key)} className="virtua-button shrink-0">
                      <FolderOpen className="mr-2 h-4 w-4" />
                      Parcourir
                    </button>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <div className="h-28 animate-pulse rounded bg-black/20" />
          )}
        </section>
      </div>
    </div>
  );
}
