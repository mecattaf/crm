import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Conventions (SPEC.md):
// - integer autoincrement `id` PKs (except sessions/fx_rates, see below)
// - created_at / updated_at: ISO-8601 TEXT, UTC
// - archived_at: nullable TEXT, soft archive
// - money: integer cents + currency code; dates DATE-only as YYYY-MM-DD TEXT
// - free-text search: companion `*_norm` columns (lowercased, accent-stripped,
//   written by src/server/services/normalize.ts — never by callers)
//
// TS property names deliberately equal the snake_case column names so DB rows
// match the flat field names of the MCP/REST surface 1:1.

const id = () => integer("id").primaryKey({ autoIncrement: true });
const created_at = () => text("created_at").notNull();
const updated_at = () => text("updated_at").notNull();
const archived_at = () => text("archived_at");

export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    name_norm: text("name_norm").notNull(),
    // PBKDF2-SHA256 via WebCrypto, >=600k iterations, per-user salt.
    // Format: "pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>"
    password_hash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const sessions = sqliteTable("sessions", {
  // id = hash of a random 256-bit token (the raw token lives only in the cookie)
  id: text("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id),
  expires_at: text("expires_at").notNull(),
  created_at: created_at(),
});

export const pipelines = sqliteTable("pipelines", {
  id: id(),
  name: text("name").notNull(),
  name_norm: text("name_norm").notNull(),
  position: integer("position").notNull(),
  created_at: created_at(),
  updated_at: updated_at(),
  archived_at: archived_at(),
});

export const stages = sqliteTable(
  "stages",
  {
    id: id(),
    pipeline_id: integer("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    name: text("name").notNull(),
    name_norm: text("name_norm").notNull(),
    position: integer("position").notNull(),
    // staleness threshold in days; NULL = never rots
    rot_days: integer("rot_days"),
    // stage-level forecast weighting, 0-100 (deal-level probability does not exist)
    forecast_weight: integer("forecast_weight").notNull().default(50),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [index("stages_pipeline_idx").on(t.pipeline_id)],
);

export const organizations = sqliteTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    name_norm: text("name_norm").notNull(),
    // Sodiwin ERP join key
    client_code: text("client_code"),
    category: text("category"),
    org_type: text("org_type"),
    address: text("address"),
    delivery_address: text("delivery_address"),
    accise_1: text("accise_1"),
    accise_2: text("accise_2"),
    owner_id: integer("owner_id").references(() => users.id),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [index("organizations_name_norm_idx").on(t.name_norm)],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    first_name: text("first_name").notNull(),
    last_name: text("last_name").notNull(),
    first_name_norm: text("first_name_norm").notNull(),
    last_name_norm: text("last_name_norm").notNull(),
    org_id: integer("org_id").references(() => organizations.id),
    email: text("email"),
    phone: text("phone"),
    job_title: text("job_title"),
    owner_id: integer("owner_id").references(() => users.id),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [
    index("contacts_last_name_norm_idx").on(t.last_name_norm),
    index("contacts_org_idx").on(t.org_id),
  ],
);

export const deals = sqliteTable(
  "deals",
  {
    id: id(),
    title: text("title").notNull(),
    title_norm: text("title_norm").notNull(),
    org_id: integer("org_id").references(() => organizations.id),
    contact_id: integer("contact_id").references(() => contacts.id),
    pipeline_id: integer("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stage_id: integer("stage_id")
      .notNull()
      .references(() => stages.id),
    value_cents: integer("value_cents").notNull().default(0),
    currency: text("currency", { enum: ["EUR", "CHF", "GBP", "USD"] })
      .notNull()
      .default("EUR"),
    // nullable — deals without a close date are excluded from forecast totals
    expected_close_date: text("expected_close_date"),
    status: text("status", { enum: ["open", "won", "lost"] }).notNull().default("open"),
    lost_reason: text("lost_reason"),
    label: text("label"),
    owner_id: integer("owner_id").references(() => users.id),
    // drives rotting (days-in-stage vs stage.rot_days)
    stage_changed_at: text("stage_changed_at").notNull(),
    won_at: text("won_at"),
    lost_at: text("lost_at"),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [
    index("deals_title_norm_idx").on(t.title_norm),
    index("deals_stage_idx").on(t.stage_id),
    index("deals_pipeline_idx").on(t.pipeline_id),
    index("deals_org_idx").on(t.org_id),
    index("deals_status_idx").on(t.status),
  ],
);

export const activities = sqliteTable(
  "activities",
  {
    id: id(),
    subject: text("subject").notNull(),
    subject_norm: text("subject_norm").notNull(),
    activity_type: text("activity_type", {
      enum: ["call", "meeting", "task", "deadline", "email", "lunch"],
    }).notNull(),
    due_date: text("due_date").notNull(),
    due_time: text("due_time"),
    duration_min: integer("duration_min"),
    priority: text("priority", { enum: ["none", "high"] }).notNull().default("none"),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    done_at: text("done_at"),
    note: text("note"),
    assignee_id: integer("assignee_id").references(() => users.id),
    // direct nullable links, Pipedrive-style (no polymorphic junctions)
    deal_id: integer("deal_id").references(() => deals.id),
    org_id: integer("org_id").references(() => organizations.id),
    contact_id: integer("contact_id").references(() => contacts.id),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [
    index("activities_due_date_idx").on(t.due_date),
    index("activities_deal_idx").on(t.deal_id),
    index("activities_org_idx").on(t.org_id),
    index("activities_contact_idx").on(t.contact_id),
    index("activities_assignee_idx").on(t.assignee_id),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    body: text("body").notNull(),
    body_norm: text("body_norm").notNull(),
    author_id: integer("author_id").references(() => users.id),
    // >=1 of deal_id/org_id/contact_id required — enforced in the service layer
    deal_id: integer("deal_id").references(() => deals.id),
    org_id: integer("org_id").references(() => organizations.id),
    contact_id: integer("contact_id").references(() => contacts.id),
    created_at: created_at(),
    updated_at: updated_at(),
    archived_at: archived_at(),
  },
  (t) => [
    index("notes_deal_idx").on(t.deal_id),
    index("notes_org_idx").on(t.org_id),
    index("notes_contact_idx").on(t.contact_id),
  ],
);

// Append-only system log. Feeds per-record timelines
// (timeline = events ∪ notes ∪ activities, merged at read time).
export const events = sqliteTable(
  "events",
  {
    id: id(),
    entity: text("entity").notNull(),
    entity_id: integer("entity_id").notNull(),
    // created | updated | stage_changed | won | lost | reopened | archived |
    // deleted | completed | ...
    kind: text("kind").notNull(),
    // JSON: old/new values, change sets
    payload: text("payload"),
    actor_user_id: integer("actor_user_id").references(() => users.id),
    created_at: created_at(),
  },
  (t) => [index("events_entity_idx").on(t.entity, t.entity_id)],
);

export const fx_rates = sqliteTable("fx_rates", {
  currency: text("currency").primaryKey(),
  // 1 unit of `currency` = rate_to_eur_micros / 1_000_000 EUR
  rate_to_eur_micros: integer("rate_to_eur_micros").notNull(),
  as_of: text("as_of").notNull(),
});
