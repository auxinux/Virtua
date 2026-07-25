import { z } from "zod";

export const ResourceAclTypeSchema = z.enum(["vm", "lxc", "docker"]);

export const ResourceAclEntrySchema = z.object({
  id: z.number().int().positive().optional(),
  userId: z.number().int().positive(),
  resourceType: ResourceAclTypeSchema,
  resourceName: z.string().min(1).max(255),
  canView: z.boolean().default(false),
  canConsole: z.boolean().default(false),
  canPower: z.boolean().default(false),
  canMedia: z.boolean().default(false),
  canModify: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  canBackup: z.boolean().default(false),
  canSnapshot: z.boolean().default(false),
  canAdmin: z.boolean().default(false),
});

export const UpdateUserResourceAclSchema = z.object({
  entries: z.array(ResourceAclEntrySchema.omit({ id: true, userId: true })).default([]),
});

export type UpdateUserResourceAclInput = z.infer<typeof UpdateUserResourceAclSchema>;
