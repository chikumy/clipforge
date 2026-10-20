import { Queue } from "bullmq";
import pg from "pg";
import { limitsFromEnv, MEDIA_QUEUE, parseStorageEnv } from "@clipforge/shared";
import { reconcile, redisConnection, startWorker } from "./queue.js";
import { s3Store } from "./store.js";

const env = parseStorageEnv(process.env);
if (!process.env.DATABASE_URL) throw new Error("Invalid or missing environment variables: DATABASE_URL");

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// Must connect as a role that bypasses RLS (the worker writes results); never expose this URL to the browser.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const queue = new Queue(MEDIA_QUEUE, { connection: redisConnection(env.REDIS_URL) });
const worker = startWorker({ db, store: s3Store(env), limits: limitsFromEnv(env), log }, env.REDIS_URL);

const tick = () => reconcile(db, queue).then((n) => n && log("re-enqueued stranded jobs", { count: n })).catch((e) => log("reconcile failed", { error: String(e) }));
void tick();
const timer = setInterval(tick, 60_000);

const stop = async () => {
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
log("worker started");
