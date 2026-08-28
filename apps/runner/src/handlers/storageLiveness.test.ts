import { describe, expect, it } from "vitest";
import { probePoolAlive } from "./storageLiveness";

describe("probePoolAlive", () => {
  it("returns false quickly when a mounted FUSE path stops responding", async () => {
    const never = new Promise<void>(() => {});
    const started = Date.now();

    const result = await probePoolAlive("/mnt/vdm-s3", {
      isMountpoint: async () => true,
      readDirectory: async () => never,
      accessTimeoutMs: 25,
    });

    expect(result).toEqual({ alive: false, reason: "access-timeout" });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("requires both a real mountpoint and readable content", async () => {
    await expect(probePoolAlive("/mnt/plain-dir", {
      isMountpoint: async () => false,
      readDirectory: async () => undefined,
      accessTimeoutMs: 25,
    })).resolves.toEqual({ alive: false, reason: "not-mounted" });

    await expect(probePoolAlive("/mnt/live", {
      isMountpoint: async () => true,
      readDirectory: async () => undefined,
      accessTimeoutMs: 25,
    })).resolves.toEqual({ alive: true });
  });
});
