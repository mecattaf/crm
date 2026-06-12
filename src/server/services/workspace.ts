import { asc, isNull } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import type { Actor } from "./types";

/**
 * Workspace orientation data (SPEC.md tool 12, get_workspace without a view):
 * pipelines with their ordered stages (weights + rot thresholds), users and
 * currencies with EUR rates. The MCP layer adds the static entity field
 * reference on top (src/server/mcp-reference.ts).
 */

export interface WorkspaceStage {
  id: number;
  name: string;
  position: number;
  rot_days: number | null;
  forecast_weight: number;
}

export interface WorkspacePipeline {
  id: number;
  name: string;
  position: number;
  stages: WorkspaceStage[];
}

export interface WorkspaceUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

export interface WorkspaceCurrency {
  currency: string;
  /** 1 unit = rate_to_eur EUR (decimal) */
  rate_to_eur: number;
  as_of: string;
}

export interface WorkspaceResult {
  pipelines: WorkspacePipeline[];
  users: WorkspaceUser[];
  currencies: WorkspaceCurrency[];
}

export async function getWorkspace(db: Db, _actor?: Actor): Promise<WorkspaceResult> {
  const pipelineRows = await db
    .select()
    .from(schema.pipelines)
    .where(isNull(schema.pipelines.archived_at))
    .orderBy(asc(schema.pipelines.position))
    .all();

  const stageRows = await db
    .select()
    .from(schema.stages)
    .where(isNull(schema.stages.archived_at))
    .orderBy(asc(schema.stages.position))
    .all();

  const userRows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(isNull(schema.users.archived_at))
    .orderBy(asc(schema.users.id))
    .all();

  const fxRows = await db.select().from(schema.fx_rates).orderBy(asc(schema.fx_rates.currency)).all();

  return {
    pipelines: pipelineRows.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      stages: stageRows
        .filter((s) => s.pipeline_id === p.id)
        .map((s) => ({
          id: s.id,
          name: s.name,
          position: s.position,
          rot_days: s.rot_days,
          forecast_weight: s.forecast_weight,
        })),
    })),
    users: userRows,
    currencies: fxRows.map((r) => ({
      currency: r.currency,
      rate_to_eur: r.rate_to_eur_micros / 1_000_000,
      as_of: r.as_of,
    })),
  };
}
