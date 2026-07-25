import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiDelete, apiGet, apiPut } from "../../api/client";
import { ConfirmModal, Modal } from "../ui/Modal";

type ResourceAclType = "vm" | "lxc" | "docker";

interface AclUser {
  id: number;
  username: string;
  role: string;
  displayName?: string | null;
  email?: string | null;
}

interface AclEntry {
  id: number;
  userId: number;
  username: string;
  role: string;
  displayName?: string | null;
  email?: string | null;
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canMedia: boolean;
  canModify: boolean;
  canDelete: boolean;
  canBackup: boolean;
  canSnapshot: boolean;
  canAdmin: boolean;
}

interface ResourceAclResponse {
  entries: AclEntry[];
  users: AclUser[];
}

interface ResourceAclPanelProps {
  resourceType: ResourceAclType;
  resourceName: string;
  title?: string;
}

type EditableField =
  | "canView"
  | "canConsole"
  | "canPower"
  | "canMedia"
  | "canModify"
  | "canDelete"
  | "canBackup"
  | "canSnapshot"
  | "canAdmin";

const EMPTY_PERMS: Record<EditableField, boolean> = {
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

export function ResourceAclPanel({ resourceType, resourceName, title }: ResourceAclPanelProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AclEntry | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | "">("");
  const [perms, setPerms] = useState<Record<EditableField, boolean>>(EMPTY_PERMS);

  const { data } = useQuery<ResourceAclResponse>({
    queryKey: ["resource-acl", resourceType, resourceName],
    queryFn: () => apiGet<ResourceAclResponse>(`/api/resources/${resourceType}/${encodeURIComponent(resourceName)}/acl`),
  });

  const entries = data?.entries ?? [];
  const users = data?.users ?? [];
  const availableUsers = useMemo(
    () => users.filter((user) => !entries.some((entry) => entry.userId === user.id)),
    [users, entries]
  );

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["resource-acl", resourceType, resourceName] });
  };

  const upsert = useMutation({
    mutationFn: (payload: { userId: number; perms: Record<EditableField, boolean> }) =>
      apiPut(`/api/resources/${resourceType}/${encodeURIComponent(resourceName)}/acl/${payload.userId}`, payload.perms),
    onSuccess: async () => {
      setEditorOpen(false);
      setSelectedUserId("");
      setPerms(EMPTY_PERMS);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (userId: number) => apiDelete(`/api/resources/${resourceType}/${encodeURIComponent(resourceName)}/acl/${userId}`),
    onSuccess: async () => {
      setDeleteTarget(null);
      await invalidate();
    },
  });

  const openAdd = () => {
    setSelectedUserId(availableUsers[0]?.id ?? "");
    setPerms(EMPTY_PERMS);
    setEditorOpen(true);
  };

  const openEdit = (entry: AclEntry) => {
    setSelectedUserId(entry.userId);
    setPerms({
      canView: entry.canView,
      canConsole: entry.canConsole,
      canPower: entry.canPower,
      canMedia: entry.canMedia,
      canModify: entry.canModify,
      canDelete: entry.canDelete,
      canBackup: entry.canBackup,
      canSnapshot: entry.canSnapshot,
      canAdmin: entry.canAdmin,
    });
    setEditorOpen(true);
  };

  const setPerm = (field: EditableField, checked: boolean) => {
    setPerms((current) => {
      const next = { ...current, [field]: checked };
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
      return next;
    });
  };

  const userOptions = users.filter((user) => user.id === selectedUserId || availableUsers.some((available) => available.id === user.id));
  const currentUser = users.find((user) => user.id === selectedUserId);

  useEffect(() => {
    if (editorOpen && selectedUserId === "" && availableUsers.length > 0) {
      setSelectedUserId(availableUsers[0].id);
    }
  }, [editorOpen, selectedUserId, availableUsers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-300">{title ?? t("acl.defaultTitle", { name: resourceName })}</h3>
        <button onClick={openAdd} disabled={availableUsers.length === 0} className="btn-primary btn-sm">
          {t("acl.addUser")}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="card p-6 text-center text-text-400 text-sm">{t("acl.noEntries")}</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600">
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("acl.user")}</th>
                <th className="px-4 py-2 text-left text-text-400 font-medium">{t("acl.rights")}</th>
                <th className="px-4 py-2 text-right text-text-400 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const rights = [
                  entry.canView && t("acl.view"),
                  entry.canConsole && t("acl.console"),
                  entry.canPower && t("acl.power"),
                  entry.canMedia && t("acl.media"),
                  entry.canModify && t("acl.modify"),
                  entry.canSnapshot && t("acl.snapshot"),
                  entry.canBackup && t("acl.backup"),
                  entry.canDelete && t("acl.delete"),
                  entry.canAdmin && t("acl.admin"),
                ].filter(Boolean).join(", ");
                return (
                  <tr key={entry.userId} className="border-b border-surface-700">
                    <td className="px-4 py-2">
                      <div className="text-text-200 font-medium">{entry.displayName || entry.username}</div>
                      <div className="text-xs text-text-500">{entry.username} · {entry.role}</div>
                    </td>
                    <td className="px-4 py-2 text-text-400">{rights || "—"}</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => openEdit(entry)} className="btn-secondary btn-sm">{t("action.edit")}</button>
                        <button onClick={() => setDeleteTarget(entry)} className="btn-danger btn-sm">{t("action.delete")}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={selectedUserId && entries.some((entry) => entry.userId === selectedUserId) ? t("acl.editTitle") : t("acl.addTitle")}
        size="lg"
        footer={
          <>
            <button onClick={() => setEditorOpen(false)} className="btn-secondary">{t("action.cancel")}</button>
            <button
              onClick={() => selectedUserId && upsert.mutate({ userId: Number(selectedUserId), perms })}
              disabled={upsert.isPending || selectedUserId === ""}
              className="btn-primary"
            >
              {upsert.isPending ? t("common.saving") : t("action.save")}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">{t("acl.user")}</label>
            <select
              className="input"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value ? Number(e.target.value) : "")}
              disabled={selectedUserId !== "" && entries.some((entry) => entry.userId === selectedUserId)}
            >
              <option value="">{t("acl.selectUser")}</option>
              {userOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName ? `${user.displayName} (${user.username})` : user.username}
                </option>
              ))}
            </select>
            {currentUser && <p className="mt-1 text-xs text-text-500">{currentUser.role}{currentUser.email ? ` · ${currentUser.email}` : ""}</p>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([
              ["canView", t("acl.view")],
              ["canConsole", t("acl.console")],
              ["canPower", t("acl.power")],
              ["canMedia", t("acl.media")],
              ["canModify", t("acl.modify")],
              ["canSnapshot", t("acl.snapshot")],
              ["canBackup", t("acl.backup")],
              ["canDelete", t("acl.delete")],
              ["canAdmin", t("acl.admin")],
            ] as Array<[EditableField, string]>).map(([field, label]) => (
              <label key={field} className="flex items-center gap-2 cursor-pointer text-sm text-text-300">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-accent-blue"
                  checked={perms[field]}
                  onChange={(e) => setPerm(field, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title={t("acl.deleteTitle")}
        message={deleteTarget ? t("acl.deleteMessage", { user: deleteTarget.username, resource: resourceName }) : ""}
        confirmLabel={t("action.delete")}
        danger
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.userId)}
        onCancel={() => setDeleteTarget(null)}
        loading={remove.isPending}
      />
    </div>
  );
}
