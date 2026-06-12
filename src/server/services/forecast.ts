import { type SQL, and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { type Ref, resolvePipeline } from "./resolve";
import type { Actor } from "./types";
import { nowIso } from "./types";

/**
 * forecast() — the CEO job (SPEC.md tool 11). Open deals (archived excluded)
 * grouped by expected-close month, weighted by stage forecast_weight and
 * converted to EUR via fx_rates. Replicates pipedrive_pull.py semantics:
 * weighted = value_eur * weight/100; deals with NULL expected_close_date go
 * in an `unscheduled` bucket — listed, never totalled.
 *
 * All arithmetic happens in integer EUR cents (rounded per deal) so month
 * totals are the exact sum of the listed deal lines; decimals at the surface.
 */
export interface ForecastInput {
  /** pipeline name or id; omit for all pipelines */
  pipeline?: Ref;
  /** horizon: only months [now's month, now's month + months) are returned */
  months?: number;
  /** injectable clock (ISO datetime, UTC) */
  now?: string;
}

export interface ForecastDeal {
  id: number;
  title: string;
  organization: string | null;
  pipeline: string;
  stage: string;
  value: number;
  currency: string;
  value_eur: number;
  /** stage forecast_weight, 0-100 */
  weight: number;
  weighted_eur: number;
  expected_close_date: string | null;
}

export interface ForecastMonth {
  /** YYYY-MM */
  month: string;
  gross_eur: number;
  weighted_eur: number;
  deals: ForecastDeal[];
}

export interface ForecastResult {
  pipeline: { id: number; name: string } | null;
  months: ForecastMonth[];
  /** deals lacking an expected_close_date: listed, never totalled */
  unscheduled: ForecastDeal[];
  /** totals across the listed months (unscheduled excluded) */
  total_gross_eur: number;
  total_weighted_eur: number;
}

/** currency -> rate_to_eur_micros (1 unit = micros / 1e6 EUR), from fx_rates. */
export async function fxEurMap(db: Db): Promise<Map<string, number>> {
  const rows = await db.select().from(schema.fx_rates).all();
  return new Map(rows.map((r) => [r.currency, r.rate_to_eur_micros]));
}

/** Convert integer cents in `currency` to integer EUR cents (rounded). */
export function toEurCents(valueCents: number, currency: string, fx: Map<string, number>): number {
  const micros = fx.get(currency);
  if (micros === undefined) {
    throw new ValidationError(`No FX rate for currency "${currency}".`);
  }
  return Math.round((valueCents * micros) / 1_000_000);
}

/** whole months from YYYY-MM `from` to YYYY-MM `to` (negative = past). */
function monthDiff(from: string, to: string): number {
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  return (ty - fy) * 12 + (tm - fm);
}

export async function forecast(
  db: Db,
  input: ForecastInput = {},
  _actor?: Actor,
): Promise<ForecastResult> {
  if (input.months !== undefined && (!Number.isInteger(input.months) || input.months < 1)) {
    throw new ValidationError("months must be a positive integer.");
  }
  const now = nowIso(input.now);
  const currentMonth = now.slice(0, 7);
  const pipeline = input.pipeline != null ? await resolvePipeline(db, input.pipeline) : null;
  const fx = await fxEurMap(db);

  const conds: SQL[] = [eq(schema.deals.status, "open"), isNull(schema.deals.archived_at)];
  if (pipeline) conds.push(eq(schema.deals.pipeline_id, pipeline.id));

  const rows = await db
    .select({
      id: schema.deals.id,
      title: schema.deals.title,
      organization: schema.organizations.name,
      pipeline: schema.pipelines.name,
      stage: schema.stages.name,
      value_cents: schema.deals.value_cents,
      currency: schema.deals.currency,
      weight: schema.stages.forecast_weight,
      expected_close_date: schema.deals.expected_close_date,
    })
    .from(schema.deals)
    .innerJoin(schema.stages, eq(schema.deals.stage_id, schema.stages.id))
    .innerJoin(schema.pipelines, eq(schema.deals.pipeline_id, schema.pipelines.id))
    .leftJoin(schema.organizations, eq(schema.deals.org_id, schema.organizations.id))
    .where(and(...conds))
    .orderBy(asc(schema.deals.expected_close_date), asc(schema.deals.id))
    .all();

  interface Bucket {
    grossCents: number;
    weightedCents: number;
    deals: ForecastDeal[];
  }
  const byMonth = new Map<string, Bucket>();
  const unscheduled: ForecastDeal[] = [];
  let totalGrossCents = 0;
  let totalWeightedCents = 0;

  for (const row of rows) {
    const eurCents = toEurCents(row.value_cents, row.currency, fx);
    const weightedCents = Math.round((eurCents * row.weight) / 100);
    const deal: ForecastDeal = {
      id: row.id,
      title: row.title,
      organization: row.organization,
      pipeline: row.pipeline,
      stage: row.stage,
      value: row.value_cents / 100,
      currency: row.currency,
      value_eur: eurCents / 100,
      weight: row.weight,
      weighted_eur: weightedCents / 100,
      expected_close_date: row.expected_close_date,
    };

    if (row.expected_close_date === null) {
      unscheduled.push(deal);
      continue;
    }
    const month = row.expected_close_date.slice(0, 7);
    if (input.months !== undefined) {
      const diff = monthDiff(currentMonth, month);
      if (diff < 0 || diff >= input.months) continue;
    }
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = { grossCents: 0, weightedCents: 0, deals: [] };
      byMonth.set(month, bucket);
    }
    bucket.grossCents += eurCents;
    bucket.weightedCents += weightedCents;
    bucket.deals.push(deal);
    totalGrossCents += eurCents;
    totalWeightedCents += weightedCents;
  }

  const months: ForecastMonth[] = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, b]) => ({
      month,
      gross_eur: b.grossCents / 100,
      weighted_eur: b.weightedCents / 100,
      deals: b.deals,
    }));

  return {
    pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
    months,
    unscheduled,
    total_gross_eur: totalGrossCents / 100,
    total_weighted_eur: totalWeightedCents / 100,
  };
}
