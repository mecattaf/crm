import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/server/db/schema";
import { moveDeal } from "../src/server/services/deals";
import { AmbiguousError, NotFoundError, ValidationError } from "../src/server/services/errors";
import { createRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

const LATER = "2026-06-13T09:30:00.000Z";

async function makeDeal(db: ReturnType<typeof testDb>) {
  return (await createRecord(
    db,
    { entity: "deal", data: { title: "Geneva order", value: 900 }, now: NOW },
    admin,
  )) as ServiceRecord;
}

async function dealEvents(db: ReturnType<typeof testDb>, id: number) {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.entity, "deal"), eq(schema.events.entity_id, id)))
    .all();
}

describe("move_deal", () => {
  it("moves by stage name within the deal's pipeline, updating stage_changed_at and logging an event", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    expect(deal["stage_id"]).toBe(1);

    const moved = await moveDeal(db, { deal: deal["id"] as number, stage: "payment", now: LATER }, admin);
    expect(moved["stage_id"]).toBe(4);
    expect(moved["stage_changed_at"]).toBe(LATER);

    const evts = await dealEvents(db, deal["id"] as number);
    const sc = evts.find((e) => e.kind === "stage_changed");
    expect(sc).toBeDefined();
    expect(JSON.parse(sc!.payload!)).toEqual({
      from_stage_id: 1,
      from_stage: "Order received",
      to_stage_id: 4,
      to_stage: "Payment",
    });
  });

  it("resolves the deal itself by title", async () => {
    const db = testDb();
    await makeDeal(db);
    const moved = await moveDeal(db, { deal: "geneva", stage: "Proforma Sent", now: LATER }, admin);
    expect(moved["stage_id"]).toBe(2);
  });

  it("refuses stages from another pipeline and reports ambiguity", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    await expect(
      moveDeal(db, { deal: deal["id"] as number, stage: "Qualification", now: LATER }, admin),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      moveDeal(db, { deal: deal["id"] as number, stage: "proforma", now: LATER }, admin),
    ).rejects.toBeInstanceOf(AmbiguousError);
  });

  it("moves across pipelines when pipeline is given", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    const moved = await moveDeal(
      db,
      { deal: deal["id"] as number, pipeline: "new leads", stage: "qualification", now: LATER },
      admin,
    );
    expect(moved["pipeline_id"]).toBe(2);
    expect(moved["stage_id"]).toBe(7);
  });

  it("marks won: sets won_at, clears lost fields, writes won event", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    const won = await moveDeal(db, { deal: deal["id"] as number, status: "won", now: LATER }, admin);
    expect(won["status"]).toBe("won");
    expect(won["won_at"]).toBe(LATER);
    expect(won["lost_at"]).toBeNull();
    const evts = await dealEvents(db, deal["id"] as number);
    expect(evts.some((e) => e.kind === "won")).toBe(true);
  });

  it("marks lost with reason, then reopen clears everything", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    const lost = await moveDeal(
      db,
      { deal: deal["id"] as number, status: "lost", lost_reason: "price too high", now: LATER },
      admin,
    );
    expect(lost["status"]).toBe("lost");
    expect(lost["lost_at"]).toBe(LATER);
    expect(lost["lost_reason"]).toBe("price too high");
    const evts = await dealEvents(db, deal["id"] as number);
    const lostEvt = evts.find((e) => e.kind === "lost");
    expect(JSON.parse(lostEvt!.payload!)).toEqual({ lost_reason: "price too high" });

    const reopened = await moveDeal(
      db,
      { deal: deal["id"] as number, status: "open", now: "2026-06-14T00:00:00.000Z" },
      admin,
    );
    expect(reopened["status"]).toBe("open");
    expect(reopened["lost_at"]).toBeNull();
    expect(reopened["lost_reason"]).toBeNull();
    expect((await dealEvents(db, deal["id"] as number)).some((e) => e.kind === "reopened")).toBe(true);
  });

  it("can change stage and status in one call (two events, one batch)", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    const moved = await moveDeal(
      db,
      { deal: deal["id"] as number, stage: "Waiting for delivery", status: "won", now: LATER },
      admin,
    );
    expect(moved["stage_id"]).toBe(5);
    expect(moved["status"]).toBe("won");
    const kinds = (await dealEvents(db, deal["id"] as number)).map((e) => e.kind);
    expect(kinds).toContain("stage_changed");
    expect(kinds).toContain("won");
  });

  it("validates inputs", async () => {
    const db = testDb();
    const deal = await makeDeal(db);
    await expect(moveDeal(db, { deal: deal["id"] as number, now: NOW }, admin)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      moveDeal(
        db,
        { deal: deal["id"] as number, status: "won", lost_reason: "nope", now: NOW },
        admin,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
