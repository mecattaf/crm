import { and, asc, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "./errors";
import { eventStmt } from "./events";
import { normalizeText } from "./normalize";
import { type EntityDef, entityDef } from "./registry";
import {
  type Ref,
  resolveContact,
  resolveDeal,
  resolveEntityRecord,
  resolveOrganization,
  resolvePipeline,
  resolveStage,
  resolveUser,
} from "./resolve";
import { createSchemas, patchSchemas } from "./schemas";
import type { Actor, EntityName, ServiceRecord } from "./types";
import { nowIso } from "./types";

type Data = Record<string, unknown>;

const MAX_BATCH = 50;

// ---------------------------------------------------------------------------
// shared plumbing

export function parseWith<T = Data>(zodSchema: z.ZodType, value: unknown): T {
  const result = zodSchema.safeParse(value);
  if (!result.success) throw new ValidationError(z.prettifyError(result.error));
  return result.data as T;
}

/** Output shape: *_norm stripped; deals expose decimal `value` instead of cents. */
export function shapeRecord(entity: EntityName, row: Data): ServiceRecord {
  const def = entityDef(entity);
  const out: Data = { ...row };
  for (const normCol of Object.values(def.normSources)) delete out[normCol];
  if (entity === "deal") {
    out["value"] = (row["value_cents"] as number) / 100;
    delete out["value_cents"];
  }
  return out as ServiceRecord;
}

function idColumn(def: EntityDef): SQLiteColumn {
  const field = def.fields["id"];
  if (!field) throw new Error("registry entity is missing an id field");
  return field.column;
}

// The registry makes tables dynamic, which drizzle's generics cannot follow —
// these three helpers are the single deliberately-loose seam.
function insertReturning(db: Db, table: SQLiteTable, row: Data) {
  return db.insert(table).values(row as never).returning();
}

function updateReturning(db: Db, table: SQLiteTable, idCol: SQLiteColumn, id: number, values: Data) {
  return db.update(table).set(values as never).where(eq(idCol, id)).returning();
}

async function runBatch(db: Db, stmts: unknown[]): Promise<unknown[]> {
  return (await db.batch(
    stmts as unknown as readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  )) as unknown as unknown[];
}

async function resolveRefId(db: Db, target: string, ref: Ref): Promise<number> {
  switch (target) {
    case "user":
      return (await resolveUser(db, ref)).id;
    case "organization":
      return (await resolveOrganization(db, ref)).id;
    case "contact":
      return (await resolveContact(db, ref)).id;
    case "deal":
      return (await resolveDeal(db, ref)).id;
    case "pipeline":
      return (await resolvePipeline(db, ref)).id;
    default:
      throw new Error(`unexpected ref target ${target}`);
  }
}

/** Convert name-reference input fields into *_id columns (pipeline/stage are deal-specific, handled in prepareDeal). */
async function applyRefs(db: Db, def: EntityDef, data: Data): Promise<Data> {
  const out: Data = { ...data };
  for (const [field, refDef] of Object.entries(def.refs)) {
    if (!(field in out)) continue;
    if (refDef.target === "pipeline" || refDef.target === "stage") continue;
    const value = out[field];
    delete out[field];
    out[refDef.column] = value === null || value === undefined
      ? null
      : await resolveRefId(db, refDef.target, value as Ref);
  }
  return out;
}

function applyNorms(def: EntityDef, data: Data): void {
  for (const [source, normCol] of Object.entries(def.normSources)) {
    if (source in data && data[source] != null) {
      data[normCol] = normalizeText(String(data[source]));
    }
  }
}

async function defaultPipeline(db: Db) {
  const row = await db
    .select()
    .from(schema.pipelines)
    .where(isNull(schema.pipelines.archived_at))
    .orderBy(asc(schema.pipelines.position))
    .limit(1)
    .get();
  if (!row) throw new NotFoundError("No pipelines exist.");
  return row;
}

async function firstStage(db: Db, pipelineId: number) {
  const row = await db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipeline_id, pipelineId), isNull(schema.stages.archived_at)))
    .orderBy(asc(schema.stages.position))
    .limit(1)
    .get();
  if (!row) throw new NotFoundError(`Pipeline ${pipelineId} has no stages.`);
  return row;
}

function moneyToCents(value: unknown): number {
  return Math.round((value as number) * 100);
}

async function prepareCreate(
  db: Db,
  entity: EntityName,
  raw: Data,
  actor: Actor,
  now: string,
): Promise<Data> {
  const def = entityDef(entity);
  const parsed = parseWith(createSchemas[entity], raw);
  const row = await applyRefs(db, def, parsed);

  if (entity === "deal") {
    const pipeline =
      row["pipeline"] != null ? await resolvePipeline(db, row["pipeline"] as Ref) : await defaultPipeline(db);
    const stage =
      row["stage"] != null
        ? await resolveStage(db, row["stage"] as Ref, pipeline.id)
        : await firstStage(db, pipeline.id);
    delete row["pipeline"];
    delete row["stage"];
    row["pipeline_id"] = pipeline.id;
    row["stage_id"] = stage.id;
    row["value_cents"] = row["value"] == null ? 0 : moneyToCents(row["value"]);
    delete row["value"];
    row["stage_changed_at"] = now;
  }

  if (entity === "activity" && row["assignee_id"] === undefined) {
    row["assignee_id"] = actor.userId;
  }

  if (entity === "note") {
    if (row["author_id"] === undefined || row["author_id"] === null) {
      row["author_id"] = actor.userId;
    }
    if (row["deal_id"] == null && row["org_id"] == null && row["contact_id"] == null) {
      throw new ValidationError(
        "A note must be linked to at least one of: deal, organization, contact.",
      );
    }
  }

  applyNorms(def, row);
  row["created_at"] = now;
  row["updated_at"] = now;
  return row;
}

// ---------------------------------------------------------------------------
// create

export interface CreateRecordInput {
  entity: EntityName;
  /** single object or heterogeneous batch */
  data: Data | Data[];
  now?: string;
}

export async function createRecord(
  db: Db,
  input: CreateRecordInput,
  actor: Actor,
): Promise<ServiceRecord | ServiceRecord[]> {
  const { entity } = input;
  const def = entityDef(entity);
  const isBatch = Array.isArray(input.data);
  const items = Array.isArray(input.data) ? input.data : [input.data];
  if (items.length === 0) throw new ValidationError("data[] must not be empty.");
  if (items.length > MAX_BATCH) throw new ValidationError(`Batch create is limited to ${MAX_BATCH} records.`);
  const now = nowIso(input.now);

  const rows: Data[] = [];
  for (const item of items) rows.push(await prepareCreate(db, entity, item, actor, now));

  // Interleave [insert, event] pairs: the event row binds last_insert_rowid()
  // of the insert immediately before it, atomically within one batch.
  const stmts: unknown[] = [];
  for (const row of rows) {
    stmts.push(insertReturning(db, def.table, row));
    stmts.push(
      eventStmt(db, { entity, kind: "created", payload: { data: shapeRecord(entity, row) }, actor, now }),
    );
  }
  const results = await runBatch(db, stmts);

  const created: ServiceRecord[] = [];
  for (let i = 0; i < results.length; i += 2) {
    const inserted = (results[i] as Data[])[0];
    if (!inserted) throw new Error("insert returned no row");
    created.push(shapeRecord(entity, inserted));
  }
  return isBatch ? created : created[0]!;
}

// ---------------------------------------------------------------------------
// update

export interface UpdateRecordInput {
  entity: EntityName;
  id?: Ref;
  patch?: Data;
  /** heterogeneous bulk update */
  items?: { id: Ref; patch: Data }[];
  now?: string;
}

export async function updateRecord(
  db: Db,
  input: UpdateRecordInput,
  actor: Actor,
): Promise<ServiceRecord | ServiceRecord[]> {
  const { entity } = input;
  const def = entityDef(entity);
  const isBulk = input.items !== undefined;
  const items = input.items ?? (input.id !== undefined && input.patch !== undefined
    ? [{ id: input.id, patch: input.patch }]
    : undefined);
  if (!items || items.length === 0) {
    throw new ValidationError("update_record needs either (id, patch) or items: [{id, patch}].");
  }
  if (items.length > MAX_BATCH) throw new ValidationError(`Bulk update is limited to ${MAX_BATCH} records.`);
  const now = nowIso(input.now);

  const stmts: unknown[] = [];
  for (const item of items) {
    if (entity === "deal") {
      for (const key of ["pipeline", "stage", "status", "lost_reason"]) {
        if (key in item.patch) {
          throw new ValidationError(`"${key}" cannot be patched directly — use move_deal.`);
        }
      }
    }
    const parsed = parseWith(patchSchemas[entity], item.patch);
    if (Object.keys(parsed).length === 0) {
      throw new ValidationError(`Empty patch for ${entity} ${item.id}.`);
    }
    const current = await resolveEntityRecord(db, entity, item.id);
    const values = await applyRefs(db, def, parsed);
    if (entity === "deal" && "value" in values) {
      values["value_cents"] = values["value"] == null ? 0 : moneyToCents(values["value"]);
      delete values["value"];
    }
    if (entity === "note") {
      const linked = (col: string) =>
        (col in values ? values[col] : (current as Data)[col]) != null;
      if (!linked("deal_id") && !linked("org_id") && !linked("contact_id")) {
        throw new ValidationError(
          "A note must stay linked to at least one of: deal, organization, contact.",
        );
      }
    }
    applyNorms(def, values);
    values["updated_at"] = now;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, to] of Object.entries(values)) {
      if (key === "updated_at" || Object.values(def.normSources).includes(key)) continue;
      changes[key] = { from: (current as Data)[key], to };
    }

    stmts.push(updateReturning(db, def.table, idColumn(def), current.id, values));
    stmts.push(eventStmt(db, { entity, entityId: current.id, kind: "updated", payload: { changes }, actor, now }));
  }

  const results = await runBatch(db, stmts);
  const updated: ServiceRecord[] = [];
  for (let i = 0; i < results.length; i += 2) {
    const row = (results[i] as Data[])[0];
    if (!row) throw new Error("update returned no row");
    updated.push(shapeRecord(entity, row));
  }
  return isBulk ? updated : updated[0]!;
}

// ---------------------------------------------------------------------------
// archive (soft) / delete (confirm-gated, never batched)

export interface ArchiveRecordInput {
  entity: EntityName;
  id: Ref;
  now?: string;
}

export async function archiveRecord(
  db: Db,
  input: ArchiveRecordInput,
  actor: Actor,
): Promise<ServiceRecord> {
  const { entity } = input;
  const def = entityDef(entity);
  const now = nowIso(input.now);
  const current = await resolveEntityRecord(db, entity, input.id);
  if ((current as Data)["archived_at"] != null) return shapeRecord(entity, current);

  const results = await runBatch(db, [
    updateReturning(db, def.table, idColumn(def), current.id, { archived_at: now, updated_at: now }),
    eventStmt(db, { entity, entityId: current.id, kind: "archived", actor, now }),
  ]);
  const row = (results[0] as Data[])[0];
  if (!row) throw new Error("archive returned no row");
  return shapeRecord(entity, row);
}

export interface DeleteRecordInput {
  entity: EntityName;
  id: Ref;
  confirm?: boolean;
  now?: string;
}

export async function deleteRecord(
  db: Db,
  input: DeleteRecordInput,
  actor: Actor,
): Promise<{ deleted: true; record: ServiceRecord }> {
  if (input.confirm !== true) {
    throw new ValidationError(
      "delete_record permanently destroys data and requires confirm: true. Consider archive_record instead.",
    );
  }
  const { entity } = input;
  const def = entityDef(entity);
  const now = nowIso(input.now);
  const current = await resolveEntityRecord(db, entity, input.id);
  const record = shapeRecord(entity, current);

  await runBatch(db, [
    db.delete(def.table).where(eq(idColumn(def), current.id)),
    eventStmt(db, { entity, entityId: current.id, kind: "deleted", payload: { data: record }, actor, now }),
  ]);
  return { deleted: true, record };
}

// ---------------------------------------------------------------------------
// get (with include assembly)

export type IncludeName = "timeline" | "activities" | "notes" | "deals" | "contacts";

const ALLOWED_INCLUDES: Record<EntityName, IncludeName[]> = {
  organization: ["contacts", "deals", "activities", "notes", "timeline"],
  contact: ["deals", "activities", "notes", "timeline"],
  deal: ["activities", "notes", "timeline"],
  activity: ["timeline"],
  note: ["timeline"],
};

/** FK column linking notes/activities/deals to a parent record. */
const PARENT_FK: Partial<Record<EntityName, "org_id" | "contact_id" | "deal_id">> = {
  organization: "org_id",
  contact: "contact_id",
  deal: "deal_id",
};

export interface GetRecordInput {
  entity: EntityName;
  id: Ref;
  include?: IncludeName[];
}

export interface TimelineItem {
  type: "event" | "note" | "activity";
  at: string;
  data: Data;
}

export async function getRecord(
  db: Db,
  input: GetRecordInput,
  _actor?: Actor,
): Promise<ServiceRecord> {
  const { entity } = input;
  const current = await resolveEntityRecord(db, entity, input.id);
  const out = shapeRecord(entity, current);
  const include = input.include ?? [];

  for (const inc of include) {
    if (!ALLOWED_INCLUDES[entity].includes(inc)) {
      throw new ValidationError(
        `include "${inc}" is not valid for ${entity}. Allowed: ${ALLOWED_INCLUDES[entity].join(", ")}.`,
      );
    }
  }
  const id = current.id;
  const fk = PARENT_FK[entity];

  if (include.includes("contacts") && entity === "organization") {
    const rows = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.org_id, id), isNull(schema.contacts.archived_at)))
      .orderBy(asc(schema.contacts.id)).all();
    out["contacts"] = rows.map((r) => shapeRecord("contact", r));
  }
  if (include.includes("deals") && fk) {
    const col = fk === "org_id" ? schema.deals.org_id : schema.deals.contact_id;
    const rows = await db.select().from(schema.deals)
      .where(and(eq(col, id), isNull(schema.deals.archived_at)))
      .orderBy(asc(schema.deals.id)).all();
    out["deals"] = rows.map((r) => shapeRecord("deal", r));
  }
  if (include.includes("activities") && fk) {
    const rows = await db.select().from(schema.activities)
      .where(and(eq(schema.activities[fk], id), isNull(schema.activities.archived_at)))
      .orderBy(asc(schema.activities.id)).all();
    out["activities"] = rows.map((r) => shapeRecord("activity", r));
  }
  if (include.includes("notes") && fk) {
    const rows = await db.select().from(schema.notes)
      .where(and(eq(schema.notes[fk], id), isNull(schema.notes.archived_at)))
      .orderBy(asc(schema.notes.id)).all();
    out["notes"] = rows.map((r) => shapeRecord("note", r));
  }
  if (include.includes("timeline")) {
    out["timeline"] = await assembleTimeline(db, entity, id);
  }
  return out;
}

/** timeline = events ∪ notes ∪ activities, merged at read time (SPEC.md). */
export async function assembleTimeline(
  db: Db,
  entity: EntityName,
  id: number,
): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];

  const evts = await db.select().from(schema.events)
    .where(and(eq(schema.events.entity, entity), eq(schema.events.entity_id, id)))
    .orderBy(asc(schema.events.id)).all();
  for (const e of evts) {
    items.push({
      type: "event",
      at: e.created_at,
      data: {
        id: e.id,
        kind: e.kind,
        payload: e.payload ? JSON.parse(e.payload) : null,
        actor_user_id: e.actor_user_id,
      },
    });
  }

  const fk = PARENT_FK[entity];
  if (fk) {
    const noteRows = await db.select().from(schema.notes)
      .where(and(eq(schema.notes[fk], id), isNull(schema.notes.archived_at)))
      .orderBy(asc(schema.notes.id)).all();
    for (const n of noteRows) {
      items.push({ type: "note", at: n.created_at, data: shapeRecord("note", n) });
    }
    const actRows = await db.select().from(schema.activities)
      .where(and(eq(schema.activities[fk], id), isNull(schema.activities.archived_at)))
      .orderBy(asc(schema.activities.id)).all();
    for (const a of actRows) {
      items.push({ type: "activity", at: a.created_at, data: shapeRecord("activity", a) });
    }
  }

  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return items;
}
