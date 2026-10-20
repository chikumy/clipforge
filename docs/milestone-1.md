# Milestone 1: accounts, workspaces, security

## What exists
- Email/password sign-up, sign-in, sign-out, password recovery (Supabase Auth, cookie sessions, `proxy.ts` gate).
- Workspaces (creator / business / agency), five roles, members page, invitations by link, onboarding.
- Migration `supabase/migrations/20261019000001_workspaces.sql`: `profiles`, `workspaces`, `workspace_members`, `invitations`, `audit_logs`.
- RLS on all five tables with explicit select/insert/update/delete policies. Writes that must be atomic or privileged go through `security definer` functions (`create_workspace`, `create_invitation`, `accept_invitation`, `revoke_invitation`).
- Invitation tokens: 32 random bytes, only a SHA-256 hash stored, single use, 7 days, bound to the invited email.
- Audit log is append-only for every role including the service role (triggers reject update/delete/truncate) and survives workspace deletion.
- Last owner cannot leave or be demoted; only owners can create, change or remove owners.

## Tests actually run (authoring session)
| Suite | Result |
|---|---|
| `pnpm test:db` (28 RLS/permission tests, Postgres 16 + auth shim) | 28 passed |
| `pnpm test` (unit: permissions, schemas, env, redirect safety) | 14 passed |
| `pnpm typecheck` | clean |
| `pnpm build` | succeeds |
| `pnpm test:e2e` smoke (5 tests, no Supabase) | 5 passed |
| Full user journey e2e (sign up, workspace, invite, accept, access limits) | passed in CI job `e2e-journey` against a real local Supabase stack (commit 2252b82) |

## Not verified
- The migration has been applied by CI to a local Supabase stack (`supabase start`), but not yet to a hosted staging project.
- Email delivery: none configured. Invitations are shared as links; auth emails use Supabase's built-in sender, which is rate-limited and for development only.

## Configuration still required
Supabase project (URL, anon key) for staging; SMTP provider before inviting real users; `NEXT_PUBLIC_SITE_URL` per environment. Add the production redirect URL `…/auth/callback` in Supabase Auth settings.

## Known limitations / deliberate deferrals
- UI uses plain accessible HTML and Tailwind; no component library yet (spec asks for one, add when forms get complex).
- No dark/light toggle; the theme follows the OS setting.
- No generated DB types (`supabase gen types`); one hand-typed cast in the members page.
- No Redis rate limiting on our own routes yet (Supabase Auth's built-in limits apply). Needed before public launch.
- No workspace rename/timezone edit UI; account deletion and retention workflow start in Milestone 2 when media exists.
- Social login, MFA and SSO not included.
- Error monitoring and structured logging not wired up yet.

## Security notes
Service-role key is not used by the web app. `getUser()` (server-validated) is used in the proxy, not `getSession()`. `next` redirects are restricted to same-site paths. Login errors are generic. Security headers set in `next.config.ts` (CSP not yet).

## Next smallest milestone
2a: private upload of one video to S3-compatible storage with signed URLs, FFprobe validation in a worker, and a `render_jobs` row showing progress.
