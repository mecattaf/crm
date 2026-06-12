import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/server/db/schema";
import { ValidationError } from "../src/server/services/errors";
import { createRecord, getRecord, updateRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

async function eventsFor(db: ReturnType<typeof testDb>, entity: string, entityId: number) {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.entity, entity), eq(schema.events.entity_id, entityId)))
    .all();
}

describe("create + get round-trips", () => {
  it("creates an organization, returns the full record without *_norm, writes a created event", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      {
        entity: "organization",
        data: { name: "Domaine Léon", client_code: "SOD-042", owner: "admin@sodimo.eu" },
        now: NOW,
      },
      admin,
    )) as ServiceRecord;
    expect(org["id"]).toBeTypeOf("number");
    expect(org["name"]).toBe("Domaine Léon");
    expect(org["owner_id"]).toBe(1);
    expect(org["created_at"]).toBe(NOW);
    expect("name_norm" in org).toBe(false);

    const fetched = await getRecord(db, { entity: "organization", id: org["id"] as number });
    expect(fetched["name"]).toBe("Domaine Léon");

    const evts = await eventsFor(db, "organization", org["id"] as number);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.kind).toBe("created");
    expect(evts[0]!.actor_user_id).toBe(1);
  });

  it("creates a contact resolving organization by name", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Vins Müller GmbH" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const contact = (await createRecord(
      db,
      {
        entity: "contact",
        data: { first_name: "Jörg", last_name: "Müller", organization: "vins muller" },
        now: NOW,
      },
      admin,
    )) as ServiceRecord;
    expect(contact["org_id"]).toBe(org["id"]);
  });

  it("creates a deal with defaults: first pipeline, first stage, EUR, value cents", async () => {
    const db = testDb();
    const deal = (await createRecord(
      db,
      { entity: "deal", data: { title: "Bordeaux Q3", value: 1234.56 }, now: NOW },
      admin,
    )) as ServiceRecord;
    expect(deal["pipeline_id"]).toBe(1);
    expect(deal["stage_id"]).toBe(1); // Order received
    expect(deal["currency"]).toBe("EUR");
    expect(deal["status"]).toBe("open");
    expect(deal["value"]).toBe(1234.56);
    expect("value_cents" in deal).toBe(false);
    expect(deal["stage_changed_at"]).toBe(NOW);

    const raw = await db.select().from(schema.deals)
      .where(eq(schema.deals.id, deal["id"] as number)).get();
    expect(raw!.value_cents).toBe(123456);
  });

  it("creates a deal resolving pipeline and stage by name", async () => {
    const db = testDb();
    const deal = (await createRecord(
      db,
      {
        entity: "deal",
        data: { title: "Swiss lead", pipeline: "new leads", stage: "negotiation", currency: "CHF" },
        now: NOW,
      },
      admin,
    )) as ServiceRecord;
    expect(deal["pipeline_id"]).toBe(2);
    expect(deal["stage_id"]).toBe(10);
  });

  it("rejects unknown fields with a validation error", async () => {
    const db = testDb();
    await expect(
      createRecord(
        db,
        { entity: "organization", data: { name: "X", bogus_field: 1 }, now: NOW },
        admin,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires a link on note creation", async () => {
    const db = testDb();
    await expect(
      createRecord(db, { entity: "note", data: { body: "orphan" }, now: NOW }, admin),
    ).rejects.toThrow(/at least one/);
  });
});

describe("batch create", () => {
  it("creates a heterogeneous batch and one event per record", async () => {
    const db = testDb();
    const orgs = (await createRecord(
      db,
      {
        entity: "organization",
        data: [
          { name: "Alpha SA" },
          { name: "Beta SARL", category: "importer" },
          { name: "Gamma AG", org_type: "distributor" },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    expect(orgs).toHaveLength(3);
    expect(orgs.map((o) => o["name"])).toEqual(["Alpha SA", "Beta SARL", "Gamma AG"]);

    for (const org of orgs) {
      const evts = await eventsFor(db, "organization", org["id"] as number);
      expect(evts).toHaveLength(1);
      expect(evts[0]!.kind).toBe("created");
    }
  });

  it("rejects an empty batch", async () => {
    const db = testDb();
    await expect(
      createRecord(db, { entity: "organization", data: [], now: NOW }, admin),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("update", () => {
  it("updates a single record, recomputes norm, writes an updated event with changes", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Ancien Nom" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const later = "2026-06-13T08:00:00.000Z";
    const updated = (await updateRecord(
      db,
      { entity: "organization", id: org["id"] as number, patch: { name: "Nouveau Café" }, now: later },
      admin,
    )) as ServiceRecord;
    expect(updated["name"]).toBe("Nouveau Café");
    expect(updated["updated_at"]).toBe(later);

    // norm recomputed → findable accent-insensitively under the new name
    const fetched = await getRecord(db, { entity: "organization", id: "nouveau cafe" });
    expect(fetched["id"]).toBe(org["id"]);

    const evts = await eventsFor(db, "organization", org["id"] as number);
    const upd = evts.find((e) => e.kind === "updated");
    expect(upd).toBeDefined();
    const payload = JSON.parse(upd!.payload!) as { changes: Record<string, { from: unknown; to: unknown }> };
    expect(payload.changes["name"]).toEqual({ from: "Ancien Nom", to: "Nouveau Café" });
  });

  it("performs heterogeneous bulk updates", async () => {
    const db = testDb();
    const deals = (await createRecord(
      db,
      {
        entity: "deal",
        data: [
          { title: "Deal A", value: 100 },
          { title: "Deal B", value: 200 },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    const result = (await updateRecord(
      db,
      {
        entity: "deal",
        items: [
          { id: deals[0]!["id"] as number, patch: { value: 150.5 } },
          { id: deals[1]!["id"] as number, patch: { label: "hot", expected_close_date: "2026-07-01" } },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    expect(result).toHaveLength(2);
    expect(result[0]!["value"]).toBe(150.5);
    expect(result[1]!["label"]).toBe("hot");
    expect(result[1]!["expected_close_date"]).toBe("2026-07-01");
  });

  it("rejects stage/status patches on deals, pointing to move_deal", async () => {
    const db = testDb();
    const deal = (await createRecord(
      db,
      { entity: "deal", data: { title: "No shortcut" }, now: NOW },
      admin,
    )) as ServiceRecord;
    await expect(
      updateRecord(
        db,
        { entity: "deal", id: deal["id"] as number, patch: { stage: "Payment" }, now: NOW },
        admin,
      ),
    ).rejects.toThrow(/move_deal/);
    await expect(
      updateRecord(
        db,
        { entity: "deal", id: deal["id"] as number, patch: { status: "won" }, now: NOW },
        admin,
      ),
    ).rejects.toThrow(/move_deal/);
  });

  it("rejects an empty patch", async () => {
    const db = testDb();
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Patchless" }, now: NOW },
      admin,
    )) as ServiceRecord;
    await expect(
      updateRecord(db, { entity: "organization", id: org["id"] as number, patch: {}, now: NOW }, admin),
    ).rejects.toThrow(/Empty patch/);
  });
});
