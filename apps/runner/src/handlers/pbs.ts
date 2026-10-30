/**
 * Proxmox Backup Server browsing: client status, snapshot listing and the
 * read-only inspection used to pre-fill the restore dialog. The restores
 * themselves live with their siblings (qemu_restore_pbs / lxc_restore_pbs).
 */
import {
  parsePveCtConfig,
  parsePveVmConfig,
  parseSnapshotList,
  parseSnapshotRef,
  sanitizeGuestName,
  validatePbsConnection,
} from "./pbsConfig.js";
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import { promisify } from "util";
import { listPbsSnapshotsJson, pbsClientVersion, readPbsBlob, PbsClientError } from "./pbsClient.js";
import { PROXMOX_KEYRING_BASE64, PROXMOX_KEYRING_SHA256 } from "./proxmoxKeyring.js";

const execFileAsync = promisify(execFile);
const KEYRING_PATH = "/usr/share/keyrings/auxinux-proxmox-archive-keyring.gpg";
const SOURCES_PATH = "/etc/apt/sources.list.d/auxinux-proxmox-pbs-client.sources";
const APT_ENV = { ...process.env, DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8" };

export async function handlePbs(action: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (action) {
    case "pbs_status": {
      const version = await pbsClientVersion();
      return { installed: !!version, version };
    }
    case "pbs_validate": {
      const { secret: _secret, ...conn } = validatePbsConnection(p.connection);
      return conn;
    }
    case "pbs_install_client": return installClient(p);
    case "pbs_list_snapshots": return listSnapshots(p);
    case "pbs_inspect": return inspectSnapshot(p);
    default: throw new Error(`Unknown pbs action: ${action}`);
  }
}

async function listSnapshots(p: Record<string, unknown>) {
  const conn = validatePbsConnection(p.connection);
  try {
    return { ok: true, snapshots: parseSnapshotList(await listPbsSnapshotsJson(conn)) };
  } catch (error) {
    // Surface the fingerprint so the UI can offer "trust this certificate".
    if (error instanceof PbsClientError && error.fingerprint) {
      return { ok: false, error: error.message, code: error.code, fingerprint: error.fingerprint, snapshots: [] };
    }
    throw error;
  }
}

async function inspectSnapshot(p: Record<string, unknown>) {
  const conn = validatePbsConnection(p.connection);
  const snapshot = String(p.snapshot ?? "");
  const { type, id } = parseSnapshotRef(snapshot);
  if (type === "vm") {
    const spec = parsePveVmConfig(await readPbsBlob(conn, snapshot, "qemu-server.conf.blob"));
    return { type, spec, suggestedName: sanitizeGuestName(spec.name, `vm-${id}`) };
  }
  const spec = parsePveCtConfig(await readPbsBlob(conn, snapshot, "pct.conf.blob"));
  return { type, spec, suggestedName: sanitizeGuestName(spec.hostname, `ct-${id}`) };
}

/**
 * Install proxmox-backup-client from the AuxiNux depot's mirror of Proxmox's
 * pbs-client repository. Afterwards it is a normal apt package: it follows
 * the node's regular apt upgrades, nothing to copy by hand.
 */
async function installClient(p: Record<string, unknown>) {
  const repoUrl = String(p.repoUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(repoUrl)) throw new Error("Invalid Proxmox repository URL");

  const osRelease = await fs.readFile("/etc/os-release", "utf8").catch(() => "");
  const codename = /^VERSION_CODENAME=(\S+)$/m.exec(osRelease)?.[1]?.replace(/"/g, "");
  if (codename !== "trixie") throw new Error(`proxmox-backup-client is only provided for Debian 13 (trixie); this node runs ${codename ?? "an unknown release"}`);

  const keyring = Buffer.from(PROXMOX_KEYRING_BASE64, "base64");
  if (createHash("sha256").update(keyring).digest("hex") !== PROXMOX_KEYRING_SHA256) throw new Error("Embedded Proxmox keyring is corrupted");
  await fs.writeFile(KEYRING_PATH, keyring, { mode: 0o644 });
  await fs.writeFile(SOURCES_PATH, [
    "# Managed by AuxiNux Virtua — mirror of Proxmox's pbs-client repository",
    "Types: deb",
    `URIs: ${repoUrl}`,
    "Suites: trixie",
    "Components: main",
    `Signed-By: ${KEYRING_PATH}`,
    "",
  ].join("\n"), { mode: 0o644 });

  const run = async (args: string[]) => {
    try {
      await execFileAsync("apt-get", args, { env: APT_ENV, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-3).join(" — ");
      throw new Error(`apt-get ${args[0]} failed: ${stderr || (error as Error).message}`);
    }
  };
  await run(["update"]);
  await run(["install", "-y", "proxmox-backup-client"]);
  const version = await pbsClientVersion();
  if (!version) throw new Error("proxmox-backup-client was installed but does not run");
  return { installed: true, version };
}
