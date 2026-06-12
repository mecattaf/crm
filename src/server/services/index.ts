export { completeActivity, scheduleActivity } from "./activities";
export type { CompleteActivityInput, ScheduleActivityInput } from "./activities";
export { aggregate } from "./aggregate";
export type { AggregateGroup, AggregateInput, AggregateResult } from "./aggregate";
export { moveDeal } from "./deals";
export type { MoveDealInput } from "./deals";
export { forecast, fxEurMap, toEurCents } from "./forecast";
export type { ForecastDeal, ForecastInput, ForecastMonth, ForecastResult } from "./forecast";
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
export { compileFilters } from "./search";
export type { Actor, EntityName, ServiceRecord } from "./types";
export { ENTITIES } from "./types";
export {
  myDay,
  noNextActivity,
  overdueActivities,
  pipelineBoard,
  recentActivity,
  rottingFlag,
  staleDeals,
} from "./views";
export type {
  BoardDeal,
  BoardNextActivity,
  BoardStage,
  MyDayInput,
  MyDayItem,
  MyDayResult,
  NoNextActivityDeal,
  NoNextActivityInput,
  OverdueActivitiesInput,
  OverdueActivity,
  PipelineBoardInput,
  PipelineBoardResult,
  RecentActivityInput,
  RecentActivityItem,
  RottingFlag,
  StaleDeal,
  StaleDealsInput,
} from "./views";
