import { invoke } from "@tauri-apps/api/core";

let lastMessage = "";
let lastAt = 0;
let logPath: string | null = null;

/** Where the errors land, once the first one was written. */
export function uiLogPath() {
  return logPath;
}

function describe(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * Write an interface error to Logs/interface.log (Rust side) with the page it
 * happened on. Never throws: logging must not become the next crash.
 */
export async function reportUiError(kind: string, error: unknown, extra = "") {
  try {
    const text = `[${kind}] ${window.location.hash || "#/"}\n${describe(error)}${extra ? `\n${extra}` : ""}`;
    const now = Date.now();
    // The same failure repeated by a render loop is written once.
    if (text === lastMessage && now - lastAt < 5000) return;
    lastMessage = text;
    lastAt = now;
    logPath = await invoke<string>("log_ui_error", { message: text });
  } catch {
    /* Web preview or older backend: the console still has it. */
  }
}

/** Errors outside React rendering (event handlers, promises nobody awaited). */
export function installGlobalErrorLog() {
  window.addEventListener("error", (event) => void reportUiError("window.error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => void reportUiError("promise", event.reason));
}
