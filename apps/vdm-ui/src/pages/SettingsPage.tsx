import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import type { VdmUser as AuthUser } from "@/types/vdm";

interface VdmSettings { vdmName?: string; allowSelfSigned?: boolean; }
interface LogsConfig { enabled: boolean; minLevel: "warn" | "error" | "info"; retentionDays: number; categories: string[]; }
interface VdmUser { id: number; username: string; role: string; createdAt: string; }
interface VdmNode { name: string; displayName?: string; enabled: boolean; }
interface VdmHaStatus { enabled: boolean; available: boolean; controlNode: string | null; sharedPath?: string | null; output?: string; error?: string; }

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="vdm-card p-4 space-y-4">
      <h2 className="text-sm font-semibold text-vdm-text uppercase tracking-wider border-b border-vdm-border pb-2">{title}</h2>
      {children}
    </div>
  );
}

function AddUserModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (u: { username: string; password: string; role: string }) => void }) {
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-sm p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Add User</h3>
        <div><label className="vdm-label">Username</label><input className="vdm-input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></div>
        <div><label className="vdm-label">Password</label><input className="vdm-input" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></div>
        <div>
          <label className="vdm-label">Role</label>
          <select className="vdm-input" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="admin">Admin</option>

            <option value="viewer">Viewer</option>
          </select>
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (form.username && form.password) { onSave(form); onClose(); } }}>Create</button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { isAdmin, user } = useVdmAuth();
  const qc = useQueryClient();
  const [showAddUser, setShowAddUser] = useState(false);
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [haPath, setHaPath] = useState("");
  const [haNode, setHaNode] = useState("");

  const settingsQuery = useQuery<VdmSettings>({
    queryKey: ["vdm-settings"],
    queryFn: () => api.get("/api/vdm/settings"),
    enabled: isAdmin,
  });
  const usersQuery = useQuery<VdmUser[]>({
    queryKey: ["vdm-users"],
    queryFn: () => api.get("/api/vdm/users"),
    enabled: isAdmin,
  });
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes"), enabled: isAdmin });
  const haQuery = useQuery<VdmHaStatus>({ queryKey: ["vdm-ha"], queryFn: () => api.get("/api/vdm/ha"), enabled: isAdmin });
  const logsConfigQuery = useQuery<LogsConfig>({ queryKey: ["vdm-logs-config"], queryFn: () => api.get("/api/vdm/logs/config"), enabled: isAdmin });
  const saveLogsConfigMut = useMutation({
    mutationFn: (data: Partial<LogsConfig>) => api.put("/api/vdm/logs/config", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-logs-config"] }),
  });

  useEffect(() => {
    if (haQuery.data?.sharedPath) setHaPath(haQuery.data.sharedPath);
    if (haQuery.data?.controlNode) setHaNode(haQuery.data.controlNode);
  }, [haQuery.data?.sharedPath, haQuery.data?.controlNode]);

  const saveSettingsMut = useMutation({
    mutationFn: (data: VdmSettings) => api.put("/api/vdm/settings", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-settings"] }),
  });
  const addUserMut = useMutation({
    mutationFn: (data: { username: string; password: string; role: string }) => api.post("/api/vdm/users", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-users"] }),
  });
  const deleteUserMut = useMutation({
    mutationFn: (id: number) => api.delete(`/api/vdm/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-users"] }),
  });
  const haMut = useMutation({
    mutationFn: (enabled: boolean) => api.put("/api/vdm/ha", { enabled, controlNode: haNode, sharedPath: haPath }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vdm-ha"] }),
  });

  async function changePassword() {
    if (pwForm.next !== pwForm.confirm) { setPwMsg({ ok: false, text: "Passwords do not match" }); return; }
    try {
      await api.post("/api/vdm/auth/change-password", { currentPassword: pwForm.current, newPassword: pwForm.next });
      qc.setQueryData<AuthUser | null>(["vdm-me"], (current) => current ? { ...current, mustChangePassword: false } : current);
      setPwMsg({ ok: true, text: "Password changed successfully" });
      setPwForm({ current: "", next: "", confirm: "" });
    } catch { setPwMsg({ ok: false, text: "Failed to change password. Check current password." }); }
  }

  const settings = settingsQuery.data ?? {};
  const users = usersQuery.data ?? [];

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-lg font-semibold text-vdm-text">Settings</h1>
      {user?.mustChangePassword && <div className="rounded-lg border border-vdm-warning/40 bg-vdm-warning/10 px-3 py-2 text-sm text-vdm-warning">Change the temporary password before managing resources or opening consoles.</div>}

      {/* Change password (always visible) */}
      <SectionCard title="Change Password">
        <div className="space-y-3">
          <div><label className="vdm-label">Current Password</label><input className="vdm-input" type="password" value={pwForm.current} onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))} /></div>
          <div><label className="vdm-label">New Password</label><input className="vdm-input" type="password" value={pwForm.next} onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))} /></div>
          <div><label className="vdm-label">Confirm New Password</label><input className="vdm-input" type="password" value={pwForm.confirm} onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))} /></div>
          {pwMsg && <p className={`text-sm ${pwMsg.ok ? "text-vdm-success" : "text-vdm-danger"}`}>{pwMsg.text}</p>}
          <button className="vdm-btn-primary" onClick={changePassword}>Update Password</button>
        </div>
      </SectionCard>

      {/* Admin-only sections */}
      {isAdmin && (
        <>
          <SectionCard title="VDM Settings">
            <div className="space-y-3">
              <div>
                <label className="vdm-label">VDM Display Name</label>
                <input className="vdm-input" defaultValue={settings.vdmName ?? "AuxiNux VDM"}
                  onBlur={(e) => saveSettingsMut.mutate({ ...settings, vdmName: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-sm text-vdm-text cursor-pointer">
                <input type="checkbox" className="rounded" checked={settings.allowSelfSigned ?? true}
                  onChange={(e) => saveSettingsMut.mutate({ ...settings, allowSelfSigned: e.target.checked })} />
                Allow self-signed TLS certificates when connecting to nodes
              </label>
            </div>
          </SectionCard>

          <SectionCard title="LOGS — Journal opérationnel">
            {logsConfigQuery.isLoading ? (
              <p className="text-sm text-vdm-textMuted">Chargement…</p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-vdm-textMuted">
                  Capture les warnings/erreurs de VDM et des nœuds (montages, backups, migrations, nœuds hors ligne).
                  Consultation dans le menu <span className="font-mono text-vdm-text">LOGS</span>. Heures : stockées en UTC, affichées dans votre fuseau.
                </p>
                <label className="flex items-center gap-2 text-sm text-vdm-text cursor-pointer">
                  <input type="checkbox" className="rounded" checked={logsConfigQuery.data?.enabled ?? true}
                    onChange={(e) => saveLogsConfigMut.mutate({ enabled: e.target.checked })} />
                  Activer la collecte des LOGS
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="vdm-label">Niveau minimum capturé</label>
                    <select className="vdm-input" value={logsConfigQuery.data?.minLevel ?? "warn"}
                      onChange={(e) => saveLogsConfigMut.mutate({ minLevel: e.target.value as LogsConfig["minLevel"] })}>
                      <option value="warn">Warnings et erreurs (recommandé)</option>
                      <option value="error">Erreurs seulement</option>
                      <option value="info">Info, warnings et erreurs</option>
                    </select>
                  </div>
                  <div>
                    <label className="vdm-label">Rétention (jours, 1–365)</label>
                    <input className="vdm-input" type="number" min={1} max={365} defaultValue={logsConfigQuery.data?.retentionDays ?? 30}
                      onBlur={(e) => { const v = Number.parseInt(e.target.value, 10); if (v >= 1 && v <= 365) saveLogsConfigMut.mutate({ retentionDays: v }); }} />
                  </div>
                </div>
                <div>
                  <label className="vdm-label">Catégories collectées</label>
                  <div className="flex gap-2 flex-wrap">
                    {["storage", "backup", "migration", "nodes", "system"].map((c) => {
                      const active = logsConfigQuery.data?.categories?.includes(c) ?? true;
                      return (
                        <button key={c} type="button"
                          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${active
                            ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent"
                            : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/40"}`}
                          onClick={() => {
                            const cur = logsConfigQuery.data?.categories ?? [];
                            const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
                            if (next.length) saveLogsConfigMut.mutate({ categories: next });
                          }}>
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {saveLogsConfigMut.isError && <p className="text-sm text-vdm-danger">Échec de l'enregistrement : {(saveLogsConfigMut.error as Error).message}</p>}
              </div>
            )}
          </SectionCard>

          <SectionCard title="High Availability">
            <div className="space-y-3">
              <p className="text-sm text-vdm-textMuted">
                Pacemaker moves the single VDM LXC to another node when its active node fails. Quorum, fencing and cluster storage are mandatory.
              </p>
              <div>
                <label className="vdm-label">Control node</label>
                <select className="vdm-input" value={haNode} onChange={(e) => setHaNode(e.target.value)} disabled={haQuery.data?.enabled}>
                  <option value="">Select a node</option>
                  {(nodesQuery.data ?? []).filter((n) => n.enabled).map((n) => <option key={n.name} value={n.name}>{n.displayName || n.name}</option>)}
                </select>
              </div>
              <div>
                <label className="vdm-label">Cluster storage path on every node</label>
                <input className="vdm-input" value={haPath} onChange={(e) => setHaPath(e.target.value)} placeholder="/srv/virtua-ha/lxc" disabled={haQuery.data?.enabled} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className={`text-sm font-medium ${haQuery.data?.enabled ? "text-vdm-success" : "text-vdm-textMuted"}`}>
                  {haQuery.isLoading ? "Checking HA…" : haQuery.data?.enabled ? "HA active" : "HA inactive"}
                </span>
                {haQuery.data?.enabled ? (
                  <button className="vdm-btn-danger" disabled={haMut.isPending} onClick={() => { if (confirm("Disable automatic VDM failover?")) haMut.mutate(false); }}>Disable HA</button>
                ) : (
                  <button className="vdm-btn-primary" disabled={haMut.isPending || !haNode || !haPath} onClick={() => { if (confirm("Enable VDM HA after validating quorum, fencing and cluster storage?")) haMut.mutate(true); }}>Enable HA</button>
                )}
              </div>
              {(haMut.error || haQuery.data?.error) && <p className="text-sm text-vdm-danger">{haMut.error instanceof Error ? haMut.error.message : haQuery.data?.error}</p>}
              {haQuery.data?.output && <pre className="text-xs text-vdm-textMuted whitespace-pre-wrap max-h-32 overflow-auto">{haQuery.data.output}</pre>}
            </div>
          </SectionCard>

          <SectionCard title="User Management">
            <div className="flex justify-end mb-2">
              <button className="vdm-btn-primary text-xs" onClick={() => setShowAddUser(true)}>+ Add User</button>
            </div>
            <div className="vdm-card divide-y divide-vdm-border/50">
              {users.length === 0 ? (
                <p className="px-4 py-4 text-sm text-vdm-textMuted">No users</p>
              ) : users.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex-1">
                    <span className="font-medium text-vdm-text text-sm">{u.username}</span>
                    {u.username === user?.username && <span className="ml-2 text-xs text-vdm-accent">(you)</span>}
                  </div>
                  <span className="pill-gray capitalize text-xs">{u.role}</span>
                  <span className="text-xs text-vdm-textMuted hidden sm:block">{new Date(u.createdAt).toLocaleDateString()}</span>
                  {u.username !== user?.username && (
                    <button className="vdm-btn-danger text-xs" onClick={() => { if (confirm(`Delete user ${u.username}?`)) deleteUserMut.mutate(u.id); }}>Delete</button>
                  )}
                </div>
              ))}
            </div>
            <AddUserModal open={showAddUser} onClose={() => setShowAddUser(false)} onSave={(data) => addUserMut.mutate(data)} />
          </SectionCard>
        </>
      )}

      {/* Version info */}
      <div className="text-xs text-vdm-textMuted px-1">AuxiNux VDM — v{__APP_VERSION__}</div>
    </div>
  );
}
