import { sql } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import type { Actor, EntityName } from "./types";

/**
 * Every mutation writes an `events` row in the SAME `db.batch()` as the data
 * write (D1 has no interactive transactions; a batch is the atomic unit).
 */
export interface EventInput {
  entity: EntityName;
  /** omit to bind last_insert_rowid() — MUST directly follow the INSERT it logs */
  entityId?: number;
  kind: string;
  payload?: unknown;
  actor: Actor;
  now: string;
}

export function eventStmt(db: Db, input: EventInput) {
  return db.insert(schema.events).values({
    entity: input.entity,
    entity_id:
      input.entityId !== undefined
        ? input.entityId
        : (sql`last_insert_rowid()` as unknown as number),
    kind: input.kind,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    actor_user_id: input.actor.userId,
    created_at: input.now,
  });
}
