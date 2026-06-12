import { registry } from "./services/registry";
import { ENTITIES, type EntityName } from "./services/types";

/**
 * Single source of truth for the MCP surface's self-description.
 *
 * The tool descriptions ARE the product's prompt engineering: they teach a
 * Claude client the entity fields, the filter-operand grammar and the
 * ergonomics rules (names everywhere, decimal money) without any external
 * skill files. The same constants feed get_workspace()'s machine-readable
 * field reference, so the two can never drift apart.
 */

export const CURRENCIES = ["EUR", "CHF", "GBP", "USD"] as const;

export interface FieldRef {
  name: string;
  /** JSON/human type, incl. enum values and "ref" for name-or-id references */
  type: string;
  required?: boolean;
  desc?: string;
}

const USER_REF = "user name, email or id";
const ORG_REF = "organization name or id";
const COMMON_READONLY: FieldRef[] = [
  { name: "id", type: "integer" },
  { name: "created_at", type: "datetime" },
  { name: "updated_at", type: "datetime" },
  { name: "archived_at", type: "datetime", desc: "null unless soft-archived" },
];

/** Fields accepted by create_record / update_record, per entity. */
export const WRITABLE_FIELDS: Record<EntityName, FieldRef[]> = {
  organization: [
    { name: "name", type: "string", required: true },
    { name: "client_code", type: "string", desc: "Sodiwin ERP join key" },
    { name: "category", type: "string" },
    { name: "org_type", type: "string" },
    { name: "address", type: "string" },
    { name: "delivery_address", type: "string" },
    { name: "accise_1", type: "string", desc: "excise number 1" },
    { name: "accise_2", type: "string", desc: "excise number 2" },
    { name: "owner", type: "ref", desc: USER_REF },
  ],
  contact: [
    { name: "first_name", type: "string", required: true },
    { name: "last_name", type: "string", required: true },
    { name: "organization", type: "ref", desc: ORG_REF },
    { name: "email", type: "string" },
    { name: "phone", type: "string" },
    { name: "job_title", type: "string" },
    { name: "owner", type: "ref", desc: USER_REF },
  ],
  deal: [
    { name: "title", type: "string", required: true },
    { name: "organization", type: "ref", desc: ORG_REF },
    { name: "contact", type: "ref", desc: "contact name or id" },
    { name: "pipeline", type: "ref", desc: "create only — defaults to the first pipeline" },
    {
      name: "stage",
      type: "ref",
      desc: "create only — defaults to the pipeline's first stage; later changes go through move_deal",
    },
    { name: "value", type: "money", desc: "decimal in `currency`, e.g. 12500.5" },
    { name: "currency", type: '"EUR"|"CHF"|"GBP"|"USD"', desc: "default EUR" },
    {
      name: "expected_close_date",
      type: "date",
      desc: "YYYY-MM-DD; deals without one are listed in forecasts but never totalled",
    },
    { name: "label", type: "string" },
    { name: "owner", type: "ref", desc: USER_REF },
  ],
  activity: [
    { name: "subject", type: "string", required: true },
    {
      name: "activity_type",
      type: '"call"|"meeting"|"task"|"deadline"|"email"|"lunch"',
      required: true,
      desc: "called `type` in schedule_activity",
    },
    { name: "due_date", type: "date", required: true },
    { name: "due_time", type: "string", desc: "HH:MM, 24h" },
    { name: "duration_min", type: "integer" },
    { name: "priority", type: '"none"|"high"' },
    { name: "note", type: "string" },
    { name: "assignee", type: "ref", desc: `${USER_REF} — defaults to the current user` },
    { name: "deal", type: "ref", desc: "deal title or id" },
    { name: "organization", type: "ref", desc: ORG_REF },
    { name: "contact", type: "ref", desc: "contact name or id" },
  ],
  note: [
    { name: "body", type: "string", required: true },
    { name: "deal", type: "ref", desc: "deal title or id" },
    { name: "organization", type: "ref", desc: ORG_REF },
    { name: "contact", type: "ref", desc: "contact name or id (a note needs at least one link)" },
  ],
};

/** Read-only output fields beyond the writable ones, per entity. */
export const READONLY_FIELDS: Record<EntityName, FieldRef[]> = {
  organization: [...COMMON_READONLY, { name: "owner_id", type: "integer" }],
  contact: [...COMMON_READONLY, { name: "org_id", type: "integer" }, { name: "owner_id", type: "integer" }],
  deal: [
    ...COMMON_READONLY,
    { name: "pipeline_id", type: "integer" },
    { name: "stage_id", type: "integer" },
    { name: "status", type: '"open"|"won"|"lost"', desc: "set via move_deal only" },
    { name: "lost_reason", type: "string", desc: "set via move_deal status:lost" },
    { name: "stage_changed_at", type: "datetime", desc: "drives rotting" },
    { name: "won_at", type: "datetime" },
    { name: "lost_at", type: "datetime" },
  ],
  activity: [
    ...COMMON_READONLY,
    { name: "done", type: "boolean", desc: "set via complete_activity" },
    { name: "done_at", type: "datetime" },
    { name: "assignee_id", type: "integer" },
  ],
  note: [...COMMON_READONLY, { name: "author_id", type: "integer", desc: "defaults to the current user" }],
};

/** Filterable/sortable fields, derived from the service registry (never drifts). */
export function filterableFields(entity: EntityName): { name: string; type: string }[] {
  return Object.entries(registry[entity].fields).map(([name, f]) => ({ name, type: f.kind }));
}

// ---------------------------------------------------------------------------
// rendered blocks for tool descriptions

function fieldLine(f: FieldRef): string {
  const parts = [f.type];
  if (f.required) parts.push("required");
  if (f.desc) parts.push(f.desc);
  return `${f.name} (${parts.join("; ")})`;
}

export const WRITABLE_FIELDS_BLOCK = ENTITIES.map(
  (e) => `- ${e}: ${WRITABLE_FIELDS[e].map(fieldLine).join(", ")}`,
).join("\n");

export const FILTER_FIELDS_BLOCK = ENTITIES.map(
  (e) =>
    `- ${e}: ${filterableFields(e)
      .map((f) => `${f.name}:${f.type}`)
      .join(", ")}`,
).join("\n");

export const OPERAND_TABLE = `Filter grammar: filters = flat AND-list of {field, op, value}; an element may instead be {"or": [conditions]} for an OR group.
Operands by field type:
- any: eq, ne, in (value = array), is_null, not_null
- string: contains (accent- and case-insensitive substring)
- number / money / date / datetime: gt, gte, lt, lte (money compared as decimals, e.g. 1500.5)
- date / datetime only: is_today; in_past; is_overdue (in the past AND still open/not-done); in_next_days:N; in_last_days:N (put N in the op like "in_next_days:30", or as the value)
Archived records are excluded by default — pass include_archived: true or filter on archived_at to see them.`;

export const REF_RULE = `References accept an integer id OR a human-readable name and resolve server-side, accent- and case-insensitively: organization names, contact names, deal titles, activity subjects, pipeline/stage names, user names or emails. Never look up an id first — pass the name. If a name is ambiguous, the error lists the matching candidates (id + label) so you can retry with the id.`;

export const MONEY_RULE = `Money is a decimal number in the record's currency (value: 1234.5 means 1 234,50) — never cents. Currencies: ${CURRENCIES.join(", ")} (stored FX rates convert to EUR in forecasts and boards). Dates are YYYY-MM-DD, times HH:MM (24h), timestamps ISO-8601 UTC.`;

/** Machine-readable field reference returned by get_workspace (no view). */
export const WORKSPACE_FIELD_REFERENCE = Object.fromEntries(
  ENTITIES.map((e) => [
    e,
    {
      writable: WRITABLE_FIELDS[e],
      read_only: READONLY_FIELDS[e],
      filterable: filterableFields(e),
    },
  ]),
);
