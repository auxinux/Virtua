import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut } from "../api/client";
import { useAuth } from "../utils/useAuth";

interface DisplayNameCardProps {
  type: "vm" | "lxc" | "docker";
  /** vm/lxc: name ; docker: container id */
  id: string;
  /** The real, underlying resource name — shown as the fallback. */
  realName: string;
  className?: string;
}

/**
 * Editable UI label for a machine. Unlike Rename this never touches libvirt,
 * LXC or Docker — it only changes what Virtua shows, so it works on a running
 * machine and on anything whose real name has to stay put.
 */
export function DisplayNameCard({ type, id, realName, className = "" }: DisplayNameCardProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { getResourcePermissions } = useAuth();
  const canEdit = getResourcePermissions(type, id).canModify;
  const base = type === "docker"
    ? `/api/docker/containers/${encodeURIComponent(id)}`
    : `/api/${type === "vm" ? "vms" : "lxc"}/${encodeURIComponent(id)}`;

  const displayName = useQuery<{ displayName: string }>({
    queryKey: ["displayName", type, id],
    queryFn: () => apiGet(`${base}/display-name`),
  });

  // A real rename writes display_name = the new name, so an override equal to
  // the real name carries no information — treat it as "no override".
  const stored = displayName.data?.displayName?.trim() ?? "";
  const current = stored === realName ? "" : stored;

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(current); }, [current, editing]);

  const save = useMutation({
    mutationFn: (value: string) => apiPut(`${base}/display-name`, { displayName: value }),
    onSuccess: () => {
      setEditing(false);
      // The label feeds the sidebar and every list, so refresh them too.
      qc.invalidateQueries({ queryKey: ["displayName", type, id] });
      qc.invalidateQueries({ queryKey: ["sidebar"] });
      qc.invalidateQueries({ queryKey: [type === "vm" ? "vms" : type] });
    },
  });

  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-300">{t("displayName.title", "Nom d'affichage")}</h3>
        {canEdit && !editing && (
          <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>{t("action.edit", "Modifier")}</button>
        )}
      </div>

      {editing ? (
        <>
          <input
            className="input w-full"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={realName}
            maxLength={120}
          />
          <p className="text-xs text-text-500 mt-1">
            {t("displayName.hint", "Change seulement l'affichage dans Virtua. Le nom réel reste")} <span className="font-mono">{realName}</span>.
          </p>
          <div className="flex gap-2 mt-2">
            <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(draft.trim())}>
              {save.isPending ? t("msg.loading", "…") : t("action.save", "Enregistrer")}
            </button>
            <button className="btn-ghost btn-sm" onClick={() => { setEditing(false); setDraft(current); }}>
              {t("action.cancel", "Annuler")}
            </button>
            {current && (
              <button className="btn-ghost btn-sm" disabled={save.isPending} onClick={() => { setDraft(""); save.mutate(""); }}>
                {t("displayName.reset", "Réinitialiser")}
              </button>
            )}
          </div>
          {save.error && <p className="text-sm text-red-400 mt-2">{(save.error as Error).message}</p>}
        </>
      ) : (
        <p className="text-sm text-text-300">
          {current
            ? <>{current} <span className="text-text-500 font-mono text-xs">({realName})</span></>
            : <span className="text-text-500 italic">{t("displayName.empty", "Aucun — le nom réel est utilisé")}</span>}
        </p>
      )}
    </div>
  );
}
