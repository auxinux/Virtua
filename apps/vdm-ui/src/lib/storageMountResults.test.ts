import { describe, expect, it } from "vitest";
import { mountFailureMessage } from "./storageMountResults";

describe("mountFailureMessage", () => {
  it("summarizes failed nodes and preserves their errors", () => {
    expect(mountFailureMessage([
      { node: "node1", ok: true },
      { node: "node2", ok: false, error: "S3 endpoint unreachable" },
      { node: "node3", ok: false, error: "Runner timeout" },
    ])).toBe("node2: S3 endpoint unreachable; node3: Runner timeout");
  });

  it("returns null when every mount succeeds", () => {
    expect(mountFailureMessage([{ node: "node1", ok: true }])).toBeNull();
  });
});
