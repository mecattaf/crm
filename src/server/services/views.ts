import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { fxEurMap, toEurCents } from "./forecast";
import { type Ref, resolvePipeline, resolveUser } from "./resolve";
import type { Actor } from "./types";
import { nowIso } from "./types";

/**
 * Named views (SPEC.md tool 12, get_workspace(view)) — canned queries that
 * answer the team's standing questions in one call. All read-only; all accept
 * an injectable `now` (ISO datetime, UTC) for deterministic relative-time math.
 */

const DAY_MS = 86_400_000;

export type RottingFlag = "red" | "amber" | "none";

/** exact (fractional) days since stage_changed_at */
function daysInStage(stageChangedAt: string, now: string): number {
  return (Date.parse(now) - Date.parse(stageChangedAt)) / DAY_MS;
}

/**
 * Rotting per SPEC.md: red = days in stage STRICTLY greater than rot_days,
 * amber = days >= 0.8 * rot_days, else none. rot_days NULL = never rots.
 * Comparisons use exact fractional days; the surfaced days_in_stage is floored.
 */
export function rottingFlag(days: number, rotDays: number | null): RottingFlag {
  if (rotDays === null) return "none";
  if (days > rotDays) return "red";
  if (days >= 0.8 * rotDays) return "amber";
  return "none";
}

const contactFullName = sql<string>`(${schema.contacts.first_name} || ' ' || ${schema.contacts.last_name})`;

// ---------------------------------------------------------------------------
// pipeline_board

export interface PipelineBoardInput {
  pipeline: Ref;
  now?: string;
}

export interface BoardNextActivity {
  id: number;
  subject: string;
  activity_type: string;
  due_date: string;
  due_time: string | null;
}

export interface BoardDeal {
  id: number;
  title: string;
  organization: string | null;
  contact: string | null;
  owner: string | null;
  value: number;
  currency: string;
  days_in_stage: number;
  rotting: RottingFlag;
  next_activity: BoardNextActivity | null;
}

export interface BoardStage {
  id: number;
  name: string;
  position: number;
  rot_days: number | null;
  forecast_weight: number;
  count: number;
  gross_eur: number;
  deals: BoardDeal[];
}

export interface PipelineBoardResult {
  pipeline: { id: number; name: string };
  stages: BoardStage[];
}

export async function pipelineBoard(
  db: Db,
  input: PipelineBoardInput,
  _actor?: Actor,
): Promise<PipelineBoardResult> {
  const now = nowIso(input.now);
  const pipeline = await resolvePipeline(db, input.pipeline);
  const fx = await fxEurMap(db);

  const stages = await db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipeline_id, pipeline.id), isNull(schema.stages.archived_at)))
    .orderBy(asc(schema.stages.position))
    .all();

  const dealRows = await db
    .select({
      id: schema.deals.id,
      title: schema.deals.title,
      stage_id: schema.deals.stage_id,
      value_cents: schema.deals.value_cents,
      currency: schema.deals.currency,
      stage_changed_at: schema.deals.stage_changed_at,
      organization: schema.organizations.name,
      contact: contactFullName,
      owner: schema.users.name,
    })
    .from(schema.deals)
    .leftJoin(schema.organizations, eq(schema.deals.org_id, schema.organizations.id))
    .leftJoin(schema.contacts, eq(schema.deals.contact_id, schema.contacts.id))
    .leftJoin(schema.users, eq(schema.deals.owner_id, schema.users.id))
    .where(
      and(
        eq(schema.deals.pipeline_id, pipeline.id),
        eq(schema.deals.status, "open"),
        isNull(schema.deals.archived_at),
      ),
    )
    .orderBy(asc(schema.deals.id))
    .all();

  // earliest pending activity per deal (one query for the whole board)
  const nextByDeal = new Map<number, BoardNextActivity>();
  if (dealRows.length > 0) {
    const pending = await db
      .select({
        id: schema.activities.id,
        subject: schema.activities.subject,
        activity_type: schema.activities.activity_type,
        due_date: schema.activities.due_date,
        due_time: schema.activities.due_time,
        deal_id: schema.activities.deal_id,
      })
      .from(schema.activities)
      .where(
        and(
          inArray(schema.activities.deal_id, dealRows.map((d) => d.id)),
          eq(schema.activities.done, false),
          isNull(schema.activities.archived_at),
        ),
      )
      .orderBy(
        asc(schema.activities.due_date),
        sql`${schema.activities.due_time} is null`,
        asc(schema.activities.due_time),
        asc(schema.activities.id),
      )
      .all();
    for (const a of pending) {
      if (a.deal_id !== null && !nextByDeal.has(a.deal_id)) {
        const { deal_id: _dealId, ...next } = a;
        nextByDeal.set(a.deal_id, next);
      }
    }
  }

  const boardStages: BoardStage[] = stages.map((stage) => {
    const deals = dealRows
      .filter((d) => d.stage_id === stage.id)
      .map((d): BoardDeal => {
        const days = daysInStage(d.stage_changed_at, now);
        return {
          id: d.id,
          title: d.title,
          organization: d.organization,
          contact: d.contact,
          owner: d.owner,
          value: d.value_cents / 100,
          currency: d.currency,
          days_in_stage: Math.floor(days),
          rotting: rottingFlag(days, stage.rot_days),
          next_activity: nextByDeal.get(d.id) ?? null,
        };
      });
    const grossCents = dealRows
      .filter((d) => d.stage_id === stage.id)
      .reduce((sum, d) => sum + toEurCents(d.value_cents, d.currency, fx), 0);
    return {
      id: stage.id,
      name: stage.name,
      position: stage.position,
      rot_days: stage.rot_days,
      forecast_weight: stage.forecast_weight,
      count: deals.length,
      gross_eur: grossCents / 100,
      deals,
    };
  });

  return { pipeline: { id: pipeline.id, name: pipeline.name }, stages: boardStages };
}

// ---------------------------------------------------------------------------
// overdue_activities

export interface OverdueActivitiesInput {
  /** user name, email or id */
  assignee?: Ref;
  now?: string;
}

export interface OverdueActivity {
  id: number;
  subject: string;
  activity_type: string;
  due_date: string;
  due_time: string | null;
  priority: string;
  assignee: string | null;
  deal: string | null;
  organization: string | null;
  contact: string | null;
}

/** Not-done activities with due date/time in the past, oldest first. */
export async function overdueActivities(
  db: Db,
  input: OverdueActivitiesInput = {},
  _actor?: Actor,
): Promise<OverdueActivity[]> {
  const now = nowIso(input.now);
  const today = now.slice(0, 10);
  const timeNow = now.slice(11, 16); // HH:MM, matches due_time format

  const conds: SQL[] = [
    eq(schema.activities.done, false),
    isNull(schema.activities.archived_at),
    or(
      lt(schema.activities.due_date, today),
      and(
        eq(schema.activities.due_date, today),
        lt(schema.activities.due_time, timeNow), // NULL due_time -> NULL -> false
      ),
    ) as SQL,
  ];
  if (input.assignee !== undefined) {
    const user = await resolveUser(db, input.assignee);
    conds.push(eq(schema.activities.assignee_id, user.id));
  }

  return await db
    .select({
      id: schema.activities.id,
      subject: schema.activities.subject,
      activity_type: schema.activities.activity_type,
      due_date: schema.activities.due_date,
      due_time: schema.activities.due_time,
      priority: schema.activities.priority,
      assignee: schema.users.name,
      deal: schema.deals.title,
      organization: schema.organizations.name,
      contact: contactFullName,
    })
    .from(schema.activities)
    .leftJoin(schema.users, eq(schema.activities.assignee_id, schema.users.id))
    .leftJoin(schema.deals, eq(schema.activities.deal_id, schema.deals.id))
    .leftJoin(schema.organizations, eq(schema.activities.org_id, schema.organizations.id))
    .leftJoin(schema.contacts, eq(schema.activities.contact_id, schema.contacts.id))
    .where(and(...conds))
    .orderBy(
      asc(schema.activities.due_date),
      sql`${schema.activities.due_time} is null`,
      asc(schema.activities.due_time),
      asc(schema.activities.id),
    )
    .all();
}

// ---------------------------------------------------------------------------
// no_next_activity

export interface NoNextActivityInput {
  pipeline?: Ref;
  now?: string;
}

export interface NoNextActivityDeal {
  id: number;
  title: string;
  organization: string | null;
  owner: string | null;
  pipeline: string;
  stage: string;
  value: number;
  currency: string;
  expected_close_date: string | null;
  days_in_stage: number;
}

/** Open deals with zero pending activities — Rani's explicit ask. */
export async function noNextActivity(
  db: Db,
  input: NoNextActivityInput = {},
  _actor?: Actor,
): Promise<NoNextActivityDeal[]> {
  const now = nowIso(input.now);
  const pipeline = input.pipeline != null ? await resolvePipeline(db, input.pipeline) : null;

  const pendingForDeal = db
    .select({ one: sql`1` })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.deal_id, schema.deals.id),
        eq(schema.activities.done, false),
        isNull(schema.activities.archived_at),
      ),
    );

  const conds: SQL[] = [
    eq(schema.deals.status, "open"),
    isNull(schema.deals.archived_at),
    notExists(pendingForDeal),
  ];
  if (pipeline) conds.push(eq(schema.deals.pipeline_id, pipeline.id));

  const rows = await db
    .select({
      id: schema.deals.id,
      title: schema.deals.title,
      organization: schema.organizations.name,
      owner: schema.users.name,
      pipeline: schema.pipelines.name,
      stage: schema.stages.name,
      value_cents: schema.deals.value_cents,
      currency: schema.deals.currency,
      expected_close_date: schema.deals.expected_close_date,
      stage_changed_at: schema.deals.stage_changed_at,
    })
    .from(schema.deals)
    .innerJoin(schema.stages, eq(schema.deals.stage_id, schema.stages.id))
    .innerJoin(schema.pipelines, eq(schema.deals.pipeline_id, schema.pipelines.id))
    .leftJoin(schema.organizations, eq(schema.deals.org_id, schema.organizations.id))
    .leftJoin(schema.users, eq(schema.deals.owner_id, schema.users.id))
    .where(and(...conds))
    .orderBy(asc(schema.deals.id))
    .all();

  return rows.map(({ value_cents, stage_changed_at, ...rest }) => ({
    ...rest,
    value: value_cents / 100,
    days_in_stage: Math.floor(daysInStage(stage_changed_at, now)),
  }));
}

// ---------------------------------------------------------------------------
// stale_deals

export interface StaleDealsInput {
  pipeline?: Ref;
  now?: string;
}

export interface StaleDeal {
  id: number;
  title: string;
  organization: string | null;
  owner: string | null;
  pipeline: string;
  stage: string;
  rot_days: number | null;
  value: number;
  currency: string;
  days_in_stage: number;
  rotting: RottingFlag;
}

/** Open deals rotting red or amber: red first, then by days_in_stage desc. */
export async function staleDeals(
  db: Db,
  input: StaleDealsInput = {},
  _actor?: Actor,
): Promise<StaleDeal[]> {
  const now = nowIso(input.now);
  const pipeline = input.pipeline != null ? await resolvePipeline(db, input.pipeline) : null;

  const conds: SQL[] = [eq(schema.deals.status, "open"), isNull(schema.deals.archived_at)];
  if (pipeline) conds.push(eq(schema.deals.pipeline_id, pipeline.id));

  const rows = await db
    .select({
      id: schema.deals.id,
      title: schema.deals.title,
      organization: schema.organizations.name,
      owner: schema.users.name,
      pipeline: schema.pipelines.name,
      stage: schema.stages.name,
      rot_days: schema.stages.rot_days,
      value_cents: schema.deals.value_cents,
      currency: schema.deals.currency,
      stage_changed_at: schema.deals.stage_changed_at,
    })
    .from(schema.deals)
    .innerJoin(schema.stages, eq(schema.deals.stage_id, schema.stages.id))
    .innerJoin(schema.pipelines, eq(schema.deals.pipeline_id, schema.pipelines.id))
    .leftJoin(schema.organizations, eq(schema.deals.org_id, schema.organizations.id))
    .leftJoin(schema.users, eq(schema.deals.owner_id, schema.users.id))
    .where(and(...conds))
    .all();

  const stale: (StaleDeal & { exact_days: number })[] = [];
  for (const row of rows) {
    const days = daysInStage(row.stage_changed_at, now);
    const flag = rottingFlag(days, row.rot_days);
    if (flag === "none") continue;
    const { value_cents, stage_changed_at: _sca, ...rest } = row;
    stale.push({
      ...rest,
      value: value_cents / 100,
      days_in_stage: Math.floor(days),
      rotting: flag,
      exact_days: days,
    });
  }

  stale.sort((a, b) => {
    if (a.rotting !== b.rotting) return a.rotting === "red" ? -1 : 1;
    if (a.exact_days !== b.exact_days) return b.exact_days - a.exact_days;
    return a.id - b.id;
  });
  return stale.map(({ exact_days: _d, ...deal }) => deal);
}

// ---------------------------------------------------------------------------
// recent_activity

export interface RecentActivityInput {
  /** look-back window, default 7 */
  days?: number;
  now?: string;
}

export interface RecentActivityItem {
  id: number;
  entity: string;
  entity_id: number;
  /** display name of the touched record (null if since hard-deleted) */
  entity_label: string | null;
  kind: string;
  payload: unknown;
  actor: string | null;
  created_at: string;
}

const RECENT_ACTIVITY_CAP = 100;

async function entityLabels(db: Db, entity: string, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  switch (entity) {
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
        .select({ id: schema.contacts.id, label: contactFullName })
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
    case "activity": {
      const rows = await db
        .select({ id: schema.activities.id, label: schema.activities.subject })
        .from(schema.activities)
        .where(inArray(schema.activities.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label]));
    }
    case "note": {
      const rows = await db
        .select({ id: schema.notes.id, label: schema.notes.body })
        .from(schema.notes)
        .where(inArray(schema.notes.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.label.slice(0, 40)]));
    }
    default:
      return new Map();
  }
}

/** Events log joined to entity display names, newest first, capped at 100. */
export async function recentActivity(
  db: Db,
  input: RecentActivityInput = {},
  _actor?: Actor,
): Promise<RecentActivityItem[]> {
  const days = input.days ?? 7;
  if (!Number.isInteger(days) || days < 1) {
    throw new ValidationError("days must be a positive integer.");
  }
  const now = nowIso(input.now);
  const since = new Date(Date.parse(now) - days * DAY_MS).toISOString();

  const rows = await db
    .select({
      id: schema.events.id,
      entity: schema.events.entity,
      entity_id: schema.events.entity_id,
      kind: schema.events.kind,
      payload: schema.events.payload,
      actor: schema.users.name,
      created_at: schema.events.created_at,
    })
    .from(schema.events)
    .leftJoin(schema.users, eq(schema.events.actor_user_id, schema.users.id))
    .where(gte(schema.events.created_at, since))
    .orderBy(desc(schema.events.created_at), desc(schema.events.id))
    .limit(RECENT_ACTIVITY_CAP)
    .all();

  const idsByEntity = new Map<string, number[]>();
  for (const r of rows) {
    const ids = idsByEntity.get(r.entity) ?? [];
    ids.push(r.entity_id);
    idsByEntity.set(r.entity, ids);
  }
  const labels = new Map<string, Map<number, string>>();
  for (const [entity, ids] of idsByEntity) {
    labels.set(entity, await entityLabels(db, entity, [...new Set(ids)]));
  }

  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    entity_id: r.entity_id,
    entity_label: labels.get(r.entity)?.get(r.entity_id) ?? null,
    kind: r.kind,
    payload: r.payload ? JSON.parse(r.payload) : null,
    actor: r.actor,
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// my_day

export interface MyDayInput {
  /** user name, email or id */
  user: Ref;
  /** YYYY-MM-DD; defaults to today derived from `now` */
  date?: string;
  now?: string;
}

export interface MyDayItem {
  id: number;
  subject: string;
  activity_type: string;
  due_time: string | null;
  duration_min: number | null;
  priority: string;
  done: boolean;
  deal: string | null;
  organization: string | null;
  contact: string | null;
}

export interface MyDayResult {
  user: { id: number; name: string };
  date: string;
  /** activities due that date (done ones included, flagged), due_time NULLs last */
  items: MyDayItem[];
  /** pending activities of this user due before `date` */
  overdue_count: number;
}

export async function myDay(db: Db, input: MyDayInput, _actor?: Actor): Promise<MyDayResult> {
  const now = nowIso(input.now);
  const date = input.date ?? now.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`date must be YYYY-MM-DD (got "${date}").`);
  }
  const user = await resolveUser(db, input.user);

  const items = await db
    .select({
      id: schema.activities.id,
      subject: schema.activities.subject,
      activity_type: schema.activities.activity_type,
      due_time: schema.activities.due_time,
      duration_min: schema.activities.duration_min,
      priority: schema.activities.priority,
      done: schema.activities.done,
      deal: schema.deals.title,
      organization: schema.organizations.name,
      contact: contactFullName,
    })
    .from(schema.activities)
    .leftJoin(schema.deals, eq(schema.activities.deal_id, schema.deals.id))
    .leftJoin(schema.organizations, eq(schema.activities.org_id, schema.organizations.id))
    .leftJoin(schema.contacts, eq(schema.activities.contact_id, schema.contacts.id))
    .where(
      and(
        eq(schema.activities.assignee_id, user.id),
        eq(schema.activities.due_date, date),
        isNull(schema.activities.archived_at),
      ),
    )
    .orderBy(
      sql`${schema.activities.due_time} is null`,
      asc(schema.activities.due_time),
      asc(schema.activities.id),
    )
    .all();

  const overdue = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.assignee_id, user.id),
        eq(schema.activities.done, false),
        isNull(schema.activities.archived_at),
        lt(schema.activities.due_date, date),
      ),
    )
    .get();

  return {
    user: { id: user.id, name: user.name },
    date,
    items,
    overdue_count: overdue?.count ?? 0,
  };
}
