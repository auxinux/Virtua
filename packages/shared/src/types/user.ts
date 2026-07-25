export type Role = "ADMIN" | "USER";

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string | null;
  email: string | null;
  suspended: boolean;
  mustChangePassword: boolean;
  permissions: string[];
  createdAt: string;
}

export interface UserLimits {
  userId: number;
  maxVms: number;        // -1 = unlimited
  maxLxc: number;
  maxDocker: number;
  maxStorageGb: number;
  allowVmCreate: boolean;
  allowVmDelete: boolean;
  allowVmModify: boolean;
  allowLxcCreate: boolean;
  allowLxcDelete: boolean;
  allowDockerCreate: boolean;
  allowDockerDelete: boolean;
  allowIsoUpload: boolean;
  allowIsoDelete: boolean;
  allowStorageManage: boolean;
  allowNetworkManage: boolean;
}

export interface AuditLog {
  id: number;
  userId: number | null;
  username: string | null;
  ip: string | null;
  action: string;
  resourceType: string | null;
  resourceName: string | null;
  result: "success" | "error";
  details: string | null;
  createdAt: string;
  /** "security" entries are immutable (never pruned or cleared). */
  category?: "general" | "security";
}
