import { decryptSecret } from "./secrets.js";

export interface VdmNodeRow {
  id: number;
  name: string;
  display_name: string | null;
  api_url: string;
  auth_token: string;
  enabled: number;
  status: string;
  last_seen_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  virtua_version?: string | null;
  compatibility?: string;
  last_error?: string | null;
  failure_count?: number;
  latency_ms?: number | null;
}

const DEFAULT_TIMEOUT_MS = Math.max(1_000, Number(process.env.AUXINUX_VDM_NODE_TIMEOUT_MS ?? 15_000));
const DEFAULT_GET_RETRIES = Math.max(0, Math.min(5, Number(process.env.AUXINUX_VDM_NODE_RETRIES ?? 1)));

export type NodeRequestFailure = "timeout" | "network" | "unauthorized" | "http" | "invalid-response";

export class NodeRequestError extends Error {
  constructor(
    message: string,
    readonly nodeName: string,
    readonly failure: NodeRequestFailure,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NodeRequestError";
  }
}

function retryable(method: string, error: unknown): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!(error instanceof NodeRequestError)) return false;
  return error.failure === "timeout" || error.failure === "network" || (error.statusCode !== undefined && error.statusCode >= 500);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchNode<T>(node: VdmNodeRow, pathname: string, init?: RequestInit & { timeoutMs?: number; retries?: number }): Promise<T> {
  const base = node.api_url.replace(/\/+$/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const retries = init?.retries ?? (method === "GET" || method === "HEAD" ? DEFAULT_GET_RETRIES : 0);
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const abortFromCaller = () => controller.abort(init?.signal?.reason);
    init?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const headers = new Headers(init?.headers ?? {});
      headers.set("x-auxinux-node-token", decryptSecret(node.auth_token));
      if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      const { timeoutMs: _timeoutMs, retries: _retries, ...fetchInit } = init ?? {};
      const res = await fetch(`${base}${pathname}`, { ...fetchInit, method, headers, signal: controller.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        const failure = res.status === 401 || res.status === 403 ? "unauthorized" : "http";
        throw new NodeRequestError(err.error ?? `HTTP ${res.status}`, node.name, failure, res.status);
      }
      try {
        return await res.json() as T;
      } catch {
        throw new NodeRequestError("Invalid JSON response", node.name, "invalid-response", res.status);
      }
    } catch (error) {
      if (error instanceof NodeRequestError) lastError = error;
      else if (controller.signal.aborted) lastError = new NodeRequestError(`Timeout after ${timeoutMs} ms`, node.name, "timeout");
      else lastError = new NodeRequestError(error instanceof Error ? error.message : "Network error", node.name, "network");
      if (attempt >= retries || !retryable(method, lastError)) throw lastError;
      await wait(Math.min(1_000, 150 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw lastError;
}

export async function tryFetchNode<T>(node: VdmNodeRow, pathname: string, fallback: T): Promise<T> {
  try {
    return await fetchNode<T>(node, pathname);
  } catch {
    return fallback;
  }
}

export async function pingNode(node: VdmNodeRow): Promise<boolean> {
  try {
    await fetchNode(node, "/api/internal/node/summary");
    return true;
  } catch {
    return false;
  }
}
