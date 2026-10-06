import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  VIRTUAOS_REPOS,
  parseChannelInput,
  parseLatestFromReleaseMd,
  type VirtuaOsChannel,
  type VirtuaOsKernelChannelResult,
  type VirtuaOsStatus,
} from "@auxinux/shared";

type RunnerStatus = Omit<VirtuaOsStatus, "latestVirtuaOS">;

export interface VirtuaOsDeps {
  app: FastifyInstance;
  callRunner: <T>(action: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => void;
  audit: (req: FastifyRequest, entry: { action: string; result: "success" | "error"; details: string }) => void;
  fetchText?: (url: string) => Promise<string>;
}

const LATEST_TTL_MS = 5 * 60_000;
// apt-get update + install + purge + update-grub can be slow on a busy mirror.
const KERNEL_SWITCH_TIMEOUT_MS = 45 * 60_000;

const defaultFetchText = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export function registerVirtuaOsApi(deps: VirtuaOsDeps) {
  const { app, callRunner, requireAdmin, audit } = deps;
  const fetchText = deps.fetchText ?? defaultFetchText;

  // Detected once at startup, then cached: the answer only changes with a
  // reinstall, and the settings page polls the status.
  let detection: Promise<boolean> | null = null;
  const isVirtuaOs = () => {
    detection ??= callRunner<RunnerStatus>("virtuaos_status")
      .then((status) => status.isVirtuaOS)
      .catch(() => { detection = null; return false; });
    return detection;
  };
  void isVirtuaOs();

  const latestCache = new Map<VirtuaOsChannel, { at: number; value: string | null }>();
  async function latestFor(channel: VirtuaOsChannel): Promise<string | null> {
    const cached = latestCache.get(channel);
    if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
    let value: string | null = null;
    try {
      value = parseLatestFromReleaseMd(await fetchText(`${VIRTUAOS_REPOS.releases[channel]}release.md`));
    } catch { /* depot unreachable: show "unknown", retry after the TTL */ }
    latestCache.set(channel, { at: Date.now(), value });
    return value;
  }

  async function status(): Promise<VirtuaOsStatus> {
    const current = await callRunner<RunnerStatus>("virtuaos_status");
    return { ...current, latestVirtuaOS: await latestFor(current.virtuaosChannel) };
  }

  const notVirtuaOs = (reply: FastifyReply) => reply.status(409).send({ error: "This host is not VirtuaOS" });

  app.get("/api/system/virtuaos", async (req, reply) => {
    requireAdmin(req, reply);
    if (!(await isVirtuaOs())) return notVirtuaOs(reply);
    return status();
  });

  app.put("/api/system/virtuaos/channel", async (req, reply) => {
    requireAdmin(req, reply);
    if (!(await isVirtuaOs())) return notVirtuaOs(reply);
    const channel = parseChannelInput((req.body as { channel?: unknown } | undefined)?.channel);
    if (!channel) return reply.status(400).send({ error: "channel must be PROD or DEV" });
    try {
      const result = await callRunner<{ previous: VirtuaOsChannel; current: VirtuaOsChannel }>("virtuaos_set_channel", { channel });
      audit(req, { action: "system.virtuaos.channel", result: "success", details: `VIRTUAOS_CHANNEL ${result.previous} → ${result.current}` });
      return { ok: true, ...result, status: await status() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(req, { action: "system.virtuaos.channel", result: "error", details: `VIRTUAOS_CHANNEL → ${channel}: ${message}` });
      return reply.status(500).send({ error: message });
    }
  });

  app.put("/api/system/virtuaos/kernel-channel", async (req, reply) => {
    requireAdmin(req, reply);
    if (!(await isVirtuaOs())) return notVirtuaOs(reply);
    const channel = parseChannelInput((req.body as { channel?: unknown } | undefined)?.channel);
    if (!channel) return reply.status(400).send({ error: "channel must be PROD or DEV" });
    const before = await callRunner<RunnerStatus>("virtuaos_status").catch(() => null);
    try {
      const result = await callRunner<VirtuaOsKernelChannelResult>("virtuaos_set_kernel_channel", { channel }, KERNEL_SWITCH_TIMEOUT_MS);
      audit(req, { action: "system.virtuaos.kernelChannel", result: "success", details: `KERNEL_CHANNEL ${result.previous} → ${result.current} (reboot required)` });
      return { ...result, status: await status() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(req, {
        action: "system.virtuaos.kernelChannel",
        result: "error",
        details: `KERNEL_CHANNEL ${before?.kernelChannel ?? "?"} → ${channel}: ${message.split("\n")[0]}`,
      });
      const busy = /already running|locked/i.test(message);
      return reply.status(busy ? 409 : 500).send({ error: message });
    }
  });
}
