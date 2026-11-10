import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiDelete, apiGet, apiPost } from "../../api/client";
import { Modal, ConfirmModal } from "../../components/ui/Modal";
import { StatusBadge } from "../../components/ui/Badge";
import { useAuth } from "../../utils/useAuth";
import { formatBytes, formatDate } from "../../utils/formatBytes";
import type { BaseInfo, DepotBaseEntry, QemuVm, StoragePool } from "@auxinux/shared";
import { BetaBadge, DisposableStopChoices } from "./DisposableActions";

const OS_LABELS: Record<string, string> = { windows11: "Windows 11", debian13: "Debian 13", other: "Système" };

/**
 * Disposable VMs (beta): bases on this node, launching a disposable copy,
 * and what to do with the stopped ones. Bases are managed by administrators.
 */
export default function DisposablePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [launchBase, setLaunchBase] = useState<BaseInfo | null>(null);
  const [deleteBase, setDeleteBase] = useState<BaseInfo | null>(null);
  const [makeBaseOpen, setMakeBaseOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const bases = useQuery<BaseInfo[]>({
    queryKey: ["disposable", "bases"],
    queryFn: () => apiGet<BaseInfo[]>("/api/disposable/bases"),
    refetchInterval: 15_000,
  });
  const vms = useQuery<QemuVm[]>({
    queryKey: ["vms", "disposable-page"],
    queryFn: () => apiGet<QemuVm[]>("/api/vms"),
    refetchInterval: 5_000,
  });
  const depot = useQuery<{ base: string; items: DepotBaseEntry[] }>({
    queryKey: ["disposable", "depot"],
    queryFn: () => apiGet("/api/disposable/depot"),
    enabled: isAdmin,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const removeBase = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/disposable/bases/${encodeURIComponent(id)}`),
    onSuccess: () => { setDeleteBase(null); qc.invalidateQueries({ queryKey: ["disposable"] }); },
    onError: (err: Error) => setError(err.message),
  });
  const importDepot = useMutation({
    mutationFn: (name: string) => apiPost("/api/disposable/depot/import", { name }),
    onSuccess: () => setNotice(t("disposable.importStarted", "Téléchargement lancé : suivez-le dans les tâches. La base apparaîtra ici une fois vérifiée.")),
    onError: (err: Error) => setError(err.message),
  });

  const disposables = (vms.data ?? []).filter((vm) => vm.disposable);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-100 flex items-center">{t("disposable.title", "VM jetables")}<BetaBadge /></h1>
          <p className="text-xs text-text-500 mt-1">
            {t("disposable.intro", "Une base est un système installé gardé en lecture seule. Une VM jetable est une copie instantanée de la base : à l'arrêt, jetez-la, repartez de la base, gardez-la ou convertissez-la en VM normale.")}
          </p>
        </div>
        <Link to="/vms" className="btn-secondary">{t("nav.vms")}</Link>
      </div>

      {notice && <div className="rounded border border-emerald-800 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
      {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}

      <section className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-300">{t("disposable.bases", "Bases")}</h2>
          {isAdmin && (
            <button className="btn-secondary text-sm" onClick={() => setMakeBaseOpen(true)}>
              {t("disposable.makeBase", "Créer une base depuis une VM arrêtée")}
            </button>
          )}
        </div>
        {bases.isLoading ? (
          <p className="text-sm text-text-500">{t("common.loading", "Chargement…")}</p>
        ) : (bases.data ?? []).length === 0 ? (
          <p className="text-sm text-text-500">
            {t("disposable.noBase", "Aucune base sur ce nœud. Importez-en une du dépôt AuxiNux, faites-en une à partir d'une VM arrêtée, ou utilisez la création rapide avec « Préparer comme base jetable ».")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-500 text-xs">
                <th className="py-2">{t("common.name")}</th>
                <th>{t("disposable.system", "Système")}</th>
                <th>{t("disposable.hardware", "Matériel")}</th>
                <th>{t("disposable.size", "Taille")}</th>
                <th>{t("disposable.inUse", "Utilisée par")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(bases.data ?? []).map((base) => (
                <tr key={base.id} className="border-t border-surface-600">
                  <td className="py-2">
                    <div className="text-text-200">{base.label}</div>
                    <div className="text-2xs text-text-500 font-mono">{base.id} · {base.source === "depot" ? t("disposable.fromDepot", "dépôt") : t("disposable.local", "local")} · {base.createdAt ? formatDate(base.createdAt) : "—"}</div>
                  </td>
                  <td className="text-text-300">{OS_LABELS[base.os] ?? base.os} · {base.architecture.toUpperCase()}</td>
                  <td className="text-text-400 text-xs">{base.cpu} vCPU · {base.memoryMib} Mio · {base.diskGib} Gio{base.secureBoot ? " · Secure Boot" : ""}{base.tpm2 ? " · TPM" : ""}</td>
                  <td className="text-text-400">{formatBytes(base.sizeBytes)}</td>
                  <td className="text-text-400 text-xs">{base.inUse > 0 ? base.usedBy.join(", ") : "—"}</td>
                  <td className="text-right whitespace-nowrap space-x-2">
                    <button className="btn-primary text-xs px-2 py-1" onClick={() => { setNotice(""); setError(""); setLaunchBase(base); }}>
                      {t("disposable.launch", "Lancer une VM jetable")}
                    </button>
                    {isAdmin && (
                      <button className="btn-danger text-xs px-2 py-1" disabled={base.inUse > 0} title={base.inUse > 0 ? t("disposable.baseInUse", "Jetez ou convertissez d'abord ses VM jetables") : undefined} onClick={() => setDeleteBase(base)}>
                        {t("action.delete", "Supprimer")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-text-300">{t("disposable.running", "VM jetables")}</h2>
        {disposables.length === 0 ? (
          <p className="text-sm text-text-500">{t("disposable.none", "Aucune VM jetable pour le moment.")}</p>
        ) : (
          <div className="space-y-2">
            {disposables.map((vm) => (
              <div key={vm.name} className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-600 pt-2">
                <div className="flex items-center gap-3">
                  <Link to={`/vms/${encodeURIComponent(vm.name)}`} className="text-accent-blue hover:underline">{vm.name}</Link>
                  <StatusBadge state={vm.state} />
                  <span className="text-xs text-text-500">{vm.disposable!.baseLabel}{vm.disposable!.strict ? ` · ${t("disposable.strict", "bac à sable strict")}` : ""}</span>
                </div>
                {vm.state === "stopped" ? (
                  <DisposableStopChoices vmName={vm.name} disposable={vm.disposable!} compact />
                ) : (
                  <span className="text-xs text-text-500">{t("disposable.stopToChoose", "Arrêtez-la pour la jeter, la réinitialiser ou la convertir.")}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text-300">{t("disposable.depot", "Bases du dépôt AuxiNux (.vmtmp)")}</h2>
          {depot.isLoading ? (
            <p className="text-sm text-text-500">{t("common.loading", "Chargement…")}</p>
          ) : depot.error ? (
            <p className="text-sm text-text-500">{(depot.error as Error).message}</p>
          ) : (depot.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-text-500">{t("disposable.depotEmpty", "Aucune base .vmtmp sur le dépôt pour l'architecture de ce nœud.")}</p>
          ) : (
            <ul className="space-y-1.5">
              {depot.data!.items.map((item) => (
                <li key={item.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-text-200 font-mono">{item.name}<span className="ml-2 text-text-500">{item.sizeBytes ? formatBytes(item.sizeBytes) : ""}</span></span>
                  <button className="btn-secondary text-xs px-2 py-1" disabled={importDepot.isPending} onClick={() => { setNotice(""); setError(""); importDepot.mutate(item.name); }}>
                    {t("disposable.import", "Importer")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <LaunchModal base={launchBase} onClose={() => setLaunchBase(null)} onLaunched={(name) => { setLaunchBase(null); setNotice(t("disposable.launched", "VM jetable {{name}} démarrée.", { name })); }} />
      <MakeBaseModal open={makeBaseOpen} vms={(vms.data ?? []).filter((vm) => !vm.disposable)} onClose={() => setMakeBaseOpen(false)} onStarted={() => { setMakeBaseOpen(false); setNotice(t("disposable.baseStarted", "Copie du disque lancée : la base apparaîtra ici une fois terminée (suivez la tâche).")); }} />
      <ConfirmModal
        open={!!deleteBase}
        onClose={() => setDeleteBase(null)}
        onConfirm={() => deleteBase && removeBase.mutate(deleteBase.id)}
        title={t("disposable.deleteBase", "Supprimer la base ?")}
        message={t("disposable.deleteBaseMsg", "La base « {{label}} » et son disque seront supprimés définitivement.", { label: deleteBase?.label ?? "" })}
        confirmLabel={t("action.delete", "Supprimer")}
        dangerous
        loading={removeBase.isPending}
      />
    </div>
  );
}

function LaunchModal({ base, onClose, onLaunched }: { base: BaseInfo | null; onClose: () => void; onLaunched: (name: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [storagePool, setStoragePool] = useState("");
  const [bridge, setBridge] = useState("virbr0");
  const [strict, setStrict] = useState(false);
  const [noNetwork, setNoNetwork] = useState(false);
  const [error, setError] = useState("");

  const pools = useQuery<StoragePool[]>({ queryKey: ["storage", "pools", "local"], queryFn: () => apiGet<StoragePool[]>("/api/storage/pools"), enabled: !!base });
  const bridges = useQuery<string[]>({
    queryKey: ["network", "bridges-list", "local"],
    queryFn: async () => (await apiGet<{ name: string }[]>("/api/network/bridges")).map((b) => b.name),
    enabled: !!base,
  });
  const vmPools = (pools.data ?? []).filter((p) => p.content.includes("vm") || p.content.includes("disk"));
  useEffect(() => { if (!storagePool && vmPools[0]) setStoragePool(vmPools[0].name); }, [vmPools, storagePool]);
  useEffect(() => {
    const list = bridges.data ?? [];
    if (list.length && !list.includes(bridge)) setBridge(["virbr0", "br0"].find((b) => list.includes(b)) ?? list[0]);
  }, [bridges.data, bridge]);

  const launch = useMutation({
    mutationFn: () => apiPost<{ name: string }>("/api/disposable/launch", {
      baseId: base!.id,
      ...(name.trim() ? { name: name.trim() } : {}),
      storagePool,
      bridge,
      strict,
      noNetwork,
    }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["vms"] });
      qc.invalidateQueries({ queryKey: ["disposable"] });
      setName("");
      onLaunched(result.name);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open={!!base}
      onClose={onClose}
      title={`${t("disposable.launch", "Lancer une VM jetable")} · ${base?.label ?? ""}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>{t("action.cancel")}</button>
          <button className="btn-primary" disabled={launch.isPending || !storagePool} onClick={() => { setError(""); launch.mutate(); }}>
            {launch.isPending ? t("common.creating") : t("disposable.launchNow", "Lancer")}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">{t("vm.name")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`jetable-${base?.os ?? "vm"}-1`} />
          <p className="text-xs text-text-500 mt-1">{t("disposable.nameHelp", "Laissez vide pour un nom automatique.")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("storage.pool")}</label>
            <select className="select" value={storagePool} onChange={(e) => setStoragePool(e.target.value)}>
              {vmPools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t("vm.networkBridge")}</label>
            <select className="select" value={bridge} onChange={(e) => setBridge(e.target.value)} disabled={noNetwork}>
              {(bridges.data ?? [bridge]).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 rounded accent-accent-blue" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          <span className="text-sm text-text-300">
            {t("disposable.strictToggle", "Bac à sable strict")}
            <span className="block text-xs text-text-500">{t("disposable.strictHelp", "Rien n'est écrit sur le disque : toutes les modifications disparaissent à l'arrêt.")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 rounded accent-accent-blue" checked={noNetwork} onChange={(e) => setNoNetwork(e.target.checked)} />
          <span className="text-sm text-text-300">
            {t("disposable.noNetwork", "Sans réseau")}
            <span className="block text-xs text-text-500">{t("disposable.noNetworkHelp", "Aucune carte réseau : pour ouvrir un fichier douteux sans risque de fuite.")}</span>
          </span>
        </label>
        {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
      </div>
    </Modal>
  );
}

function MakeBaseModal({ open, vms, onClose, onStarted }: { open: boolean; vms: QemuVm[]; onClose: () => void; onStarted: () => void }) {
  const { t } = useTranslation();
  const [vmName, setVmName] = useState("");
  const [label, setLabel] = useState("");
  const [os, setOs] = useState("other");
  const [removeSource, setRemoveSource] = useState(false);
  const [error, setError] = useState("");
  const stopped = vms.filter((vm) => vm.state === "stopped");

  const create = useMutation({
    mutationFn: () => apiPost("/api/disposable/bases", { vmName, os, removeSource, ...(label.trim() ? { label: label.trim() } : {}) }),
    onSuccess: () => { setVmName(""); setLabel(""); setRemoveSource(false); onStarted(); },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("disposable.makeBase", "Créer une base depuis une VM arrêtée")}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>{t("action.cancel")}</button>
          <button className="btn-primary" disabled={!vmName || create.isPending} onClick={() => { setError(""); create.mutate(); }}>
            {create.isPending ? t("common.creating") : t("disposable.makeBaseNow", "Créer la base")}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">{t("disposable.sourceVm", "VM source (arrêtée)")}</label>
          <select className="select" value={vmName} onChange={(e) => setVmName(e.target.value)}>
            <option value="">— {t("common.select")} —</option>
            {stopped.map((vm) => <option key={vm.name} value={vm.name}>{vm.displayName || vm.name}</option>)}
          </select>
          {stopped.length === 0 && <p className="text-xs text-text-500 mt-1">{t("disposable.noStoppedVm", "Aucune VM arrêtée : arrêtez la VM à copier.")}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("disposable.system", "Système")}</label>
            <select className="select" value={os} onChange={(e) => setOs(e.target.value)}>
              <option value="debian13">Debian 13</option>
              <option value="windows11">Windows 11</option>
              <option value="other">{t("disposable.otherOs", "Autre")}</option>
            </select>
          </div>
          <div>
            <label className="label">{t("disposable.label", "Nom de la base")}</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("disposable.labelAuto", "automatique")} />
          </div>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 rounded accent-accent-blue" checked={removeSource} onChange={(e) => setRemoveSource(e.target.checked)} />
          <span className="text-sm text-text-300">{t("disposable.removeSource", "Supprimer la VM source une fois la base créée")}</span>
        </label>
        <p className="text-xs text-text-500">
          {t("disposable.generalizeHint", "Généralisez le système avant (Windows : sysprep ; Linux : machine-id et clés SSH vides) pour que chaque copie ait sa propre identité. Les bases Debian de la création rapide le sont déjà.")}
        </p>
        {error && <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
      </div>
    </Modal>
  );
}
