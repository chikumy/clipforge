# Milestone 2b: audio extraction and transcription

## What works
- A member with role owner, admin or editor clicks **Transcribe** on a ready video that has an audio track (Videos page). The `request_transcription` RPC checks role, that the video is `ready`, has audio, and has no transcript yet; a double click returns the same job (unique active-job index). The request is audited.
- The worker claims the `transcribe` job, re-checks the asset belongs to the job's workspace, downloads the file, re-sniffs the container, and runs ffmpeg with the demuxer forced (`-f mov|matroska`) to write the first audio stream as 16 kHz mono WAV in a temp directory. The WAV is deleted afterwards; nothing audio-related is stored.
- The WAV goes to a `Transcriber` (`apps/worker/src/transcribe.ts`). Output is validated (`validateSegments`: bounded count, text length, ordered, not past the video's end) before it is written to `transcripts` (one per video, `segments` as `[{start,end,text}]`).
- Queue: one `media` queue, job name = kind (`probe` | `transcribe`). The reconcile loop re-enqueues stranded jobs of both kinds. Retries and final failure behave as in 2a.
- Transcripts are readable by workspace members only; clients cannot write them (RLS `with check (false)`).

## The provider is a mock
There is **no real speech recognition** in this milestone. `TRANSCRIBE_PROVIDER=mock` produces placeholder segments on a fixed 5 s grid, each saying `[MOCK TRANSCRIPT - not real speech recognition]`. The row has `is_mock = true` and the UI shows a warning. The worker refuses `mock` when `NODE_ENV=production`. With `TRANSCRIBE_PROVIDER` unset, transcription jobs fail after retries rather than inventing text.

## Configuration still needed
- A real provider: implement the `Transcriber` interface (one file) and add it to `apps/worker/src/index.ts`. Needs your choice of provider (OpenAI Whisper API, Deepgram, self-hosted whisper.cpp, ...) and its API key as a worker-only secret.
- Everything from 2a (staging Supabase URL and anon key to apply migrations; Redis and S3).

## Tests run
- `pnpm typecheck`, `pnpm test` (36), `pnpm test:db` (65, including real ffmpeg audio extraction, real Postgres RLS and real Redis reconcile). Results are in the PR.
- Not tested: the browser Transcribe button end to end (the CI e2e journey was not extended), a real provider, long or multi-audio-track files.

## Known limitations
- Only the first audio stream is transcribed; no language selection or detection (`language` is null for the mock).
- Whole file is downloaded to extract audio (same as the probe step); a long video re-downloads for each job.
- No re-transcribe, delete or edit of transcripts; a failed job can be retried by clicking Transcribe again.
- Provider call has no timeout or cost cap yet, because no real provider exists.

## Next smallest milestone
2c: clip candidate scoring from transcript segments (provider adapter with a labelled mock), still without rendering.
