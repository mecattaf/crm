import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { createDb } from "../db";
import {
  archiveRecord,
  createRecord,
  deleteRecord,
  getRecord,
  searchRecords,
  updateRecord,
} from "../services";
import { ValidationError } from "../services/errors";
import type { IncludeName } from "../services/records";
import { parseWith } from "../services/records";
import { refSchema } from "../services/schemas";
import type { EntityName, ServiceRecord } from "../services/types";
import { actorOf, parseIncludeParam, parseListQuery, readJson } from "./params";

/**
 * Generic per-entity CRUD routes — thin HTTP adapters over the record
 * services (which own all validation via the shared zod schemas).
 *
 * GET    /            list (search_records grammar via query params)
 * POST   /            create (single object or heterogeneous batch)
 * PATCH  /            bulk update [{id, patch}]
 * GET    /:id         get (?include=, id-or-name Ref)
 * PATCH  /:id         update
 * POST   /:id/archive soft archive
 * DELETE /:id         hard delete (?confirm=true, else 409)
 */

// item shape only; patch contents are validated by the service patchSchemas
const bulkPatchSchema = z.array(
  z.strictObject({ id: refSchema, patch: z.record(z.string(), z.unknown()) }),
);

const listEnvelope = (result: { items: ServiceRecord[]; next_cursor: string | null }) => ({
  data: result.items,
  ...(result.next_cursor !== null && { cursor: result.next_cursor }),
});

export function recordRoutes(entity: EntityName): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const result = await searchRecords(createDb(c.env.DB), parseListQuery(c, entity));
    return c.json(listEnvelope(result));
  });

  r.post("/", async (c) => {
    const body = await readJson(c);
    const result = await createRecord(
      createDb(c.env.DB),
      { entity, data: body as never },
      actorOf(c),
    );
    return c.json(Array.isArray(result) ? { data: result } : result, 201);
  });

  r.patch("/", async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body)) {
      throw new ValidationError("Bulk PATCH expects an array of {id, patch}.");
    }
    const items = parseWith<z.infer<typeof bulkPatchSchema>>(bulkPatchSchema, body);
    const result = await updateRecord(createDb(c.env.DB), { entity, items }, actorOf(c));
    return c.json({ data: result });
  });

  r.get("/:id", async (c) => {
    const record = await getRecord(createDb(c.env.DB), {
      entity,
      id: c.req.param("id"),
      include: parseIncludeParam(c) as IncludeName[], // values validated by the service
    });
    return c.json(record);
  });

  r.patch("/:id", async (c) => {
    const patch = await readJson(c);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ValidationError("PATCH expects a JSON object of fields to change.");
    }
    const record = await updateRecord(
      createDb(c.env.DB),
      { entity, id: c.req.param("id"), patch: patch as Record<string, unknown> },
      actorOf(c),
    );
    return c.json(record);
  });

  r.post("/:id/archive", async (c) => {
    const record = await archiveRecord(
      createDb(c.env.DB),
      { entity, id: c.req.param("id") },
      actorOf(c),
    );
    return c.json(record);
  });

  r.delete("/:id", async (c) => {
    // asymmetric destructive friction (SPEC.md): confirm at the HTTP edge -> 409
    if (c.req.query("confirm") !== "true") {
      return c.json(
        {
          error:
            "DELETE permanently destroys data and requires ?confirm=true. Consider POST /:id/archive instead.",
        },
        409,
      );
    }
    const result = await deleteRecord(
      createDb(c.env.DB),
      { entity, id: c.req.param("id"), confirm: true },
      actorOf(c),
    );
    return c.json(result);
  });

  return r;
}
