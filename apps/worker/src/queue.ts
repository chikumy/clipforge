import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import type { Pool } from "pg";
import { MEDIA_QUEUE, PROBE_JOB, TRANSCRIBE_JOB, jobData, jobOptions } from "@clipforge/shared";
import { markFailed, processProbeJob, type Deps } from "./process.js";
import { processTranscribeJob } from "./transcribe.js";

export const redisConnection = (url: string) => new IORedis(url, { maxRetriesPerRequest: null });

/** Queue entries are only a wake-up signal; the render_jobs row is the source of truth. */
export function startWorker(deps: Deps & { db: Pool }, redisUrl: string, concurrency = 2) {
  const worker = new Worker(
    MEDIA_QUEUE,
    async (job) => {
      const { jobId } = jobData.parse(job.data); // a malformed payload fails fast and is never retried into success
      if (job.name === PROBE_JOB) return processProbeJob(deps, jobId);
      if (job.name === TRANSCRIBE_JOB) return processTranscribeJob(deps, jobId);
      throw new Error(`unknown job name ${job.name}`);
    },
    { connection: redisConnection(redisUrl), concurrency },
  );
  worker.on("failed", (job, err) => {
    deps.log?.("job attempt failed", { jobId: job?.id, attempt: job?.attemptsMade, error: err.message });
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const parsed = jobData.safeParse(job.data);
      if (parsed.success) void markFailed(deps.db, parsed.data.jobId);
    }
  });
  return worker;
}

/**
 * Re-enqueues jobs that are `queued` in Postgres but missing from Redis (the web app commits the row
 * first and enqueues second, so a crash or Redis outage in between would otherwise strand the job).
 */
export async function reconcile(db: Pool, queue: Queue, olderThanSeconds = 30, backoffMs = 5000): Promise<number> {
  const { rows } = await db.query<{ id: string; kind: string }>(
    "select id, kind from render_jobs where status = 'queued' and kind in ('probe', 'transcribe') and created_at < now() - make_interval(secs => $1) order by created_at limit 100",
    [olderThanSeconds],
  );
  for (const r of rows) {
    await queue.add(r.kind, { jobId: r.id }, jobOptions(r.id, backoffMs));
  }
  return rows.length;
}
