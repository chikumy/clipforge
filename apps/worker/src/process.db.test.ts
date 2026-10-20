import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type MediaLimits } from "@clipforge/shared";
import { createTestDb } from "../../../supabase/tests/db-setup";
import { markFailed, processProbeJob, type Deps } from "./process";
import { TooLargeError, type ObjectStore } from "./store";

// Real Postgres + real ffprobe; only object storage is faked (files on local disk).
let t: Awaited<ReturnType<typeof createTestDb>>;
let dir: string;
let ws: string;
const files: Record<string, string> = {};
const limits: MediaLimits = { ...DEFAULT_LIMITS };

const store = (map: Record<string, string>): ObjectStore => ({
  async download(key, dest, maxBytes) {
    const src = map[key];
    if (!src) throw new Error("NoSuchKey");
    copyFileSync(src, dest);
    const { size } = statSync(dest);
    if (size > maxBytes) throw new TooLargeError("too big");
    return size;
  },
});

const ffmpeg = (out: string, ...args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=duration=2", ...args, out]);

async function seed(key: string, size: number, status = "uploaded") {
  const a = await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key, status) values ($1,'f.mp4','video/mp4',$2,$3,$4) returning id", [ws, size, key, status]);
  const j = await t.db.query("insert into render_jobs (workspace_id, asset_id, kind) values ($1,$2,'probe') returning id", [ws, a.rows[0].id]);
  return { asset: a.rows[0].id as string, job: j.rows[0].id as string };
}
const assetOf = async (id: string) => (await t.db.query("select status, probe, rejection_reason from assets where id = $1", [id])).rows[0];
const jobOf = async (id: string) => (await t.db.query("select status, progress, attempts, error from render_jobs where id = $1", [id])).rows[0];
const size = (p: string) => statSync(p).size;

beforeAll(async () => {
  t = await createTestDb("worker");
  ws = (await t.db.query("insert into workspaces (name, slug, kind) values ('W','w-1','creator') returning id")).rows[0].id;
  dir = mkdtempSync(join(tmpdir(), "cf-media-"));
  files.mp4 = join(dir, "ok.mp4");
  files.mkv = join(dir, "ok.mkv");
  files.text = join(dir, "playlist.mp4");
  files.corrupt = join(dir, "corrupt.mp4");
  ffmpeg(files.mp4, "-c:v", "libx264", "-c:a", "aac", "-shortest");
  ffmpeg(files.mkv, "-c:v", "libx264", "-c:a", "aac", "-shortest");
  writeFileSync(files.text, "#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n");
  const garbage = Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.from("isom"), Buffer.alloc(200, 7)]);
  writeFileSync(files.corrupt, garbage);
}, 120_000);

afterAll(async () => {
  await t?.drop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await t.db.query("delete from render_jobs");
  await t.db.query("delete from assets");
});

const deps = (map: Record<string, string>, over: Partial<Deps> = {}): Deps => ({ db: t.db, store: store(map), limits, ...over });

describe("processProbeJob", () => {
  it("marks a valid mp4 ready and stores what ffprobe saw", async () => {
    const { asset, job } = await seed("k1", size(files.mp4!));
    expect(await processProbeJob(deps({ k1: files.mp4! }), job)).toBe("ready");
    const a = await assetOf(asset);
    expect(a.status).toBe("ready");
    expect(a.probe).toMatchObject({ width: 320, height: 240, videoCodec: "h264", audioCodec: "aac" });
    expect(a.probe.durationSeconds).toBeGreaterThan(1.5);
    expect(await jobOf(job)).toMatchObject({ status: "succeeded", progress: 100, attempts: 1 });
  });

  it("accepts matroska", async () => {
    const { asset, job } = await seed("k2", size(files.mkv!));
    expect(await processProbeJob(deps({ k2: files.mkv! }), job)).toBe("ready");
    expect((await assetOf(asset)).status).toBe("ready");
  });

  it("rejects a text playlist without running ffprobe on it", async () => {
    const { asset, job } = await seed("k3", size(files.text!));
    expect(await processProbeJob(deps({ k3: files.text! }, { ffprobe: "/bin/false-not-installed" }), job)).toBe("rejected");
    expect(await assetOf(asset)).toMatchObject({ status: "rejected", rejection_reason: expect.stringMatching(/Unsupported video format/) });
    expect((await jobOf(job)).status).toBe("succeeded");
  });

  it("rejects a damaged file", async () => {
    const { asset, job } = await seed("k4", size(files.corrupt!));
    expect(await processProbeJob(deps({ k4: files.corrupt! }), job)).toBe("rejected");
    expect((await assetOf(asset)).rejection_reason).toMatch(/damaged/);
  });

  it("rejects a video over the duration limit", async () => {
    const { asset, job } = await seed("k5", size(files.mp4!));
    expect(await processProbeJob(deps({ k5: files.mp4! }, { limits: { ...limits, maxDurationSeconds: 1 } }), job)).toBe("rejected");
    expect((await assetOf(asset)).rejection_reason).toMatch(/limit/);
  });

  it("rejects when the stored object is not the declared size", async () => {
    const real = size(files.mp4!);
    const small = await seed("k6", real - 10);
    expect(await processProbeJob(deps({ k6: files.mp4! }), small.job)).toBe("rejected");
    const big = await seed("k7", real + 10);
    expect(await processProbeJob(deps({ k7: files.mp4! }), big.job)).toBe("rejected");
    expect((await assetOf(big.asset)).rejection_reason).toMatch(/size/);
  });

  it("rejects declared sizes over the app limit before downloading", async () => {
    const { asset, job } = await seed("k8", 5000);
    expect(await processProbeJob(deps({}, { limits: { ...limits, maxBytes: 1000 } }), job)).toBe("rejected");
    expect((await assetOf(asset)).rejection_reason).toMatch(/larger/);
  });

  it("skips jobs that are already finished, so redelivery is harmless", async () => {
    const { job } = await seed("k9", size(files.mp4!));
    await processProbeJob(deps({ k9: files.mp4! }), job);
    expect(await processProbeJob(deps({ k9: files.mp4! }), job)).toBe("skipped");
    expect((await jobOf(job)).attempts).toBe(1);
    expect(await processProbeJob(deps({}), "00000000-0000-0000-0000-000000000000")).toBe("skipped");
  });

  it("throws on storage failure so the queue can retry, and leaves the job retryable", async () => {
    const { asset, job } = await seed("missing", 100);
    await expect(processProbeJob(deps({}), job)).rejects.toThrow(/NoSuchKey/);
    expect((await jobOf(job)).status).toBe("running");
    expect((await assetOf(asset)).status).toBe("validating");
    await expect(processProbeJob(deps({}), job)).rejects.toThrow(); // second attempt re-claims it
    expect((await jobOf(job)).attempts).toBe(2);
  });

  it("throws when ffprobe is not installed (infrastructure, not a bad file)", async () => {
    const { job } = await seed("k10", size(files.mp4!));
    await expect(processProbeJob(deps({ k10: files.mp4! }, { ffprobe: "/nonexistent/ffprobe" }), job)).rejects.toThrow(/ENOENT/);
  });

  it("refuses an asset that does not belong to the job's workspace", async () => {
    const other = (await t.db.query("insert into workspaces (name, slug, kind) values ('O','o-1','creator') returning id")).rows[0].id;
    const a = await t.db.query("insert into assets (workspace_id, original_filename, content_type, size_bytes, storage_key, status) values ($1,'f.mp4','video/mp4',10,'kx','uploaded') returning id", [ws]);
    // A job row whose workspace disagrees with its asset's workspace must never be processed.
    await t.db.query("alter table render_jobs disable trigger all");
    const j = await t.db.query("insert into render_jobs (workspace_id, asset_id, kind) values ($1,$2,'probe') returning id", [other, a.rows[0].id]);
    await t.db.query("alter table render_jobs enable trigger all");
    await expect(processProbeJob(deps({ kx: files.mp4! }), j.rows[0].id)).rejects.toThrow(/asset not found/);
    expect((await assetOf(a.rows[0].id)).status).toBe("uploaded");
  });
});

describe("markFailed", () => {
  it("fails the job with a generic message and flags the asset", async () => {
    const { asset, job } = await seed("kf", 100);
    await t.db.query("update render_jobs set status = 'running' where id = $1", [job]);
    await t.db.query("update assets set status = 'validating' where id = $1", [asset]);
    await markFailed(t.db, job);
    expect(await jobOf(job)).toMatchObject({ status: "failed", error: expect.not.stringMatching(/NoSuchKey|ENOENT/) });
    expect((await assetOf(asset)).status).toBe("error");
  });

  it("does not overwrite a job that already succeeded", async () => {
    const { asset, job } = await seed("kg", size(files.mp4!));
    await processProbeJob(deps({ kg: files.mp4! }), job);
    await markFailed(t.db, job);
    expect((await jobOf(job)).status).toBe("succeeded");
    expect((await assetOf(asset)).status).toBe("ready");
  });
});
