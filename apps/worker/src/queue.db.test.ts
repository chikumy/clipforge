import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, MEDIA_QUEUE, PROBE_JOB, jobOptions } from "@clipforge/shared";
import { createTestDb } from "../../../supabase/tests/db-setup";
import { reconcile, redisConnection, startWorker } from "./queue";
import type { ObjectStore } from "./store";

// Real Postgres + real Redis + real ffprobe. Skipped unless REDIS_URL is set (see docs/setup.md).
const redisUrl = process.env.REDIS_URL;
const maybe = redisUrl ? describe : describe.skip;

maybe("media queue", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let dir: string;
  let video: string;
  let ws: string;
  let queue: Queue;
  const workers: { close(): Promise<void> }[] = [];

  const okStore: ObjectStore = { async download(_k, dest) { copyFileSync(video, dest); return statSync(video).size; } };
  const brokenStore: ObjectStore = { async download() { throw new Error("S3 unavailable"); } };

  const seed = async () => {
    const a = await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key, status) values ($1,'f.mp4','video/mp4',$2,$3,'uploaded') returning id", [ws, statSync(video).size, `k-${Math.random()}`]);
    const j = await t.db.query("insert into render_jobs (workspace_id, asset_id, kind, created_at) values ($1,$2,'probe', now() - interval '1 minute') returning id", [ws, a.rows[0].id]);
    return { asset: a.rows[0].id as string, job: j.rows[0].id as string };
  };
  const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error("timed out waiting");
  };

  beforeAll(async () => {
    t = await createTestDb("queue");
    ws = (await t.db.query("insert into workspaces (name, slug, kind) values ('W','w-q','creator') returning id")).rows[0].id;
    dir = mkdtempSync(join(tmpdir(), "cf-q-"));
    video = join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-c:v", "libx264", video]);
    queue = new Queue(MEDIA_QUEUE, { connection: redisConnection(redisUrl!) });
    await queue.obliterate({ force: true });
  }, 60_000);

  afterAll(async () => {
    for (const w of workers) await w.close();
    await queue?.close();
    await t?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-enqueues a stranded queued job and processes it to ready", async () => {
    const { asset, job } = await seed();
    expect(await reconcile(t.db as never, queue, 30)).toBe(1);
    workers.push(startWorker({ db: t.db as never, store: okStore, limits: { ...DEFAULT_LIMITS } }, redisUrl!));
    await until(async () => (await t.db.query("select status from assets where id = $1", [asset])).rows[0].status === "ready");
    expect((await t.db.query("select status from render_jobs where id = $1", [job])).rows[0].status).toBe("succeeded");
  });

  it("does not enqueue the same job twice", async () => {
    const { job } = await seed();
    await queue.add(PROBE_JOB, { jobId: job }, jobOptions(job));
    await queue.add(PROBE_JOB, { jobId: job }, jobOptions(job));
    expect(await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed").then((c) => Object.values(c).reduce((a, b) => a + b, 0))).toBeGreaterThan(0);
    const j = await queue.getJob(job);
    expect(j?.id).toBe(job);
    await until(async () => (await t.db.query("select status from render_jobs where id = $1", [job])).rows[0].status === "succeeded");
    expect((await t.db.query("select attempts from render_jobs where id = $1", [job])).rows[0].attempts).toBe(1);
  });

  it("retries storage failures, then marks the job failed and the asset errored", async () => {
    await queue.obliterate({ force: true });
    for (const w of workers.splice(0)) await w.close();
    workers.push(startWorker({ db: t.db as never, store: brokenStore, limits: { ...DEFAULT_LIMITS } }, redisUrl!));
    const { asset, job } = await seed();
    await queue.add(PROBE_JOB, { jobId: job }, jobOptions(job, 50)); // fast backoff for the test
    await until(async () => (await t.db.query("select status from render_jobs where id = $1", [job])).rows[0].status === "failed");
    const j = (await t.db.query("select attempts, error from render_jobs where id = $1", [job])).rows[0];
    expect(j.attempts).toBe(3);
    expect(j.error).not.toMatch(/S3/);
    expect((await t.db.query("select status from assets where id = $1", [asset])).rows[0].status).toBe("error");
  });
});
