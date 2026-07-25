import { z } from "zod";

export const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
