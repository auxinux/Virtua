import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiDelete } from "../api/client";
import { ConfirmModal } from "../components/ui/Modal";
import { useAuth } from "../utils/useAuth";

interface DesktopDevice {
  id: string;
  name: string;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
}

export default function DesktopDevicesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();

  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const account = useQuery<{ desktopEnabled: boolean }>({
    queryKey: ["desktop", "account"],
    queryFn: () => apiGet("/api/desktop/account"),
  });

  const devices = useQuery<DesktopDevice[]>({
    queryKey: ["desktop", "my-devices"],
    queryFn: () => apiGet("/api/desktop/my-devices"),
    refetchInterval: 15_000,
  });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => apiPut<{ desktopEnabled: boolean }>("/api/desktop/account", { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop", "account"] }),
  });

  const revokeAll = useMutation({
    mutationFn: () => apiPost("/api/desktop/my-devices/revoke-all", {}),
    onSuccess: () => { setConfirmRevokeAll(false); qc.invalidateQueries({ queryKey: ["desktop", "my-devices"] }); },
  });

  const genCode = useMutation({
    mutationFn: () => apiPost<{ code: string; expiresInMs: number }>("/api/desktop/pairing-codes", {}),
    onSuccess: (res) => {
      setCode(res.code);
      setExpiresAt(Date.now() + res.expiresInMs);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/desktop/my-devices/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop", "my-devices"] }),
  });
  const purge = useMutation({
    mutationFn: () => apiPost("/api/desktop/my-devices/purge-revoked", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop", "my-devices"] }),
  });
  const revokedCount = (devices.data ?? []).filter((d) => d.revoked).length;

  // Countdown for the pairing code.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) { setCode(null); setExpiresAt(null); }
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [expiresAt]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-100">{t("account.title", "Configuration de mon compte")}</h1>
        <p className="text-sm text-text-400 mt-1">
          {t("account.subtitle", "Gère l'accès Virtua Desktop pour ton compte.")} {user ? `(${user.username})` : ""}
        </p>
      </div>

      <ChangePasswordCard />
      <MfaCard />

      {/* Virtua Desktop settings: global allow switch + revoke all */}
      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-200">{t("desktop.settingsTitle", "Paramètres Virtua Desktop")}</h2>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-text-200">{t("desktop.allowTitle", "Autoriser Virtua Desktop")}</div>
            <p className="text-xs text-text-500 mt-0.5 max-w-md">
              {t("desktop.allowHelp", "Si désactivé, aucun client Virtua Desktop ne peut se connecter ni rester actif sur ce compte. Les sessions en cours sont coupées immédiatement.")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={account.data?.desktopEnabled ?? true}
            disabled={account.isLoading || setEnabled.isPending}
            onClick={() => setEnabled.mutate(!(account.data?.desktopEnabled ?? true))}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${ (account.data?.desktopEnabled ?? true) ? "bg-accent-blue" : "bg-surface-500"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${ (account.data?.desktopEnabled ?? true) ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        {account.data && !account.data.desktopEnabled && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
            {t("desktop.allowDisabledNote", "Virtua Desktop est actuellement désactivé pour ce compte.")}
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-surface-700 pt-4">
          <div>
            <div className="text-sm text-text-200">{t("desktop.revokeAllTitle", "Tout révoquer")}</div>
            <p className="text-xs text-text-500 mt-0.5 max-w-md">
              {t("desktop.revokeAllHelp", "Déconnecte et révoque immédiatement tous les appareils Virtua Desktop de ce compte.")}
            </p>
          </div>
          <button
            className="btn-danger btn-sm whitespace-nowrap"
            disabled={revokeAll.isPending || (devices.data?.filter((d) => !d.revoked).length ?? 0) === 0}
            onClick={() => setConfirmRevokeAll(true)}
          >
            {t("desktop.revokeAllBtn", "Tout révoquer")}
          </button>
        </div>
      </div>

      {/* Pairing code */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-text-200 mb-1">{t("desktop.pairTitle", "Code d'appairage")}</h2>
        <p className="text-xs text-text-500 mb-4">
          {t("desktop.pairHelp", "Génère un code à saisir dans l'app Desktop (Appairage). Valable quelques minutes, à usage unique. Plus sûr que de taper ton mot de passe dans l'app.")}
        </p>

        {code ? (
          <div className="flex items-center gap-4">
            <div className="font-mono text-3xl tracking-[0.3em] text-accent-blue bg-black/30 border border-surface-500 rounded-lg px-6 py-4 select-all">
              {code}
            </div>
            <div className="text-sm">
              <div className="text-text-300">{t("desktop.expiresIn", "Expire dans")} <span className="font-mono">{mins}:{String(secs).padStart(2, "0")}</span></div>
              <button onClick={() => navigator.clipboard?.writeText(code).catch(() => {})} className="btn-secondary btn-sm mt-2">
                {t("action.copy", "Copier")}
              </button>
              <button onClick={() => genCode.mutate()} className="btn-ghost btn-sm mt-2 ml-2" disabled={genCode.isPending}>
                {t("desktop.regenerate", "Régénérer")}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => genCode.mutate()} className="btn-primary" disabled={genCode.isPending}>
            {genCode.isPending ? t("msg.loading", "…") : t("desktop.generate", "Générer un code d'appairage")}
          </button>
        )}
        {genCode.error && <p className="text-sm text-red-400 mt-3">{(genCode.error as Error).message}</p>}
      </div>

      {/* Paired devices */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-600 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-200">{t("desktop.devicesTitle", "Mes appareils")}</h2>
          <div className="flex items-center gap-3">
            {revokedCount > 0 && (
              <button className="btn-ghost btn-sm text-text-400" disabled={purge.isPending} onClick={() => purge.mutate()}>
                {purge.isPending ? t("msg.loading", "…") : t("desktop.purgeRevoked", "Nettoyer les révoqués")} ({revokedCount})
              </button>
            )}
            <span className="text-2xs text-text-500">{devices.data?.length ?? 0}</span>
          </div>
        </div>
        {devices.isLoading ? (
          <div className="p-6 text-center text-text-500 text-sm">{t("msg.loading", "Chargement…")}</div>
        ) : (devices.data?.length ?? 0) === 0 ? (
          <div className="p-6 text-center text-text-500 text-sm">{t("desktop.noDevices", "Aucun appareil appairé")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600 text-text-400">
                <th className="px-5 py-2 text-left font-medium">{t("desktop.device", "Appareil")}</th>
                <th className="px-5 py-2 text-left font-medium">{t("desktop.lastSeen", "Vu")}</th>
                <th className="px-5 py-2 text-left font-medium">IP</th>
                <th className="px-5 py-2 text-left font-medium">{t("common.status", "État")}</th>
                <th className="px-5 py-2 text-right font-medium">{t("common.actions", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {devices.data!.map((d) => (
                <tr key={d.id} className="border-b border-surface-700">
                  <td className="px-5 py-2.5 text-text-200 font-medium">{d.name}</td>
                  <td className="px-5 py-2.5 text-text-400 text-xs">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}</td>
                  <td className="px-5 py-2.5 text-text-400 text-xs font-mono">{d.lastIp ?? "—"}</td>
                  <td className="px-5 py-2.5">
                    {d.revoked
                      ? <span className="text-xs text-red-400">{t("desktop.revoked", "révoqué")}</span>
                      : <span className="text-xs text-emerald-400">{t("status.active", "actif")}</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {d.revoked ? (
                      <button onClick={() => revoke.mutate(d.id)} disabled={revoke.isPending} className="btn-ghost btn-sm text-text-400" title={t("desktop.removeBtn", "Supprimer de la liste")}>
                        {t("action.delete", "Supprimer")} ✕
                      </button>
                    ) : (
                      <button onClick={() => revoke.mutate(d.id)} disabled={revoke.isPending} className="btn-danger btn-sm">
                        {t("desktop.revokeBtn", "Révoquer")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal
        open={confirmRevokeAll}
        onClose={() => setConfirmRevokeAll(false)}
        onConfirm={() => revokeAll.mutate()}
        loading={revokeAll.isPending}
        dangerous
        title={t("desktop.revokeAllTitle", "Tout révoquer")}
        message={t("desktop.revokeAllConfirm", "Révoquer tous les appareils Virtua Desktop de ce compte ? Ils devront se reconnecter.")}
        confirmLabel={t("desktop.revokeAllBtn", "Tout révoquer")}
      />
    </div>
  );
}

// ─── Change password ────────────────────────────────────────────────────────
function ChangePasswordCard() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => apiPost("/api/auth/change-password", { currentPassword: current, newPassword: next }),
    onSuccess: () => { setDone(true); setCurrent(""); setNext(""); setConfirm(""); setTimeout(() => setDone(false), 4000); },
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length > 0 && next === confirm && !change.isPending;

  return (
    <div className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-text-200">{t("account.changePassword", "Changer mon mot de passe")}</h2>
      <div className="grid gap-3 max-w-sm">
        <input type="password" className="input" autoComplete="current-password" placeholder={t("account.currentPassword", "Mot de passe actuel")} value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input type="password" className="input" autoComplete="new-password" placeholder={t("account.newPassword", "Nouveau mot de passe")} value={next} onChange={(e) => setNext(e.target.value)} />
        <input type="password" className="input" autoComplete="new-password" placeholder={t("account.confirmPassword", "Confirmer le nouveau mot de passe")} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {mismatch && <p className="text-xs text-red-400">{t("account.passwordMismatch", "Les mots de passe ne correspondent pas.")}</p>}
      {change.error && <p className="text-xs text-red-400">{(change.error as Error).message}</p>}
      {done && <p className="text-xs text-emerald-400">{t("account.passwordChanged", "Mot de passe mis à jour.")}</p>}
      <button className="btn-primary btn-sm" disabled={!canSubmit} onClick={() => change.mutate()}>
        {change.isPending ? t("msg.loading", "…") : t("account.changePassword", "Changer mon mot de passe")}
      </button>
    </div>
  );
}

// ─── MFA (SMS + email) ──────────────────────────────────────────────────────
interface MfaStatus {
  smsAvailable: boolean;
  emailAvailable: boolean;
  sms: { enabled: boolean; phoneVerified: boolean; phone: string | null };
  email: { enabled: boolean; emailVerified: boolean; email: string | null };
}

function MfaCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery<MfaStatus>({ queryKey: ["account", "mfa"], queryFn: () => apiGet("/api/account/mfa") });

  if (status.isLoading) return null;
  const s = status.data;
  if (!s) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["account", "mfa"] });

  return (
    <div className="card p-5 space-y-5">
      <h2 className="text-sm font-semibold text-text-200">{t("account.mfaTitle", "Authentification à deux facteurs (MFA)")}</h2>

      <MfaChannel
        kind="sms"
        available={s.smsAvailable}
        enabled={s.sms.enabled}
        masked={s.sms.phone}
        onChange={refresh}
      />
      <div className="border-t border-surface-700" />
      <MfaChannel
        kind="email"
        available={s.emailAvailable}
        enabled={s.email.enabled}
        masked={s.email.email}
        onChange={refresh}
      />
    </div>
  );
}

function MfaChannel({ kind, available, enabled, masked, onChange }: {
  kind: "sms" | "email"; available: boolean; enabled: boolean; masked: string | null; onChange: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [dest, setDest] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const title = kind === "sms" ? t("account.mfaSms", "MFA par SMS") : t("account.mfaEmail", "MFA par e-mail");
  const path = `/api/account/mfa/${kind}`;
  const destField = kind === "sms" ? "phone" : "email";

  const start = useMutation({
    mutationFn: () => apiPost<{ sentTo: string }>(`${path}/start`, dest ? { [destField]: dest } : {}),
    onSuccess: (r) => { setSentTo(r.sentTo); setStep("code"); },
  });
  const confirm = useMutation({
    mutationFn: () => apiPost(`${path}/confirm`, { code }),
    onSuccess: () => { setStep("idle"); setCode(""); setDest(""); onChange(); },
  });
  const disable = useMutation({
    mutationFn: () => apiPost(`${path}/disable`, {}),
    onSuccess: () => onChange(),
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm text-text-200">{title}</div>
          {!available ? (
            <p className="text-xs text-text-500 mt-0.5">{t("account.mfaUnavailable", "Désactivé par l'administrateur.")}</p>
          ) : enabled ? (
            <p className="text-xs text-emerald-400 mt-0.5">{t("account.mfaEnabledOn", "Activé")} {masked ? `(${masked})` : ""}</p>
          ) : (
            <p className="text-xs text-text-500 mt-0.5">{t("account.mfaDisabled", "Désactivé")}</p>
          )}
        </div>
        {available && enabled && (
          <button className="btn-secondary btn-sm" disabled={disable.isPending} onClick={() => disable.mutate()}>
            {t("action.disable", "Désactiver")}
          </button>
        )}
      </div>

      {available && !enabled && step === "idle" && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input
            className="input max-w-xs"
            placeholder={kind === "sms" ? t("account.phonePlaceholder", "+15145551234") : t("account.emailPlaceholder", "vous@exemple.com")}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          />
          <button className="btn-primary btn-sm" disabled={start.isPending || (kind === "sms" && !dest)} onClick={() => start.mutate()}>
            {start.isPending ? t("msg.loading", "…") : t("account.mfaSendCode", "Envoyer le code")}
          </button>
        </div>
      )}

      {available && !enabled && step === "code" && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-text-400">{t("account.mfaCodeSent", "Code envoyé à")} {sentTo}. {t("account.mfaCodeTtl", "Valable 30 minutes.")}</p>
          <div className="flex items-center gap-2">
            <input className="input w-32 font-mono tracking-widest" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <button className="btn-primary btn-sm" disabled={confirm.isPending || code.length !== 6} onClick={() => confirm.mutate()}>
              {confirm.isPending ? t("msg.loading", "…") : t("account.mfaConfirm", "Confirmer")}
            </button>
            <button className="btn-ghost btn-sm" disabled={start.isPending} onClick={() => start.mutate()}>{t("account.mfaResend", "Renvoyer")}</button>
          </div>
        </div>
      )}

      {start.error && <p className="text-xs text-red-400 mt-2">{(start.error as Error).message}</p>}
      {confirm.error && <p className="text-xs text-red-400 mt-2">{(confirm.error as Error).message}</p>}
    </div>
  );
}
