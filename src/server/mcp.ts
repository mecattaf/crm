import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { createDb, type Db } from "./db";
import {
  FILTER_FIELDS_BLOCK,
  MONEY_RULE,
  OPERAND_TABLE,
  REF_RULE,
  WORKSPACE_FIELD_REFERENCE,
  WRITABLE_FIELDS_BLOCK,
} from "./mcp-reference";
import {
  aggregate,
  archiveRecord,
  completeActivity,
  createRecord,
  deleteRecord,
  ENTITIES,
  type Filter,
  forecast,
  getRecord,
  getWorkspace,
  logNote,
  moveDeal,
  myDay,
  noNextActivity,
  overdueActivities,
  pipelineBoard,
  recentActivity,
  scheduleActivity,
  searchRecords,
  staleDeals,
  updateRecord,
  ValidationError,
} from "./services";
import type { Actor } from "./services/types";

/**
 * Identity attached to every OAuth grant at /authorize consent
 * (completeAuthorization props) and delivered to tool handlers as
 * `this.props` on every authorized /mcp request.
 */
export type Props = { userId: number; role: string };

// ---------------------------------------------------------------------------
// shared schema fragments (Zod v4; raw shapes per MCP SDK registerTool)

const ref = z.union([z.number().int(), z.string().min(1)]);
const entityParam = z.enum(ENTITIES).describe("Which record type to operate on.");
const recordData = z.record(z.string(), z.unknown());
const filterCond = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
});
const filtersParam = z
  .array(z.union([filterCond, z.object({ or: z.array(filterCond).min(1) })]))
  .describe("AND-list of {field, op, value}; use {or: [...]} elements for OR groups. See the operand table in this tool's description.");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * Drop keys whose value is undefined. Zod keeps optional keys that arrive
 * explicitly as undefined, but the services distinguish "absent" from "null"
 * (e.g. an absent assignee defaults to the actor; a null one clears it) — so
 * adapter-built inputs must only carry keys the caller actually sent.
 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// result shaping: compact JSON text + structuredContent for object results

function jsonResult(result: unknown): CallToolResult {
  const out: CallToolResult = { content: [{ type: "text", text: JSON.stringify(result) }] };
  // structuredContent must be a JSON object per the MCP spec; arrays and
  // scalars travel as JSON text only.
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    out.structuredContent = result as Record<string, unknown>;
  }
  return out;
}

/**
 * Service errors (validation, not-found, ambiguity with candidate lists) are
 * written for LLM self-correction — surface their message verbatim as an MCP
 * tool error rather than a protocol failure.
 */
function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// tool registration (exported separately from the agent so tests can mount
// the registry against a mock actor if the transport ever gets in the way)

export function registerCrmTools(
  server: McpServer,
  getDb: () => Db,
  getActor: () => Actor,
): void {
  /** register one tool: zod-validated args -> service call -> JSON result */
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.output<z.ZodObject<Shape>>, db: Db, actor: Actor) => Promise<unknown>,
  ): void => {
    server.registerTool(name, { description, inputSchema: shape }, (async (
      args: z.output<z.ZodObject<Shape>>,
    ) => {
      try {
        return jsonResult(await handler(args, getDb(), getActor()));
      } catch (err) {
        return errorResult(err);
      }
    }) as never);
  };

  // -------------------------------------------------------------- search

  tool(
    "search_records",
    `Search and list CRM records (entity: organization | contact | deal | activity | note). \`query\` does fuzzy, accent- and case-insensitive matching across the entity's text fields — the right tool for "who/what is X?". Combine with typed \`filters\`, \`sort\` ("field" asc or "-field" desc), \`limit\` and \`cursor\` (pass back next_cursor to page). Prefer get_workspace(view=...) for the canned team questions (pipeline board, overdue, stale, agenda) and aggregate for counts/sums.

Filterable/sortable fields per entity:
${FILTER_FIELDS_BLOCK}

${OPERAND_TABLE}

${MONEY_RULE}`,
    {
      entity: entityParam,
      query: z.string().optional().describe("Fuzzy cross-field text match (accent-insensitive)."),
      filters: filtersParam.optional(),
      sort: z
        .union([z.string(), z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })])
        .optional()
        .describe('"field", "-field" (descending) or {field, dir}.'),
      limit: z.number().int().min(1).max(200).optional().describe("Page size, default 50, max 200."),
      cursor: z.string().optional().describe("next_cursor from the previous page."),
      include_archived: z.boolean().optional().describe("Include soft-archived records (default false)."),
    },
    (args, db, actor) =>
      searchRecords(
        db,
        compact({
          entity: args.entity,
          query: args.query,
          filters: args.filters as Filter[] | undefined,
          sort: args.sort,
          limit: args.limit,
          cursor: args.cursor,
          include_archived: args.include_archived,
        }),
        actor,
      ),
  );

  // -------------------------------------------------------------- get

  tool(
    "get_record",
    `Fetch ONE record with full context in a single call. \`id\` accepts the record's integer id OR its name/title/subject (resolved accent-insensitively; ambiguous names return a candidate list). \`include\` pulls related data in the same response — valid per entity: organization → contacts, deals, activities, notes, timeline; contact → deals, activities, notes, timeline; deal → activities, notes, timeline; activity/note → timeline. "timeline" is the merged chronological history (events + notes + activities). Use this when you know which record; use search_records to find one.`,
    {
      entity: entityParam,
      id: ref.describe("Record id or human-readable name/title/subject."),
      include: z
        .array(z.enum(["timeline", "activities", "notes", "deals", "contacts"]))
        .optional()
        .describe("Related data to embed in the response."),
    },
    (args, db, actor) =>
      getRecord(db, compact({ entity: args.entity, id: args.id, include: args.include }), actor),
  );

  // -------------------------------------------------------------- create

  tool(
    "create_record",
    `Create one record, or several in one call (\`data\` as an array, max 50 — all of the same entity). Returns the full created record(s). ${REF_RULE}

Fields by entity (required marked; everything else optional):
${WRITABLE_FIELDS_BLOCK}

${MONEY_RULE}
A note must link to at least one of deal/organization/contact. New deals land in the given (or first) pipeline's given (or first) stage — later stage/status changes go through move_deal only. For day-to-day logging prefer the dedicated verbs log_note and schedule_activity.`,
    {
      entity: entityParam,
      data: z
        .union([recordData, z.array(recordData).min(1).max(50)])
        .describe("Field object, or an array of them for batch create."),
    },
    (args, db, actor) =>
      createRecord(db, { entity: args.entity, data: args.data as Record<string, unknown> | Record<string, unknown>[] }, actor),
  );

  // -------------------------------------------------------------- update

  tool(
    "update_record",
    `Update fields on existing record(s): pass (id, patch) for one record, or items: [{id, patch}] for a heterogeneous bulk update (max 50, each row with its own patch). Returns the full updated record(s). Patchable fields are the same as create_record's (see that tool's field table), EXCEPT a deal's pipeline/stage/status/lost_reason — those must go through move_deal and are rejected here. Money: decimal \`value\`. ${REF_RULE}`,
    {
      entity: entityParam,
      id: ref.optional().describe("Record id or name (single update)."),
      patch: recordData.optional().describe("Fields to change (single update)."),
      items: z
        .array(z.object({ id: ref, patch: recordData }))
        .min(1)
        .max(50)
        .optional()
        .describe("Bulk update: each item has its own id and patch."),
    },
    (args, db, actor) =>
      updateRecord(
        db,
        compact({
          entity: args.entity,
          id: args.id,
          patch: args.patch as Record<string, unknown> | undefined,
          items: args.items as { id: number | string; patch: Record<string, unknown> }[] | undefined,
        }),
        actor,
      ),
  );

  // -------------------------------------------------------------- archive / delete

  tool(
    "archive_record",
    `Soft-archive a record: sets archived_at, hides it from searches, views and name resolution (still reachable by id; reversible in the database). This is the DEFAULT way to remove something — reach for archive_record, not delete_record, unless the user explicitly wants permanent destruction. Returns the archived record.`,
    {
      entity: entityParam,
      id: ref.describe("Record id or human-readable name."),
    },
    (args, db, actor) => archiveRecord(db, { entity: args.entity, id: args.id }, actor),
  );

  tool(
    "delete_record",
    `PERMANENTLY delete a single record. Irreversible, never batched, and requires confirm: true (calls without it fail with instructions). Only use when the user explicitly confirms permanent deletion — otherwise use archive_record.`,
    {
      entity: entityParam,
      id: ref.describe("Record id or human-readable name."),
      confirm: z.boolean().optional().describe("Must be exactly true to delete."),
    },
    (args, db, actor) =>
      deleteRecord(db, compact({ entity: args.entity, id: args.id, confirm: args.confirm }), actor),
  );

  // -------------------------------------------------------------- move_deal

  tool(
    "move_deal",
    `Move a deal through its pipeline and/or set its outcome — the ONLY way to change a deal's stage or status (update_record rejects those fields). \`stage\` resolves by name within the deal's own pipeline; pass \`pipeline\` too to move across pipelines (the stage then resolves in the target pipeline). \`status\`: "won", "lost" (optionally with lost_reason) or "open" to reopen. Stamps stage_changed_at (the rotting clock) and writes stage_changed/won/lost events to the timeline. Returns the full updated deal.`,
    {
      deal: ref.describe("Deal id or title."),
      stage: ref.optional().describe("Target stage name or id (within the deal's pipeline)."),
      pipeline: ref.optional().describe("Target pipeline name or id, when moving across pipelines."),
      status: z.enum(["open", "won", "lost"]).optional(),
      lost_reason: z.string().optional().describe('Only with status: "lost".'),
    },
    (args, db, actor) =>
      moveDeal(
        db,
        compact({
          deal: args.deal,
          stage: args.stage,
          pipeline: args.pipeline,
          status: args.status,
          lost_reason: args.lost_reason,
        }),
        actor,
      ),
  );

  // -------------------------------------------------------------- log_note

  tool(
    "log_note",
    `Attach a free-text note to a deal, organization and/or contact (at least one, by name or id). Use it right after a call, meeting or email to capture what happened; it is authored as the current user and appears on the record's timeline. For something that still needs DOING, use schedule_activity instead.`,
    {
      body: z.string().min(1).describe("The note text."),
      deal: ref.optional().describe("Deal id or title."),
      organization: ref.optional().describe("Organization id or name."),
      contact: ref.optional().describe("Contact id or name."),
    },
    (args, db, actor) =>
      logNote(
        db,
        compact({ body: args.body, deal: args.deal, organization: args.organization, contact: args.contact }),
        actor,
      ),
  );

  // -------------------------------------------------------------- activities

  tool(
    "schedule_activity",
    `Schedule a follow-up activity — the product's core discipline: every open deal should always have a next activity (audit with get_workspace view=no_next_activity). Link it to a deal/organization/contact by name or id; \`assignee\` defaults to the current user. due_date is YYYY-MM-DD, due_time HH:MM (24h). Returns the created activity; mark it done later with complete_activity.`,
    {
      subject: z.string().min(1),
      type: z.enum(["call", "meeting", "task", "deadline", "email", "lunch"]),
      due_date: dateParam,
      due_time: z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM").optional(),
      duration_min: z.number().int().positive().optional(),
      priority: z.enum(["none", "high"]).optional(),
      note: z.string().optional(),
      assignee: ref.optional().describe("User name, email or id — defaults to you."),
      deal: ref.optional().describe("Deal id or title."),
      organization: ref.optional().describe("Organization id or name."),
      contact: ref.optional().describe("Contact id or name."),
    },
    (args, db, actor) =>
      scheduleActivity(
        db,
        compact({
          subject: args.subject,
          type: args.type,
          due_date: args.due_date,
          due_time: args.due_time,
          duration_min: args.duration_min,
          priority: args.priority,
          note: args.note,
          assignee: args.assignee,
          deal: args.deal,
          organization: args.organization,
          contact: args.contact,
        }),
        actor,
      ),
  );

  tool(
    "complete_activity",
    `Mark an activity done — prefer this over update_record for completion: it stamps done/done_at, appends the optional done_note to the activity's note and logs a "completed" event. \`activity\` accepts the id or the subject. After completing the last pending activity on a deal, consider scheduling the next one (next-activity discipline).`,
    {
      activity: ref.describe("Activity id or subject."),
      done_note: z.string().optional().describe("Outcome note appended to the activity."),
    },
    (args, db, actor) =>
      completeActivity(db, compact({ activity: args.activity, done_note: args.done_note }), actor),
  );

  // -------------------------------------------------------------- aggregate

  tool(
    "aggregate",
    `Counts, sums and averages over any entity — the dashboard replacement. metric: "count" | "sum:<field>" | "avg:<field>" (numeric or money fields; money in/out as decimals). Optional group_by on any filterable field; foreign-key columns (stage_id, pipeline_id, owner_id, org_id, ...) come back with human-readable labels next to the raw key. Takes the exact same \`filters\` grammar as search_records (see its description for fields and operands); archived records excluded by default. NOTE: sum:value adds deal values in their RAW currencies without FX conversion — for EUR-converted totals use forecast. Example — open deal count per stage: {entity: "deal", metric: "count", group_by: "stage_id", filters: [{field: "status", op: "eq", value: "open"}]}.`,
    {
      entity: entityParam,
      metric: z.string().describe('"count", "sum:<field>" or "avg:<field>".'),
      group_by: z.string().optional().describe("Field to group by (FK columns get labels)."),
      filters: filtersParam.optional(),
      include_archived: z.boolean().optional(),
    },
    (args, db, actor) =>
      aggregate(
        db,
        compact({
          entity: args.entity,
          metric: args.metric,
          group_by: args.group_by,
          filters: args.filters as Filter[] | undefined,
          include_archived: args.include_archived,
        }),
        actor,
      ),
  );

  // -------------------------------------------------------------- forecast

  tool(
    "forecast",
    `Revenue forecast — the answer to "how do the coming months look?". Open deals grouped by expected-close month (YYYY-MM), each converted to EUR via the stored FX rates and weighted by its stage's forecast_weight (0-100%). Returns months: [{month, gross_eur, weighted_eur, deals[]}] (each deal line shows value, currency, value_eur, weight, weighted_eur), an \`unscheduled\` list for open deals with no expected_close_date (listed, never totalled — flag these to the user) and total_gross_eur / total_weighted_eur across the listed months. \`pipeline\` (name or id) narrows scope; \`months\` limits the horizon to N months starting now.`,
    {
      pipeline: ref.optional().describe("Pipeline name or id; omit for all pipelines."),
      months: z.number().int().min(1).optional().describe("Horizon in months from the current month."),
    },
    (args, db, actor) => forecast(db, compact({ pipeline: args.pipeline, months: args.months }), actor),
  );

  // -------------------------------------------------------------- get_workspace

  tool(
    "get_workspace",
    `Orientation + canned views. Call with NO arguments first in a session to learn the workspace: pipelines with their ordered stages (incl. forecast_weight % and rot_days staleness thresholds), users (id, name, email, role), currencies with EUR rates, and the machine-readable per-entity field reference (writable/read-only/filterable). With \`view\`, runs a canned query — prefer these over hand-rolled search_records:
- pipeline_board (requires pipeline): open deals by stage with rotting flags (red = days in stage > rot_days, amber = ≥ 80% of it) and each deal's next pending activity
- overdue_activities (optional assignee): pending activities past their due date/time, oldest first
- no_next_activity (optional pipeline): open deals with NO pending activity — the follow-up gap list, check it regularly
- stale_deals (optional pipeline): rotting open deals, red first then longest-stuck
- recent_activity (optional days, default 7): everything that changed recently, newest first
- my_day (optional user, defaults to you; optional date YYYY-MM-DD): that user's agenda for the day plus their overdue count`,
    {
      view: z
        .enum([
          "pipeline_board",
          "overdue_activities",
          "no_next_activity",
          "stale_deals",
          "recent_activity",
          "my_day",
        ])
        .optional()
        .describe("Omit for workspace orientation; set to run a canned view."),
      pipeline: ref.optional().describe("pipeline_board (required), no_next_activity, stale_deals."),
      assignee: ref.optional().describe("overdue_activities: limit to one user."),
      user: ref.optional().describe("my_day: whose agenda (defaults to you)."),
      date: dateParam.optional().describe("my_day: which day (defaults to today)."),
      days: z.number().int().min(1).optional().describe("recent_activity: look-back window, default 7."),
    },
    async (args, db, actor) => {
      switch (args.view) {
        case undefined: {
          const ws = await getWorkspace(db, actor);
          return { ...ws, fields: WORKSPACE_FIELD_REFERENCE };
        }
        case "pipeline_board":
          if (args.pipeline === undefined) {
            throw new ValidationError(
              'view "pipeline_board" needs a pipeline (name or id) — call get_workspace with no arguments to list pipelines.',
            );
          }
          return pipelineBoard(db, { pipeline: args.pipeline }, actor);
        case "overdue_activities":
          return overdueActivities(db, compact({ assignee: args.assignee }), actor);
        case "no_next_activity":
          return noNextActivity(db, compact({ pipeline: args.pipeline }), actor);
        case "stale_deals":
          return staleDeals(db, compact({ pipeline: args.pipeline }), actor);
        case "recent_activity":
          return recentActivity(db, compact({ days: args.days }), actor);
        case "my_day":
          return myDay(db, compact({ user: args.user ?? actor.userId, date: args.date }), actor);
      }
    },
  );
}

/**
 * The CRM MCP agent (SQLite-backed Durable Object, per-session and
 * disposable — D1 is the only source of truth). The acting user arrives via
 * OAuth as `this.props` and is attached to every mutation as the event actor.
 */
export class CrmMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "sodimo-crm", version: "0.1.0" });

  async init(): Promise<void> {
    registerCrmTools(
      this.server,
      () => createDb(this.env.DB),
      () => {
        // OAuthProvider always injects the grant's props before /mcp reaches
        // us; a missing identity is a wiring bug, never an anonymous call.
        if (!this.props) throw new Error("missing OAuth props on the MCP session");
        return { userId: this.props.userId };
      },
    );
  }
}
