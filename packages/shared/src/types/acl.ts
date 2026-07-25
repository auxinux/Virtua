export type ResourceAclType = "vm" | "lxc" | "docker";

export interface ResourceAclEntry {
  id: number;
  userId: number;
  resourceType: ResourceAclType;
  resourceName: string;
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canMedia: boolean;
  canModify: boolean;
  canDelete: boolean;
  canBackup: boolean;
  canSnapshot: boolean;
  canAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceCatalogEntry {
  resourceType: ResourceAclType;
  resourceName: string;
  displayName: string;
  ownerId: number | null;
  ownerUsername?: string | null;
}
