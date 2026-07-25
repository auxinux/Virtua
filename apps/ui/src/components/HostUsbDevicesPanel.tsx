import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Usb } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { HostUsbDevice } from "@auxinux/shared";

type AttachedUsbDevice = {
  type: "usb";
  id: string;
  vendorId: string;
  productId: string;
  label: string;
  bus?: string;
  device?: string;
  devPath?: string;
  persistent?: boolean;
};

interface HostUsbDevicesPanelProps {
  resourceType: "vm" | "lxc";
  resourceName: string;
  nodeName?: string;
  attachedDevices?: AttachedUsbDevice[];
  invalidateKey: unknown[];
}

function usbPayload(device: Pick<AttachedUsbDevice, "vendorId" | "productId" | "bus" | "device" | "persistent">, persistent = true) {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    bus: persistent ? undefined : device.bus,
    device: persistent ? undefined : device.device,
    persistent,
  };
}

export function HostUsbDevicesPanel({
  resourceType,
  resourceName,
  nodeName,
  attachedDevices = [],
  invalidateKey,
}: HostUsbDevicesPanelProps) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const basePath = resourceType === "vm" ? `/api/vms/${resourceName}` : `/api/lxc/${resourceName}`;
  const usbPath = `/api/host/usb-devices${nodeName ? `?node=${encodeURIComponent(nodeName)}` : ""}`;

  const { data: devices = [], isLoading, error } = useQuery<HostUsbDevice[]>({
    queryKey: ["host", "usb-devices", nodeName ?? "local"],
    queryFn: () => apiGet<HostUsbDevice[]>(usbPath),
  });

  const selected = useMemo(
    () => devices.find((device) => device.id === selectedId),
    [devices, selectedId],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: invalidateKey });
    qc.invalidateQueries({ queryKey: ["host", "usb-devices", nodeName ?? "local"] });
  };

  const attach = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a USB device first");
      return apiPost(`${basePath}/usb/attach`, usbPayload(selected, true));
    },
    onSuccess: refresh,
  });

  const detach = useMutation({
    mutationFn: (device: AttachedUsbDevice) => apiPost(`${basePath}/usb/detach`, usbPayload(device)),
    onSuccess: refresh,
  });

  const attachedKeys = new Set(attachedDevices.map((device) => `${device.vendorId}:${device.productId}`));
  const available = devices.filter((device) => !attachedKeys.has(`${device.vendorId}:${device.productId}`));

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-300 flex items-center gap-2">
            <Usb className="w-4 h-4" />
            Périphériques USB du host
          </h3>
          <p className="text-xs text-text-500 mt-1">
            Pour une imprimante USB dans CUPS, attache le périphérique au LXC puis redétecte l’imprimante.
            Virtua garde l’attache persistante par modèle USB quand un seul périphérique correspond.
          </p>
        </div>
      </div>

      {attachedDevices.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-text-400">Attachés à cette ressource</div>
          {attachedDevices.map((device) => (
            <div key={device.id} className="flex items-center justify-between gap-3 rounded-lg border border-surface-600 bg-surface-700/30 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-text-200 truncate">{device.label}</div>
                <div className="text-xs font-mono text-text-500">
                  {device.vendorId}:{device.productId}
                  {device.bus && device.device ? ` · Bus ${device.bus} Device ${device.device}` : " · persistant"}
                </div>
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
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={isLoading || available.length === 0}
        >
          <option value="">{isLoading ? "Chargement des USB..." : "Sélectionner un périphérique USB"}</option>
          {available.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label} · {device.vendorId}:{device.productId} · Bus {device.bus} Device {device.device}
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
        <p className="text-xs text-text-500">Aucun périphérique USB disponible sur ce host.</p>
      )}
      {error && <p className="text-xs text-red-400">{String((error as Error).message)}</p>}
      {attach.isError && <p className="text-xs text-red-400">{String((attach.error as Error).message)}</p>}
      {detach.isError && <p className="text-xs text-red-400">{String((detach.error as Error).message)}</p>}
      {resourceType === "lxc" && (
        <p className="text-xs text-yellow-400">
          LXC redémarre si nécessaire pour appliquer le montage USB. Si plusieurs périphériques ont le même vendor/product, Virtua demandera une attache précise par Bus/Device.
        </p>
      )}
    </div>
  );
}
