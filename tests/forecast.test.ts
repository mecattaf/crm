import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/server/services/errors";
import { forecast } from "../src/server/services/forecast";
import { createRecord } from "../src/server/services/records";
import { seedDealFixture } from "./fixtures";
import { NOW, admin, testDb } from "./helpers";

// NOW = 2026-06-12T10:00:00Z -> current month 2026-06.
// FX micros (seed): EUR 1_000_000, CHF 1_060_000, GBP 1_170_000, USD 920_000.

describe("forecast", () => {
  it("groups open deals by expected-close month with EUR conversion and stage weighting", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await forecast(db, { pipeline: "Export Clients", now: NOW });

    expect(r.pipeline).toEqual({ id: 1, name: "Export Clients" });
    expect(r.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);

    const june = r.months.find((m) => m.month === "2026-06")!;
    expect(june.gross_eur).toBe(12120); // 10000 EUR + 2000 CHF * 1.06
    expect(june.weighted_eur).toBe(11060); // 10000 * 100% + 2120 * 50%
    expect(june.deals.map((d) => d.title)).toEqual(["Margaux June order", "Swiss proforma"]);

    const margaux = june.deals[0]!;
    expect(margaux).toMatchObject({
      organization: "Château Margaux Négoce",
      stage: "Payment",
      weight: 100,
      value: 10000,
      currency: "EUR",
      value_eur: 10000,
      weighted_eur: 10000,
      expected_close_date: "2026-06-20",
    });

    const swiss = june.deals[1]!;
    expect(swiss).toMatchObject({
      stage: "Proforma Sent",
      weight: 50,
      value: 2000,
      currency: "CHF",
      value_eur: 2120,
      weighted_eur: 1060,
    });

    const july = r.months.find((m) => m.month === "2026-07")!;
    expect(july.gross_eur).toBe(1170); // 1000 GBP * 1.17
    expect(july.weighted_eur).toBe(585);

    expect(r.total_gross_eur).toBe(18290); // 1000 + 12120 + 1170 + 4000
    expect(r.total_weighted_eur).toBe(14145); // 500 + 11060 + 585 + 2000
  });

  it("puts deals without expected_close_date in unscheduled — listed, never totalled", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await forecast(db, { pipeline: "Export Clients", now: NOW });

    expect(r.unscheduled.map((d) => d.title)).toEqual(["Unscheduled payment"]);
    expect(r.unscheduled[0]).toMatchObject({
      value_eur: 3000,
      weight: 100,
      weighted_eur: 3000,
      expected_close_date: null,
    });
    // not in any month bucket, not in totals (totals asserted above exclude it)
    for (const m of r.months) {
      expect(m.deals.map((d) => d.title)).not.toContain("Unscheduled payment");
    }
  });

  it("months horizon keeps only [now's month, now's month + months)", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await forecast(db, { pipeline: "Export Clients", months: 2, now: NOW });

    // May (past) and August (beyond horizon) drop out; unscheduled stays listed
    expect(r.months.map((m) => m.month)).toEqual(["2026-06", "2026-07"]);
    expect(r.total_gross_eur).toBe(13290); // 12120 + 1170
    expect(r.total_weighted_eur).toBe(11645); // 11060 + 585
    expect(r.unscheduled).toHaveLength(1);

    const onlyJune = await forecast(db, { pipeline: 1, months: 1, now: NOW });
    expect(onlyJune.months.map((m) => m.month)).toEqual(["2026-06"]);
    expect(onlyJune.pipeline).toEqual({ id: 1, name: "Export Clients" });
  });

  it("covers all pipelines by default; pipeline filter excludes the rest", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const all = await forecast(db, { now: NOW });

    expect(all.pipeline).toBeNull();
    const july = all.months.find((m) => m.month === "2026-07")!;
    expect(july.deals.map((d) => d.title)).toEqual(["London July order", "USD wine lead"]);
    expect(july.gross_eur).toBe(5770); // 1170 + 5000 USD * 0.92
    expect(july.weighted_eur).toBe(2885);
    expect(all.total_gross_eur).toBe(22890);
    expect(all.total_weighted_eur).toBe(16445);

    const filtered = await forecast(db, { pipeline: "Export Clients", now: NOW });
    const titles = filtered.months.flatMap((m) => m.deals.map((d) => d.title));
    expect(titles).not.toContain("USD wine lead");
  });

  it("excludes won and archived deals everywhere", async () => {
    const db = testDb();
    await seedDealFixture(db);
    const r = await forecast(db, { now: NOW });
    const everywhere = [
      ...r.months.flatMap((m) => m.deals.map((d) => d.title)),
      ...r.unscheduled.map((d) => d.title),
    ];
    expect(everywhere).not.toContain("Won June deal");
    expect(everywhere).not.toContain("Archived deal");
  });

  it("rounds EUR conversion to cents", async () => {
    const db = testDb();
    await createRecord(
      db,
      {
        entity: "deal",
        data: {
          title: "Fractional CHF",
          pipeline: "Export Clients",
          stage: "Payment",
          value: 333.33,
          currency: "CHF",
          expected_close_date: "2026-06-30",
        },
        now: NOW,
      },
      admin,
    );
    const r = await forecast(db, { now: NOW });
    const deal = r.months[0]!.deals[0]!;
    expect(deal.value_eur).toBe(353.33); // 33333 cents * 1.06 = 35332.98 -> 35333
    expect(deal.weighted_eur).toBe(353.33); // Payment weight 100
  });

  it("rejects a non-positive months horizon", async () => {
    const db = testDb();
    await expect(forecast(db, { months: 0, now: NOW })).rejects.toBeInstanceOf(ValidationError);
    await expect(forecast(db, { months: 1.5, now: NOW })).rejects.toBeInstanceOf(ValidationError);
  });
});
