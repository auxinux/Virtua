import { useSyncExternalStore } from "react";

/**
 * Console layout preferences, persisted per workstation. Shared by the app
 * shell (Layout), the console page and the graphical console so a single
 * toggle can fold every bar around the VM screen.
 */
export type ConsolePrefs = {
  /** Hide the app sidebar, header, machine list and info bars. */
  focus: boolean;
  /** Fold the machine list of the console page. */
  listCollapsed: boolean;
  /** Fold the power/address/metrics/mode bars above the console. */
  detailsCollapsed: boolean;
  /** Show the console action bar only while the pointer is over it. */
  autoHideActions: boolean;
};

const storageKey = "virtua.desktop.consolePrefs";
const defaults: ConsolePrefs = { focus: false, listCollapsed: false, detailsCollapsed: false, autoHideActions: false };
const listeners = new Set<() => void>();

function load(): ConsolePrefs {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<ConsolePrefs>) } : defaults;
  } catch {
    return defaults;
  }
}

let current = load();

export function setConsolePrefs(patch: Partial<ConsolePrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    // Private mode / quota: the preference still applies to this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConsolePrefs(): ConsolePrefs {
  return useSyncExternalStore(subscribe, () => current);
}
