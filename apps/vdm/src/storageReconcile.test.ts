import { describe, expect, it, vi } from "vitest";
import { reconcileStorageMounts } from "./storageReconcile";

describe("reconcileStorageMounts", () => {
  it("reconciles every enabled storage on every non-offline node", async () => {
    const mount = vi.fn(async () => undefined);
    const nodes = [
      { name: "node1", status: "online" },
      { name: "node2", status: "degraded" },
      { name: "node3", status: "offline" },
    ];
    const storages = [
      { name: "shared-a", enabled: 1 },
      { name: "shared-b", enabled: 1 },
      { name: "disabled", enabled: 0 },
    ];

    const result = await reconcileStorageMounts(nodes, storages, mount);

    expect(mount.mock.calls.map(([node, storage]) => `${node.name}:${storage.name}`).sort()).toEqual([
      "node1:shared-a",
      "node1:shared-b",
      "node2:shared-a",
      "node2:shared-b",
    ]);
    expect(result.failures).toEqual([]);
  });

  it("returns individual failures without aborting the remaining mounts", async () => {
    const mount = vi.fn(async (node: { name: string }, storage: { name: string }) => {
      if (node.name === "node1" && storage.name === "bad") throw new Error("mount failed");
    });

    const result = await reconcileStorageMounts(
      [{ name: "node1", status: "online" }],
      [{ name: "bad", enabled: 1 }, { name: "good", enabled: 1 }],
      mount,
    );

    expect(mount).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([{ node: "node1", storage: "bad", error: "mount failed" }]);
  });
});
