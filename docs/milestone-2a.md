# Milestone 2a: private video upload and validation

## What exists
- **Upload flow.** Editors, admins and owners pick a video on the *Videos* page. The server records the upload (`create_asset_upload`), then gives the browser a signed S3 form that only accepts that exact key, content type and byte size, for 15 minutes. The browser uploads straight to private storage. When it finishes, the server checks the stored object's size itself (it does not trust the browser), then calls `complete_asset_upload`, which creates one `probe` job and queues it.
- **Checking.** A separate worker downloads the file, checks its first bytes (MP4/MOV or Matroska/WebM only), runs `ffprobe` with the demuxer forced to match, and applies limits: size, duration (default 3 h), frame size, stream count. Result: asset `ready` with duration, resolution and codecs, or `rejected` with a plain-language reason.
- **Reliability.** Postgres is the source of truth. The queue entry is only a wake-up: the worker re-queues stranded `queued` jobs every minute. Jobs retry 3 times with backoff; after that the job is `failed` and the asset `error`. Re-delivery of a finished job is a no-op; two active jobs for one asset are impossible (unique index).
- **Security.** Storage keys are built from ids (never filenames) and hidden from clients. Signed forms are single-key, exact-size, typed. Text/playlist files never reach `ffprobe` (no HLS/concat tricks). Clients cannot write `assets` or `render_jobs` directly. Viewers cannot upload. Error messages shown to users are generic for infrastructure failures.
- New tables: `assets`, `render_jobs` (migration `20261020000001_assets_jobs.sql`).

## Tests actually run (authoring session)
| Suite | Result |
|---|---|
| `pnpm test` (unit) | 34 passed |
| `pnpm test:db` with Redis (RLS, worker pipeline with real ffprobe, queue with real Redis) | 54 passed |
| `pnpm test:s3` against **moto** (an S3 mock) | 3 passed, 2 skipped |
| Typecheck, `next build`, smoke e2e | clean / clean / 5 passed |

The 2 skipped S3 tests check that storage *refuses* a wrong-size or wrong-type upload. The mock (moto) does not enforce signed-form rules and MinIO's free Docker image is no longer published, so these have **never been run**: the exact-size limit relies on S3's documented `content-length-range` behaviour and the policy contents are only checked by decoding them. Run them against real S3 or R2 (`S3_ENFORCES_POLICY=true`) before launch. The browser upload end to end (page, signed form, mock S3, worker, status shown) is exercised only in CI (`e2e-journey`).

## Known limitations
- The worker downloads the whole file before checking it (up to the size limit). Later: stream from a signed URL or check only what is needed.
- No delete, cancel or manual retry for uploads yet; no storage cleanup (retention workflow comes later). Unfinished uploads are capped at 20 per workspace per day instead of a general rate limiter.
- Only `probe` jobs exist. Transcription, clip scoring and rendering are Milestone 2b onward.
- Signed form size is exact, so a browser that reports a different `file.size` than it sends will fail; this has not been seen but is untested on large files in real browsers.
- No virus scanning of uploads.

## Configuration still required
S3-compatible bucket (private) with CORS for the site origin; Redis; a worker host with FFmpeg and a database role that bypasses RLS (`DATABASE_URL`); `MAX_UPLOAD_BYTES` / `MAX_VIDEO_SECONDS` if the defaults (2 GiB, 3 h) are not right.

## Next smallest milestone
2b: audio extraction and timestamped transcription behind a provider adapter (with a clearly labelled development mock if no API key is set).
