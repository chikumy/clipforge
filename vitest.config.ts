import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/**/*.test.ts", "apps/web/lib/**/*.test.ts"] } },
      // Needs a disposable Postgres; see docs/setup.md.
      { test: { name: "db", include: ["supabase/tests/**/*.test.ts"], fileParallelism: false } },
    ],
  },
});
