import { execFile } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sniffContainer, validateSegments, type Segment } from "@clipforge/shared";
import type { Deps } from "./process.js";
import { TooLargeError } from "./store.js";

const run = promisify(execFile);

export type Transcription = { language: string | null; segments: Segment[] };
/** Speech-to-text behind one seam, so a real provider is a new file, not a rewrite. */
export interface Transcriber {
  readonly name: string;
  readonly isMock: boolean;
  /** `wav` is 16 kHz mono PCM. */
  transcribe(wav: string, durationSeconds: number): Promise<Transcription>;
}

const WAV_BYTES_PER_SECOND = 16_000 * 2;
const WAV_HEADER_BYTES = 44;

/**
 * DEVELOPMENT ONLY. Produces placeholder text on a fixed 5 s grid; it does no speech recognition.
 * Every segment says so, and the transcript row is flagged is_mock, so it cannot pass for real output.
 */
export const mockTranscriber: Transcriber = {
  name: "mock",
  isMock: true,
  async transcribe(wav) {
    const { size } = await stat(wav);
    const seconds = Math.max(0, (size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND);
    const segments: Segment[] = [];
    for (let start = 0, n = 1; start < seconds; start += 5, n++) {
      segments.push({ start, end: Math.min(start + 5, seconds), text: `[MOCK TRANSCRIPT - not real speech recognition] Placeholder segment ${n}` });
    }
    return { language: null, segments };
  },
};

export type TranscribeOutcome = "done" | "failed" | "skipped";

/**
 * Extracts the audio track and transcribes it. "No audio" is a normal outcome (job failed with a
 * user-safe message); missing tools or provider errors throw so the queue retries.
 */
export async function processTranscribeJob(deps: Deps, jobId: string): Promise<TranscribeOutcome> {
  const { db } = deps;
  const claimed = await db.query<{ workspace_id: string; asset_id: string }>(
    `update render_jobs set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1
     where id = $1 and kind = 'transcribe' and status in ('queued', 'running') returning workspace_id, asset_id`,
    [jobId],
  );
  const job = claimed.rows[0];
  if (!job) return "skipped";
  if (!deps.transcriber) throw new Error("no transcription provider configured");

  const found = await db.query<{ storage_key: string; size_bytes: string; status: string; probe: { durationSeconds: number; audioCodec: string | null } | null }>(
    "select storage_key, size_bytes, status, probe from assets where id = $1 and workspace_id = $2",
    [job.asset_id, job.workspace_id],
  );
  const asset = found.rows[0];
  if (!asset) throw new Error("asset not found for job workspace");

  const fail = async (message: string): Promise<TranscribeOutcome> => {
    await db.query("update render_jobs set status = 'failed', error = $2, finished_at = now() where id = $1", [jobId, message]);
    return "failed";
  };
  if (asset.status !== "ready" || !asset.probe) return fail("The video is not ready to transcribe.");
  if (!asset.probe.audioCodec) return fail("This video has no audio track to transcribe.");

  const dir = await mkdtemp(join(tmpdir(), "clipforge-audio-"));
  const input = join(dir, "input");
  const wav = join(dir, "audio.wav");
  try {
    const declared = Number(asset.size_bytes);
    try {
      await deps.store.download(asset.storage_key, input, declared);
    } catch (e) {
      if (e instanceof TooLargeError) return fail("File size does not match what was declared.");
      throw e;
    }

    const head = new Uint8Array(16);
    const fh = await open(input, "r");
    try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
    const container = sniffContainer(head);
    if (!container) return fail("Unsupported video format.");

    try {
      // Demuxer forced as in the probe step; only the first audio stream, never video or subtitles.
      await run(
        deps.ffmpeg ?? "ffmpeg",
        ["-nostdin", "-v", "error", "-y", "-f", container, "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav],
        { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e;
      return fail("The audio in this video could not be read.");
    }
    await db.query("update render_jobs set progress = 50 where id = $1", [jobId]);

    const result = await deps.transcriber.transcribe(wav, asset.probe.durationSeconds);
    const segments = validateSegments(result.segments, asset.probe.durationSeconds);

    await db.query(
      `insert into transcripts (workspace_id, asset_id, provider, is_mock, language, segments)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (asset_id) do update set provider = excluded.provider, is_mock = excluded.is_mock,
         language = excluded.language, segments = excluded.segments`,
      [job.workspace_id, job.asset_id, deps.transcriber.name, deps.transcriber.isMock, result.language, JSON.stringify(segments)],
    );
    await db.query("update render_jobs set status = 'succeeded', progress = 100, error = null, finished_at = now() where id = $1", [jobId]);
    return "done";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
