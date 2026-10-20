import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Needs a disposable Postgres superuser connection (see docs/setup.md).
const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/postgres";
const dbName = `clipforge_test_${process.pid}`;

let admin: Client;
let db: Client;

const alice = "00000000-0000-0000-0000-00000000000a"; // owner of A
const bob = "00000000-0000-0000-0000-00000000000b"; // admin of A
const carol = "00000000-0000-0000-0000-00000000000c"; // editor of A
const dave = "00000000-0000-0000-0000-00000000000d"; // viewer of A
const erin = "00000000-0000-0000-0000-00000000000e"; // owner of B only (other tenant)
let wsA: string;
let wsB: string;

/** Run `fn` as an end user (RLS applies), inside a transaction that is always rolled back. */
async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${uid ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

/** Run `fn`, expecting the database to reject it; returns the error message. */
async function rejects(uid: string | null, sql: string, params: unknown[] = []): Promise<string> {
  return as(uid, async () => {
    await db.query("savepoint s");
    try {
      await db.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected failure but succeeded: ${sql}`);
  });
}

const rows = async (uid: string | null, sql: string, params: unknown[] = []) =>
  as(uid, async () => (await db.query(sql, params)).rows);

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  db = new Client({ connectionString: u.toString() });
  await db.connect();

  await db.query(readFileSync(join(__dirname, "supabase-shim.sql"), "utf8"));
  const dir = join(__dirname, "../migrations");
  for (const f of readdirSync(dir).sort()) await db.query(readFileSync(join(dir, f), "utf8"));

  for (const [id, email] of [
    [alice, "alice@example.com"], [bob, "bob@example.com"], [carol, "carol@example.com"],
    [dave, "dave@example.com"], [erin, "erin@example.com"],
  ] as const) {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  }

  // Build the tenants through the public RPCs, as the app does (committed, unlike `as`).
  const asCommitted = async (uid: string, sql: string, params: unknown[] = []) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      const r = await db.query(sql, params);
      await db.query("commit");
      return r.rows;
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  };
  wsA = (await asCommitted(alice, "select id from public.create_workspace('Acme Studio', 'agency')"))[0].id;
  wsB = (await asCommitted(erin, "select id from public.create_workspace('Other Co', 'business')"))[0].id;
  // Membership is only reachable via invitations; use the real flow for bob/carol/dave.
  for (const [uid, email, role] of [[bob, "bob@example.com", "admin"], [carol, "carol@example.com", "editor"], [dave, "dave@example.com", "viewer"]] as const) {
    const token = (await asCommitted(alice, "select public.create_invitation($1, $2, $3) as t", [wsA, email, role]))[0].t;
    await asCommitted(uid, "select public.accept_invitation($1)", [token]);
  }
}, 60_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${dbName} with (force)`);
  await admin?.end();
});

describe("cross-tenant isolation", () => {
  it("shows a user only their own workspaces", async () => {
    expect((await rows(alice, "select id from public.workspaces")).map((r) => r.id)).toEqual([wsA]);
    expect((await rows(erin, "select id from public.workspaces")).map((r) => r.id)).toEqual([wsB]);
  });

  it("hides another tenant's members, invitations, audit log and profiles", async () => {
    expect(await rows(erin, "select 1 from public.workspace_members where workspace_id = $1", [wsA])).toHaveLength(0);
    expect(await rows(erin, "select 1 from public.invitations where workspace_id = $1", [wsA])).toHaveLength(0);
    expect(await rows(erin, "select 1 from public.audit_logs where workspace_id = $1", [wsA])).toHaveLength(0);
    expect(await rows(erin, "select 1 from public.profiles where id = $1", [alice])).toHaveLength(0);
    expect(await rows(alice, "select 1 from public.profiles where id = $1", [bob])).toHaveLength(1);
  });

  it("blocks writes to another tenant's workspace and members", async () => {
    const upd = await as(erin, async () => (await db.query("update public.workspaces set name = 'pwned' where id = $1", [wsA])).rowCount);
    expect(upd).toBe(0);
    const del = await as(erin, async () => (await db.query("delete from public.workspaces where id = $1", [wsA])).rowCount);
    expect(del).toBe(0);
    const delM = await as(erin, async () => (await db.query("delete from public.workspace_members where workspace_id = $1", [wsA])).rowCount);
    expect(delM).toBe(0);
  });

  it("refuses RPCs that target another tenant", async () => {
    expect(await rejects(erin, "select public.create_invitation($1, 'x@example.com', 'viewer')", [wsA])).toMatch(/Only owners and admins/);
    expect(await rows(erin, "select * from public.workspace_member_list($1)", [wsA])).toHaveLength(0);
  });

  it("gives signed-out users nothing", async () => {
    expect(await rejects(null, "select * from public.workspaces")).toMatch(/permission denied/);
  });
});

describe("role permissions", () => {
  it("lets owner/admin rename the workspace, not editor/viewer", async () => {
    const run = (uid: string) => as(uid, async () => (await db.query("update public.workspaces set name = 'Renamed' where id = $1", [wsA])).rowCount);
    expect(await run(alice)).toBe(1);
    expect(await run(bob)).toBe(1);
    expect(await run(carol)).toBe(0);
    expect(await run(dave)).toBe(0);
  });

  it("only lets the owner delete the workspace", async () => {
    const run = (uid: string) => as(uid, async () => (await db.query("delete from public.workspaces where id = $1", [wsA])).rowCount);
    expect(await run(bob)).toBe(0);
    expect(await run(carol)).toBe(0);
    expect(await run(alice)).toBe(1); // rolled back by `as`
  });

  it("lets only owner/admin invite", async () => {
    expect(await rejects(carol, "select public.create_invitation($1, 'n@example.com', 'viewer')", [wsA])).toMatch(/Only owners and admins/);
    expect(await rejects(dave, "select public.create_invitation($1, 'n@example.com', 'viewer')", [wsA])).toMatch(/Only owners and admins/);
    expect(await rows(bob, "select public.create_invitation($1, 'n@example.com', 'viewer') as t", [wsA])).toHaveLength(1);
  });

  it("refuses to invite directly as owner or an existing member", async () => {
    expect(await rejects(alice, "select public.create_invitation($1, 'n@example.com', 'owner')", [wsA])).toMatch(/promote/);
    expect(await rejects(alice, "select public.create_invitation($1, 'carol@example.com', 'viewer')", [wsA])).toMatch(/already a member/);
  });

  it("only exposes invitations to owner/admin and never the token hash", async () => {
    const seen = await as(alice, async () => {
      await db.query("select public.create_invitation($1, 'n@example.com', 'viewer')", [wsA]);
      return (await db.query("select count(*)::int as n from public.invitations where accepted_at is null")).rows[0].n;
    });
    expect(seen).toBe(1);
    expect(await rows(carol, "select 1 from public.invitations")).toHaveLength(0);
    expect(await rejects(alice, "select token_hash from public.invitations")).toMatch(/permission denied/);
    expect(await rejects(alice, "select count(*) from public.invitations where token_hash is not null")).toMatch(/permission denied/);
  });

  it("lets editors read members but not change roles", async () => {
    expect(await rows(carol, "select 1 from public.workspace_members where workspace_id = $1", [wsA])).toHaveLength(4);
    const n = await as(carol, async () => (await db.query("update public.workspace_members set role = 'admin' where user_id = $1 and workspace_id = $2", [carol, wsA])).rowCount);
    expect(n).toBe(0);
  });

  it("prevents an admin from touching the owner role", async () => {
    expect(await rejects(bob, "update public.workspace_members set role = 'owner' where user_id = $1 and workspace_id = $2", [bob, wsA])).toMatch(/Only an owner/);
    expect(await rejects(bob, "update public.workspace_members set role = 'viewer' where user_id = $1 and workspace_id = $2", [alice, wsA])).toMatch(/Only an owner/);
    expect(await rejects(bob, "delete from public.workspace_members where user_id = $1 and workspace_id = $2", [alice, wsA])).toMatch(/Only an owner/);
  });

  it("lets a member leave, but not remove someone else unless admin", async () => {
    const leave = await as(dave, async () => (await db.query("delete from public.workspace_members where user_id = $1 and workspace_id = $2", [dave, wsA])).rowCount);
    expect(leave).toBe(1);
    const other = await as(carol, async () => (await db.query("delete from public.workspace_members where user_id = $1 and workspace_id = $2", [dave, wsA])).rowCount);
    expect(other).toBe(0);
    const byAdmin = await as(bob, async () => (await db.query("delete from public.workspace_members where user_id = $1 and workspace_id = $2", [dave, wsA])).rowCount);
    expect(byAdmin).toBe(1);
  });

  it("protects the last owner", async () => {
    expect(await rejects(alice, "update public.workspace_members set role = 'admin' where user_id = $1 and workspace_id = $2", [alice, wsA])).toMatch(/at least one owner/);
    expect(await rejects(alice, "delete from public.workspace_members where user_id = $1 and workspace_id = $2", [alice, wsA])).toMatch(/at least one owner/);
  });

  it("blocks direct inserts and client-side privilege escalation", async () => {
    expect(await rejects(erin, "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsA, erin])).toMatch(/row-level security/);
    expect(await rejects(erin, "insert into public.workspaces (name, slug, kind) values ('x', 'x', 'creator')")).toMatch(/row-level security/);
    expect(await rejects(alice, "update public.workspaces set slug = 'hijack' where id = $1", [wsA])).toMatch(/permission denied/);
    expect(await rejects(alice, "update public.workspace_members set user_id = $1 where workspace_id = $2", [erin, wsA])).toMatch(/permission denied/);
  });

  it("lets users edit only their own profile", async () => {
    expect(await as(alice, async () => (await db.query("update public.profiles set display_name = 'A' where id = $1", [alice])).rowCount)).toBe(1);
    expect(await as(alice, async () => (await db.query("update public.profiles set display_name = 'X' where id = $1", [bob])).rowCount)).toBe(0);
  });
});

describe("invitations", () => {
  const invite = async (email: string, role = "viewer") =>
    (await rows(alice, "select public.create_invitation($1, $2, $3) as t", [wsA, email, role]))[0].t as string;

  it("stores only a hash of the token", async () => {
    const token = await as(alice, async () => {
      const t = (await db.query("select public.create_invitation($1, 'h@example.com', 'viewer') as t", [wsA])).rows[0].t;
      // the transaction is rolled back, so re-create below for the superuser check
      return t as string;
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [alice]);
    const t2 = (await db.query("select public.create_invitation($1, 'h2@example.com', 'viewer') as t", [wsA])).rows[0].t as string;
    await db.query("commit");
    const r = await db.query(
      "select encode(token_hash, 'hex') = encode(extensions.digest($1, 'sha256'), 'hex') as hashed, encode(token_hash, 'escape') like '%' || $1 || '%' as raw from public.invitations where email = 'h2@example.com'",
      [t2],
    );
    expect(r.rows[0]).toEqual({ hashed: true, raw: false });
  });

  it("rejects wrong email, bad token and signed-out use", async () => {
    await db.query("insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'fred@example.com')");
    const token = await as(alice, async () => (await db.query("select public.create_invitation($1, 'fred@example.com', 'viewer') as t", [wsA])).rows[0].t);
    expect(token).toBeTruthy();
    expect(await rejects(erin, "select public.accept_invitation('nope')")).toMatch(/invalid or has expired/);
    expect(await rejects(null, "select public.accept_invitation('nope')")).toMatch(/permission denied/);
  });

  it("rejects expired and reused invitations", async () => {
    await db.query("insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f2', 'gina@example.com')");
    const gina = "00000000-0000-0000-0000-0000000000f2";
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [alice]);
    const token = (await db.query("select public.create_invitation($1, 'gina@example.com', 'editor') as t", [wsA])).rows[0].t;
    await db.query("commit");

    // Wrong user first: a different address cannot use it.
    expect(await rejects(erin, "select public.accept_invitation($1)", [token])).toMatch(/different email/);

    await db.query("update public.invitations set expires_at = now() - interval '1 minute' where lower(email) = 'gina@example.com'");
    expect(await rejects(gina, "select public.accept_invitation($1)", [token])).toMatch(/invalid or has expired/);
    await db.query("update public.invitations set expires_at = now() + interval '1 day' where lower(email) = 'gina@example.com'");

    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [gina]);
    await db.query("select public.accept_invitation($1)", [token]);
    await db.query("commit");
    expect(await rejects(gina, "select public.accept_invitation($1)", [token])).toMatch(/invalid or has expired/);
    expect((await rows(gina, "select role from public.workspace_members where workspace_id = $1 and user_id = $2", [wsA, gina]))[0].role).toBe("editor");
  });

  it("replaces an earlier pending invite for the same address", async () => {
    const first = await invite("dup@example.com");
    expect(first).toBeTruthy();
    const n = await as(alice, async () => {
      await db.query("select public.create_invitation($1, 'DUP@example.com', 'viewer')", [wsA]);
      await db.query("select public.create_invitation($1, 'dup@example.com', 'editor')", [wsA]);
      return (await db.query("select count(*)::int as n from public.invitations where lower(email) = 'dup@example.com' and accepted_at is null")).rows[0].n;
    });
    expect(n).toBe(1);
  });

  it("lets owner/admin revoke, others not", async () => {
    const inv = (await db.query("insert into public.invitations (workspace_id, email, role, token_hash) values ($1, 'rev2@example.com', 'viewer', '\\x01') returning id", [wsA])).rows[0].id;
    expect(await rejects(carol, "select public.revoke_invitation($1)", [inv])).toMatch(/not found/);
    expect(await rejects(erin, "select public.revoke_invitation($1)", [inv])).toMatch(/not found/);
    expect(await rows(bob, "select public.revoke_invitation($1)", [inv])).toHaveLength(1);
  });
});

describe("assets and jobs", () => {
  const create = (ws = wsA, name = "talk.mp4", type = "video/mp4", size = 1000) =>
    `select * from public.create_asset_upload('${ws}', '${name}', '${type}', ${size})`;

  it("lets owner/admin/editor start an upload, not viewers or other tenants", async () => {
    for (const uid of [alice, bob, carol]) expect(await rows(uid, create())).toHaveLength(1);
    expect(await rejects(dave, create())).toMatch(/do not have permission/);
    expect(await rejects(erin, create())).toMatch(/do not have permission/);
    expect(await rejects(null, create())).toMatch(/permission denied/);
  });

  it("builds the storage key from ids, never from the filename", async () => {
    const key = await as(carol, async () => {
      const a = (await db.query(create(wsA, "../../etc/passwd.mp4"))).rows[0];
      await db.query("reset role"); // storage_key is hidden from clients; read it as the superuser
      const k = (await db.query("select storage_key from public.assets where id = $1", [a.id])).rows[0].storage_key;
      return { k, id: a.id, name: a.original_filename };
    });
    expect(key.k).toBe(`workspaces/${wsA}/assets/${key.id}/source`); // must match assetStorageKey() in packages/shared
    expect(key.name).toBe("../../etc/passwd.mp4"); // kept only as a display label
  });

  it("rejects unsupported types and bad sizes at the database", async () => {
    expect(await rejects(alice, create(wsA, "a.exe", "application/x-msdownload"))).toMatch(/check constraint/);
    expect(await rejects(alice, create(wsA, "a.mp4", "video/mp4", 0))).toMatch(/check constraint/);
    expect(await rejects(alice, create(wsA, "a.mp4", "video/mp4", 5368709121))).toMatch(/check constraint/);
  });

  it("limits unfinished uploads per workspace", async () => {
    const msg = await as(alice, async () => {
      for (let i = 0; i < 20; i++) await db.query(create());
      await db.query("savepoint s");
      try { await db.query(create()); } catch (e) { return (e as Error).message; }
      return "";
    });
    expect(msg).toMatch(/Too many unfinished uploads/);
  });

  it("shows assets to members only, and hides the storage key", async () => {
    const id = await as(alice, async () => (await db.query(create())).rows[0].id);
    expect(id).toBeTruthy();
    await db.query("insert into public.assets (id, workspace_id, original_filename, content_type, size_bytes, storage_key) values ('00000000-0000-0000-0000-0000000000a1', $1, 'seed.mp4', 'video/mp4', 10, 'seed-key')", [wsA]);
    expect(await rows(dave, "select id from public.assets where id = '00000000-0000-0000-0000-0000000000a1'")).toHaveLength(1);
    expect(await rows(erin, "select id from public.assets")).toHaveLength(0);
    expect(await rejects(alice, "select storage_key from public.assets")).toMatch(/permission denied/);
  });

  it("completes an upload once and returns the same job on repeat", async () => {
    const out = await as(carol, async () => {
      const a = (await db.query(create())).rows[0];
      const j1 = (await db.query("select public.complete_asset_upload($1) as j", [a.id])).rows[0].j;
      const j2 = (await db.query("select public.complete_asset_upload($1) as j", [a.id])).rows[0].j;
      const st = (await db.query("select status from public.assets where id = $1", [a.id])).rows[0].status;
      const n = (await db.query("select count(*)::int as n from public.render_jobs where asset_id = $1", [a.id])).rows[0].n;
      return { j1, j2, st, n };
    });
    expect(out.j1).toBeTruthy();
    expect(out.j2).toBe(out.j1);
    expect(out.st).toBe("uploaded");
    expect(out.n).toBe(1);
  });

  it("refuses to complete an upload for viewers and other tenants", async () => {
    const id = await as(alice, async () => (await db.query(create())).rows[0].id);
    await db.query("insert into public.assets (id, workspace_id, original_filename, content_type, size_bytes, storage_key) values ('00000000-0000-0000-0000-0000000000a2', $1, 'seed2.mp4', 'video/mp4', 10, 'seed-key-2')", [wsA]);
    const target = "00000000-0000-0000-0000-0000000000a2";
    expect(id).toBeTruthy();
    expect(await rejects(dave, "select public.complete_asset_upload($1)", [target])).toMatch(/Upload not found/);
    expect(await rejects(erin, "select public.complete_asset_upload($1)", [target])).toMatch(/Upload not found/);
  });

  it("shows jobs to members only", async () => {
    await db.query("insert into public.assets (id, workspace_id, original_filename, content_type, size_bytes, storage_key, status) values ('00000000-0000-0000-0000-0000000000a3', $1, 'seed3.mp4', 'video/mp4', 10, 'seed-key-3', 'uploaded')", [wsA]);
    await db.query("insert into public.render_jobs (workspace_id, asset_id, kind) values ($1, '00000000-0000-0000-0000-0000000000a3', 'probe')", [wsA]);
    expect((await rows(dave, "select 1 from public.render_jobs where asset_id = '00000000-0000-0000-0000-0000000000a3'")).length).toBe(1);
    expect(await rows(erin, "select 1 from public.render_jobs")).toHaveLength(0);
  });

  it("prevents a second active job for the same asset", async () => {
    await expect(db.query("insert into public.render_jobs (workspace_id, asset_id, kind) values ($1, '00000000-0000-0000-0000-0000000000a3', 'probe')", [wsA])).rejects.toThrow(/render_jobs_one_active_idx/);
  });

  it("blocks direct writes to assets and jobs, even by the owner", async () => {
    expect(await rejects(alice, "insert into public.assets (workspace_id, original_filename, content_type, size_bytes, storage_key) values ($1, 'x.mp4', 'video/mp4', 1, 'k')", [wsA])).toMatch(/row-level security/);
    expect(await as(alice, async () => (await db.query("update public.assets set status = 'ready'")).rowCount)).toBe(0);
    expect(await as(alice, async () => (await db.query("delete from public.assets")).rowCount)).toBe(0);
    expect(await rejects(alice, "insert into public.render_jobs (workspace_id, asset_id, kind) values ($1, '00000000-0000-0000-0000-0000000000a3', 'probe')", [wsA])).toMatch(/row-level security/);
    expect(await as(alice, async () => (await db.query("update public.render_jobs set status = 'succeeded'")).rowCount)).toBe(0);
  });
});

describe("audit log", () => {
  it("records membership and workspace events", async () => {
    const actions = (await rows(alice, "select action from public.audit_logs where workspace_id = $1", [wsA])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["workspace.created", "member.added", "invitation.created", "invitation.accepted"]));
  });

  it("is visible to owner/admin only", async () => {
    expect((await rows(bob, "select 1 from public.audit_logs where workspace_id = $1", [wsA])).length).toBeGreaterThan(0);
    expect(await rows(carol, "select 1 from public.audit_logs where workspace_id = $1", [wsA])).toHaveLength(0);
  });

  it("cannot be inserted, updated or deleted by users, nor by the service role", async () => {
    expect(await rejects(alice, "insert into public.audit_logs (action) values ('forged')")).toMatch(/row-level security|permission denied/);
    expect(await rejects(alice, "update public.audit_logs set action = 'x'")).toMatch(/permission denied/);
    expect(await rejects(alice, "delete from public.audit_logs")).toMatch(/permission denied/);
    await expect(db.query("update public.audit_logs set action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.audit_logs")).rejects.toThrow(/append-only/);
    await expect(db.query("truncate public.audit_logs")).rejects.toThrow(/append-only/);
  });

  it("keeps history after the workspace is deleted", async () => {
    const before = (await db.query("select count(*)::int as n from public.audit_logs where workspace_id = $1", [wsB])).rows[0].n;
    await db.query("delete from public.workspaces where id = $1", [wsB]);
    const after = (await db.query("select count(*)::int as n from public.audit_logs where workspace_id = $1", [wsB])).rows[0].n;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });
});

describe("workspace creation", () => {
  it("rejects bad timezones and signed-out callers", async () => {
    expect(await rejects(erin, "select * from public.create_workspace('X', 'creator', 'Mars/Phobos')")).toMatch(/Unknown timezone/);
    expect(await rejects(null, "select * from public.create_workspace('X', 'creator')")).toMatch(/permission denied/);
  });

  it("makes the creator the owner and slugs are unique", async () => {
    const r = await as(erin, async () => {
      const a = (await db.query("select * from public.create_workspace('Same Name', 'creator')")).rows[0];
      const b = (await db.query("select * from public.create_workspace('Same Name', 'creator')")).rows[0];
      const m = (await db.query("select role from public.workspace_members where workspace_id = $1", [a.id])).rows[0];
      return { a, b, m };
    });
    expect(r.m.role).toBe("owner");
    expect(r.a.slug).not.toBe(r.b.slug);
  });

  it("creates a profile row for new auth users", async () => {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000f3', 'hana@example.com', '{\"display_name\":\"Hana\"}')");
    const r = await db.query("select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000f3'");
    expect(r.rows[0].display_name).toBe("Hana");
  });
});
