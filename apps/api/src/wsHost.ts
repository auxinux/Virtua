import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;

/**
 * The `Origin` of a request, when it names a web page the console WebSocket
 * can be served from. Native clients send their own window's origin instead:
 * Tauri is `tauri://localhost` on macOS and `http://tauri.localhost` on
 * Windows. Trusting those pointed the Desktop client at `localhost` (refused
 * with "AUXINUX_PUBLIC_HOST is required…") or at `tauri.localhost`.
 */
export function webOrigin(headers: IncomingHttpHeaders): URL | null {
  const raw = typeof headers.origin === "string" ? headers.origin : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "tauri.localhost" || url.hostname.endsWith(".tauri.localhost")) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Host the client reached, for a URL handed back to it: a web origin first
 * (the Vite dev proxy serves the UI from another port), then the reverse
 * proxy's forwarded host, then the Host header.
 */
export function clientHost(headers: IncomingHttpHeaders): string {
  const forwardedHost = (headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  return webOrigin(headers)?.host ?? forwardedHost ?? headers.host ?? "";
}

export function isLoopbackHost(host: string): boolean {
  return !host || LOOPBACK_HOST.test(host);
}
