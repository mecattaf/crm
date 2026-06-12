export { completeActivity, scheduleActivity } from "./activities";
export type { CompleteActivityInput, ScheduleActivityInput } from "./activities";
export { moveDeal } from "./deals";
export type { MoveDealInput } from "./deals";
export { AmbiguousError, NotFoundError, ServiceError, ValidationError } from "./errors";
export { normalizeText } from "./normalize";
export { logNote } from "./notes";
export type { LogNoteInput } from "./notes";
export {
  archiveRecord,
  assembleTimeline,
  createRecord,
  deleteRecord,
  getRecord,
  updateRecord,
} from "./records";
export type {
  ArchiveRecordInput,
  CreateRecordInput,
  DeleteRecordInput,
  GetRecordInput,
  IncludeName,
  TimelineItem,
  UpdateRecordInput,
} from "./records";
export {
  resolveActivity,
  resolveContact,
  resolveDeal,
  resolveEntityRecord,
  resolveNote,
  resolveOrganization,
  resolvePipeline,
  resolveStage,
  resolveUser,
} from "./resolve";
export type { Ref } from "./resolve";
export { searchRecords } from "./search";
export type {
  Filter,
  FilterCond,
  OrGroup,
  SearchRecordsInput,
  SearchRecordsResult,
  SortSpec,
} from "./search";
export type { Actor, EntityName, ServiceRecord } from "./types";
export { ENTITIES } from "./types";
