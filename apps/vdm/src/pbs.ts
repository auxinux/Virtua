/**
 * Pure helpers for VDM's datacenter-wide Proxmox Backup Server integration:
 * request validation, job targets and run summaries. No I/O here so the rules
 * stay unit-testable; server.ts wires them to the nodes.
 */
import { PbsConnectionSchema, PbsKeepSchema, PBS_GUEST_NAME_RE, type PbsConnectionInput, type PbsKeepInput } from "@auxinux/shared";

export type PbsGuestKind = "vm" | "lxc";

export interface PbsGuestRef {
  node: string;
  kind: PbsGuestKind;
  name: string;
}

/**
 * A job covers every guest of the listed kinds on every enabled node ("all",
 * resolved at run time so new guests are included) plus explicitly selected
 * guests, written `node:kind:name`.
 */
export interface VdmPbsJobTargets {
  all: PbsGuestKind[];
  guests: string[];
}

export interface StoredPbsRemote {
  server: string;
  port: number;
  datastore: string;
  namespace: string | null;
  auth_id: string;
  /** Decrypted secret. */
  secret: string;
  fingerprint: string | null;
}

const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export const PBS_REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export class PbsValidationError extends Error {
  readonly statusCode = 400;
}

function fail(message: string): never {
  throw new PbsValidationError(message);
}

export function parseGuestRef(ref: string): PbsGuestRef | null {
  const parts = ref.split(":");
  if (parts.length !== 3) return null;
  const [node, kind, name] = parts;
  if (!NODE_NAME_RE.test(node) || (kind !== "vm" && kind !== "lxc") || !PBS_GUEST_NAME_RE.test(name)) return null;
  return { node, kind, name };
}

export function formatGuestRef(ref: PbsGuestRef): string {
  return `${ref.node}:${ref.kind}:${ref.name}`;
}

export function parsePbsJobTargets(raw: unknown): VdmPbsJobTargets {
  const t = (raw ?? {}) as Record<string, unknown>;
  const all = Array.isArray(t.all) ? [...new Set(t.all.filter((k): k is PbsGuestKind => k === "vm" || k === "lxc"))].sort() : [];
  const guests: string[] = [];
  for (const entry of Array.isArray(t.guests) ? t.guests : []) {
    const ref = typeof entry === "string" ? parseGuestRef(entry.trim()) : null;
    if (!ref) fail(`Invalid guest reference: ${String(entry).slice(0, 80)} (expected node:vm|lxc:name)`);
    const key = formatGuestRef(ref);
    if (!guests.includes(key)) guests.push(key);
  }
  if (all.length === 0 && guests.length === 0) fail("Select at least one VM or container");
  return { all, guests };
}

/**
 * Merge "all" listings with the explicit selection, one entry per guest. A
 * selected guest of a kind already covered by "all" on its node is not
 * repeated, so a job never backs the same guest up twice in a run.
 */
export function resolvePbsJobGuests(targets: VdmPbsJobTargets, inventory: PbsGuestRef[]): PbsGuestRef[] {
  const out = new Map<string, PbsGuestRef>();
  for (const g of inventory) if (targets.all.includes(g.kind)) out.set(formatGuestRef(g), g);
  for (const key of targets.guests) {
    const ref = parseGuestRef(key);
    if (ref && !out.has(key)) out.set(key, ref);
  }
  return [...out.values()];
}

export function readPbsKeep(body: Record<string, unknown>): PbsKeepInput {
  const n = (v: unknown) => {
    if (v === undefined || v === null || v === "") return undefined;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > 1000) fail("Retention counts must be whole numbers between 1 and 1000");
    return x;
  };
  return PbsKeepSchema.parse({ keepLast: n(body.keepLast), keepDaily: n(body.keepDaily), keepWeekly: n(body.keepWeekly), keepMonthly: n(body.keepMonthly) });
}

/**
 * Request body → PBS connection. An empty secret on an existing remote keeps
 * the stored one, so editing never requires re-typing the token. Error
 * messages name the field, never its value.
 */
export function pbsConnectionFromBody(body: Record<string, unknown>, existing?: StoredPbsRemote): PbsConnectionInput & { port: number } {
  const secret = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : existing?.secret ?? "";
  const pick = (key: string, fallback: unknown) => (body[key] === undefined ? fallback : body[key]);
  const parsed = PbsConnectionSchema.safeParse({
    server: pick("server", existing?.server ?? ""),
    port: pick("port", existing?.port ?? 8007) || 8007,
    datastore: pick("datastore", existing?.datastore ?? ""),
    namespace: pick("namespace", existing?.namespace ?? "") ?? "",
    authId: pick("authId", existing?.auth_id ?? ""),
    secret,
    fingerprint: pick("fingerprint", existing?.fingerprint ?? "") ?? "",
  });
  if (!parsed.success) fail(parsed.error.issues.map((i) => i.message).join("; "));
  return { ...parsed.data, port: parsed.data.port ?? 8007 };
}

export function pbsConnectionFromStored(row: StoredPbsRemote): PbsConnectionInput {
  return {
    server: row.server,
    port: row.port,
    datastore: row.datastore,
    namespace: row.namespace ?? undefined,
    authId: row.auth_id,
    secret: row.secret,
    fingerprint: row.fingerprint ?? undefined,
  };
}

export interface PbsJobValues {
  name: string;
  remoteId: number;
  days: string;
  time: string;
  targets: VdmPbsJobTargets;
  keep: PbsKeepInput;
  enabled: boolean;
}

export function parsePbsJobBody(body: Record<string, unknown>): PbsJobValues {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 64) fail("Job name is required (max 64 chars)");
  const remoteId = Number(body.remoteId);
  if (!Number.isInteger(remoteId) || remoteId < 1) fail("PBS remote is required");
  const days = [...new Set(String(body.days ?? "").split("").filter((d) => /^[0-6]$/.test(d)))].sort().join("");
  if (!days) fail("Pick at least one day");
  const time = String(body.time ?? "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("Time must be HH:MM");
  return { name, remoteId, days, time, targets: parsePbsJobTargets(body.targets), keep: readPbsKeep(body), enabled: body.enabled !== false };
}

export type PbsJobStatus = "ok" | "partial" | "failed";

/** Final status line of a job run (stored on the job, shown in the UI). */
export function summarizePbsJobRun(total: number, failed: string[], skippedNodes: string[]): { status: PbsJobStatus; message: string } {
  const skipped = skippedNodes.length ? ` — skipped offline node(s): ${skippedNodes.join(", ")}` : "";
  if (total === 0) return { status: "failed", message: `No guest matched this job${skipped}` };
  const ok = total - failed.length;
  const status: PbsJobStatus = failed.length === total ? "failed" : failed.length > 0 || skippedNodes.length > 0 ? "partial" : "ok";
  const message = failed.length === 0
    ? `${total} guest(s) backed up${skipped}`
    : `${ok}/${total} backed up — ${failed.join("; ")}${skipped}`;
  return { status, message: message.slice(0, 2000) };
}

/**
 * Notes ("Note: …") a node task wrote to its activity log — restore and
 * backup caveats such as TPM content or VLAN tags — without the time prefix.
 */
export function extractTaskNotes(activityLog: unknown): string[] {
  if (!Array.isArray(activityLog)) return [];
  const notes: string[] = [];
  for (const line of activityLog) {
    if (typeof line !== "string") continue;
    const text = line.includes(" · ") ? line.split(" · ").slice(1).join(" · ") : line;
    if (text.startsWith("Note: ")) notes.push(text.slice(6));
  }
  return [...new Set(notes)];
}

/** Map a node task's 0–100 progress into the [from, to] slice of the VDM task. */
export function scaleProgress(nodePercent: unknown, from: number, to: number): number {
  const p = typeof nodePercent === "number" && Number.isFinite(nodePercent) ? Math.max(0, Math.min(100, nodePercent)) : 0;
  return Math.round(from + ((to - from) * p) / 100);
}
