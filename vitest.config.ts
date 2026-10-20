import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/web/lib/**/*.test.ts", "apps/worker/src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.db.test.ts"],
        },
      },
      // Need a disposable Postgres (and ffprobe for the worker); see docs/setup.md.
      {
        test: {
          name: "db",
          include: ["supabase/tests/**/*.test.ts", "apps/worker/src/**/*.db.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      // Real S3-compatible store. `server-only` is stubbed because it throws outside Next's server bundle.
      {
        resolve: { alias: { "server-only": new URL("./tests/integration/server-only-stub.ts", import.meta.url).pathname } },
        test: { name: "s3", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000 },
      },
    ],
  },
});
