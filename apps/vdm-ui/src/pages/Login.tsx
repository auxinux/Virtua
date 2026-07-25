import { useState } from "react";
import { useVdmAuth } from "@/hooks/useVdmAuth";

export default function Login() {
  const { login, loginError, isLoggingIn } = useVdmAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login({ username, password });
    } catch {}
  };

  return (
    <div className="min-h-screen bg-vdm-bg flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-vdm-accent/10 border border-vdm-accent/20 mb-4">
            <svg className="w-8 h-8 text-vdm-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-vdm-text">Virtua VDM</h1>
          <p className="text-sm text-vdm-textMuted mt-1">Datacenter Manager</p>
        </div>

        <form onSubmit={handleSubmit} className="vdm-card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-vdm-text mb-4">Sign in to your account</h2>

          {loginError && (
            <div className="px-3 py-2.5 bg-vdm-danger/10 border border-vdm-danger/30 rounded text-sm text-vdm-danger">
              {loginError}
            </div>
          )}

          <div>
            <label className="vdm-label">Username</label>
            <input
              type="text"
              className="vdm-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="vdm-label">Password</label>
            <input
              type="password"
              className="vdm-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="vdm-btn-primary w-full justify-center py-2"
            disabled={isLoggingIn}
          >
            {isLoggingIn ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing in...
              </span>
            ) : "Sign in"}
          </button>
        </form>

        <p className="text-center text-xs text-vdm-textMuted mt-5">
          Virtua VDM v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
