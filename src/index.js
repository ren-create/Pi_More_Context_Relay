/**
 * Pi More Context Relay
 *
 * The first verified runtime slice is the JavaScript dual-session spike in
 * scripts/pi-dual-session-spike.mjs. Product modules will be added one vertical
 * slice at a time.
 */
export const PROJECT_NAME = "Pi More Context Relay";
export const PROJECT_STATUS = "phase-2-day-7-complete";

export {
  GroupTreeError,
  GroupTreeManager,
  HISTORY_ACCESS,
  RELATIONSHIPS,
} from "./group-tree.js";

export { TaskError, TaskManager, TASK_STATUS } from "./task-manager.js";
export { DevelopmentRecordError, DevelopmentRecordStore, RECORD_TYPES, RECORD_EXPOSURES } from "./record-store.js";
export { AuthorizationError, authorizeRecordDescriptor, filterAuthorizedDescriptors } from "./authorization.js";

export {
  GROUP_FACT_AUDIT_CODES,
  GROUP_FACT_SCHEMA_VERSION,
  GROUP_FACT_STATUS,
  GroupFactError,
  GroupFactStore,
  canonicalizeFactValue,
  hashFactValue,
} from "./group-fact-store.js";

export {
  FACT_TOKEN_ESTIMATOR_VERSION,
  FactSnapshotError,
  FactSnapshotManager,
  estimateFactTokens,
} from "./fact-snapshot.js";

export {
  DAY6_SCHEMA_VERSION,
  EXPOSURE_OVERRIDE_KINDS,
  HISTORY_DESCRIPTOR_STATUS,
  HISTORY_ENTRY_TYPES,
  HistoryCatalog,
  HistoryIndexer,
  HistoryLoader,
  HistorySidecarError,
  canonicalizePiEntry,
  extractExplicitContent,
  filterAuthorizedHistoryDescriptors,
  hashPiEntry,
  loadAuthorizedExplicitHistory,
  toAuthorizationDescriptor,
} from "./history-sidecar.js";
