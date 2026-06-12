import { eq } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { eventStmt } from "./events";
import { createRecord, shapeRecord } from "./records";
import { type Ref, resolveActivity } from "./resolve";
import type { Actor, ServiceRecord } from "./types";
import { nowIso } from "./types";

/**
 * The next-activity discipline is the product's core loop — schedule and
 * complete are first-class verbs (SPEC.md).
 */
export interface ScheduleActivityInput {
  subject: string;
  type: "call" | "meeting" | "task" | "deadline" | "email" | "lunch";
  due_date: string;
  due_time?: string;
  duration_min?: number;
  priority?: "none" | "high";
  note?: string;
  /** defaults to the actor */
  assignee?: Ref;
  deal?: Ref;
  organization?: Ref;
  contact?: Ref;
  now?: string;
}

export async function scheduleActivity(
  db: Db,
  input: ScheduleActivityInput,
  actor: Actor,
): Promise<ServiceRecord> {
  const { type, now, ...rest } = input;
  const data = { ...rest, activity_type: type };
  return (await createRecord(db, { entity: "activity", data, now }, actor)) as ServiceRecord;
}

export interface CompleteActivityInput {
  /** id or subject */
  activity: Ref;
  done_note?: string;
  now?: string;
}

export async function completeActivity(
  db: Db,
  input: CompleteActivityInput,
  actor: Actor,
): Promise<ServiceRecord> {
  const now = nowIso(input.now);
  const activity = await resolveActivity(db, input.activity);
  if (activity.done) {
    throw new ValidationError(`Activity #${activity.id} is already done.`);
  }

  const note = input.done_note
    ? activity.note
      ? `${activity.note}\n${input.done_note}`
      : input.done_note
    : activity.note;

  const update = db
    .update(schema.activities)
    .set({ done: true, done_at: now, note, updated_at: now })
    .where(eq(schema.activities.id, activity.id))
    .returning();

  const results = (await db.batch([
    update,
    eventStmt(db, {
      entity: "activity",
      entityId: activity.id,
      kind: "completed",
      payload: input.done_note ? { done_note: input.done_note } : undefined,
      actor,
      now,
    }),
  ])) as unknown[];

  const row = (results[0] as Record<string, unknown>[])[0];
  if (!row) throw new Error("complete_activity update returned no row");
  return shapeRecord("activity", row);
}
