import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FactSnapshotError, FactSnapshotManager } from "../src/fact-snapshot.js";
import { GroupFactError, GroupFactStore, hashFactValue } from "../src/group-fact-store.js";
import { GroupTreeManager } from "../src/group-tree.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = resolve(ROOT, "artifacts/group-fact-store-spike.json");
const CANARIES = ["D7_CROSS_GROUP_FACT_CANARY", "D7_SUPERSEDED_FACT_CANARY", "D7_REVOKED_FACT_CANARY", "D7_BUDGET_FACT_CANARY"];
const SAFE_FIELDS = new Set(["scenario", "stage", "code", "status", "groupId", "factId", "factKey", "version", "factStatus", "supersedesId", "supersededById", "actorSessionId", "snapshotId", "targetSessionId", "factCount", "estimatedTokens", "factTokenBudget", "budgetGap", "activeSnapshotCount", "piEntryCountBefore", "piEntryCountAfter", "reasonCode", "errorCode"]);
const CHECKS = [
  ["D7-H01", "canonical value hash, exact schema, and no fact value in diagnostics/artifact"],
  ["D7-H02", "root first publish creates version 1 ACTIVE"],
  ["D7-H03", "single ACTIVE per group/key and key isolation across groups"],
  ["D7-H04", "replace creates version+1 with preserved bidirectional supersede chain"],
  ["D7-H05", "stale/duplicate/no-op/invalid mutation failures are atomic"],
  ["D7-H06", "revoke affects current ACTIVE only and never rolls back"],
  ["D7-H07", "revoked version can be explicitly republished as next version without rewriting old version"],
  ["D7-H08", "only group root can mutate facts"],
  ["D7-H09", "same-group reads allowed and cross-group reads denied without canary leak"],
  ["D7-H10", "get/list/audit are deep-copied, sorted, and audit is value-free"],
  ["D7-H11", "snapshot contains all active facts, refs, and budget metadata"],
  ["D7-H12", "existing snapshot remains pinned after store replacement"],
  ["D7-H13", "next-run worker/tester snapshots read the replacement version"],
  ["D7-H14", "revoke changes future snapshot only; old snapshots remain and new one omits key"],
  ["D7-H15", "budget overrun fails without partial snapshot or value leakage"],
  ["D7-H16", "FactStore/snapshots leave Pi history unchanged; offline and artifact safe"],
];
const checks = CHECKS.map(([id, requirement]) => ({ id, requirement, status: "UNOBSERVED", evidenceSequence: [] }));
const records = [];
const scenarios = { "version-lifecycle": "NOT_RUN", "root-only-mutation": "NOT_RUN", "group-read-boundary": "NOT_RUN", "snapshot-isolation": "NOT_RUN", "fact-budget": "NOT_RUN", "pi-history-isolation": "NOT_RUN" };
let sequence = 0;
let failureLocation = null;
let executionError = false;
let finalArtifactPassed = false;

function log(scenario, stage, code, fields = {}, status = "PASS") {
  const record = { sequence: ++sequence, scenario, stage, code, status };
  for (const [key, value] of Object.entries(fields)) if (SAFE_FIELDS.has(key) && value !== undefined && value !== null) record[key] = value;
  records.push(record);
  return record.sequence;
}
function mark(ids, evidence, status = "PASS", reasonCode) {
  for (const id of ids) {
    const check = checks.find((item) => item.id === id);
    if (check.status === "UNOBSERVED" || status === "FAIL") check.status = status;
    if (reasonCode) check.reasonCode = reasonCode;
    check.evidenceSequence.push(evidence);
  }
}
function assert(condition, code) {
  if (!condition) { const error = new Error("scenario assertion failed"); error.code = code; throw error; }
}
function environment(suffix) {
  const pi = SessionManager.inMemory();
  pi.appendMessage({ role: "user", content: "synthetic pre-existing Pi history" });
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: `group-${suffix}`, name: suffix, policyVersion: "p1", rootSession: { id: `root-${suffix}`, piSessionRef: `pi-root-${suffix}`, displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: `worker-${suffix}`, groupId: `group-${suffix}`, piSessionRef: pi.getSessionId(), displayRole: "worker", parentId: `root-${suffix}`, status: "ACTIVE" });
  groupTree.addSession({ id: `tester-${suffix}`, groupId: `group-${suffix}`, piSessionRef: `pi-tester-${suffix}`, displayRole: "tester", parentId: `root-${suffix}`, status: "ACTIVE" });
  groupTree.addSession({ id: `peer-${suffix}`, groupId: `group-${suffix}`, piSessionRef: `pi-peer-${suffix}`, displayRole: "peer", parentId: `root-${suffix}`, status: "ACTIVE" });
  groupTree.createGroup({ id: `foreign-${suffix}`, name: "foreign", policyVersion: "p1", rootSession: { id: `foreign-root-${suffix}`, piSessionRef: `pi-foreign-${suffix}`, displayRole: "root", status: "ACTIVE" } });
  let tick = 0;
  const factStore = new GroupFactStore({ groupTree, now: () => new Date(Date.UTC(2026, 8, 17) + tick++ * 1000) });
  let snapshotNo = 0;
  const snapshots = new FactSnapshotManager({ factStore, now: () => new Date(Date.UTC(2026, 8, 17, 1) + tick++ * 1000), createId: () => `snapshot-${suffix}-${++snapshotNo}` });
  return { pi, groupTree, factStore, snapshots, groupId: `group-${suffix}`, root: `root-${suffix}`, worker: `worker-${suffix}`, tester: `tester-${suffix}`, peer: `peer-${suffix}`, foreignRoot: `foreign-root-${suffix}` };
}
function publish(env, id, factKey, value, groupId = env.groupId, actor = env.root) {
  return env.factStore.publishFact({ id, groupId, factKey, value, createdBySessionId: actor });
}
async function scenario(name, ids, run) {
  scenarios[name] = "RUNNING";
  try {
    const evidence = await run();
    const seq = log(name, evidence.stage, evidence.code, evidence.fields);
    mark(ids, seq);
    scenarios[name] = "PASS";
  } catch (error) {
    scenarios[name] = "FAIL";
    const code = typeof error?.code === "string" ? error.code : "SCENARIO_FAILED";
    const seq = log(name, "scenario", "SCENARIO_EXCEPTION", { errorCode: code }, "FAIL");
    mark(ids, seq, "FAIL", code);
    failureLocation ??= { scenario: name, stage: "scenario", code };
  }
}

async function main() {
  await scenario("version-lifecycle", ["D7-H01", "D7-H02", "D7-H03", "D7-H04", "D7-H05", "D7-H06", "D7-H07", "D7-H10"], () => {
    const env = environment("life");
    const v1 = publish(env, "life-v1", "policy.order", { marker: "D7_SUPERSEDED_FACT_CANARY" });
    const v1HashBefore = v1.contentHash;
    const v1ValueBefore = JSON.stringify(v1.value);
    const exactSchema = Object.keys(v1).sort().join(",") === ["contentHash", "createdAt", "createdBySessionId", "factKey", "groupId", "id", "revokeReason", "revokedAt", "revokedBySessionId", "schemaVersion", "status", "supersededAt", "supersededById", "supersedesId", "value", "version"].sort().join(",");
    const stableHash = v1.contentHash === hashFactValue({ marker: "D7_SUPERSEDED_FACT_CANARY" });
    const v2 = env.factStore.replaceFact({ id: "life-v2", groupId: env.groupId, factKey: v1.factKey, value: "D7_REVOKED_FACT_CANARY", createdBySessionId: env.root, expectedPreviousFactId: v1.id });
    const linkAfterReplace = env.factStore.getFact({ factId: v1.id, viewerSessionId: env.root });
    const bidirectionalLink = linkAfterReplace.status === "SUPERSEDED"
      && linkAfterReplace.supersededById === v2.id
      && v2.supersedesId === linkAfterReplace.id
      && linkAfterReplace.contentHash === v1HashBefore
      && JSON.stringify(linkAfterReplace.value) === v1ValueBefore;
    const groupIndependent = publish(env, "foreign-life-v1", "policy.order", "independent", `foreign-life`, `foreign-root-life`).version === 1;
    const stateBeforeFailures = env.factStore.listFactVersions({ groupId: env.groupId, factKey: v1.factKey, viewerSessionId: env.root });
    const auditBeforeFailures = env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root });
    const expectedFailures = [
      () => env.factStore.replaceFact({ id: "life-v3-stale", groupId: env.groupId, factKey: v1.factKey, value: "x", createdBySessionId: env.root, expectedPreviousFactId: v1.id }),
      () => env.factStore.replaceFact({ id: v2.id, groupId: env.groupId, factKey: v1.factKey, value: "x", createdBySessionId: env.root, expectedPreviousFactId: v2.id }),
      () => env.factStore.replaceFact({ id: "life-v3-same", groupId: env.groupId, factKey: v1.factKey, value: "D7_REVOKED_FACT_CANARY", createdBySessionId: env.root, expectedPreviousFactId: v2.id }),
      () => env.factStore.replaceFact({ id: "life-v3-invalid", groupId: env.groupId, factKey: v1.factKey, value: undefined, createdBySessionId: env.root, expectedPreviousFactId: v2.id }),
    ];
    let allRejected = true;
    for (const operation of expectedFailures) { try { operation(); allRejected = false; } catch (error) { if (!(error instanceof GroupFactError)) allRejected = false; } }
    const unchanged = JSON.stringify(env.factStore.listFactVersions({ groupId: env.groupId, factKey: v1.factKey, viewerSessionId: env.root })) === JSON.stringify(stateBeforeFailures)
      && JSON.stringify(env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root })) === JSON.stringify(auditBeforeFailures);
    const list = env.factStore.listFactVersions({ groupId: env.groupId, factKey: v1.factKey, viewerSessionId: env.root });
    const versionsSorted = list.map(({ version }) => version).join(",") === "1,2";
    const activeOnce = env.factStore.listActiveFacts({ groupId: env.groupId, viewerSessionId: env.root }).filter(({ factKey }) => factKey === v1.factKey).length === 1;
    const firstCopy = list[0]; firstCopy.value.marker = "mutated";
    const deepCopyPreserved = env.factStore.getFact({ factId: v1.id, viewerSessionId: env.root }).value.marker === "D7_SUPERSEDED_FACT_CANARY";
    const audit = env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root });
    const noValueAudit = !JSON.stringify(audit).includes("D7_SUPERSEDED_FACT_CANARY") && !JSON.stringify(audit).includes("D7_REVOKED_FACT_CANARY") && audit.map(({ code }) => code).join(",") === "PUBLISHED,SUPERSEDED";
    const v2Revoked = env.factStore.revokeFact({ groupId: env.groupId, factKey: v1.factKey, revokedBySessionId: env.root, expectedActiveFactId: v2.id, reason: "OBSOLETE" });
    const v2ValueBeforeRepublish = JSON.stringify(v2Revoked.value);
    const v2HashBeforeRepublish = v2Revoked.contentHash;
    const noRollback = env.factStore.getActiveFact({ groupId: env.groupId, factKey: v1.factKey, viewerSessionId: env.root }) === undefined
      && env.factStore.getFact({ factId: v1.id, viewerSessionId: env.root }).status === "SUPERSEDED";
    const v3 = env.factStore.replaceFact({ id: "life-v3", groupId: env.groupId, factKey: v1.factKey, value: "reconfirmed", createdBySessionId: env.root, expectedPreviousFactId: v2.id });
    const v2AfterRepublish = env.factStore.getFact({ factId: v2.id, viewerSessionId: env.root });
    const oldRevokedUnchanged = v2AfterRepublish.status === "REVOKED"
      && v2AfterRepublish.revokedAt === v2Revoked.revokedAt
      && v2AfterRepublish.revokedBySessionId === v2Revoked.revokedBySessionId
      && v2AfterRepublish.revokeReason === v2Revoked.revokeReason
      && v2AfterRepublish.supersededById === null
      && v2AfterRepublish.contentHash === v2HashBeforeRepublish
      && JSON.stringify(v2AfterRepublish.value) === v2ValueBeforeRepublish;
    const lifecycleAudit = env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root });
    const cleanDiagnostics = !JSON.stringify(lifecycleAudit).includes("D7_SUPERSEDED_FACT_CANARY") && !JSON.stringify(lifecycleAudit).includes("D7_REVOKED_FACT_CANARY");
    assert(exactSchema, "FACT_SCHEMA_CHECK_FAILED");
    assert(stableHash, "CANONICAL_HASH_CHECK_FAILED");
    assert(v1.version === 1 && v1.status === "ACTIVE", "INITIAL_VERSION_CHECK_FAILED");
    assert(groupIndependent, "GROUP_KEY_ISOLATION_FAILED");
    assert(allRejected && unchanged, "ATOMIC_FAILURE_CHECK_FAILED");
    assert(versionsSorted && activeOnce && bidirectionalLink, "SINGLE_ACTIVE_OR_VERSION_CHAIN_FAILED");
    assert(deepCopyPreserved, "FACT_DEEP_COPY_FAILED");
    assert(noValueAudit, "VALUE_FREE_AUDIT_CHECK_FAILED");
    assert(noRollback && v2Revoked.status === "REVOKED", "REVOKE_NO_ROLLBACK_FAILED");
    assert(v3.version === 3 && v3.status === "ACTIVE" && oldRevokedUnchanged, "REPUBLISH_CHAIN_FAILED");
    assert(cleanDiagnostics, "CANARY_DIAGNOSTIC_CHECK_FAILED");
    return { stage: "lifecycle", code: "VERSION_CHAIN_AND_ATOMICITY", fields: { groupId: env.groupId, factId: v3.id, factKey: v3.factKey, version: v3.version, factStatus: v3.status, supersedesId: v3.supersedesId, supersededById: null, actorSessionId: env.root, reasonCode: "CAS_AND_REPUBLISH_VERIFIED" } };
  });

  await scenario("root-only-mutation", ["D7-H08"], () => {
    const env = environment("root");
    const first = publish(env, "root-v1", "root.policy", "safe");
    const before = env.factStore.listFactVersions({ groupId: env.groupId, factKey: first.factKey, viewerSessionId: env.root });
    const auditBefore = env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root });
    const deniedActors = [env.worker, env.peer, env.foreignRoot];
    let deniedReplaces = 0;
    let deniedPublishes = 0;
    for (const actor of deniedActors) {
      try { env.factStore.replaceFact({ id: `denied-replace-${actor}`, groupId: env.groupId, factKey: first.factKey, value: "D7_CROSS_GROUP_FACT_CANARY", createdBySessionId: actor, expectedPreviousFactId: first.id }); }
      catch (error) { if (error instanceof GroupFactError) deniedReplaces += 1; }
      try { env.factStore.publishFact({ id: `denied-publish-${actor}`, groupId: env.groupId, factKey: `denied.${actor}`, value: "D7_CROSS_GROUP_FACT_CANARY", createdBySessionId: actor }); }
      catch (error) { if (error instanceof GroupFactError) deniedPublishes += 1; }
    }
    const revokeDenied = (() => { try { env.factStore.revokeFact({ groupId: env.groupId, factKey: first.factKey, revokedBySessionId: env.worker, expectedActiveFactId: first.id, reason: "USER_REQUEST" }); return false; } catch (error) { return error instanceof GroupFactError; } })();
    assert(deniedReplaces === deniedActors.length && deniedPublishes === deniedActors.length && revokeDenied
      && env.factStore.listActiveFacts({ groupId: env.groupId, viewerSessionId: env.root }).length === 1
      && JSON.stringify(before) === JSON.stringify(env.factStore.listFactVersions({ groupId: env.groupId, factKey: first.factKey, viewerSessionId: env.root }))
      && JSON.stringify(auditBefore) === JSON.stringify(env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root })), "ROOT_ONLY_AUTHORITY_FAILED");
    return { stage: "authorization", code: "NON_ROOT_MUTATIONS_DENIED", fields: { groupId: env.groupId, factId: first.id, factKey: first.factKey, actorSessionId: env.worker, reasonCode: "ROOT_ONLY" } };
  });

  await scenario("group-read-boundary", ["D7-H09", "D7-H10"], () => {
    const env = environment("read");
    const local = publish(env, "read-local", "alpha.key", "local fact");
    publish(env, "read-zeta", "zeta.key", "z");
    const foreign = publish(env, "read-foreign", "alpha.key", "D7_CROSS_GROUP_FACT_CANARY", "foreign-read", "foreign-root-read");
    const sameGroupReadable = [env.root, env.worker, env.tester].every((viewer) => env.factStore.getFact({ factId: local.id, viewerSessionId: viewer }).value === "local fact");
    const before = env.factStore.listActiveFacts({ groupId: env.groupId, viewerSessionId: env.root });
    before[0].value = "tamper";
    const isolated = env.factStore.getActiveFact({ groupId: env.groupId, factKey: "alpha.key", viewerSessionId: env.root }).value === "local fact";
    const sorted = env.factStore.listActiveFacts({ groupId: env.groupId, viewerSessionId: env.root }).map(({ factKey }) => factKey).join(",") === "alpha.key,zeta.key";
    const denied = (() => { try { env.factStore.getFact({ factId: foreign.id, viewerSessionId: env.root }); return false; } catch (error) { return error instanceof GroupFactError && !error.message.includes("D7_CROSS_GROUP_FACT_CANARY"); } })();
    const audit = JSON.stringify(env.factStore.listAuditEvents({ groupId: env.groupId, viewerSessionId: env.root }));
    assert(sameGroupReadable && isolated && sorted && denied && !audit.includes("D7_CROSS_GROUP_FACT_CANARY"), "GROUP_READ_BOUNDARY_FAILED");
    return { stage: "read-boundary", code: "GROUP_READ_AND_AUDIT_SAFE", fields: { groupId: env.groupId, factId: local.id, factKey: local.factKey, actorSessionId: env.root, reasonCode: "CROSS_GROUP_DENIED" } };
  });

  await scenario("snapshot-isolation", ["D7-H11", "D7-H12", "D7-H13", "D7-H14"], () => {
    const env = environment("snap");
    const v1 = publish(env, "snap-v1", "shared.policy", { rule: "v1" });
    const a = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 128 });
    const v2 = env.factStore.replaceFact({ id: "snap-v2", groupId: env.groupId, factKey: v1.factKey, value: { rule: "v2" }, createdBySessionId: env.root, expectedPreviousFactId: v1.id });
    const b = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 128 });
    const c = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.tester, factTokenBudget: 128 });
    const pinnedA = env.snapshots.getSnapshot(a.id).facts[0];
    const refsComplete = a.factRefs.length === a.facts.length && a.factRefs[0].contentHash === v1.contentHash && a.budget.factCount === a.facts.length && a.budget.estimatedTokens <= a.budget.factTokenBudget;
    env.factStore.revokeFact({ groupId: env.groupId, factKey: v1.factKey, revokedBySessionId: env.root, expectedActiveFactId: v2.id, reason: "OBSOLETE" });
    const d = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 128 });
    const oldStable = env.snapshots.getSnapshot(a.id).facts[0].value.rule === "v1" && env.snapshots.getSnapshot(b.id).facts[0].value.rule === "v2" && env.snapshots.getSnapshot(c.id).facts[0].value.rule === "v2";
    const newEmpty = d.facts.length === 0 && d.budget.factCount === 0;
    assert(refsComplete && pinnedA.id === v1.id && b.facts[0].id === v2.id && c.facts[0].id === v2.id && oldStable && newEmpty, "SNAPSHOT_ISOLATION_FAILED");
    return { stage: "snapshot-lifecycle", code: "SNAPSHOT_VERSION_PINNED", fields: { groupId: env.groupId, factId: v2.id, factKey: v2.factKey, version: v2.version, factStatus: v2.status, snapshotId: c.id, targetSessionId: c.targetSessionId, factCount: c.budget.factCount, estimatedTokens: c.budget.estimatedTokens, factTokenBudget: c.budget.factTokenBudget, budgetGap: c.budget.budgetGap, activeSnapshotCount: env.snapshots.listActiveSnapshots().length } };
  });

  await scenario("fact-budget", ["D7-H15"], () => {
    const env = environment("budget");
    const value = "D7_BUDGET_FACT_CANARY";
    publish(env, "budget-v1", "budget.key", value);
    const successful = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 64 });
    const before = env.snapshots.listActiveSnapshots().length;
    let error;
    try { env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 1 }); } catch (caught) { error = caught; }
    const after = env.snapshots.listActiveSnapshots().length;
    assert(error instanceof FactSnapshotError && error.code === "FACT_BUDGET_EXCEEDED" && error.factCount === 1 && error.estimatedTokens > error.factTokenBudget && after === before && !error.message.includes(value) && !JSON.stringify(error).includes(value), "FACT_BUDGET_FAILURE_UNSAFE");
    return { stage: "budget", code: "BUDGET_OVERRUN_NO_PARTIAL_SNAPSHOT", fields: { groupId: env.groupId, factId: "budget-v1", factKey: "budget.key", snapshotId: successful.id, targetSessionId: successful.targetSessionId, factCount: error.factCount, estimatedTokens: error.estimatedTokens, factTokenBudget: error.factTokenBudget, budgetGap: error.budgetGap, activeSnapshotCount: after, errorCode: error.code } };
  });

  await scenario("pi-history-isolation", ["D7-H16"], () => {
    const env = environment("pi");
    const before = structuredClone(env.pi.getEntries());
    const v1 = publish(env, "pi-v1", "isolation.key", "v1");
    const a = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 128 });
    const v2 = env.factStore.replaceFact({ id: "pi-v2", groupId: env.groupId, factKey: v1.factKey, value: "v2", createdBySessionId: env.root, expectedPreviousFactId: v1.id });
    const b = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.tester, factTokenBudget: 128 });
    env.factStore.revokeFact({ groupId: env.groupId, factKey: v1.factKey, revokedBySessionId: env.root, expectedActiveFactId: v2.id, reason: "USER_REQUEST" });
    const c = env.snapshots.createSnapshot({ groupId: env.groupId, targetSessionId: env.worker, factTokenBudget: 128 });
    env.snapshots.releaseSnapshot(a.id);
    env.snapshots.releaseSnapshot(b.id);
    env.snapshots.releaseSnapshot(c.id);
    const after = env.pi.getEntries();
    assert(JSON.stringify(after) === JSON.stringify(before) && before.length === after.length, "PI_HISTORY_MUTATED");
    return { stage: "pi-history", code: "PI_HISTORY_UNCHANGED", fields: { groupId: env.groupId, factId: v2.id, factKey: v2.factKey, version: v2.version, piEntryCountBefore: before.length, piEntryCountAfter: after.length, activeSnapshotCount: env.snapshots.listActiveSnapshots().length, reasonCode: "OFFLINE_ZERO_MODEL_CALLS" } };
  });
}

try { await main(); }
catch (error) {
  executionError = true;
  const code = typeof error?.code === "string" ? error.code : "RUNNER_FAILED";
  const seq = log("runner", "top-level", "RUNNER_EXCEPTION", { errorCode: code }, "FAIL");
  for (const check of checks.filter((item) => item.status === "UNOBSERVED")) mark([check.id], seq, "FAIL", code);
  failureLocation ??= { scenario: "runner", stage: "top-level", code };
} finally {
  for (const check of checks) check.evidenceSequence = [...new Set(check.evidenceSequence)].sort((a, b) => a - b);
  const hasFail = checks.some(({ status }) => status === "FAIL");
  const allPass = checks.every(({ status }) => status === "PASS");
  let artifact = { schemaVersion: 1, createdAt: new Date().toISOString(), execution: { offline: true, modelCalls: 0, realSessionReads: 0 }, scenarios, records, checks, failureLocation, decision: hasFail ? "DAY7_FAILED" : allPass ? "DAY7_COMPLETE_GO_DAY8" : "DAY7_INCONCLUSIVE_RERUN", passed: allPass && !executionError };
  const serialized = JSON.stringify(artifact, null, 2);
  const unsafeKey = /"(?:value|payload|message|toolContent|stack)"\s*:/i.test(serialized);
  const credentialLike = /(?:sk-[A-Za-z0-9]{16,}|(?i:api[_-]?key)\s*[:=]\s*["'][^"']+|Bearer\s+[A-Za-z0-9._-]{16,})/i.test(serialized);
  if (CANARIES.some((canary) => serialized.includes(canary)) || unsafeKey || credentialLike) {
    const safeSequence = ++sequence;
    failureLocation = { scenario: "runner", stage: "artifact-scan", code: "ARTIFACT_SAFETY_SCAN_FAILED" };
    const safeChecks = checks.map((item) => ({ id: item.id, requirement: item.requirement, status: item.id === "D7-H16" ? "FAIL" : "UNOBSERVED", evidenceSequence: item.id === "D7-H16" ? [safeSequence] : [], ...(item.id === "D7-H16" ? { reasonCode: "ARTIFACT_SAFETY_SCAN_FAILED" } : {}) }));
    artifact = { schemaVersion: 1, createdAt: new Date().toISOString(), execution: { offline: true, modelCalls: 0, realSessionReads: 0 }, scenarios, records: [{ sequence: safeSequence, scenario: "runner", stage: "artifact-scan", code: "ARTIFACT_SAFETY_SCAN_FAILED", status: "FAIL", errorCode: "ARTIFACT_SAFETY_SCAN_FAILED" }], checks: safeChecks, failureLocation, decision: "DAY7_FAILED", passed: false };
  }
  finalArtifactPassed = artifact.passed === true;
  await mkdir(dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, JSON.stringify(artifact, null, 2), "utf8");
  console.log(JSON.stringify({ artifact: "artifacts/group-fact-store-spike.json", scenarios, records: artifact.records.length, checks: artifact.checks, decision: artifact.decision, failureLocation: artifact.failureLocation }, null, 2));
}
if (!finalArtifactPassed || executionError) process.exitCode = 1;
