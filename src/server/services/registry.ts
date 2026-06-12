import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import type { EntityName } from "./types";

/**
 * Static metadata driving the generic record services (create/get/update/
 * archive/delete/search). Field kinds drive filter-operand typing; `norm`
 * points at the accent-insensitive companion column when one exists.
 */
export type FieldKind = "string" | "number" | "boolean" | "date" | "datetime" | "money";

export interface FieldDef {
  column: SQLiteColumn;
  kind: FieldKind;
  /** companion *_norm column used for `contains` + fuzzy query matching */
  norm?: SQLiteColumn;
}

/** input reference field -> { column written, target entity for resolution } */
export interface RefDef {
  column: string;
  target: "user" | "organization" | "contact" | "deal" | "pipeline" | "stage";
}

export interface EntityDef {
  table: SQLiteTable;
  /** filterable / sortable fields (whitelist) */
  fields: Record<string, FieldDef>;
  /** norm columns matched against normalized `query` */
  searchNorm: SQLiteColumn[];
  /** raw columns matched with lower(col) LIKE against `query` */
  searchRaw: SQLiteColumn[];
  /** *_norm columns to strip from output, keyed by their source field */
  normSources: Record<string, string>;
  /** name-reference input fields accepted by create/update */
  refs: Record<string, RefDef>;
  label: (row: Record<string, unknown>) => string;
}

const { organizations, contacts, deals, activities, notes } = schema;

export const registry: Record<EntityName, EntityDef> = {
  organization: {
    table: organizations,
    fields: {
      id: { column: organizations.id, kind: "number" },
      name: { column: organizations.name, kind: "string", norm: organizations.name_norm },
      client_code: { column: organizations.client_code, kind: "string" },
      category: { column: organizations.category, kind: "string" },
      org_type: { column: organizations.org_type, kind: "string" },
      address: { column: organizations.address, kind: "string" },
      delivery_address: { column: organizations.delivery_address, kind: "string" },
      accise_1: { column: organizations.accise_1, kind: "string" },
      accise_2: { column: organizations.accise_2, kind: "string" },
      owner_id: { column: organizations.owner_id, kind: "number" },
      created_at: { column: organizations.created_at, kind: "datetime" },
      updated_at: { column: organizations.updated_at, kind: "datetime" },
      archived_at: { column: organizations.archived_at, kind: "datetime" },
    },
    searchNorm: [organizations.name_norm],
    searchRaw: [
      organizations.client_code,
      organizations.category,
      organizations.address,
      organizations.delivery_address,
    ],
    normSources: { name: "name_norm" },
    refs: { owner: { column: "owner_id", target: "user" } },
    label: (row) => String(row["name"]),
  },

  contact: {
    table: contacts,
    fields: {
      id: { column: contacts.id, kind: "number" },
      first_name: { column: contacts.first_name, kind: "string", norm: contacts.first_name_norm },
      last_name: { column: contacts.last_name, kind: "string", norm: contacts.last_name_norm },
      org_id: { column: contacts.org_id, kind: "number" },
      email: { column: contacts.email, kind: "string" },
      phone: { column: contacts.phone, kind: "string" },
      job_title: { column: contacts.job_title, kind: "string" },
      owner_id: { column: contacts.owner_id, kind: "number" },
      created_at: { column: contacts.created_at, kind: "datetime" },
      updated_at: { column: contacts.updated_at, kind: "datetime" },
      archived_at: { column: contacts.archived_at, kind: "datetime" },
    },
    searchNorm: [contacts.first_name_norm, contacts.last_name_norm],
    searchRaw: [contacts.email, contacts.phone, contacts.job_title],
    normSources: { first_name: "first_name_norm", last_name: "last_name_norm" },
    refs: {
      organization: { column: "org_id", target: "organization" },
      owner: { column: "owner_id", target: "user" },
    },
    label: (row) => `${row["first_name"]} ${row["last_name"]}`,
  },

  deal: {
    table: deals,
    fields: {
      id: { column: deals.id, kind: "number" },
      title: { column: deals.title, kind: "string", norm: deals.title_norm },
      org_id: { column: deals.org_id, kind: "number" },
      contact_id: { column: deals.contact_id, kind: "number" },
      pipeline_id: { column: deals.pipeline_id, kind: "number" },
      stage_id: { column: deals.stage_id, kind: "number" },
      value: { column: deals.value_cents, kind: "money" },
      currency: { column: deals.currency, kind: "string" },
      expected_close_date: { column: deals.expected_close_date, kind: "date" },
      status: { column: deals.status, kind: "string" },
      lost_reason: { column: deals.lost_reason, kind: "string" },
      label: { column: deals.label, kind: "string" },
      owner_id: { column: deals.owner_id, kind: "number" },
      stage_changed_at: { column: deals.stage_changed_at, kind: "datetime" },
      won_at: { column: deals.won_at, kind: "datetime" },
      lost_at: { column: deals.lost_at, kind: "datetime" },
      created_at: { column: deals.created_at, kind: "datetime" },
      updated_at: { column: deals.updated_at, kind: "datetime" },
      archived_at: { column: deals.archived_at, kind: "datetime" },
    },
    searchNorm: [deals.title_norm],
    searchRaw: [deals.label],
    normSources: { title: "title_norm" },
    refs: {
      organization: { column: "org_id", target: "organization" },
      contact: { column: "contact_id", target: "contact" },
      owner: { column: "owner_id", target: "user" },
      pipeline: { column: "pipeline_id", target: "pipeline" },
      stage: { column: "stage_id", target: "stage" },
    },
    label: (row) => String(row["title"]),
  },

  activity: {
    table: activities,
    fields: {
      id: { column: activities.id, kind: "number" },
      subject: { column: activities.subject, kind: "string", norm: activities.subject_norm },
      activity_type: { column: activities.activity_type, kind: "string" },
      due_date: { column: activities.due_date, kind: "date" },
      due_time: { column: activities.due_time, kind: "string" },
      duration_min: { column: activities.duration_min, kind: "number" },
      priority: { column: activities.priority, kind: "string" },
      done: { column: activities.done, kind: "boolean" },
      done_at: { column: activities.done_at, kind: "datetime" },
      assignee_id: { column: activities.assignee_id, kind: "number" },
      deal_id: { column: activities.deal_id, kind: "number" },
      org_id: { column: activities.org_id, kind: "number" },
      contact_id: { column: activities.contact_id, kind: "number" },
      created_at: { column: activities.created_at, kind: "datetime" },
      updated_at: { column: activities.updated_at, kind: "datetime" },
      archived_at: { column: activities.archived_at, kind: "datetime" },
    },
    searchNorm: [activities.subject_norm],
    searchRaw: [activities.note],
    normSources: { subject: "subject_norm" },
    refs: {
      assignee: { column: "assignee_id", target: "user" },
      deal: { column: "deal_id", target: "deal" },
      organization: { column: "org_id", target: "organization" },
      contact: { column: "contact_id", target: "contact" },
    },
    label: (row) => String(row["subject"]),
  },

  note: {
    table: notes,
    fields: {
      id: { column: notes.id, kind: "number" },
      body: { column: notes.body, kind: "string", norm: notes.body_norm },
      author_id: { column: notes.author_id, kind: "number" },
      deal_id: { column: notes.deal_id, kind: "number" },
      org_id: { column: notes.org_id, kind: "number" },
      contact_id: { column: notes.contact_id, kind: "number" },
      created_at: { column: notes.created_at, kind: "datetime" },
      updated_at: { column: notes.updated_at, kind: "datetime" },
      archived_at: { column: notes.archived_at, kind: "datetime" },
    },
    searchNorm: [notes.body_norm],
    searchRaw: [],
    normSources: { body: "body_norm" },
    refs: {
      author: { column: "author_id", target: "user" },
      deal: { column: "deal_id", target: "deal" },
      organization: { column: "org_id", target: "organization" },
      contact: { column: "contact_id", target: "contact" },
    },
    label: (row) => String(row["body"]).slice(0, 40),
  },
};

export function entityDef(entity: EntityName): EntityDef {
  return registry[entity];
}
