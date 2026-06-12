import { env } from "cloudflare:test";
import { createDb, type Db } from "../src/server/db";
import type { Actor } from "../src/server/services/types";

export function testDb(): Db {
  return createDb(env.DB);
}

/** Seeded admin (drizzle/migrations/0001_seed.sql). */
export const admin: Actor = { userId: 1 };

/** Deterministic clock for relative-date assertions. */
export const NOW = "2026-06-12T10:00:00.000Z";
export const TODAY = "2026-06-12";
