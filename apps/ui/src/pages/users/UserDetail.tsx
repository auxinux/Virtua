import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut } from "../../api/client";
import { Tabs } from "../../components/ui/Tabs";
import type { ResourceAclEntry, ResourceCatalogEntry, User, UserLimits } from "@auxinux/shared";

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "password", label: "Password" },
  { key: "limits", label: "Limits & Permissions" },
  { key: "acl", label: "Resource ACL" },
];

// ─── Profile Tab ───────────────────────────────────────────────────────────────
function ProfileTab({ user }: { user: User }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [email, setEmail] = useState(user.email || "");
  const [role, setRole] = useState(user.role);
  const [mustChangePwd, setMustChangePwd] = useState(user.mustChangePassword);
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: () => apiPut(`/api/users/${user.id}`, { displayName, email, role, mustChangePassword: mustChangePwd }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users", user.id] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="card p-5 max-w-md space-y-4">
      <div>
        <label className="label">Username</label>
        <input className="input" value={user.username} disabled />
      </div>
      <div>
        <label className="label">Display Name</label>
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div>
        <label className="label">Email</label>
        <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label">Role</label>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "USER")}>
          <option value="USER">USER</option>
          <option value="ADMIN">ADMIN</option>
        </select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="w-4 h-4 accent-accent-blue"
          checked={mustChangePwd}
          onChange={(e) => setMustChangePwd(e.target.checked)}
        />
        <span className="text-sm text-text-300">Force password change on next login</span>
      </label>
      <div className="flex items-center gap-3">
        <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving..." : "Save Changes"}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved!</span>}
      </div>
    </div>
  );
}

// ─── Password Tab ──────────────────────────────────────────────────────────────
function PasswordTab({ userId }: { userId: number }) {
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: () => apiPut(`/api/users/${userId}/password`, { newPassword: newPass }),
    onSuccess: () => {
      setNewPass(""); setConfirm(""); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPass !== confirm) { setError("Passwords do not match"); return; }
    if (newPass.length < 8) { setError("Password must be at least 8 characters"); return; }
    update.mutate();
  };

  return (
    <div className="card p-5 max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">New Password</label>
          <input type="password" className="input" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        </div>
        <div>
          <label className="label">Confirm Password</label>
          <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={update.isPending} className="btn-primary">
            {update.isPending ? "Saving..." : "Set Password"}
          </button>
          {saved && <span className="text-green-400 text-sm">Password updated!</span>}
        </div>
      </form>
    </div>
  );
}

// ─── Limits Tab ────────────────────────────────────────────────────────────────
function LimitsTab({ userId }: { userId: number }) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [limits, setLimits] = useState<Partial<UserLimits>>({});

  const { data } = useQuery<UserLimits>({
    queryKey: ["users", userId, "limits"],
    queryFn: () => apiGet<UserLimits>(`/api/users/${userId}/limits`),
  });

  useEffect(() => {
    if (data) setLimits(data);
  }, [data]);

  const update = useMutation({
    mutationFn: () => apiPut(`/api/users/${userId}/limits`, limits),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users", userId, "limits"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const setLimit = (key: keyof UserLimits, value: unknown) =>
    setLimits((l) => ({ ...l, [key]: value }));

  const numLimit = (key: keyof UserLimits, label: string) => (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="input w-24"
          min={-1}
          value={(limits[key] as number) ?? -1}
          onChange={(e) => setLimit(key, parseInt(e.target.value, 10))}
        />
        <span className="text-xs text-text-500">(-1 = unlimited)</span>
      </div>
    </div>
  );

  const permission = (key: keyof UserLimits, label: string) => (
    <label key={key} className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        className="w-4 h-4 accent-accent-blue"
        checked={Boolean(limits[key])}
        onChange={(e) => setLimit(key, e.target.checked)}
      />
      <span className="text-sm text-text-300">{label}</span>
    </label>
  );

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-text-300 mb-4">Resource Quotas</h3>
        <div className="grid grid-cols-2 gap-4">
          {numLimit("maxVms", "Max VMs")}
          {numLimit("maxLxc", "Max LXC Containers")}
          {numLimit("maxDocker", "Max Docker Containers")}
          {numLimit("maxStorageGb", "Max Storage (GB)")}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-text-300 mb-4">Permissions</h3>
        <div className="grid grid-cols-2 gap-3">
          {permission("allowVmCreate", "Create VMs")}
          {permission("allowVmDelete", "Delete VMs")}
          {permission("allowVmModify", "Modify VMs")}
          {permission("allowLxcCreate", "Create LXC")}
          {permission("allowLxcDelete", "Delete LXC")}
          {permission("allowDockerCreate", "Create Docker")}
          {permission("allowDockerDelete", "Delete Docker")}
          {permission("allowIsoUpload", "Upload ISOs")}
          {permission("allowIsoDelete", "Delete ISOs")}
          {permission("allowStorageManage", "Manage Storage (Admin)")}
          {permission("allowNetworkManage", "Manage Network (Admin)")}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving..." : "Save Limits"}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved!</span>}
      </div>
    </div>
  );
}

function AclTab({ userId }: { userId: number }) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  type EditableAclEntry = Omit<ResourceAclEntry, "id" | "createdAt" | "updatedAt" | "userId">;
  type EditableAclField = "canView" | "canConsole" | "canPower" | "canMedia" | "canModify" | "canDelete" | "canBackup" | "canSnapshot" | "canAdmin";
  const [entries, setEntries] = useState<Record<string, EditableAclEntry>>({});

  const { data: catalog = [] } = useQuery<ResourceCatalogEntry[]>({
    queryKey: ["resources", "catalog"],
    queryFn: () => apiGet<ResourceCatalogEntry[]>("/api/resources/catalog"),
  });

  const { data: aclRows = [] } = useQuery<ResourceAclEntry[]>({
    queryKey: ["users", userId, "acl"],
    queryFn: () => apiGet<ResourceAclEntry[]>(`/api/users/${userId}/acl`),
  });

  useEffect(() => {
    const next: Record<string, EditableAclEntry> = {};
    for (const row of aclRows) {
      next[`${row.resourceType}:${row.resourceName}`] = {
        resourceType: row.resourceType,
        resourceName: row.resourceName,
        canView: row.canView,
        canConsole: row.canConsole,
        canPower: row.canPower,
        canMedia: row.canMedia,
        canModify: row.canModify,
        canDelete: row.canDelete,
        canBackup: row.canBackup,
        canSnapshot: row.canSnapshot,
        canAdmin: row.canAdmin,
      };
    }
    setEntries(next);
  }, [aclRows]);

  const update = useMutation({
    mutationFn: async () => {
      const payload = Object.values(entries).filter((entry) =>
        entry.canView ||
        entry.canConsole ||
        entry.canPower ||
        entry.canMedia ||
        entry.canModify ||
        entry.canDelete ||
        entry.canBackup ||
        entry.canSnapshot ||
        entry.canAdmin
      );
      return apiPut(`/api/users/${userId}/acl`, { entries: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users", userId, "acl"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const toggle = (resourceType: ResourceCatalogEntry["resourceType"], resourceName: string, field: EditableAclField, checked: boolean) => {
    const key = `${resourceType}:${resourceName}`;
    setEntries((current) => {
      const existing = current[key] ?? {
        resourceType,
        resourceName,
        canView: false,
        canConsole: false,
        canPower: false,
        canMedia: false,
        canModify: false,
        canDelete: false,
        canBackup: false,
        canSnapshot: false,
        canAdmin: false,
      };
      const next = { ...existing, [field]: checked };
      if (field === "canAdmin" && checked) {
        next.canView = true;
        next.canConsole = true;
        next.canPower = true;
        next.canMedia = true;
        next.canModify = true;
        next.canDelete = true;
        next.canBackup = true;
        next.canSnapshot = true;
      }
      if (field !== "canView" && checked) {
        next.canView = true;
      }
      return { ...current, [key]: next };
    });
  };

  return (
    <div className="space-y-4">
      <div className="card p-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-text-500">
            <tr className="border-b border-surface-500">
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">View</th>
              <th className="px-3 py-2">Console</th>
              <th className="px-3 py-2">Power</th>
              <th className="px-3 py-2">Media</th>
              <th className="px-3 py-2">Modify</th>
              <th className="px-3 py-2">Snapshot</th>
              <th className="px-3 py-2">Backup</th>
              <th className="px-3 py-2">Delete</th>
              <th className="px-3 py-2">Admin</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((resource) => {
              const key = `${resource.resourceType}:${resource.resourceName}`;
              const entry = entries[key] ?? {
                resourceType: resource.resourceType,
                resourceName: resource.resourceName,
                canView: false,
                canConsole: false,
                canPower: false,
                canMedia: false,
                canModify: false,
                canDelete: false,
                canBackup: false,
                canSnapshot: false,
                canAdmin: false,
              };
              const checkbox = (field: EditableAclField) => (
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-accent-blue"
                  checked={Boolean(entry[field])}
                  onChange={(e) => toggle(resource.resourceType, resource.resourceName, field, e.target.checked)}
                />
              );
              return (
                <tr key={key} className="border-b border-surface-600/60">
                  <td className="px-3 py-3">
                    <div className="font-medium text-text-200">{resource.displayName}</div>
                    <div className="text-xs text-text-500 uppercase">{resource.resourceType}</div>
                  </td>
                  <td className="px-3 py-3 text-text-400">{resource.ownerUsername ?? "Unassigned"}</td>
                  <td className="px-3 py-3">{checkbox("canView")}</td>
                  <td className="px-3 py-3">{checkbox("canConsole")}</td>
                  <td className="px-3 py-3">{checkbox("canPower")}</td>
                  <td className="px-3 py-3">{checkbox("canMedia")}</td>
                  <td className="px-3 py-3">{checkbox("canModify")}</td>
                  <td className="px-3 py-3">{checkbox("canSnapshot")}</td>
                  <td className="px-3 py-3">{checkbox("canBackup")}</td>
                  <td className="px-3 py-3">{checkbox("canDelete")}</td>
                  <td className="px-3 py-3">{checkbox("canAdmin")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => update.mutate()} disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving..." : "Save ACL"}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved!</span>}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState("profile");

  const { data: user, isLoading, error } = useQuery<User>({
    queryKey: ["users", Number(id)],
    queryFn: () => apiGet<User>(`/api/users/${id}`),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !user) {
    return <div className="card p-6 text-red-400">User not found</div>;
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate("/users")} className="text-text-400 hover:text-text-200 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-text-100">{user.username}</h1>
          <p className="text-sm text-text-500">
            {user.role} {user.suspended && "· Suspended"}
          </p>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <div>
        {tab === "profile" && <ProfileTab user={user} />}
        {tab === "password" && <PasswordTab userId={user.id} />}
        {tab === "limits" && <LimitsTab userId={user.id} />}
        {tab === "acl" && <AclTab userId={user.id} />}
      </div>
    </div>
  );
}
