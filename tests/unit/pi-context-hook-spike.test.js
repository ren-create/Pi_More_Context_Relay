import { describe, expect, it } from "vitest";
import {
  aggregateScenarioChecks,
  countProviderManagedMarkers,
  failuresAreDiagnosable,
  providerCallsFollowContext,
} from "../../scripts/pi-context-hook-spike.mjs";

import {
  CHECK_STATUS,
  DECISION,
  DAY5_SCHEMA_VERSION,
  MANAGED_CUSTOM_TYPE,
  createDay5HookHarness,
  createManagedMessage,
  evaluateDay5Decision,
  findManagedInsertionIndex,
  inspectToolClosure,
  rebuildManagedContext,
  stripManagedMessages,
} from "../../src/pi-context-hook-spike.js";

const snapshot = { snapshotId: "snap-1", sessionId: "session-1", blockTag: "[RELAY:day5]", managedText: "SYNTHETIC_MANAGED_CANARY", createdAt: 10 };
const usage = { tokens: 12, percent: 3, contextWindow: 100 };
const estimate = (message) => typeof message?.content === "string" ? Math.ceil(message.content.length / 4) : 2;

function baseMessages() {
  return [
    { role: "user", content: "prompt", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "day5_probe_tool", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolCallId: "tool-1", toolName: "day5_probe_tool", content: [{ type: "text", text: "SYNTHETIC_TOOL_RESULT_CANARY" }], isError: false, timestamp: 3 },
  ];
}

describe("Day 5 context hook pure contract", () => {
  it("aggregates only the scenario that owns H08-H11", () => {
    const result = (scenario, status) => ({ scenario, checks: { H08: { status }, H09: { status }, H10: { status }, H11: { status } } });
    const checks = aggregateScenarioChecks([
      result("normal", CHECK_STATUS.UNOBSERVED),
      result("tool-loop", CHECK_STATUS.PASS),
      result("auto-retry", CHECK_STATUS.PASS),
      result("auto-compaction", CHECK_STATUS.PASS),
    ]);
    expect(checks.find((check) => check.id === "D5-H08").status).toBe(CHECK_STATUS.PASS);
    expect(checks.find((check) => check.id === "D5-H09").status).toBe(CHECK_STATUS.PASS);
    expect(checks.find((check) => check.id === "D5-H10").status).toBe(CHECK_STATUS.PASS);
    expect(checks.find((check) => check.id === "D5-H11").status).toBe(CHECK_STATUS.PASS);
  });

  it("detects managed markers after Pi converts custom messages to provider user messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: '<relay-managed-context snapshot-id="snap-1" block-tag="[RELAY:normal]">PRIVATE</relay-managed-context>' }] },
      { role: "user", content: [{ type: "text", text: "ordinary prompt" }] },
    ];
    expect(countProviderManagedMarkers(messages, "[RELAY:normal]")).toBe(1);
    expect(countProviderManagedMarkers(messages, "[RELAY:other]")).toBe(0);
  });

  it("requires a real sequenced provider observation after each matching context", () => {
    const records = [
      { stage: "CONTEXT", sequence: 4, contextCallIndex: 1, snapshotId: "snap-1" },
      { stage: "PROVIDER_CALL", sequence: 5, contextCallIndex: 1, snapshotId: "snap-1" },
    ];
    const observations = [{ providerPurpose: "agent-1", providerSequence: 5, contextCallIndex: 1 }];
    expect(providerCallsFollowContext(records, observations)).toBe(true);
    expect(providerCallsFollowContext(records.filter((record) => record.stage !== "PROVIDER_CALL"), observations)).toBe(false);
  });

  it("treats a fully located internal failure as H16 evidence", () => {
    const located = [{ sequence: 9, stage: "COMPACTION", code: "COMPACTION_FAILED", status: CHECK_STATUS.FAIL, evidence: { aborted: false, errorSummary: "Auto-compaction failed" } }];
    const incomplete = [{ ...located[0], evidence: { aborted: false } }];
    expect(failuresAreDiagnosable(located, null)).toBe(true);
    expect(failuresAreDiagnosable(incomplete, null)).toBe(false);
  });
  it("creates and identifies only fully-qualified managed custom messages", () => {
    const managed = createManagedMessage({ ...snapshot, timestamp: 11 });
    expect(managed).toMatchObject({ role: "custom", customType: MANAGED_CUSTOM_TYPE, display: false, details: { schemaVersion: DAY5_SCHEMA_VERSION, blockTag: snapshot.blockTag } });
    const messages = [{ role: "user", content: "a [RELAY:day5] marker" }, managed, { role: "custom", customType: MANAGED_CUSTOM_TYPE, details: { schemaVersion: DAY5_SCHEMA_VERSION, blockTag: "other" }, content: "do not remove" }];
    expect(stripManagedMessages(messages, { blockTag: snapshot.blockTag })).toHaveLength(2);
  });

  it("inserts before the last user and is idempotent while closing tools", () => {
    const first = rebuildManagedContext({ messages: baseMessages(), snapshot, estimateMessageTokens: estimate, contextWindow: 100, reserveTokens: 10, piContextUsage: usage });
    const second = rebuildManagedContext({ messages: first.messages, snapshot, estimateMessageTokens: estimate, contextWindow: 100, reserveTokens: 10, piContextUsage: usage });
    expect(findManagedInsertionIndex(first.messages)).toBe(1);
    expect(first.diagnostic.removedManagedCount).toBe(0);
    expect(second.diagnostic.removedManagedCount).toBe(1);
    expect(second.diagnostic.finalManagedCount).toBe(1);
    expect(second.diagnostic.originalMessagesPreserved).toBe(true);
    expect(second.diagnostic.toolClosure).toMatchObject({ closed: true, latestToolResultId: "tool-1", latestToolResultPresent: true });
    expect(second.diagnostic.budget.method).toBe("pi-estimateTokens-sum");
  });

  it("reports dangling and orphan tool relationships without copying result text", () => {
    const closure = inspectToolClosure([{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "x", arguments: {} }] }, { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "SYNTHETIC_TOOL_RESULT_CANARY" }] }]);
    expect(closure).toMatchObject({ closed: false, danglingCallIds: ["call-a"], orphanResultIds: ["orphan"] });
    expect(JSON.stringify(closure)).not.toContain("SYNTHETIC_TOOL_RESULT_CANARY");
  });

  it("reports fixed tool-call/result pairs by ID", () => {
    const closure = inspectToolClosure([
      { role: "assistant", content: [{ type: "toolCall", id: "fixed-001", name: "x", arguments: {} }] },
      { role: "toolResult", toolCallId: "fixed-001", content: [{ type: "text", text: "result" }] },
    ]);
    expect(closure).toMatchObject({ closed: true, matchingToolPairIds: ["fixed-001"], latestToolResultId: "fixed-001", latestToolResultPresent: true });
  });

  it("emits a safe lifecycle record and cleans one session snapshot", async () => {
    const handlers = new Map();
    const records = [];
    const harness = createDay5HookHarness({ scenario: "unit", managedText: snapshot.managedText, blockTag: snapshot.blockTag, now: () => 10, createId: () => snapshot.snapshotId, estimateMessageTokens: estimate, emit: (record) => records.push(record) });
    harness.extension.factory({ on(name, handler) { handlers.set(name, handler); } });
    const ctx = { sessionManager: { getSessionId: () => snapshot.sessionId }, getContextUsage: () => usage, model: { contextWindow: 100 } };
    expect(handlers.get("before_agent_start")({ type: "before_agent_start" }, ctx)).toEqual({});
    const transformed = handlers.get("context")({ type: "context", messages: baseMessages() }, ctx);
    expect(transformed.messages.filter((m) => m.customType === MANAGED_CUSTOM_TYPE)).toHaveLength(1);
    expect(harness.getActiveSnapshots()).toHaveLength(1);
    handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    expect(harness.getActiveSnapshots()).toHaveLength(0);
    expect(records.find((record) => record.stage === "AGENT_SETTLED").evidence).toMatchObject({ activeSnapshotCountBefore: 1, activeSnapshotCountAfter: 0 });
    expect(records.find((record) => record.stage === "CONTEXT").evidence).toMatchObject({
      budgetMethod: "pi-estimateTokens-sum",
      baseEstimatedTokens: expect.any(Number),
      managedEstimatedTokens: expect.any(Number),
      finalEstimatedTokens: expect.any(Number),
      contextWindow: 100,
      reserveTokens: 0,
      inputThreshold: 100,
      budgetGap: expect.any(Number),
      piLastReportedTokens: 12,
      piLastReportedPercent: 3,
    });
    expect(records.every((record) => !JSON.stringify(record).includes("SYNTHETIC_TOOL_RESULT_CANARY"))).toBe(true);
  });

  it("records stale snapshots and missing-session failures", () => {
    const handlers = new Map();
    const records = [];
    const harness = createDay5HookHarness({ scenario: "state", managedText: snapshot.managedText, blockTag: snapshot.blockTag, createId: ({ runOrdinal }) => `snap-${runOrdinal}`, emit: (record) => records.push(record) });
    harness.extension.factory({ on(name, handler) { handlers.set(name, handler); } });
    const ctx = { sessionManager: { getSessionId: () => "session-state" } };
    handlers.get("before_agent_start")({ scenario: "state" }, ctx);
    handlers.get("before_agent_start")({ scenario: "state" }, ctx);
    expect(records.some((record) => record.code === "STALE_SNAPSHOT_ACTIVE" && record.status === CHECK_STATUS.FAIL)).toBe(true);
    expect(harness.getActiveSnapshots()).toHaveLength(1);
    const missing = { sessionManager: { getSessionId: () => "" } };
    handlers.get("context")({ scenario: "state", messages: [] }, missing);
    expect(records.some((record) => record.code === "D5_SESSION_ID_UNAVAILABLE" && record.status === CHECK_STATUS.FAIL)).toBe(true);
  });

  it("records snapshot factory failures instead of throwing from before_agent_start", () => {
    const handlers = new Map();
    const harness = createDay5HookHarness({ scenario: "snapshot-error", managedText: "PUBLIC_MANAGED", blockTag: "[snapshot-error]", createId: () => { throw new Error("synthetic id failure"); } });
    harness.extension.factory({ on(name, handler) { handlers.set(name, handler); } });
    expect(() => handlers.get("before_agent_start")({}, { sessionManager: { getSessionId: () => "session-error" } })).not.toThrow();
    expect(harness.getRecords()).toContainEqual(expect.objectContaining({ stage: "BEFORE_AGENT_START", status: CHECK_STATUS.FAIL, code: "D5_SNAPSHOT_CREATE_ERROR" }));
  });

  it("retains sanitized compaction failure location fields", () => {
    const handlers = new Map();
    const harness = createDay5HookHarness({ scenario: "compaction-error", managedText: "PUBLIC_MANAGED", blockTag: "[compaction-error]", createId: () => "snap-compaction-error" });
    harness.extension.factory({ on(name, handler) { handlers.set(name, handler); } });
    const ctx = { sessionManager: { getSessionId: () => "session-compaction-error" } };
    handlers.get("before_agent_start")({}, ctx);
    handlers.get("session_compact_failed")({ reason: "overflow", willRetry: false, fromExtension: false, aborted: false, errorMessage: "Auto-compaction failed: api_key=synthetic-secret" }, ctx);
    const failure = harness.getRecords().find((record) => record.code === "COMPACTION_FAILED");
    expect(failure.evidence).toMatchObject({ reason: "overflow", aborted: false, errorSummary: "Auto-compaction failed: api_key=<redacted>" });
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  });

  it("records estimator and emitter exceptions as safe failures", () => {
    const estimatorHandlers = new Map();
    const estimatorRecords = [];
    const estimatorHarness = createDay5HookHarness({ scenario: "estimator", managedText: "PUBLIC_MANAGED", blockTag: "[estimator]", estimateMessageTokens: () => { throw new Error("SYNTHETIC_ESTIMATOR_FAILURE"); }, emit: (record) => estimatorRecords.push(record) });
    estimatorHarness.extension.factory({ on(name, handler) { estimatorHandlers.set(name, handler); } });
    const ctx = { sessionManager: { getSessionId: () => "session-estimator" }, getContextUsage: () => ({ contextWindow: 100 }) };
    estimatorHandlers.get("before_agent_start")({}, ctx);
    estimatorHandlers.get("context")({ messages: [{ role: "user", content: "x" }] }, ctx);
    expect(estimatorRecords.some((record) => record.status === CHECK_STATUS.FAIL && record.code === "D5_CONTEXT_REBUILD_ERROR")).toBe(true);

    const emitterHarness = createDay5HookHarness({ scenario: "emitter", managedText: "PUBLIC_MANAGED", blockTag: "[emitter]", emit: () => { throw new Error("SYNTHETIC_EMITTER_FAILURE"); } });
    const emitterHandlers = new Map();
    emitterHarness.extension.factory({ on(name, handler) { emitterHandlers.set(name, handler); } });
    emitterHandlers.get("before_agent_start")({}, { sessionManager: { getSessionId: () => "session-emitter" } });
    expect(emitterHarness.getRecords().some((record) => record.status === CHECK_STATUS.FAIL && record.code === "D5_EMIT_ERROR")).toBe(true);
  });

  it("preserves the evidence whitelist and starts sequences at the requested offset", () => {
    const records = [];
    const harness = createDay5HookHarness({ scenario: "evidence", managedText: "PUBLIC_MANAGED", blockTag: "[evidence]", sequenceStart: 40, emit: (record) => records.push(record) });
    const handlers = new Map();
    harness.extension.factory({ on(name, handler) { handlers.set(name, handler); } });
    const ctx = { sessionManager: { getSessionId: () => "session-evidence" }, getContextUsage: () => ({ contextWindow: 100, tokens: 7, percent: 2 }) };
    handlers.get("before_agent_start")({}, ctx);
    handlers.get("context")({ messages: baseMessages() }, ctx);
    const contextRecord = records.find((record) => record.stage === "CONTEXT");
    expect(contextRecord.sequence).toBeGreaterThan(40);
    expect(contextRecord.evidence).toMatchObject({
      removedManagedCount: 0,
      finalManagedCount: 1,
      insertionIndex: expect.any(Number),
      originalMessagesPreserved: true,
      toolClosureClosed: true,
      latestToolResultId: "tool-1",
      matchingToolPairIds: ["tool-1"],
      budgetMethod: "pi-estimateTokens-sum",
      piLastReportedTokens: 7,
      piLastReportedPercent: 2,
    });
    expect(JSON.stringify(contextRecord)).not.toContain("SYNTHETIC_TOOL_RESULT_CANARY");
  });

  it("uses the frozen decision ordering", () => {
    const checks = Array.from({ length: 16 }, (_, index) => ({ id: `D5-H${String(index + 1).padStart(2, "0")}`, status: CHECK_STATUS.PASS }));
    expect(evaluateDay5Decision({ checks })).toBe(DECISION.GO_SDK);
    checks[3].status = CHECK_STATUS.UNOBSERVED;
    expect(evaluateDay5Decision({ checks })).toBe(DECISION.INCONCLUSIVE_RERUN);
    checks[4].status = CHECK_STATUS.FAIL;
    expect(evaluateDay5Decision({ checks })).toBe(DECISION.NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH);
  });
});
