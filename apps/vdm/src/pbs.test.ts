import { describe, expect, it } from "vitest";
import { isPbsJobDue } from "@auxinux/shared";
import {
  extractTaskNotes,
  parseGuestRef,
  parsePbsJobBody,
  parsePbsJobTargets,
  pbsConnectionFromBody,
  readPbsKeep,
  resolvePbsJobGuests,
  scaleProgress,
  summarizePbsJobRun,
  type StoredPbsRemote,
} from "./pbs.js";

describe("parseGuestRef", () => {
  it("parses node:kind:name", () => {
    expect(parseGuestRef("node-a:vm:web-1")).toEqual({ node: "node-a", kind: "vm", name: "web-1" });
    expect(parseGuestRef("n1:lxc:ct.db")).toEqual({ node: "n1", kind: "lxc", name: "ct.db" });
  });

  it("rejects other kinds, extra parts and unsafe names", () => {
    for (const bad of ["n1:docker:x", "n1:vm", "n1:vm:a:b", "n1:vm:../x", ":vm:x", "n 1:vm:x"]) {
      expect(parseGuestRef(bad), bad).toBeNull();
    }
  });
});

describe("parsePbsJobTargets", () => {
  it("keeps known kinds and dedupes guests", () => {
    expect(parsePbsJobTargets({ all: ["lxc", "vm", "vm", "docker"], guests: ["n1:vm:a", "n1:vm:a"] }))
      .toEqual({ all: ["lxc", "vm"], guests: ["n1:vm:a"] });
  });

  it("requires at least one target and valid references", () => {
    expect(() => parsePbsJobTargets({ all: [], guests: [] })).toThrow(/at least one/);
    expect(() => parsePbsJobTargets({ guests: ["oops"] })).toThrow(/Invalid guest reference/);
  });
});

describe("resolvePbsJobGuests", () => {
  const inventory = [
    { node: "n1", kind: "vm" as const, name: "a" },
    { node: "n1", kind: "lxc" as const, name: "c" },
    { node: "n2", kind: "vm" as const, name: "b" },
  ];

  it("expands 'all' per kind across nodes and adds selected guests once", () => {
    const out = resolvePbsJobGuests({ all: ["vm"], guests: ["n1:vm:a", "n1:lxc:c", "n3:lxc:z"] }, inventory);
    expect(out.map((g) => `${g.node}:${g.kind}:${g.name}`)).toEqual(["n1:vm:a", "n2:vm:b", "n1:lxc:c", "n3:lxc:z"]);
  });

  it("uses only the selection when no kind is 'all'", () => {
    expect(resolvePbsJobGuests({ all: [], guests: ["n2:vm:b"] }, inventory)).toEqual([{ node: "n2", kind: "vm", name: "b" }]);
  });
});

describe("readPbsKeep", () => {
  it("drops blanks and rejects out-of-range counts", () => {
    expect(readPbsKeep({ keepLast: "", keepDaily: "7", keepWeekly: 4 })).toEqual({ keepDaily: 7, keepWeekly: 4 });
    expect(() => readPbsKeep({ keepLast: 0 })).toThrow();
    expect(() => readPbsKeep({ keepMonthly: 1.5 })).toThrow();
  });
});

describe("pbsConnectionFromBody", () => {
  const body = { server: "pbs.lan", datastore: "store1", authId: "root@pam!virtua", secret: "tok" };
  const stored: StoredPbsRemote = { server: "pbs.lan", port: 8007, datastore: "store1", namespace: null, auth_id: "root@pam!virtua", secret: "old-secret", fingerprint: null };

  it("normalises a new connection", () => {
    expect(pbsConnectionFromBody({ ...body, port: "", namespace: " " })).toMatchObject({ server: "pbs.lan", port: 8007, namespace: undefined, secret: "tok" });
  });

  it("keeps the stored secret and fields when the edit omits them", () => {
    const conn = pbsConnectionFromBody({ datastore: "store2", secret: "" }, stored);
    expect(conn.secret).toBe("old-secret");
    expect(conn.datastore).toBe("store2");
    expect(conn.authId).toBe("root@pam!virtua");
  });

  it("rejects bad syntax without echoing the secret", () => {
    expect(() => pbsConnectionFromBody({ ...body, authId: "root" })).toThrow(/user@realm/);
    expect(() => pbsConnectionFromBody({ ...body, secret: "" })).toThrow(/secret is required/);
    try {
      pbsConnectionFromBody({ ...body, server: "bad host", secret: "super-secret-value" });
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-value");
    }
  });
});

describe("parsePbsJobBody", () => {
  const valid = { name: "Nightly", remoteId: 1, days: "51231", time: "02:30", targets: { all: ["vm"] }, keepDaily: 7 };

  it("normalises days and defaults enabled", () => {
    expect(parsePbsJobBody(valid)).toMatchObject({ days: "1235", time: "02:30", enabled: true, keep: { keepDaily: 7 } });
    expect(parsePbsJobBody({ ...valid, enabled: false }).enabled).toBe(false);
  });

  it("validates name, remote, days and time", () => {
    expect(() => parsePbsJobBody({ ...valid, name: "" })).toThrow(/name/);
    expect(() => parsePbsJobBody({ ...valid, remoteId: "x" })).toThrow(/remote/);
    expect(() => parsePbsJobBody({ ...valid, days: "79" })).toThrow(/day/);
    expect(() => parsePbsJobBody({ ...valid, time: "24:00" })).toThrow(/HH:MM/);
  });
});

describe("summarizePbsJobRun", () => {
  it("reports ok, partial and failed runs", () => {
    expect(summarizePbsJobRun(2, [], [])).toEqual({ status: "ok", message: "2 guest(s) backed up" });
    expect(summarizePbsJobRun(2, ["n1/a: boom"], []).status).toBe("partial");
    expect(summarizePbsJobRun(2, [], ["n3"])).toEqual({ status: "partial", message: "2 guest(s) backed up — skipped offline node(s): n3" });
    expect(summarizePbsJobRun(1, ["n1/a: boom"], []).status).toBe("failed");
    expect(summarizePbsJobRun(0, [], []).status).toBe("failed");
  });
});

describe("node task helpers", () => {
  it("extracts restore/backup notes from a node activity log", () => {
    expect(extractTaskNotes(["10:00:00 · Restoring", "10:01:00 · Note: TPM state not restored", "10:02:00 · Note: TPM state not restored", 3]))
      .toEqual(["TPM state not restored"]);
    expect(extractTaskNotes(undefined)).toEqual([]);
  });

  it("maps node progress into a slice of the VDM task", () => {
    expect(scaleProgress(0, 5, 95)).toBe(5);
    expect(scaleProgress(50, 5, 95)).toBe(50);
    expect(scaleProgress(150, 5, 95)).toBe(95);
    expect(scaleProgress(undefined, 5, 95)).toBe(5);
  });
});

describe("schedule (shared with the node)", () => {
  it("fires once per slot in VDM-local time", () => {
    const job = { enabled: 1, days: "5", time: "02:00", last_run_at: null as string | null };
    const friday = (h: number) => new Date(2026, 9, 30, h, 0);
    expect(isPbsJobDue(job, friday(1))).toBe(false);
    expect(isPbsJobDue(job, friday(9))).toBe(true);
    expect(isPbsJobDue({ ...job, last_run_at: friday(2).toISOString() }, friday(9))).toBe(false);
  });
});
