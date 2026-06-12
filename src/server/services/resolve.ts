import { and, eq, isNull, like, sql } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { AmbiguousError, NotFoundError } from "./errors";
import { normalizeText } from "./normalize";
import type { EntityName } from "./types";

/**
 * Name resolution: every reference (pipeline, stage, user, org, contact, deal,
 * activity) is resolvable by integer id, numeric string, or human-readable
 * name. Names match accent-insensitively: exact normalized match first, then
 * substring; >1 hit raises AmbiguousError listing the candidates.
 * Archived records are excluded from name lookups (still reachable by id).
 */
export type Ref = number | string;

export function isIdRef(ref: Ref): boolean {
  return typeof ref === "number" || /^\d+$/.test(ref.trim());
}

function toId(ref: Ref): number {
  return typeof ref === "number" ? ref : Number.parseInt(ref, 10);
}

function pickOne<T extends { id: number }>(
  rows: T[],
  what: string,
  ref: Ref,
  label: (row: T) => string,
): T {
  if (rows.length === 1) return rows[0]!;
  if (rows.length === 0) throw new NotFoundError(`No ${what} matches "${ref}".`);
  throw new AmbiguousError(
    `Multiple ${what}s match "${ref}" — use the id.`,
    rows.map((r) => ({ id: r.id, label: label(r) })),
  );
}

export async function resolvePipeline(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.pipelines).where(eq(schema.pipelines.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No pipeline with id ${ref}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const alive = isNull(schema.pipelines.archived_at);
  let rows = await db.select().from(schema.pipelines)
    .where(and(eq(schema.pipelines.name_norm, q), alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.pipelines)
      .where(and(like(schema.pipelines.name_norm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "pipeline", ref, (r) => r.name);
}

/** Stage names resolve within one pipeline (per move_deal semantics). */
export async function resolveStage(db: Db, ref: Ref, pipelineId: number) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.stages)
      .where(and(eq(schema.stages.id, toId(ref)), eq(schema.stages.pipeline_id, pipelineId))).get();
    if (!row) throw new NotFoundError(`No stage with id ${ref} in pipeline ${pipelineId}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const scope = and(eq(schema.stages.pipeline_id, pipelineId), isNull(schema.stages.archived_at));
  let rows = await db.select().from(schema.stages)
    .where(and(eq(schema.stages.name_norm, q), scope)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.stages)
      .where(and(like(schema.stages.name_norm, `%${q}%`), scope)).all();
  }
  return pickOne(rows, "stage", ref, (r) => r.name);
}

/** Users resolve by id, exact email, or name. */
export async function resolveUser(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.users).where(eq(schema.users.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No user with id ${ref}.`);
    return row;
  }
  const raw = String(ref).trim().toLowerCase();
  const alive = isNull(schema.users.archived_at);
  const byEmail = await db.select().from(schema.users)
    .where(and(eq(sql`lower(${schema.users.email})`, raw), alive)).all();
  if (byEmail.length === 1) return byEmail[0]!;
  const q = normalizeText(String(ref));
  let rows = await db.select().from(schema.users)
    .where(and(eq(schema.users.name_norm, q), alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.users)
      .where(and(like(schema.users.name_norm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "user", ref, (r) => `${r.name} <${r.email}>`);
}

export async function resolveOrganization(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.organizations)
      .where(eq(schema.organizations.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No organization with id ${ref}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const alive = isNull(schema.organizations.archived_at);
  let rows = await db.select().from(schema.organizations)
    .where(and(eq(schema.organizations.name_norm, q), alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.organizations)
      .where(and(like(schema.organizations.name_norm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "organization", ref, (r) => r.name);
}

export async function resolveContact(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.contacts).where(eq(schema.contacts.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No contact with id ${ref}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const alive = isNull(schema.contacts.archived_at);
  const fullNorm = sql`(${schema.contacts.first_name_norm} || ' ' || ${schema.contacts.last_name_norm})`;
  let rows = await db.select().from(schema.contacts)
    .where(and(sql`(${fullNorm} = ${q} OR ${schema.contacts.last_name_norm} = ${q})`, alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.contacts)
      .where(and(like(fullNorm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "contact", ref, (r) => `${r.first_name} ${r.last_name}`);
}

export async function resolveDeal(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.deals).where(eq(schema.deals.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No deal with id ${ref}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const alive = isNull(schema.deals.archived_at);
  let rows = await db.select().from(schema.deals)
    .where(and(eq(schema.deals.title_norm, q), alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.deals)
      .where(and(like(schema.deals.title_norm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "deal", ref, (r) => r.title);
}

export async function resolveActivity(db: Db, ref: Ref) {
  if (isIdRef(ref)) {
    const row = await db.select().from(schema.activities)
      .where(eq(schema.activities.id, toId(ref))).get();
    if (!row) throw new NotFoundError(`No activity with id ${ref}.`);
    return row;
  }
  const q = normalizeText(String(ref));
  const alive = isNull(schema.activities.archived_at);
  let rows = await db.select().from(schema.activities)
    .where(and(eq(schema.activities.subject_norm, q), alive)).all();
  if (rows.length === 0) {
    rows = await db.select().from(schema.activities)
      .where(and(like(schema.activities.subject_norm, `%${q}%`), alive)).all();
  }
  return pickOne(rows, "activity", ref, (r) => r.subject);
}

export async function resolveNote(db: Db, ref: Ref) {
  if (!isIdRef(ref)) throw new NotFoundError(`Notes are only addressable by id (got "${ref}").`);
  const row = await db.select().from(schema.notes).where(eq(schema.notes.id, toId(ref))).get();
  if (!row) throw new NotFoundError(`No note with id ${ref}.`);
  return row;
}

/** Resolve a record reference for get/update/archive/delete on any entity. */
export async function resolveEntityRecord(
  db: Db,
  entity: EntityName,
  ref: Ref,
): Promise<Record<string, unknown> & { id: number }> {
  switch (entity) {
    case "organization":
      return resolveOrganization(db, ref);
    case "contact":
      return resolveContact(db, ref);
    case "deal":
      return resolveDeal(db, ref);
    case "activity":
      return resolveActivity(db, ref);
    case "note":
      return resolveNote(db, ref);
  }
}
