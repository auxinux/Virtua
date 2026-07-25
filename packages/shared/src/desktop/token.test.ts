import { describe, it, expect } from "vitest";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generatePairingCode,
  evaluateResourceAccess,
  type DesktopAccessPayload,
} from "./token";

const SECRET = "test-secret-please-change-0123456789abcdef";

function makePayload(over: Partial<DesktopAccessPayload> = {}): DesktopAccessPayload {
  const now = Math.floor(Date.now() / 1000);
  return { v: 1, did: "11111111-1111-1111-1111-111111111111", uid: 7, role: "USER", iat: now, exp: now + 900, ...over };
}

describe("desktop access token", () => {
  it("round-trips a valid token", () => {
    const p = makePayload();
    const token = signAccessToken(p, SECRET);
    const verified = verifyAccessToken(token, SECRET);
    expect(verified).not.toBeNull();
    expect(verified?.uid).toBe(7);
    expect(verified?.did).toBe(p.did);
    expect(verified?.role).toBe("USER");
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken(makePayload(), SECRET);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify(makePayload({ role: "ADMIN" })), "utf8")
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(verifyAccessToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", () => {
    const token = signAccessToken(makePayload(), SECRET);
    expect(verifyAccessToken(token, "another-secret")).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signAccessToken(makePayload({ iat: now - 2000, exp: now - 1000 }), SECRET);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyAccessToken("garbage", SECRET)).toBeNull();
    expect(verifyAccessToken("a.b.c", SECRET)).toBeNull();
    expect(verifyAccessToken("", SECRET)).toBeNull();
  });
});

describe("refresh tokens & pairing codes", () => {
  it("generates distinct refresh tokens and stable hashes", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
    // never stores the raw token
    expect(hashRefreshToken(a)).not.toContain(a);
  });

  it("generates readable pairing codes without ambiguous chars", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[IO01]/);
  });
});

describe("permission model (RBAC)", () => {
  const fullAcl = { canView: true, canConsole: true, canPower: true, canSnapshot: true };
  const viewOnly = { canView: true, canConsole: false, canPower: false, canSnapshot: false };

  it("ADMIN can do everything regardless of ACL/ownership", () => {
    for (const required of ["view", "console", "power", "snapshot"] as const) {
      expect(evaluateResourceAccess({ role: "ADMIN", isOwner: false, acl: null, required })).toBe(true);
    }
  });

  it("owner gets full access to their resource", () => {
    for (const required of ["view", "console", "power", "snapshot"] as const) {
      expect(evaluateResourceAccess({ role: "USER", isOwner: true, acl: null, required })).toBe(true);
    }
  });

  it("USER with no ACL and not owner is denied", () => {
    for (const required of ["view", "console", "power", "snapshot"] as const) {
      expect(evaluateResourceAccess({ role: "USER", isOwner: false, acl: null, required })).toBe(false);
    }
  });

  it("USER is limited to the exact ACL flags", () => {
    expect(evaluateResourceAccess({ role: "USER", isOwner: false, acl: viewOnly, required: "view" })).toBe(true);
    expect(evaluateResourceAccess({ role: "USER", isOwner: false, acl: viewOnly, required: "console" })).toBe(false);
    expect(evaluateResourceAccess({ role: "USER", isOwner: false, acl: viewOnly, required: "power" })).toBe(false);
    expect(evaluateResourceAccess({ role: "USER", isOwner: false, acl: fullAcl, required: "snapshot" })).toBe(true);
  });
});
