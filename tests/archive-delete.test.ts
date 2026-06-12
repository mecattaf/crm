import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/server/db/schema";
import { NotFoundError, ValidationError } from "../src/server/services/errors";
import { archiveRecord, createRecord, deleteRecord, getRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

describe("archive_record (soft)", () => {
  it("sets archived_at, writes an archived event, and is idempotent", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Sunset Trading" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const id = org["id"] as number;
    const later = "2026-06-13T00:00:00.000Z";

    const archived = await archiveRecord(db, { entity: "organization", id, now: later }, admin);
    expect(archived["archived_at"]).toBe(later);

    // idempotent: second archive returns the record, writes no second event
    const again = await archiveRecord(db, { entity: "organization", id, now: "2026-06-14T00:00:00.000Z" }, admin);
    expect(again["archived_at"]).toBe(later);

    const evts = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.entity, "organization"), eq(schema.events.entity_id, id)))
      .all();
    expect(evts.filter((e) => e.kind === "archived")).toHaveLength(1);

    // still reachable by id
    const fetched = await getRecord(db, { entity: "organization", id });
    expect(fetched["archived_at"]).toBe(later);
  });
});

describe("delete_record (confirm-gated)", () => {
  it("refuses without confirm: true", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Doomed SARL" }, now: NOW },
      admin,
    )) as ServiceRecord;
    await expect(
      deleteRecord(db, { entity: "organization", id: org["id"] as number, now: NOW }, admin),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteRecord(db, { entity: "organization", id: org["id"] as number, confirm: false, now: NOW }, admin),
    ).rejects.toThrow(/confirm/);
  });

  it("hard-deletes with confirm: true and keeps a deleted event", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Doomed SARL" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const id = org["id"] as number;

    const result = await deleteRecord(db, { entity: "organization", id, confirm: true, now: NOW }, admin);
    expect(result.deleted).toBe(true);
    expect(result.record["name"]).toBe("Doomed SARL");

    await expect(getRecord(db, { entity: "organization", id })).rejects.toBeInstanceOf(NotFoundError);

    const evts = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.entity, "organization"), eq(schema.events.entity_id, id)))
      .all();
    expect(evts.map((e) => e.kind)).toEqual(["created", "deleted"]);
  });
});

describe("worker smoke", () => {
  it("serves /api/health", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
