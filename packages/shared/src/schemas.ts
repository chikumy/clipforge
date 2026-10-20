import { z } from "zod";
import { ROLES, WORKSPACE_KINDS } from "./permissions";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, "Use at least 10 characters").max(128);

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80),
});
export const signInSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(WORKSPACE_KINDS),
  timezone: z.string().min(1).max(64).default("UTC"),
});

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((r) => r !== "owner", "Invite as admin, then promote to owner."),
});
