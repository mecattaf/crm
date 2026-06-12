/** Who is performing the mutation; recorded as events.actor_user_id. */
export interface Actor {
  userId: number;
}

export const ENTITIES = ["organization", "contact", "deal", "activity", "note"] as const;
export type EntityName = (typeof ENTITIES)[number];

/** Output record shape: flat snake_case fields, *_norm omitted, money as decimal `value`. */
export type ServiceRecord = Record<string, unknown> & { id: number };

export function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}
