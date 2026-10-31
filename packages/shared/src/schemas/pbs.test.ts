import { describe, expect, it } from "vitest";
import {
  InternalPbsBackupRequestSchema,
  InternalPbsRestoreRequestSchema,
  PbsConnectionSchema,
} from "./pbs";

const connection = { server: "pbs.lan", datastore: "store1", authId: "root@pam!virtua", secret: "s3cret" };

describe("PbsConnectionSchema", () => {
  it("accepts a minimal connection and blanks optional fields", () => {
    const parsed = PbsConnectionSchema.parse({ ...connection, namespace: "  ", fingerprint: "" });
    expect(parsed.namespace).toBeUndefined();
    expect(parsed.fingerprint).toBeUndefined();
    expect(parsed.port).toBeUndefined();
  });

  it("coerces the port and rejects out-of-range values", () => {
    expect(PbsConnectionSchema.parse({ ...connection, port: "8007" }).port).toBe(8007);
    expect(PbsConnectionSchema.safeParse({ ...connection, port: 70000 }).success).toBe(false);
  });

  it("applies the runner's syntax rules", () => {
    expect(PbsConnectionSchema.safeParse({ ...connection, authId: "root" }).success).toBe(false);
    expect(PbsConnectionSchema.safeParse({ ...connection, server: "pbs.lan;rm -rf" }).success).toBe(false);
    expect(PbsConnectionSchema.safeParse({ ...connection, namespace: "a/../b" }).success).toBe(false);
    expect(PbsConnectionSchema.safeParse({ ...connection, fingerprint: "aa:bb" }).success).toBe(false);
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    expect(PbsConnectionSchema.parse({ ...connection, fingerprint: fp }).fingerprint).toBe(fp.toLowerCase());
  });

  it("requires a secret, server, datastore and auth id", () => {
    for (const key of ["secret", "server", "datastore", "authId"] as const) {
      expect(PbsConnectionSchema.safeParse({ ...connection, [key]: "" }).success, key).toBe(false);
    }
  });
});

describe("InternalPbsBackupRequestSchema", () => {
  it("defaults keep and validates the guest", () => {
    const parsed = InternalPbsBackupRequestSchema.parse({ connection, resourceType: "vm", name: "web-1" });
    expect(parsed.keep).toEqual({});
    expect(InternalPbsBackupRequestSchema.safeParse({ connection, resourceType: "docker", name: "web" }).success).toBe(false);
    expect(InternalPbsBackupRequestSchema.safeParse({ connection, resourceType: "vm", name: "../etc" }).success).toBe(false);
  });

  it("bounds the retention counts", () => {
    expect(InternalPbsBackupRequestSchema.safeParse({ connection, resourceType: "lxc", name: "ct", keep: { keepLast: 0 } }).success).toBe(false);
    expect(InternalPbsBackupRequestSchema.parse({ connection, resourceType: "lxc", name: "ct", keep: { keepDaily: 7 } }).keep.keepDaily).toBe(7);
  });
});

describe("InternalPbsRestoreRequestSchema", () => {
  it("accepts a restore with a bridge map", () => {
    const parsed = InternalPbsRestoreRequestSchema.parse({
      connection, snapshot: "vm/100/2026-10-30T02:00:00Z", name: "restored", storagePool: "default", bridgeMap: { vmbr0: "virbr0" },
    });
    expect(parsed.bridgeMap).toEqual({ vmbr0: "virbr0" });
  });

  it("rejects a missing name or a wrongly typed field", () => {
    expect(InternalPbsRestoreRequestSchema.safeParse({ connection, snapshot: "vm/1/x", name: "" }).success).toBe(false);
    expect(InternalPbsRestoreRequestSchema.safeParse({ connection, snapshot: "vm/1/x", name: "a", autostart: "yes" }).success).toBe(false);
  });
});
