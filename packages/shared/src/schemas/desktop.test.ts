import { describe, it, expect } from "vitest";
import { DesktopCreateResourceSchema, DesktopUpdateResourceSchema } from "./desktop";

describe("DesktopCreateResourceSchema", () => {
  it("accepts gpuModel and networkModel for a VM", () => {
    const result = DesktopCreateResourceSchema.safeParse({
      type: "vm",
      name: "test-vm",
      gpuModel: "qxl",
      networkModel: "e1000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gpuModel).toBe("qxl");
      expect(result.data.networkModel).toBe("e1000");
    }
  });

  it("rejects an unknown gpuModel value", () => {
    const result = DesktopCreateResourceSchema.safeParse({
      type: "vm",
      name: "test-vm",
      gpuModel: "nvidia-passthrough",
    });
    expect(result.success).toBe(false);
  });
});

describe("DesktopUpdateResourceSchema", () => {
  it("accepts an update that only changes gpuModel (regression: used to strip to {} and fail the refine)", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ gpuModel: "qxl" });
    expect(result.success).toBe(true);
  });

  it("accepts an update that only changes networkModel", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ networkModel: "virtio" });
    expect(result.success).toBe(true);
  });

  it("still rejects a fully empty update", () => {
    const result = DesktopUpdateResourceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("still rejects an update containing only unknown fields", () => {
    const result = DesktopUpdateResourceSchema.safeParse({ somethingUnsupported: "x" });
    expect(result.success).toBe(false);
  });
});
