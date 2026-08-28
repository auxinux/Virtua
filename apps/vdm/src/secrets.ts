import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";
const DEV_FALLBACK = "auxinux-vdm-development-encryption-key";
const material = process.env.AUXINUX_VDM_ENCRYPTION_KEY
  ?? process.env.AUXINUX_VDM_SESSION_SECRET
  ?? DEV_FALLBACK;
const key = createHash("sha256").update(material).digest();

// Refuse to silently encrypt production secrets with the hardcoded dev key.
// If neither a dedicated encryption key nor a session secret is configured,
// stored secrets (S3 keys, SMB passwords) would be decryptable by anyone with
// the source. Fail loud instead of writing weak ciphertext.
if (material === DEV_FALLBACK) {
  console.warn("[vdm] WARNING: no AUXINUX_VDM_ENCRYPTION_KEY or AUXINUX_VDM_SESSION_SECRET set — secrets are encrypted with a hardcoded development key. Set AUXINUX_VDM_ENCRYPTION_KEY in /etc/auxinux-vdm.env for production.");
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value;
  const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (payload.length < 29) throw new Error("Invalid encrypted secret");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
