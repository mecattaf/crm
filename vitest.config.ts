import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Read all D1 migrations (schema + seed) so tests/setup.ts can apply
      // them to the isolated per-test D1 database.
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "drizzle", "migrations"),
      );
      return {
        main: "./src/server/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
