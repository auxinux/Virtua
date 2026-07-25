import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { Modal } from "./ui/Modal";

interface SnapshotEntry {
  name: string;
  createdAt?: string;
  description?: string;
  state?: string;
  isCurrent?: boolean;
}

interface SnapshotModalProps {
  open: boolean;
  onClose: () => void;
  /** "vm" or "lxc" */
  type: "vm" | "lxc";
  /** resource name */
  name: string;
}

/**
 * Integrated snapshot manager (no JS prompt): create a snapshot, list existing
 * ones and roll back / delete — all in one panel, wired to the real API.
 */
export function SnapshotModal({ open, onClose, type, name }: SnapshotModalProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const base = `/api/${type === "vm" ? "vms" : "lxc"}/${encodeURIComponent(name)}`;
  const [snapName, setSnapName] = useState("");
  const [desc, setDesc] = useState("");
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null);

  const snapshots = useQuery<SnapshotEntry[]>({
    queryKey: ["snapshots", type, name],
    queryFn: () => apiGet(`${base}/snapshots`),
    enabled: open,
    refetchInterval: open ? 8000 : false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["snapshots", type, name] });

  const create = useMutation({
    mutationFn: () => apiPost(`${base}/snapshot/create`, { name: snapName.trim(), description: desc.trim() || undefined }),
    onSuccess: () => { setSnapName(""); setDesc(""); invalidate(); },
  });
  const rollback = useMutation({
    mutationFn: (snap: string) => apiPost(`${base}/snapshot/${encodeURIComponent(snap)}/rollback`, {}),
    onSuccess: () => { setConfirmRollback(null); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (snap: string) => apiDelete(`${base}/snapshot/${encodeURIComponent(snap)}`),
    onSuccess: () => invalidate(),
  });

  const validName = /^[a-zA-Z0-9._-]{1,64}$/.test(snapName.trim());

  return (
    <Modal open={open} onClose={onClose} title={`${t("action.snapshot", "Snapshots")} — ${name}`} size="lg">
      <div className="p-4 space-y-5">
        {/* Create */}
        <div>
          <h3 className="text-xs font-semibold text-text-300 mb-2 uppercase tracking-wide">{t("snapshot.create", "Créer un snapshot")}</h3>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder={t("snapshot.namePlaceholder", "nom (a-z, 0-9, . _ -)")}
              value={snapName}
              onChange={(e) => setSnapName(e.target.value)}
            />
            <button className="btn-primary" disabled={!validName || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? t("msg.loading", "…") : t("snapshot.take", "Créer")}
            </button>
          </div>
          <input
            className="input mt-2"
            placeholder={t("snapshot.descPlaceholder", "Description (optionnel)")}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          {create.error && <p className="text-sm text-red-400 mt-2">{(create.error as Error).message}</p>}
        </div>

        {/* List */}
        <div>
          <h3 className="text-xs font-semibold text-text-300 mb-2 uppercase tracking-wide">
            {t("snapshot.existing", "Snapshots existants")} ({snapshots.data?.length ?? 0})
          </h3>
          {snapshots.isLoading ? (
            <p className="text-sm text-text-500">{t("msg.loading", "Chargement…")}</p>
          ) : (snapshots.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-text-500">{t("snapshot.none", "Aucun snapshot")}</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {snapshots.data!.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-3 rounded border border-surface-600 bg-surface-800/60 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-100 font-mono font-medium truncate">{s.name || "(sans nom)"}</span>
                      {s.isCurrent && <span className="text-2xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">{t("snapshot.current", "actuel")}</span>}
                    </div>
                    <div className="text-2xs text-text-500 truncate">
                      {s.createdAt ? new Date(s.createdAt).toLocaleString() : t("snapshot.noDate", "date inconnue")}
                      {s.description ? ` · ${s.description}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {confirmRollback === s.name ? (
                      <>
                        <button className="btn-danger btn-sm" disabled={rollback.isPending} onClick={() => rollback.mutate(s.name)}>
                          {t("snapshot.confirmRollback", "Confirmer le retour")}
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => setConfirmRollback(null)}>{t("action.cancel", "Annuler")}</button>
                      </>
                    ) : (
                      <>
                        <button className="btn-secondary btn-sm" onClick={() => setConfirmRollback(s.name)} title={t("snapshot.rollback", "Revenir à ce snapshot")}>
                          {t("snapshot.rollback", "Rollback")}
                        </button>
                        <button className="btn-ghost btn-sm text-red-400" disabled={remove.isPending} onClick={() => remove.mutate(s.name)} title={t("action.delete", "Supprimer")}>
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {rollback.error && <p className="text-sm text-red-400 mt-2">{(rollback.error as Error).message}</p>}
          <p className="text-2xs text-text-500 mt-3">
            {t("snapshot.rollbackWarning", "⚠ Un rollback restaure l'état du snapshot — les changements depuis seront perdus.")}
          </p>
        </div>
      </div>
    </Modal>
  );
}
