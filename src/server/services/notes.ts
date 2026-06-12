import type { Db } from "../db";
import { createRecord } from "./records";
import type { Ref } from "./resolve";
import type { Actor, ServiceRecord } from "./types";

/** log_note: first-class verb; thin wrapper over note creation (event included). */
export interface LogNoteInput {
  body: string;
  deal?: Ref;
  organization?: Ref;
  contact?: Ref;
  now?: string;
}

export async function logNote(db: Db, input: LogNoteInput, actor: Actor): Promise<ServiceRecord> {
  const { now, ...data } = input;
  return (await createRecord(db, { entity: "note", data, now }, actor)) as ServiceRecord;
}
