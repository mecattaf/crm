import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { ValidationError } from "../services/errors";
import { type FieldDef, entityDef } from "../services/registry";
import { parseWith } from "../services/records";
import type { FilterCond, SearchRecordsInput } from "../services/search";
import type { Actor, EntityName } from "../services/types";

/**
 * Query-string -> service-input adapters. Validation itself lives in the
 * services (zod schemas, filter grammar); this module only converts the
 * untyped HTTP surface (strings) into the typed inputs the services expect.
 */

export function actorOf(c: Context<AppEnv>): Actor {
  return { userId: c.var.user.id };
}

/** JSON body or a 400 ValidationError (mapped by the api router's onError). */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

/** Like readJson, but an empty body means {} (verb endpoints with optional args). */
export async function readJsonOrEmpty(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

const boolParam = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const listQuerySchema = z.object({
  query: z.string().optional(),
  sort: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
  include_archived: boolParam.optional(),
});

export const includeArchivedSchema = boolParam;

/** Coerce one filter operand by the registry field kind (strings otherwise). */
function coerceOne(raw: string, fd: FieldDef | undefined, field: string): unknown {
  if (!fd) return raw; // unknown field: the service raises its canonical error
  if (fd.kind === "number" || fd.kind === "money") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new ValidationError(`Filter on "${field}" expects a number (got "${raw}").`);
    }
    return n;
  }
  if (fd.kind === "boolean") return raw === "true" || raw === "1";
  return raw;
}

/**
 * One `filter=` query param: `field:op` or `field:op:value`.
 * Relative-date day counts ride along as the value (`due_date:in_next_days:7`);
 * the `in` operand takes a comma-separated value list.
 */
export function parseFilterParam(entity: EntityName, raw: string): FilterCond {
  const [field, op, ...rest] = raw.split(":");
  if (!field || !op) {
    throw new ValidationError(
      `filter must be "field:op" or "field:op:value" (got "${raw}").`,
    );
  }
  if (rest.length === 0) return { field, op };

  const value = rest.join(":");
  const fd = entityDef(entity).fields[field];
  // day-count argument of relative-date operands: the service Number()s it
  if (op === "in_next_days" || op === "in_last_days") return { field, op, value };
  if (op === "in") {
    return { field, op, value: value.split(",").map((v) => coerceOne(v, fd, field)) };
  }
  return { field, op, value: coerceOne(value, fd, field) };
}

export function parseFilters(c: Context<AppEnv>, entity: EntityName): FilterCond[] {
  return (c.req.queries("filter") ?? []).map((raw) => parseFilterParam(entity, raw));
}

/** GET list query params -> SearchRecordsInput. */
export function parseListQuery(c: Context<AppEnv>, entity: EntityName): SearchRecordsInput {
  const q = parseWith<z.infer<typeof listQuerySchema>>(listQuerySchema, c.req.query());
  return { entity, ...q, filters: parseFilters(c, entity) };
}

/** `include` params (repeatable and/or comma-separated); values validated by getRecord. */
export function parseIncludeParam(c: Context<AppEnv>): string[] {
  return (c.req.queries("include") ?? []).flatMap((v) =>
    v.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
}
