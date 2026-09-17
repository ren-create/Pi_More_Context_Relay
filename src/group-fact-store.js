import { createHash } from "node:crypto";

export const GROUP_FACT_SCHEMA_VERSION = 1;
export const GROUP_FACT_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SUPERSEDED: "SUPERSEDED", REVOKED: "REVOKED" });
export const GROUP_FACT_AUDIT_CODES = Object.freeze({ PUBLISHED: "PUBLISHED", SUPERSEDED: "SUPERSEDED", REPUBLISHED: "REPUBLISHED", REVOKED: "REVOKED" });

const FACT_FIELDS = new Set(["id", "groupId", "factKey", "version", "value", "status", "supersedesId", "supersededById", "createdBySessionId", "contentHash", "schemaVersion", "createdAt", "supersededAt", "revokedAt", "revokedBySessionId", "revokeReason"]);
const REVOKE_REASONS = new Set(["POLICY_REVOKED", "INCORRECT", "OBSOLETE", "USER_REQUEST"]);
const copy = (value) => structuredClone(value);
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class GroupFactError extends Error {
  constructor(code, message = "Group fact operation failed") {
    super(message);
    this.name = "GroupFactError";
    this.code = code;
  }
}

function fail(code, message = "Group fact operation failed") { throw new GroupFactError(code, message); }

function exactString(value, code, field) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) fail(code, `${field} must be a non-empty string without surrounding whitespace`);
  return value;
}

function isoTimestamp(value, code, field) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(code, `${field} clock value is invalid`);
  return value.toISOString();
}

export function canonicalizeFactValue(value) {
  const ancestors = new Set();
  const visit = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("FACT_VALUE_INVALID", "value contains a non-finite number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") fail("FACT_VALUE_INVALID", "value contains a non-JSON value");
    if (ancestors.has(item)) fail("FACT_VALUE_INVALID", "value contains a cycle");
    if (Object.getOwnPropertySymbols(item).length) fail("FACT_VALUE_INVALID", "value contains symbol keys");
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) fail("FACT_VALUE_INVALID", "array must be a plain array");
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) fail("FACT_VALUE_INVALID", "array contains unsupported properties");
      const values = [];
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) fail("FACT_VALUE_INVALID", "array contains a missing element");
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("FACT_VALUE_INVALID", "array elements must be enumerable data properties");
        values.push(visit(descriptor.value));
      }
      result = `[${values.join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) fail("FACT_VALUE_INVALID", "value objects must be plain objects");
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) fail("FACT_VALUE_INVALID", "value contains a symbol key");
      const pairs = [];
      for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("FACT_VALUE_INVALID", "object fields must be enumerable data properties");
        pairs.push(`${JSON.stringify(key)}:${visit(descriptor.value)}`);
      }
      result = `{${pairs.join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value);
}

export function hashFactValue(value) {
  return `sha256:${createHash("sha256").update(canonicalizeFactValue(value), "utf8").digest("hex")}`;
}

function validateFact(fact) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact) || (Object.getPrototypeOf(fact) !== Object.prototype && Object.getPrototypeOf(fact) !== null)) fail("FACT_SCHEMA_INVALID", "fact must be a plain object");
  const keys = Reflect.ownKeys(fact);
  if (keys.some((key) => typeof key !== "string" || !FACT_FIELDS.has(key))) fail("FACT_SCHEMA_INVALID", "fact contains an unsupported field");
  if (keys.some((key) => { const descriptor = Object.getOwnPropertyDescriptor(fact, key); return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"); })) fail("FACT_SCHEMA_INVALID", "fact fields must be enumerable data properties");
  for (const field of ["id", "groupId", "factKey", "createdBySessionId", "contentHash"]) exactString(fact[field], "FACT_SCHEMA_INVALID", field);
  if (fact.factKey.length > 128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(fact.factKey)) fail("FACT_SCHEMA_INVALID", "factKey format is invalid");
  if (!Number.isSafeInteger(fact.version) || fact.version < 1) fail("FACT_SCHEMA_INVALID", "version must be a positive safe integer");
  if (!Object.values(GROUP_FACT_STATUS).includes(fact.status)) fail("FACT_SCHEMA_INVALID", "status is invalid");
  if (!(fact.supersedesId === null || (typeof fact.supersedesId === "string" && fact.supersedesId.length > 0 && fact.supersedesId === fact.supersedesId.trim()))) fail("FACT_SCHEMA_INVALID", "supersedesId is invalid");
  if (!(fact.supersededById === null || (typeof fact.supersededById === "string" && fact.supersededById.length > 0 && fact.supersededById === fact.supersededById.trim()))) fail("FACT_SCHEMA_INVALID", "supersededById is invalid");
  if (fact.schemaVersion !== GROUP_FACT_SCHEMA_VERSION) fail("FACT_SCHEMA_INVALID", "schemaVersion is invalid");
  if (!/^sha256:[0-9a-f]{64}$/.test(fact.contentHash)) fail("FACT_SCHEMA_INVALID", "contentHash is invalid");
  if (typeof fact.createdAt !== "string" || !Number.isFinite(Date.parse(fact.createdAt)) || new Date(fact.createdAt).toISOString() !== fact.createdAt) fail("FACT_SCHEMA_INVALID", "createdAt is invalid");
  for (const field of ["supersededAt", "revokedAt"]) if (!(fact[field] === null || (typeof fact[field] === "string" && Number.isFinite(Date.parse(fact[field])) && new Date(fact[field]).toISOString() === fact[field]))) fail("FACT_SCHEMA_INVALID", `${field} is invalid`);
  if (!(fact.revokedBySessionId === null || (typeof fact.revokedBySessionId === "string" && fact.revokedBySessionId !== "" && fact.revokedBySessionId === fact.revokedBySessionId.trim()))) fail("FACT_SCHEMA_INVALID", "revokedBySessionId is invalid");
  if (!(fact.revokeReason === null || REVOKE_REASONS.has(fact.revokeReason))) fail("FACT_SCHEMA_INVALID", "revokeReason is invalid");
  if (fact.status === "ACTIVE" && (fact.supersededById !== null || fact.supersededAt !== null || fact.revokedAt !== null || fact.revokedBySessionId !== null || fact.revokeReason !== null)) fail("FACT_SCHEMA_INVALID", "active fact lifecycle fields are inconsistent");
  if (fact.status === "SUPERSEDED" && (!fact.supersededById || !fact.supersededAt || fact.revokedAt !== null || fact.revokedBySessionId !== null || fact.revokeReason !== null)) fail("FACT_SCHEMA_INVALID", "superseded fact lifecycle fields are inconsistent");
  if (fact.status === "REVOKED" && (fact.supersededById !== null || fact.supersededAt !== null || !fact.revokedAt || !fact.revokedBySessionId || !fact.revokeReason)) fail("FACT_SCHEMA_INVALID", "revoked fact lifecycle fields are inconsistent");
  const canonicalValue = canonicalizeFactValue(fact.value);
  const expectedHash = `sha256:${createHash("sha256").update(canonicalValue, "utf8").digest("hex")}`;
  if (fact.contentHash !== expectedHash) fail("FACT_SCHEMA_INVALID", "contentHash does not match value");
}

export class GroupFactStore {
  #facts = new Map();
  #keys = new Map();
  #audit = [];
  #groupTree;
  #now;

  constructor({ groupTree, now = () => new Date() } = {}) {
    if (!groupTree || typeof groupTree.getGroup !== "function" || typeof groupTree.getSession !== "function" || typeof now !== "function") fail("STORE_CONFIG_INVALID", "groupTree and now callback are required");
    this.#groupTree = groupTree;
    this.#now = now;
  }

  #groupKey(groupId, factKey) { return `${groupId}\u0000${factKey}`; }
  #versions(groupId, factKey) { return (this.#keys.get(this.#groupKey(groupId, factKey)) ?? []).map((id) => this.#facts.get(id)); }
  #actor(groupId, sessionId) {
    exactString(groupId, "GROUP_INVALID", "groupId");
    exactString(sessionId, "SESSION_INVALID", "sessionId");
    let group; let session;
    try { group = this.#groupTree.getGroup(groupId); session = this.#groupTree.getSession(sessionId); } catch { fail("AUTHORIZATION_DENIED", "session is not authorized for this group"); }
    if (session.groupId !== group.id) fail("AUTHORIZATION_DENIED", "session is not authorized for this group");
    return { group, session };
  }
  #rootActor(groupId, sessionId) {
    const identity = this.#actor(groupId, sessionId);
    if (identity.group.rootSessionId !== identity.session.id) fail("ROOT_AUTHORITY_REQUIRED", "mutation requires the group root session");
    return identity;
  }
  #time() {
    let value;
    try { value = this.#now(); } catch { fail("CLOCK_INVALID", "clock callback failed"); }
    return isoTimestamp(value, "CLOCK_INVALID", "now");
  }
  #appendAudit(event) { this.#audit.push(event); }
  #makeFact({ id, groupId, factKey, value, version, status = "ACTIVE", supersedesId = null, createdBySessionId, contentHash, createdAt, supersededById = null, supersededAt = null, revokedAt = null, revokedBySessionId = null, revokeReason = null }) {
    const fact = { id, groupId, factKey, version, value: copy(value), status, supersedesId, supersededById, createdBySessionId, contentHash, schemaVersion: GROUP_FACT_SCHEMA_VERSION, createdAt, supersededAt, revokedAt, revokedBySessionId, revokeReason };
    validateFact(fact);
    return fact;
  }
  #validatedValue(value) {
    const canonical = canonicalizeFactValue(value);
    const snapshot = copy(value);
    const contentHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    return { value: snapshot, contentHash };
  }
  #register(fact) {
    this.#facts.set(fact.id, fact);
    const key = this.#groupKey(fact.groupId, fact.factKey);
    const versions = this.#keys.get(key) ?? [];
    versions.push(fact.id);
    this.#keys.set(key, versions);
  }
  #newId(id) {
    exactString(id, "FACT_ID_INVALID", "id");
    if (this.#facts.has(id)) fail("FACT_ID_EXISTS", "fact id already exists");
    return id;
  }
  #normalizeKey(factKey) {
    exactString(factKey, "FACT_KEY_INVALID", "factKey");
    if (factKey.length > 128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(factKey)) fail("FACT_KEY_INVALID", "factKey format is invalid");
    return factKey;
  }
  #auditEvent({ code, fact, actorSessionId, previousStatus = null, newStatus, relatedFactId = null, reason = null, timestamp }) {
    return { code, factId: fact.id, groupId: fact.groupId, factKey: fact.factKey, version: fact.version, actorSessionId, previousStatus, newStatus, relatedFactId, reason, timestamp };
  }

  publishFact({ id, groupId, factKey, value, createdBySessionId } = {}) {
    this.#rootActor(groupId, createdBySessionId);
    id = this.#newId(id);
    factKey = this.#normalizeKey(factKey);
    const group = exactString(groupId, "GROUP_INVALID", "groupId");
    if (this.#versions(group, factKey).length) fail("FACT_ALREADY_EXISTS", "fact key already has a version");
    const validatedValue = this.#validatedValue(value);
    const createdAt = this.#time();
    const fact = this.#makeFact({ id, groupId: group, factKey, ...validatedValue, version: 1, createdBySessionId, createdAt });
    const audit = this.#auditEvent({ code: GROUP_FACT_AUDIT_CODES.PUBLISHED, fact, actorSessionId: createdBySessionId, newStatus: fact.status, timestamp: createdAt });
    this.#register(fact);
    this.#appendAudit(audit);
    return copy(fact);
  }

  replaceFact({ id, groupId, factKey, value, createdBySessionId, expectedPreviousFactId } = {}) {
    this.#rootActor(groupId, createdBySessionId);
    id = this.#newId(id);
    factKey = this.#normalizeKey(factKey);
    const group = exactString(groupId, "GROUP_INVALID", "groupId");
    const versions = this.#versions(group, factKey);
    const previous = versions.at(-1);
    if (!previous) fail("FACT_NOT_FOUND", "fact key has no prior version");
    if (expectedPreviousFactId !== previous.id) fail("STALE_EXPECTED_FACT", "expected previous fact does not match latest version");
    if (versions.filter(({ status }) => status === "ACTIVE").length > 1) fail("FACT_STATE_CONFLICT", "fact key has multiple active versions");
    if (previous.status !== "ACTIVE" && previous.status !== "REVOKED") fail("FACT_STATE_CONFLICT", "latest fact cannot be replaced");
    const validatedValue = this.#validatedValue(value);
    const { contentHash } = validatedValue;
    if (previous.status === "ACTIVE" && previous.contentHash === contentHash) fail("NO_FACT_CHANGE", "active fact value is unchanged");
    if (previous.version >= Number.MAX_SAFE_INTEGER) fail("FACT_VERSION_EXHAUSTED", "fact version cannot be incremented");
    const timestamp = this.#time();
    const next = this.#makeFact({ id, groupId: group, factKey, ...validatedValue, version: previous.version + 1, supersedesId: previous.id, createdBySessionId, createdAt: timestamp });
    const priorUpdate = previous.status === "ACTIVE" ? { ...previous, status: "SUPERSEDED", supersededById: next.id, supersededAt: timestamp } : null;
    if (priorUpdate) validateFact(priorUpdate);
    const audit = this.#auditEvent({ code: previous.status === "REVOKED" ? GROUP_FACT_AUDIT_CODES.REPUBLISHED : GROUP_FACT_AUDIT_CODES.SUPERSEDED, fact: next, actorSessionId: createdBySessionId, previousStatus: previous.status, newStatus: next.status, relatedFactId: previous.id, timestamp });
    if (priorUpdate) this.#facts.set(previous.id, priorUpdate);
    this.#register(next);
    this.#appendAudit(audit);
    return copy(next);
  }

  revokeFact({ groupId, factKey, revokedBySessionId, expectedActiveFactId, reason } = {}) {
    this.#rootActor(groupId, revokedBySessionId);
    factKey = this.#normalizeKey(factKey);
    if (!REVOKE_REASONS.has(reason)) fail("REVOKE_REASON_INVALID", "reason is not an approved safe code");
    const group = exactString(groupId, "GROUP_INVALID", "groupId");
    const versions = this.#versions(group, factKey);
    const active = versions.filter(({ status }) => status === "ACTIVE");
    if (active.length !== 1) fail("ACTIVE_FACT_NOT_FOUND", "fact key does not have exactly one active version");
    const previous = active[0];
    if (expectedActiveFactId !== previous.id) fail("STALE_EXPECTED_FACT", "expected active fact does not match");
    const timestamp = this.#time();
    const revoked = { ...previous, status: "REVOKED", revokedAt: timestamp, revokedBySessionId, revokeReason: reason };
    validateFact(revoked);
    const audit = this.#auditEvent({ code: GROUP_FACT_AUDIT_CODES.REVOKED, fact: revoked, actorSessionId: revokedBySessionId, previousStatus: previous.status, newStatus: revoked.status, reason, timestamp });
    this.#facts.set(previous.id, revoked);
    this.#appendAudit(audit);
    return copy(revoked);
  }

  getFact({ factId, viewerSessionId } = {}) {
    exactString(factId, "FACT_ID_INVALID", "factId");
    const fact = this.#facts.get(factId);
    if (!fact) fail("FACT_NOT_FOUND", "fact was not found");
    this.#actor(fact.groupId, viewerSessionId);
    return copy(fact);
  }

  getActiveFact({ groupId, factKey, viewerSessionId } = {}) {
    const { group } = this.#actor(groupId, viewerSessionId);
    factKey = this.#normalizeKey(factKey);
    const active = this.#versions(group.id, factKey).filter(({ status }) => status === "ACTIVE");
    if (active.length > 1) fail("FACT_STATE_CONFLICT", "fact key has multiple active versions");
    return active.length ? copy(active[0]) : undefined;
  }

  listActiveFacts({ groupId, viewerSessionId } = {}) {
    const { group } = this.#actor(groupId, viewerSessionId);
    return [...this.#facts.values()].filter(({ groupId: owner, status }) => owner === group.id && status === "ACTIVE").sort((a, b) => compareText(a.factKey, b.factKey) || a.version - b.version).map(copy);
  }

  listFactVersions({ groupId, factKey, viewerSessionId } = {}) {
    const { group } = this.#actor(groupId, viewerSessionId);
    factKey = this.#normalizeKey(factKey);
    return this.#versions(group.id, factKey).sort((a, b) => a.version - b.version).map(copy);
  }

  listAuditEvents({ groupId, viewerSessionId } = {}) {
    const { group } = this.#actor(groupId, viewerSessionId);
    return this.#audit.filter(({ groupId: owner }) => owner === group.id).sort((a, b) => compareText(a.factKey, b.factKey) || a.version - b.version || compareText(a.timestamp, b.timestamp) || compareText(a.code, b.code) || compareText(a.factId, b.factId)).map(copy);
  }
}
