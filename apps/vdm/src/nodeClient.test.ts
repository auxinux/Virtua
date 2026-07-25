import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNode, NodeRequestError, type VdmNodeRow } from "./nodeClient.js";

const node: VdmNodeRow = {
  id: 1,
  name: "node-a",
  display_name: "Node A",
  api_url: "http://10.0.0.10:8441",
  auth_token: "secret-token",
  enabled: 1,
  status: "online",
  last_seen_at: null,
  notes: null,
  created_at: "",
  updated_at: "",
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchNode", () => {
  it("adds the node token and decodes JSON", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-auxinux-node-token")).toBe("secret-token");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNode(node, "/api/internal/node/summary", { retries: 0 })).resolves.toEqual({ ok: true });
  });

  it("retries a GET after a server error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNode(node, "/api/internal/node/summary", { retries: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "failed" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNode(node, "/api/internal/vms", { method: "POST", body: "{}", retries: 3 })).rejects.toBeInstanceOf(NodeRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts requests that exceed their timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })));
    await expect(fetchNode(node, "/slow", { timeoutMs: 10, retries: 0 })).rejects.toMatchObject({ failure: "timeout" });
  });
});
