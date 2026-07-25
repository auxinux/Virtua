import { z } from "zod";

const bridgeNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/;
const interfaceNameRegex = /^[a-zA-Z0-9._:-]{1,32}$/;
const cidrRegex = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export const CreateBridgeSchema = z.object({
  name: z.string().regex(bridgeNameRegex, "Bridge name must start with a letter and be 15 characters or fewer"),
  uplinkInterface: z.string().regex(interfaceNameRegex).optional(),
  hostIpMode: z.enum(["none", "dhcp", "static", "copy"]).default("none"),
  ipAddress: z.string().regex(cidrRegex, "IP address must use CIDR notation").optional(),
  gateway: z.string().regex(ipv4Regex, "Gateway must be a valid IPv4 address").optional(),
  stp: z.boolean().default(false),
  mtu: z.number().int().min(576).max(9216).optional(),
  persist: z.boolean().default(true),
});

export type CreateBridgeInput = z.infer<typeof CreateBridgeSchema>;
