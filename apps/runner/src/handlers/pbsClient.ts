/**
 * Thin wrapper around Proxmox's official `proxmox-backup-client`.
 *
 * The PBS chunk store (dedup index, optional encryption, pxar) is only read
 * through the official client — reimplementing it would be fragile. Secrets go
 * through the environment (PBS_PASSWORD), never argv, so they don't show in ps.
 */
import { spawn } from "child_process";
import { buildPbsRepository, parseBackupStartLine, pruneArgs, type PbsConnection, type PruneKeep } from "./pbsConfig.js";

const PBS_CLIENT = process.env.PBS_CLIENT_BIN ?? "proxmox-backup-client";

export class PbsClientError extends Error {
  /** Server certificate fingerprint reported by the client when it is not trusted yet. */
  fingerprint?: string;
  code?: string;
}

function pbsEnv(conn: PbsConnection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    PBS_REPOSITORY: buildPbsRepository(conn),
    PBS_PASSWORD: conn.secret,
  };
  if (conn.fingerprint) env.PBS_FINGERPRINT = conn.fingerprint;
  return env;
}

function nsArgs(conn: PbsConnection): string[] {
  return conn.namespace ? ["--ns", conn.namespace] : [];
}

function toClientError(stderr: string, exitCode: number | null): PbsClientError {
  const text = stderr.trim();
  if (/ENOENT|not found/i.test(text) && exitCode === null) {
    const err = new PbsClientError("proxmox-backup-client is not installed on this node");
    err.code = "PBS_CLIENT_MISSING";
    return err;
  }
  // Unknown self-signed certificate: the client prints the fingerprint, asks
  // "Are you sure you want to continue connecting?" and fails on closed stdin.
  const fp = /fingerprint:\s*((?:[0-9a-f]{2}:){31}[0-9a-f]{2})/i.exec(text)?.[1];
  if (fp) {
    const err = new PbsClientError(`PBS certificate is not trusted yet (fingerprint ${fp.toLowerCase()})`);
    err.fingerprint = fp.toLowerCase();
    err.code = "PBS_UNTRUSTED_CERT";
    return err;
  }
  const lastLines = text.split("\n").filter((l) => l.trim() && !/^Are you sure/i.test(l)).slice(-3).join(" — ");
  return new PbsClientError(`proxmox-backup-client failed: ${lastLines || `exit code ${exitCode}`}`);
}

export interface RunOptions {
  timeoutMs?: number;
  /** Called every few seconds while the command runs (progress polling). */
  onTick?: () => void | Promise<void>;
}

export function runPbsClient(conn: PbsConnection | null, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PBS_CLIENT, args, {
        env: conn ? pbsEnv(conn) : { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(toClientError(String(error), null));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-64 * 1024);
    });
    const tick = opts.onTick ? setInterval(() => { void Promise.resolve(opts.onTick!()).catch(() => {}); }, 3000) : undefined;
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    const done = () => {
      if (tick) clearInterval(tick);
      if (timer) clearTimeout(timer);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      done();
      reject(toClientError(error.code === "ENOENT" ? "ENOENT not found" : error.message, null));
    });
    child.on("close", (code) => {
      done();
      if (code === 0) resolve({ stdout, stderr });
      else reject(toClientError(stderr, code));
    });
  });
}

export async function pbsClientVersion(): Promise<string | null> {
  try {
    const { stdout } = await runPbsClient(null, ["version"], { timeoutMs: 15_000 });
    return /version:\s*(\S+)/i.exec(stdout)?.[1] ?? (stdout.trim() || "unknown");
  } catch {
    return null;
  }
}

export async function listPbsSnapshotsJson(conn: PbsConnection): Promise<string> {
  const { stdout } = await runPbsClient(conn, ["snapshot", "list", "--output-format", "json", ...nsArgs(conn)], { timeoutMs: 120_000 });
  return stdout;
}

/** Read a small blob archive (qemu-server.conf.blob, pct.conf.blob) to memory. */
export async function readPbsBlob(conn: PbsConnection, snapshot: string, archive: string): Promise<string> {
  const { stdout } = await runPbsClient(conn, ["restore", ...nsArgs(conn), snapshot, archive, "-"], { timeoutMs: 120_000 });
  return stdout;
}

/** Restore an image (.img.fidx → raw file) or a pxar (.pxar.didx → directory). */
export async function restorePbsArchive(
  conn: PbsConnection,
  snapshot: string,
  archive: string,
  target: string,
  opts: RunOptions & { extraArgs?: string[] } = {},
): Promise<void> {
  await runPbsClient(conn, ["restore", ...nsArgs(conn), snapshot, archive, target, ...(opts.extraArgs ?? [])], opts);
}

/**
 * Create a snapshot. `specs` are `archive:path` pairs (drive-x.img:/raw/file,
 * root.pxar:/dir, qemu-server.conf:/file). Returns the snapshot reference.
 */
export async function backupToPbs(
  conn: PbsConnection,
  specs: string[],
  group: { type: "vm" | "ct"; id: string },
  opts: RunOptions = {},
): Promise<string | undefined> {
  const { stdout, stderr } = await runPbsClient(conn, [
    "backup", ...specs,
    "--backup-type", group.type,
    "--backup-id", group.id,
    ...nsArgs(conn),
  ], opts);
  return parseBackupStartLine(`${stdout}\n${stderr}`);
}

/** Apply a retention policy to one backup group (vm/<id> or ct/<id>). */
export async function prunePbsGroup(conn: PbsConnection, group: string, keep: PruneKeep): Promise<void> {
  const args = pruneArgs(keep);
  if (args.length === 0) return;
  await runPbsClient(conn, ["prune", group, ...args, ...nsArgs(conn)], { timeoutMs: 10 * 60_000 });
}
