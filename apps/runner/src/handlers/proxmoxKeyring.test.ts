import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { PROXMOX_KEYRING_BASE64, PROXMOX_KEYRING_SHA256 } from "./proxmoxKeyring";

describe("embedded Proxmox keyring", () => {
  it("matches the pinned sha256", () => {
    const digest = createHash("sha256").update(Buffer.from(PROXMOX_KEYRING_BASE64, "base64")).digest("hex");
    expect(digest).toBe(PROXMOX_KEYRING_SHA256);
  });
});
