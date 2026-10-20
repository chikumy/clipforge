# ClipForge AI

Multi-tenant SaaS for turning long videos into Shorts, generating branded videos, and managing client social publishing.

**Status: Milestone 1** (accounts, workspaces, roles, invitations, row-level security). Video, billing and publishing features are not built yet. See [docs/milestone-1.md](docs/milestone-1.md) for what exists, what was tested, and known limits.

## Quick start

```bash
pnpm install
supabase start                    # local Auth + Postgres (needs Docker)
cp apps/web/.env.example apps/web/.env.local   # fill from `supabase status`
pnpm dev
```

## Checks

```bash
pnpm typecheck
pnpm test                         # unit tests
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test:db   # RLS tests, needs a disposable Postgres
pnpm test:e2e                     # Playwright (smoke without Supabase; full journey with E2E_FULL=1)
```
