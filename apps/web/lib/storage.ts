import "server-only";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { limitsFromEnv, MEDIA_QUEUE, parseStorageEnv, PROBE_JOB, TRANSCRIBE_JOB, jobOptions, type StorageEnv } from "@clipforge/shared";

// Read lazily so pages that never touch storage still render when it is not configured.
let cached: { env: StorageEnv; s3: S3Client; queue: Queue } | undefined;
function ctx() {
  if (!cached) {
    const env = parseStorageEnv(process.env);
    cached = {
      env,
      s3: new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      }),
      queue: new Queue(MEDIA_QUEUE, { connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }) }),
    };
  }
  return cached;
}

export const mediaLimits = () => limitsFromEnv(ctx().env);

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** A one-use form post that S3 itself restricts to this key, this type and exactly this many bytes. */
export function presignUpload(key: string, contentType: string, size: number) {
  const { s3, env } = ctx();
  return createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Expires: UPLOAD_URL_TTL_SECONDS,
    Fields: { "Content-Type": contentType },
    Conditions: [["content-length-range", size, size], ["eq", "$Content-Type", contentType]],
  });
}

/** Size of the stored object, or null if it is not there. */
export async function storedSize(key: string): Promise<number | null> {
  const { s3, env } = ctx();
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return r.ContentLength ?? null;
  } catch (e) {
    if ((e as { name?: string }).name === "NotFound") return null;
    throw e;
  }
}

export const enqueueProbe = (jobId: string) => ctx().queue.add(PROBE_JOB, { jobId }, jobOptions(jobId));
export const enqueueTranscribe = (jobId: string) => ctx().queue.add(TRANSCRIBE_JOB, { jobId }, jobOptions(jobId));
