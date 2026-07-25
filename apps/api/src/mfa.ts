// =============================================================================
//  Multi-factor authentication transport (Twilio SMS + SMTP email)
//
//  Pure transport + code helpers. Storage, hashing and verification of codes
//  live in server.ts (which owns the DB). Secrets are read from the settings
//  table by the caller and passed in here — never logged.
// =============================================================================
import { randomInt } from "crypto";
import nodemailer from "nodemailer";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;        // true = implicit TLS (465); false = STARTTLS/plain
  user?: string;
  pass?: string;
  from: string;           // From: header (e.g. "Virtua <no-reply@domain>")
}

/** Cryptographically-random numeric code, fixed length (default 6 digits). */
export function generateNumericCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

/** Best-effort masking of a phone number for display (keep last 2 digits). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return "••";
  return `${phone.startsWith("+") ? "+" : ""}${"•".repeat(Math.max(2, digits.length - 2))}${digits.slice(-2)}`;
}

/** Mask an email for display: j••@domain.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(2, local.length - 1))}@${domain}`;
}

/** E.164-ish sanity check (+ and 7–15 digits). */
export function isLikelyPhone(phone: string): boolean {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/[\s().-]/g, ""));
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s().-]/g, "");
}

export function isLikelyEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/** Send an SMS through Twilio's REST API (no SDK; uses global fetch). */
export async function sendSms(cfg: TwilioConfig, to: string, body: string): Promise<void> {
  if (!cfg.accountSid || !cfg.authToken || !cfg.fromNumber) {
    throw new Error("Twilio is not configured");
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: cfg.fromNumber, Body: body });
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { message?: string; code?: number };
      detail = json.message ? `${json.message}${json.code ? ` (code ${json.code})` : ""}` : "";
    } catch {
      detail = (await res.text().catch(() => "")).slice(0, 200);
    }
    throw new Error(`Twilio SMS failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
}

/** Send a transactional email over SMTP. */
export async function sendEmail(cfg: SmtpConfig, to: string, subject: string, text: string): Promise<void> {
  if (!cfg.host || !cfg.from) throw new Error("SMTP is not configured");
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
    // Reasonable timeouts so a misconfigured server fails fast instead of hanging.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transporter.sendMail({ from: cfg.from, to, subject, text });
}
