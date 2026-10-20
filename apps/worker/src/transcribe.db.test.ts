import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@clipforge/shared";
import { createTestDb } from "../../../supabase/tests/db-setup";
import type { Deps } from "./process";
import type { ObjectStore } from "./store";
import { mockTranscriber, processTranscribeJob, type Transcriber } from "./transcribe";

// Real Postgres + real ffmpeg; only object storage is faked (files on local disk).
let t: Awaited<ReturnType<typeof createTestDb>>;
let dir: string;
let ws: string;
const files: Record<string, string> = {};

const store: ObjectStore = {
  async download(key, dest) {
    const src = files[key];
    if (!src) throw new Error("NoSuchKey");
    copyFileSync(src, dest);
    return statSync(dest).size;
  },
};
const deps = (over: Partial<Deps> = {}): Deps => ({ db: t.db, store, limits: { ...DEFAULT_LIMITS }, transcriber: mockTranscriber, ...over });

const make = (out: string, withAudio: boolean) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=320x240:rate=10",
    ...(withAudio ? ["-f", "lavfi", "-i", "sine=duration=12", "-c:a", "aac"] : []), "-c:v", "libx264", out]);

async function seed(key: string, probe: object, status = "ready") {
  const a = await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key, status, probe) values ($1,'f.mp4','video/mp4',$2,$3,$4,$5) returning id", [ws, statSync(files[key]!).size, key, status, JSON.stringify(probe)]);
  const j = await t.db.query("insert into render_jobs (workspace_id, asset_id, kind) values ($1,$2,'transcribe') returning id", [ws, a.rows[0].id]);
  return { asset: a.rows[0].id as string, job: j.rows[0].id as string };
}
const jobOf = async (id: string) => (await t.db.query("select status, progress, error from render_jobs where id = $1", [id])).rows[0];
const transcriptOf = async (asset: string) => (await t.db.query("select * from transcripts where asset_id = $1", [asset])).rows[0];

beforeAll(async () => {
  t = await createTestDb("transcribe");
  ws = (await t.db.query("insert into workspaces (name, slug, kind) values ('W','w-1','creator') returning id")).rows[0].id;
  dir = mkdtempSync(join(tmpdir(), "cf-tr-"));
  files.audio = join(dir, "audio.mp4");
  files.silent = join(dir, "silent.mp4");
  make(files.audio, true);
  make(files.silent, false);
}, 120_000);
afterAll(async () => {
  await t?.drop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.db.query("delete from transcripts");
  await t.db.query("delete from render_jobs");
  await t.db.query("delete from assets");
});

describe("processTranscribeJob", () => {
  it("extracts audio and stores clearly labelled mock segments on a 5 s grid", async () => {
    const { asset, job } = await seed("audio", { durationSeconds: 12, audioCodec: "aac" });
    expect(await processTranscribeJob(deps(), job)).toBe("done");
    const tr = await transcriptOf(asset);
    expect(tr).toMatchObject({ provider: "mock", is_mock: true, workspace_id: ws });
    expect(tr.segments).toHaveLength(3); // 0-5, 5-10, 10-~12
    expect(tr.segments[0]).toMatchObject({ start: 0, end: 5 });
    expect(tr.segments[0].text).toContain("MOCK");
    expect(tr.segments[2].end).toBeGreaterThan(11.5);
    expect(await jobOf(job)).toMatchObject({ status: "succeeded", progress: 100 });
  });

  it("fails a video without audio with a user-safe message and no transcript", async () => {
    const { asset, job } = await seed("silent", { durationSeconds: 12, audioCodec: null });
    expect(await processTranscribeJob(deps(), job)).toBe("failed");
    expect(await transcriptOf(asset)).toBeUndefined();
    expect((await jobOf(job)).error).toMatch(/no audio/);
  });

  it("throws, and stores nothing, when no provider is configured", async () => {
    const { asset, job } = await seed("audio", { durationSeconds: 12, audioCodec: "aac" });
    await expect(processTranscribeJob(deps({ transcriber: undefined }), job)).rejects.toThrow(/no transcription provider/);
    expect(await transcriptOf(asset)).toBeUndefined();
  });

  it("rejects provider output that runs past the video, so nothing bad is stored", async () => {
    const bad: Transcriber = { name: "bad", isMock: false, transcribe: async () => ({ language: "en", segments: [{ start: 0, end: 999, text: "x" }] }) };
    const { asset, job } = await seed("audio", { durationSeconds: 12, audioCodec: "aac" });
    await expect(processTranscribeJob(deps({ transcriber: bad }), job)).rejects.toThrow();
    expect(await transcriptOf(asset)).toBeUndefined();
  });

  it("is a no-op for a finished job, a probe job, or an unknown id", async () => {
    const { job } = await seed("audio", { durationSeconds: 12, audioCodec: "aac" });
    await processTranscribeJob(deps(), job);
    expect(await processTranscribeJob(deps(), job)).toBe("skipped");
    expect(await processTranscribeJob(deps(), "00000000-0000-0000-0000-000000000000")).toBe("skipped");
  });

  it("will not transcribe an asset that is not ready", async () => {
    const { asset, job } = await seed("audio", { durationSeconds: 12, audioCodec: "aac" }, "rejected");
    expect(await processTranscribeJob(deps(), job)).toBe("failed");
    expect(await transcriptOf(asset)).toBeUndefined();
  });
});
