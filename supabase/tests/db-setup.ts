import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

// Needs a disposable Postgres superuser connection (see docs/setup.md).
const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/postgres";

/** Creates a throwaway database with the auth shim and all migrations applied. */
export async function createTestDb(tag: string) {
  const name = `clipforge_${tag}_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const db = new pg.Pool({ connectionString: u.toString() });
  await db.query(readFileSync(join(__dirname, "supabase-shim.sql"), "utf8"));
  const dir = join(__dirname, "../migrations");
  for (const f of readdirSync(dir).sort()) await db.query(readFileSync(join(dir, f), "utf8"));
  return {
    db,
    async drop() {
      await db.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
