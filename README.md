# ClipForge AI

Multi-tenant SaaS for turning long videos into Shorts, generating branded videos, and managing client social publishing.

**Status: Milestone 2a** (accounts, workspaces, roles, invitations, row-level security, private video upload and validation). Transcription, clips, rendering, billing and publishing are not built yet. See [docs/milestone-1.md](docs/milestone-1.md) and [docs/milestone-2a.md](docs/milestone-2a.md) for what exists, what was tested, and known limits. Setup: [docs/setup.md](docs/setup.md).

## Quick start

```bash
pnpm install
supabase start                    # local Auth + Postgres (needs Docker)
docker compose up -d              # Redis + MinIO for uploads
cp apps/web/.env.example apps/web/.env.local   # fill from `supabase status`
pnpm dev                          # web; see docs/setup.md to run the worker
```

## Checks

```bash
pnpm typecheck
pnpm test                         # unit tests
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test:db   # RLS tests, needs a disposable Postgres
pnpm test:e2e                     # Playwright (smoke without Supabase; full journey with E2E_FULL=1)
```
