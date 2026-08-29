let csrfToken: string | null = null;

function reportMutationError(method: string, message: string) {
  if (method !== "GET") window.dispatchEvent(new CustomEvent("vdm-api-error", { detail: message }));
}

async function fetchCsrf() {
  const res = await fetch("/api/vdm/auth/csrf");
  const data = await res.json() as { token: string };
  csrfToken = data.token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== "GET" && !csrfToken) await fetchCsrf();

  const headers: Record<string, string> = {};
  if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 403) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (data.error?.includes("CSRF")) {
      csrfToken = null;
      return request(method, path, body);
    }
    const message = data.error ?? "Forbidden";
    reportMutationError(method, message);
    throw new Error(message);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: unknown };
    const raw = err.error;
    const message = typeof raw === "string" && raw
      ? raw
      : Array.isArray(raw)
        ? raw.map((i) => (i && typeof i === "object" && "message" in i
          ? `${Array.isArray((i as { path?: unknown[] }).path) ? (i as { path: unknown[] }).path.join(".") + ": " : ""}${(i as { message?: unknown }).message ?? JSON.stringify(i)}`
          : typeof i === "string" ? i : JSON.stringify(i))).join("; ") || `HTTP ${res.status}`
        : raw ? JSON.stringify(raw) : `HTTP ${res.status}`;
    reportMutationError(method, message);
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
  /** Multipart upload (FormData). Returns the parsed JSON body. */
  upload: async <T>(path: string, form: FormData): Promise<T> => {
    if (!csrfToken) await fetchCsrf();
    const headers: Record<string, string> = {};
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const res = await fetch(path, { method: "POST", headers, credentials: "include", body: form });
    if (res.status === 403) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (data.error?.includes("CSRF")) {
        csrfToken = null;
        return api.upload<T>(path, form);
      }
      const message = data.error ?? "Forbidden";
      reportMutationError("POST", message);
      throw new Error(message);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: unknown };
      const message = typeof err.error === "string" && err.error ? err.error : `HTTP ${res.status}`;
      reportMutationError("POST", message);
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  },
};
