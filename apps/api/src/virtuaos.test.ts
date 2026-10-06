import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerVirtuaOsApi } from "./virtuaos.js";

const STATUS = {
  isVirtuaOS: true,
  version: "1.0.3-BETA",
  virtuaosChannel: "PROD",
  kernelChannel: "PROD",
  runningKernel: "7.2.4-auxinux-virtua-amd64",
  runningKernelChannel: "PROD",
  installedKernelMetas: ["kernel-virtua"],
  devKernelPackages: [],
  mismatch: false,
};

function build(opts: { isVirtuaOS: boolean; admin?: boolean }) {
  const app = Fastify();
  const runnerCalls: string[] = [];
  const audits: Array<{ action: string; result: string; details: string }> = [];
  registerVirtuaOsApi({
    app,
    callRunner: async <T,>(action: string, params?: unknown) => {
      runnerCalls.push(action);
      if (action === "virtuaos_status") return { ...STATUS, isVirtuaOS: opts.isVirtuaOS } as T;
      if (action === "virtuaos_set_channel") return { ok: true, previous: "PROD", current: (params as { channel: string }).channel } as T;
      if (action === "virtuaos_set_kernel_channel") {
        return { ok: true, previous: "PROD", current: (params as { channel: string }).channel, rebootRequired: true, log: "" } as T;
      }
      throw new Error(`unexpected ${action}`);
    },
    requireAdmin: () => {
      if (opts.admin === false) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    },
    audit: (_req, entry) => audits.push(entry),
    fetchText: async (url) => (url.endsWith("/VIRTUAOS/DEV/release.md") ? "latest: 1.1.0-BETA\n" : "latest: 1.0.4\n"),
  });
  return { app, runnerCalls, audits };
}

describe("VirtuaOS API", () => {
  it("answers 409 and never changes anything on a non-VirtuaOS host", async () => {
    const { app, runnerCalls } = build({ isVirtuaOS: false });
    expect((await app.inject({ method: "GET", url: "/api/system/virtuaos" })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/system/virtuaos/channel", payload: { channel: "DEV" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/system/virtuaos/kernel-channel", payload: { channel: "DEV" } })).statusCode).toBe(409);
    expect(runnerCalls.every((action) => action === "virtuaos_status")).toBe(true);
  });

  it("returns the status with the latest version of the selected channel", async () => {
    const { app } = build({ isVirtuaOS: true });
    const res = await app.inject({ method: "GET", url: "/api/system/virtuaos" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isVirtuaOS: true, version: "1.0.3-BETA", latestVirtuaOS: "1.0.4" });
  });

  it("is admin only", async () => {
    const { app } = build({ isVirtuaOS: true, admin: false });
    expect((await app.inject({ method: "GET", url: "/api/system/virtuaos" })).statusCode).toBe(403);
  });

  it("only accepts PROD|DEV, never a URL", async () => {
    const { app, runnerCalls } = build({ isVirtuaOS: true });
    const res = await app.inject({ method: "PUT", url: "/api/system/virtuaos/kernel-channel", payload: { channel: "https://dep.auxinux.ca/VIRTUA/KERNEL-DEV/" } });
    expect(res.statusCode).toBe(400);
    expect(runnerCalls).not.toContain("virtuaos_set_kernel_channel");
  });

  it("audits a kernel channel change with old → new", async () => {
    const { app, audits } = build({ isVirtuaOS: true });
    const res = await app.inject({ method: "PUT", url: "/api/system/virtuaos/kernel-channel", payload: { channel: "dev" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, previous: "PROD", current: "DEV", rebootRequired: true });
    expect(audits).toEqual([{ action: "system.virtuaos.kernelChannel", result: "success", details: "KERNEL_CHANNEL PROD → DEV (reboot required)" }]);
  });
});
