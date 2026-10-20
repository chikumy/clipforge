import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import type { Pool } from "pg";
import { MEDIA_QUEUE, PROBE_JOB, probeJobData, probeJobOptions } from "@clipforge/shared";
import { markFailed, processProbeJob, type Deps } from "./process.js";

export const redisConnection = (url: string) => new IORedis(url, { maxRetriesPerRequest: null });

/** Queue entries are only a wake-up signal; the render_jobs row is the source of truth. */
export function startWorker(deps: Deps & { db: Pool }, redisUrl: string, concurrency = 2) {
  const worker = new Worker(
    MEDIA_QUEUE,
    async (job) => {
      const { jobId } = probeJobData.parse(job.data); // a malformed payload fails fast and is never retried into success
      if (job.name !== PROBE_JOB) throw new Error(`unknown job name ${job.name}`);
      return processProbeJob(deps, jobId);
    },
    { connection: redisConnection(redisUrl), concurrency },
  );
  worker.on("failed", (job, err) => {
    deps.log?.("job attempt failed", { jobId: job?.id, attempt: job?.attemptsMade, error: err.message });
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const parsed = probeJobData.safeParse(job.data);
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
  const { rows } = await db.query<{ id: string }>(
    "select id from render_jobs where status = 'queued' and kind = 'probe' and created_at < now() - make_interval(secs => $1) order by created_at limit 100",
    [olderThanSeconds],
  );
  for (const r of rows) {
    await queue.add(PROBE_JOB, { jobId: r.id }, probeJobOptions(r.id, backoffMs));
  }
  return rows.length;
}
