// =============================================================================
//  Desktop access-token signing/verification + permission decision (PURE).
//
//  ⚠ Node-only (uses node:crypto). This file is intentionally NOT exported from
//  the shared index barrel so the browser UI never imports it. The API and the
//  unit tests import it directly by path.
//
//  Access token format (compact, stateless, HMAC-signed):
//      base64url(payloadJSON) "." base64url(HMAC_SHA256(secret, payloadB64))
//  The payload carries the device id, user id, role and expiry. It is short
//  lived; long-term identity + revocation live in the refresh token / device row.
// =============================================================================
import { createHmac, timingSafeEqual, randomBytes, createHash } from "crypto";

export interface DesktopAccessPayload {
  v: 1;
  did: string;   // device id (uuid)
  uid: number;   // user id
  role: "ADMIN" | "USER";
  iat: number;   // issued-at (epoch seconds)
  exp: number;   // expiry (epoch seconds)
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signAccessToken(payload: DesktopAccessPayload, secret: string): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

/**
 * Verify the token signature and expiry. Returns the payload when valid, else
 * null. Uses a constant-time signature comparison.
 */
export function verifyAccessToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): DesktopAccessPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: DesktopAccessPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as DesktopAccessPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.exp !== "number" || typeof payload.did !== "string") return null;
  if (payload.exp <= nowSec) return null;
  return payload;
}

/** A cryptographically-random opaque refresh token (returned once to the client). */
export function generateRefreshToken(): string {
  return b64url(randomBytes(48));
}

/** Hash a refresh token for at-rest storage (never store the raw token). */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Short, human-typable pairing code (base32, unambiguous alphabet). */
export function generatePairingCode(groups = 2, groupLen = 4): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1
  const bytes = randomBytes(groups * groupLen);
  const chars: string[] = [];
  for (let i = 0; i < groups * groupLen; i += 1) chars.push(alphabet[bytes[i] % alphabet.length]);
  const out: string[] = [];
  for (let g = 0; g < groups; g += 1) out.push(chars.slice(g * groupLen, g * groupLen + groupLen).join(""));
  return out.join("-");
}

// ── Permission model (pure) ───────────────────────────────────────────────────
// Mirrors the server RBAC rule so it can be unit-tested in isolation:
//   ADMIN              → full access to everything
//   owner of resource  → full access to that resource
//   otherwise          → only what the per-resource ACL flag allows
export type DesktopPerm = "view" | "console" | "power" | "snapshot";

export interface ResourceAclFlags {
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canSnapshot: boolean;
}

export function evaluateResourceAccess(args: {
  role: "ADMIN" | "USER";
  isOwner: boolean;
  acl: ResourceAclFlags | null;
  required: DesktopPerm;
}): boolean {
  if (args.role === "ADMIN") return true;
  if (args.isOwner) return true;
  if (!args.acl) return false;
  switch (args.required) {
    case "view": return args.acl.canView;
    case "console": return args.acl.canConsole;
    case "power": return args.acl.canPower;
    case "snapshot": return args.acl.canSnapshot;
    default: return false;
  }
}
