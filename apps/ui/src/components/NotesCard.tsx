import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut } from "../api/client";
import { useAuth } from "../utils/useAuth";

interface NotesCardProps {
  type: "vm" | "lxc" | "docker";
  /** vm/lxc: name ; docker: container id */
  id: string;
  className?: string;
}

/** Free-text notes per machine (persisted as the resource's description). */
export function NotesCard({ type, id, className = "" }: NotesCardProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { getResourcePermissions } = useAuth();
  const canEdit = getResourcePermissions(type, id).canModify;
  const base = type === "docker" ? `/api/docker/containers/${encodeURIComponent(id)}` : `/api/${type === "vm" ? "vms" : "lxc"}/${encodeURIComponent(id)}`;

  const notes = useQuery<{ notes: string }>({
    queryKey: ["notes", type, id],
    queryFn: () => apiGet(`${base}/notes`),
  });

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(notes.data?.notes ?? ""); }, [notes.data, editing]);

  const save = useMutation({
    mutationFn: () => apiPut(`${base}/notes`, { notes: draft }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ["notes", type, id] }); },
  });

  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-300">{t("notes.title", "Notes")}</h3>
        {canEdit && !editing && (
          <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>{t("action.edit", "Modifier")}</button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            className="input min-h-[120px] resize-y w-full font-sans"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("notes.placeholder", "Ajoute des notes pour cette machine…")}
            maxLength={4000}
          />
          <div className="flex gap-2 mt-2">
            <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t("msg.loading", "…") : t("action.save", "Enregistrer")}
            </button>
            <button className="btn-ghost btn-sm" onClick={() => { setEditing(false); setDraft(notes.data?.notes ?? ""); }}>
              {t("action.cancel", "Annuler")}
            </button>
          </div>
          {save.error && <p className="text-sm text-red-400 mt-2">{(save.error as Error).message}</p>}
        </>
      ) : (
        <p className="text-sm text-text-300 whitespace-pre-wrap min-h-[1.5rem]">
          {notes.data?.notes?.trim() ? notes.data.notes : <span className="text-text-500 italic">{t("notes.empty", "Aucune note")}</span>}
        </p>
      )}
    </div>
  );
}
