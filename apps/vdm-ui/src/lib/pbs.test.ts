import { describe, expect, it } from "vitest";
import { defaultPbsBridgeMap, describePbsDays, describePbsTargets, latestPbsSnapshots, optionalCount } from "./pbs";
import type { VdmPbsSnapshot } from "@/types/vdm";

const snap = (type: "vm" | "ct", id: string, time: string): VdmPbsSnapshot => ({ ref: `${type}/${id}/${time}`, type, id, time, protected: false, encrypted: false, files: [] });

describe("PBS UI helpers", () => {
  it("describes days and targets", () => {
    expect(describePbsDays("0123456")).toBe("Every day");
    expect(describePbsDays("12345")).toBe("Mon–Fri");
    expect(describePbsDays("06")).toBe("Sat, Sun");
    expect(describePbsTargets({ all: ["vm"], guests: ["n1:lxc:db"] })).toBe("all VMs + n1/db");
    expect(describePbsTargets({ all: [], guests: ["a:vm:1", "a:vm:2", "a:vm:3", "a:vm:4"] })).toBe("a/1, a/2, a/3 +1");
  });

  it("keeps the newest snapshot per guest", () => {
    const list = [snap("vm", "100", "2026-10-31"), snap("vm", "100", "2026-10-30"), snap("ct", "100", "2026-10-29")];
    expect(latestPbsSnapshots(list).map((s) => s.ref)).toEqual(["vm/100/2026-10-31", "ct/100/2026-10-29"]);
  });

  it("maps bridges by name, falling back to the default", () => {
    expect(defaultPbsBridgeMap(["vmbr0", "vmbr9"], ["vmbr0", "virbr0"], "virbr0")).toEqual({ vmbr0: "vmbr0", vmbr9: "virbr0" });
  });

  it("parses optional counts", () => {
    expect(optionalCount("")).toBeUndefined();
    expect(optionalCount("0")).toBeUndefined();
    expect(optionalCount("7")).toBe(7);
  });
});
