import { describe, expect, it } from "vitest";
import { completeActivity } from "../src/server/services/activities";
import { aggregate } from "../src/server/services/aggregate";
import { ValidationError } from "../src/server/services/errors";
import { createRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { seedDealFixture } from "./fixtures";
import { NOW, admin, testDb } from "./helpers";

describe("aggregate: count", () => {
  it("counts records, excluding archived by default", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await aggregate(db, { entity: "deal", metric: "count", now: NOW });
    expect(r).toEqual({ metric: "count", value: 8 }); // 9 seeded - 1 archived

    const all = await aggregate(db, {
      entity: "deal",
      metric: "count",
      include_archived: true,
      now: NOW,
    });
    expect(all.value).toBe(9);
  });

  it("reuses the search filter grammar incl. relative-date operands", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const open = await aggregate(db, {
      entity: "deal",
      metric: "count",
      filters: [{ field: "status", op: "eq", value: "open" }],
      now: NOW,
    });
    expect(open.value).toBe(7);

    // ECD within [2026-06-12, 2026-07-12]: Margaux, Swiss, London July, Won June
    // (archived 2026-06-19 deal stays excluded)
    const closingSoon = await aggregate(db, {
      entity: "deal",
      metric: "count",
      filters: [{ field: "expected_close_date", op: "in_next_days", value: 30 }],
      now: NOW,
    });
    expect(closingSoon.value).toBe(4);
  });
});

describe("aggregate: sum / avg with money decimals", () => {
  it("sum:value grouped by currency returns decimals, not cents", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await aggregate(db, {
      entity: "deal",
      group_by: "currency",
      metric: "sum:value",
      filters: [{ field: "status", op: "eq", value: "open" }],
      now: NOW,
    });
    expect(r.metric).toBe("sum:value");
    expect(r.group_by).toBe("currency");
    expect(r.groups).toEqual([
      { key: "CHF", label: null, value: 2000 },
      { key: "EUR", label: null, value: 18000 }, // 10000 + 3000 + 4000 + 1000
      { key: "GBP", label: null, value: 1000 },
      { key: "USD", label: null, value: 5000 },
    ]);
  });

  it("avg:value rounds money to cents", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await aggregate(db, {
      entity: "deal",
      metric: "avg:value",
      filters: [
        { field: "status", op: "eq", value: "open" },
        { field: "currency", op: "eq", value: "EUR" },
      ],
      now: NOW,
    });
    expect(r.value).toBe(4500); // (10000 + 3000 + 4000 + 1000) / 4

    // 3-way average with a repeating decimal in cents: (10000+3000+4000)/3
    const r3 = await aggregate(db, {
      entity: "deal",
      metric: "avg:value",
      filters: [
        { field: "currency", op: "eq", value: "EUR" },
        { field: "value", op: "gt", value: 1000 },
        { field: "status", op: "eq", value: "open" },
      ],
      now: NOW,
    });
    expect(r3.value).toBe(5666.67); // 566666.66... cents -> 566667 -> 5666.67
  });

  it("sum over an empty set is 0; avg is null", async () => {
    const db = testDb();
    const sum = await aggregate(db, { entity: "deal", metric: "sum:value", now: NOW });
    expect(sum.value).toBe(0);
    const avg = await aggregate(db, { entity: "deal", metric: "avg:value", now: NOW });
    expect(avg.value).toBeNull();
  });
});

describe("aggregate: group_by name resolution", () => {
  it("resolves FK group keys to display names (stage_id -> stage name)", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await aggregate(db, {
      entity: "deal",
      group_by: "stage_id",
      metric: "count",
      now: NOW,
    });
    expect(r.groups).toEqual([
      { key: 1, label: "Order received", value: 2 }, // London July + May overdue (archived excluded)
      { key: 2, label: "Proforma Sent", value: 1 },
      { key: 3, label: "Proforma confirmed", value: 1 },
      { key: 4, label: "Payment", value: 3 }, // Margaux + Unscheduled + Won
      { key: 10, label: "Negotiation", value: 1 },
    ]);
  });

  it("groups NULL FK keys with a null label", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await aggregate(db, {
      entity: "deal",
      group_by: "owner_id",
      metric: "count",
      now: NOW,
    });
    expect(r.groups).toEqual([{ key: null, label: null, value: 8 }]);
  });

  it("groups booleans as 0/1 keys (activities by done)", async () => {
    const db = testDb();
    const acts = (await createRecord(
      db,
      {
        entity: "activity",
        data: [
          { subject: "call one", activity_type: "call", due_date: "2026-06-12" },
          { subject: "call two", activity_type: "call", due_date: "2026-06-13" },
          { subject: "task done", activity_type: "task", due_date: "2026-06-10" },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    await completeActivity(db, { activity: acts[2]!["id"] as number, now: NOW }, admin);

    const r = await aggregate(db, {
      entity: "activity",
      group_by: "done",
      metric: "count",
      now: NOW,
    });
    expect(r.groups).toEqual([
      { key: 0, label: null, value: 2 },
      { key: 1, label: null, value: 1 },
    ]);
  });
});

describe("aggregate: validation", () => {
  it("rejects unknown metrics, non-numeric metric fields and unknown group_by", async () => {
    const db = testDb();
    await expect(
      aggregate(db, { entity: "deal", metric: "median:value", now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      aggregate(db, { entity: "deal", metric: "sum:title", now: NOW }),
    ).rejects.toThrow(/numeric field/);
    await expect(
      aggregate(db, { entity: "deal", metric: "sum:nope", now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      aggregate(db, { entity: "deal", group_by: "nope", metric: "count", now: NOW }),
    ).rejects.toThrow(/group_by/);
    await expect(
      aggregate(db, {
        entity: "deal",
        metric: "count",
        filters: [{ field: "nope", op: "eq", value: 1 }],
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
