import { z } from "zod";

const nodeNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const UpdateDatacenterConfigSchema = z.object({
  mode: z.enum(["standalone", "datacenter"]).default("standalone"),
  name: z.string().min(1).max(128),
  primaryNodeName: z.string().regex(nodeNameRegex, "Primary node must reference a valid node name"),
  primaryApiUrl: z.string().url().nullable().optional(),
});

export const CreateDatacenterNodeSchema = z.object({
  name: z.string().regex(nodeNameRegex, "Node name must use letters, digits, dots, dashes or underscores"),
  displayName: z.string().max(128).optional(),
  apiUrl: z.string().url().optional(),
  role: z.enum(["primary", "secondary"]).default("secondary"),
  enabled: z.boolean().default(true),
  notes: z.string().max(500).optional(),
});

export const UpdateDatacenterNodeSchema = z.object({
  displayName: z.string().max(128).nullable().optional(),
  apiUrl: z.string().url().nullable().optional(),
  role: z.enum(["primary", "secondary"]).optional(),
  enabled: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const CreateJoinTokenSchema = z.object({
  note: z.string().max(255).optional(),
  expiresInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
});

export const JoinDatacenterSchema = z.object({
  primaryApiUrl: z.string().url(),
  token: z.string().min(8).max(255),
  nodeName: z.string().regex(nodeNameRegex, "Node name must use letters, digits, dots, dashes or underscores").optional(),
  displayName: z.string().max(128).optional(),
  apiUrl: z.string().url().optional(),
});

export type UpdateDatacenterConfigInput = z.infer<typeof UpdateDatacenterConfigSchema>;
export type CreateDatacenterNodeInput = z.infer<typeof CreateDatacenterNodeSchema>;
export type UpdateDatacenterNodeInput = z.infer<typeof UpdateDatacenterNodeSchema>;
export type CreateJoinTokenInput = z.infer<typeof CreateJoinTokenSchema>;
export type JoinDatacenterInput = z.infer<typeof JoinDatacenterSchema>;
