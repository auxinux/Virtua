import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiPost } from "../api/client";

export default function ChangePassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const change = useMutation({
    mutationFn: () => apiPost("/api/auth/change-password", { currentPassword: current, newPassword: newPass }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["auth"] });
      qc.invalidateQueries({ queryKey: ["auth"] });
      navigate("/");
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPass !== confirm) { setError("Passwords do not match"); return; }
    if (newPass.length < 8) { setError("Password must be at least 8 characters"); return; }
    change.mutate();
  };

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-yellow-900/30 border border-yellow-700 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-text-100">{t("auth.changePassword")}</h1>
          <p className="text-sm text-text-400 mt-1 text-center">{t("auth.mustChangePassword")}</p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Current Password</label>
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">{t("auth.newPassword")}</label>
              <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Confirm New Password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
            </div>

            {error && (
              <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>
            )}

            <button type="submit" disabled={change.isPending} className="btn-primary w-full justify-center py-2">
              {change.isPending ? t("msg.loading") : t("action.save")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
