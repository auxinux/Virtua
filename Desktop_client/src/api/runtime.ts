import { invoke } from "@tauri-apps/api/core";

export interface RuntimePlatform {
  os: string;
  arch: string;
  mobile: boolean;
}

export async function getRuntimePlatform(): Promise<RuntimePlatform> {
  try {
    return await invoke<RuntimePlatform>("runtime_platform");
  } catch {
    return {
      os: "web",
      arch: "unknown",
      mobile: false,
    };
  }
}
