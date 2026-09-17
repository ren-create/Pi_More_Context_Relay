import { describe, expect, it, vi } from "vitest";
import {
  canonicalizePiEntry,
  extractExplicitContent,
  filterAuthorizedHistoryDescriptors,
  hashPiEntry,
  HistoryCatalog,
  HistoryIndexer,
  HistoryLoader,
  HistorySidecarError,
  loadAuthorizedExplicitHistory,
  toAuthorizationDescriptor,
} from "../../src/history-sidecar.js";
import { GroupTreeManager } from "../../src/group-tree.js";
import { DevelopmentRecordStore, RECORD_EXPOSURES } from "../../src/record-store.js";
import { TaskManager } from "../../src/task-manager.js";

const instant = "2026-09-17T00:00:00.000Z";
const fixedNow = () => new Date(instant);

function topology() {
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: "g1", name: "one", policyVersion: "p1", rootSession: { id: "root", piSessionRef: "pi-root", displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: "worker", groupId: "g1", piSessionRef: "pi-worker", displayRole: "worker", parentId: "root", status: "ACTIVE" });
  groupTree.addSession({ id: "child", groupId: "g1", piSessionRef: "pi-child", displayRole: "child", parentId: "worker", status: "ACTIVE" });
  groupTree.addSession({ id: "peer", groupId: "g1", piSessionRef: "pi-peer", displayRole: "peer", parentId: "root", status: "ACTIVE" });
  groupTree.createGroup({ id: "g2", name: "two", policyVersion: "p1", rootSession: { id: "other", piSessionRef: "pi-other", displayRole: "root", status: "ACTIVE" } });
  const taskManager = new TaskManager({ groupTree });
  taskManager.createTask({ id: "task", groupId: "g1", issuerSessionId: "root", assigneeSessionId: "worker", goal: "work", acceptanceCriteria: ["done"] });
  const developmentRecordStore = new DevelopmentRecordStore({ groupTree, taskManager, now: fixedNow });
  return { groupTree, taskManager, developmentRecordStore };
}

const message = (id, role = "user", content = `text-${id}`) => ({ id, type: "message", timestamp: instant, message: { role, content } });
const sessionManager = (piSessionRef, entries, leafId) => ({ getSessionId: () => piSessionRef, getEntries: () => entries, getLeafId: () => leafId === undefined ? entries.at(-1)?.id ?? null : leafId, getEntry: (id) => entries.find((entry) => entry.id === id) });

function indexerFixture({ entries = [message("e1")], piSessionRef = "pi-worker", groupId = "g1", sourceSessionId = "worker", taskId = null, createId } = {}) {
  const env = topology();
  const catalog = new HistoryCatalog({ now: fixedNow });
  let next = 0;
  const indexer = new HistoryIndexer({ ...env, catalog, now: fixedNow, createId: createId ?? (() => `d${++next}`) });
  const manager = sessionManager(piSessionRef, entries);
  const reconcile = (extra = {}) => indexer.reconcile({ sessionManager: manager, piSessionRef, groupId, sourceSessionId, taskId, ...extra });
  return { ...env, catalog, indexer, manager, reconcile };
}

function descriptor(overrides = {}) {
  return {
    id: "d1", piSessionRef: "pi-worker", piEntryId: "e1", groupId: "g1", sourceSessionId: "worker", taskId: null,
    entryType: "MESSAGE", exposure: RECORD_EXPOSURES.WORK_RECORD, exposureSource: "DEFAULT", exposureAuthorityId: null,
    status: "ACTIVE", contentHash: hashPiEntry(message("e1")), schemaVersion: 1, createdAt: instant, revokedAt: null, ...overrides,
  };
}

describe("Day 6 history sidecar", () => {
  it("validates and atomically replaces metadata-only topology across roots and unsupported nodes", () => {
    const catalog = new HistoryCatalog();
    const original = { piSessionRef: "pi", nodes: [{ piEntryId: "r", piParentEntryId: null }, { piEntryId: "middle", piParentEntryId: "r" }, { piEntryId: "leaf", piParentEntryId: "middle" }, { piEntryId: "other-root", piParentEntryId: null }], leafPiEntryId: "leaf" };
    catalog.replaceSessionTopology(original);
    expect(catalog.listActiveBranchEntryIds("pi")).toEqual(["r", "middle", "leaf"]);
    expect(catalog.getSessionTopology("pi")).toEqual(original);
    for (const invalid of [
      { ...original, nodes: [...original.nodes, { piEntryId: "leaf", piParentEntryId: null }] },
      { ...original, nodes: [{ piEntryId: "x", piParentEntryId: "missing" }] },
      { ...original, nodes: [{ piEntryId: "x", piParentEntryId: "y" }, { piEntryId: "y", piParentEntryId: "x" }] },
      { ...original, leafPiEntryId: "missing" },
      { ...original, nodes: [{ piEntryId: "r", piParentEntryId: null, message: "forbidden" }] },
    ]) expect(() => catalog.replaceSessionTopology(invalid)).toThrow(HistorySidecarError);
    expect(catalog.getSessionTopology("pi")).toEqual(original);
  });

  it("filters active-branch descriptors while retaining abandoned branch descriptors in the catalog", () => {
    const entries = [
      { ...message("root"), parentId: null },
      { id: "unsupported", type: "model_change", parentId: "root" },
      { ...message("old", "user", "old branch"), parentId: "unsupported" },
      { ...message("new", "user", "new branch"), parentId: "unsupported" },
    ];
    const f = indexerFixture({ entries });
    f.manager.getLeafId = () => "new";
    f.reconcile();
    expect(f.catalog.listDescriptors({ piSessionRef: "pi-worker" }).map(({ piEntryId }) => piEntryId)).toEqual(["root", "old", "new"]);
    expect(f.catalog.listActiveBranchEntryIds("pi-worker")).toEqual(["root", "unsupported", "new"]);
    expect(f.catalog.listActiveBranchDescriptors({ piSessionRef: "pi-worker" }).map(({ piEntryId }) => piEntryId)).toEqual(["root", "new"]);
    expect(JSON.stringify(f.catalog.getSessionTopology("pi-worker"))).not.toContain("old branch");
  });

  it("fails closed on unknown leaf, parent drift, and disappearance without replacing prior topology", () => {
    const f = indexerFixture({ entries: [{ ...message("root"), parentId: null }, { ...message("leaf"), parentId: "root" }] });
    f.manager.getLeafId = () => "leaf";
    f.reconcile();
    const saved = f.catalog.getSessionTopology("pi-worker");
    f.manager.getLeafId = () => "unknown";
    expect(() => f.reconcile()).toThrow(/leaf/i);
    f.manager.getLeafId = () => "leaf";
    f.manager.getEntries = () => [{ ...message("root"), parentId: null }, { ...message("leaf"), parentId: "changed" }];
    expect(f.reconcile().conflicts.map(({ reasonCode }) => reasonCode)).toContain("PARENT_DRIFT");
    f.manager.getEntries = () => [{ ...message("root"), parentId: null }];
    expect(f.reconcile().conflicts.map(({ reasonCode }) => reasonCode)).toContain("SEEN_ENTRY_DISAPPEARED");
    expect(f.catalog.getSessionTopology("pi-worker")).toEqual(saved);
  });
  it("canonicalizes full Pi entries deterministically and rejects lossy JSON values", () => {
    expect(canonicalizePiEntry({ z: 1, a: { y: true, x: null } })).toBe(canonicalizePiEntry({ a: { x: null, y: true }, z: 1 }));
    expect(hashPiEntry(message("e1", "user", "changed"))).not.toBe(hashPiEntry(message("e1")));
    const hole = []; hole.length = 1;
    expect(canonicalizePiEntry({ type: "compaction", details: undefined, usage: undefined, fromHook: undefined })).toBe('{"type":"compaction"}');
    for (const bad of [{ optional: undefined }, { type: "compaction", summary: "x", unexpected: undefined }, { x: [undefined] }, { x: hole }, { x: NaN }, { x: 1n }, { x: () => 1 }]) expect(() => canonicalizePiEntry(bad)).toThrow(HistorySidecarError);
    const cycle = {}; cycle.self = cycle;
    expect(() => canonicalizePiEntry(cycle)).toThrow(/cyclic/i);
  });

  it("catalog enforces uniqueness, deep copies, schema-only data, and safe idempotent revocation", () => {
    const catalog = new HistoryCatalog({ now: fixedNow });
    const original = descriptor();
    catalog.registerDescriptor(original);
    original.id = "mutated";
    const got = catalog.getDescriptor("d1"); got.groupId = "mutated";
    const listed = catalog.listDescriptors(); listed[0].sourceSessionId = "mutated";
    expect(catalog.getDescriptor("d1").groupId).toBe("g1");
    expect(() => catalog.registerDescriptor(descriptor({ id: "d2" }))).toThrow(/already indexed/i);
    expect(() => catalog.registerDescriptor(descriptor({ id: "d1", piEntryId: "e2" }))).toThrow(/already exists/i);
    expect(() => catalog.registerDescriptor({ ...descriptor({ id: "d3", piEntryId: "e3" }), text: "D6_CROSS_GROUP_SECRET_CANARY" })).toThrow();
    expect(() => catalog.registerDescriptor(descriptor({ id: "d3", piEntryId: "e3", contentHash: "D6_CROSS_GROUP_SECRET_CANARY" }))).toThrow();
    const symbolPayload = descriptor({ id: "d3", piEntryId: "e3" }); symbolPayload[Symbol("payload")] = "hidden";
    expect(() => catalog.registerDescriptor(symbolPayload)).toThrow();
    const hiddenPayload = descriptor({ id: "d3", piEntryId: "e3" }); Object.defineProperty(hiddenPayload, "hidden", { value: "private", enumerable: false });
    expect(() => catalog.registerDescriptor(hiddenPayload)).toThrow();
    expect(() => catalog.revokeDescriptor({ descriptorId: "d1", reason: "D6_TOOL_RESULT_CANARY" })).toThrow(HistorySidecarError);
    const revoked = catalog.revokeDescriptor({ descriptorId: "d1", reason: "POLICY_REVOKED" });
    expect(catalog.revokeDescriptor({ descriptorId: "d1", reason: "SOURCE_REMOVED" })).toEqual(revoked);
    expect(catalog.listAuditEvents()).toEqual([{ code: "DESCRIPTOR_REVOKED", descriptorId: "d1", piSessionRef: "pi-worker", piEntryId: "e1", reasonCode: "POLICY_REVOKED", timestamp: instant }]);
    expect(JSON.stringify(catalog.listAuditEvents())).not.toMatch(/CANARY|text-e1/);
  });

  it("reconciles eligible entries idempotently, indexes only incremental additions, and never replaces an old hash", () => {
    const first = message("e1");
    const fixture = indexerFixture({ entries: [first, { id: "skip", type: "custom", payload: "private" }, { id: "unknown-type", type: "D6_CROSS_GROUP_SECRET_CANARY", payload: "hidden" }] });
    const initial = fixture.reconcile();
    expect(initial.createdDescriptorIds).toEqual(["d1"]);
    expect(initial.skipped).toEqual([
      { piEntryId: "skip", piEntryType: "custom", reasonCode: "SKIPPED_UNSUPPORTED_ENTRY" },
      { piEntryId: "unknown-type", piEntryType: "unsupported", reasonCode: "SKIPPED_UNSUPPORTED_ENTRY" },
    ]);
    expect(JSON.stringify(initial)).not.toContain("D6_CROSS_GROUP_SECRET_CANARY");
    expect(fixture.catalog.getDescriptor("d1").exposure).toBe("WORK_RECORD");
    expect(fixture.reconcile().unchangedDescriptorIds).toEqual(["d1"]);
    fixture.manager.getEntries = () => [first, { id: "skip", type: "custom", payload: "private" }, { id: "unknown-type", type: "D6_CROSS_GROUP_SECRET_CANARY", payload: "hidden" }, message("e2")];
    expect(fixture.reconcile().createdDescriptorIds).toEqual(["d2"]);
    const frozenHash = fixture.catalog.getDescriptor("d1").contentHash;
    fixture.manager.getEntries = () => [message("e1", "user", "edited"), { id: "skip", type: "custom", payload: "private" }, { id: "unknown-type", type: "D6_CROSS_GROUP_SECRET_CANARY", payload: "hidden" }, message("e2")];
    expect(fixture.reconcile().conflicts[0].reasonCode).toBe("CONTENT_HASH_MISMATCH");
    expect(fixture.catalog.getDescriptor("d1").contentHash).toBe(frozenHash);
  });

  it("accepts only a first controlled DESIGN_CONTEXT override backed by a payload-free matching authority", () => {
    const entries = [message("directive")];
    const f = indexerFixture({ entries, taskId: "task" });
    f.developmentRecordStore.createRecord({ id: "auth", groupId: "g1", taskId: "task", sourceSessionId: "root", type: "WORK_DIRECTIVE", exposure: "DESIGN_CONTEXT", payload: { secret: "do not expose" } });
    const realGetDescriptor = f.developmentRecordStore.getDescriptor.bind(f.developmentRecordStore);
    const descriptorSpy = vi.fn((id) => realGetDescriptor(id));
    const safeStore = { getDescriptor: descriptorSpy };
    f.indexer.developmentRecordStore = safeStore;
    const override = { piEntryId: "directive", exposure: "DESIGN_CONTEXT", provenance: { kind: "TASK_DIRECTIVE", authorityRecordId: "auth" } };
    f.reconcile();
    const expanded = f.reconcile({ exposureOverrides: [override] });
    expect(expanded.conflicts[0].reasonCode).toBe("DESCRIPTOR_METADATA_MISMATCH");
    expect(f.catalog.findDescriptor({ piSessionRef: "pi-worker", piEntryId: "directive" }).exposure).toBe("WORK_RECORD");
    const firstOverride = indexerFixture({ entries, taskId: "task" });
    firstOverride.indexer.developmentRecordStore = safeStore;
    firstOverride.reconcile({ exposureOverrides: [override] });
    expect(descriptorSpy).toHaveBeenCalledTimes(2);
    const stored = firstOverride.catalog.findDescriptor({ piSessionRef: "pi-worker", piEntryId: "directive" });
    expect(stored).toMatchObject({ exposure: "DESIGN_CONTEXT", exposureSource: "TASK_DIRECTIVE", exposureAuthorityId: "auth" });
    expect(firstOverride.reconcile().unchangedDescriptorIds).toEqual([stored.id]);
    expect(JSON.stringify(stored)).not.toMatch(/do not expose|secret/);
    expect(() => f.reconcile({ exposureOverrides: [{ ...override, exposure: "GROUP_FACT" }] })).toThrow(HistorySidecarError);
  });

  it("rejects forged, mismatched, wrong-type, wrong-exposure, and unmatched authority overrides", () => {
    const f = indexerFixture({ entries: [message("directive")], taskId: "task" });
    const makeRecord = (id, fields) => f.developmentRecordStore.createRecord({ id, groupId: "g1", taskId: "task", sourceSessionId: "worker", type: "WORK_DIRECTIVE", exposure: "DESIGN_CONTEXT", payload: {}, ...fields });
    makeRecord("wrong-type", { type: "PLAN" }); makeRecord("wrong-exposure", { exposure: "WORK_RECORD" });
    const base = { piEntryId: "directive", exposure: "DESIGN_CONTEXT", provenance: { kind: "TASK_DIRECTIVE", authorityRecordId: "fake" } };
    expect(() => f.reconcile({ exposureOverrides: [base] })).toThrow(/authority/i);
    for (const authorityRecordId of ["wrong-type", "wrong-exposure"]) expect(() => f.reconcile({ exposureOverrides: [{ ...base, provenance: { ...base.provenance, authorityRecordId } }] })).toThrow(/authority/i);
    expect(() => f.reconcile({ exposureOverrides: [{ ...base, piEntryId: "not-present" }] })).toThrow(/override/i);
    expect(() => f.reconcile({ exposureOverrides: [base, base] })).toThrow(/duplicate/i);
    expect(() => f.reconcile({ exposureOverrides: [{ ...base, provenance: { ...base.provenance, kind: "AUTOMATIC" } }] })).toThrow();
  });

  it("rejects descriptors with non-canonical whitespace in identity metadata", () => {
    const catalog = new HistoryCatalog();
    for (const candidate of [
      descriptor({ id: " d1 " }),
      descriptor({ piSessionRef: " pi-worker " }),
      descriptor({ taskId: " task " }),
      descriptor({ exposure: "DESIGN_CONTEXT", exposureSource: "HANDOFF", exposureAuthorityId: " authority " }),
    ]) expect(() => catalog.registerDescriptor(candidate)).toThrow(HistorySidecarError);
  });

  it("adapts history through the existing authorization whitelist and preserves 5x3 decisions", () => {
    const { groupTree } = topology();
    const work = descriptor();
    const context = descriptor({ id: "d2", piEntryId: "e2", entryType: "TOOL_RESULT", exposure: "DESIGN_CONTEXT", exposureSource: "HANDOFF", exposureAuthorityId: "authority" });
    const publicFact = descriptor({ id: "d3", piEntryId: "e3", entryType: "COMPACTION", exposure: "GROUP_FACT", exposureSource: "DEFAULT", exposureAuthorityId: null });
    // GROUP_FACT cannot be indexed as history; this row is intentionally rejected by schema validation.
    expect(() => toAuthorizationDescriptor(publicFact)).toThrow();
    expect(Object.keys(toAuthorizationDescriptor(work)).sort()).toEqual(["contentHash", "createdAt", "exposure", "groupId", "recordId", "schemaVersion", "sourceRecordIds", "sourceSessionId", "taskId", "type"].sort());
    for (const [viewer, allowed] of [["worker", true], ["root", true], ["child", false], ["peer", false], ["other", false]]) {
      const result = filterAuthorizedHistoryDescriptors({ viewerSessionId: viewer, descriptors: [work, context], groupTree });
      expect(result.decisions).toHaveLength(2);
      expect(result.descriptors.some((item) => item.id === work.id)).toBe(allowed);
    }
    const revoked = { ...work, status: "REVOKED", revokedAt: instant };
    expect(filterAuthorizedHistoryDescriptors({ viewerSessionId: "root", descriptors: [revoked], groupTree }).decisions[0].reasonCode).toBe("DENY_REVOKED_DESCRIPTOR");
    expect(context.exposure).toBe(RECORD_EXPOSURES.DESIGN_CONTEXT);
  });

  it("authorizes before any Pi read; denied cross-group canary never enters safe output", () => {
    const catalog = new HistoryCatalog({ now: fixedNow });
    catalog.registerDescriptor(descriptor());
    catalog.registerDescriptor(descriptor({ id: "cross", piSessionRef: "pi-other", piEntryId: "cross-entry", groupId: "g2", sourceSessionId: "other" }));
    const resolveSessionManager = vi.fn((ref) => sessionManager(ref, [message("e1"), message("cross-entry", "user", "D6_CROSS_GROUP_SECRET_CANARY")]));
    const loader = new HistoryLoader({ catalog, resolveSessionManager });
    const result = loadAuthorizedExplicitHistory({ viewerSessionId: "root", catalog, loader, groupTree: topology().groupTree });
    expect(result.extractedItems).toHaveLength(1);
    expect(result.decisions.find((item) => item.recordId === "cross").reasonCode).toBe("DENY_CROSS_GROUP");
    expect(resolveSessionManager).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result: { ...result, extractedItems: [] } })).not.toContain("D6_CROSS_GROUP_SECRET_CANARY");
  });

  it("fails closed for missing, revoked, session mismatch, hash mismatch and type drift without partial batch output", () => {
    const f = indexerFixture({ entries: [message("e1"), message("e2")] }); f.reconcile();
    const resolve = vi.fn((ref) => sessionManager(ref, [message("e1"), message("e2")]));
    const loader = new HistoryLoader({ catalog: f.catalog, resolveSessionManager: resolve });
    const ids = f.catalog.listDescriptors().map((item) => item.id);
    expect(() => loader.loadAllowed({ allowedDescriptorIds: [ids[0], "missing"] })).toThrow(/not found/i);
    expect(() => loader.loadAllowed({ allowedDescriptorIds: [ids[0], ids[0]] })).toThrow(/unique/i);
    expect(() => new HistoryLoader({ catalog: f.catalog, resolveSessionManager: () => ({ getSessionId: () => "wrong", getEntry: () => message("e1") }) }).loadAllowed({ allowedDescriptorIds: [ids[0]] })).toThrow(/reference/i);
    expect(() => new HistoryLoader({ catalog: f.catalog, resolveSessionManager: () => sessionManager("pi-worker", [message("e1", "user", "changed"), message("e2")]) }).loadAllowed({ allowedDescriptorIds: ids })).toThrow(/integrity/i);
    expect(() => new HistoryLoader({ catalog: f.catalog, resolveSessionManager: () => sessionManager("pi-worker", [{ id: "e1", type: "compaction", summary: "D6_COMPACTION_SUMMARY_CANARY" }, message("e2")]) }).loadAllowed({ allowedDescriptorIds: ids })).toThrow(/integrity/i);
    f.catalog.revokeDescriptor({ descriptorId: ids[0], reason: "USER_REQUEST" });
    expect(() => loader.loadAllowed({ allowedDescriptorIds: [ids[0]] })).toThrow(/revoked/i);
  });

  it("splits compaction metadata before load and extracts only explicit safe blocks", () => {
    const entries = [
      { id: "compact", type: "compaction", timestamp: instant, summary: "D6_COMPACTION_SUMMARY_CANARY", tokensBefore: 99 },
      { id: "assistant", type: "message", timestamp: instant, message: { role: "assistant", content: [
        { type: "text", text: "visible" }, { type: "thinking", thinking: "D6_THINKING_CANARY" },
        { type: "image", data: "D6_TOOL_RESULT_CANARY" }, { type: "toolCall", id: "call-42", name: "lookup", arguments: { q: "safe" } },
        { type: "text", text: "discarded metadata" },
      ], usage: { input: 8 }, errorMessage: "must not surface" } },
      { id: "tool", type: "message", timestamp: instant, message: { role: "toolResult", toolCallId: "call-42", toolName: "lookup", isError: false, content: [{ type: "text", text: "tool output retained" }], details: "D6_TOOL_RESULT_CANARY", usage: { total: 9 }, errorMessage: "hidden" } },
    ];
    const f = indexerFixture({ entries }); f.reconcile();
    const readManager = sessionManager("pi-worker", entries);
    const resolver = vi.fn(() => readManager);
    const loader = new HistoryLoader({ catalog: f.catalog, resolveSessionManager: resolver });
    const result = loadAuthorizedExplicitHistory({ viewerSessionId: "worker", catalog: f.catalog, loader, groupTree: f.groupTree });
    expect(result.metadataOnlyDescriptors.map((item) => item.piEntryId)).toEqual(["compact"]);
    expect(resolver).toHaveBeenCalledTimes(2);
    const assistant = result.extractedItems.find((item) => item.piEntryId === "assistant");
    expect(assistant.items).toEqual([{ type: "TEXT", role: "assistant", text: "visible" }, { type: "TOOL_CALL", toolCallId: "call-42", toolName: "lookup", arguments: { q: "safe" } }, { type: "TEXT", role: "assistant", text: "discarded metadata" }]);
    const tool = result.extractedItems.find((item) => item.piEntryId === "tool");
    expect(tool.items).toEqual([{ type: "TOOL_RESULT", toolCallId: "call-42", toolName: "lookup", isError: false, text: "tool output retained" }]);
    expect(JSON.stringify({ decisions: result.decisions, metadata: result.metadataOnlyDescriptors, omitted: result.extractedItems.map(({ omitted }) => omitted) })).not.toMatch(/CANARY|errorMessage|usage|details/);
    expect(() => extractExplicitContent({ descriptor: f.catalog.findDescriptor({ piSessionRef: "pi-worker", piEntryId: "compact" }), entry: entries[0] })).toThrow(/metadata-only/i);
  });

  it("rejects non-JSON tool arguments without leaking their values", () => {
    const entry = { id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "x", arguments: { bad: undefined, canary: "D6_THINKING_CANARY" } }] } };
    const d = descriptor({ contentHash: hashPiEntry(message("e1", "assistant", [])) });
    expect(() => extractExplicitContent({ descriptor: d, entry })).toThrow(HistorySidecarError);
  });
});
