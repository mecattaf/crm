import type { Db } from "../src/server/db";
import { schema } from "../src/server/db";
import { moveDeal } from "../src/server/services/deals";
import { normalizeText } from "../src/server/services/normalize";
import { archiveRecord, createRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import { NOW, admin } from "./helpers";

/** ISO timestamp exactly n days before NOW (deterministic clock math). */
export function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

/** Second user for assignee/my_day tests. Returns the generated id (users
 * autoincrement is NOT reset between tests — never hardcode it). */
export async function createUser(db: Db, name: string, email: string): Promise<number> {
  const rows = await db
    .insert(schema.users)
    .values({
      email,
      name,
      name_norm: normalizeText(name),
      password_hash: "test-only",
      role: "member",
      created_at: NOW,
      updated_at: NOW,
    })
    .returning();
  return rows[0]!.id;
}

/**
 * Rich deterministic deal fixture for forecast/aggregate tests.
 * NOW = 2026-06-12 → current month 2026-06. Seeded FX micros:
 * EUR 1.00, CHF 1.06, GBP 1.17, USD 0.92.
 *
 * Open Export Clients deals by expected-close month (EUR-converted):
 *   2026-05: May overdue close   1000 EUR  @ Order received (w50)    -> 1000 / 500
 *   2026-06: Margaux June order 10000 EUR  @ Payment (w100)          -> 10000 / 10000
 *            Swiss proforma      2000 CHF  @ Proforma Sent (w50)     -> 2120 / 1060
 *   2026-07: London July order   1000 GBP  @ Order received (w50)    -> 1170 / 585
 *   2026-08: August confirm      4000 EUR  @ Proforma confirmed (w50)-> 4000 / 2000
 *   unscheduled: Unscheduled payment 3000 EUR @ Payment (w100)       -> listed only
 * New Leads - Wine:
 *   2026-07: USD wine lead       5000 USD  @ Negotiation (w50)       -> 4600 / 2300
 * Excluded everywhere: "Won June deal" (won), "Archived deal" (archived).
 */
export async function seedDealFixture(db: Db) {
  const orgs = (await createRecord(
    db,
    {
      entity: "organization",
      data: [
        { name: "Château Margaux Négoce" },
        { name: "Swiss Fine Wines" },
        { name: "London Cellars" },
      ],
      now: NOW,
    },
    admin,
  )) as ServiceRecord[];

  const deals = (await createRecord(
    db,
    {
      entity: "deal",
      data: [
        {
          title: "Margaux June order",
          organization: "Château Margaux Négoce",
          pipeline: "Export Clients",
          stage: "Payment",
          value: 10000,
          currency: "EUR",
          expected_close_date: "2026-06-20",
        },
        {
          title: "Swiss proforma",
          organization: "Swiss Fine Wines",
          pipeline: "Export Clients",
          stage: "Proforma Sent",
          value: 2000,
          currency: "CHF",
          expected_close_date: "2026-06-25",
        },
        {
          title: "London July order",
          organization: "London Cellars",
          pipeline: "Export Clients",
          stage: "Order received",
          value: 1000,
          currency: "GBP",
          expected_close_date: "2026-07-10",
        },
        {
          title: "USD wine lead",
          organization: "London Cellars",
          pipeline: "New Leads - Wine",
          stage: "Negotiation",
          value: 5000,
          currency: "USD",
          expected_close_date: "2026-07-15",
        },
        {
          title: "Unscheduled payment",
          organization: "Château Margaux Négoce",
          pipeline: "Export Clients",
          stage: "Payment",
          value: 3000,
          currency: "EUR",
        },
        {
          title: "Won June deal",
          pipeline: "Export Clients",
          stage: "Payment",
          value: 8000,
          currency: "EUR",
          expected_close_date: "2026-06-18",
        },
        {
          title: "Archived deal",
          pipeline: "Export Clients",
          stage: "Order received",
          value: 9999,
          currency: "EUR",
          expected_close_date: "2026-06-19",
        },
        {
          title: "August confirm",
          pipeline: "Export Clients",
          stage: "Proforma confirmed",
          value: 4000,
          currency: "EUR",
          expected_close_date: "2026-08-05",
        },
        {
          title: "May overdue close",
          pipeline: "Export Clients",
          stage: "Order received",
          value: 1000,
          currency: "EUR",
          expected_close_date: "2026-05-30",
        },
      ],
      now: NOW,
    },
    admin,
  )) as ServiceRecord[];

  await moveDeal(db, { deal: deals[5]!["id"] as number, status: "won", now: NOW }, admin);
  await archiveRecord(db, { entity: "deal", id: deals[6]!["id"] as number, now: NOW }, admin);

  return { orgs, deals };
}
