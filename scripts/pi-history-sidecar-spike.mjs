import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  extractExplicitContent,
  filterAuthorizedHistoryDescriptors,
  hashPiEntry,
  HistoryCatalog,
  HistoryIndexer,
  HistoryLoader,
  loadAuthorizedExplicitHistory,
} from "../src/history-sidecar.js";
import { GroupTreeManager } from "../src/group-tree.js";
import { DevelopmentRecordStore, RECORD_EXPOSURES } from "../src/record-store.js";
import { TaskManager } from "../src/task-manager.js";
import { filterAuthorizedDescriptors } from "../src/authorization.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = resolve(ROOT, "artifacts/pi-history-sidecar-spike.json");
const CANARIES = ["D6_CROSS_GROUP_SECRET_CANARY", "D6_THINKING_CANARY", "D6_TOOL_RESULT_CANARY", "D6_COMPACTION_SUMMARY_CANARY", "D6_ABANDONED_BRANCH_CANARY"];
const SAFE_FIELDS = new Set(["scenario", "stage", "code", "status", "descriptorId", "piSessionRef", "piEntryId", "sourceSessionId", "groupId", "taskId", "entryType", "exposure", "descriptorStatus", "scannedCount", "createdCount", "unchangedCount", "skippedCount", "conflictCount", "allowedCount", "deniedCount", "loadedCount", "extractedItemCount", "thinkingBlockCount", "imageBlockCount", "unsupportedBlockCount", "readAttemptCount", "reasonCode", "errorCode", "contentHashMatched", "topologyNodeCount", "activeBranchCount", "catalogDescriptorCount", "abandonedBranchExcluded"]);
const CHECK_IDS = ["D6-H01", "D6-H02", "D6-H03", "D6-H04", "D6-H05", "D6-H06", "D6-H07", "D6-H08", "D6-H09", "D6-H10", "D6-H11", "D6-H12", "D6-H13", "D6-H14", "D6-H15", "D6-H16", "D6-H17"];
const CHECK_TEXT = [
  "body-free descriptor association", "stable whole-entry canonical hash", "eligible entry classification", "idempotent incremental reconcile", "default WORK_RECORD exposure", "controlled first-write DESIGN_CONTEXT override", "metadata-only compaction", "catalog deep-copy and revoke audit", "existing authorization matrix reuse", "authorization before loading", "unknown/session fail-closed", "hash/type integrity fail-closed", "revoked history fail-closed", "explicit block extraction and toolCallId closure", "cross-group canary isolation", "Pi in-memory SessionManager end-to-end", "metadata-only active branch follows current Pi leaf after branch switch",
];
const checks = CHECK_IDS.map((id, index) => ({ id, requirement: CHECK_TEXT[index], status: "UNOBSERVED", evidenceSequence: [] }));
const records = [];
let sequence = 0;
let failureLocation = null;
const scenarios = { "incremental-index": "NOT_RUN", "controlled-exposure": "NOT_RUN", "authorized-load": "NOT_RUN", "integrity-failures": "NOT_RUN", "cross-group-canary": "NOT_RUN", "explicit-extraction": "NOT_RUN", "active-branch-scope": "NOT_RUN" };

function log(scenario, stage, code, fields = {}) {
  const record = { sequence: ++sequence, scenario, stage, code, status: "PASS" };
  for (const [key, value] of Object.entries(fields)) if (SAFE_FIELDS.has(key) && value !== undefined) record[key] = value;
  records.push(record);
  return record.sequence;
}
function pass(ids, evidence) { for (const id of ids) { const item = checks.find((check) => check.id === id); item.status = "PASS"; item.evidenceSequence.push(evidence); } }
function fail(ids, evidence, code) { for (const id of ids) { const item = checks.find((check) => check.id === id); item.status = "FAIL"; item.evidenceSequence.push(evidence); item.reasonCode = code; } }
function assert(condition, code) { if (!condition) { const error = new Error(code); error.code = code; throw error; } }

function environment(manager, suffix = "a") {
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: `group-${suffix}`, name: suffix, policyVersion: "p1", rootSession: { id: `root-${suffix}`, piSessionRef: `pi-root-${suffix}`, displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: `worker-${suffix}`, groupId: `group-${suffix}`, piSessionRef: manager.getSessionId(), displayRole: "worker", parentId: `root-${suffix}`, status: "ACTIVE" });
  groupTree.addSession({ id: `child-${suffix}`, groupId: `group-${suffix}`, piSessionRef: `pi-child-${suffix}`, displayRole: "child", parentId: `worker-${suffix}`, status: "ACTIVE" });
  groupTree.addSession({ id: `peer-${suffix}`, groupId: `group-${suffix}`, piSessionRef: `pi-peer-${suffix}`, displayRole: "peer", parentId: `root-${suffix}`, status: "ACTIVE" });
  groupTree.createGroup({ id: `group-x${suffix}`, name: "other", policyVersion: "p1", rootSession: { id: `other-${suffix}`, piSessionRef: `pi-other-${suffix}`, displayRole: "root", status: "ACTIVE" } });
  const taskManager = new TaskManager({ groupTree });
  taskManager.createTask({ id: `task-${suffix}`, groupId: `group-${suffix}`, issuerSessionId: `root-${suffix}`, assigneeSessionId: `worker-${suffix}`, goal: "synthetic", acceptanceCriteria: ["verified"] });
  const developmentRecordStore = new DevelopmentRecordStore({ groupTree, taskManager });
  const catalog = new HistoryCatalog();
  let next = 0;
  const indexer = new HistoryIndexer({ catalog, groupTree, taskManager, developmentRecordStore, createId: () => `d-${suffix}-${++next}` });
  return { groupTree, taskManager, developmentRecordStore, catalog, indexer, groupId: `group-${suffix}`, sourceSessionId: `worker-${suffix}`, rootSessionId: `root-${suffix}`, childSessionId: `child-${suffix}`, peerSessionId: `peer-${suffix}`, taskId: `task-${suffix}` };
}
function reconcile(manager, env, extra = {}) { return env.indexer.reconcile({ sessionManager: manager, piSessionRef: manager.getSessionId(), groupId: env.groupId, sourceSessionId: env.sourceSessionId, ...extra }); }
function makeReadLoader(env, managers) {
  let attempts = 0;
  const resolveSessionManager = (ref) => { attempts += 1; return managers.get(ref); };
  const loader = new HistoryLoader({ catalog: env.catalog, resolveSessionManager });
  return { loader, readAttempts: () => attempts };
}
function callResultById(manager, entries, id) { return manager.getEntry(id) ?? entries.find((entry) => entry.id === id); }

async function scenario(name, affectedChecks, fn) {
  scenarios[name] = "RUNNING";
  try { await fn(); scenarios[name] = "PASS"; }
  catch (error) {
    scenarios[name] = "FAIL";
    const evidence = log(name, "scenario", "SCENARIO_EXCEPTION", { status: "FAIL", errorCode: typeof error?.code === "string" ? error.code : "SCENARIO_FAILED" });
    fail(affectedChecks, evidence, typeof error?.code === "string" ? error.code : "SCENARIO_FAILED");
    if (!failureLocation) failureLocation = { scenario: name, stage: "scenario", code: typeof error?.code === "string" ? error.code : "SCENARIO_FAILED" };
  }
}

async function main() {
  const managers = new Map();
  await scenario("incremental-index", ["D6-H01", "D6-H02", "D6-H03", "D6-H04", "D6-H05", "D6-H16"], () => {
    const manager = SessionManager.inMemory(); managers.set(manager.getSessionId(), manager);
    const userId = manager.appendMessage({ role: "user", content: "synthetic user fixture" });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic assistant fixture" }] });
    const env = environment(manager);
    const first = reconcile(manager, env);
    const second = reconcile(manager, env);
    const addedId = manager.appendMessage({ role: "user", content: "synthetic incremental fixture" });
    const delta = reconcile(manager, env);
    const d = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: userId });
    const stable = hashPiEntry(manager.getEntry(userId)) === hashPiEntry(manager.getEntry(userId));
    const changed = hashPiEntry(manager.getEntry(userId)) !== hashPiEntry({ ...manager.getEntry(userId), fixtureChange: true });
    const getEntriesHaveIds = manager.getEntries().every((entry) => typeof entry.id === "string" && entry.id.length > 0);
    const seq = log("incremental-index", "reconcile", "PI_IN_MEMORY_RECONCILE", { piSessionRef: manager.getSessionId(), piEntryId: userId, descriptorId: d.id, sourceSessionId: env.sourceSessionId, groupId: env.groupId, entryType: d.entryType, exposure: d.exposure, scannedCount: first.scannedCount, createdCount: first.createdDescriptorIds.length, unchangedCount: second.unchangedDescriptorIds.length, skippedCount: first.skipped.length, conflictCount: delta.conflicts.length });
    assert(d.exposure === RECORD_EXPOSURES.WORK_RECORD && first.createdDescriptorIds.length === 2 && second.createdDescriptorIds.length === 0 && delta.createdDescriptorIds.length === 1 && env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: addedId }), "INCREMENTAL_RECONCILE_FAILED");
    assert(stable && changed && getEntriesHaveIds && !("message" in d) && !("content" in d), "DESCRIPTOR_OR_HASH_EVIDENCE_FAILED");
    pass(["D6-H01", "D6-H02", "D6-H03", "D6-H04", "D6-H05", "D6-H16"], seq);
  });

  await scenario("controlled-exposure", ["D6-H06"], () => {
    const manager = SessionManager.inMemory(); managers.set(manager.getSessionId(), manager);
    const messageId = manager.appendMessage({ role: "user", content: "synthetic directive fixture" });
    const env = environment(manager, "b");
    env.developmentRecordStore.createRecord({ id: "authority-b", groupId: env.groupId, taskId: env.taskId, sourceSessionId: env.rootSessionId, type: "WORK_DIRECTIVE", exposure: "DESIGN_CONTEXT", payload: { safeTestOnly: true } });
    const override = { piEntryId: messageId, exposure: "DESIGN_CONTEXT", provenance: { kind: "TASK_DIRECTIVE", authorityRecordId: "authority-b" } };
    reconcile(manager, env, { taskId: env.taskId, exposureOverrides: [override] });
    const descriptor = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: messageId });
    const late = reconcile(manager, env, { taskId: env.taskId });
    let groupFactRejected = false;
    try { reconcile(manager, env, { taskId: env.taskId, exposureOverrides: [{ ...override, exposure: "GROUP_FACT" }] }); } catch { groupFactRejected = true; }
    const seq = log("controlled-exposure", "authority", "CONTROLLED_OVERRIDE", { descriptorId: descriptor.id, piSessionRef: manager.getSessionId(), piEntryId: messageId, exposure: descriptor.exposure, sourceSessionId: env.sourceSessionId, groupId: env.groupId, taskId: env.taskId, conflictCount: late.conflicts.length });
    assert(descriptor.exposure === "DESIGN_CONTEXT" && descriptor.exposureSource === "TASK_DIRECTIVE" && descriptor.exposureAuthorityId === "authority-b" && late.conflicts.length === 0 && late.unchangedDescriptorIds.includes(descriptor.id) && groupFactRejected, "CONTROLLED_OVERRIDE_FAILED");
    pass(["D6-H06"], seq);
  });

  await scenario("authorized-load", ["D6-H09", "D6-H10"], () => {
    const manager = SessionManager.inMemory(); managers.set(manager.getSessionId(), manager);
    const entryId = manager.appendMessage({ role: "user", content: "synthetic authorization fixture" });
    const env = environment(manager, "c"); reconcile(manager, env);
    const { loader, readAttempts } = makeReadLoader(env, managers);
    const denied = loadAuthorizedExplicitHistory({ viewerSessionId: env.childSessionId, catalog: env.catalog, loader, groupTree: env.groupTree });
    const deniedAttempts = readAttempts();
    const allowed = loadAuthorizedExplicitHistory({ viewerSessionId: env.rootSessionId, catalog: env.catalog, loader, groupTree: env.groupTree });
    const matrixDescriptors = ["WORK_RECORD", "DESIGN_CONTEXT", "GROUP_FACT"].map((exposure, index) => ({ recordId: `matrix-${index}`, groupId: env.groupId, taskId: env.taskId, sourceSessionId: env.sourceSessionId, type: "SUMMARY", exposure, sourceRecordIds: [], contentHash: "sha256:" + "a".repeat(64), schemaVersion: 1, createdAt: new Date().toISOString() }));
    const matrixViewers = [env.sourceSessionId, env.rootSessionId, env.childSessionId, env.peerSessionId, "other-c"];
    const expectedMatrix = [[true, true, true], [true, true, true], [false, true, true], [false, false, true], [false, false, false]];
    let matrixCorrect = true;
    for (let viewerIndex = 0; viewerIndex < matrixViewers.length; viewerIndex += 1) {
      const result = filterAuthorizedDescriptors({ viewerSessionId: matrixViewers[viewerIndex], descriptors: matrixDescriptors, groupTree: env.groupTree });
      matrixCorrect &&= result.decisions.length === 3 && result.decisions.every((decision, exposureIndex) => decision.allowed === expectedMatrix[viewerIndex][exposureIndex]);
    }
    const seq = log("authorized-load", "authorization", "AUTHORIZATION_BEFORE_READ", { piSessionRef: manager.getSessionId(), piEntryId: entryId, sourceSessionId: env.sourceSessionId, groupId: env.groupId, allowedCount: allowed.descriptors.length, deniedCount: denied.decisions.filter((d) => !d.allowed).length, loadedCount: allowed.extractedItems.length, readAttemptCount: deniedAttempts });
    assert(deniedAttempts === 0 && denied.extractedItems.length === 0 && allowed.extractedItems.length === 1 && matrixCorrect, "AUTHORIZATION_ORDER_OR_MATRIX_FAILED");
    pass(["D6-H09", "D6-H10"], seq);
  });

  await scenario("integrity-failures", ["D6-H07", "D6-H08", "D6-H11", "D6-H12", "D6-H13"], () => {
    const manager = SessionManager.inMemory(); managers.set(manager.getSessionId(), manager);
    const userId = manager.appendMessage({ role: "user", content: "synthetic integrity fixture" });
    const env = environment(manager, "d"); reconcile(manager, env);
    const descriptor = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: userId });
    const read = makeReadLoader(env, managers);
    const unknownRejected = (() => { try { read.loader.loadAllowed({ allowedDescriptorIds: ["unknown-descriptor"] }); return false; } catch { return true; } })();
    const badCatalog = new HistoryCatalog(); badCatalog.registerDescriptor({ ...descriptor, id: "bad-hash-d", contentHash: "sha256:" + "0".repeat(64) });
    const hashRejected = (() => { try { new HistoryLoader({ catalog: badCatalog, resolveSessionManager: () => manager }).loadAllowed({ allowedDescriptorIds: ["bad-hash-d"] }); return false; } catch { return true; } })();
    const driftCatalog = new HistoryCatalog();
    const driftedEntry = { ...manager.getEntry(userId), type: "custom" };
    driftCatalog.registerDescriptor({ ...descriptor, id: "type-drift-d", contentHash: hashPiEntry(driftedEntry) });
    const typeRejected = (() => { try { new HistoryLoader({ catalog: driftCatalog, resolveSessionManager: () => ({ getSessionId: () => manager.getSessionId(), getEntry: () => driftedEntry }) }).loadAllowed({ allowedDescriptorIds: ["type-drift-d"] }); return false; } catch (error) { return error.code === "ENTRY_TYPE_MISMATCH"; } })();
    const missingCatalog = new HistoryCatalog();
    missingCatalog.registerDescriptor({ ...descriptor, id: "missing-entry-d", piEntryId: "entry-does-not-exist" });
    const missingEntryRejected = (() => { try { new HistoryLoader({ catalog: missingCatalog, resolveSessionManager: () => manager }).loadAllowed({ allowedDescriptorIds: ["missing-entry-d"] }); return false; } catch (error) { return error.code === "PI_ENTRY_NOT_FOUND"; } })();
    const mismatched = (() => { try { new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => ({ getSessionId: () => "wrong-session", getEntry: manager.getEntry.bind(manager) }) }).loadAllowed({ allowedDescriptorIds: [descriptor.id] }); return false; } catch { return true; } })();
    let managerAttempt = 0;
    const compactId = manager.appendCompaction("D6_COMPACTION_SUMMARY_CANARY", userId, 450);
    reconcile(manager, env);
    const compact = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: compactId });
    const noCompactRead = (() => { try { new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => { managerAttempt += 1; return manager; } }).loadAllowed({ allowedDescriptorIds: [compact.id] }); return false; } catch { return managerAttempt === 0; } })();
    const cloned = env.catalog.getDescriptor(descriptor.id); cloned.id = "tampered";
    const beforeRevoke = env.catalog.listAuditEvents().length;
    env.catalog.revokeDescriptor({ descriptorId: descriptor.id, reason: "POLICY_REVOKED" });
    const revokedReject = (() => { try { read.loader.loadAllowed({ allowedDescriptorIds: [descriptor.id] }); return false; } catch { return true; } })();
    const seq = log("integrity-failures", "loader", "FAIL_CLOSED_INTEGRITY", { descriptorId: descriptor.id, piSessionRef: manager.getSessionId(), piEntryId: userId, descriptorStatus: "REVOKED", contentHashMatched: false, loadedCount: 0, readAttemptCount: managerAttempt, reasonCode: "FAIL_CLOSED" });
    assert(unknownRejected && missingEntryRejected && hashRejected && typeRejected && mismatched && noCompactRead && revokedReject && beforeRevoke === 0 && env.catalog.listAuditEvents().length === 1 && env.catalog.getDescriptor(descriptor.id).id === descriptor.id, "INTEGRITY_FAIL_CLOSED_FAILED");
    pass(["D6-H07", "D6-H08", "D6-H11", "D6-H12", "D6-H13"], seq);
  });

  await scenario("cross-group-canary", ["D6-H15"], () => {
    const local = SessionManager.inMemory(); local.appendMessage({ role: "user", content: "synthetic local" });
    const foreign = SessionManager.inMemory(); const foreignId = foreign.appendMessage({ role: "user", content: "D6_CROSS_GROUP_SECRET_CANARY" });
    managers.set(local.getSessionId(), local); managers.set(foreign.getSessionId(), foreign);
    const env = environment(local, "e"); reconcile(local, env);
    const foreignEntry = foreign.getEntry(foreignId);
    env.catalog.registerDescriptor({ id: "foreign-e", piSessionRef: foreign.getSessionId(), piEntryId: foreignId, groupId: "group-xe", sourceSessionId: "other-e", taskId: null, entryType: "MESSAGE", exposure: "WORK_RECORD", exposureSource: "DEFAULT", exposureAuthorityId: null, status: "ACTIVE", contentHash: hashPiEntry(foreignEntry), schemaVersion: 1, createdAt: new Date().toISOString(), revokedAt: null });
    let foreignReads = 0; const real = foreign.getEntry.bind(foreign); foreign.getEntry = (...args) => { foreignReads += 1; return real(...args); };
    const { loader } = makeReadLoader(env, managers);
    const result = loadAuthorizedExplicitHistory({ viewerSessionId: env.rootSessionId, catalog: env.catalog, loader, groupTree: env.groupTree });
    const safeText = JSON.stringify({ decisions: result.decisions, descriptors: result.descriptors, extractedIds: result.extractedItems.map(({ descriptorId }) => descriptorId) });
    const seq = log("cross-group-canary", "authorization", "CROSS_GROUP_DENIED", { descriptorId: "foreign-e", piSessionRef: foreign.getSessionId(), piEntryId: foreignId, sourceSessionId: "other-e", groupId: "group-xe", deniedCount: 1, loadedCount: 0, readAttemptCount: foreignReads, reasonCode: result.decisions.find((item) => item.recordId === "foreign-e")?.reasonCode });
    assert(foreignReads === 0 && !safeText.includes("D6_CROSS_GROUP_SECRET_CANARY"), "CROSS_GROUP_CANARY_LEAK_OR_READ");
    pass(["D6-H15"], seq);
  });

  await scenario("explicit-extraction", ["D6-H14"], () => {
    const manager = SessionManager.inMemory();
    const assistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic visible" }, { type: "thinking", thinking: "D6_THINKING_CANARY" }, { type: "toolCall", id: "tool-call-fixed-17", name: "fixture", arguments: { q: "synthetic" } }, { type: "image", data: "D6_TOOL_RESULT_CANARY" }] });
    const toolId = manager.appendMessage({ role: "toolResult", toolCallId: "tool-call-fixed-17", toolName: "fixture", content: [{ type: "text", text: "synthetic result" }], isError: false, details: "discard", usage: { tokens: 1 } });
    const env = environment(manager, "f"); reconcile(manager, env);
    const loader = new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => manager });
    const loaded = loader.loadAllowed({ allowedDescriptorIds: [assistantId, toolId].map((entryId) => env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: entryId }).id) });
    const projections = loaded.map(extractExplicitContent);
    const call = projections[0].items.find((item) => item.type === "TOOL_CALL");
    const result = projections[1].items.find((item) => item.type === "TOOL_RESULT");
    const seq = log("explicit-extraction", "projection", "EXPLICIT_BLOCKS_ONLY", { piSessionRef: manager.getSessionId(), piEntryId: assistantId, entryType: "MESSAGE", extractedItemCount: projections.reduce((sum, item) => sum + item.items.length, 0), thinkingBlockCount: projections[0].omitted.thinkingBlockCount, imageBlockCount: projections[0].omitted.imageBlockCount, unsupportedBlockCount: projections[0].omitted.unsupportedBlockCount });
    assert(call?.toolCallId === "tool-call-fixed-17" && result?.toolCallId === call.toolCallId && projections[0].omitted.thinkingBlockCount === 1 && projections[0].omitted.imageBlockCount === 1, "EXPLICIT_EXTRACTION_FAILED");
    pass(["D6-H14"], seq);
  });

  await scenario("active-branch-scope", ["D6-H17"], () => {
    const manager = SessionManager.inMemory();
    const anchorId = manager.appendMessage({ role: "user", content: "synthetic shared anchor" });
    const abandonedId = manager.appendMessage({ role: "user", content: "D6_ABANDONED_BRANCH_CANARY" });
    const env = environment(manager, "g");
    const getBranchSpy = (() => { let calls = 0; const original = manager.getBranch.bind(manager); manager.getBranch = (...args) => { calls += 1; return original(...args); }; return () => calls; })();
    reconcile(manager, env);
    manager.branch(anchorId);
    const activeId = manager.appendMessage({ role: "user", content: "synthetic active branch" });
    reconcile(manager, env);
    const topology = env.catalog.getSessionTopology(manager.getSessionId());
    const activeIds = env.catalog.listActiveBranchEntryIds(manager.getSessionId());
    const descriptors = env.catalog.listDescriptors({ piSessionRef: manager.getSessionId() });
    const activeDescriptors = env.catalog.listActiveBranchDescriptors({ piSessionRef: manager.getSessionId() });
    const excluded = descriptors.some(({ piEntryId }) => piEntryId === abandonedId) && !activeIds.includes(abandonedId) && !activeDescriptors.some(({ piEntryId }) => piEntryId === abandonedId);
    const seq = log("active-branch-scope", "branch", "ACTIVE_BRANCH_METADATA_ONLY", { piSessionRef: manager.getSessionId(), scannedCount: topology.nodes.length, topologyNodeCount: topology.nodes.length, activeBranchCount: activeIds.length, catalogDescriptorCount: descriptors.length, abandonedBranchExcluded: excluded });
    assert(getBranchSpy() === 0 && activeIds.join(",") === `${anchorId},${activeId}` && excluded && !JSON.stringify({ activeIds, activeDescriptors }).includes("D6_ABANDONED_BRANCH_CANARY"), "ACTIVE_BRANCH_SCOPE_FAILED");
    pass(["D6-H17"], seq);
  });
}

let executionError = false;
try { await main(); }
catch (error) {
  executionError = true;
  const evidence = log("runner", "top-level", "RUNNER_EXCEPTION", { status: "FAIL", errorCode: typeof error?.code === "string" ? error.code : "RUNNER_FAILED" });
  for (const item of checks.filter((check) => check.status === "UNOBSERVED")) { item.status = "FAIL"; item.reasonCode = "RUNNER_FAILED"; item.evidenceSequence.push(evidence); }
  failureLocation ??= { scenario: "runner", stage: "top-level", code: typeof error?.code === "string" ? error.code : "RUNNER_FAILED" };
} finally {
  for (const check of checks) check.evidenceSequence = [...new Set(check.evidenceSequence)].sort((a, b) => a - b);
  const hasFail = checks.some((check) => check.status === "FAIL");
  const allPass = checks.every((check) => check.status === "PASS");
  let artifact = { schemaVersion: 1, createdAt: new Date().toISOString(), piSdkVersion: "0.85.1", execution: { offline: true, modelCalls: 0, realSessionReads: 0 }, scenarios, records, checks, failureLocation, decision: hasFail ? "DAY6_FAILED" : allPass ? "DAY6_COMPLETE_GO_DAY7" : "DAY6_INCONCLUSIVE_RERUN", passed: allPass && !executionError };
  const serialized = JSON.stringify(artifact, null, 2);
  if (CANARIES.some((canary) => serialized.includes(canary))) {
    const safeSequence = ++sequence;
    const h15 = checks.find((check) => check.id === "D6-H15");
    h15.status = "FAIL";
    h15.reasonCode = "ARTIFACT_CANARY_SCAN_FAILED";
    h15.evidenceSequence = [safeSequence];
    failureLocation = { scenario: "runner", stage: "artifact-scan", code: "ARTIFACT_CANARY_SCAN_FAILED" };
    artifact = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      piSdkVersion: "0.85.1",
      execution: { offline: true, modelCalls: 0, realSessionReads: 0 },
      scenarios,
      records: [{ sequence: safeSequence, scenario: "runner", stage: "artifact-scan", code: "CANARY_FOUND_IN_ARTIFACT", status: "FAIL", errorCode: "ARTIFACT_CANARY_SCAN_FAILED" }],
      checks,
      failureLocation,
      decision: "DAY6_FAILED",
      passed: false,
    };
  }
  await mkdir(dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, JSON.stringify(artifact, null, 2), "utf8");
  console.log(JSON.stringify({ artifact: "artifacts/pi-history-sidecar-spike.json", scenarios, checks: artifact.checks, decision: artifact.decision, failureLocation: artifact.failureLocation }, null, 2));
}
if (checks.some((check) => check.status !== "PASS")) process.exitCode = 1;
