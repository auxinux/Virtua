import { invoke } from "@tauri-apps/api/core";
import { virtuaClient } from "@/api/virtuaClient";
import type { LocalVm } from "@/types";

export interface BaseInfo {
  id: string;
  label: string;
  os: string;
  architecture: string;
  guestOs: string;
  cpu: number;
  memoryMib: number;
  diskGib: number;
  createdAt: string;
  source: string;
  size: number;
  inUse: number;
}

export interface DepotBase {
  name: string;
  url: string;
  size?: number | null;
}

export type DisposableAction = "discard" | "reset" | "convert" | "keep";

/** Disposable VMs: copy-on-write copies of an installed base (disposable.rs). */
export const disposables = {
  bases: () => invoke<BaseInfo[]>("local_list_bases"),
  depot: () => invoke<DepotBase[]>("local_depot_bases"),
  download: (base: DepotBase) => invoke<unknown>("local_download_base", { name: base.name, url: base.url }),
  importFile: (path: string) => invoke<unknown>("local_import_base_file", { path }),
  exportBase: (id: string) => invoke<string>("local_export_base", { id }),
  deleteBase: (id: string) => invoke<void>("local_delete_base", { id }),
  baseFromVm: (vmId: string) => invoke<unknown>("local_base_from_vm", { vmId }),
  prepare: (os: "windows11" | "debian13") => invoke<LocalVm>("local_prepare_base", { os }),
  launch: (baseId: string, strict: boolean, network: "user" | "isolated") =>
    invoke<LocalVm>("local_launch_disposable", { baseId, strict, network }),
  act: (id: string, action: DisposableAction) => invoke<LocalVm | null>("local_disposable_action", { id, action }),
};

/**
 * What the Jetables page needs, from this computer or from a Virtua server
 * (0.8.11+). Server bases are built and imported in its web interface: the
 * optional operations are local-only.
 */
export interface DisposableApi {
  bases: () => Promise<BaseInfo[]>;
  launch: (baseId: string, strict: boolean, network: "user" | "isolated") => Promise<{ id: string }>;
  act: (id: string, action: DisposableAction) => Promise<unknown>;
  depot?: () => Promise<DepotBase[]>;
  download?: (base: DepotBase) => Promise<unknown>;
  prepare?: (os: "windows11" | "debian13") => Promise<unknown>;
  exportBase?: (id: string) => Promise<string>;
  deleteBase?: (id: string) => Promise<void>;
  /** Shown in place of the local-only sections. */
  remoteNote?: string;
}

export const localDisposableApi: DisposableApi = {
  bases: disposables.bases,
  launch: disposables.launch,
  act: disposables.act,
  depot: disposables.depot,
  download: disposables.download,
  prepare: disposables.prepare,
  exportBase: disposables.exportBase,
  deleteBase: disposables.deleteBase,
};

export const cloudDisposableApi: DisposableApi = {
  bases: async () =>
    (await virtuaClient.disposable.bases()).map((base) => ({
      ...base,
      guestOs: base.os.startsWith("windows") ? "windows" : "other",
      createdAt: "",
      source: "server",
    })),
  launch: (baseId, strict, network) => virtuaClient.disposable.launch(baseId, strict, network),
  act: (id, action) => virtuaClient.disposable.act(id, action),
  remoteNote: "Bases du serveur Virtua : elles se préparent et s’importent dans son interface web (VM → Jetables).",
};
