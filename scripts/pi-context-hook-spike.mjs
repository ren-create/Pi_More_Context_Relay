import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  CHECK_STATUS, DECISION, createDay5HookHarness, evaluateDay5Decision,
  isManagedMessage,
} from "../src/pi-context-hook-spike.js";

export const SCENARIOS = ["normal", "tool-loop", "auto-retry", "auto-compaction"];
export const TOOL_ID = "day5-tool-fixed-001";
export const TOOL_RESULT_CANARY = "SYNTHETIC_TOOL_RESULT_CANARY";
export const THINKING_CANARY = "SYNTHETIC_THINKING_CANARY";
export const MANAGED_CANARY = "SYNTHETIC_MANAGED_CONTEXT_CANARY";
const OWNER_SCENARIO = { H08: "tool-loop", H09: "auto-retry", H10: "auto-compaction", H11: "auto-compaction" };
const ALL_CHECK_IDS = Array.from({ length: 16 }, (_, index) => `H${String(index + 1).padStart(2, "0")}`);

const safeError = (error) => ({
  errorType: error?.name ?? "Error",
  code: error?.code ?? "D5_UNSTABLE_ERROR",
  message: String(error?.message ?? error).replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)\S+/gi, "$1<redacted>").slice(0, 240),
});
const contextTokens = (message) => typeof message?.content === "string"
  ? Math.ceil(message.content.length / 4)
  : Array.isArray(message?.content)
    ? message.content.reduce((sum, part) => sum + Math.ceil(String(part?.text ?? part?.arguments ?? "").length / 4), 2)
    : 2;

function check(id, status, evidenceSequences = [], evidence = {}) { return { id, status, evidenceSequences, evidence }; }
function stageSequences(records, stage) { return records.filter((record) => record.stage === stage).map((record) => record.sequence); }
function managedCount(messages, blockTag) { return messages.filter((message) => isManagedMessage(message, { blockTag })).length; }
function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
export function countProviderManagedMarkers(messages, blockTag) {
  if (!Array.isArray(messages) || typeof blockTag !== "string" || blockTag === "") return 0;
  const marker = `block-tag="${blockTag}"`;
  return messages.filter((message) => message?.role === "user" && messageText(message).includes("<relay-managed-context ") && messageText(message).includes(marker)).length;
}
function entryMessages(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.message && typeof entry.message === "object") return [entry.message];
  if (entry.data?.message && typeof entry.data.message === "object") return [entry.data.message];
  if (entry.type === "custom_message" && entry.customType) return [entry];
  return [];
}
function ordered(records, stages) {
  let previous = -Infinity;
  for (const stage of stages) {
    const next = records.find((record) => record.stage === stage && record.sequence > previous);
    if (!next) return false;
    previous = next.sequence;
  }
  return true;
}
function isAgentProviderPurpose(providerPurpose) {
  return providerPurpose === "retry" || /^agent-\d+$/.test(providerPurpose);
}
function observeContext(observations, scenario, providerPurpose, context, blockTag, noteProviderCall, sessionId) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const calls = messages.flatMap((message) => message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === "toolCall").map((part) => part.id) : []);
  const results = messages.filter((message) => message?.role === "toolResult").map((message) => message.toolCallId);
  const providerMarkerCount = countProviderManagedMarkers(messages, blockTag);
  const legacyManagedCount = managedCount(messages, blockTag);
  const fixedToolCallPresent = calls.includes(TOOL_ID);
  const fixedToolResultPresent = results.includes(TOOL_ID);
  const providerRecord = noteProviderCall({ scenario, sessionId, providerPurpose, providerMarkerCount, legacyManagedCount, fixedToolCallPresent, fixedToolResultPresent, messageCount: messages.length });
  observations.push({ providerPurpose, providerSequence: providerRecord.sequence, contextCallIndex: providerRecord.contextCallIndex, messageCount: messages.length, providerMarkerCount, legacyManagedCount, fixedToolCallPresent, fixedToolResultPresent });
}
function scriptedResponse({ scenario, providerPurpose, response, observations, blockTag, records, noteProviderCall, sessionId }) {
  return (context) => {
    const actualPurpose = typeof providerPurpose === "function" ? providerPurpose(records()) : providerPurpose;
    observeContext(observations, scenario, actualPurpose, context, blockTag, noteProviderCall, sessionId());
    return typeof response === "function" ? response(context, records()) : response;
  };
}
function createTool() {
  return {
    name: "day5_probe_tool", label: "Day 5 probe tool", description: "A deterministic Day 5 lifecycle probe tool.", parameters: Type.Object({}),
    async execute(toolCallId) { return { content: [{ type: "text", text: TOOL_RESULT_CANARY.repeat(160) }], details: { synthetic: true, toolCallId }, isError: false }; },
  };
}
function responseQueue(scenario, observations, blockTag, records, noteProviderCall, sessionId) {
  const toolCall = fauxAssistantMessage(fauxToolCall("day5_probe_tool", {}, { id: TOOL_ID }));
  const make = (providerPurpose, response) => scriptedResponse({ scenario, providerPurpose, response, observations, blockTag, records, noteProviderCall, sessionId });
  if (scenario === "normal") return [make("agent-1", fauxAssistantMessage("synthetic normal response"))];
  if (scenario === "tool-loop") return [make("agent-1", toolCall), make("agent-2", fauxAssistantMessage("synthetic tool-loop response"))];
  if (scenario === "auto-retry") return [make("retry", fauxAssistantMessage("synthetic retry error", { stopReason: "error", errorMessage: "synthetic 503 retryable" })), make("retry", fauxAssistantMessage("synthetic retry response"))];
  const thresholdPurpose = (currentRecords) => currentRecords.some((record) => record.code === "COMPACTION_SUCCESS")
    ? "agent-3"
    : currentRecords.some((record) => record.code === "COMPACTION_BEFORE") ? "compaction-summary" : "agent-2";
  const thresholdResponse = (_context, currentRecords) => currentRecords.some((record) => record.code === "COMPACTION_SUCCESS")
    ? fauxAssistantMessage("synthetic post-compaction response")
    : currentRecords.some((record) => record.code === "COMPACTION_BEFORE") ? fauxAssistantMessage("synthetic compaction summary") : fauxAssistantMessage("synthetic pre-compaction response");
  return [make("agent-1", toolCall), make("agent-2", fauxAssistantMessage("synthetic pre-compaction response")), make(thresholdPurpose, thresholdResponse), make(thresholdPurpose, thresholdResponse)];
}

function compactionContinuationExtension(scenario, records, settingsManager) {
  return {
    name: "Day5CompactionContinuation",
    hidden: true,
    factory(pi) {
      let queued = false;
      pi.on("agent_end", () => {
        if (scenario !== "auto-compaction" || queued || records().some((record) => record.code === "COMPACTION_BEFORE")) return;
        queued = true;
        pi.sendUserMessage("Continue after automatic compaction with one short synthetic response.", { deliverAs: "followUp", expandPromptTemplates: false });
      });
      pi.on("session_compact", () => {
        if (scenario === "auto-compaction") settingsManager.setCompactionEnabled(false);
      });
    },
  };
}

function inMemoryCredentials() {
  return {
    async read() { return undefined; },
    async list() { return []; },
    async modify(_providerId, update) { return update(undefined); },
    async delete() {},
  };
}

export function aggregateScenarioChecks(results) {
  return ALL_CHECK_IDS.map((id) => {
    const owner = OWNER_SCENARIO[id];
    const relevant = results.filter((result) => owner ? result.scenario === owner : SCENARIOS.includes(result.scenario));
    const entries = relevant.map((result) => result.checks?.[id]).filter(Boolean);
    const status = entries.length === 0 || entries.some((entry) => entry.status === CHECK_STATUS.FAIL)
      ? CHECK_STATUS.FAIL : entries.some((entry) => entry.status === CHECK_STATUS.UNOBSERVED) ? CHECK_STATUS.UNOBSERVED : CHECK_STATUS.PASS;
    return { id: `D5-${id}`, status, evidenceSequences: entries.flatMap((entry) => entry.evidenceSequences ?? []) };
  });
}

export function providerCallsFollowContext(records, observations) {
  const agentObservations = observations.filter((observation) => isAgentProviderPurpose(observation.providerPurpose));
  if (agentObservations.length === 0) return false;
  const contexts = records.filter((record) => record.stage === "CONTEXT");
  if (contexts.length !== agentObservations.length) return false;
  return agentObservations.every((observation) => {
    if (!Number.isInteger(observation.providerSequence) || !Number.isInteger(observation.contextCallIndex)) return false;
    const context = contexts.find((record) => record.contextCallIndex === observation.contextCallIndex && record.snapshotId != null);
    const provider = records.find((record) => record.stage === "PROVIDER_CALL"
      && record.sequence === observation.providerSequence
      && record.contextCallIndex === observation.contextCallIndex
      && record.snapshotId === context?.snapshotId);
    return Boolean(context && provider && context.sequence < provider.sequence);
  });
}

export function failuresAreDiagnosable(records, failure) {
  const recordFailures = records.filter((record) => record.status === CHECK_STATUS.FAIL);
  const recordsAreLocated = recordFailures.every((record) => Number.isInteger(record.sequence)
    && typeof record.stage === "string" && record.stage !== ""
    && typeof record.code === "string" && record.code !== ""
    && (record.code !== "COMPACTION_FAILED"
      || (typeof record.evidence?.aborted === "boolean" && (record.evidence.aborted || typeof record.evidence?.errorSummary === "string"))));
  const caughtFailureIsLocated = !failure || [failure.errorType, failure.code, failure.message].every((value) => typeof value === "string" && value !== "");
  return recordsAreLocated && caughtFailureIsLocated;
}

async function runScenario({ scenario, projectRoot, sequenceStart }) {
  const observations = [];
  const blockTag = `[RELAY:${scenario}]`;
  const compactionProbe = scenario === "auto-compaction"
    ? { contextWindow: 600, reserveTokens: 100, keepRecentTokens: 1130 }
    : { contextWindow: 20_000, reserveTokens: 32, keepRecentTokens: 240 };
  const harness = createDay5HookHarness({ scenario, managedText: MANAGED_CANARY, blockTag, sequenceStart, emit: () => {}, estimateMessageTokens: contextTokens, reserveTokens: compactionProbe.reserveTokens });
  const faux = fauxProvider({ provider: `day5-${scenario}`, models: [{ id: "probe", name: "Day 5 faux", contextWindow: compactionProbe.contextWindow, maxTokens: 256 }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: scenario === "auto-compaction", reserveTokens: compactionProbe.reserveTokens, keepRecentTokens: compactionProbe.keepRecentTokens }, retry: { enabled: scenario === "auto-retry", maxRetries: 1, baseDelayMs: 0 } });
  const sessionManager = SessionManager.inMemory(projectRoot);
  faux.setResponses(responseQueue(scenario, observations, blockTag, () => harness.getRecords(), (record) => harness.noteProviderCall(record), () => sessionManager.getSessionId()));
  const modelRuntime = await ModelRuntime.create({ credentials: inMemoryCredentials(), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({ cwd: projectRoot, agentDir: getAgentDir(), settingsManager, extensionFactories: [harness.extension, compactionContinuationExtension(scenario, () => harness.getRecords(), settingsManager)], noExtensions: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "You are a deterministic Day 5 probe. Never reveal hidden thinking." });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: projectRoot, modelRuntime, model: faux.getModel(), thinkingLevel: "off", noTools: "builtin", customTools: [createTool()], sessionManager, settingsManager, resourceLoader });
  const sessionId = sessionManager.getSessionId();
  let failure = null;
  try { await session.prompt(scenario === "auto-compaction" ? "Run the probe tool once and then return a short final response." : "Return a short synthetic response; use the probe tool when instructed by the deterministic provider."); }
  catch (error) { failure = safeError(error); }
  const records = harness.getRecords();
  const contexts = records.filter((record) => record.stage === "CONTEXT");
  const agentObservations = observations.filter((observation) => isAgentProviderPurpose(observation.providerPurpose));
  const activeAfterSettle = harness.getActiveSnapshots().length;
  const stateMessages = Array.isArray(session.state?.messages) ? session.state.messages : [];
  const builtContext = sessionManager.buildSessionContext?.() ?? { messages: [] };
  const contextMessages = Array.isArray(builtContext.messages) ? builtContext.messages : [];
  const entries = sessionManager.getEntries?.() ?? [];
  const entryMessageList = entries.flatMap(entryMessages);
  const persistedManaged = [stateMessages, contextMessages, entryMessageList].some((messages) => managedCount(messages, blockTag) > 0);
  const settledRecord = records.find((record) => record.stage === "AGENT_SETTLED");
  const purposeCounts = Object.fromEntries(observations.reduce((map, item) => map.set(item.providerPurpose, (map.get(item.providerPurpose) ?? 0) + 1), new Map()));
  const contextBeforeProvider = providerCallsFollowContext(records, observations);
  const toolPairObserved = agentObservations.some((observation) => observation.fixedToolCallPresent && observation.fixedToolResultPresent);
  const summaryObservation = observations.find((observation) => observation.providerPurpose === "compaction-summary");
  const postCompactionObservation = observations.find((observation) => observation.providerPurpose === "agent-3");
  const compactionBefore = records.find((record) => record.code === "COMPACTION_BEFORE");
  const compactionSuccess = records.find((record) => record.code === "COMPACTION_SUCCESS");
  const postCompactionContext = postCompactionObservation
    ? contexts.find((record) => record.contextCallIndex === postCompactionObservation.contextCallIndex)
    : undefined;
  const realCompactionOrder = Boolean(summaryObservation && postCompactionObservation && postCompactionContext && compactionBefore && compactionSuccess
    && ["threshold", "overflow"].includes(compactionBefore.evidence.reason)
    && summaryObservation.providerSequence > compactionBefore.sequence
    && summaryObservation.providerSequence < compactionSuccess.sequence
    && postCompactionContext.sequence > compactionSuccess.sequence
    && postCompactionObservation.providerSequence > postCompactionContext.sequence);
  const postCompactionToolPair = Boolean(realCompactionOrder
    && postCompactionObservation.fixedToolCallPresent && postCompactionObservation.fixedToolResultPresent);
  const checks = {
    H01: check("D5-H01", stageSequences(records, "BEFORE_AGENT_START").length === 1 ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "BEFORE_AGENT_START")),
    H02: check("D5-H02", Boolean(sessionId) && ["BEFORE_AGENT_START", "CONTEXT", "AGENT_SETTLED"].every((stage) => records.filter((record) => record.stage === stage).every((record) => record.sessionId === sessionId)) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL),
    H03: check("D5-H03", contexts.length > 0 && new Set(contexts.map((record) => record.snapshotId)).size === 1 ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "CONTEXT")),
    H04: check("D5-H04", contextBeforeProvider ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, [...stageSequences(records, "CONTEXT"), ...agentObservations.map((observation) => observation.providerSequence)]),
    H05: check("D5-H05", agentObservations.length > 0 && agentObservations.every((observation) => observation.providerMarkerCount === 1) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, agentObservations.map((observation) => observation.providerSequence)),
    H06: check("D5-H06", contexts.length > 0 && contexts.every((record) => record.evidence.finalManagedCount === 1) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "CONTEXT")),
    H07: check("D5-H07", contexts.length > 0 && contexts.every((record) => record.evidence.originalMessagesPreserved === true) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "CONTEXT")),
    H08: check("D5-H08", scenario === "tool-loop" ? (toolPairObserved ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL) : CHECK_STATUS.UNOBSERVED, scenario === "tool-loop" ? agentObservations.filter((observation) => observation.fixedToolCallPresent && observation.fixedToolResultPresent).map((observation) => observation.providerSequence) : []),
    H09: check("D5-H09", scenario === "auto-retry" ? (contexts.length >= 2 && new Set(contexts.map((record) => record.snapshotId)).size === 1 ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL) : CHECK_STATUS.UNOBSERVED, scenario === "auto-retry" ? agentObservations.map((observation) => observation.providerSequence) : []),
    H10: check("D5-H10", scenario === "auto-compaction" ? (realCompactionOrder ? CHECK_STATUS.PASS : CHECK_STATUS.UNOBSERVED) : CHECK_STATUS.UNOBSERVED, scenario === "auto-compaction" ? [compactionBefore?.sequence, summaryObservation?.providerSequence, compactionSuccess?.sequence, postCompactionContext?.sequence, postCompactionObservation?.providerSequence].filter(Number.isInteger) : []),
    H11: check("D5-H11", scenario === "auto-compaction" ? (realCompactionOrder ? (postCompactionToolPair ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL) : CHECK_STATUS.UNOBSERVED) : CHECK_STATUS.UNOBSERVED, postCompactionObservation ? [postCompactionObservation.providerSequence] : []),
    H12: check("D5-H12", contexts.length > 0 && contexts.every((record) => ["budgetMethod", "baseEstimatedTokens", "managedEstimatedTokens", "finalEstimatedTokens", "budgetGap"].every((field) => field in record.evidence)) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "CONTEXT")),
    H13: check("D5-H13", settledRecord?.evidence?.activeSnapshotCountBefore >= 1 && settledRecord?.evidence?.activeSnapshotCountAfter === 0 && activeAfterSettle === 0 ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, stageSequences(records, "AGENT_SETTLED")),
    H14: check("D5-H14", !persistedManaged ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL),
    H15: check("D5-H15", !JSON.stringify({ records, observations }).includes(TOOL_RESULT_CANARY) && !JSON.stringify({ records, observations }).includes(THINKING_CANARY) && !JSON.stringify({ records, observations }).includes(MANAGED_CANARY) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL),
    H16: check("D5-H16", failuresAreDiagnosable(records, failure) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, records.filter((record) => record.status === CHECK_STATUS.FAIL).map((record) => record.sequence)),
  };
  const result = { scenario, sessionId, records, checks, observations, purposeCounts, failure, compactionSettingsAfter: settingsManager.getCompactionSettings(), historyAudit: { messageCount: stateMessages.length, contextMessageCount: contextMessages.length, entryCount: entries.length, entryMessageCount: entryMessageList.length, persistedManaged } };
  session.dispose();
  faux.unregister?.();
  return result;
}

async function main() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const artifactPath = resolve(projectRoot, "artifacts", "pi-context-hook-spike.json");
  const artifact = { schemaVersion: 1, createdAt: new Date().toISOString(), piSdkVersion: VERSION, execution: { network: false, persistence: "in-memory", provider: "faux", scenarios: SCENARIOS }, scenarios: [], records: [], checks: [], decision: DECISION.INCONCLUSIVE_RERUN, failureLocation: null, passed: false };
  let sequenceStart = 0;
  try {
    for (const scenario of SCENARIOS) {
      try {
        const result = await runScenario({ scenario, projectRoot, sequenceStart });
        artifact.scenarios.push({ scenario: result.scenario, sessionId: result.sessionId, failure: result.failure, observations: result.observations, purposeCounts: result.purposeCounts, checks: result.checks, compactionSettingsAfter: result.compactionSettingsAfter, historyAudit: result.historyAudit });
        artifact.records.push(...result.records);
        const firstFailure = result.records.find((record) => record.status === CHECK_STATUS.FAIL);
        if (firstFailure) artifact.failureLocation ??= { scenario, stage: firstFailure.stage, sequence: firstFailure.sequence, code: firstFailure.code, errorType: firstFailure.evidence?.errorType ?? null, errorSummary: firstFailure.evidence?.errorSummary ?? null };
        if (result.failure) artifact.failureLocation ??= { scenario, stage: "PROMPT", sequence: result.records.at(-1)?.sequence ?? sequenceStart, ...result.failure };
        sequenceStart = artifact.records.length ? Math.max(...artifact.records.map((record) => record.sequence)) : sequenceStart;
      } catch (error) {
        const safe = safeError(error);
        const sequence = ++sequenceStart;
        artifact.failureLocation ??= { scenario, stage: "SETUP", sequence, ...safe };
        artifact.scenarios.push({ scenario, failure: safe });
        artifact.records.push({ schemaVersion: 1, sequence, scenario, stage: "SETUP", status: CHECK_STATUS.UNOBSERVED, code: safe.code, sessionId: null, snapshotId: null, contextCallIndex: null, evidence: { errorType: safe.errorType } });
      }
    }
    const results = artifact.scenarios.filter((scenario) => scenario.checks).map((scenario) => ({ scenario: scenario.scenario, checks: scenario.checks }));
    artifact.checks = aggregateScenarioChecks(results);
    artifact.decision = evaluateDay5Decision({ checks: artifact.checks });
  } catch (error) {
    const safe = safeError(error);
    artifact.failureLocation ??= { scenario: "unknown", stage: "DECISION", sequence: ++sequenceStart, ...safe };
    artifact.decision = DECISION.INCONCLUSIVE_RERUN;
  } finally {
    const serialized = JSON.stringify(artifact);
    if (serialized.includes(TOOL_RESULT_CANARY) || serialized.includes(THINKING_CANARY) || serialized.includes(MANAGED_CANARY)) {
      artifact.failureLocation ??= { scenario: "artifact", stage: "HISTORY_AUDIT", sequence: ++sequenceStart, code: "D5_ARTIFACT_CANARY_LEAK", errorType: "SafetyScanError", message: "synthetic canary found in artifact" };
      artifact.decision = DECISION.NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH;
    }
    artifact.passed = artifact.decision === DECISION.GO_SDK;
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\nArtifact: ${artifactPath}\n`);
  }
  if (!artifact.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1; });
}
