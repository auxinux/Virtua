import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiDelete } from "../../api/client";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { ScopeNotice } from "../../components/ui/ScopeNotice";
import type { User } from "@auxinux/shared";

// Extended User type with resource counts returned by the API
interface UserWithStats extends User {
  vmCount?: number;
  lxcCount?: number;
  dockerCount?: number;
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
      role === "ADMIN"
        ? "bg-purple-900/30 text-purple-400 border border-purple-800"
        : "bg-surface-700 text-text-400 border border-surface-500"
    }`}>
      {role}
    </span>
  );
}

function ResourceCountBadge({ count, icon, label }: { count: number; icon: string; label: string }) {
  if (count === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-surface-600 text-text-300 border border-surface-500"
      title={`${count} ${label}`}
    >
      <span>{icon}</span>
      <span className="font-medium">{count}</span>
    </span>
  );
}

function CreateUserModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "USER">("USER");
  const [mustChangePassword, setMustChangePassword] = useState(true);
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () =>
      apiPost("/api/users", { username, password, displayName, email, role, mustChangePassword }),
    onSuccess: () => {
      onCreated();
      onClose();
      setUsername(""); setPassword(""); setDisplayName(""); setEmail("");
      setRole("USER"); setMustChangePassword(true); setError("");
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={open} title={t("modal.createUser")} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Username *</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="john_doe"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "USER")}>
              <option value="USER">USER — Client</option>
              <option value="ADMIN">ADMIN — Full access</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">Password *</label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className="text-xs text-text-500 mt-1">Minimum 8 characters</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Display Name</label>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={mustChangePassword}
            onChange={(e) => setMustChangePassword(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm text-text-300">Require password change on first login</span>
        </label>
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => create.mutate()}
            disabled={!username || !password || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? "Creating…" : "Create User"}
          </button>
          <button onClick={onClose} className="btn">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

export default function UserList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data: users = [], isLoading } = useQuery<UserWithStats[]>({
    queryKey: ["users"],
    queryFn: () => apiGet<UserWithStats[]>("/api/users"),
  });

  const toggleSuspend = useMutation({
    mutationFn: ({ id, suspended }: { id: number; suspended: boolean }) =>
      apiPut(`/api/users/${id}/suspend`, { suspended }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const deleteUser = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/users/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const filteredUsers = search.trim()
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(search.toLowerCase()) ||
          (u.displayName ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (u.email ?? "").toLowerCase().includes(search.toLowerCase())
      )
    : users;

  const adminCount = users.filter((u) => u.role === "ADMIN").length;
  const activeCount = users.filter((u) => !u.suspended).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">Users</h1>
          <p className="text-xs text-text-500 mt-0.5">
            {users.length} total · {activeCount} active · {adminCount} admin
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search users…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-sm w-48"
          />
          <button onClick={() => setCreateOpen(true)} className="btn-primary">
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New User
          </button>
        </div>
      </div>

      <ScopeNotice title={t("scope.controlPlaneTitle")}>
        {t("scope.usersControlPlaneDesc")}
      </ScopeNotice>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Users", value: users.length, color: "text-text-200" },
          { label: "Active", value: activeCount, color: "text-green-400" },
          { label: "Suspended", value: users.length - activeCount, color: "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="card px-4 py-3 flex items-center justify-between">
            <span className="text-xs text-text-500">{stat.label}</span>
            <span className={`text-lg font-bold ${stat.color}`}>{stat.value}</span>
          </div>
        ))}
      </div>

      {/* User table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-600">
              <th className="px-4 py-3 text-left text-text-400 font-medium">User</th>
              <th className="px-4 py-3 text-left text-text-400 font-medium">Role</th>
              <th className="px-4 py-3 text-left text-text-400 font-medium">Resources</th>
              <th className="px-4 py-3 text-left text-text-400 font-medium">Status</th>
              <th className="px-4 py-3 text-left text-text-400 font-medium">Created</th>
              <th className="px-4 py-3 text-right text-text-400 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-text-500">
                  {search ? `No users match "${search}"` : "No users found"}
                </td>
              </tr>
            ) : filteredUsers.map((user) => (
              <tr key={user.id} className="border-b border-surface-700 hover:bg-surface-700/30 transition-colors">
                <td className="px-4 py-3">
                  <Link to={`/users/${user.id}`} className="text-accent-blue hover:underline font-medium">
                    {user.username}
                  </Link>
                  {user.displayName && (
                    <div className="text-xs text-text-400">{user.displayName}</div>
                  )}
                  {user.email && (
                    <div className="text-xs text-text-500">{user.email}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <RoleBadge role={user.role} />
                </td>
                <td className="px-4 py-3">
                  {user.role === "ADMIN" ? (
                    <span className="text-xs text-purple-400">Full access</span>
                  ) : (
                    <div className="flex items-center gap-1">
                      <ResourceCountBadge count={user.vmCount ?? 0} icon="🖥" label="VMs" />
                      <ResourceCountBadge count={user.lxcCount ?? 0} icon="📦" label="LXC" />
                      <ResourceCountBadge count={user.dockerCount ?? 0} icon="🐳" label="Docker" />
                      {!user.vmCount && !user.lxcCount && !user.dockerCount && (
                        <span className="text-xs text-text-500 italic">no resources</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {user.suspended ? (
                    <span className="inline-flex items-center gap-1 text-xs text-red-400">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524L13.477 14.89zm1.414-1.414A6 6 0 006.524 5.11L14.89 13.477zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clipRule="evenodd" />
                      </svg>
                      Suspended
                    </span>
                  ) : user.mustChangePassword ? (
                    <span className="inline-flex items-center gap-1 text-xs text-yellow-400">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      Must change pwd
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-green-400">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                      Active
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-400 text-xs">
                  {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Link
                      to={`/users/${user.id}`}
                      className="p-1.5 rounded text-text-400 hover:bg-surface-600 transition-colors"
                      title={t("modal.editAssignResources")}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </Link>
                    <button
                      onClick={() => toggleSuspend.mutate({ id: user.id, suspended: !user.suspended })}
                      disabled={toggleSuspend.isPending}
                      className={`p-1.5 rounded transition-colors ${
                        user.suspended
                          ? "text-green-400 hover:bg-green-900/30"
                          : "text-yellow-400 hover:bg-yellow-900/30"
                      }`}
                      title={user.suspended ? "Unsuspend user" : "Suspend user"}
                    >
                      {user.suspended ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                      )}
                    </button>
                    {user.role !== "ADMIN" && (
                      <button
                        onClick={() => setDeleteTarget(user.id)}
                        className="p-1.5 rounded text-red-400 hover:bg-red-900/30 transition-colors"
                        title={t("modal.deleteUser")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["users"] })}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title={t("modal.deleteUser")}
        message="Delete this user? Their VMs and containers will not be deleted but will become unowned."
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteTarget !== null && deleteUser.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteUser.isPending}
      />
    </div>
  );
}
