import { invoke } from "@tauri-apps/api/core";

export interface RuntimePlatform {
  /** `auxinux` on AuxiNux OS, else the os-release ID, `macos` or `windows`. */
  distro?: string;
  auxinux?: boolean;
  os: string;
  arch: string;
  mobile: boolean;
}

export async function getRuntimePlatform(): Promise<RuntimePlatform> {
  try {
    return await invoke<RuntimePlatform>("runtime_platform");
  } catch {
    return {
      distro: "web",
      auxinux: false,
      os: "web",
      arch: "unknown",
      mobile: false,
    };
  }
}
