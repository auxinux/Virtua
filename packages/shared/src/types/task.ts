export type TaskStatus = "pending" | "running" | "completed" | "failed";
export type TaskKind =
  | "upload"
  | "url-download"
  | "docker-pull"
  | "lxc-cache"
  | "backup-upload"
  | "backup-delete"
  | "vm-snapshot"
  | "vm-backup"
  | "vm-restore"
  | "vm-rollback"
  | "vm-snapshot-delete"
  | "lxc-snapshot"
  | "lxc-backup"
  | "lxc-restore"
  | "lxc-rollback"
  | "lxc-snapshot-delete";

export interface TaskProgress {
  id: string;
  kind: TaskKind;
  ownerUsername?: string;
  action?: string;
  label: string;
  resourceType?: string;
  resourceName?: string;
  status: TaskStatus;
  progressPercent: number;
  bytesCurrent?: number;
  bytesTotal?: number;
  message?: string;
  detail?: string;
  activityLog?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
