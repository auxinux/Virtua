import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiPost } from "../api/client";
import i18n, { changeAppLanguage, getAvailableLanguages, type UiLanguage } from "../i18n";
import auxinuxLogo from "../assets/logo-AuxiNux.png";

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [mfa, setMfa] = useState<{ method: "sms" | "email"; sentTo: string } | null>(null);
  const [code, setCode] = useState("");

  const { data: languages = [] } = useQuery<UiLanguage[]>({
    queryKey: ["ui", "languages"],
    queryFn: () => getAvailableLanguages(),
    staleTime: 5 * 60 * 1000,
  });

  const completeLogin = (data: { user: { mustChangePassword: boolean } }) => {
    // Mark the start of this session so TaskDrawer only shows tasks created after login
    sessionStorage.setItem("tasksSince", new Date().toISOString());
    qc.removeQueries({ queryKey: ["auth"] });
    qc.invalidateQueries({ queryKey: ["auth"] });
    navigate(data.user.mustChangePassword ? "/change-password" : "/");
  };

  type LoginResult = { ok: boolean; mfaRequired?: boolean; method?: "sms" | "email"; sentTo?: string; user?: { mustChangePassword: boolean } };
  const login = useMutation({
    mutationFn: () => apiPost<LoginResult>("/api/auth/login", { username, password }),
    onSuccess: (data) => {
      if (data.mfaRequired && data.method) {
        setMfa({ method: data.method, sentTo: data.sentTo ?? "" });
        setCode("");
        return;
      }
      if (data.user) completeLogin({ user: data.user });
    },
    onError: (err: Error) => setError(err.message),
  });

  const verifyMfa = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; user: { mustChangePassword: boolean } }>("/api/auth/mfa/verify", { code }),
    onSuccess: (data) => completeLogin(data),
    onError: (err: Error) => setError(err.message),
  });

  const resendMfa = useMutation({
    mutationFn: () => apiPost<{ sentTo: string }>("/api/auth/mfa/resend", {}),
    onSuccess: (r) => setMfa((m) => (m ? { ...m, sentTo: r.sentTo } : m)),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (mfa) verifyMfa.mutate();
    else login.mutate();
  };

  const backToCredentials = () => { setMfa(null); setCode(""); setError(""); };

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-3">
          <select
            value={i18n.language.toUpperCase()}
            onChange={(e) => { void changeAppLanguage(e.target.value); }}
            className="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-text-300"
            aria-label={t("auth.language")}
          >
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.code} · {language.nativeName}
              </option>
            ))}
          </select>
        </div>

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img
            src={auxinuxLogo}
            alt="AuxiNux"
            className="w-32 sm:w-36 h-auto object-contain drop-shadow-[0_14px_36px_rgba(34,139,230,0.2)]"
          />
          <div className="mt-5 text-sm font-semibold uppercase tracking-[0.42em] text-text-300 pl-[0.42em]">
            Virtua
          </div>
          <p className="text-sm text-text-500 mt-2">{t("brand.product")}</p>
        </div>

        {/* Form */}
        <div className="card p-6">
          {!mfa ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">{t("auth.username")}</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="input"
                  placeholder="admin"
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div>
                <label className="label">{t("auth.password")}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              {error && (
                <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={login.isPending || !username || !password}
                className="btn-primary w-full justify-center py-2"
              >
                {login.isPending ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {t("msg.loading")}
                  </span>
                ) : t("auth.login")}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">{t("auth.mfaCode", "Code de vérification")}</label>
                <p className="text-xs text-text-500 mb-2">
                  {mfa.method === "sms"
                    ? t("auth.mfaSentSms", "Un code a été envoyé par SMS au")
                    : t("auth.mfaSentEmail", "Un code a été envoyé par e-mail au")} {mfa.sentTo}.
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="input text-center font-mono text-lg tracking-[0.4em]"
                  placeholder="000000"
                  autoFocus
                  autoComplete="one-time-code"
                />
              </div>

              {error && (
                <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={verifyMfa.isPending || code.length !== 6}
                className="btn-primary w-full justify-center py-2"
              >
                {verifyMfa.isPending ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {t("msg.loading")}
                  </span>
                ) : t("auth.mfaVerify", "Vérifier")}
              </button>

              <div className="flex items-center justify-between text-xs">
                <button type="button" onClick={backToCredentials} className="text-text-400 hover:text-text-200">
                  ← {t("auth.back", "Retour")}
                </button>
                <button type="button" onClick={() => resendMfa.mutate()} disabled={resendMfa.isPending} className="text-accent-blue hover:underline">
                  {t("auth.mfaResend", "Renvoyer le code")}
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-2xs text-text-500 mt-6">
          {t("brand.full")} v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
