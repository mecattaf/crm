import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/server/services/errors";
import { archiveRecord, createRecord } from "../src/server/services/records";
import { searchRecords } from "../src/server/services/search";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin, testDb } from "./helpers";

// Deterministic clock: NOW = 2026-06-12T10:00:00Z → today = 2026-06-12
const YESTERDAY = "2026-06-11";
const TEN_DAYS_AGO = "2026-06-02";
const IN_THREE_DAYS = "2026-06-15";
const IN_THIRTY_DAYS = "2026-07-12";

async function seedDeals(db: ReturnType<typeof testDb>) {
  return (await createRecord(
    db,
    {
      entity: "deal",
      data: [
        { title: "Crémant order", value: 500, expected_close_date: IN_THREE_DAYS },
        { title: "Bordeaux pallet", value: 2500, expected_close_date: YESTERDAY },
        { title: "Whisky single cask", value: 12000, currency: "GBP" },
      ],
      now: NOW,
    },
    admin,
  )) as ServiceRecord[];
}

describe("query (fuzzy cross-field)", () => {
  it("matches accent-insensitively across normalized fields", async () => {
    const db = testDb();
    await createRecord(
      db,
      {
        entity: "organization",
        data: [{ name: "Café São Paulo Importação" }, { name: "Berlin Wein Kontor" }],
        now: NOW,
      },
      admin,
    );
    const hit = await searchRecords(db, { entity: "organization", query: "cafe sao", now: NOW });
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]!["name"]).toBe("Café São Paulo Importação");

    const miss = await searchRecords(db, { entity: "organization", query: "tokyo", now: NOW });
    expect(miss.items).toHaveLength(0);
  });

  it("matches raw columns case-insensitively (client_code)", async () => {
    const db = testDb();
    await createRecord(
      db,
      { entity: "organization", data: { name: "Acme", client_code: "SOD-99" }, now: NOW },
      admin,
    );
    const r = await searchRecords(db, { entity: "organization", query: "sod-99", now: NOW });
    expect(r.items).toHaveLength(1);
  });
});

describe("filter operands", () => {
  it("eq / ne / gt on money converts decimals to cents", async () => {
    const db = testDb();
    await seedDeals(db);
    const eq500 = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "value", op: "eq", value: 500 }],
      now: NOW,
    });
    expect(eq500.items.map((d) => d["title"])).toEqual(["Crémant order"]);

    const gt1000 = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "value", op: "gt", value: 1000 }],
      now: NOW,
    });
    expect(gt1000.items.map((d) => d["title"]).sort()).toEqual([
      "Bordeaux pallet",
      "Whisky single cask",
    ]);
  });

  it("contains is accent-insensitive on normed fields", async () => {
    const db = testDb();
    await seedDeals(db);
    const r = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "title", op: "contains", value: "cremant" }],
      now: NOW,
    });
    expect(r.items).toHaveLength(1);
  });

  it("in / is_null / not_null", async () => {
    const db = testDb();
    await seedDeals(db);
    const inCur = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "currency", op: "in", value: ["GBP", "USD"] }],
      now: NOW,
    });
    expect(inCur.items.map((d) => d["title"])).toEqual(["Whisky single cask"]);

    const noClose = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "expected_close_date", op: "is_null" }],
      now: NOW,
    });
    expect(noClose.items.map((d) => d["title"])).toEqual(["Whisky single cask"]);

    const withClose = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "expected_close_date", op: "not_null" }],
      now: NOW,
    });
    expect(withClose.items).toHaveLength(2);
  });

  it("or groups combine with outer and", async () => {
    const db = testDb();
    await seedDeals(db);
    const r = await searchRecords(db, {
      entity: "deal",
      filters: [
        {
          or: [
            { field: "value", op: "gt", value: 10000 },
            { field: "title", op: "contains", value: "cremant" },
          ],
        },
        { field: "status", op: "eq", value: "open" },
      ],
      now: NOW,
    });
    expect(r.items.map((d) => d["title"]).sort()).toEqual(["Crémant order", "Whisky single cask"]);
  });

  it("rejects unknown fields and unknown operands", async () => {
    const db = testDb();
    await expect(
      searchRecords(db, { entity: "deal", filters: [{ field: "nope", op: "eq", value: 1 }], now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      searchRecords(db, { entity: "deal", filters: [{ field: "title", op: "zap", value: 1 }], now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      searchRecords(db, {
        entity: "deal",
        filters: [{ field: "title", op: "is_today" }],
        now: NOW,
      }),
    ).rejects.toThrow(/date fields/);
  });
});

describe("relative date operands (injected now)", () => {
  async function seedActivities(db: ReturnType<typeof testDb>) {
    await createRecord(
      db,
      {
        entity: "activity",
        data: [
          { subject: "due today", activity_type: "call", due_date: "2026-06-12" },
          { subject: "due yesterday", activity_type: "task", due_date: YESTERDAY },
          { subject: "long overdue", activity_type: "email", due_date: TEN_DAYS_AGO },
          { subject: "due soon", activity_type: "meeting", due_date: IN_THREE_DAYS },
          { subject: "due next month", activity_type: "deadline", due_date: IN_THIRTY_DAYS },
        ],
        now: NOW,
      },
      admin,
    );
  }

  it("is_today", async () => {
    const db = testDb();
    await seedActivities(db);
    const r = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "is_today" }],
      now: NOW,
    });
    expect(r.items.map((a) => a["subject"])).toEqual(["due today"]);
  });

  it("is_overdue excludes done activities", async () => {
    const db = testDb();
    await seedActivities(db);
    const r = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "is_overdue" }],
      now: NOW,
    });
    expect(r.items.map((a) => a["subject"]).sort()).toEqual(["due yesterday", "long overdue"]);

    // completing one removes it from overdue
    const { completeActivity } = await import("../src/server/services/activities");
    const target = r.items.find((a) => a["subject"] === "due yesterday")!;
    await completeActivity(db, { activity: target["id"] as number, now: NOW }, admin);
    const after = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "is_overdue" }],
      now: NOW,
    });
    expect(after.items.map((a) => a["subject"])).toEqual(["long overdue"]);
  });

  it("is_overdue on deals only counts open deals", async () => {
    const db = testDb();
    const deals = await seedDeals(db);
    const { moveDeal } = await import("../src/server/services/deals");
    const overdueBefore = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "expected_close_date", op: "is_overdue" }],
      now: NOW,
    });
    expect(overdueBefore.items.map((d) => d["title"])).toEqual(["Bordeaux pallet"]);
    await moveDeal(db, { deal: deals[1]!["id"] as number, status: "won", now: NOW }, admin);
    const overdueAfter = await searchRecords(db, {
      entity: "deal",
      filters: [{ field: "expected_close_date", op: "is_overdue" }],
      now: NOW,
    });
    expect(overdueAfter.items).toHaveLength(0);
  });

  it("in_past", async () => {
    const db = testDb();
    await seedActivities(db);
    const r = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "in_past" }],
      now: NOW,
    });
    expect(r.items.map((a) => a["subject"]).sort()).toEqual(["due yesterday", "long overdue"]);
  });

  it("in_next_days with value and with colon suffix", async () => {
    const db = testDb();
    await seedActivities(db);
    const withValue = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "in_next_days", value: 7 }],
      now: NOW,
    });
    expect(withValue.items.map((a) => a["subject"]).sort()).toEqual(["due soon", "due today"]);

    const withColon = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "in_next_days:7" }],
      now: NOW,
    });
    expect(withColon.items.map((a) => a["subject"]).sort()).toEqual(["due soon", "due today"]);
  });

  it("in_last_days", async () => {
    const db = testDb();
    await seedActivities(db);
    const r = await searchRecords(db, {
      entity: "activity",
      filters: [{ field: "due_date", op: "in_last_days", value: 5 }],
      now: NOW,
    });
    expect(r.items.map((a) => a["subject"]).sort()).toEqual(["due today", "due yesterday"]);
  });
});

describe("archive visibility", () => {
  it("excludes archived records by default; include_archived or archived_at filter reveals them", async () => {
    const db = testDb();
    const orgs = (await createRecord(
      db,
      { entity: "organization", data: [{ name: "Live Org" }, { name: "Dead Org" }], now: NOW },
      admin,
    )) as ServiceRecord[];
    await archiveRecord(db, { entity: "organization", id: orgs[1]!["id"] as number, now: NOW }, admin);

    const dflt = await searchRecords(db, { entity: "organization", now: NOW });
    expect(dflt.items.map((o) => o["name"])).toEqual(["Live Org"]);

    const all = await searchRecords(db, { entity: "organization", include_archived: true, now: NOW });
    expect(all.items).toHaveLength(2);

    const onlyArchived = await searchRecords(db, {
      entity: "organization",
      filters: [{ field: "archived_at", op: "not_null" }],
      now: NOW,
    });
    expect(onlyArchived.items.map((o) => o["name"])).toEqual(["Dead Org"]);
  });
});

describe("sort + cursor pagination", () => {
  it("sorts by money descending via '-value'", async () => {
    const db = testDb();
    await seedDeals(db);
    const r = await searchRecords(db, { entity: "deal", sort: "-value", now: NOW });
    expect(r.items.map((d) => d["title"])).toEqual([
      "Whisky single cask",
      "Bordeaux pallet",
      "Crémant order",
    ]);
  });

  it("paginates with a cursor (default id order), no duplicates, terminates", async () => {
    const db = testDb();
    await createRecord(
      db,
      {
        entity: "organization",
        data: Array.from({ length: 5 }, (_, i) => ({ name: `Org ${i + 1}` })),
        now: NOW,
      },
      admin,
    );
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await searchRecords(db, {
        entity: "organization",
        limit: 2,
        ...(cursor ? { cursor } : {}),
        now: NOW,
      });
      seen.push(...page.items.map((o) => o["id"]));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it("paginates stably under a custom sort", async () => {
    const db = testDb();
    await createRecord(
      db,
      {
        entity: "deal",
        data: [
          { title: "D1", value: 100 },
          { title: "D2", value: 100 },
          { title: "D3", value: 50 },
          { title: "D4", value: 200 },
        ],
        now: NOW,
      },
      admin,
    );
    const p1 = await searchRecords(db, { entity: "deal", sort: "-value", limit: 2, now: NOW });
    expect(p1.items.map((d) => d["title"])).toEqual(["D4", "D1"]);
    const p2 = await searchRecords(db, {
      entity: "deal",
      sort: "-value",
      limit: 2,
      cursor: p1.next_cursor!,
      now: NOW,
    });
    expect(p2.items.map((d) => d["title"])).toEqual(["D2", "D3"]);
    expect(p2.next_cursor).toBeNull();
  });

  it("rejects a malformed cursor", async () => {
    const db = testDb();
    await expect(
      searchRecords(db, { entity: "deal", cursor: "garbage!!", now: NOW }),
    ).rejects.toThrow(/cursor/i);
  });
});
