import { createHash } from "node:crypto";
import { filterAuthorizedDescriptors } from "./authorization.js";
import { RECORD_EXPOSURES } from "./record-store.js";

export const DAY6_SCHEMA_VERSION = 1;
export const HISTORY_ENTRY_TYPES = Object.freeze({ MESSAGE: "MESSAGE", TOOL_RESULT: "TOOL_RESULT", COMPACTION: "COMPACTION" });
export const HISTORY_DESCRIPTOR_STATUS = Object.freeze({ ACTIVE: "ACTIVE", REVOKED: "REVOKED" });
export const EXPOSURE_OVERRIDE_KINDS = Object.freeze({ TASK_DIRECTIVE: "TASK_DIRECTIVE", HANDOFF: "HANDOFF" });

const EXPOSURE_SOURCES = new Set(["DEFAULT", ...Object.values(EXPOSURE_OVERRIDE_KINDS)]);
const DESCRIPTOR_FIELDS = new Set(["id", "piSessionRef", "piEntryId", "groupId", "sourceSessionId", "taskId", "entryType", "exposure", "exposureSource", "exposureAuthorityId", "status", "contentHash", "schemaVersion", "createdAt", "revokedAt"]);
const FORBIDDEN_DESCRIPTOR_FIELDS = new Set(["message", "content", "text", "summary", "payload", "arguments", "details", "thinking", "toolResult", "rawEntry"]);
const PI_ENTRY_TYPE_CODES = new Set(["message", "compaction", "thinking_level_change", "model_change", "branch_summary", "custom", "custom_message", "label", "session_info"]);
const copy = (value) => structuredClone(value);

export class HistorySidecarError extends Error {
  constructor(code, message = "History sidecar operation failed") {
    super(message);
    this.name = "HistorySidecarError";
    this.code = code;
  }
}

function fail(code, message) { throw new HistorySidecarError(code, message); }
function nonEmpty(value, code, field) {
  if (typeof value !== "string" || value.trim() === "") fail(code, `${field} must be a non-empty string`);
  return value.trim();
}
function exactNonEmpty(value, code, field) {
  const normalized = nonEmpty(value, code, field);
  if (normalized !== value) fail(code, `${field} must not contain surrounding whitespace`);
  return normalized;
}
function isoDate(value, code, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code, `${field} must be an ISO timestamp`);
  return value;
}

export function canonicalizePiEntry(entry) {
  const ancestors = new Set();
  const visit = (value) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("INVALID_CANONICAL_VALUE", "Pi entry contains a non-finite number");
      return JSON.stringify(value);
    }
    if (typeof value !== "object") fail("INVALID_CANONICAL_VALUE", "Pi entry contains a non-JSON value");
    if (ancestors.has(value)) fail("CYCLIC_ENTRY", "Pi entry is cyclic");
    if (Object.getOwnPropertySymbols(value).length) fail("INVALID_CANONICAL_VALUE", "Pi entry contains symbol keys");
    ancestors.add(value);
    let serialized;
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || value[index] === undefined) fail("INVALID_CANONICAL_VALUE", "Pi entry contains an undefined array slot");
        items.push(visit(value[index]));
      }
      serialized = `[${items.join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail("INVALID_CANONICAL_VALUE", "Pi entry must contain plain JSON objects");
      const keys = Object.keys(value).sort();
      for (const key of keys) {
        if (value[key] === undefined && !(value === entry && entry.type === "compaction" && ["details", "usage", "fromHook"].includes(key))) {
          fail("INVALID_CANONICAL_VALUE", "Pi entry contains undefined outside optional compaction fields");
        }
      }
      const serializedKeys = keys.filter((key) => value[key] !== undefined);
      serialized = `{${serializedKeys.map((key) => `${JSON.stringify(key)}:${visit(value[key])}`).join(",")}}`;
    }
    ancestors.delete(value);
    return serialized;
  };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("INVALID_ENTRY", "Pi entry must be an object");
  return visit(entry);
}

export function hashPiEntry(entry) {
  return `sha256:${createHash("sha256").update(canonicalizePiEntry(entry), "utf8").digest("hex")}`;
}

function classifyEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "compaction") return HISTORY_ENTRY_TYPES.COMPACTION;
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return null;
  if (entry.message.role === "user" || entry.message.role === "assistant") return HISTORY_ENTRY_TYPES.MESSAGE;
  if (entry.message.role === "toolResult") return HISTORY_ENTRY_TYPES.TOOL_RESULT;
  return null;
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) fail("INVALID_DESCRIPTOR", "descriptor must be an object");
  const prototype = Object.getPrototypeOf(descriptor);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_DESCRIPTOR", "descriptor must be a plain object");
  const keys = Reflect.ownKeys(descriptor);
  if (keys.some((key) => typeof key !== "string" || FORBIDDEN_DESCRIPTOR_FIELDS.has(key) || !DESCRIPTOR_FIELDS.has(key))) fail("INVALID_DESCRIPTOR", "descriptor contains an unsupported field");
  if (keys.some((key) => { const property = Object.getOwnPropertyDescriptor(descriptor, key); return !property.enumerable || !Object.hasOwn(property, "value"); })) fail("INVALID_DESCRIPTOR", "descriptor fields must be enumerable data properties");
  for (const key of ["id", "piSessionRef", "piEntryId", "groupId", "sourceSessionId", "contentHash"]) exactNonEmpty(descriptor[key], "INVALID_DESCRIPTOR", key);
  if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.contentHash)) fail("INVALID_DESCRIPTOR", "contentHash must be a SHA-256 digest");
  if (descriptor.taskId !== null) exactNonEmpty(descriptor.taskId, "INVALID_DESCRIPTOR", "taskId");
  if (!Object.values(HISTORY_ENTRY_TYPES).includes(descriptor.entryType)) fail("INVALID_DESCRIPTOR", "entryType is invalid");
  if (!Object.values(RECORD_EXPOSURES).includes(descriptor.exposure)) fail("INVALID_DESCRIPTOR", "exposure is invalid");
  if (!EXPOSURE_SOURCES.has(descriptor.exposureSource)) fail("INVALID_DESCRIPTOR", "exposureSource is invalid");
  if (descriptor.exposureSource === "DEFAULT") {
    if (descriptor.exposureAuthorityId !== null || descriptor.exposure !== RECORD_EXPOSURES.WORK_RECORD) fail("INVALID_DESCRIPTOR", "exposure provenance is inconsistent");
  } else {
    exactNonEmpty(descriptor.exposureAuthorityId, "INVALID_DESCRIPTOR", "exposureAuthorityId");
    if (descriptor.exposure !== RECORD_EXPOSURES.DESIGN_CONTEXT) fail("INVALID_DESCRIPTOR", "exposure provenance is inconsistent");
  }
  if (descriptor.status !== HISTORY_DESCRIPTOR_STATUS.ACTIVE && descriptor.status !== HISTORY_DESCRIPTOR_STATUS.REVOKED) fail("INVALID_DESCRIPTOR", "status is invalid");
  if (descriptor.schemaVersion !== DAY6_SCHEMA_VERSION) fail("INVALID_DESCRIPTOR", "schemaVersion is invalid");
  isoDate(descriptor.createdAt, "INVALID_DESCRIPTOR", "createdAt");
  if (!(descriptor.revokedAt === null || (typeof descriptor.revokedAt === "string" && Number.isFinite(Date.parse(descriptor.revokedAt)) && new Date(descriptor.revokedAt).toISOString() === descriptor.revokedAt))) fail("INVALID_DESCRIPTOR", "revokedAt is invalid");
  if (descriptor.status === HISTORY_DESCRIPTOR_STATUS.ACTIVE && descriptor.revokedAt !== null) fail("INVALID_DESCRIPTOR", "active descriptor cannot have revokedAt");
  if (descriptor.status === HISTORY_DESCRIPTOR_STATUS.REVOKED && descriptor.revokedAt === null) fail("INVALID_DESCRIPTOR", "revoked descriptor requires revokedAt");
}

export class HistoryCatalog {
  #descriptors = new Map();
  #entryKeys = new Map();
  #audit = [];
  #topologies = new Map();
  #now;

  constructor({ now = () => new Date() } = {}) {
    if (typeof now !== "function") fail("INVALID_CALLBACK", "now must be a function");
    this.#now = now;
  }

  registerDescriptor(descriptor) {
    validateDescriptor(descriptor);
    if (this.#descriptors.has(descriptor.id)) fail("DESCRIPTOR_ID_EXISTS", "descriptor id already exists");
    const key = `${descriptor.piSessionRef}\u0000${descriptor.piEntryId}`;
    if (this.#entryKeys.has(key)) fail("ENTRY_ALREADY_INDEXED", "Pi entry is already indexed");
    const stored = copy(descriptor);
    this.#descriptors.set(stored.id, stored);
    this.#entryKeys.set(key, stored.id);
    return copy(stored);
  }

  getDescriptor(descriptorId) {
    const id = nonEmpty(descriptorId, "DESCRIPTOR_ID_INVALID", "descriptorId");
    const descriptor = this.#descriptors.get(id);
    if (!descriptor) fail("DESCRIPTOR_NOT_FOUND", "descriptor was not found");
    return copy(descriptor);
  }

  findDescriptor({ piSessionRef, piEntryId } = {}) {
    nonEmpty(piSessionRef, "PI_SESSION_REF_INVALID", "piSessionRef");
    nonEmpty(piEntryId, "PI_ENTRY_ID_INVALID", "piEntryId");
    const id = this.#entryKeys.get(`${piSessionRef}\u0000${piEntryId}`);
    return id ? this.getDescriptor(id) : undefined;
  }

  listDescriptors(filters = {}) {
    const allowed = new Set(["groupId", "taskId", "sourceSessionId", "piSessionRef", "entryType", "status"]);
    if (Object.keys(filters).some((key) => !allowed.has(key))) fail("INVALID_FILTER", "unsupported descriptor filter");
    return [...this.#descriptors.values()].filter((descriptor) => Object.entries(filters).every(([key, value]) => descriptor[key] === value)).map(copy);
  }

  replaceSessionTopology({ piSessionRef, nodes, leafPiEntryId } = {}) {
    exactNonEmpty(piSessionRef, "TOPOLOGY_INVALID", "piSessionRef");
    if (!Array.isArray(nodes) || !(leafPiEntryId === null || typeof leafPiEntryId === "string")) fail("TOPOLOGY_INVALID", "topology shape is invalid");
    const copied = [];
    const byId = new Map();
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node) || Object.getPrototypeOf(node) !== Object.prototype || Reflect.ownKeys(node).length !== 2 || !Object.hasOwn(node, "piEntryId") || !Object.hasOwn(node, "piParentEntryId")) fail("TOPOLOGY_INVALID", "topology node schema is invalid");
      const piEntryId = exactNonEmpty(node.piEntryId, "TOPOLOGY_INVALID", "piEntryId");
      const piParentEntryId = node.piParentEntryId === null ? null : exactNonEmpty(node.piParentEntryId, "TOPOLOGY_INVALID", "piParentEntryId");
      if (byId.has(piEntryId)) fail("TOPOLOGY_DUPLICATE_ENTRY", "topology entry ID is duplicated");
      const stored = { piEntryId, piParentEntryId };
      byId.set(piEntryId, stored);
      copied.push(stored);
    }
    for (const node of copied) if (node.piParentEntryId !== null && !byId.has(node.piParentEntryId)) fail("TOPOLOGY_ORPHAN", "topology parent is unavailable");
    if (leafPiEntryId !== null) {
      exactNonEmpty(leafPiEntryId, "TOPOLOGY_INVALID", "leafPiEntryId");
      if (!byId.has(leafPiEntryId)) fail("TOPOLOGY_UNKNOWN_LEAF", "topology leaf is unavailable");
    }
    const complete = new Set();
    for (const start of copied) {
      const path = new Set();
      let current = start;
      while (current && !complete.has(current.piEntryId)) {
        if (path.has(current.piEntryId)) fail("TOPOLOGY_CYCLE", "topology contains a cycle");
        path.add(current.piEntryId);
        current = current.piParentEntryId === null ? null : byId.get(current.piParentEntryId);
      }
      for (const id of path) complete.add(id);
    }
    const topology = { piSessionRef, nodes: copied, leafPiEntryId };
    this.#topologies.set(piSessionRef, topology);
    return copy(topology);
  }

  getSessionTopology(piSessionRef) {
    exactNonEmpty(piSessionRef, "PI_SESSION_REF_INVALID", "piSessionRef");
    const topology = this.#topologies.get(piSessionRef);
    return topology ? copy(topology) : undefined;
  }

  listActiveBranchEntryIds(piSessionRef) {
    const topology = this.#topologies.get(exactNonEmpty(piSessionRef, "PI_SESSION_REF_INVALID", "piSessionRef"));
    if (!topology) fail("TOPOLOGY_NOT_FOUND", "session topology was not found");
    const byId = new Map(topology.nodes.map((node) => [node.piEntryId, node]));
    const branch = [];
    let current = topology.leafPiEntryId === null ? null : byId.get(topology.leafPiEntryId);
    while (current) {
      branch.push(current.piEntryId);
      current = current.piParentEntryId === null ? null : byId.get(current.piParentEntryId);
    }
    return branch.reverse();
  }

  listActiveBranchDescriptors(filters = {}) {
    const allowed = new Set(["piSessionRef", "groupId", "taskId", "sourceSessionId", "entryType", "status"]);
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => !allowed.has(key))) fail("INVALID_FILTER", "unsupported active-branch descriptor filter");
    const piSessionRef = exactNonEmpty(filters.piSessionRef, "INVALID_FILTER", "piSessionRef");
    const activeIds = new Set(this.listActiveBranchEntryIds(piSessionRef));
    return [...this.#descriptors.values()].filter((descriptor) => descriptor.piSessionRef === piSessionRef && activeIds.has(descriptor.piEntryId) && Object.entries(filters).every(([key, value]) => key === "piSessionRef" || descriptor[key] === value)).map(copy);
  }

  revokeDescriptor({ descriptorId, reason } = {}) {
    const descriptor = this.getDescriptor(descriptorId);
    if (!new Set(["POLICY_REVOKED", "SOURCE_REMOVED", "INTEGRITY_FAILURE", "USER_REQUEST"]).has(reason)) fail("REVOKE_REASON_INVALID", "reason must be an approved safe reason code");
    if (descriptor.status === HISTORY_DESCRIPTOR_STATUS.REVOKED) return descriptor;
    let revokedAt;
    try { revokedAt = new Date(this.#now()).toISOString(); } catch { fail("CLOCK_INVALID", "now returned an invalid date"); }
    const revoked = { ...descriptor, status: HISTORY_DESCRIPTOR_STATUS.REVOKED, revokedAt };
    this.#descriptors.set(descriptor.id, revoked);
    this.#audit.push({ code: "DESCRIPTOR_REVOKED", descriptorId: descriptor.id, piSessionRef: descriptor.piSessionRef, piEntryId: descriptor.piEntryId, reasonCode: reason, timestamp: revokedAt });
    return copy(revoked);
  }

  listAuditEvents() { return copy(this.#audit); }
}

function buildDescriptor({ id, piSessionRef, piEntryId, groupId, sourceSessionId, taskId, entryType, exposure, exposureSource, exposureAuthorityId, contentHash, createdAt }) {
  const descriptor = { id, piSessionRef, piEntryId, groupId, sourceSessionId, taskId, entryType, exposure, exposureSource, exposureAuthorityId, status: HISTORY_DESCRIPTOR_STATUS.ACTIVE, contentHash, schemaVersion: DAY6_SCHEMA_VERSION, createdAt, revokedAt: null };
  validateDescriptor(descriptor);
  return descriptor;
}

export class HistoryIndexer {
  constructor({ catalog, groupTree, taskManager, developmentRecordStore, now = () => new Date(), createId = () => `history-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 20)}` } = {}) {
    if (!(catalog instanceof HistoryCatalog) || !groupTree || typeof groupTree.getSession !== "function" || typeof groupTree.getGroup !== "function" || typeof createId !== "function" || typeof now !== "function") fail("INDEXER_CONFIG_INVALID", "indexer dependencies are invalid");
    this.catalog = catalog;
    this.groupTree = groupTree;
    this.taskManager = taskManager;
    this.developmentRecordStore = developmentRecordStore;
    this.now = now;
    this.createId = createId;
  }

  #validateAuthority(override, { groupId, taskId }) {
    const expectedType = override.provenance.kind === EXPOSURE_OVERRIDE_KINDS.TASK_DIRECTIVE ? "WORK_DIRECTIVE" : override.provenance.kind === EXPOSURE_OVERRIDE_KINDS.HANDOFF ? "HANDOFF" : null;
    if (!expectedType || override.exposure !== RECORD_EXPOSURES.DESIGN_CONTEXT || !this.developmentRecordStore || typeof this.developmentRecordStore.getDescriptor !== "function") fail("INVALID_EXPOSURE_OVERRIDE", "exposure override is invalid");
    const authorityId = nonEmpty(override.provenance.authorityRecordId, "INVALID_EXPOSURE_OVERRIDE", "authorityRecordId");
    let authority;
    try { authority = this.developmentRecordStore.getDescriptor(authorityId); } catch { fail("EXPOSURE_AUTHORITY_INVALID", "exposure authority is unavailable"); }
    if (authority.recordId !== authorityId || authority.groupId !== groupId || authority.taskId !== taskId || authority.type !== expectedType || authority.exposure !== RECORD_EXPOSURES.DESIGN_CONTEXT) fail("EXPOSURE_AUTHORITY_INVALID", "exposure authority does not match the history scope");
    return { exposure: RECORD_EXPOSURES.DESIGN_CONTEXT, exposureSource: override.provenance.kind, exposureAuthorityId: authorityId };
  }

  reconcile({ sessionManager, piSessionRef, groupId, sourceSessionId, taskId = null, exposureOverrides = [] } = {}) {
    nonEmpty(piSessionRef, "INDEX_SCOPE_INVALID", "piSessionRef");
    nonEmpty(groupId, "INDEX_SCOPE_INVALID", "groupId");
    nonEmpty(sourceSessionId, "INDEX_SCOPE_INVALID", "sourceSessionId");
    if (!(taskId === null || (typeof taskId === "string" && taskId.trim() !== ""))) fail("INDEX_SCOPE_INVALID", "taskId must be a string or null");
    if (!sessionManager || typeof sessionManager.getSessionId !== "function" || typeof sessionManager.getEntries !== "function" || typeof sessionManager.getLeafId !== "function") fail("SESSION_MANAGER_INVALID", "session manager is invalid");
    let group; let source;
    try { group = this.groupTree.getGroup(groupId); source = this.groupTree.getSession(sourceSessionId); } catch { fail("INDEX_SCOPE_INVALID", "group or source session is unavailable"); }
    if (source.groupId !== group.id || source.piSessionRef !== piSessionRef) fail("INDEX_SCOPE_MISMATCH", "source session does not match the index scope");
    if (sessionManager.getSessionId() !== piSessionRef) fail("SESSION_REF_MISMATCH", "Pi session does not match the index scope");
    if (taskId !== null) {
      if (!this.taskManager || typeof this.taskManager.getTask !== "function") fail("TASK_MANAGER_INVALID", "task manager is unavailable");
      let task; try { task = this.taskManager.getTask(taskId); } catch { fail("INDEX_SCOPE_INVALID", "task is unavailable"); }
      if (task.groupId !== groupId) fail("INDEX_SCOPE_MISMATCH", "task does not match the index scope");
    }
    if (!Array.isArray(exposureOverrides)) fail("INVALID_EXPOSURE_OVERRIDE", "exposureOverrides must be an array");
    const overrides = new Map();
    for (const override of exposureOverrides) {
      if (!override || typeof override !== "object" || Array.isArray(override) || Object.keys(override).sort().join(",") !== "exposure,piEntryId,provenance") fail("INVALID_EXPOSURE_OVERRIDE", "exposure override schema is invalid");
      const entryId = nonEmpty(override.piEntryId, "INVALID_EXPOSURE_OVERRIDE", "piEntryId");
      if (overrides.has(entryId)) fail("DUPLICATE_EXPOSURE_OVERRIDE", "duplicate exposure override");
      if (!override.provenance || typeof override.provenance !== "object" || Array.isArray(override.provenance) || Object.keys(override.provenance).sort().join(",") !== "authorityRecordId,kind") fail("INVALID_EXPOSURE_OVERRIDE", "exposure provenance schema is invalid");
      overrides.set(entryId, override);
    }
    let entries;
    try { entries = sessionManager.getEntries(); } catch { fail("ENTRY_SCAN_FAILED", "Pi entries could not be read"); }
    if (!Array.isArray(entries)) fail("ENTRY_SCAN_FAILED", "Pi entries response is invalid");
    let leafPiEntryId;
    try { leafPiEntryId = sessionManager.getLeafId(); } catch { fail("LEAF_READ_FAILED", "Pi session leaf could not be read"); }
    const topologyNodes = [];
    const seenEntryIds = new Set();
    for (const entry of entries) {
      const piEntryId = typeof entry?.id === "string" ? entry.id : null;
      if (!piEntryId || seenEntryIds.has(piEntryId) || !(entry.parentId == null || typeof entry.parentId === "string")) fail("TOPOLOGY_ENTRY_INVALID", "Pi entry topology metadata is invalid");
      seenEntryIds.add(piEntryId);
      topologyNodes.push({ piEntryId, piParentEntryId: entry.parentId ?? null });
    }
    const previousTopology = this.catalog.getSessionTopology(piSessionRef);
    const candidateIds = new Set(topologyNodes.map(({ piEntryId }) => piEntryId));
    const integrityConflicts = [];
    if (previousTopology) {
      const candidateById = new Map(topologyNodes.map((node) => [node.piEntryId, node]));
      for (const oldNode of previousTopology.nodes) {
        const current = candidateById.get(oldNode.piEntryId);
        if (!current) integrityConflicts.push({ piEntryId: oldNode.piEntryId, descriptorId: null, reasonCode: "SEEN_ENTRY_DISAPPEARED" });
        else if (current.piParentEntryId !== oldNode.piParentEntryId) integrityConflicts.push({ piEntryId: oldNode.piEntryId, descriptorId: null, reasonCode: "PARENT_DRIFT" });
      }
    }
    for (const descriptor of this.catalog.listDescriptors({ piSessionRef })) if (!candidateIds.has(descriptor.piEntryId)) integrityConflicts.push({ piEntryId: descriptor.piEntryId, descriptorId: descriptor.id, reasonCode: "DESCRIPTOR_OUTSIDE_TOPOLOGY" });
    const report = { scannedCount: entries.length, createdDescriptorIds: [], unchangedDescriptorIds: [], skipped: [], conflicts: integrityConflicts };
    if (integrityConflicts.length) return copy(report);
    this.catalog.replaceSessionTopology({ piSessionRef, nodes: topologyNodes, leafPiEntryId });
    const foundOverrideIds = new Set();
    for (const entry of entries) {
      const entryId = typeof entry?.id === "string" ? entry.id : null;
      const entryType = typeof entry?.type === "string" && PI_ENTRY_TYPE_CODES.has(entry.type) ? entry.type : "unsupported";
      const classified = classifyEntry(entry);
      if (!classified) {
        report.skipped.push({ piEntryId: entryId, piEntryType: entryType, reasonCode: "SKIPPED_UNSUPPORTED_ENTRY" });
        continue;
      }
      if (!entryId) { report.skipped.push({ piEntryId: null, piEntryType: entryType, reasonCode: "SKIPPED_INVALID_ENTRY_ID" }); continue; }
      let canonicalHash;
      try { canonicalHash = hashPiEntry(entry); } catch (error) { report.conflicts.push({ piEntryId: entryId, descriptorId: null, reasonCode: error.code ?? "INVALID_ENTRY_HASH" }); continue; }
      const override = overrides.get(entryId);
      const existing = this.catalog.findDescriptor({ piSessionRef, piEntryId: entryId });
      let provenance = existing
        ? { exposure: existing.exposure, exposureSource: existing.exposureSource, exposureAuthorityId: existing.exposureAuthorityId }
        : { exposure: RECORD_EXPOSURES.WORK_RECORD, exposureSource: "DEFAULT", exposureAuthorityId: null };
      if (override) {
        foundOverrideIds.add(entryId);
        provenance = this.#validateAuthority(override, { groupId, taskId });
      }
      if (existing) {
        const metadataMatches = existing.groupId === groupId && existing.sourceSessionId === sourceSessionId && existing.taskId === taskId && existing.entryType === classified && existing.exposure === provenance.exposure && existing.exposureSource === provenance.exposureSource && existing.exposureAuthorityId === provenance.exposureAuthorityId;
        if (existing.contentHash !== canonicalHash) report.conflicts.push({ piEntryId: entryId, descriptorId: existing.id, reasonCode: "CONTENT_HASH_MISMATCH" });
        else if (!metadataMatches) report.conflicts.push({ piEntryId: entryId, descriptorId: existing.id, reasonCode: "DESCRIPTOR_METADATA_MISMATCH" });
        else report.unchangedDescriptorIds.push(existing.id);
        continue;
      }
      let createdAt;
      try { createdAt = new Date(this.now()).toISOString(); } catch { fail("CLOCK_INVALID", "now returned an invalid date"); }
      const descriptor = buildDescriptor({ id: nonEmpty(this.createId({ piSessionRef, piEntryId: entryId }), "DESCRIPTOR_ID_INVALID", "createId result"), piSessionRef, piEntryId: entryId, groupId, sourceSessionId, taskId, entryType: classified, ...provenance, contentHash: canonicalHash, createdAt });
      try { this.catalog.registerDescriptor(descriptor); report.createdDescriptorIds.push(descriptor.id); }
      catch (error) {
        if (error.code === "DESCRIPTOR_ID_EXISTS" || error.code === "ENTRY_ALREADY_INDEXED") report.conflicts.push({ piEntryId: entryId, descriptorId: null, reasonCode: error.code });
        else throw error;
      }
    }
    for (const entryId of overrides.keys()) if (!foundOverrideIds.has(entryId)) fail("OVERRIDE_ENTRY_NOT_FOUND", "override did not match an eligible entry");
    return copy(report);
  }
}

export function toAuthorizationDescriptor(historyDescriptor) {
  validateDescriptor(historyDescriptor);
  return {
    recordId: historyDescriptor.id,
    groupId: historyDescriptor.groupId,
    taskId: historyDescriptor.taskId ?? undefined,
    sourceSessionId: historyDescriptor.sourceSessionId,
    type: historyDescriptor.entryType,
    exposure: historyDescriptor.exposure,
    sourceRecordIds: [],
    contentHash: historyDescriptor.contentHash,
    schemaVersion: historyDescriptor.schemaVersion,
    createdAt: historyDescriptor.createdAt,
  };
}

export function filterAuthorizedHistoryDescriptors({ viewerSessionId, descriptors, groupTree } = {}) {
  if (!Array.isArray(descriptors)) fail("INVALID_DESCRIPTOR_LIST", "descriptors must be an array");
  const active = [];
  const decisions = [];
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (descriptor.status === HISTORY_DESCRIPTOR_STATUS.REVOKED) {
      decisions.push({ recordId: descriptor.id, allowed: false, relationship: "UNRESOLVED", access: "DENIED", reasonCode: "DENY_REVOKED_DESCRIPTOR" });
    } else active.push(descriptor);
  }
  let filtered;
  try { filtered = filterAuthorizedDescriptors({ viewerSessionId, descriptors: active.map(toAuthorizationDescriptor), groupTree }); }
  catch { fail("AUTHORIZATION_FAILED", "history authorization failed"); }
  const byId = new Map(active.map((descriptor) => [descriptor.id, descriptor]));
  for (const decision of filtered.decisions) decisions.push(copy(decision));
  return {
    descriptors: filtered.descriptors.map((descriptor) => copy(byId.get(descriptor.recordId))),
    decisions: decisions.map((decision) => ({ ...decision })),
  };
}

export class HistoryLoader {
  constructor({ catalog, resolveSessionManager } = {}) {
    if (!(catalog instanceof HistoryCatalog) || typeof resolveSessionManager !== "function") fail("LOADER_CONFIG_INVALID", "loader dependencies are invalid");
    this.catalog = catalog;
    this.resolveSessionManager = resolveSessionManager;
  }

  loadAllowed({ allowedDescriptorIds } = {}) {
    if (!Array.isArray(allowedDescriptorIds)) fail("INVALID_DESCRIPTOR_IDS", "allowedDescriptorIds must be an array");
    const seen = new Set();
    const loaded = [];
    for (const rawId of allowedDescriptorIds) {
      const id = nonEmpty(rawId, "INVALID_DESCRIPTOR_ID", "descriptorId");
      if (seen.has(id)) fail("DUPLICATE_DESCRIPTOR_ID", "descriptor IDs must be unique");
      seen.add(id);
      const descriptor = this.catalog.getDescriptor(id);
      if (descriptor.status !== HISTORY_DESCRIPTOR_STATUS.ACTIVE) fail("DESCRIPTOR_REVOKED", "descriptor is revoked");
      if (descriptor.entryType === HISTORY_ENTRY_TYPES.COMPACTION) fail("CONTENT_NOT_LOADABLE", "compaction content is metadata-only");
      let sessionManager;
      try { sessionManager = this.resolveSessionManager(descriptor.piSessionRef); } catch { fail("SESSION_NOT_FOUND", "Pi session is unavailable"); }
      if (!sessionManager || typeof sessionManager.getSessionId !== "function" || typeof sessionManager.getEntry !== "function") fail("SESSION_NOT_FOUND", "Pi session is unavailable");
      let actualSessionId;
      try { actualSessionId = sessionManager.getSessionId(); } catch { fail("SESSION_NOT_FOUND", "Pi session is unavailable"); }
      if (actualSessionId !== descriptor.piSessionRef) fail("SESSION_REF_MISMATCH", "Pi session reference does not match");
      let entry;
      try { entry = sessionManager.getEntry(descriptor.piEntryId); } catch { fail("PI_ENTRY_NOT_FOUND", "Pi entry is unavailable"); }
      if (!entry || entry.id !== descriptor.piEntryId) fail("PI_ENTRY_NOT_FOUND", "Pi entry is unavailable");
      let currentHash;
      try { currentHash = hashPiEntry(entry); } catch { fail("ENTRY_HASH_INVALID", "Pi entry cannot be verified"); }
      if (currentHash !== descriptor.contentHash) fail("CONTENT_HASH_MISMATCH", "Pi entry integrity check failed");
      if (classifyEntry(entry) !== descriptor.entryType) fail("ENTRY_TYPE_MISMATCH", "Pi entry type changed");
      loaded.push({ descriptor: copy(descriptor), entry: copy(entry) });
    }
    return loaded;
  }
}

function countOmitted(target, key) { target[key] += 1; }
function assertJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_TOOL_ARGUMENTS", "tool arguments must be a JSON object");
  let cloned;
  const seen = new Set();
  const rejectLossyValues = (item) => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") fail("INVALID_TOOL_ARGUMENTS", "tool arguments must be lossless JSON data");
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) fail("INVALID_TOOL_ARGUMENTS", "tool arguments must not contain sparse arrays");
        rejectLossyValues(item[index]);
      }
    } else for (const child of Object.values(item)) rejectLossyValues(child);
  };
  try { rejectLossyValues(value); cloned = JSON.parse(canonicalizePiEntry(value)); } catch { fail("INVALID_TOOL_ARGUMENTS", "tool arguments must be lossless JSON data"); }
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) fail("INVALID_TOOL_ARGUMENTS", "tool arguments must be a JSON object");
  return cloned;
}

export function extractExplicitContent({ descriptor, entry } = {}) {
  validateDescriptor(descriptor);
  if (descriptor.status !== HISTORY_DESCRIPTOR_STATUS.ACTIVE) fail("DESCRIPTOR_REVOKED", "descriptor is revoked");
  if (!entry || entry.id !== descriptor.piEntryId || classifyEntry(entry) !== descriptor.entryType) fail("ENTRY_TYPE_MISMATCH", "Pi entry does not match descriptor");
  if (descriptor.entryType !== HISTORY_ENTRY_TYPES.MESSAGE && descriptor.entryType !== HISTORY_ENTRY_TYPES.TOOL_RESULT) fail("CONTENT_NOT_LOADABLE", "entry type is metadata-only");
  const items = [];
  const omitted = { thinkingBlockCount: 0, imageBlockCount: 0, unsupportedBlockCount: 0 };
  const message = entry.message;
  const textItem = (role, text) => { if (typeof text === "string") items.push({ type: "TEXT", role, text }); else countOmitted(omitted, "unsupportedBlockCount"); };
  if (message.role === "user") {
    if (typeof message.content === "string") textItem("user", message.content);
    else if (Array.isArray(message.content)) for (const block of message.content) {
      if (block?.type === "text") textItem("user", block.text);
      else if (block?.type === "image") countOmitted(omitted, "imageBlockCount");
      else if (block?.type === "thinking") countOmitted(omitted, "thinkingBlockCount");
      else countOmitted(omitted, "unsupportedBlockCount");
    }
    else countOmitted(omitted, "unsupportedBlockCount");
  } else if (message.role === "assistant") {
    if (!Array.isArray(message.content)) fail("INVALID_MESSAGE_CONTENT", "assistant content must be an array");
    for (const block of message.content) {
      if (block?.type === "text") textItem("assistant", block.text);
      else if (block?.type === "toolCall") {
        if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) fail("INVALID_TOOL_CALL", "tool call metadata is invalid");
        items.push({ type: "TOOL_CALL", toolCallId: block.id, toolName: block.name, arguments: assertJsonObject(block.arguments) });
      } else if (block?.type === "thinking") countOmitted(omitted, "thinkingBlockCount");
      else if (block?.type === "image") countOmitted(omitted, "imageBlockCount");
      else countOmitted(omitted, "unsupportedBlockCount");
    }
  } else if (message.role === "toolResult") {
    if (typeof message.toolCallId !== "string" || !message.toolCallId || typeof message.toolName !== "string" || !message.toolName || typeof message.isError !== "boolean") fail("INVALID_TOOL_RESULT", "tool result metadata is invalid");
    let text = "";
    if (!Array.isArray(message.content)) fail("INVALID_MESSAGE_CONTENT", "tool result content must be an array");
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
      else if (block?.type === "image") countOmitted(omitted, "imageBlockCount");
      else if (block?.type === "thinking") countOmitted(omitted, "thinkingBlockCount");
      else countOmitted(omitted, "unsupportedBlockCount");
    }
    items.push({ type: "TOOL_RESULT", toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, text });
  }
  return { descriptorId: descriptor.id, piSessionRef: descriptor.piSessionRef, piEntryId: descriptor.piEntryId, sourceSessionId: descriptor.sourceSessionId, entryType: descriptor.entryType, items, omitted };
}

export function loadAuthorizedExplicitHistory({ viewerSessionId, catalog, loader, groupTree, filters = {} } = {}) {
  if (!(catalog instanceof HistoryCatalog) || !(loader instanceof HistoryLoader)) fail("PIPELINE_CONFIG_INVALID", "catalog and loader are required");
  let listed;
  try { listed = catalog.listDescriptors(filters); } catch { fail("CATALOG_LIST_FAILED", "history descriptors could not be listed"); }
  const authorized = filterAuthorizedHistoryDescriptors({ viewerSessionId, descriptors: listed, groupTree });
  const metadataOnlyDescriptors = authorized.descriptors.filter((descriptor) => descriptor.entryType === HISTORY_ENTRY_TYPES.COMPACTION).map(copy);
  const loadable = authorized.descriptors.filter((descriptor) => descriptor.entryType !== HISTORY_ENTRY_TYPES.COMPACTION);
  const loaded = loader.loadAllowed({ allowedDescriptorIds: loadable.map((descriptor) => descriptor.id) });
  const extractedItems = loaded.map(({ descriptor, entry }) => extractExplicitContent({ descriptor, entry }));
  return { descriptors: authorized.descriptors.map(copy), decisions: authorized.decisions.map(copy), metadataOnlyDescriptors, extractedItems };
}
