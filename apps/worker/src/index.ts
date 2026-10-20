import { Queue } from "bullmq";
import pg from "pg";
import { limitsFromEnv, MEDIA_QUEUE, parseStorageEnv } from "@clipforge/shared";
import { reconcile, redisConnection, startWorker } from "./queue.js";
import { s3Store } from "./store.js";
import { mockTranscriber } from "./transcribe.js";

const env = parseStorageEnv(process.env);
if (!process.env.DATABASE_URL) throw new Error("Invalid or missing environment variables: DATABASE_URL");

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// Must connect as a role that bypasses RLS (the worker writes results); never expose this URL to the browser.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const queue = new Queue(MEDIA_QUEUE, { connection: redisConnection(env.REDIS_URL) });
// No real provider exists yet. Unset means transcription jobs fail; "mock" is development-only placeholder text.
const provider = process.env.TRANSCRIBE_PROVIDER || undefined;
if (provider && provider !== "mock") throw new Error("Invalid environment variable: TRANSCRIBE_PROVIDER (supported: mock)");
if (provider === "mock" && process.env.NODE_ENV === "production") throw new Error("TRANSCRIBE_PROVIDER=mock is not allowed in production");
const transcriber = provider === "mock" ? mockTranscriber : undefined;
const worker = startWorker({ db, store: s3Store(env), limits: limitsFromEnv(env), transcriber, log }, env.REDIS_URL);

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
