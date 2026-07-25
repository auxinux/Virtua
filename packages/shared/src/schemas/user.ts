import { z } from "zod";

/**
 * Password policy enforced on every password CREATION or CHANGE.
 * Login itself accepts anything (so existing accounts keep working until next change).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => /[A-Za-z]/.test(v), { message: "Password must contain at least one letter" })
  .refine((v) => /\d/.test(v), { message: "Password must contain at least one digit" });

export function validatePassword(password: unknown): { ok: true } | { ok: false; error: string } {
  const result = PasswordSchema.safeParse(password);
  if (result.success) return { ok: true };
  return { ok: false, error: result.error.issues[0]?.message ?? "Invalid password" };
}

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: PasswordSchema,
  role: z.enum(["ADMIN", "USER"]).default("USER"),
  displayName: z.string().max(64).optional(),
  email: z.string().email().max(128).optional(),
});

export const UpdateUserSchema = z.object({
  displayName: z.string().max(64).optional(),
  email: z.string().email().max(128).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  mustChangePassword: z.boolean().optional(),
});

export const UpdateUserLimitsSchema = z.object({
  maxVms: z.number().int().min(-1).optional(),
  maxLxc: z.number().int().min(-1).optional(),
  maxDocker: z.number().int().min(-1).optional(),
  maxStorageGb: z.number().int().min(-1).optional(),
  allowVmCreate: z.boolean().optional(),
  allowVmDelete: z.boolean().optional(),
  allowVmModify: z.boolean().optional(),
  allowLxcCreate: z.boolean().optional(),
  allowLxcDelete: z.boolean().optional(),
  allowDockerCreate: z.boolean().optional(),
  allowDockerDelete: z.boolean().optional(),
  allowIsoUpload: z.boolean().optional(),
  allowIsoDelete: z.boolean().optional(),
  allowStorageManage: z.boolean().optional(),
  allowNetworkManage: z.boolean().optional(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type UpdateUserLimitsInput = z.infer<typeof UpdateUserLimitsSchema>;
