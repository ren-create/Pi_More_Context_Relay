import { createHash } from "node:crypto";
import { canonicalizeFactValue } from "./group-fact-store.js";

export const FACT_TOKEN_ESTIMATOR_VERSION = "json-char-ceil-div-4-v1";
const copy = (value) => structuredClone(value);
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class FactSnapshotError extends Error {
  constructor(code, message = "Fact snapshot operation failed", safeDetails = {}) {
    super(message);
    this.name = "FactSnapshotError";
    this.code = code;
    for (const [key, value] of Object.entries(safeDetails)) if (["factCount", "estimatedTokens", "factTokenBudget", "budgetGap"].includes(key) && Number.isSafeInteger(value)) this[key] = value;
  }
}

function fail(code, message = "Fact snapshot operation failed", details) { throw new FactSnapshotError(code, message, details); }
function exactString(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) fail("SNAPSHOT_ARGUMENT_INVALID", `${field} must be a non-empty string without surrounding whitespace`);
  return value;
}
function timestamp(now) {
  let result;
  try { result = now(); } catch { fail("SNAPSHOT_CLOCK_INVALID", "snapshot clock callback failed"); }
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) fail("SNAPSHOT_CLOCK_INVALID", "snapshot clock value is invalid");
  return result.toISOString();
}

export function estimateFactTokens(fact) {
  if (!fact || typeof fact !== "object" || typeof fact.factKey !== "string" || !Number.isSafeInteger(fact.version) || fact.version < 1) fail("FACT_ESTIMATE_INVALID", "fact estimate input is invalid");
  let canonical;
  try { canonical = canonicalizeFactValue({ factKey: fact.factKey, version: fact.version, value: fact.value }); }
  catch { fail("FACT_ESTIMATE_INVALID", "fact estimate input is not canonical JSON"); }
  return Math.ceil(canonical.length / 4);
}

export class FactSnapshotManager {
  #factStore;
  #now;
  #createId;
  #estimateTokens;
  #snapshots = new Map();
  #released = new Set();

  constructor({ factStore, now = () => new Date(), createId = () => `fact-snapshot-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 20)}`, estimateTokens = estimateFactTokens } = {}) {
    if (!factStore || typeof factStore.listActiveFacts !== "function" || typeof now !== "function" || typeof createId !== "function" || typeof estimateTokens !== "function") fail("SNAPSHOT_CONFIG_INVALID", "snapshot dependencies are invalid");
    this.#factStore = factStore;
    this.#now = now;
    this.#createId = createId;
    this.#estimateTokens = estimateTokens;
  }

  createSnapshot({ groupId, targetSessionId, factTokenBudget } = {}) {
    exactString(groupId, "groupId");
    exactString(targetSessionId, "targetSessionId");
    if (!Number.isSafeInteger(factTokenBudget) || factTokenBudget < 0) fail("FACT_BUDGET_INVALID", "factTokenBudget must be a non-negative safe integer");
    let facts;
    try { facts = this.#factStore.listActiveFacts({ groupId, viewerSessionId: targetSessionId }); }
    catch { fail("SNAPSHOT_TARGET_INVALID", "target session is unavailable or outside the group"); }
    if (!Array.isArray(facts)) fail("FACT_READ_FAILED", "active facts response is invalid");
    facts = facts.map((fact) => {
      if (!fact || fact.groupId !== groupId || fact.status !== "ACTIVE" || typeof fact.factKey !== "string" || !Number.isSafeInteger(fact.version)) fail("FACT_READ_FAILED", "active fact descriptor is invalid");
      return copy(fact);
    }).sort((a, b) => compareText(a.factKey, b.factKey) || a.version - b.version || compareText(a.id, b.id));

    let estimatedTokens = 0;
    for (const fact of facts) {
      let estimate;
      try { estimate = this.#estimateTokens({ factKey: fact.factKey, version: fact.version, value: copy(fact.value) }); }
      catch { fail("FACT_ESTIMATOR_FAILED", "fact token estimator failed"); }
      if (!Number.isSafeInteger(estimate) || estimate < 0) fail("FACT_ESTIMATOR_INVALID", "fact token estimator must return a non-negative safe integer");
      estimatedTokens += estimate;
      if (!Number.isSafeInteger(estimatedTokens)) fail("FACT_ESTIMATOR_INVALID", "estimated token total exceeds safe integer range");
    }
    const factCount = facts.length;
    const budgetGap = Math.max(0, estimatedTokens - factTokenBudget);
    if (estimatedTokens > factTokenBudget) fail("FACT_BUDGET_EXCEEDED", "active facts exceed the configured token budget", { factCount, estimatedTokens, factTokenBudget, budgetGap });

    let id;
    try { id = this.#createId(); } catch { fail("SNAPSHOT_ID_INVALID", "snapshot ID callback failed"); }
    exactString(id, "snapshotId");
    if (this.#snapshots.has(id) || this.#released.has(id)) fail("SNAPSHOT_ID_EXISTS", "snapshot ID already exists");
    const createdAt = timestamp(this.#now);
    const snapshot = {
      id,
      groupId,
      targetSessionId,
      facts: copy(facts),
      factRefs: facts.map(({ id: factId, factKey, version, contentHash }) => ({ id: factId, factKey, version, contentHash })),
      budget: { method: this.#estimateTokens === estimateFactTokens ? FACT_TOKEN_ESTIMATOR_VERSION : "custom-estimator", factCount, estimatedTokens, factTokenBudget, budgetGap },
      createdAt,
    };
    this.#snapshots.set(id, snapshot);
    return copy(snapshot);
  }

  getSnapshot(snapshotId) {
    exactString(snapshotId, "snapshotId");
    const snapshot = this.#snapshots.get(snapshotId);
    if (!snapshot) fail(this.#released.has(snapshotId) ? "SNAPSHOT_RELEASED" : "SNAPSHOT_NOT_FOUND", "snapshot is unavailable");
    return copy(snapshot);
  }

  releaseSnapshot(snapshotId) {
    exactString(snapshotId, "snapshotId");
    const snapshot = this.#snapshots.get(snapshotId);
    if (!snapshot) fail(this.#released.has(snapshotId) ? "SNAPSHOT_RELEASED" : "SNAPSHOT_NOT_FOUND", "snapshot is unavailable");
    this.#snapshots.delete(snapshotId);
    this.#released.add(snapshotId);
    return copy({ id: snapshot.id, groupId: snapshot.groupId, targetSessionId: snapshot.targetSessionId, released: true });
  }

  listActiveSnapshots() {
    return [...this.#snapshots.values()].sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id)).map(copy);
  }
}
