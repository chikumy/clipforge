import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { sniffContainer, validateProbe, type FfprobeOutput, type MediaLimits } from "@clipforge/shared";
import { TooLargeError, type ObjectStore } from "./store.js";

const run = promisify(execFile);

export type Deps = {
  db: Pick<Pool, "query">;
  store: ObjectStore;
  limits: MediaLimits;
  ffprobe?: string;
  ffmpeg?: string;
  /** Absent means transcription jobs fail (and retry) instead of inventing text. */
  transcriber?: import("./transcribe.js").Transcriber;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type Outcome = "ready" | "rejected" | "skipped";

type AssetRow = { id: string; storage_key: string; size_bytes: string };

/**
 * Validates one uploaded video. Bad media is a normal outcome (asset rejected, job succeeded);
 * infrastructure problems throw so the queue retries, and `markFailed` records the final failure.
 */
export async function processProbeJob(deps: Deps, jobId: string): Promise<Outcome> {
  const { db, limits } = deps;
  const claimed = await db.query<{ workspace_id: string; asset_id: string }>(
    `update render_jobs set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1
     where id = $1 and kind = 'probe' and status in ('queued', 'running') returning workspace_id, asset_id`,
    [jobId],
  );
  const job = claimed.rows[0];
  if (!job) return "skipped"; // finished, cancelled, or unknown: nothing to do

  // Re-check ownership: the asset must belong to the job's workspace, whatever the queue payload said.
  const found = await db.query<AssetRow>(
    "select id, storage_key, size_bytes from assets where id = $1 and workspace_id = $2",
    [job.asset_id, job.workspace_id],
  );
  const asset = found.rows[0];
  if (!asset) throw new Error("asset not found for job workspace");

  await db.query("update assets set status = 'validating' where id = $1", [asset.id]);

  const reject = async (reason: string): Promise<Outcome> => {
    await db.query("update assets set status = 'rejected', rejection_reason = $2 where id = $1", [asset.id, reason]);
    await db.query("update render_jobs set status = 'succeeded', progress = 100, finished_at = now() where id = $1", [jobId]);
    deps.log?.("asset rejected", { jobId, reason });
    return "rejected";
  };

  const declared = Number(asset.size_bytes);
  if (declared > limits.maxBytes) return reject("File is larger than the upload limit.");

  const dir = await mkdtemp(join(tmpdir(), "clipforge-probe-"));
  const file = join(dir, "input");
  try {
    let written: number;
    try {
      written = await deps.store.download(asset.storage_key, file, declared);
    } catch (e) {
      if (e instanceof TooLargeError) return reject("File size does not match what was declared.");
      throw e;
    }
    if (written !== declared) return reject("File size does not match what was declared.");

    const head = new Uint8Array(16);
    const fh = await open(file, "r");
    try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
    const container = sniffContainer(head);
    if (!container) return reject("Unsupported video format. Use MP4, MOV, WebM or MKV.");

    let probe: FfprobeOutput;
    try {
      const { stdout } = await run(
        deps.ffprobe ?? "ffprobe",
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-f", container, "-i", file],
        { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      );
      probe = JSON.parse(stdout) as FfprobeOutput;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { killed?: boolean };
      if (err.code === "ENOENT") throw e; // ffprobe missing: infrastructure, retry/alert
      return reject("This file could not be read. It may be damaged.");
    }

    const verdict = validateProbe(probe, limits);
    if (!verdict.ok) return reject(verdict.reason);

    await db.query("update assets set status = 'ready', probe = $2, rejection_reason = null where id = $1", [asset.id, JSON.stringify(verdict.summary)]);
    await db.query("update render_jobs set status = 'succeeded', progress = 100, error = null, finished_at = now() where id = $1", [jobId]);
    return "ready";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Records a job that ran out of retries. The stored message is generic; details go to logs only. */
export async function markFailed(db: Deps["db"], jobId: string): Promise<void> {
  const r = await db.query<{ asset_id: string }>(
    "update render_jobs set status = 'failed', error = 'Processing failed. Please try again later.', finished_at = now() where id = $1 and status in ('queued', 'running') returning asset_id",
    [jobId],
  );
  if (r.rows[0]) await db.query("update assets set status = 'error' where id = $1 and status in ('uploaded', 'validating')", [r.rows[0].asset_id]);
}
