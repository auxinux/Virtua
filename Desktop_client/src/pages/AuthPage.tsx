import { ArrowLeft, ChevronDown, Eye, EyeOff } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { virtuaClient } from "@/api/virtuaClient";

type AuthMode = "password" | "pairing";

export function AuthPage({
  onAuthenticated,
  onBack,
  initialError,
}: {
  onAuthenticated: () => Promise<void>;
  onBack?: () => void;
  initialError?: string | null;
}) {
  const [mode, setMode] = useState<AuthMode>("password");
  const [endpoint, setEndpoint] = useState(virtuaClient.getEndpoint() || "https://srv02.athub.ca:8441");
  const [deviceName, setDeviceName] = useState(virtuaClient.getDeviceName());
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    void virtuaClient.getDeviceNameAsync().then(setDeviceName);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "password") {
        await virtuaClient.login(endpoint, username.trim(), password, deviceName.trim());
      } else {
        await virtuaClient.pair(endpoint, pairingCode.trim(), deviceName.trim());
      }
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion impossible");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-virtua-bg p-6 text-virtua-text">
      <form onSubmit={submit} className="w-full max-w-[25rem] rounded border border-virtua-border bg-virtua-panel p-5 shadow-panel">
        <div className="mb-5 flex items-center justify-between gap-3">
          <img
            src="/brand/auxinux-virtua-logo.svg"
            alt="AuxiNux Virtua - Desktop Client"
            className="h-auto w-[17rem]"
            draggable={false}
          />
          {onBack ? (
            <button type="button" onClick={onBack} className="virtua-icon-button shrink-0" title="Retour au choix Local/Cloud">
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <div className="mb-4 grid grid-cols-2 gap-1 rounded bg-black/20 p-1">
          <button
            type="button"
            onClick={() => setMode("password")}
            className={`h-9 rounded text-sm ${mode === "password" ? "bg-virtua-accent text-white" : "text-virtua-muted hover:bg-virtua-panelHover"}`}
          >
            Mot de passe
          </button>
          <button
            type="button"
            onClick={() => setMode("pairing")}
            className={`h-9 rounded text-sm ${mode === "pairing" ? "bg-virtua-accent text-white" : "text-virtua-muted hover:bg-virtua-panelHover"}`}
          >
            Code pairing
          </button>
        </div>

        <div className="grid gap-4">
          {mode === "password" ? (
            <>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-virtua-muted">Utilisateur</span>
                <input className="virtua-input" value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" autoCorrect="off" />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-virtua-muted">Mot de passe</span>
                <div className="flex rounded border border-virtua-border bg-black/20 focus-within:border-virtua-accent">
                  <input
                    className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm text-virtua-text outline-none"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="flex h-10 w-10 items-center justify-center text-virtua-muted hover:text-virtua-text"
                    title={showPassword ? "Masquer" : "Afficher"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
            </>
          ) : (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-virtua-muted">Code de pairing</span>
              <input className="virtua-input uppercase" value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="ABC123" />
            </label>
          )}

          <div className="rounded border border-virtua-border bg-black/10">
            <button
              type="button"
              onClick={() => setShowOptions((value) => !value)}
              className="flex h-10 w-full items-center justify-between px-3 text-sm text-virtua-muted hover:text-virtua-text"
            >
              Options
              <ChevronDown className={`h-4 w-4 transition-transform ${showOptions ? "rotate-180" : ""}`} />
            </button>

            {showOptions && (
              <div className="grid gap-4 border-t border-virtua-border p-3">
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-virtua-muted">Serveur</span>
                  <input className="virtua-input" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://virtua.example.com" />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-virtua-muted">Nom de cet appareil</span>
                  <input className="virtua-input" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
                </label>
              </div>
            )}
          </div>
        </div>

        {(error || initialError) && (
          <div className="mt-4 rounded border border-virtua-red/30 bg-virtua-red/10 px-3 py-2 text-sm text-virtua-red">
            {error ?? initialError}
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="virtua-button-primary mt-5 w-full justify-center disabled:cursor-not-allowed disabled:opacity-60">
          {isSubmitting ? "Connexion..." : "Connecter"}
        </button>
      </form>
    </div>
  );
}
