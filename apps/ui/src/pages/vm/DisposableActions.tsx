import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiPost } from "../../api/client";
import type { VmDisposableInfo } from "@auxinux/shared";

export type DisposableStopAction = "discard" | "reset" | "keep" | "convert";

/** "Bêta" pill shown next to every disposable-VM entry point. */
export function BetaBadge() {
  return <span className="ml-2 rounded bg-amber-900/40 border border-amber-700/50 px-1.5 py-0.5 text-2xs font-semibold uppercase text-amber-300">bêta</span>;
}

/**
 * What to do with a stopped disposable VM: throw it away, start again from
 * the base, keep it as it is, or turn it into an ordinary VM.
 */
export function DisposableStopChoices({
  vmName,
  disposable,
  onDone,
  compact = false,
}: {
  vmName: string;
  disposable: VmDisposableInfo;
  onDone?: (action: DisposableStopAction) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const act = useMutation({
    mutationFn: (action: DisposableStopAction) => apiPost(`/api/vms/${encodeURIComponent(vmName)}/disposable/${action}`),
    onSuccess: (_result, action) => {
      setError("");
      qc.invalidateQueries({ queryKey: ["vms"] });
      qc.invalidateQueries({ queryKey: ["vm", vmName] });
      qc.invalidateQueries({ queryKey: ["disposable"] });
      onDone?.(action);
      if (action === "discard") navigate("/vms/disposable");
    },
    onError: (err: Error) => setError(err.message),
  });

  const choices: Array<{ action: DisposableStopAction; label: string; help: string; className: string }> = [
    { action: "discard", label: t("disposable.discard", "Jeter"), help: t("disposable.discardHelp", "Supprime la VM et ses modifications. La base reste intacte."), className: "btn-danger" },
    { action: "reset", label: t("disposable.reset", "Repartir de la base"), help: t("disposable.resetHelp", "Efface les modifications : la VM redevient une copie neuve de la base."), className: "btn-secondary" },
    { action: "keep", label: t("disposable.keep", "Garder"), help: t("disposable.keepHelp", "Conserve la VM jetable telle quelle pour la relancer plus tard."), className: "btn-secondary" },
    { action: "convert", label: t("disposable.convert", "Convertir en VM normale"), help: t("disposable.convertHelp", "Copie complète du disque : la VM ne dépend plus de la base (peut prendre quelques minutes)."), className: "btn-primary" },
  ];

  return (
    <div className="space-y-3">
      {!compact && (
        <p className="text-sm text-text-300">
          {t("disposable.stoppedPrompt", "Cette VM jetable est arrêtée. Que voulez-vous en faire ?")}{" "}
          <span className="text-text-500">{t("disposable.base", "Base")} : {disposable.baseLabel}{disposable.strict ? ` · ${t("disposable.strict", "bac à sable strict")}` : ""}</span>
        </p>
      )}
      {disposable.strict && !compact && (
        <p className="text-xs text-text-500">{t("disposable.strictNote", "Bac à sable strict : rien n'a été écrit sur le disque, chaque démarrage repart de la base.")}</p>
      )}
      <div className={compact ? "flex flex-wrap gap-1.5" : "grid grid-cols-1 sm:grid-cols-2 gap-2"}>
        {choices.map((choice) => (
          <button
            key={choice.action}
            type="button"
            className={`${choice.className} ${compact ? "text-xs px-2 py-1" : "justify-start text-left"}`}
            title={choice.help}
            disabled={act.isPending}
            onClick={() => act.mutate(choice.action)}
          >
            {choice.label}
            {!compact && <span className="block text-2xs font-normal opacity-75">{choice.help}</span>}
          </button>
        ))}
      </div>
      {act.isPending && <p className="text-xs text-text-500">{t("common.working", "En cours…")}</p>}
      {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
    </div>
  );
}
