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
import { listPbsSnapshotsJson, pbsClientVersion, readPbsBlob, PbsClientError } from "./pbsClient.js";

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
