let csrfToken: string | null = null;

async function fetchCsrf() {
  const res = await fetch("/api/auth/csrf");
  const data = await res.json() as { token: string };
  csrfToken = data.token;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  if (!csrfToken) await fetchCsrf();
  const headers: Record<string, string> = { "X-CSRF-Token": csrfToken! };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method: "POST",
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403 && (await res.clone().json().catch(() => ({}))).error?.includes("CSRF")) {
    csrfToken = null;
    return apiPost(path, body);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  if (!csrfToken) await fetchCsrf();
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken! },
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  if (!csrfToken) await fetchCsrf();
  const res = await fetch(path, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken! },
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiUpload<T>(
  path: string,
  formData: FormData,
  onProgress?: (progress: { percent: number; loadedBytes: number; totalBytes: number }) => void
): Promise<T> {
  if (!csrfToken) await fetchCsrf();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fileEntry = formData.get("file");
    const fallbackTotal = fileEntry instanceof File ? fileEntry.size : 0;
    xhr.open("POST", path);
    xhr.setRequestHeader("X-CSRF-Token", csrfToken!);
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onloadstart = () => {
        onProgress({
          percent: fallbackTotal > 0 ? 1 : 0,
          loadedBytes: 0,
          totalBytes: fallbackTotal,
        });
      };
      xhr.upload.onprogress = (e) => {
        const totalBytes = e.lengthComputable && e.total > 0 ? e.total : fallbackTotal;
        const loadedBytes = e.loaded ?? 0;
        onProgress({
          percent: totalBytes > 0 ? Math.max(1, Math.min(99, Math.round((loadedBytes / totalBytes) * 100))) : 1,
          loadedBytes,
          totalBytes,
        });
      };
    }
    xhr.onload = () => {
      if (onProgress) {
        onProgress({
          percent: 100,
          loadedBytes: fallbackTotal,
          totalBytes: fallbackTotal,
        });
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as T);
      } else {
        const err = JSON.parse(xhr.responseText || "{}") as { error?: string };
        reject(new Error(err.error ?? `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData);
  });
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
