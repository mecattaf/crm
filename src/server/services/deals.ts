import { eq } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import { eventStmt } from "./events";
import { shapeRecord } from "./records";
import { type Ref, resolveDeal, resolvePipeline, resolveStage } from "./resolve";
import type { Actor, ServiceRecord } from "./types";
import { nowIso } from "./types";

/**
 * move_deal: stage transition and/or won/lost/reopen. The ONLY path that
 * writes stage_changed_at and stage/status events (update_record rejects
 * stage/status patches). Stage resolves by name within the deal's pipeline;
 * pass `pipeline` to move across pipelines.
 */
export interface MoveDealInput {
  deal: Ref;
  stage?: Ref;
  /** target pipeline when moving across pipelines (default: the deal's own) */
  pipeline?: Ref;
  status?: "open" | "won" | "lost";
  lost_reason?: string;
  now?: string;
}

export async function moveDeal(db: Db, input: MoveDealInput, actor: Actor): Promise<ServiceRecord> {
  if (input.stage === undefined && input.status === undefined) {
    throw new ValidationError("move_deal needs a stage and/or a status.");
  }
  if (input.lost_reason !== undefined && input.status !== "lost") {
    throw new ValidationError('lost_reason only applies with status: "lost".');
  }
  const now = nowIso(input.now);
  const deal = await resolveDeal(db, input.deal);

  const values: Record<string, unknown> = { updated_at: now };
  const eventStmts: unknown[] = [];

  if (input.stage !== undefined) {
    const pipeline =
      input.pipeline !== undefined ? await resolvePipeline(db, input.pipeline) : null;
    const pipelineId = pipeline ? pipeline.id : deal.pipeline_id;
    const fromStage = await resolveStage(db, deal.stage_id, deal.pipeline_id);
    const toStage = await resolveStage(db, input.stage, pipelineId);
    values["stage_id"] = toStage.id;
    values["pipeline_id"] = pipelineId;
    values["stage_changed_at"] = now;
    eventStmts.push(
      eventStmt(db, {
        entity: "deal",
        entityId: deal.id,
        kind: "stage_changed",
        payload: {
          from_stage_id: fromStage.id,
          from_stage: fromStage.name,
          to_stage_id: toStage.id,
          to_stage: toStage.name,
        },
        actor,
        now,
      }),
    );
  }

  if (input.status !== undefined && input.status !== deal.status) {
    values["status"] = input.status;
    if (input.status === "won") {
      values["won_at"] = now;
      values["lost_at"] = null;
      values["lost_reason"] = null;
      eventStmts.push(eventStmt(db, { entity: "deal", entityId: deal.id, kind: "won", actor, now }));
    } else if (input.status === "lost") {
      values["lost_at"] = now;
      values["won_at"] = null;
      values["lost_reason"] = input.lost_reason ?? null;
      eventStmts.push(
        eventStmt(db, {
          entity: "deal",
          entityId: deal.id,
          kind: "lost",
          payload: { lost_reason: input.lost_reason ?? null },
          actor,
          now,
        }),
      );
    } else {
      values["won_at"] = null;
      values["lost_at"] = null;
      values["lost_reason"] = null;
      eventStmts.push(
        eventStmt(db, { entity: "deal", entityId: deal.id, kind: "reopened", actor, now }),
      );
    }
  }

  const update = db
    .update(schema.deals)
    .set(values as never)
    .where(eq(schema.deals.id, deal.id))
    .returning();

  const results = (await db.batch([update, ...(eventStmts as [])])) as unknown[];
  const row = (results[0] as Record<string, unknown>[])[0];
  if (!row) throw new Error("move_deal update returned no row");
  return shapeRecord("deal", row);
}
