import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../../api/client";
import type { StoragePool } from "@auxinux/shared";
import { BetaBadge } from "./DisposableActions";

type QuickOs = "windows11" | "debian13";

const PROFILES: Record<QuickOs, { label: string; icon: string; specs: string; media: string }> = {
  windows11: {
    label: "Windows 11",
    icon: "🪟",
    specs: "4 vCPU · 4 Gio · 80 Gio · UEFI + Secure Boot + TPM 2.0",
    media: "ISO de la bibliothèque, sinon celle du dépôt AuxiNux, et le disque de pilotes VirtIO.",
  },
  debian13: {
    label: "Debian 13",
    icon: "🐧",
    specs: "2 vCPU · 4 Gio · 60 Gio · SSH, agent QEMU",
    media: "Installateur netboot officiel (dernière version, vérifié par SHA256), en français.",
  },
};

/**
 * One click for a ready VM: unattended Windows 11 or Debian 13, account
 * virtua / virtua. Runs on this node; follow the task, the VM appears at once
 * and installs itself.
 */
export default function QuickCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [os, setOs] = useState<QuickOs>("debian13");
  const [name, setName] = useState("");
  const [storagePool, setStoragePool] = useState("");
  const [bridge, setBridge] = useState("virbr0");
  const [makeBase, setMakeBase] = useState(false);
  const [error, setError] = useState("");

  const pools = useQuery<StoragePool[]>({ queryKey: ["storage", "pools", "local"], queryFn: () => apiGet<StoragePool[]>("/api/storage/pools") });
  const bridges = useQuery<string[]>({
    queryKey: ["network", "bridges-list", "local"],
    queryFn: async () => (await apiGet<{ name: string }[]>("/api/network/bridges")).map((b) => b.name),
  });
  const vmPools = (pools.data ?? []).filter((p) => p.content.includes("vm") || p.content.includes("disk"));
  useEffect(() => { if (!storagePool && vmPools[0]) setStoragePool(vmPools[0].name); }, [vmPools, storagePool]);
  useEffect(() => {
    const list = bridges.data ?? [];
    if (list.length && !list.includes(bridge)) setBridge(["virbr0", "br0"].find((b) => list.includes(b)) ?? list[0]);
  }, [bridges.data, bridge]);

  const create = useMutation({
    mutationFn: () => apiPost<{ name: string }>("/api/vms/quick-create", {
      os,
      storagePool,
      bridge,
      makeBase,
      ...(name.trim() ? { name: name.trim() } : {}),
    }),
    onSuccess: () => navigate(makeBase ? "/vms/disposable" : "/vms"),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-100">⚡ {t("quickCreate.title", "Création rapide")}</h1>
          <p className="text-xs text-text-500 mt-1">
            {t("quickCreate.intro", "Une VM prête à l'emploi, installée sans intervention. Compte : virtua / virtua (à changer après l'installation).")}
          </p>
        </div>
        <Link to="/vms/create" className="btn-secondary">{t("quickCreate.advanced", "Création avancée")}</Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(Object.keys(PROFILES) as QuickOs[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setOs(key)}
            className={`card p-4 text-left transition-colors ${os === key ? "border border-accent-blue" : "border border-transparent hover:border-surface-500"}`}
          >
            <div className="text-lg font-semibold text-text-100">{PROFILES[key].icon} {PROFILES[key].label}</div>
            <div className="text-xs text-text-300 mt-1">{PROFILES[key].specs}</div>
            <div className="text-xs text-text-500 mt-1">{PROFILES[key].media}</div>
          </button>
        ))}
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <label className="label">{t("vm.name")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={makeBase ? `base-${os}` : os === "windows11" ? "windows-11" : "debian-13"} />
          <p className="text-xs text-text-500 mt-1">{t("quickCreate.nameHelp", "Laissez vide pour un nom automatique. Sert aussi de nom d'hôte.")}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t("storage.pool")}</label>
            <select className="input" value={storagePool} onChange={(e) => setStoragePool(e.target.value)}>
              {vmPools.length === 0 && <option value="">—</option>}
              {vmPools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t("vm.networkBridge")}</label>
            <select className="input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
              {(bridges.data ?? [bridge]).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 rounded accent-accent-blue" checked={makeBase} onChange={(e) => setMakeBase(e.target.checked)} />
          <span className="text-sm text-text-300 flex flex-col">
            <span className="flex items-center">{t("quickCreate.makeBase", "Préparer comme base jetable")}<BetaBadge /></span>
            <span className="text-xs text-text-500">
              {t("quickCreate.makeBaseHelp", "Une fois installé, le système devient une base pour les VM jetables et la VM de préparation est supprimée.")}
            </span>
          </span>
        </label>
        <p className="text-xs text-text-500">
          {os === "windows11"
            ? t("quickCreate.windowsNote", "L'ISO Windows fait plus de 3 Go : le premier téléchargement prend du temps. L'installation se termine seule (environ 20 à 40 minutes) ; les supports d'installation sont retirés dès que l'agent invité répond.")
            : t("quickCreate.debianNote", "L'installateur s'éteint à la fin ; Virtua redémarre alors la VM sur son disque.")}
        </p>
        {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
        <button className="btn-primary" disabled={create.isPending || !storagePool} onClick={() => { setError(""); create.mutate(); }}>
          {create.isPending ? t("common.creating") : t("quickCreate.go", "Créer {{os}}", { os: PROFILES[os].label })}
        </button>
      </div>
    </div>
  );
}
