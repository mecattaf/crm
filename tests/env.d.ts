import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      // optional: only bound in the vitest miniflare environment
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}

export {};
