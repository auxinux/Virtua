import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut, apiPost } from "../../api/client";

interface MfaSettings {
  sms: { enabled: boolean; twilio: { accountSid: string; fromNumber: string; hasAuthToken: boolean } };
  email: { enabled: boolean; smtp: { host: string; port: number; secure: boolean; user: string; from: string; hasPass: boolean } };
}

/**
 * Admin-only global MFA configuration (Twilio SMS + SMTP email). When a channel
 * is globally disabled here, no user can enable that MFA method in their profile.
 */
export function MfaSettingsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery<MfaSettings>({ queryKey: ["settings", "mfa"], queryFn: () => apiGet("/api/settings/mfa") });

  // SMS / Twilio
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [accountSid, setAccountSid] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [authToken, setAuthToken] = useState("");      // write-only; blank = keep existing
  const [hasAuthToken, setHasAuthToken] = useState(false);

  // Email / SMTP
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState("");
  const [from, setFrom] = useState("");
  const [smtpPass, setSmtpPass] = useState("");          // write-only
  const [hasPass, setHasPass] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [emailTestTo, setEmailTestTo] = useState("");
  const [emailTestMsg, setEmailTestMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setSmsEnabled(data.sms.enabled);
    setAccountSid(data.sms.twilio.accountSid);
    setFromNumber(data.sms.twilio.fromNumber);
    setHasAuthToken(data.sms.twilio.hasAuthToken);
    setEmailEnabled(data.email.enabled);
    setHost(data.email.smtp.host);
    setPort(data.email.smtp.port);
    setSecure(data.email.smtp.secure);
    setSmtpUser(data.email.smtp.user);
    setFrom(data.email.smtp.from);
    setHasPass(data.email.smtp.hasPass);
  }, [data]);

  const save = useMutation({
    mutationFn: () => apiPut("/api/settings/mfa", {
      sms: { enabled: smsEnabled, twilio: { accountSid, fromNumber, ...(authToken ? { authToken } : {}) } },
      email: { enabled: emailEnabled, smtp: { host, port, secure, user: smtpUser, from, ...(smtpPass ? { pass: smtpPass } : {}) } },
    }),
    onSuccess: () => { setAuthToken(""); setSmtpPass(""); qc.invalidateQueries({ queryKey: ["settings", "mfa"] }); },
  });

  const testSms = useMutation({
    mutationFn: () => apiPost("/api/settings/mfa/test-sms", { to: testTo }),
    onSuccess: () => setTestMsg(t("mfa.testOk", "Envoyé ✓")),
    onError: (e: Error) => setTestMsg(e.message),
  });
  const testEmail = useMutation({
    mutationFn: () => apiPost("/api/settings/mfa/test-email", { to: emailTestTo }),
    onSuccess: () => setEmailTestMsg(t("mfa.testOk", "Envoyé ✓")),
    onError: (e: Error) => setEmailTestMsg(e.message),
  });

  return (
    <div className="card p-5 space-y-5">
      <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("mfa.title", "MFA — SMS & e-mail")}</h2>
      <p className="text-xs text-text-500 -mt-2">
        {t("mfa.help", "Si un canal est désactivé ici, aucun utilisateur ne peut l'activer dans son profil.")}
      </p>

      {/* SMS / Twilio */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-text-200">
          <input type="checkbox" checked={smsEnabled} onChange={(e) => setSmsEnabled(e.target.checked)} />
          {t("mfa.smsEnable", "Activer le MFA par SMS (Twilio)")}
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Account SID</label>
            <input className="input" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="ACxxxxxxxx" />
          </div>
          <div>
            <label className="label">{t("mfa.fromNumber", "Numéro expéditeur")}</label>
            <input className="input" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} placeholder="+15145551234" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Auth Token {hasAuthToken && <span className="text-2xs text-emerald-400">({t("mfa.configured", "configuré")})</span>}</label>
            <input className="input" type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={hasAuthToken ? "•••••••• (laisser vide pour garder)" : "Auth Token"} />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <input className="input max-w-xs" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={t("mfa.testSmsTo", "Tester: +15145551234")} />
          <button className="btn-secondary btn-sm" disabled={testSms.isPending || !testTo} onClick={() => { setTestMsg(null); testSms.mutate(); }}>
            {testSms.isPending ? t("msg.loading", "…") : t("mfa.testSms", "Tester le SMS")}
          </button>
          {testMsg && <span className="text-xs text-text-400">{testMsg}</span>}
        </div>
      </div>

      <div className="border-t border-surface-700" />

      {/* Email / SMTP */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-text-200">
          <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
          {t("mfa.emailEnable", "Activer le MFA par e-mail (SMTP)")}
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("mfa.smtpHost", "Serveur SMTP")}</label>
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.exemple.com" />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input" type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value, 10) || 587)} />
          </div>
          <div>
            <label className="label">{t("mfa.smtpUser", "Utilisateur")}</label>
            <input className="input" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <label className="label">{t("mfa.smtpPass", "Mot de passe")} {hasPass && <span className="text-2xs text-emerald-400">({t("mfa.configured", "configuré")})</span>}</label>
            <input className="input" type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder={hasPass ? "•••••••• (laisser vide pour garder)" : ""} autoComplete="new-password" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">{t("mfa.smtpFrom", "Adresse expéditeur (From)")}</label>
            <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Virtua <no-reply@exemple.com>" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-300">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          {t("mfa.smtpSecure", "TLS implicite (port 465). Décoché = STARTTLS / 587.")}
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <input className="input max-w-xs" value={emailTestTo} onChange={(e) => setEmailTestTo(e.target.value)} placeholder={t("mfa.testEmailTo", "Tester: vous@exemple.com")} />
          <button className="btn-secondary btn-sm" disabled={testEmail.isPending || !emailTestTo} onClick={() => { setEmailTestMsg(null); testEmail.mutate(); }}>
            {testEmail.isPending ? t("msg.loading", "…") : t("mfa.testEmail", "Tester l'e-mail")}
          </button>
          {emailTestMsg && <span className="text-xs text-text-400">{emailTestMsg}</span>}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t("msg.loading", "…") : t("action.save", "Enregistrer")}
        </button>
        {save.isSuccess && <span className="text-xs text-emerald-400">{t("msg.saved", "Enregistré")}</span>}
        {save.error && <span className="text-xs text-red-400">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}
