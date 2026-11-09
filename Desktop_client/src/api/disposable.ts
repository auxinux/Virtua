import { invoke } from "@tauri-apps/api/core";
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
