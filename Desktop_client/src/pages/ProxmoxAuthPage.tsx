import { useState } from "react";
import { ArrowLeft, Eye, EyeOff, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { changedFingerprint, proxmoxClient, proxmoxProfile, type PveProbe } from "@/api/proxmoxClient";
import { useLanguage } from "@/i18n";

/**
 * Connection to a Proxmox VE server: the address, its certificate (pinned by
 * fingerprint — Proxmox ships a self-signed one), then the account: password
 * (ticket) or API token, which can be kept in the keyring to reconnect alone.
 */
export function ProxmoxAuthPage({ initialError, onBack, onAuthenticated }: { initialError?: string | null; onBack: () => void; onAuthenticated: () => void }) {
  const { language } = useLanguage();
  const tr = (fr: string, en: string) => (language === "fr" ? fr : en);
  const saved = proxmoxProfile.get();
  const [url, setUrl] = useState(saved?.base ?? "");
  const [probe, setProbe] = useState<PveProbe | null>(null);
  /** The certificate shown differs from the one trusted last time. */
  const [certChanged, setCertChanged] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [username, setUsername] = useState(saved?.username ?? "root@pam");
  const [method, setMethod] = useState<"password" | "token">(saved?.tokenId ? "token" : "password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [tokenId, setTokenId] = useState(saved?.tokenId ?? "");
  const [tokenSecret, setTokenSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const check = async () => {
    setBusy(true);
    setError(null);
    setProbe(null);
    setTrusted(false);
    try {
      const next = await proxmoxClient.probe(url);
      setProbe(next);
      const known = saved && saved.base === next.base;
      const same = known && saved.fingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase() === next.fingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase();
      setCertChanged(Boolean(known && !same));
      // Same server, same certificate as last time: already trusted.
      setTrusted(Boolean(same));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!probe || !trusted) return;
    setBusy(true);
    setError(null);
    try {
      await proxmoxClient.login({
        url: probe.base,
        fingerprint: probe.fingerprint,
        username,
        ...(method === "token" ? { tokenId, tokenSecret, remember } : { password }),
      });
      onAuthenticated();
    } catch (e) {
      const changed = changedFingerprint(e);
      if (changed) {
        // The certificate changed between the check and the login.
        setProbe({ base: probe.base, fingerprint: changed });
        setCertChanged(true);
        setTrusted(false);
        setError(tr("Le certificat du serveur vient de changer : vérifiez la nouvelle empreinte.", "The server certificate just changed: check the new fingerprint."));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-virtua-bg p-6 text-virtua-text">
      <form onSubmit={login} className="w-full max-w-[30rem] rounded border border-virtua-border bg-virtua-panel p-5 shadow-panel">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Proxmox VE</h1>
            <p className="text-xs text-virtua-muted">{tr("Connexion directe à un serveur Proxmox VE 9", "Direct connection to a Proxmox VE 9 server")}</p>
          </div>
          <button type="button" onClick={onBack} className="virtua-icon-button shrink-0" title={tr("Retour au choix du mode", "Back to mode selection")}>
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-virtua-muted">{tr("Serveur", "Server")}</span>
            <div className="flex gap-2">
              <input
                className="virtua-input min-w-0 flex-1"
                value={url}
                onChange={(event) => { setUrl(event.target.value); setProbe(null); setTrusted(false); }}
                placeholder="pve.example.lan:8006"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button type="button" className="virtua-button" disabled={busy || !url.trim()} onClick={() => void check()}>
                {tr("Vérifier", "Check")}
              </button>
            </div>
            <span className="text-[11px] leading-4 text-virtua-muted">{tr("Adresse de l'interface web Proxmox ; https et le port 8006 sont supposés.", "Address of the Proxmox web UI; https and port 8006 are assumed.")}</span>
          </label>

          {probe ? (
            <div className={`rounded border p-3 text-xs ${certChanged ? "border-virtua-red/60 bg-virtua-red/10" : "border-virtua-border bg-virtua-shade/10"}`}>
              <div className="mb-1.5 flex items-center gap-2 font-medium">
                {certChanged ? <ShieldAlert className="h-4 w-4 text-virtua-red" /> : <ShieldCheck className="h-4 w-4 text-virtua-accent" />}
                {certChanged
                  ? tr("Le certificat a changé depuis la dernière connexion", "The certificate changed since the last connection")
                  : tr("Certificat du serveur (SHA-256)", "Server certificate (SHA-256)")}
              </div>
              <code className="block break-all font-mono text-[11px] leading-5 text-virtua-text" data-testid="pve-fingerprint">{probe.fingerprint}</code>
              <p className="mt-1.5 leading-5 text-virtua-muted">
                {tr(
                  "Comparez avec Proxmox → nœud → Système → Certificats (pveproxy-ssl.pem ou pve-ssl.pem). Après confirmation, seul ce certificat sera accepté.",
                  "Compare with Proxmox → node → System → Certificates (pveproxy-ssl.pem or pve-ssl.pem). Once confirmed, only this certificate is accepted.",
                )}
              </p>
              <label className="mt-2 flex items-center gap-2 text-virtua-text">
                <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
                {tr("C'est bien le certificat de mon serveur", "This is my server's certificate")}
              </label>
            </div>
          ) : null}

          {probe && trusted ? (
            <>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-virtua-muted">{tr("Utilisateur (utilisateur@domaine)", "User (user@realm)")}</span>
                <input className="virtua-input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="root@pam" autoCapitalize="none" autoCorrect="off" />
              </label>

              <div className="grid grid-cols-2 gap-1 rounded bg-virtua-shade/20 p-1">
                {(["password", "token"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={`h-9 rounded text-sm ${method === m ? "bg-virtua-accent text-virtua-onAccent" : "text-virtua-muted hover:bg-virtua-panelHover"}`}
                  >
                    {m === "password" ? tr("Mot de passe", "Password") : tr("Jeton d'API", "API token")}
                  </button>
                ))}
              </div>

              {method === "password" ? (
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-virtua-muted">{tr("Mot de passe", "Password")}</span>
                  <div className="flex rounded border border-virtua-border bg-virtua-shade/20 focus-within:border-virtua-accent">
                    <input
                      className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm text-virtua-text outline-none"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} className="flex h-10 w-10 items-center justify-center text-virtua-muted hover:text-virtua-text">
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <span className="text-[11px] leading-4 text-virtua-muted">{tr("Rien n'est enregistré : il faudra se reconnecter au prochain lancement.", "Nothing is stored: you will sign in again next time.")}</span>
                </label>
              ) : (
                <>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-virtua-muted">{tr("Nom du jeton (Token ID)", "Token ID")}</span>
                    <input className="virtua-input" value={tokenId} onChange={(event) => setTokenId(event.target.value)} placeholder="virtua-desktop" autoCapitalize="none" autoCorrect="off" />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-virtua-muted">{tr("Secret", "Secret")}</span>
                    <input className="virtua-input font-mono" type="password" value={tokenSecret} onChange={(event) => setTokenSecret(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-virtua-text">
                    <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                    <KeyRound className="h-3.5 w-3.5 text-virtua-muted" />
                    {tr("Garder le secret dans le trousseau et se reconnecter seul", "Keep the secret in the keyring and reconnect automatically")}
                  </label>
                  <span className="text-[11px] leading-4 text-virtua-muted">
                    {tr(
                      "Proxmox → Datacenter → Permissions → API Tokens. Décochez « Privilege Separation » ou donnez au jeton ses propres droits.",
                      "Proxmox → Datacenter → Permissions → API Tokens. Untick “Privilege Separation” or give the token its own permissions.",
                    )}
                  </span>
                </>
              )}

              <button type="submit" className="virtua-button-primary h-10" disabled={busy || !username.trim() || (method === "password" ? !password : !tokenId.trim() || !tokenSecret.trim())}>
                {busy ? tr("Connexion…", "Connecting…") : tr("Se connecter", "Sign in")}
              </button>
            </>
          ) : null}

          {error ? <p className="rounded border border-virtua-red/50 bg-virtua-red/10 p-2 text-xs text-virtua-red" role="alert">{error}</p> : null}
        </div>
      </form>
    </div>
  );
}
