import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Applies all D1 migrations (schema + seed) to this test file's database.
// TEST_MIGRATIONS is provided by vitest.config.ts via readD1Migrations().
// Each test FILE gets its own isolated Worker + D1; within a file, storage
// persists across tests, so beforeEach resets entity tables back to the
// seeded state (pipelines/stages/fx_rates/admin user are kept).
if (!env.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding missing — check vitest.config.ts");
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  // children before parents (FKs); autoincrement counters reset for determinism
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare("DELETE FROM deals"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM organizations"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users WHERE id <> 1"),
    env.DB.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('events','notes','activities','deals','contacts','organizations')",
    ),
  ]);
});
