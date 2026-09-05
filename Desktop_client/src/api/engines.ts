import { invoke } from "@tauri-apps/api/core";
export type EngineId = "qemu" | "docker" | "lxc";
export interface EngineStatus { id: EngineId; state: "ready" | "missing" | "stopped" | "unavailable"; detail: string }
export interface EngineOverview { os: string; architecture: string; accelerator: string; engines: EngineStatus[]; busy: boolean }
export const engines = {
  status: () => invoke<EngineOverview>("local_engine_status"),
  prepare: (engine: EngineId) => invoke<EngineOverview>("local_prepare_engine", { engine }),
  stopLxc: () => invoke<void>("local_stop_lxc_vm"),
  lxcLogs: () => invoke<string>("local_lxc_logs"),
};
