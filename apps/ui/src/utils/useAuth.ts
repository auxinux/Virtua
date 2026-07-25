import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export type ResourceType = "vm" | "lxc" | "docker";
export type ResourcePermissionKey =
  | "canView"
  | "canConsole"
  | "canPower"
  | "canMedia"
  | "canModify"
  | "canDelete"
  | "canBackup"
  | "canSnapshot"
  | "canAdmin";

export interface ResourcePermissionSet {
  canView: boolean;
  canConsole: boolean;
  canPower: boolean;
  canMedia: boolean;
  canModify: boolean;
  canDelete: boolean;
  canBackup: boolean;
  canSnapshot: boolean;
  canAdmin: boolean;
}

export interface AuthCapabilities {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  displayName: string | null;
  email: string | null;
  mustChangePassword: boolean;
  limits: {
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
  };
  sections: Record<
    | "datacenter"
    | "createWizard"
    | "host"
    | "dashboard"
    | "health"
    | "hostShell"
    | "storageOverview"
    | "isoLibrary"
    | "backups"
    | "network"
    | "firewall"
    | "users"
    | "audit"
    | "settings"
    | "vms"
    | "vmCreate"
    | "lxc"
    | "lxcCreate"
    | "docker"
    | "dockerCreate",
    boolean
  >;
  resources: {
    vms: Array<{ name: string; nodeName: string; permissions: ResourcePermissionSet }>;
    lxc: Array<{ name: string; nodeName: string; permissions: ResourcePermissionSet }>;
    docker: Array<{ id: string; nodeName: string; permissions: ResourcePermissionSet }>;
  };
  defaultRoute: string;
}

function emptyPermissions(): ResourcePermissionSet {
  return {
    canView: false,
    canConsole: false,
    canPower: false,
    canMedia: false,
    canModify: false,
    canDelete: false,
    canBackup: false,
    canSnapshot: false,
    canAdmin: false,
  };
}

export function useAuth() {
  const { data, isLoading, error } = useQuery<AuthCapabilities>({
    queryKey: ["auth", "capabilities"],
    queryFn: () => apiGet<AuthCapabilities>("/api/auth/capabilities"),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const getResourcePermissions = (resourceType: ResourceType, resourceName: string): ResourcePermissionSet => {
    if (!data) return emptyPermissions();
    if (data.role === "ADMIN") {
      return {
        canView: true,
        canConsole: true,
        canPower: true,
        canMedia: true,
        canModify: true,
        canDelete: true,
        canBackup: true,
        canSnapshot: true,
        canAdmin: true,
      };
    }
    if (resourceType === "vm") {
      return data.resources.vms.find((entry) => entry.name === resourceName)?.permissions ?? emptyPermissions();
    }
    if (resourceType === "lxc") {
      return data.resources.lxc.find((entry) => entry.name === resourceName)?.permissions ?? emptyPermissions();
    }
    return data.resources.docker.find((entry) => entry.id === resourceName || entry.id.startsWith(resourceName) || resourceName.startsWith(entry.id))?.permissions ?? emptyPermissions();
  };

  return {
    user: data
      ? {
          id: data.id,
          username: data.username,
          role: data.role,
          displayName: data.displayName,
          email: data.email,
          mustChangePassword: data.mustChangePassword,
        }
      : undefined,
    capabilities: data,
    isLoading,
    isAuthenticated: !!data,
    isAdmin: data?.role === "ADMIN",
    getResourcePermissions,
    error,
  };
}
