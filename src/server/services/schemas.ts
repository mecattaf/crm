import { z } from "zod";
import type { EntityName } from "./types";

/**
 * Zod v4 input schemas, colocated with the services (SPEC: tools/REST reuse
 * them). Strict objects: unknown keys are rejected with a clear error, which
 * is what an LLM caller needs to self-correct.
 *
 * Reference fields (`owner`, `organization`, `contact`, `deal`, `pipeline`,
 * `stage`, `assignee`, `author`) accept an integer id OR a human-readable
 * name/email; services resolve them to the corresponding *_id column.
 */
export const refSchema = z.union([z.number().int().positive(), z.string().min(1)]);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");
export const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM");
export const currencySchema = z.enum(["EUR", "CHF", "GBP", "USD"]);

export const organizationCreateSchema = z.strictObject({
  name: z.string().min(1),
  client_code: z.string().nullish(),
  category: z.string().nullish(),
  org_type: z.string().nullish(),
  address: z.string().nullish(),
  delivery_address: z.string().nullish(),
  accise_1: z.string().nullish(),
  accise_2: z.string().nullish(),
  owner: refSchema.nullish(),
});

export const contactCreateSchema = z.strictObject({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  organization: refSchema.nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  job_title: z.string().nullish(),
  owner: refSchema.nullish(),
});

export const dealCreateSchema = z.strictObject({
  title: z.string().min(1),
  organization: refSchema.nullish(),
  contact: refSchema.nullish(),
  pipeline: refSchema.nullish(),
  stage: refSchema.nullish(),
  /** decimal money in the deal's currency (e.g. 1234.5); stored as cents */
  value: z.number().nonnegative().nullish(),
  currency: currencySchema.nullish(),
  expected_close_date: dateSchema.nullish(),
  label: z.string().nullish(),
  owner: refSchema.nullish(),
});

export const activityCreateSchema = z.strictObject({
  subject: z.string().min(1),
  activity_type: z.enum(["call", "meeting", "task", "deadline", "email", "lunch"]),
  due_date: dateSchema,
  due_time: timeSchema.nullish(),
  duration_min: z.number().int().positive().nullish(),
  priority: z.enum(["none", "high"]).nullish(),
  note: z.string().nullish(),
  assignee: refSchema.nullish(),
  deal: refSchema.nullish(),
  organization: refSchema.nullish(),
  contact: refSchema.nullish(),
});

export const noteCreateSchema = z.strictObject({
  body: z.string().min(1),
  author: refSchema.nullish(),
  deal: refSchema.nullish(),
  organization: refSchema.nullish(),
  contact: refSchema.nullish(),
});

// Patches are partial creates. Deals: pipeline/stage/status transitions go
// through move_deal (single source of stage_changed_at + stage events).
export const organizationPatchSchema = organizationCreateSchema.partial();
export const contactPatchSchema = contactCreateSchema.partial();
export const dealPatchSchema = dealCreateSchema.omit({ pipeline: true, stage: true }).partial();
export const activityPatchSchema = activityCreateSchema.partial();
export const notePatchSchema = noteCreateSchema.omit({ author: true }).partial();

export const createSchemas: Record<EntityName, z.ZodType> = {
  organization: organizationCreateSchema,
  contact: contactCreateSchema,
  deal: dealCreateSchema,
  activity: activityCreateSchema,
  note: noteCreateSchema,
};

export const patchSchemas: Record<EntityName, z.ZodType> = {
  organization: organizationPatchSchema,
  contact: contactPatchSchema,
  deal: dealPatchSchema,
  activity: activityPatchSchema,
  note: notePatchSchema,
};
