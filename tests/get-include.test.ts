import { describe, expect, it } from "vitest";
import { completeActivity, scheduleActivity } from "../src/server/services/activities";
import { moveDeal } from "../src/server/services/deals";
import { ValidationError } from "../src/server/services/errors";
import { logNote } from "../src/server/services/notes";
import { createRecord, getRecord, type TimelineItem } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

describe("get_record include assembly", () => {
  it("assembles contacts, deals, activities, notes and timeline for an organization in one call", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Helvetia Vins SA" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const orgId = org["id"] as number;

    await createRecord(
      db,
      {
        entity: "contact",
        data: [
          { first_name: "Anna", last_name: "Keller", organization: orgId },
          { first_name: "Luc", last_name: "Favre", organization: orgId },
        ],
        now: NOW,
      },
      admin,
    );
    await createRecord(
      db,
      { entity: "deal", data: { title: "CH retail order", organization: orgId, value: 4000 }, now: NOW },
      admin,
    );
    await scheduleActivity(
      db,
      { subject: "Plan tasting", type: "meeting", due_date: "2026-06-20", organization: orgId, now: NOW },
      admin,
    );
    await logNote(db, { body: "Prefers CHF invoicing", organization: orgId, now: "2026-06-12T11:00:00.000Z" }, admin);

    const full = await getRecord(db, {
      entity: "organization",
      id: orgId,
      include: ["contacts", "deals", "activities", "notes", "timeline"],
    });

    expect((full["contacts"] as ServiceRecord[]).map((c) => c["last_name"]).sort()).toEqual([
      "Favre",
      "Keller",
    ]);
    expect((full["deals"] as ServiceRecord[]).map((d) => d["title"])).toEqual(["CH retail order"]);
    expect((full["deals"] as ServiceRecord[])[0]!["value"]).toBe(4000);
    expect(full["activities"] as ServiceRecord[]).toHaveLength(1);
    expect(full["notes"] as ServiceRecord[]).toHaveLength(1);

    const timeline = full["timeline"] as TimelineItem[];
    // created event + note + activity, merged and time-ordered
    expect(timeline).toHaveLength(3);
    expect(timeline.some((t) => t.type === "event" && t.data["kind"] === "created")).toBe(true);
    expect(timeline.some((t) => t.type === "note")).toBe(true);
    expect(timeline.some((t) => t.type === "activity")).toBe(true);
    const ats = timeline.map((t) => t.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it("assembles a deal timeline with stage_changed, completed activity and note", async () => {
    const db = testDb();
    const deal = (await createRecord(
      db,
      { entity: "deal", data: { title: "Armagnac lot 7" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const dealId = deal["id"] as number;

    await moveDeal(db, { deal: dealId, stage: "Proforma Sent", now: "2026-06-12T12:00:00.000Z" }, admin);
    const act = await scheduleActivity(
      db,
      { subject: "Chase payment", type: "task", due_date: "2026-06-14", deal: dealId, now: "2026-06-12T13:00:00.000Z" },
      admin,
    );
    await completeActivity(db, { activity: act["id"] as number, now: "2026-06-12T14:00:00.000Z" }, admin);
    await logNote(db, { body: "Client confirmed by phone", deal: dealId, now: "2026-06-12T15:00:00.000Z" }, admin);

    const full = await getRecord(db, { entity: "deal", id: dealId, include: ["timeline", "activities", "notes"] });
    const timeline = full["timeline"] as TimelineItem[];
    const eventKinds = timeline.filter((t) => t.type === "event").map((t) => t.data["kind"]);
    expect(eventKinds).toEqual(["created", "stage_changed"]);
    expect(timeline.filter((t) => t.type === "activity")).toHaveLength(1);
    expect(timeline.filter((t) => t.type === "note")).toHaveLength(1);
    const ats = timeline.map((t) => t.at);
    expect([...ats].sort()).toEqual(ats);

    expect((full["activities"] as ServiceRecord[])[0]!["done"]).toBe(true);
    expect((full["notes"] as ServiceRecord[])[0]!["body"]).toBe("Client confirmed by phone");
  });

  it("resolves get_record by name and rejects invalid includes", async () => {
    const db = testDb();
    await createRecord(db, { entity: "deal", data: { title: "Côtes du Rhône promo" }, now: NOW }, admin);
    const byName = await getRecord(db, { entity: "deal", id: "cotes du rhone" });
    expect(byName["title"]).toBe("Côtes du Rhône promo");

    await expect(
      getRecord(db, { entity: "deal", id: byName["id"] as number, include: ["contacts"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
