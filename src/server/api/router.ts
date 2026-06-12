import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { createDb } from "../db";
import { WORKSPACE_FIELD_REFERENCE } from "../mcp-reference";
import {
  AmbiguousError,
  NotFoundError,
  ValidationError,
  aggregate,
  assembleTimeline,
  completeActivity,
  forecast,
  getWorkspace,
  moveDeal,
  myDay,
  noNextActivity,
  overdueActivities,
  pipelineBoard,
  recentActivity,
  resolveEntityRecord,
  staleDeals,
} from "../services";
import { parseWith } from "../services/records";
import { refSchema } from "../services/schemas";
import { ENTITIES } from "../services/types";
import {
  actorOf,
  includeArchivedSchema,
  parseFilters,
  readJsonOrEmpty,
} from "./params";
import { recordRoutes } from "./records";

/**
 * /api REST router (SPEC.md "REST API"): thin adapters over the services,
 * mirroring the MCP tool surface 1:1. Conventions: JSON in/out; actor from the
 * session (c.var.user); {data, cursor?} envelope for lists, bare objects for
 * single records; service errors mapped below.
 */
export const api = new Hono<AppEnv>();

// service error -> HTTP status (ambiguity surfaces its candidates)
api.onError((err, c) => {
  if (err instanceof AmbiguousError) {
    return c.json({ error: err.message, candidates: err.candidates }, 400);
  }
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  console.error("unhandled /api error:", err);
  return c.json({ error: "internal_error" }, 500);
});

// ---------------------------------------------------------------------------
// entity CRUD + entity verbs

const moveBodySchema = z.strictObject({
  stage: refSchema.optional(),
  pipeline: refSchema.optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  lost_reason: z.string().optional(),
});

const completeBodySchema = z.strictObject({
  done_note: z.string().optional(),
});

const deals = recordRoutes("deal");
deals.post("/:id/move", async (c) => {
  const body = parseWith<z.infer<typeof moveBodySchema>>(moveBodySchema, await readJsonOrEmpty(c));
  const record = await moveDeal(
    createDb(c.env.DB),
    { deal: c.req.param("id"), ...body },
    actorOf(c),
  );
  return c.json(record);
});

const activities = recordRoutes("activity");
activities.post("/:id/complete", async (c) => {
  const body = parseWith<z.infer<typeof completeBodySchema>>(
    completeBodySchema,
    await readJsonOrEmpty(c),
  );
  const record = await completeActivity(
    createDb(c.env.DB),
    { activity: c.req.param("id"), ...body },
    actorOf(c),
  );
  return c.json(record);
});

api.route("/organizations", recordRoutes("organization"));
api.route("/contacts", recordRoutes("contact"));
api.route("/deals", deals);
api.route("/activities", activities);
api.route("/notes", recordRoutes("note"));

// ---------------------------------------------------------------------------
// named views (get_workspace(view) equivalents)

const pipelineBoardQuery = z.object({ pipeline: z.string().min(1) });
const optionalPipelineQuery = z.object({ pipeline: z.string().min(1).optional() });
const overdueQuery = z.object({ assignee: z.string().min(1).optional() });
const recentActivityQuery = z.object({ days: z.coerce.number().optional() });
const myDayQuery = z.object({ user: z.string().min(1), date: z.string().optional() });

const VIEW_NAMES = [
  "pipeline_board",
  "overdue_activities",
  "no_next_activity",
  "stale_deals",
  "recent_activity",
  "my_day",
] as const;

api.get("/views/:name", async (c) => {
  const db = createDb(c.env.DB);
  const q = c.req.query();
  switch (c.req.param("name")) {
    case "pipeline_board":
      return c.json(
        await pipelineBoard(db, parseWith<z.infer<typeof pipelineBoardQuery>>(pipelineBoardQuery, q)),
      );
    case "overdue_activities":
      return c.json({
        data: await overdueActivities(db, parseWith<z.infer<typeof overdueQuery>>(overdueQuery, q)),
      });
    case "no_next_activity":
      return c.json({
        data: await noNextActivity(
          db,
          parseWith<z.infer<typeof optionalPipelineQuery>>(optionalPipelineQuery, q),
        ),
      });
    case "stale_deals":
      return c.json({
        data: await staleDeals(
          db,
          parseWith<z.infer<typeof optionalPipelineQuery>>(optionalPipelineQuery, q),
        ),
      });
    case "recent_activity":
      return c.json({
        data: await recentActivity(
          db,
          parseWith<z.infer<typeof recentActivityQuery>>(recentActivityQuery, q),
        ),
      });
    case "my_day":
      return c.json(await myDay(db, parseWith<z.infer<typeof myDayQuery>>(myDayQuery, q)));
    default:
      throw new ValidationError(
        `Unknown view "${c.req.param("name")}". Allowed: ${VIEW_NAMES.join(", ")}.`,
      );
  }
});

// ---------------------------------------------------------------------------
// forecast / aggregate / workspace / events

const forecastQuery = z.object({
  pipeline: z.string().min(1).optional(),
  months: z.coerce.number().optional(),
});

api.get("/forecast", async (c) => {
  const q = parseWith<z.infer<typeof forecastQuery>>(forecastQuery, c.req.query());
  return c.json(await forecast(createDb(c.env.DB), q));
});

const aggregateQuery = z.object({
  entity: z.enum(ENTITIES),
  metric: z.string().min(1),
  group_by: z.string().min(1).optional(),
  include_archived: includeArchivedSchema.optional(),
});

api.get("/aggregate", async (c) => {
  const q = parseWith<z.infer<typeof aggregateQuery>>(aggregateQuery, c.req.query());
  const filters = parseFilters(c, q.entity);
  return c.json(await aggregate(createDb(c.env.DB), { ...q, filters }));
});

api.get("/workspace", async (c) =>
  c.json({ ...(await getWorkspace(createDb(c.env.DB))), fields: WORKSPACE_FIELD_REFERENCE }),
);

const eventsQuery = z.object({ entity: z.enum(ENTITIES), id: z.string().min(1) });

/** Timeline of one record: events ∪ notes ∪ activities (same assembly as get_record). */
api.get("/events", async (c) => {
  const q = parseWith<z.infer<typeof eventsQuery>>(eventsQuery, c.req.query());
  const db = createDb(c.env.DB);
  const record = await resolveEntityRecord(db, q.entity, q.id); // 404 when missing
  return c.json({ data: await assembleTimeline(db, q.entity, record.id) });
});
