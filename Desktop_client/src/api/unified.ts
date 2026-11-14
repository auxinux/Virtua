import { invoke } from "@tauri-apps/api/core";

export interface UnifiedApp {
  id: string;
  name: string;
  path: string;
  args: string;
  /** PNG, base64. */
  icon?: string | null;
}

export interface UnifiedClientStatus {
  available: boolean;
  kind?: string | null;
  detail: string;
  installable: boolean;
}

export interface UnifiedVm {
  id: string;
  name: string;
  state: string;
  architecture: string;
  enabled: boolean;
  user?: string | null;
  agent: boolean;
  /** Agent Virtua version running in the guest. */
  virtuaAgent?: string | null;
  /** The Agent Virtua can be pushed through the QEMU guest agent. */
  canInstallAgent?: boolean;
  /** Agent version embedded in this Virtua Desktop. */
  bundledAgent?: string;
  rdpReady: boolean;
  needsRestart: boolean;
  apps: UnifiedApp[];
  integrated: boolean;
}

export interface UnifiedOverview {
  client: UnifiedClientStatus;
  vms: UnifiedVm[];
}

/** Windows apps of local VMs opened as host windows (RDP RemoteApp). */
export const unified = {
  overview: () => invoke<UnifiedOverview>("local_unified_overview"),
  prepare: (id: string, username: string, password: string) => invoke<void>("local_unified_prepare", { id, username, password }),
  disable: (id: string) => invoke<void>("local_unified_disable", { id }),
  refreshApps: (id: string) => invoke<UnifiedApp[]>("local_unified_refresh_apps", { id }),
  launch: (id: string, appId?: string) => invoke<void>("local_unified_launch", { id, appId: appId ?? null }),
  integrate: (id: string, enabled: boolean) => invoke<number>("local_unified_integrate", { id, enabled }),
  installClient: () => invoke<UnifiedClientStatus>("local_unified_install_client"),
  installAgent: (id: string) => invoke<void>("local_install_virtua_agent", { id }),
};
