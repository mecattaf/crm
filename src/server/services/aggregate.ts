import { type SQL, and, asc, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { type FieldDef, type RefDef, entityDef } from "./registry";
import { type Filter, compileFilters } from "./search";
import type { Actor, EntityName } from "./types";

/**
 * aggregate() — replaces dashboards (SPEC.md tool 10). Counts/sums/averages
 * over any entity, optionally grouped by a column, reusing the exact filter
 * grammar of search_records. Money fields are decimals at the surface;
 * archived records are excluded by default (same rules as search).
 */
export interface AggregateInput {
  entity: EntityName;
  /** any whitelisted column; FK columns get resolved display labels */
  group_by?: string;
  /** "count" | "sum:<field>" | "avg:<field>" (numeric or money fields) */
  metric: string;
  filters?: Filter[];
  include_archived?: boolean;
  /** injectable clock for relative-date filter operands */
  now?: string;
}

export interface AggregateGroup {
  /** raw grouped value (FK id, string, etc.; money as decimal) */
  key: string | number | null;
  /** resolved display name for FK columns (stage name, user name, ...), else null */
  label: string | null;
  value: number | null;
}

export interface AggregateResult {
  metric: string;
  /** ungrouped result */
  value?: number | null;
  group_by?: string;
  groups?: AggregateGroup[];
}

function parseMetric(
  entity: EntityName,
  metric: string,
): { fn: "count" | "sum" | "avg"; field?: FieldDef; fieldName?: string } {
  if (metric === "count") return { fn: "count" };
  const m = /^(sum|avg):(.+)$/.exec(metric);
  if (!m) {
    throw new ValidationError(`Unknown metric "${metric}". Allowed: count, sum:<field>, avg:<field>.`);
  }
  const fn = m[1] as "sum" | "avg";
  const fieldName = m[2]!;
  const def = entityDef(entity);
  const field = def.fields[fieldName];
  if (!field) {
    throw new ValidationError(
      `Unknown field "${fieldName}" for ${entity}. Allowed: ${Object.keys(def.fields).join(", ")}.`,
    );
  }
  if (field.kind !== "number" && field.kind !== "money") {
    throw new ValidationError(`Metric "${metric}" needs a numeric field; "${fieldName}" is ${field.kind}.`);
  }
  return { fn, field, fieldName };
}

/** display labels for FK group keys, fetched in one query per call */
async function labelMap(db: Db, target: RefDef["target"], ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  switch (target) {
    case "user": {
      const rows = await db
        .select({ id: schema.users.id, label: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "organization": {
      const rows = await db
        .select({ id: schema.organizations.id, label: schema.organizations.name })
        .from(schema.organizations)
        .where(inArray(schema.organizations.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "contact": {
      const rows = await db
        .select({
          id: schema.contacts.id,
          label: sql<string>`(${schema.contacts.first_name} || ' ' || ${schema.contacts.last_name})`,
        })
        .from(schema.contacts)
        .where(inArray(schema.contacts.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "deal": {
      const rows = await db
        .select({ id: schema.deals.id, label: schema.deals.title })
        .from(schema.deals)
        .where(inArray(schema.deals.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "pipeline": {
      const rows = await db
        .select({ id: schema.pipelines.id, label: schema.pipelines.name })
        .from(schema.pipelines)
        .where(inArray(schema.pipelines.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "stage": {
      const rows = await db
        .select({ id: schema.stages.id, label: schema.stages.name })
        .from(schema.stages)
        .where(inArray(schema.stages.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
  }
}

export async function aggregate(
  db: Db,
  input: AggregateInput,
  _actor?: Actor,
): Promise<AggregateResult> {
  const { entity } = input;
  const def = entityDef(entity);
  const { fn, field } = parseMetric(entity, input.metric);

  const conds: SQL[] = compileFilters(entity, input.filters ?? [], {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.include_archived !== undefined ? { include_archived: input.include_archived } : {}),
  });
  const where = conds.length > 0 ? and(...conds) : undefined;

  const metricExpr =
    fn === "count"
      ? sql<number>`count(*)`
      : fn === "sum"
        ? sql<number>`coalesce(sum(${field!.column}), 0)`
        : sql<number | null>`avg(${field!.column})`;

  /** money metrics surface as decimals (cents internally) */
  const shapeValue = (v: number | null): number | null => {
    if (v === null || field?.kind !== "money") return v;
    return (fn === "avg" ? Math.round(v) : v) / 100;
  };

  if (input.group_by === undefined) {
    const row = await db.select({ value: metricExpr }).from(def.table).where(where).get();
    return { metric: input.metric, value: shapeValue(row?.value ?? (fn === "count" ? 0 : null)) };
  }

  const gb = def.fields[input.group_by];
  if (!gb) {
    throw new ValidationError(
      `Unknown group_by field "${input.group_by}" for ${entity}. Allowed: ${Object.keys(def.fields).join(", ")}.`,
    );
  }

  const rows = await db
    .select({ key: gb.column, value: metricExpr })
    .from(def.table)
    .where(where)
    .groupBy(gb.column)
    .orderBy(asc(gb.column))
    .all();

  // FK columns get display labels (stage_id -> stage name, owner_id -> user name, ...)
  const refDef = Object.values(def.refs).find((r) => r.column === input.group_by);
  let labels = new Map<number, string>();
  if (refDef) {
    const ids = rows.map((r) => r.key).filter((k): k is number => typeof k === "number");
    labels = await labelMap(db, refDef.target, ids);
  }

  const groups: AggregateGroup[] = rows.map((r) => {
    let key = r.key as string | number | null;
    if (gb.kind === "money" && typeof key === "number") key = key / 100;
    if (gb.kind === "boolean" && key !== null) key = Number(key);
    return {
      key,
      label: refDef && typeof r.key === "number" ? (labels.get(r.key) ?? null) : null,
      value: shapeValue(r.value),
    };
  });

  return { metric: input.metric, group_by: input.group_by, groups };
}
