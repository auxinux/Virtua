import Database from "better-sqlite3";
import type { FastifyReply } from "fastify";

interface UserLimitsRow {
  max_vms: number;
  max_lxc: number;
  max_docker: number;
  max_storage_gb: number;
  allow_vm_create: number;
  allow_vm_delete: number;
  allow_vm_modify: number;
  allow_lxc_create: number;
  allow_lxc_delete: number;
  allow_docker_create: number;
  allow_docker_delete: number;
  allow_iso_upload: number;
  allow_iso_delete: number;
  allow_storage_manage: number;
  allow_network_manage: number;
}

const DEFAULT_LIMITS: UserLimitsRow = {
  max_vms: -1, max_lxc: -1, max_docker: -1, max_storage_gb: -1,
  allow_vm_create: 0, allow_vm_delete: 0, allow_vm_modify: 0,
  allow_lxc_create: 0, allow_lxc_delete: 0,
  allow_docker_create: 0, allow_docker_delete: 0,
  allow_iso_upload: 0, allow_iso_delete: 0,
  allow_storage_manage: 0, allow_network_manage: 0,
};

function getLimits(db: Database.Database, userId: number): UserLimitsRow {
  const row = db.prepare("SELECT * FROM user_limits WHERE user_id = ?").get(userId) as UserLimitsRow | undefined;
  return row ?? DEFAULT_LIMITS;
}

type ResourceType = "vms" | "lxc" | "docker";

export function checkQuota(db: Database.Database, userId: number, role: string, type: ResourceType): { ok: boolean; reason?: string } {
  if (role === "ADMIN") return { ok: true };
  const limits = getLimits(db, userId);
  const maxKey = type === "vms" ? "max_vms" : type === "lxc" ? "max_lxc" : "max_docker";
  const max = limits[maxKey];
  if (max === 0) return { ok: false, reason: `You are not allowed to create ${type}` };
  if (max === -1) return { ok: true };

  const tableMap: Record<string, string> = { vms: "qemu_vms", lxc: "lxc_containers", docker: "docker_containers" };
  const count = (db.prepare(`SELECT COUNT(*) as c FROM ${tableMap[type]} WHERE user_id = ?`).get(userId) as { c: number }).c;
  if (count >= max) return { ok: false, reason: `Quota exceeded: max ${max} ${type} per user` };
  return { ok: true };
}

export function checkPermission(db: Database.Database, userId: number, role: string, action: keyof UserLimitsRow): { ok: boolean; reason?: string } {
  if (role === "ADMIN") return { ok: true };
  const limits = getLimits(db, userId);
  if (!limits[action]) return { ok: false, reason: `You do not have permission to perform this action` };
  return { ok: true };
}

export function replyQuotaError(reply: FastifyReply, result: { ok: boolean; reason?: string }) {
  return reply.status(403).send({ error: result.reason ?? "Forbidden" });
}
