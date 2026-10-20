import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../../supabase/tests/db-setup";
import { reconcile, redisConnection } from "./queue";

const redisUrl = process.env.REDIS_URL;
const maybe = redisUrl ? describe : describe.skip;

maybe("reconcile", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let queue: Queue;
  beforeAll(async () => {
    t = await createTestDb("reconcile");
    queue = new Queue(`reconcile-test-${process.pid}`, { connection: redisConnection(redisUrl!) });
  });
  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await t?.drop();
  });

  it("re-enqueues stranded probe and transcribe jobs under their own job names", async () => {
    const ws = (await t.db.query("insert into workspaces (name, slug, kind) values ('W','w-r','creator') returning id")).rows[0].id;
    const a = (await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key, status) values ($1,'f.mp4','video/mp4',1,'k','ready') returning id", [ws])).rows[0].id;
    const probe = (await t.db.query("insert into render_jobs (workspace_id, asset_id, kind, created_at) values ($1,$2,'probe', now() - interval '1 hour') returning id", [ws, a])).rows[0].id;
    await t.db.query("update render_jobs set status = 'succeeded' where id = $1", [probe]);
    const tr = (await t.db.query("insert into render_jobs (workspace_id, asset_id, kind, created_at) values ($1,$2,'transcribe', now() - interval '1 hour') returning id", [ws, a])).rows[0].id;
    const queued = (await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key) values ($1,'g.mp4','video/mp4',1,'k2') returning id", [ws])).rows[0].id;
    const pr = (await t.db.query("insert into render_jobs (workspace_id, asset_id, kind, created_at) values ($1,$2,'probe', now() - interval '1 hour') returning id", [ws, queued])).rows[0].id;

    expect(await reconcile(t.db as never, queue)).toBe(2);
    expect((await queue.getJob(tr))?.name).toBe("transcribe");
    expect((await queue.getJob(pr))?.name).toBe("probe");
    expect(await reconcile(t.db as never, queue)).toBe(2); // idempotent: same ids, no duplicates
    expect((await queue.getJobCounts("waiting")).waiting).toBe(2);
  });
});
