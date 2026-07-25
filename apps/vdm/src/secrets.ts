import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";
const material = process.env.AUXINUX_VDM_ENCRYPTION_KEY
  ?? process.env.AUXINUX_VDM_SESSION_SECRET
  ?? "auxinux-vdm-development-encryption-key";
const key = createHash("sha256").update(material).digest();

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
