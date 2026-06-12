import { type SQL, and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { normalizeText } from "./normalize";
import { type EntityDef, type FieldDef, entityDef } from "./registry";
import { shapeRecord } from "./records";
import type { Actor, EntityName, ServiceRecord } from "./types";
import { nowIso } from "./types";

/**
 * search_records filter grammar (SPEC.md):
 * - `query`: fuzzy accent-insensitive cross-field match
 * - `filters`: flat AND list; an element may be `{ or: [...] }` for OR groups
 * - typed operands incl. relative dates: is_today, is_overdue, in_past,
 *   in_next_days (value N, or "in_next_days:N"), in_last_days
 * - cursor pagination keyed by id (keyset; stable with any sort)
 * - archived records excluded unless include_archived or an archived_at filter
 */
export interface FilterCond {
  field: string;
  op: string;
  value?: unknown;
}

export interface OrGroup {
  or: FilterCond[];
}

export type Filter = FilterCond | OrGroup;

export interface SortSpec {
  field: string;
  dir?: "asc" | "desc";
}

export interface SearchRecordsInput {
  entity: EntityName;
  query?: string;
  filters?: Filter[];
  /** "field", "-field" (desc) or {field, dir} */
  sort?: string | SortSpec;
  limit?: number;
  cursor?: string;
  include_archived?: boolean;
  /** injectable clock (ISO datetime, UTC) for relative-date operands */
  now?: string;
}

export interface SearchRecordsResult {
  items: ServiceRecord[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const COMPARISON_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const DATE_OPS = new Set(["is_today", "is_overdue", "in_past", "in_next_days", "in_last_days"]);

interface CursorPayload {
  i: number;
  v?: unknown;
}

function encodeCursor(payload: CursorPayload): string {
  return btoa(encodeURIComponent(JSON.stringify(payload)));
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as CursorPayload;
    if (typeof parsed.i !== "number") throw new Error("bad cursor");
    return parsed;
  } catch {
    throw new ValidationError("Invalid cursor.");
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fieldDef(def: EntityDef, entity: EntityName, field: string): FieldDef {
  const fd = def.fields[field];
  if (!fd) {
    throw new ValidationError(
      `Unknown field "${field}" for ${entity}. Allowed: ${Object.keys(def.fields).join(", ")}.`,
    );
  }
  return fd;
}

function coerceValue(fd: FieldDef, value: unknown): unknown {
  if (fd.kind === "money") {
    if (typeof value !== "number") throw new ValidationError("Money filters expect a decimal number.");
    return Math.round(value * 100);
  }
  return value;
}

/** Days argument for in_next_days / in_last_days; accepts op "in_next_days:N" or value N. */
function daysArg(op: string, suffix: string | undefined, value: unknown): number {
  const raw = suffix !== undefined ? Number(suffix) : Number(value);
  if (!Number.isInteger(raw) || raw < 0) {
    throw new ValidationError(`Operand "${op}" needs a non-negative integer day count.`);
  }
  return raw;
}

function buildCondition(
  entity: EntityName,
  def: EntityDef,
  f: FilterCond,
  today: string,
  nowStamp: string,
): SQL {
  const colonIdx = f.op.indexOf(":");
  const opName = colonIdx === -1 ? f.op : f.op.slice(0, colonIdx);
  const opSuffix = colonIdx === -1 ? undefined : f.op.slice(colonIdx + 1);
  const fd = fieldDef(def, entity, f.field);
  const col = fd.column;

  if (COMPARISON_OPS.has(opName)) {
    const v = coerceValue(fd, f.value) as string | number | boolean;
    switch (opName) {
      case "eq":
        return eq(col, v);
      case "ne":
        return ne(col, v);
      case "gt":
        return gt(col, v);
      case "gte":
        return gte(col, v);
      case "lt":
        return lt(col, v);
      default:
        return lte(col, v);
    }
  }

  switch (opName) {
    case "contains": {
      const raw = String(f.value ?? "");
      if (fd.norm) return like(fd.norm, `%${normalizeText(raw)}%`);
      return like(sql`lower(${col})`, `%${raw.toLowerCase()}%`);
    }
    case "in": {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        throw new ValidationError(`Operand "in" needs a non-empty array value.`);
      }
      return inArray(col, f.value.map((v) => coerceValue(fd, v)) as (string | number)[]);
    }
    case "is_null":
      return isNull(col);
    case "not_null":
      return isNotNull(col);
  }

  if (DATE_OPS.has(opName)) {
    if (fd.kind !== "date" && fd.kind !== "datetime") {
      throw new ValidationError(`Operand "${opName}" only applies to date fields, not "${f.field}".`);
    }
    // DATE-only YYYY-MM-DD columns compare directly; datetimes via their date part.
    const dexpr: SQL = fd.kind === "date" ? sql`${col}` : sql`substr(${col}, 1, 10)`;
    switch (opName) {
      case "is_today":
        return eq(dexpr, today);
      case "in_past":
        return fd.kind === "date" ? lt(dexpr, today) : lt(col, nowStamp);
      case "is_overdue": {
        const open =
          entity === "activity"
            ? eq(schema.activities.done, false)
            : entity === "deal"
              ? eq(schema.deals.status, "open")
              : undefined;
        const past = lt(dexpr, today);
        return open ? (and(past, open) as SQL) : past;
      }
      case "in_next_days": {
        const n = daysArg(opName, opSuffix, f.value);
        return and(gte(dexpr, today), lte(dexpr, addDays(today, n))) as SQL;
      }
      default: {
        // in_last_days
        const n = daysArg(opName, opSuffix, f.value);
        return and(gte(dexpr, addDays(today, -n)), lte(dexpr, today)) as SQL;
      }
    }
  }

  throw new ValidationError(
    `Unknown operand "${f.op}". Allowed: eq, ne, gt, gte, lt, lte, contains, in, is_null, not_null, is_today, is_overdue, in_past, in_next_days:N, in_last_days:N.`,
  );
}

function referencesArchived(filters: Filter[]): boolean {
  return filters.some((f) =>
    "or" in f ? f.or.some((c) => c.field === "archived_at") : f.field === "archived_at",
  );
}

export async function searchRecords(
  db: Db,
  input: SearchRecordsInput,
  _actor?: Actor,
): Promise<SearchRecordsResult> {
  const { entity } = input;
  const def = entityDef(entity);
  const nowStamp = nowIso(input.now);
  const today = nowStamp.slice(0, 10);
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const filters = input.filters ?? [];

  const conds: SQL[] = [];

  for (const f of filters) {
    if ("or" in f) {
      if (f.or.length === 0) throw new ValidationError("Empty or-group.");
      conds.push(or(...f.or.map((c) => buildCondition(entity, def, c, today, nowStamp))) as SQL);
    } else {
      conds.push(buildCondition(entity, def, f, today, nowStamp));
    }
  }

  if (input.query) {
    const q = normalizeText(input.query);
    if (q.length > 0) {
      const matchers: SQL[] = [
        ...def.searchNorm.map((c) => like(c, `%${q}%`) as SQL),
        ...def.searchRaw.map((c) => like(sql`lower(${c})`, `%${q}%`) as SQL),
      ];
      conds.push(or(...matchers) as SQL);
    }
  }

  const archivedCol = fieldDef(def, entity, "archived_at").column;
  if (!input.include_archived && !referencesArchived(filters)) {
    conds.push(isNull(archivedCol));
  }

  // sort + keyset cursor (id tiebreak keeps pagination stable under any sort)
  const idCol = fieldDef(def, entity, "id").column;
  let sortField: string | null = null;
  let sortDir: "asc" | "desc" = "asc";
  if (input.sort) {
    if (typeof input.sort === "string") {
      sortField = input.sort.startsWith("-") ? input.sort.slice(1) : input.sort;
      sortDir = input.sort.startsWith("-") ? "desc" : "asc";
    } else {
      sortField = input.sort.field;
      sortDir = input.sort.dir ?? "asc";
    }
  }
  const sortCol = sortField && sortField !== "id" ? fieldDef(def, entity, sortField).column : null;

  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (sortCol) {
      const v = cur.v as string | number | null | undefined;
      if (v === null || v === undefined) {
        // rows with NULL sort key: SQLite orders NULLs first ASC / last DESC
        conds.push(
          sortDir === "asc"
            ? (or(isNotNull(sortCol), and(isNull(sortCol), gt(idCol, cur.i))) as SQL)
            : (and(isNull(sortCol), gt(idCol, cur.i)) as SQL),
        );
      } else {
        conds.push(
          sortDir === "asc"
            ? (or(gt(sortCol, v), and(eq(sortCol, v), gt(idCol, cur.i))) as SQL)
            : (or(
                lt(sortCol, v),
                isNull(sortCol),
                and(eq(sortCol, v), gt(idCol, cur.i)),
              ) as SQL),
        );
      }
    } else {
      conds.push(gt(idCol, cur.i));
    }
  }

  const orderBy = sortCol
    ? [sortDir === "asc" ? asc(sortCol) : desc(sortCol), asc(idCol)]
    : [asc(idCol)];

  const rows = (await db
    .select()
    .from(def.table)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1)
    .all()) as Record<string, unknown>[];

  const page = rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    nextCursor = encodeCursor({
      i: last["id"] as number,
      ...(sortField && sortField !== "id" ? { v: last[sortField === "value" ? "value_cents" : sortField] } : {}),
    });
  }

  return {
    items: page.map((r) => shapeRecord(entity, r)),
    next_cursor: nextCursor,
  };
}
