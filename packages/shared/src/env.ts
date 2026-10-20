import { z } from "zod";

const server = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

/** Names only in the error: a bad or missing value is never echoed back. */
export function parseEnv(source: Record<string, string | undefined>) {
  const r = server.safeParse(source);
  if (r.success) return r.data;
  const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  throw new Error(`Invalid or missing environment variables: ${names.join(", ")}`);
}
