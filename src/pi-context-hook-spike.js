/**
 * Day 5: deliberately small, fail-closed context-hook harness.
 *
 * The harness only changes the copy of messages supplied to the `context`
 * hook.  It never uses before_agent_start's `message` result, and therefore
 * never persists the managed message in a Pi session.
 */

export const DAY5_SCHEMA_VERSION = 1;
export const MANAGED_CUSTOM_TYPE = "pi-more-context-relay/day5-managed-v1";
export const CHECK_STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", UNOBSERVED: "UNOBSERVED" });
export const DECISION = Object.freeze({
  GO_SDK: "GO_SDK",
  NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH: "NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH",
  INCONCLUSIVE_RERUN: "INCONCLUSIVE_RERUN",
});

export class Day5SpikeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "Day5SpikeError";
    this.code = code;
  }
}

function fail(code, message) { throw new Day5SpikeError(code, message); }
function nonEmpty(value, code, label) {
  if (typeof value !== "string" || value.trim() === "") fail(code, `${label} must be a non-empty string`);
  return value;
}
function finite(value, code, label, { integer = false, min = -Infinity } = {}) {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min) fail(code, `${label} is invalid`);
  return value;
}
function messagesArray(messages, code = "D5_MESSAGES_INVALID") {
  if (!Array.isArray(messages)) fail(code, "messages must be an array");
  return messages;
}
function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
function sameValue(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function safeDiagnosticText(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)\S+/gi, "$1<redacted>")
    .replace(/<relay-managed-context\b[^>]*>[\s\S]*?<\/relay-managed-context>/gi, "<relay-managed-context redacted>")
    .slice(0, 240);
}

export function createManagedMessage({ snapshotId, blockTag, managedText, timestamp }) {
  nonEmpty(snapshotId, "D5_SNAPSHOT_ID_INVALID", "snapshotId");
  nonEmpty(blockTag, "D5_BLOCK_TAG_INVALID", "blockTag");
  nonEmpty(managedText, "D5_MANAGED_TEXT_INVALID", "managedText");
  finite(timestamp, "D5_TIMESTAMP_INVALID", "timestamp", { min: 0 });
  return {
    role: "custom",
    customType: MANAGED_CUSTOM_TYPE,
    content: `<relay-managed-context snapshot-id="${snapshotId}" block-tag="${blockTag}">${managedText}</relay-managed-context>`,
    display: false,
    details: { schemaVersion: DAY5_SCHEMA_VERSION, snapshotId, blockTag },
    timestamp,
  };
}

export function isManagedMessage(message, { blockTag } = {}) {
  if (typeof blockTag !== "string" || blockTag === "") return false;
  return message?.role === "custom" &&
    message?.customType === MANAGED_CUSTOM_TYPE &&
    message?.details?.schemaVersion === DAY5_SCHEMA_VERSION &&
    message?.details?.blockTag === blockTag;
}

export function stripManagedMessages(messages, { blockTag } = {}) {
  messagesArray(messages);
  nonEmpty(blockTag, "D5_BLOCK_TAG_INVALID", "blockTag");
  return messages.filter((message) => !isManagedMessage(message, { blockTag }));
}

export function findManagedInsertionIndex(messages) {
  messagesArray(messages);
  let index = messages.findLastIndex((message) => message?.role === "user");
  return index < 0 ? 0 : index;
}

function toolCallBlocks(message) {
  return message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === "toolCall" && typeof part.id === "string")
    : [];
}

export function inspectToolClosure(messages) {
  messagesArray(messages);
  const calls = [];
  const results = [];
  for (const message of messages) {
    for (const block of toolCallBlocks(message)) calls.push(block.id);
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") results.push(message.toolCallId);
  }
  const callSet = new Set(calls);
  const resultSet = new Set(results);
  const danglingCallIds = [...new Set(calls.filter((id) => !resultSet.has(id)))];
  const orphanResultIds = [...new Set(results.filter((id) => !callSet.has(id)))];
  const latestToolResultId = results.length ? results[results.length - 1] : null;
  const latestToolResultPresent = latestToolResultId === null || resultSet.has(latestToolResultId);
  const matchingToolPairIds = [...new Set(calls.filter((id) => resultSet.has(id)))];
  return {
    callCount: calls.length,
    resultCount: results.length,
    danglingCallIds,
    orphanResultIds,
    latestToolResultId,
    latestToolResultPresent,
    matchingToolPairIds,
    closed: danglingCallIds.length === 0 && orphanResultIds.length === 0,
  };
}

export function estimateBudget({ messagesBefore, messagesAfter, contextWindow, reserveTokens, estimateMessageTokens, piContextUsage }) {
  messagesArray(messagesBefore, "D5_BUDGET_MESSAGES_BEFORE_INVALID");
  messagesArray(messagesAfter, "D5_BUDGET_MESSAGES_AFTER_INVALID");
  finite(contextWindow, "D5_CONTEXT_WINDOW_INVALID", "contextWindow", { integer: true, min: 1 });
  finite(reserveTokens, "D5_RESERVE_TOKENS_INVALID", "reserveTokens", { integer: true, min: 0 });
  if (typeof estimateMessageTokens !== "function") fail("D5_TOKEN_ESTIMATOR_INVALID", "estimateMessageTokens must be a function");
  const estimate = (message) => {
    const value = estimateMessageTokens(message);
    return finite(value, "D5_TOKEN_ESTIMATE_INVALID", "token estimate", { min: 0 });
  };
  const baseEstimatedTokens = messagesBefore.reduce((sum, message) => sum + estimate(message), 0);
  const finalEstimatedTokens = messagesAfter.reduce((sum, message) => sum + estimate(message), 0);
  const managedEstimatedTokens = Math.max(0, finalEstimatedTokens - baseEstimatedTokens);
  const inputThreshold = Math.max(0, contextWindow - reserveTokens);
  const usage = piContextUsage && typeof piContextUsage === "object" ? piContextUsage : {};
  const piLastReportedTokens = Number.isFinite(usage.tokens) ? usage.tokens : null;
  const piLastReportedPercent = Number.isFinite(usage.percent) ? usage.percent : null;
  return {
    method: "pi-estimateTokens-sum",
    baseEstimatedTokens,
    managedEstimatedTokens,
    finalEstimatedTokens,
    contextWindow,
    reserveTokens,
    inputThreshold,
    budgetGap: Math.max(0, finalEstimatedTokens - inputThreshold),
    piLastReportedTokens,
    piLastReportedPercent,
  };
}

export function rebuildManagedContext({ messages, snapshot, estimateMessageTokens, contextWindow, reserveTokens, piContextUsage }) {
  messagesArray(messages);
  if (!snapshot || typeof snapshot !== "object") fail("D5_SNAPSHOT_INVALID", "snapshot is required");
  nonEmpty(snapshot.snapshotId, "D5_SNAPSHOT_ID_INVALID", "snapshot.snapshotId");
  nonEmpty(snapshot.sessionId, "D5_SESSION_ID_INVALID", "snapshot.sessionId");
  nonEmpty(snapshot.blockTag, "D5_BLOCK_TAG_INVALID", "snapshot.blockTag");
  nonEmpty(snapshot.managedText, "D5_MANAGED_TEXT_INVALID", "snapshot.managedText");
  const original = messages.slice();
  const stripped = stripManagedMessages(original, { blockTag: snapshot.blockTag });
  const insertionIndex = findManagedInsertionIndex(stripped);
  const managed = createManagedMessage({
    snapshotId: snapshot.snapshotId,
    blockTag: snapshot.blockTag,
    managedText: snapshot.managedText,
    timestamp: snapshot.createdAt ?? Date.now(),
  });
  const output = [...stripped.slice(0, insertionIndex), managed, ...stripped.slice(insertionIndex)];
  const finalManagedCount = output.filter((message) => isManagedMessage(message, { blockTag: snapshot.blockTag })).length;
  const nonManagedOutput = output.filter((message) => !isManagedMessage(message, { blockTag: snapshot.blockTag }));
  const originalMessagesPreserved = nonManagedOutput.length === stripped.length && stripped.every((message, index) => sameValue(message, nonManagedOutput[index]));
  const toolClosure = inspectToolClosure(output);
  const budget = estimateBudget({ messagesBefore: stripped, messagesAfter: output, contextWindow, reserveTokens, estimateMessageTokens, piContextUsage });
  return {
    messages: output,
    diagnostic: {
      removedManagedCount: original.length - stripped.length,
      finalManagedCount,
      insertionIndex,
      originalMessagesPreserved,
      toolClosure,
      budget,
    },
  };
}

function sessionIdOf(ctx) {
  const id = ctx?.sessionManager?.getSessionId?.();
  return typeof id === "string" && id ? id : null;
}

function safeEvidence(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const key of [
    "runOrdinal", "removedManagedCount", "finalManagedCount", "insertionIndex",
    "originalMessagesPreserved", "toolClosureClosed", "latestToolResultId",
    "latestToolResultPresent", "matchingToolPairIds", "budgetMethod",
    "baseEstimatedTokens", "managedEstimatedTokens", "finalEstimatedTokens",
    "contextWindow", "reserveTokens", "inputThreshold", "budgetGap",
    "piLastReportedTokens", "piLastReportedPercent", "lastAssistantContextTokens", "contextCallCount",
    "providerAgentCallCount", "activeSnapshotCountBefore", "activeSnapshotCountAfter",
    "messageCount", "entryCount", "persistedManaged", "toolCallId", "toolName",
    "reason", "willRetry", "fromExtension", "isError", "tokensBefore", "tokensAfter",
    "turnIndex", "providerCallIndex", "providerPurpose", "providerMarkerCount",
    "legacyManagedCount", "fixedToolCallPresent", "fixedToolResultPresent", "aborted",
    "errorType", "errorSummary", "canaryScanPassed",
  ]) {
    const item = value[key];
    if (key === "errorSummary") {
      const sanitized = safeDiagnosticText(item);
      if (sanitized !== undefined) out[key] = sanitized;
    } else if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || (Array.isArray(item) && item.every((entry) => typeof entry === "string"))) out[key] = item;
  }
  return out;
}

export function createDay5HookHarness({ managedText, blockTag, scenario = "unknown", now = () => Date.now(), createId = () => `snap-${Date.now()}`, emit = () => {}, estimateMessageTokens = () => 1, reserveTokens = 0, sequenceStart = 0 }) {
  nonEmpty(managedText, "D5_MANAGED_TEXT_INVALID", "managedText");
  nonEmpty(blockTag, "D5_BLOCK_TAG_INVALID", "blockTag");
  if (typeof now !== "function" || typeof createId !== "function" || typeof emit !== "function") fail("D5_HARNESS_CALLBACK_INVALID", "now/createId/emit must be functions");
  finite(sequenceStart, "D5_SEQUENCE_START_INVALID", "sequenceStart", { integer: true, min: 0 });
  const active = new Map();
  const records = [];
  let sequence = sequenceStart;
  let runOrdinal = 0;
  let emitError = false;
  const push = ({ scenario = "unknown", stage, status = "INFO", code = "D5_EVENT", sessionId = null, snapshotId = null, contextCallIndex = null, evidence = {} }) => {
    const record = { schemaVersion: DAY5_SCHEMA_VERSION, sequence: ++sequence, scenario, stage, status, code, sessionId, snapshotId, contextCallIndex, evidence: safeEvidence(evidence) };
    records.push(record);
    try { emit(clone(record)); } catch (error) {
      emitError = true;
      records.push({ schemaVersion: DAY5_SCHEMA_VERSION, sequence: ++sequence, scenario, stage, status: CHECK_STATUS.FAIL, code: "D5_EMIT_ERROR", sessionId, snapshotId, contextCallIndex, evidence: safeEvidence({ errorType: error?.name ?? "Error" }) });
    }
    return record;
  };
  const getSnapshot = (ctx, event, stage) => {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) {
      push({ scenario: event?.scenario ?? "unknown", stage, status: CHECK_STATUS.FAIL, code: "D5_SESSION_ID_UNAVAILABLE" });
      return null;
    }
    return { sessionId, snapshot: active.get(sessionId) };
  };
  const scenarioOf = (event) => typeof event?.scenario === "string" ? event.scenario : scenario;
  const extension = { name: "Day5HookHarness", hidden: true, factory: (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      const scenario = scenarioOf(event);
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) { push({ scenario, stage: "BEFORE_AGENT_START", status: CHECK_STATUS.FAIL, code: "D5_SESSION_ID_UNAVAILABLE" }); return {}; }
      const old = active.get(sessionId);
      if (old && !old.settled) {
        push({ scenario, stage: "BEFORE_AGENT_START", status: CHECK_STATUS.FAIL, code: "STALE_SNAPSHOT_ACTIVE", sessionId, snapshotId: old.snapshotId });
        return {};
      }
      try {
        const snapshotId = createId({ sessionId, runOrdinal: runOrdinal + 1 });
        nonEmpty(snapshotId, "D5_SNAPSHOT_ID_INVALID", "createId result");
        if ([...active.values()].some((item) => item.snapshotId === snapshotId)) fail("D5_SNAPSHOT_NOT_UNIQUE", "createId returned a duplicate snapshot ID");
        const snapshot = { snapshotId, sessionId, blockTag, managedText, runOrdinal: ++runOrdinal, createdAt: now(), contextCallCount: 0, providerAgentCallCount: 0, settled: false };
        active.set(sessionId, snapshot);
        push({ scenario, stage: "BEFORE_AGENT_START", status: CHECK_STATUS.PASS, code: "SNAPSHOT_CREATED", sessionId, snapshotId, evidence: { runOrdinal: snapshot.runOrdinal } });
      } catch (error) {
        push({ scenario, stage: "BEFORE_AGENT_START", status: CHECK_STATUS.FAIL, code: error?.code ?? "D5_SNAPSHOT_CREATE_ERROR", sessionId, evidence: { errorType: error?.name ?? "Error", errorSummary: error?.message } });
      }
      return {};
    });
    pi.on("context", (event, ctx) => {
      const scenario = scenarioOf(event);
      const found = getSnapshot(ctx, event, "CONTEXT");
      const sessionId = found?.sessionId;
      const snapshot = found?.snapshot;
      if (!snapshot || snapshot.sessionId !== sessionId) {
        push({ scenario, stage: "CONTEXT", status: CHECK_STATUS.FAIL, code: snapshot ? "D5_SESSION_MISMATCH" : "D5_SNAPSHOT_MISSING", sessionId, snapshotId: snapshot?.snapshotId });
        return { messages: event.messages };
      }
      const contextCallIndex = ++snapshot.contextCallCount;
      try {
        const rebuilt = rebuildManagedContext({ messages: event.messages, snapshot, estimateMessageTokens, contextWindow: ctx.getContextUsage?.()?.contextWindow ?? ctx.model?.contextWindow ?? 100000, reserveTokens, piContextUsage: ctx.getContextUsage?.() });
        const d = rebuilt.diagnostic;
         push({ scenario, stage: "CONTEXT", status: d.finalManagedCount === 1 && d.originalMessagesPreserved && d.toolClosure.closed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, code: "CONTEXT_REBUILT", sessionId, snapshotId: snapshot.snapshotId, contextCallIndex, evidence: { removedManagedCount: d.removedManagedCount, finalManagedCount: d.finalManagedCount, insertionIndex: d.insertionIndex, originalMessagesPreserved: d.originalMessagesPreserved, toolClosureClosed: d.toolClosure.closed, latestToolResultId: d.toolClosure.latestToolResultId, latestToolResultPresent: d.toolClosure.latestToolResultPresent, matchingToolPairIds: d.toolClosure.matchingToolPairIds, budgetMethod: d.budget.method, baseEstimatedTokens: d.budget.baseEstimatedTokens, managedEstimatedTokens: d.budget.managedEstimatedTokens, finalEstimatedTokens: d.budget.finalEstimatedTokens, contextWindow: d.budget.contextWindow, reserveTokens: d.budget.reserveTokens, inputThreshold: d.budget.inputThreshold, budgetGap: d.budget.budgetGap, piLastReportedTokens: d.budget.piLastReportedTokens, piLastReportedPercent: d.budget.piLastReportedPercent } });
        return { messages: rebuilt.messages };
      } catch (error) {
        push({ scenario, stage: "CONTEXT", status: CHECK_STATUS.FAIL, code: error?.code ?? "D5_CONTEXT_REBUILD_ERROR", sessionId, snapshotId: snapshot.snapshotId, contextCallIndex, evidence: { errorType: error?.name ?? "Error", errorSummary: error?.message } });
        return { messages: event.messages };
      }
    });
    pi.on("before_provider_request", (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      const snapshot = sessionId ? active.get(sessionId) : undefined;
      if (!snapshot) {
        push({ scenario, stage: "PROVIDER_CALL", status: CHECK_STATUS.FAIL, code: "D5_PROVIDER_SNAPSHOT_MISSING", sessionId });
        return;
      }
      snapshot.providerAgentCallCount += 1;
      push({ scenario, stage: "PROVIDER_CALL", status: CHECK_STATUS.PASS, code: "PROVIDER_CALL_OBSERVED", sessionId, snapshotId: snapshot.snapshotId, contextCallIndex: snapshot.contextCallCount, evidence: { providerCallIndex: snapshot.providerAgentCallCount } });
    });
    pi.on("agent_settled", (event, ctx) => {
      const scenario = scenarioOf(event);
      const sessionId = sessionIdOf(ctx);
      const snapshot = sessionId ? active.get(sessionId) : undefined;
      if (!snapshot) { push({ scenario, stage: "AGENT_SETTLED", status: CHECK_STATUS.FAIL, code: "D5_SNAPSHOT_MISSING", sessionId }); return; }
       const activeSnapshotCountBefore = active.size;
       snapshot.settled = true;
       active.delete(sessionId);
       push({ scenario, stage: "AGENT_SETTLED", status: CHECK_STATUS.PASS, code: "SNAPSHOT_CLEANED", sessionId, snapshotId: snapshot.snapshotId, evidence: { contextCallCount: snapshot.contextCallCount, providerAgentCallCount: snapshot.providerAgentCallCount, activeSnapshotCountBefore, activeSnapshotCountAfter: active.size } });
    });
    pi.on("session_before_compact", (event, ctx) => push({ scenario: scenarioOf(event), stage: "COMPACTION", code: "COMPACTION_BEFORE", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { reason: event.reason, willRetry: event.willRetry, tokensBefore: event.preparation?.tokensBefore } }));
    pi.on("session_compact", (event, ctx) => push({ scenario: scenarioOf(event), stage: "COMPACTION", code: "COMPACTION_SUCCESS", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension } }));
    pi.on("session_compact_failed", (event, ctx) => push({ scenario: scenarioOf(event), stage: "COMPACTION", status: CHECK_STATUS.FAIL, code: "COMPACTION_FAILED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension, aborted: event.aborted, errorSummary: event.errorMessage } }));
    pi.on("agent_start", (event, ctx) => push({ scenario, stage: "AGENT_START", code: "AGENT_STARTED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null }));
    pi.on("agent_end", (event, ctx) => {
      const lastAssistant = Array.isArray(event.messages) ? event.messages.findLast((message) => message?.role === "assistant") : undefined;
      const usage = lastAssistant?.usage;
      const lastAssistantContextTokens = usage && typeof usage === "object"
        ? (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
          ? usage.totalTokens
          : [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0))
        : null;
      push({ scenario, stage: "AGENT_END", code: "AGENT_ENDED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { messageCount: event.messages?.length ?? 0, lastAssistantContextTokens } });
    });
    pi.on("turn_start", (event, ctx) => push({ scenario, stage: "TURN_START", code: "TURN_STARTED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { turnIndex: event.turnIndex } }));
    pi.on("turn_end", (event, ctx) => push({ scenario, stage: "TURN_END", code: "TURN_ENDED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { turnIndex: event.turnIndex } }));
    pi.on("tool_execution_start", (event, ctx) => push({ scenario, stage: "TOOL_START", code: "TOOL_STARTED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { toolCallId: event.toolCallId, toolName: event.toolName } }));
    pi.on("tool_execution_end", (event, ctx) => push({ scenario, stage: "TOOL_END", code: "TOOL_ENDED", sessionId: sessionIdOf(ctx), snapshotId: active.get(sessionIdOf(ctx))?.snapshotId ?? null, evidence: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError } }));
  }};
  const checks = () => {
    const result = [];
    const contexts = records.filter((r) => r.stage === "CONTEXT");
    result.push({ id: "D5-H06", status: contexts.length > 0 && contexts.every((r) => r.evidence.finalManagedCount === 1) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, evidenceSequences: contexts.map((r) => r.sequence) });
    result.push({ id: "D5-H12", status: contexts.length > 0 && contexts.every((r) => ["budgetGap", "managedEstimatedTokens", "budgetMethod"].every((k) => k in r.evidence)) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, evidenceSequences: contexts.map((r) => r.sequence) });
    return result;
  };
  return {
    extension,
    getActiveSnapshots: () => clone([...active.values()].map(({ managedText: _managedText, ...snapshot }) => snapshot)),
    getRecords: () => clone(records),
    getChecks: () => clone(checks()),
    noteProviderCall: (record = {}) => {
      const sessionId = record.sessionId;
      const snapshot = sessionId ? active.get(sessionId) : undefined;
      if (snapshot) snapshot.providerAgentCallCount += 1;
      return push({ ...record, stage: "PROVIDER_CALL", code: record.code ?? "PROVIDER_CALL_OBSERVED", sessionId, snapshotId: snapshot?.snapshotId ?? null, contextCallIndex: record.contextCallIndex ?? snapshot?.contextCallCount ?? null, evidence: { providerCallIndex: snapshot?.providerAgentCallCount ?? null, ...safeEvidence(record) } });
    },
    finalize: () => ({ activeSnapshotCount: active.size, recordCount: records.length, emitError, checks: checks() }),
  };
}

export function evaluateDay5Decision({ checks }) {
  if (!checks || typeof checks !== "object") fail("D5_CHECKS_INVALID", "checks must be an array or object");
  const values = Array.isArray(checks) ? checks : Object.entries(checks).map(([id, value]) => ({ id, status: value?.status ?? value }));
  if (values.length !== 16) fail("D5_CHECK_COUNT_INVALID", "exactly 16 checks are required");
  if (values.some((check) => !Object.values(CHECK_STATUS).includes(check.status))) fail("D5_CHECK_STATUS_INVALID", "check has an invalid status");
  if (values.some((check) => check.status === CHECK_STATUS.FAIL)) return DECISION.NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH;
  if (values.some((check) => check.status === CHECK_STATUS.UNOBSERVED)) return DECISION.INCONCLUSIVE_RERUN;
  return DECISION.GO_SDK;
}
