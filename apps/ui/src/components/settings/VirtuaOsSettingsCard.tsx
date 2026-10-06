import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { VirtuaOsChannel, VirtuaOsKernelChannelResult, VirtuaOsStatus } from "@auxinux/shared";
import { apiGet, apiPut } from "../../api/client";
import { Modal } from "../ui/Modal";

export const VIRTUAOS_QUERY_KEY = ["system", "virtuaos"] as const;

/**
 * VirtuaOS status, or null on a plain Debian/Ubuntu host (the API answers 409
 * there). Shared by the settings card and the reboot banner.
 */
export function useVirtuaOsStatus(enabled = true) {
  return useQuery<VirtuaOsStatus | null>({
    queryKey: VIRTUAOS_QUERY_KEY,
    queryFn: () => apiGet<VirtuaOsStatus>("/api/system/virtuaos").catch(() => null),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

function ChannelBadge({ channel }: { channel: VirtuaOsChannel }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
      channel === "DEV" ? "bg-amber-900/40 text-amber-300 border border-amber-800/60" : "bg-emerald-900/30 text-emerald-300 border border-emerald-800/60"
    }`}>
      {channel}
    </span>
  );
}

function ChannelToggle({ value, disabled, onPick }: { value: VirtuaOsChannel; disabled?: boolean; onPick: (channel: VirtuaOsChannel) => void }) {
  return (
    <div className="inline-flex rounded border border-surface-500 overflow-hidden">
      {(["PROD", "DEV"] as const).map((channel) => (
        <button
          key={channel}
          type="button"
          disabled={disabled || channel === value}
          onClick={() => onPick(channel)}
          className={`px-3 py-1 text-xs font-semibold transition-colors ${
            channel === value ? "bg-accent-blue text-white" : "bg-surface-700 text-text-400 hover:bg-surface-600 disabled:opacity-50"
          }`}
        >
          {channel}
        </button>
      ))}
    </div>
  );
}

/** Persistent until the host has rebooted on a kernel of the chosen channel. */
export function VirtuaOsRebootBanner({ status }: { status: VirtuaOsStatus | null | undefined }) {
  const { t } = useTranslation();
  if (!status?.isVirtuaOS || !status.mismatch) return null;
  return (
    <div className="rounded border border-amber-800/70 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
      <div className="font-semibold">{t("virtuaos.rebootRequired")}</div>
      <div className="text-amber-300/80 mt-0.5">
        {t("virtuaos.mismatch", { running: status.runningKernelChannel, selected: status.kernelChannel })}
      </div>
    </div>
  );
}

type Pending =
  | { kind: "os"; channel: VirtuaOsChannel }
  | { kind: "kernel"; channel: VirtuaOsChannel };

export function VirtuaOsSettingsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: status } = useVirtuaOsStatus();
  const [pending, setPending] = useState<Pending | null>(null);
  const [kernelLog, setKernelLog] = useState<string | null>(null);

  const refresh = (next?: VirtuaOsStatus) => {
    if (next) qc.setQueryData(VIRTUAOS_QUERY_KEY, next);
    else void qc.invalidateQueries({ queryKey: VIRTUAOS_QUERY_KEY });
  };

  const setOsChannel = useMutation({
    mutationFn: (channel: VirtuaOsChannel) => apiPut<{ status: VirtuaOsStatus }>("/api/system/virtuaos/channel", { channel }),
    onSuccess: (res) => { refresh(res.status); setPending(null); },
  });

  const setKernelChannel = useMutation({
    mutationFn: (channel: VirtuaOsChannel) =>
      apiPut<VirtuaOsKernelChannelResult & { status: VirtuaOsStatus }>("/api/system/virtuaos/kernel-channel", { channel }),
    onSuccess: (res) => { refresh(res.status); setKernelLog(res.log); setPending(null); },
    onError: () => refresh(),
  });

  // Plain Debian/Ubuntu host: the section does not exist.
  if (!status?.isVirtuaOS) return null;

  const busy = setOsChannel.isPending || setKernelChannel.isPending;
  const pick = (kind: Pending["kind"], channel: VirtuaOsChannel) => {
    setOsChannel.reset();
    setKernelChannel.reset();
    // Going back to PROD on the OS branch is harmless: no confirmation needed.
    if (kind === "os" && channel === "PROD") { setOsChannel.mutate(channel); return; }
    setPending({ kind, channel });
  };
  const confirm = () => {
    if (!pending) return;
    if (pending.kind === "os") setOsChannel.mutate(pending.channel);
    else setKernelChannel.mutate(pending.channel);
  };
  const activeError = (pending?.kind === "kernel" ? setKernelChannel.error : setOsChannel.error) as Error | null;

  return (
    <div className="card p-5 space-y-4">
      <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("virtuaos.title")}</h2>

      <VirtuaOsRebootBanner status={status} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-text-200">{t("virtuaos.osBranch")}</div>
          <div className="text-xs text-text-500 mt-0.5">
            {t("virtuaos.installed")}: <span className="text-text-300 font-mono">{status.version ?? "?"}</span>
            {" · "}
            {t("virtuaos.latestOnChannel", { channel: status.virtuaosChannel })}:{" "}
            <span className="text-text-300 font-mono">{status.latestVirtuaOS ?? t("virtuaos.unknown")}</span>
          </div>
          <div className="text-xs text-text-500 mt-0.5">{t("virtuaos.osUpgradeHint")}</div>
        </div>
        <ChannelToggle value={status.virtuaosChannel} disabled={busy} onPick={(c) => pick("os", c)} />
      </div>
      {!pending && setOsChannel.error && <p className="text-sm text-red-300">{(setOsChannel.error as Error).message}</p>}

      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-surface-600 pt-4">
        <div>
          <div className="text-sm text-text-200">{t("virtuaos.kernel")}</div>
          <div className="text-xs text-text-500 mt-0.5 flex items-center gap-1.5">
            {t("virtuaos.runningKernel")}: <span className="text-text-300 font-mono">{status.runningKernel}</span>
            <ChannelBadge channel={status.runningKernelChannel} />
          </div>
          {status.installedKernelMetas.length > 0 && (
            <div className="text-xs text-text-500 mt-0.5">
              {t("virtuaos.installedMetas")}: <span className="font-mono">{status.installedKernelMetas.join(", ")}</span>
            </div>
          )}
        </div>
        <ChannelToggle value={status.kernelChannel} disabled={busy} onPick={(c) => pick("kernel", c)} />
      </div>
      {setKernelChannel.isPending && <p className="text-xs text-text-400">{t("virtuaos.kernelSwitching")}</p>}
      {kernelLog && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-400">{t("virtuaos.showLog")}</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/60 p-2 text-[11px] text-text-300 whitespace-pre-wrap">{kernelLog}</pre>
        </details>
      )}

      <Modal
        open={!!pending}
        onClose={() => { if (!busy) setPending(null); }}
        title={pending?.kind === "kernel" ? t("virtuaos.confirmKernelTitle", { channel: pending.channel }) : t("virtuaos.confirmOsTitle")}
        size="lg"
        footer={
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setPending(null)}>{t("action.cancel")}</button>
            <button className={pending?.channel === "DEV" ? "btn-danger" : "btn-primary"} disabled={busy} onClick={confirm}>
              {busy ? "..." : t("virtuaos.confirmSwitch", { channel: pending?.channel ?? "" })}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-text-300">
          {pending?.channel === "DEV" && <p className="text-amber-300">{t("virtuaos.devWarning")}</p>}
          {pending?.kind === "os" && <p>{t("virtuaos.osSwitchExplain")}</p>}
          {pending?.kind === "kernel" && pending.channel === "DEV" && <p>{t("virtuaos.kernelToDevExplain")}</p>}
          {pending?.kind === "kernel" && pending.channel === "PROD" && (
            <>
              <p>{t("virtuaos.kernelToProdExplain")}</p>
              {status.devKernelPackages.length > 0 ? (
                <ul className="rounded bg-surface-800 border border-surface-500 px-3 py-2 font-mono text-xs space-y-0.5">
                  {status.devKernelPackages.map((pkg) => <li key={pkg}>{pkg}</li>)}
                </ul>
              ) : (
                <p className="text-text-500">{t("virtuaos.nothingToPurge")}</p>
              )}
            </>
          )}
          {pending?.kind === "kernel" && <p className="font-medium">{t("virtuaos.rebootAnnounce")}</p>}
          {activeError && (
            <pre className="text-xs text-red-300 border border-red-900/60 bg-red-950/30 rounded px-3 py-2 whitespace-pre-wrap max-h-60 overflow-auto">
              {activeError.message}
            </pre>
          )}
        </div>
      </Modal>
    </div>
  );
}
