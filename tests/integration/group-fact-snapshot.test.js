import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GroupTreeManager } from "../../src/group-tree.js";
import { GroupFactStore } from "../../src/group-fact-store.js";
import { FactSnapshotManager } from "../../src/fact-snapshot.js";

describe("GroupFact snapshots with Pi session isolation", () => {
  it("pins snapshot A, exposes v2 to next-run snapshots B/C, excludes revoked key from D, and never changes Pi entries", () => {
    const piSession = SessionManager.inMemory();
    piSession.appendMessage({ role: "user", content: "synthetic pre-existing Pi history" });
    const piEntriesBefore = structuredClone(piSession.getEntries());
    const groupTree = new GroupTreeManager();
    groupTree.createGroup({ id: "g1", name: "one", policyVersion: "p1", rootSession: { id: "root", piSessionRef: "pi-root", displayRole: "root", status: "ACTIVE" } });
    groupTree.addSession({ id: "worker", groupId: "g1", piSessionRef: "pi-worker", displayRole: "worker", parentId: "root", status: "ACTIVE" });
    groupTree.addSession({ id: "tester", groupId: "g1", piSessionRef: "pi-tester", displayRole: "tester", parentId: "root", status: "ACTIVE" });
    const factStore = new GroupFactStore({ groupTree, now: () => new Date("2026-09-17T00:00:00.000Z") });
    let snapshotNumber = 0;
    const snapshots = new FactSnapshotManager({ factStore, now: () => new Date("2026-09-17T00:00:01.000Z"), createId: () => `snapshot-${++snapshotNumber}` });

    const version1 = factStore.publishFact({ id: "fact-v1", groupId: "g1", factKey: "relay.policy", value: { rule: "v1" }, createdBySessionId: "root" });
    const snapshotA = snapshots.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 128 });
    const version2 = factStore.replaceFact({ id: "fact-v2", groupId: "g1", factKey: "relay.policy", value: { rule: "v2" }, createdBySessionId: "root", expectedPreviousFactId: version1.id });
    const snapshotB = snapshots.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 128 });
    const snapshotC = snapshots.createSnapshot({ groupId: "g1", targetSessionId: "tester", factTokenBudget: 128 });

    expect(snapshots.getSnapshot(snapshotA.id).facts).toMatchObject([{ id: "fact-v1", version: 1, value: { rule: "v1" } }]);
    expect(snapshots.getSnapshot(snapshotB.id).facts).toMatchObject([{ id: "fact-v2", version: 2, value: { rule: "v2" } }]);
    expect(snapshots.getSnapshot(snapshotC.id).facts).toMatchObject([{ id: "fact-v2", version: 2, value: { rule: "v2" } }]);

    factStore.revokeFact({ groupId: "g1", factKey: "relay.policy", revokedBySessionId: "root", expectedActiveFactId: version2.id, reason: "OBSOLETE" });
    const snapshotD = snapshots.createSnapshot({ groupId: "g1", targetSessionId: "worker", factTokenBudget: 128 });
    expect(snapshots.getSnapshot(snapshotD.id).facts).toEqual([]);
    expect(snapshots.getSnapshot(snapshotA.id).facts[0].value).toEqual({ rule: "v1" });
    expect(snapshots.getSnapshot(snapshotB.id).facts[0].value).toEqual({ rule: "v2" });
    expect(snapshots.getSnapshot(snapshotC.id).facts[0].value).toEqual({ rule: "v2" });

    for (const snapshot of [snapshotA, snapshotB, snapshotC, snapshotD]) snapshots.releaseSnapshot(snapshot.id);
    expect(piSession.getEntries()).toEqual(piEntriesBefore);
    expect(JSON.stringify(piSession.getEntries())).toBe(JSON.stringify(piEntriesBefore));
  });
});
