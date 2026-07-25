/**
 * SSL / Let's Encrypt Certificate Manager
 * Supports HTTP-01 and DNS-01 ACME challenges via acme-client
 */

import * as acme from "acme-client";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.AUXINUX_DATA_DIR ?? "/var/lib/auxinux";
export const SSL_DIR = path.join(DATA_DIR, "ssl");
export const CERT_PATH = path.join(SSL_DIR, "cert.pem");
export const KEY_PATH = path.join(SSL_DIR, "key.pem");
const ACME_ACCOUNT_KEY_PATH = path.join(SSL_DIR, "account.key.pem");
const CERT_META_PATH = path.join(SSL_DIR, "meta.json");

// ── In-memory token store for HTTP-01 challenges ──────────────────────────
export const challengeTokens = new Map<string, string>();

// ── Types ──────────────────────────────────────────────────────────────────
export interface SslMeta {
  domain: string;
  email: string;
  challenge: "http-01" | "dns-01";
  issuedAt: string;
  expiresAt: string;
  autoRenew: boolean;
  staging?: boolean;
}

export interface SslStatus {
  enabled: boolean;
  certExists: boolean;
  domain?: string;
  email?: string;
  challenge?: "http-01" | "dns-01";
  issuedAt?: string;
  expiresAt?: string;
  daysUntilExpiry?: number;
  autoRenew?: boolean;
  isExpired?: boolean;
  staging?: boolean;
}

export interface DnsChallengePending {
  type: "dns-01";
  domain: string;
  txtName: string;
  txtValue: string;
}

export interface ProvisionOptions {
  domain: string;
  email: string;
  challenge: "http-01" | "dns-01";
  staging?: boolean;
  apiPort?: number;
  progressCallback?: (step: string, data?: Record<string, unknown>) => void;
}

// ── Certificate helpers ────────────────────────────────────────────────────

function getCertExpiry(pem: string): Date | null {
  try {
    const x509 = new crypto.X509Certificate(pem);
    return new Date(x509.validTo);
  } catch {
    return null;
  }
}

async function readCertMeta(): Promise<SslMeta | null> {
  try {
    const raw = await fsp.readFile(CERT_META_PATH, "utf8");
    return JSON.parse(raw) as SslMeta;
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns current SSL certificate status.
 */
export async function getSslStatus(): Promise<SslStatus> {
  const certExists = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
  if (!certExists) {
    return { enabled: false, certExists: false };
  }

  const meta = await readCertMeta();
  let expiresAt: string | undefined;
  let isExpired = false;

  try {
    const certPem = await fsp.readFile(CERT_PATH, "utf8");
    const expiry = getCertExpiry(certPem);
    if (expiry) {
      expiresAt = expiry.toISOString();
      isExpired = expiry < new Date();
    }
  } catch {
    expiresAt = meta?.expiresAt;
  }

  const daysUntilExpiry = expiresAt
    ? Math.floor((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : undefined;

  return {
    enabled: !isExpired,
    certExists: true,
    domain: meta?.domain,
    email: meta?.email,
    challenge: meta?.challenge,
    issuedAt: meta?.issuedAt,
    expiresAt,
    daysUntilExpiry,
    autoRenew: meta?.autoRenew ?? true,
    isExpired,
    staging: meta?.staging,
  };
}

/**
 * Load TLS options from stored cert/key files for Fastify HTTPS.
 * Returns null if no valid cert exists.
 */
export async function loadTlsOptions(): Promise<{ key: Buffer; cert: Buffer } | null> {
  try {
    if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) return null;
    const [certBuf, keyBuf] = await Promise.all([
      fsp.readFile(CERT_PATH),
      fsp.readFile(KEY_PATH),
    ]);
    // Validate cert is not expired
    const expiry = getCertExpiry(certBuf.toString("utf8"));
    if (expiry && expiry < new Date()) {
      console.warn("[ssl] Certificate is expired, skipping HTTPS startup");
      return null;
    }
    return { key: keyBuf, cert: certBuf };
  } catch (err) {
    console.warn("[ssl] Failed to load TLS options:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Remove SSL certificate files.
 */
export async function removeCertificate(): Promise<void> {
  await Promise.all([
    fsp.unlink(CERT_PATH).catch(() => {}),
    fsp.unlink(KEY_PATH).catch(() => {}),
    fsp.unlink(CERT_META_PATH).catch(() => {}),
  ]);
}

/**
 * Provision a new Let's Encrypt certificate.
 * For HTTP-01: temporarily starts a server on port 80 to serve the challenge.
 * For DNS-01: requires manual DNS TXT record setup; blocks until DNS propagates (max 60 min).
 */
export async function provisionCertificate(options: ProvisionOptions): Promise<void> {
  const { domain, email, challenge, staging = false } = options;
  const report = (msg: string, data?: Record<string, unknown>) => {
    console.log(`[ssl] ${msg}`, data ?? "");
    options.progressCallback?.(msg, data);
  };

  await fsp.mkdir(SSL_DIR, { recursive: true });

  // ── ACME account key ──────────────────────────────────────────────────
  let accountKeyPem: string;
  try {
    accountKeyPem = await fsp.readFile(ACME_ACCOUNT_KEY_PATH, "utf8");
    report("Loaded existing ACME account key");
  } catch {
    report("Generating ACME account key...");
    const accountKey = await acme.crypto.createPrivateKey();
    accountKeyPem = accountKey.toString();
    await fsp.writeFile(ACME_ACCOUNT_KEY_PATH, accountKeyPem, { mode: 0o600 });
    report("ACME account key generated");
  }

  const directoryUrl = staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  report(`Connecting to ACME directory: ${staging ? "staging" : "production"}`);

  const client = new acme.Client({ directoryUrl, accountKey: accountKeyPem });

  await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${email}`] });
  report("ACME account registered/recovered");

  // ── Generate cert key pair + CSR ──────────────────────────────────────
  report("Generating certificate key pair and CSR...");
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] });
  report("CSR generated");

  let challengeHttpServer: http.Server | null = null;

  try {
    const certPem = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: challenge === "http-01" ? ["http-01"] : ["dns-01"],

      challengeCreateFn: async (authz, chall, keyAuthorization) => {
        if (chall.type === "http-01") {
          challengeTokens.set(chall.token, keyAuthorization);
          report("HTTP-01: challenge token ready", { token: chall.token });

          // Start HTTP server on port 80 if not already bound there
          if (!options.apiPort || options.apiPort !== 80) {
            const port80Free = await isPortFree(80);
            if (port80Free) {
              challengeHttpServer = createChallengeServer();
              await new Promise<void>((resolve, reject) => {
                challengeHttpServer!.once("listening", resolve);
                challengeHttpServer!.once("error", reject);
                challengeHttpServer!.listen(80, "0.0.0.0");
              });
              report("HTTP-01: challenge server started on port 80");
            } else {
              report("HTTP-01: port 80 already in use; challenge will be served by existing server");
            }
          }
        } else if (chall.type === "dns-01") {
          const txtName = `_acme-challenge.${authz.identifier.value}`;
          report("DNS-01: add the following DNS TXT record, then wait for propagation", {
            name: txtName,
            value: keyAuthorization,
            type: "TXT",
            ttl: 60,
          });

          // Wait for DNS propagation (poll every 15 seconds, max 60 minutes)
          await waitForDnsTxtRecord(txtName, keyAuthorization, 60 * 60 * 1000, (attempt) => {
            report(`DNS-01: polling DNS propagation (attempt ${attempt})...`, { txtName });
          });
          report("DNS-01: TXT record verified via DNS lookup");
        }
      },

      challengeRemoveFn: async (_authz, chall, _keyAuthorization) => {
        if (chall.type === "http-01") {
          challengeTokens.delete(chall.token);
        }
      },
    });

    // ── Save certificate + key ──────────────────────────────────────────
    report("Certificate issued! Saving to disk...");
    const keyPem = certKey.toString();
    await fsp.writeFile(KEY_PATH, keyPem, { mode: 0o600 });
    await fsp.writeFile(CERT_PATH, certPem, { mode: 0o644 });

    const expiry = getCertExpiry(certPem) ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const meta: SslMeta = {
      domain,
      email,
      challenge,
      issuedAt: new Date().toISOString(),
      expiresAt: expiry.toISOString(),
      autoRenew: true,
      staging,
    };
    await fsp.writeFile(CERT_META_PATH, JSON.stringify(meta, null, 2), { mode: 0o644 });
    report("SSL certificate saved", { expiresAt: expiry.toISOString() });

  } finally {
    const srv = challengeHttpServer as http.Server | null;
    if (srv) {
      srv.close();
      report("HTTP-01: challenge server stopped");
    }
  }
}

/**
 * Check if a certificate renewal is due (< 30 days to expiry) and renew automatically.
 */
export async function checkAndRenew(): Promise<void> {
  const status = await getSslStatus();
  if (!status.certExists || !status.autoRenew) return;
  if (status.daysUntilExpiry === undefined || status.daysUntilExpiry > 30) return;

  const meta = await readCertMeta();
  if (!meta) {
    console.warn("[ssl] Auto-renew skipped: no certificate metadata");
    return;
  }

  console.log(`[ssl] Auto-renewing certificate (expires in ${status.daysUntilExpiry} days)...`);
  try {
    await provisionCertificate({
      domain: meta.domain,
      email: meta.email,
      challenge: meta.challenge,
      staging: meta.staging ?? false,
      progressCallback: (step) => console.log(`[ssl:autorenew] ${step}`),
    });
    console.log("[ssl] Certificate renewed. Restart the service to apply the new certificate.");
  } catch (err) {
    console.error("[ssl] Auto-renewal failed:", err instanceof Error ? err.message : String(err));
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

function createChallengeServer(): http.Server {
  return http.createServer((req, res) => {
    const token = req.url?.match(/^\/.well-known\/acme-challenge\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (token) {
      const value = challengeTokens.get(token);
      if (value) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(value);
        return;
      }
    }
    res.writeHead(404);
    res.end("Not found");
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function resolveDnsTxt(name: string): Promise<string[][]> {
  try {
    const { stdout } = await execFileAsync("dig", ["+short", "TXT", name, "@8.8.8.8"], { timeout: 10_000 });
    return stdout.trim().split("\n").filter(Boolean).map((line) => [line.replace(/^"|"$/g, "")]);
  } catch {
    // Fallback: try system resolver via node dns
    const { resolveTxt } = await import("dns/promises");
    return resolveTxt(name).catch(() => []);
  }
}

async function waitForDnsTxtRecord(
  name: string,
  expectedValue: string,
  timeoutMs: number,
  onAttempt?: (attempt: number) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    onAttempt?.(attempt);
    try {
      const records = await resolveDnsTxt(name);
      const found = records.flat().some((value) => value === expectedValue);
      if (found) return;
    } catch {
      // DNS query failed, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`DNS-01: TXT record for ${name} not found within timeout (${timeoutMs / 1000}s). Make sure the record is set and try again.`);
}
