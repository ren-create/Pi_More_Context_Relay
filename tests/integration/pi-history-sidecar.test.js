import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  extractExplicitContent,
  HistoryCatalog,
  HistoryIndexer,
  HistoryLoader,
  hashPiEntry,
  loadAuthorizedExplicitHistory,
} from "../../src/history-sidecar.js";
import { GroupTreeManager } from "../../src/group-tree.js";
import { DevelopmentRecordStore } from "../../src/record-store.js";
import { TaskManager } from "../../src/task-manager.js";

const makeEnvironment = (manager) => {
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: "group-a", name: "A", policyVersion: "p1", rootSession: { id: "root", piSessionRef: "pi-root", displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: "worker", groupId: "group-a", piSessionRef: manager.getSessionId(), displayRole: "worker", parentId: "root", status: "ACTIVE" });
  groupTree.addSession({ id: "child", groupId: "group-a", piSessionRef: "pi-child", displayRole: "child", parentId: "worker", status: "ACTIVE" });
  groupTree.addSession({ id: "peer", groupId: "group-a", piSessionRef: "pi-peer", displayRole: "peer", parentId: "root", status: "ACTIVE" });
  groupTree.createGroup({ id: "group-b", name: "B", policyVersion: "p1", rootSession: { id: "other", piSessionRef: "pi-other", displayRole: "root", status: "ACTIVE" } });
  const taskManager = new TaskManager({ groupTree });
  taskManager.createTask({ id: "task", groupId: "group-a", issuerSessionId: "root", assigneeSessionId: "worker", goal: "fixture", acceptanceCriteria: ["verified"] });
  const developmentRecordStore = new DevelopmentRecordStore({ groupTree, taskManager });
  const catalog = new HistoryCatalog();
  const indexer = new HistoryIndexer({ catalog, groupTree, taskManager, developmentRecordStore, createId: (() => { let n = 0; return () => `history-${++n}`; })() });
  return { groupTree, taskManager, developmentRecordStore, catalog, indexer };
};

const index = (manager, env, extra = {}) => env.indexer.reconcile({ sessionManager: manager, piSessionRef: manager.getSessionId(), groupId: "group-a", sourceSessionId: "worker", ...extra });

function makeMessages(manager) {
  const userId = manager.appendMessage({ role: "user", content: "synthetic user text" });
  const assistantId = manager.appendMessage({ role: "assistant", content: [
    { type: "text", text: "synthetic assistant text" },
    { type: "thinking", thinking: "D6_THINKING_CANARY" },
    { type: "toolCall", id: "tool-call-fixed-17", name: "fixture_tool", arguments: { value: "synthetic" } },
  ] });
  const toolId = manager.appendMessage({ role: "toolResult", toolCallId: "tool-call-fixed-17", toolName: "fixture_tool", content: [{ type: "text", text: "synthetic tool output" }], isError: false, details: "D6_TOOL_RESULT_CANARY", errorMessage: "not projected", usage: { totalTokens: 4 } });
  return { userId, assistantId, toolId };
}

describe("Pi 0.85.1 in-memory history sidecar integration", () => {
  it("uses actual SessionManager entries for incremental indexing, identity and whole-entry hashes", () => {
    const manager = SessionManager.inMemory();
    const { userId, assistantId, toolId } = makeMessages(manager);
    const env = makeEnvironment(manager);
    expect(manager.getSessionId()).toEqual(expect.any(String));
    expect(manager.getEntries().map(({ id }) => id)).toEqual([userId, assistantId, toolId]);
    expect(manager.getEntry(userId)).toMatchObject({ id: userId, type: "message", message: { role: "user" } });
    const first = index(manager, env);
    expect(first.createdDescriptorIds).toHaveLength(3);
    expect(env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: assistantId })).toMatchObject({ entryType: "MESSAGE", exposure: "WORK_RECORD" });
    expect(index(manager, env).createdDescriptorIds).toHaveLength(0);
    const nextId = manager.appendMessage({ role: "user", content: "incremental" });
    const delta = index(manager, env);
    expect(delta.createdDescriptorIds).toHaveLength(1);
    expect(env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: nextId })).toBeTruthy();
    expect(env.catalog.listDescriptors().every((item) => item.contentHash.startsWith("sha256:") && !("message" in item))).toBe(true);
  });

  it("tracks the current real Pi branch without getBranch and keeps abandoned descriptors only in catalog scope", () => {
    const manager = SessionManager.inMemory();
    const anchorId = manager.appendMessage({ role: "user", content: "synthetic shared anchor" });
    const abandonedId = manager.appendMessage({ role: "user", content: "D6_ABANDONED_BRANCH_CANARY" });
    const env = makeEnvironment(manager);
    const branchSpy = vi.spyOn(manager, "getBranch");
    index(manager, env);
    manager.branch(anchorId);
    const activeId = manager.appendMessage({ role: "user", content: "synthetic active branch" });
    index(manager, env);
    const topology = env.catalog.getSessionTopology(manager.getSessionId());
    const activeIds = env.catalog.listActiveBranchEntryIds(manager.getSessionId());
    const activeDescriptors = env.catalog.listActiveBranchDescriptors({ piSessionRef: manager.getSessionId() });
    expect(branchSpy).not.toHaveBeenCalled();
    expect(topology.nodes.every((node) => Object.keys(node).sort().join(",") === "piEntryId,piParentEntryId")).toBe(true);
    expect(env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: abandonedId })).toBeTruthy();
    expect(activeIds).toEqual([anchorId, activeId]);
    expect(activeDescriptors.map(({ piEntryId }) => piEntryId)).toEqual([anchorId, activeId]);
    expect(JSON.stringify({ topology, activeIds, activeDescriptors }).includes("D6_ABANDONED_BRANCH_CANARY")).toBe(false);
  });

  it("validates controlled exposure against DevelopmentRecordStore metadata and rejects late expansion", () => {
    const manager = SessionManager.inMemory();
    const entryId = manager.appendMessage({ role: "user", content: "controlled fixture" });
    const env = makeEnvironment(manager);
    const authority = env.developmentRecordStore.createRecord({ id: "directive", groupId: "group-a", taskId: "task", sourceSessionId: "root", type: "WORK_DIRECTIVE", exposure: "DESIGN_CONTEXT", payload: { body: "not returned" } });
    expect(env.developmentRecordStore.getDescriptor(authority.id)).not.toHaveProperty("payload");
    const override = { piEntryId: entryId, exposure: "DESIGN_CONTEXT", provenance: { kind: "TASK_DIRECTIVE", authorityRecordId: "directive" } };
    index(manager, env, { taskId: "task", exposureOverrides: [override] });
    expect(env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: entryId })).toMatchObject({ exposure: "DESIGN_CONTEXT", exposureSource: "TASK_DIRECTIVE", exposureAuthorityId: "directive" });
    const repeated = index(manager, env, { taskId: "task" });
    expect(repeated.conflicts).toEqual([]);
    expect(repeated.unchangedDescriptorIds).toHaveLength(1);
    expect(() => index(manager, env, { taskId: "task", exposureOverrides: [{ ...override, exposure: "GROUP_FACT" }] })).toThrow();
  });

  it("performs authorized-load against Pi and proves denied viewers cause zero session/getEntry reads", () => {
    const manager = SessionManager.inMemory();
    const userId = manager.appendMessage({ role: "user", content: "private worker history" });
    const env = makeEnvironment(manager);
    index(manager, env);
    const realGetEntry = manager.getEntry.bind(manager);
    const getEntrySpy = vi.fn((id) => realGetEntry(id));
    manager.getEntry = getEntrySpy;
    const resolveSessionManager = vi.fn(() => manager);
    const loader = new HistoryLoader({ catalog: env.catalog, resolveSessionManager });
    const denied = loadAuthorizedExplicitHistory({ viewerSessionId: "child", catalog: env.catalog, loader, groupTree: env.groupTree });
    expect(denied.extractedItems).toEqual([]);
    expect(resolveSessionManager).not.toHaveBeenCalled();
    expect(getEntrySpy).not.toHaveBeenCalled();
    const allowed = loadAuthorizedExplicitHistory({ viewerSessionId: "root", catalog: env.catalog, loader, groupTree: env.groupTree });
    expect(allowed.extractedItems[0].piEntryId).toBe(userId);
    expect(resolveSessionManager).toHaveBeenCalledTimes(1);
    expect(getEntrySpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed for corrupted hashes, revoked descriptors, unknown Pi entries, and metadata-only compaction", () => {
    const manager = SessionManager.inMemory();
    const userId = manager.appendMessage({ role: "user", content: "integrity fixture" });
    const env = makeEnvironment(manager);
    index(manager, env);
    const descriptor = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: userId });
    // A second isolated catalog lets the test present a stable but incorrect expected hash.
    const brokenCatalog = new HistoryCatalog();
    brokenCatalog.registerDescriptor({ ...descriptor, id: "bad-hash", contentHash: "sha256:" + "0".repeat(64) });
    const brokenLoader = new HistoryLoader({ catalog: brokenCatalog, resolveSessionManager: () => manager });
    expect(() => brokenLoader.loadAllowed({ allowedDescriptorIds: ["bad-hash"] })).toThrow(/integrity/i);
    const missingCatalog = new HistoryCatalog();
    missingCatalog.registerDescriptor({ ...descriptor, id: "missing-pi-entry", piEntryId: "not-a-real-entry" });
    expect(() => new HistoryLoader({ catalog: missingCatalog, resolveSessionManager: () => manager }).loadAllowed({ allowedDescriptorIds: ["missing-pi-entry"] })).toThrow(/unavailable/i);
    const driftCatalog = new HistoryCatalog();
    const driftedEntry = { ...manager.getEntry(userId), type: "custom" };
    driftCatalog.registerDescriptor({ ...descriptor, id: "type-drift", contentHash: hashPiEntry(driftedEntry) });
    const driftManager = { getSessionId: () => manager.getSessionId(), getEntry: () => driftedEntry };
    expect(() => new HistoryLoader({ catalog: driftCatalog, resolveSessionManager: () => driftManager }).loadAllowed({ allowedDescriptorIds: ["type-drift"] })).toThrow(/type changed/i);
    const revoked = env.catalog.revokeDescriptor({ descriptorId: descriptor.id, reason: "POLICY_REVOKED" });
    expect(() => new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => manager }).loadAllowed({ allowedDescriptorIds: [revoked.id] })).toThrow(/revoked/i);
    const compactId = manager.appendCompaction("D6_COMPACTION_SUMMARY_CANARY", userId, 123);
    index(manager, env);
    const compaction = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: compactId });
    const getEntrySpy = vi.spyOn(manager, "getEntry");
    expect(() => new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => manager }).loadAllowed({ allowedDescriptorIds: [compaction.id] })).toThrow(/metadata-only/i);
    expect(getEntrySpy).not.toHaveBeenCalled();
    expect(manager.getEntry("not-a-real-entry")).toBeUndefined();
  });

  it("keeps a real cross-group Pi canary outside authorized loader and extraction", () => {
    const managerA = SessionManager.inMemory(); managerA.appendMessage({ role: "user", content: "same group" });
    const managerB = SessionManager.inMemory(); const canaryId = managerB.appendMessage({ role: "user", content: "D6_CROSS_GROUP_SECRET_CANARY" });
    const env = makeEnvironment(managerA);
    index(managerA, env);
    const otherDescriptor = { id: "other-group-descriptor", piSessionRef: managerB.getSessionId(), piEntryId: canaryId, groupId: "group-b", sourceSessionId: "other", taskId: null, entryType: "MESSAGE", exposure: "WORK_RECORD", exposureSource: "DEFAULT", exposureAuthorityId: null, status: "ACTIVE", contentHash: hashPiEntry(managerB.getEntry(canaryId)), schemaVersion: 1, createdAt: new Date().toISOString(), revokedAt: null };
    env.catalog.registerDescriptor(otherDescriptor);
    const getEntrySpy = vi.spyOn(managerB, "getEntry");
    const resolveSessionManager = vi.fn((ref) => ref === managerA.getSessionId() ? managerA : managerB);
    const result = loadAuthorizedExplicitHistory({ viewerSessionId: "root", catalog: env.catalog, loader: new HistoryLoader({ catalog: env.catalog, resolveSessionManager }), groupTree: env.groupTree });
    expect(result.decisions.find((decision) => decision.recordId === otherDescriptor.id).reasonCode).toBe("DENY_CROSS_GROUP");
    expect(getEntrySpy).not.toHaveBeenCalled();
    expect(JSON.stringify({ decisions: result.decisions, descriptors: result.descriptors, extracted: result.extractedItems.map(({ piEntryId, entryType }) => ({ piEntryId, entryType })) })).not.toContain("D6_CROSS_GROUP_SECRET_CANARY");
  });

  it("extracts actual Pi assistant/toolResult entries with fixed toolCallId and omits sensitive blocks", () => {
    const manager = SessionManager.inMemory();
    const ids = makeMessages(manager);
    const env = makeEnvironment(manager); index(manager, env);
    const loader = new HistoryLoader({ catalog: env.catalog, resolveSessionManager: () => manager });
    const assistantDescriptor = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: ids.assistantId });
    const toolDescriptor = env.catalog.findDescriptor({ piSessionRef: manager.getSessionId(), piEntryId: ids.toolId });
    const assistant = extractExplicitContent(loader.loadAllowed({ allowedDescriptorIds: [assistantDescriptor.id] })[0]);
    const tool = extractExplicitContent(loader.loadAllowed({ allowedDescriptorIds: [toolDescriptor.id] })[0]);
    const toolCall = assistant.items.find((item) => item.type === "TOOL_CALL");
    const toolResult = tool.items.find((item) => item.type === "TOOL_RESULT");
    expect(toolCall.toolCallId).toBe("tool-call-fixed-17");
    expect(toolResult.toolCallId).toBe(toolCall.toolCallId);
    expect(assistant.omitted.thinkingBlockCount).toBe(1);
    expect(JSON.stringify([assistant, tool])).not.toMatch(/D6_THINKING_CANARY|D6_TOOL_RESULT_CANARY|errorMessage|usage|details/);
  });
});
