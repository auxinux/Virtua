import { z } from "zod";

/**
 * Proxmox Backup Server contracts shared by the node API (internal routes) and
 * VDM, which owns its PBS remotes and sends the connection with every call.
 * The syntax rules mirror the runner's `validatePbsConnection` so VDM can
 * reject bad input without a runner; nodes still run `pbs_validate`, which
 * stays the authority.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const PbsConnectionSchema = z.object({
  server: z.string().trim().regex(/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}|[0-9a-fA-F:]+)$/, "Invalid PBS server address"),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  datastore: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/, "Invalid PBS datastore name"),
  namespace: optionalTrimmed(255).refine(
    (v) => v === undefined || /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$/.test(v),
    "Invalid PBS namespace",
  ),
  authId: z.string().trim().regex(
    /^[A-Za-z0-9._@-]{1,64}@[A-Za-z0-9._-]{1,32}(![A-Za-z0-9._-]{1,64})?$/,
    "Invalid PBS user / token id (expected user@realm or user@realm!token)",
  ),
  secret: z.string().min(1, "PBS password / token secret is required").max(4096),
  fingerprint: optionalTrimmed(95).transform((v) => v?.toLowerCase()).refine(
    (v) => v === undefined || /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(v),
    "Invalid PBS fingerprint (expected 32 hex bytes separated by ':')",
  ),
});

export type PbsConnectionInput = z.infer<typeof PbsConnectionSchema>;

const keepCount = z.number().int().min(1).max(1000).optional();

export const PbsKeepSchema = z.object({
  keepLast: keepCount,
  keepDaily: keepCount,
  keepWeekly: keepCount,
  keepMonthly: keepCount,
});

export type PbsKeepInput = z.infer<typeof PbsKeepSchema>;

/** Same charset Virtua accepts for VM / container names. */
export const PBS_GUEST_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

/** Optional human label of the remote, used in node-side task labels. */
const remoteName = z.string().trim().max(64).optional();

export const InternalPbsConnectionRequestSchema = z.object({
  connection: PbsConnectionSchema,
});

export const InternalPbsInspectRequestSchema = z.object({
  connection: PbsConnectionSchema,
  snapshot: z.string().min(1).max(300),
});

export const InternalPbsBackupRequestSchema = z.object({
  connection: PbsConnectionSchema,
  remoteName,
  resourceType: z.enum(["vm", "lxc"]),
  name: z.string().regex(PBS_GUEST_NAME_RE, "Invalid guest name"),
  keep: PbsKeepSchema.default({}),
});

export type InternalPbsBackupRequest = z.infer<typeof InternalPbsBackupRequestSchema>;

export const InternalPbsRestoreRequestSchema = z.object({
  connection: PbsConnectionSchema,
  remoteName,
  snapshot: z.string().min(1).max(300),
  name: z.string().trim().min(1).max(63),
  /** Pool NAME on the target node (resolved there to its path). */
  storagePool: z.string().trim().max(128).optional(),
  bridge: z.string().trim().max(32).optional(),
  bridgeMap: z.record(z.string().max(32), z.string().max(32)).optional(),
  autostart: z.boolean().optional(),
  vcpus: z.number().int().min(1).max(512).optional(),
  cpuCores: z.number().int().min(1).max(512).optional(),
  memoryMb: z.number().int().min(16).max(16 * 1024 * 1024).optional(),
  keepUuid: z.boolean().optional(),
  rootArchive: z.string().max(128).optional(),
  totalBytes: z.number().int().nonnegative().optional(),
});

export type InternalPbsRestoreRequest = z.infer<typeof InternalPbsRestoreRequestSchema>;

export interface PbsJobSchedule {
  enabled: number | boolean;
  /** JS weekday digits, 0 = Sunday */
  days: string;
  /** server-local HH:MM */
  time: string;
  last_run_at: string | null;
}

/** True when the job's slot for today has passed and it has not run since. */
export function isPbsJobDue(job: PbsJobSchedule, now: Date): boolean {
  if (!job.enabled || !job.days.includes(String(now.getDay()))) return false;
  const [h, m] = job.time.split(":").map(Number);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (now < slot) return false;
  return !job.last_run_at || new Date(job.last_run_at) < slot;
}

/** VDM restore request: the restore options plus the node to restore onto. */
export const VdmPbsRestoreRequestSchema = InternalPbsRestoreRequestSchema.omit({ connection: true, remoteName: true }).extend({
  targetNode: z.string().trim().min(1).max(63),
});

export type VdmPbsRestoreRequest = z.infer<typeof VdmPbsRestoreRequestSchema>;
