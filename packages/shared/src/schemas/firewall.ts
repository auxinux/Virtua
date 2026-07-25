import { z } from "zod";

const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const cidrRegex = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/;

export const FirewallRuleSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.enum(["allow", "forward"]),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  hostPort: z.number().int().min(1).max(65535),
  targetIp: z.string().regex(ipv4Regex, "Target IP must be a valid IPv4 address").optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
  sourceCidr: z.string().regex(cidrRegex, "Source must be a valid IPv4/CIDR").optional(),
  description: z.string().max(500).optional(),
  linkedResourceType: z.enum(["vm", "lxc", "docker", "host"]).optional(),
  linkedResourceName: z.string().max(128).optional(),
  relation: z.string().max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "forward") {
    if (!value.targetIp) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Forward rules require a target IP", path: ["targetIp"] });
    }
    if (!value.targetPort) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Forward rules require a target port", path: ["targetPort"] });
    }
  }
});

export const FirewallSettingsSchema = z.object({
  enabled: z.boolean(),
  protectSsh: z.boolean().optional(),
});

export type FirewallRuleInput = z.infer<typeof FirewallRuleSchema>;
export type FirewallSettingsInput = z.infer<typeof FirewallSettingsSchema>;
