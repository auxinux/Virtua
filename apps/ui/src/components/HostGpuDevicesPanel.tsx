import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { HostGpuDevice } from "@auxinux/shared";

type AttachedGpuDevice = {
  type: "gpu";
  id: "dri" | "nvidia";
  label: string;
  devPaths: string[];
};

interface HostGpuDevicesPanelProps {
  resourceName: string;
  nodeName?: string;
  attachedDevices?: AttachedGpuDevice[];
  invalidateKey: unknown[];
}

export function HostGpuDevicesPanel({
  resourceName,
  nodeName,
  attachedDevices = [],
  invalidateKey,
}: HostGpuDevicesPanelProps) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<"" | "dri" | "nvidia">("");
  const gpuPath = `/api/host/gpu-devices${nodeName ? `?node=${encodeURIComponent(nodeName)}` : ""}`;
  const basePath = `/api/lxc/${resourceName}`;

  const { data: devices = [], isLoading, error } = useQuery<HostGpuDevice[]>({
    queryKey: ["host", "gpu-devices", nodeName ?? "local"],
    queryFn: () => apiGet<HostGpuDevice[]>(gpuPath),
  });

  const selected = useMemo(
    () => devices.find((device) => device.id === selectedId),
    [devices, selectedId],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: invalidateKey });
    qc.invalidateQueries({ queryKey: ["host", "gpu-devices", nodeName ?? "local"] });
  };

  const attach = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a GPU first");
      return apiPost(`${basePath}/gpu/attach`, { id: selected.id });
    },
    onSuccess: refresh,
  });

  const detach = useMutation({
    mutationFn: (device: AttachedGpuDevice) => apiPost(`${basePath}/gpu/detach`, { id: device.id }),
    onSuccess: refresh,
  });

  const attachedIds = new Set(attachedDevices.map((device) => device.id));
  const available = devices.filter((device) => !attachedIds.has(device.id));

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-300 flex items-center gap-2">
          <Cpu className="w-4 h-4" />
          GPU du host pour LXC
        </h3>
        <p className="text-xs text-text-500 mt-1">
          Partage simple pour conteneur: expose /dev/dri pour Intel/AMD ou /dev/nvidia* pour NVIDIA.
          Utile pour Ollama, Jellyfin, encodage vidéo et workloads compute légers.
        </p>
      </div>

      {attachedDevices.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-text-400">Attachés à ce LXC</div>
          {attachedDevices.map((device) => (
            <div key={device.id} className="flex items-center justify-between gap-3 rounded-lg border border-surface-600 bg-surface-700/30 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-text-200 truncate">{device.label}</div>
                <div className="text-xs font-mono text-text-500 truncate">{device.devPaths.join(", ")}</div>
              </div>
              <button
                className="btn-ghost btn-sm text-red-400"
                disabled={detach.isPending}
                onClick={() => detach.mutate(device)}
              >
                Détacher
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
        <select
          className="select"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value as "" | "dri" | "nvidia")}
          disabled={isLoading || available.length === 0}
        >
          <option value="">{isLoading ? "Chargement des GPU..." : "Sélectionner un GPU"}</option>
          {available.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
              {device.assignedTo ? ` · déjà attaché à ${device.assignedTo.name}` : ""}
            </option>
          ))}
        </select>
        <button
          className="btn-primary"
          disabled={!selected || attach.isPending}
          onClick={() => attach.mutate()}
        >
          {attach.isPending ? "Attache..." : "Attacher"}
        </button>
      </div>

      {available.length === 0 && !isLoading && (
        <p className="text-xs text-text-500">Aucun GPU partageable détecté sur ce host.</p>
      )}
      {error && <p className="text-xs text-red-400">{String((error as Error).message)}</p>}
      {attach.isError && <p className="text-xs text-red-400">{String((attach.error as Error).message)}</p>}
      {detach.isError && <p className="text-xs text-red-400">{String((detach.error as Error).message)}</p>}
      <p className="text-xs text-yellow-400">
        Le LXC redémarre si nécessaire pour appliquer le montage. Les drivers et bibliothèques utilisateur doivent être compatibles dans le conteneur.
      </p>
    </div>
  );
}
