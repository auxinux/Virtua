import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useConfirm } from "@/hooks/useDialog";

interface DesktopDevice {
  id: string;
  name: string;
  installationId: string | null;
  revoked: boolean;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
}

function formatMoment(value: string | null): string {
  if (!value) return "jamais";
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Pair and manage Virtua Desktop clients against this manager. A code is the
 * safe path — the operator never types the VDM password into a desktop app —
 * and every paired device stays revocable from here.
 */
export function DesktopClientsCard() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const devicesQuery = useQuery<DesktopDevice[]>({
    queryKey: ["desktop-devices"],
    queryFn: () => api.get("/api/desktop/my-devices"),
  });

  const pairMut = useMutation({
    mutationFn: () => api.post<{ code: string; expiresInMs: number }>("/api/desktop/pairing-codes"),
    onSuccess: (data) => setPairing({ code: data.code, expiresAt: Date.now() + data.expiresInMs }),
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/desktop/my-devices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop-devices"] }),
  });
  const revokeAllMut = useMutation({
    mutationFn: () => api.post("/api/desktop/my-devices/revoke-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop-devices"] }),
  });
  const purgeMut = useMutation({
    mutationFn: () => api.post("/api/desktop/my-devices/purge-revoked"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desktop-devices"] }),
  });

  // The countdown only needs to tick while a code is on screen.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (pairing && pairing.expiresAt <= now) setPairing(null);
  }, [pairing, now]);

  const devices = devicesQuery.data ?? [];
  const active = devices.filter((device) => !device.revoked);
  const revoked = devices.filter((device) => device.revoked);

  return (
    <div className="space-y-4">
      <p className="text-sm text-vdm-textMuted">
        Le client Desktop se connecte à ce gestionnaire et voit toutes les machines de tous les
        nœuds. Serveur à saisir dans le client :{" "}
        <span className="font-mono text-vdm-text">{window.location.origin}</span>
      </p>

      <div className="space-y-2">
        <button className="vdm-btn-primary" disabled={pairMut.isPending} onClick={() => pairMut.mutate()}>
          {pairMut.isPending ? "Génération…" : "Générer un code d'appairage"}
        </button>
        {pairMut.isError && <p className="text-sm text-vdm-danger">{(pairMut.error as Error).message}</p>}
        {pairing && (
          <div className="rounded-lg border border-vdm-accent/40 bg-vdm-accent/10 px-3 py-3 space-y-1">
            <p className="font-mono text-2xl tracking-[0.3em] text-vdm-text">{pairing.code}</p>
            <p className="text-xs text-vdm-textMuted">
              Saisissez ce code dans l'onglet « Code pairing » du client Desktop. Valide encore{" "}
              {formatCountdown(pairing.expiresAt - now)} et utilisable une seule fois.
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-vdm-textMuted">
            Appareils appairés ({active.length})
          </span>
          <div className="flex gap-2">
            {active.length > 0 && (
              <button
                className="vdm-btn-danger text-xs"
                disabled={revokeAllMut.isPending}
                onClick={async () => {
                  if (await confirm({
                    title: "Révoquer tous les clients Desktop ?",
                    message: "Chaque appareil sera déconnecté immédiatement et devra être appairé de nouveau.",
                    confirmLabel: "Tout révoquer",
                  })) revokeAllMut.mutate();
                }}
              >
                Tout révoquer
              </button>
            )}
            {revoked.length > 0 && (
              <button className="vdm-btn-ghost text-xs" disabled={purgeMut.isPending} onClick={() => purgeMut.mutate()}>
                Purger les révoqués
              </button>
            )}
          </div>
        </div>

        <div className="vdm-card divide-y divide-vdm-border/50">
          {devicesQuery.isLoading ? (
            <p className="px-3 py-4 text-sm text-vdm-textMuted">Chargement…</p>
          ) : devices.length === 0 ? (
            <p className="px-3 py-4 text-sm text-vdm-textMuted">Aucun client Desktop appairé.</p>
          ) : devices.map((device) => (
            <div key={device.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-vdm-text">{device.name}</span>
                <p className="text-xs text-vdm-textMuted">
                  Vu {formatMoment(device.lastSeenAt)}
                  {device.lastIp ? ` depuis ${device.lastIp}` : ""}
                </p>
              </div>
              <span className={device.revoked ? "pill-gray text-xs" : "pill-green text-xs"}>
                {device.revoked ? "révoqué" : "actif"}
              </span>
              <button
                className="vdm-btn-danger text-xs"
                disabled={revokeMut.isPending}
                onClick={async () => {
                  if (await confirm({
                    title: device.revoked ? `Supprimer ${device.name} ?` : `Révoquer ${device.name} ?`,
                    message: device.revoked
                      ? "L'appareil disparaît de la liste."
                      : "L'appareil est déconnecté immédiatement et devra être appairé de nouveau.",
                    confirmLabel: device.revoked ? "Supprimer" : "Révoquer",
                  })) revokeMut.mutate(device.id);
                }}
              >
                {device.revoked ? "Supprimer" : "Révoquer"}
              </button>
            </div>
          ))}
        </div>
        {devicesQuery.isError && (
          <p className="mt-2 text-sm text-vdm-danger">{(devicesQuery.error as Error).message}</p>
        )}
      </div>
      {dialog}
    </div>
  );
}
