import { z } from "zod";
import { DEFAULT_LIMITS } from "./media";

const num = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const storageEnvSchema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(), // set for MinIO / R2 / other S3-compatible stores
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  REDIS_URL: z.string().min(1),
  MAX_UPLOAD_BYTES: num(DEFAULT_LIMITS.maxBytes),
  MAX_VIDEO_SECONDS: num(DEFAULT_LIMITS.maxDurationSeconds),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;

/** Names only in the error. Read lazily so pages that do not use storage still work without it. */
export function parseStorageEnv(source: Record<string, string | undefined>): StorageEnv {
  // An empty value in a .env file means "unset".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const r = storageEnvSchema.safeParse(present);
  if (r.success) return r.data;
  const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  throw new Error(`Invalid or missing environment variables: ${names.join(", ")}`);
}

export const limitsFromEnv = (e: StorageEnv) => ({
  ...DEFAULT_LIMITS,
  maxBytes: e.MAX_UPLOAD_BYTES,
  maxDurationSeconds: e.MAX_VIDEO_SECONDS,
});
