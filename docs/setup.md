# Local setup

## Prerequisites
Node 22, pnpm 10, Docker (for Supabase CLI and MinIO), FFmpeg (`ffprobe` on PATH, for the worker and its tests).

## Run the app
```bash
pnpm install
supabase start                      # Auth + Postgres
docker compose up -d                # Redis + MinIO (bucket clipforge-dev)
cp apps/web/.env.example apps/web/.env.local   # fill from `supabase status`; storage values below
pnpm dev                            # web on :3000
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  S3_ENDPOINT=http://127.0.0.1:9000 S3_FORCE_PATH_STYLE=true S3_BUCKET=clipforge-dev \
  S3_ACCESS_KEY_ID=minio S3_SECRET_ACCESS_KEY=minio12345 REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter worker start        # worker
```

## Tests
| Command | Needs |
|---|---|
| `pnpm test` | nothing |
| `pnpm test:db` | a throwaway Postgres superuser (`TEST_DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:54329/postgres`), `ffprobe`/`ffmpeg`; set `REDIS_URL` to include the queue tests |
| `pnpm test:s3` | an S3-compatible endpoint (`S3_ENDPOINT`, `S3_BUCKET`, keys, `REDIS_URL`); set `S3_ENFORCES_POLICY=true` for MinIO/AWS, which enforce signed-upload limits |
| `pnpm test:e2e` | smoke tests need nothing; `E2E_FULL=1` needs the whole stack (CI does this) |

## Production storage notes
- The bucket must be **private**. Browsers upload with short-lived signed forms.
- Add a CORS rule on the bucket allowing `POST` from your site origin (`NEXT_PUBLIC_SITE_URL`) and exposing no credentials.
- The worker needs a Postgres role that bypasses RLS and read access to the bucket. The web app only needs permission to put, head and sign.
