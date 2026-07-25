export type FirewallRuleType = "allow" | "forward";
export type FirewallProtocol = "tcp" | "udp";
export type FirewallRuleSourceKind = "manual" | "auto";
export type FirewallRuleState = "ready" | "creating" | "deleting" | "restoring" | "active";

export interface FirewallRule {
  id: string;
  sourceKind: FirewallRuleSourceKind;
  enabled: boolean;
  type: FirewallRuleType;
  protocol: FirewallProtocol;
  hostPort: number;
  targetIp?: string;
  targetPort?: number;
  sourceCidr?: string;
  description?: string;
  linkedResourceType?: "vm" | "lxc" | "docker" | "host";
  linkedResourceName?: string;
  relation?: string;
  status?: FirewallRuleState;
  createdAt?: string;
  updatedAt?: string;
}

export interface FirewallStatus {
  enabled: boolean;
  backend: "iptables";
  protectedPorts: number[];
  sshPort: number;
  protectSsh: boolean;
  rulesCount: number;
  autoRulesCount: number;
  manualRulesCount: number;
  lastAppliedAt?: string;
}
