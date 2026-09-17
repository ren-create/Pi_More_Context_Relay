import { describe, expect, it, vi } from "vitest";
import { GroupTreeManager } from "../../src/group-tree.js";
import { GroupFactStore } from "../../src/group-fact-store.js";
import { estimateFactTokens, FactSnapshotError, FactSnapshotManager, FACT_TOKEN_ESTIMATOR_VERSION } from "../../src/fact-snapshot.js";

const makeFixture = ({ estimateTokens, nextId } = {}) => {
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: "g1", name: "one", policyVersion: "p1", rootSession: { id: "root", piSessionRef: "pi-root", displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: "worker", groupId: "g1", piSessionRef: "pi-worker", displayRole: "worker", parentId: "root", status: "ACTIVE" });
  groupTree.addSession({ id: "tester", groupId: "g1", piSessionRef: "pi-tester", displayRole: "tester", parentId: "root", status: "ACTIVE" });
  groupTree.createGroup({ id: "g2", name: "two", policyVersion: "p1", rootSession: { id: "other-root", piSessionRef: "pi-other", displayRole: "root", status: "ACTIVE" } });
  const factStore = new GroupFactStore({ groupTree, now: () => new Date("2026-09-17T00:00:00.000Z") });
  let counter = 0;
  const manager = new FactSnapshotManager({ factStore, now: () => new Date("2026-09-17T00:00:01.000Z"), createId: nextId ?? (() => `snap-${++counter}`), ...(estimateTokens ? { estimateTokens } : {}) });
  return { groupTree, factStore, manager };
};
const pub = (factStore, id, factKey, value) => factStore.publishFact({ id, groupId: "g1", factKey, value, createdBySessionId: "root" });

describe("Day 7 fact snapshots", () => {
  it("estimates canonical JSON characters with an explicit deterministic heuristic", () => {
    const fact = { factKey: "a.key", version: 2, value: { z: true, a: "x" } };
    const expected = Math.ceil('{"factKey":"a.key","value":{"a":"x","z":true},"version":2}'.length / 4);
    expect(estimateFactTokens(fact)).toBe(expected);
    const { factStore, manager } = makeFixture();
    pub(factStore, "f1", "a.key", "value");
    expect(manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 100 }).budget.method).toBe(FACT_TOKEN_ESTIMATOR_VERSION);
  });

  it("creates sorted, body-complete snapshots with refs, budget metadata, and deep-copy getters", () => {
    const { factStore, manager } = makeFixture();
    pub(factStore, "z1", "z.key", { value: [1, 2] });
    pub(factStore, "a1", "a.key", "first");
    const snapshot = manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 500 });
    expect(snapshot.facts.map(({ factKey }) => factKey)).toEqual(["a.key", "z.key"]);
    expect(snapshot.factRefs.map(({ id, factKey, version }) => ({ id, factKey, version }))).toEqual([{ id: "a1", factKey: "a.key", version: 1 }, { id: "z1", factKey: "z.key", version: 1 }]);
    expect(snapshot.budget).toMatchObject({ method: FACT_TOKEN_ESTIMATOR_VERSION, factCount: 2, estimatedTokens: expect.any(Number), factTokenBudget: 500, budgetGap: expect.any(Number) });
    snapshot.facts[0].value = "modified";
    snapshot.factRefs[0].id = "modified";
    manager.getSnapshot(snapshot.id).budget.factCount = 77;
    expect(manager.getSnapshot(snapshot.id)).toEqual(expect.objectContaining({ facts: expect.arrayContaining([expect.objectContaining({ id: "a1", value: "first" })]), factRefs: expect.arrayContaining([expect.objectContaining({ id: "a1" })]), budget: expect.objectContaining({ factCount: 2 }) }));
    const listed = manager.listActiveSnapshots();
    listed[0].facts[0].value = "mutated list";
    expect(manager.getSnapshot(snapshot.id).facts[0].value).toBe("first");
  });

  it("fails cross-group or unknown targets before snapshot creation", () => {
    const { factStore, manager } = makeFixture();
    pub(factStore, "f1", "a.key", "safe");
    expect(() => manager.createSnapshot({ groupId: "g1", targetSessionId: "other-root", factTokenBudget: 10 })).toThrow(expect.objectContaining({ code: "SNAPSHOT_TARGET_INVALID" }));
    expect(() => manager.createSnapshot({ groupId: "missing", targetSessionId: "worker", factTokenBudget: 10 })).toThrow(FactSnapshotError);
    expect(manager.listActiveSnapshots()).toEqual([]);
  });

  it("rejects over-budget facts atomically and exposes only safe numeric evidence", () => {
    const createId = vi.fn(() => "must-not-be-created");
    const { factStore, manager } = makeFixture({ createId, estimateTokens: ({ value }) => value === "D7_BUDGET_FACT_CANARY" ? 9 : 2 });
    pub(factStore, "f1", "budget.key", "D7_BUDGET_FACT_CANARY");
    let caught;
    try { manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 4 }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(FactSnapshotError);
    expect(caught).toMatchObject({ code: "FACT_BUDGET_EXCEEDED", factCount: 1, estimatedTokens: 9, factTokenBudget: 4, budgetGap: 5 });
    expect(caught.message).not.toContain("D7_BUDGET_FACT_CANARY");
    expect(JSON.stringify(caught)).not.toContain("D7_BUDGET_FACT_CANARY");
    expect(createId).not.toHaveBeenCalled();
    expect(manager.listActiveSnapshots()).toEqual([]);
  });

  it("rejects invalid budgets and estimator results without storing partial snapshots", () => {
    const { factStore, manager } = makeFixture({ estimateTokens: () => -1 });
    pub(factStore, "f1", "a.key", "fact");
    for (const factTokenBudget of [-1, 1.2, Infinity]) expect(() => manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget })).toThrow(FactSnapshotError);
    expect(() => manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 10 })).toThrow(expect.objectContaining({ code: "FACT_ESTIMATOR_INVALID" }));
    expect(manager.listActiveSnapshots()).toEqual([]);
  });

  it("keeps snapshots isolated from later replace/revoke and fails closed after release", () => {
    const { factStore, manager } = makeFixture();
    pub(factStore, "f1", "a.key", "v1");
    const snapshot = manager.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 100 });
    factStore.replaceFact({ id: "f2", groupId: "g1", factKey: "a.key", value: "v2", createdBySessionId: "root", expectedPreviousFactId: "f1" });
    expect(manager.getSnapshot(snapshot.id).facts[0]).toMatchObject({ id: "f1", version: 1, status: "ACTIVE", value: "v1" });
    factStore.revokeFact({ groupId: "g1", factKey: "a.key", revokedBySessionId: "root", expectedActiveFactId: "f2", reason: "OBSOLETE" });
    expect(manager.getSnapshot(snapshot.id).facts[0].value).toBe("v1");
    manager.releaseSnapshot(snapshot.id);
    expect(() => manager.getSnapshot(snapshot.id)).toThrow(expect.objectContaining({ code: "SNAPSHOT_RELEASED" }));
    expect(() => manager.releaseSnapshot(snapshot.id)).toThrow(expect.objectContaining({ code: "SNAPSHOT_RELEASED" }));
    expect(manager.listActiveSnapshots()).toEqual([]);
    expect(() => manager.getSnapshot("unknown")).toThrow(expect.objectContaining({ code: "SNAPSHOT_NOT_FOUND" }));
  });
});
