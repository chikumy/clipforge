import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageEnv } from "@clipforge/shared";

export class TooLargeError extends Error {}

export interface ObjectStore {
  /** Streams the object to `dest`, failing with TooLargeError past `maxBytes`. Returns bytes written. */
  download(key: string, dest: string, maxBytes: number): Promise<number>;
}

export function s3Store(env: StorageEnv): ObjectStore {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  return {
    async download(key, dest, maxBytes) {
      const res = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      let written = 0;
      const cap = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          cb(written > maxBytes ? new TooLargeError("object larger than allowed") : null, chunk);
        },
      });
      await pipeline(res.Body as Readable, cap, createWriteStream(dest, { mode: 0o600 }));
      return written;
    },
  };
}
