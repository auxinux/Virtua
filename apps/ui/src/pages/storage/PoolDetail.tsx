import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiDelete, apiPost } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { formatBytes } from "../../utils/formatBytes";
import type { StoragePool } from "@auxinux/shared";

interface PoolContentItem {
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt?: string;
  linkedResourceType?: string;
  linkedResourceName?: string;
  relation?: string;
  synthetic?: boolean;
  isLinked?: boolean;
  deletable?: boolean;
}

export default function PoolDetail() {
  const { t } = useTranslation();
  const { name, nodeName } = useParams<{ name: string; nodeName?: string; sharedName?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const poolName = name;
  const [deletePoolOpen, setDeletePoolOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PoolContentItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<PoolContentItem | null>(null);

  const poolBasePath = nodeName
    ? `/api/nodes/${encodeURIComponent(nodeName)}/storage/pools/${encodeURIComponent(poolName ?? "")}`
    : `/api/storage/pools/${encodeURIComponent(poolName ?? "")}`;

  const { data: pool, isLoading, error } = useQuery<StoragePool>({
    queryKey: ["storage", "pools", nodeName || "local", poolName],
    queryFn: () => apiGet<StoragePool>(poolBasePath),
  });

  const { data: content = [] } = useQuery<PoolContentItem[]>({
    queryKey: ["storage", "pools", nodeName || "local", poolName, "content"],
    queryFn: () => apiGet<PoolContentItem[]>(`${poolBasePath}/content`),
  });

  const deletePool = useMutation({
    mutationFn: () => apiDelete(`/api/storage/pools/${encodeURIComponent(poolName ?? "")}`),
    onSuccess: () => navigate("/storage"),
  });

  const isRemotePool = Boolean(nodeName);

  const deleteContentItem = useMutation({
    mutationFn: (itemPath: string) => apiPost(`${poolBasePath}/content/delete`, { itemPath }),
    onSuccess: async () => {
      setDeleteItem(null);
      await qc.invalidateQueries({ queryKey: ["storage", "pools", nodeName || "local", poolName, "content"] });
      await qc.invalidateQueries({ queryKey: ["storage", "pools", nodeName || "local", poolName] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !pool) {
    return <div className="card p-6 text-red-400">Storage pool not found</div>;
  }

  const usedPercent = pool.totalBytes ? (pool.usedBytes / pool.totalBytes) * 100 : 0;
  const barColor = usedPercent > 85 ? "bg-red-500" : usedPercent > 70 ? "bg-yellow-500" : "bg-accent-blue";

  const typeIcon: Record<string, string> = {
    iso: "💿",
    vm: "🖥",
    vm_disk: "🖥",
    backup: "📦",
    template: "📄",
    disk: "💾",
    archive: "🗜",
    snapshot: "📸",
    docker: "🐳",
    lxc: "📦",
    container: "🐳",
    file: "📄",
  };

  const typeLabel: Record<string, string> = {
    iso: "ISO",
    vm: "VM",
    vm_disk: "VM",
    backup: "Backup",
    template: "Template",
    disk: "Disk",
    archive: "Archive",
    snapshot: "Snapshot",
    docker: "Docker",
    lxc: "LXC",
    container: "Container",
    file: "File",
  };

  const downloadUrl = (item: PoolContentItem) =>
    `${poolBasePath}/content/download?itemPath=${encodeURIComponent(item.path)}`;
  const canDeleteItem = (item: PoolContentItem) =>
    !isRemotePool && !item.isLinked && (!item.synthetic || item.deletable);
  const deleteBlockedTitle = (item: PoolContentItem) => {
    if (isRemotePool) return "Remote pool deletion is not available from the primary node yet";
    if (item.isLinked) return "This entry is linked to an active resource";
    if (item.synthetic && !item.deletable) return "Delete this from its resource screen";
    return "Delete orphan item";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/storage")} className="text-text-400 hover:text-text-200 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-text-100">{pool.name}{nodeName ? ` · ${nodeName}` : ""}</h1>
            <p className="text-sm text-text-500 font-mono mt-0.5">{pool.path}</p>
          </div>
        </div>
        <button
          onClick={() => setDeletePoolOpen(true)}
          disabled={isRemotePool}
          className={`btn border-red-900 ${
            isRemotePool
              ? "bg-surface-700 text-text-500 cursor-not-allowed"
              : "bg-red-900/20 text-red-400 hover:bg-red-900/40"
          }`}
          title={isRemotePool ? "Remote pool deletion is not available from the primary node yet" : "Delete storage pool"}
        >
          Delete Pool
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-text-300 mb-3">Storage Usage</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-text-500">Used</span>
              <span className="font-mono text-text-200">{formatBytes(pool.usedBytes)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-500">Free</span>
              <span className="font-mono text-text-200">{formatBytes(pool.freeBytes)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-500">Total</span>
              <span className="font-mono text-text-200">{formatBytes(pool.totalBytes)}</span>
            </div>
            <div>
              <div className="flex justify-between text-xs text-text-500 mb-1">
                <span>Usage</span>
                <span>{usedPercent.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-surface-700 rounded-full h-2">
                <div className={`${barColor} h-2 rounded-full`} style={{ width: `${usedPercent}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <h3 className="text-sm font-semibold text-text-300 mb-3">Pool Information</h3>
          <dl className="space-y-2 text-sm">
            {[
              ["Type", pool.type],
              ["Enabled", pool.enabled ? "Yes" : "No"],
              ["Remote Source", pool.mountSource || "—"],
              ["Filesystem", pool.fstype || "—"],
              ["Content Types", pool.content?.join(", ") || "—"],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex justify-between">
                <dt className="text-text-500">{k}</dt>
                <dd className="text-text-200">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/* Content */}
      <div>
        <h2 className="text-sm font-semibold text-text-300 mb-3">Content ({content.length} items)</h2>
        {content.length === 0 ? (
          <div className="card p-6 text-center text-text-400 text-sm">Pool is empty</div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-600">
                  <th className="px-4 py-3 text-left text-text-400 font-medium">Name</th>
                  <th className="px-4 py-3 text-left text-text-400 font-medium">Type</th>
                  <th className="px-4 py-3 text-left text-text-400 font-medium">Linked To</th>
                  <th className="px-4 py-3 text-left text-text-400 font-medium">Size</th>
                  <th className="px-4 py-3 text-left text-text-400 font-medium">Created</th>
                  <th className="px-4 py-3 text-right text-text-400 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {content.map((item) => (
                  <tr
                    key={item.path}
                    className="border-b border-surface-700 hover:bg-surface-700/30 cursor-pointer"
                    onDoubleClick={() => setSelectedItem(item)}
                  >
                    <td className="px-4 py-2 font-mono text-text-200 text-xs">
                      {typeIcon[item.type] || "📄"} {item.name}
                    </td>
                    <td className="px-4 py-2 text-text-400">{typeLabel[item.type] || item.type}</td>
                    <td className="px-4 py-2 text-text-400">
                      {item.linkedResourceType && item.linkedResourceName
                        ? `${item.linkedResourceType.toUpperCase()} · ${item.linkedResourceName}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-text-300">{formatBytes(item.size)}</td>
                    <td className="px-4 py-2 text-text-400">
                      {item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-2">
                        {!item.synthetic && (
                          <a
                            href={isRemotePool ? undefined : downloadUrl(item)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isRemotePool) e.preventDefault();
                            }}
                            className={`text-xs px-2 py-1 rounded border ${
                              isRemotePool
                                ? "border-surface-500 text-text-500 cursor-not-allowed"
                                : "btn-secondary"
                            }`}
                            title={isRemotePool ? "Remote download is not available yet through the primary node" : "Download file"}
                          >
                            Download
                          </a>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canDeleteItem(item)) return;
                            setDeleteItem(item);
                          }}
                          disabled={!canDeleteItem(item)}
                          className={`text-xs px-2 py-1 rounded border ${
                            !canDeleteItem(item)
                              ? "border-surface-500 text-text-500 cursor-not-allowed"
                              : "border-red-900 text-red-400 hover:bg-red-900/20"
                          }`}
                          title={deleteBlockedTitle(item)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={deletePoolOpen}
        title={t("modal.deleteStoragePool")}
        message={`Remove storage pool "${name}" from AuxiNux? The directory will be unmounted but not deleted.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => deletePool.mutate()}
        onCancel={() => setDeletePoolOpen(false)}
        loading={deletePool.isPending}
      />

      <ConfirmModal
        open={!!deleteItem}
        title={t("modal.deleteStorageFile")}
        message={deleteItem ? `Delete "${deleteItem.name}" from pool "${name}"? This cannot be undone.` : ""}
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteItem && deleteContentItem.mutate(deleteItem.path)}
        onCancel={() => setDeleteItem(null)}
        loading={deleteContentItem.isPending}
      />

      <Modal
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        title={selectedItem ? `Content Details · ${selectedItem.name}` : "Content Details"}
        size="lg"
        footer={
          <>
            {selectedItem && !selectedItem.synthetic && (
              <a href={downloadUrl(selectedItem)} className="btn-secondary">
                Download
              </a>
            )}
            <button onClick={() => setSelectedItem(null)} className="btn-secondary">Close</button>
          </>
        }
      >
        {selectedItem && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-text-500">Name</div>
                <div className="text-text-200 font-mono break-all">{selectedItem.name}</div>
              </div>
              <div>
                <div className="text-text-500">Type</div>
                <div className="text-text-200">{typeLabel[selectedItem.type] || selectedItem.type}</div>
              </div>
              <div>
                <div className="text-text-500">Linked Resource</div>
                <div className="text-text-200">
                  {selectedItem.linkedResourceType && selectedItem.linkedResourceName
                    ? `${selectedItem.linkedResourceType.toUpperCase()} · ${selectedItem.linkedResourceName}`
                    : "Not linked"}
                </div>
              </div>
              <div>
                <div className="text-text-500">Relation</div>
                <div className="text-text-200">{selectedItem.relation || "—"}</div>
              </div>
              <div>
                <div className="text-text-500">Delete Allowed</div>
                <div className="text-text-200">{canDeleteItem(selectedItem) ? "Yes" : "No"}</div>
              </div>
              <div>
                <div className="text-text-500">Size</div>
                <div className="text-text-200 font-mono">{formatBytes(selectedItem.size)}</div>
              </div>
              <div>
                <div className="text-text-500">Created</div>
                <div className="text-text-200">{selectedItem.createdAt ? new Date(selectedItem.createdAt).toLocaleString() : "—"}</div>
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Path / Reference</div>
              <div className="rounded border border-surface-500 bg-surface-800 px-3 py-2 text-text-200 font-mono text-xs break-all">
                {selectedItem.path}
              </div>
            </div>
            {selectedItem.synthetic && (
              <div className="text-xs text-text-500">
                {selectedItem.deletable
                  ? "This entry is managed by the host service, not a directly browsed file on disk."
                  : "This entry is a linked metadata record, not a directly browsed file on disk."}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
