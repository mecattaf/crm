import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/server/db/schema";
import { completeActivity, scheduleActivity } from "../src/server/services/activities";
import { ValidationError } from "../src/server/services/errors";
import { logNote } from "../src/server/services/notes";
import { createRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

describe("schedule_activity / complete_activity", () => {
  it("schedules with assignee defaulting to the actor and links a deal by name", async () => {
    const db = testDb();
    await createRecord(db, { entity: "deal", data: { title: "Tokaji shipment" }, now: NOW }, admin);
    const activity = await scheduleActivity(
      db,
      { subject: "Call about Tokaji", type: "call", due_date: "2026-06-15", deal: "tokaji", now: NOW },
      admin,
    );
    expect(activity["assignee_id"]).toBe(1);
    expect(activity["deal_id"]).toBeTypeOf("number");
    expect(activity["done"]).toBe(false);

    const evts = await db
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.entity, "activity"), eq(schema.events.entity_id, activity["id"] as number)),
      )
      .all();
    expect(evts.map((e) => e.kind)).toEqual(["created"]);
  });

  it("completes an activity: done flag, done_at, appended done_note, completed event", async () => {
    const db = testDb();
    const activity = await scheduleActivity(
      db,
      {
        subject: "Send proforma",
        type: "email",
        due_date: "2026-06-12",
        note: "include accise codes",
        organization: undefined,
        now: NOW,
      },
      admin,
    );
    const later = "2026-06-12T16:00:00.000Z";
    const done = await completeActivity(
      db,
      { activity: activity["id"] as number, done_note: "sent to Jörg", now: later },
      admin,
    );
    expect(done["done"]).toBe(true);
    expect(done["done_at"]).toBe(later);
    expect(done["note"]).toBe("include accise codes\nsent to Jörg");

    const evts = await db
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.entity, "activity"), eq(schema.events.entity_id, activity["id"] as number)),
      )
      .all();
    expect(evts.map((e) => e.kind)).toContain("completed");

    await expect(
      completeActivity(db, { activity: activity["id"] as number, now: later }, admin),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("resolves activities by subject for completion", async () => {
    const db = testDb();
    await scheduleActivity(
      db,
      { subject: "Déguster les échantillons", type: "task", due_date: "2026-06-20", now: NOW },
      admin,
    );
    const done = await completeActivity(db, { activity: "deguster", now: NOW }, admin);
    expect(done["done"]).toBe(true);
  });
});

describe("log_note", () => {
  it("logs a note against an organization by name, author = actor", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Quinta do Vale" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const note = await logNote(
      db,
      { body: "Visited the estate, great Touriga.", organization: "quinta do vale", now: NOW },
      admin,
    );
    expect(note["org_id"]).toBe(org["id"]);
    expect(note["author_id"]).toBe(1);

    const evts = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.entity, "note"), eq(schema.events.entity_id, note["id"] as number)))
      .all();
    expect(evts.map((e) => e.kind)).toEqual(["created"]);
  });

  it("requires at least one link", async () => {
    const db = testDb();
    await expect(logNote(db, { body: "floating note", now: NOW }, admin)).rejects.toThrow(
      /at least one/,
    );
  });
});
