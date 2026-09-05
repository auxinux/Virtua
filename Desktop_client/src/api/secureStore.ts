import { invoke } from "@tauri-apps/api/core";

const ENDPOINT_KEY = "auxinux:virtua:endpoint";
const DEVICE_NAME_KEY = "auxinux:virtua:device-name";
const INSTALLATION_ID_KEY = "auxinux:virtua:installation-id";
const WEB_REFRESH_KEY = "auxinux:virtua:refresh-token:fallback";

const isTauri = () => "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

type DesktopSettingKey = "endpoint" | "deviceName" | "installationId";

async function loadNativeSetting(key: DesktopSettingKey) {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("load_desktop_setting", { key });
  } catch {
    return null;
  }
}

async function saveNativeSetting(key: DesktopSettingKey, value: string) {
  if (!isTauri()) return;
  await invoke("save_desktop_setting", { key, value }).catch(() => undefined);
}

async function clearNativeSetting(key: DesktopSettingKey) {
  if (!isTauri()) return;
  await invoke("clear_desktop_setting", { key }).catch(() => undefined);
}

export const secureStore = {
  getEndpoint() {
    return window.localStorage.getItem(ENDPOINT_KEY) ?? "";
  },

  async getEndpointAsync() {
    const nativeValue = await loadNativeSetting("endpoint");
    if (nativeValue) {
      window.localStorage.setItem(ENDPOINT_KEY, nativeValue);
      return nativeValue;
    }
    return this.getEndpoint();
  },

  setEndpoint(endpoint: string) {
    window.localStorage.setItem(ENDPOINT_KEY, endpoint);
    void saveNativeSetting("endpoint", endpoint);
  },

  async setEndpointAsync(endpoint: string) {
    window.localStorage.setItem(ENDPOINT_KEY, endpoint);
    await saveNativeSetting("endpoint", endpoint);
  },

  clearEndpoint() {
    window.localStorage.removeItem(ENDPOINT_KEY);
    void clearNativeSetting("endpoint");
  },

  getDeviceName() {
    return window.localStorage.getItem(DEVICE_NAME_KEY) ?? `AuxiNux Desktop ${navigator.platform || "Client"}`;
  },

  async getDeviceNameAsync() {
    const nativeValue = await loadNativeSetting("deviceName");
    if (nativeValue) {
      window.localStorage.setItem(DEVICE_NAME_KEY, nativeValue);
      return nativeValue;
    }
    return this.getDeviceName();
  },

  setDeviceName(deviceName: string) {
    window.localStorage.setItem(DEVICE_NAME_KEY, deviceName);
    void saveNativeSetting("deviceName", deviceName);
  },

  async setDeviceNameAsync(deviceName: string) {
    window.localStorage.setItem(DEVICE_NAME_KEY, deviceName);
    await saveNativeSetting("deviceName", deviceName);
  },

  getInstallationId() {
    const existing = window.localStorage.getItem(INSTALLATION_ID_KEY);
    if (existing) return existing;
    const nextId = globalThis.crypto?.randomUUID?.() ?? `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(INSTALLATION_ID_KEY, nextId);
    void saveNativeSetting("installationId", nextId);
    return nextId;
  },

  async getInstallationIdAsync() {
    const nativeValue = await loadNativeSetting("installationId");
    if (nativeValue) {
      window.localStorage.setItem(INSTALLATION_ID_KEY, nativeValue);
      return nativeValue;
    }
    return this.getInstallationId();
  },

  async setInstallationIdAsync(installationId: string) {
    window.localStorage.setItem(INSTALLATION_ID_KEY, installationId);
    await saveNativeSetting("installationId", installationId);
  },

  async getRefreshToken() {
    if (isTauri()) {
      try {
        return await invoke<string | null>("load_refresh_token") ?? window.localStorage.getItem(WEB_REFRESH_KEY);
      } catch {
        return window.localStorage.getItem(WEB_REFRESH_KEY);
      }
    }
    return window.localStorage.getItem(WEB_REFRESH_KEY);
  },

  async setRefreshToken(token: string) {
    if (isTauri()) {
      try {
        await invoke("save_refresh_token", { token });
        window.localStorage.removeItem(WEB_REFRESH_KEY);
      } catch (error) {
        // Development/debug builds may not always have Keychain access yet.
        window.localStorage.setItem(WEB_REFRESH_KEY, token);
      }
    } else {
      window.localStorage.setItem(WEB_REFRESH_KEY, token);
    }
  },

  async clearRefreshToken() {
    if (isTauri()) {
      await invoke("clear_refresh_token").catch(() => undefined);
      window.localStorage.removeItem(WEB_REFRESH_KEY);
      return;
    }
    window.localStorage.removeItem(WEB_REFRESH_KEY);
  },
};
