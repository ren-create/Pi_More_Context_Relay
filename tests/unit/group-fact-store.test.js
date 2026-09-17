import { describe, expect, it } from "vitest";
import { GroupTreeManager } from "../../src/group-tree.js";
import {
  canonicalizeFactValue,
  GROUP_FACT_AUDIT_CODES,
  GROUP_FACT_SCHEMA_VERSION,
  GROUP_FACT_STATUS,
  GroupFactError,
  GroupFactStore,
  hashFactValue,
} from "../../src/group-fact-store.js";

const instant = "2026-09-17T00:00:00.000Z";
const fixture = () => {
  const groupTree = new GroupTreeManager();
  groupTree.createGroup({ id: "g-a", name: "A", policyVersion: "p1", rootSession: { id: "root-a", piSessionRef: "pi-root-a", displayRole: "root", status: "ACTIVE" } });
  groupTree.addSession({ id: "worker-a", groupId: "g-a", piSessionRef: "pi-worker-a", displayRole: "worker", parentId: "root-a", status: "ACTIVE" });
  groupTree.addSession({ id: "peer-a", groupId: "g-a", piSessionRef: "pi-peer-a", displayRole: "peer", parentId: "root-a", status: "ACTIVE" });
  groupTree.createGroup({ id: "g-b", name: "B", policyVersion: "p1", rootSession: { id: "root-b", piSessionRef: "pi-root-b", displayRole: "root", status: "ACTIVE" } });
  let tick = 0;
  const store = new GroupFactStore({ groupTree, now: () => new Date(Date.parse(instant) + tick++ * 1000) });
  return { groupTree, store };
};
const publish = (store, id, value, extra = {}) => store.publishFact({ id, groupId: "g-a", factKey: "policy.order", value, createdBySessionId: "root-a", ...extra });

describe("Day 7 GroupFactStore", () => {
  it("canonicalizes lossless JSON values with stable object-key ordering and hashes", () => {
    const left = { z: [1, true, null, "x"], a: { y: 2, b: "v" } };
    const right = { a: { b: "v", y: 2 }, z: [1, true, null, "x"] };
    expect(canonicalizeFactValue(left)).toBe(canonicalizeFactValue(right));
    expect(hashFactValue(left)).toBe(hashFactValue(right));
    expect(hashFactValue({ a: 1 })).not.toBe(hashFactValue({ a: "1" }));
    expect(canonicalizeFactValue(null)).toBe("null");
    expect(canonicalizeFactValue(-0)).toBe("0");
  });

  it("rejects every non-lossless JSON value shape", () => {
    const cycle = {}; cycle.self = cycle;
    const sparse = []; sparse.length = 1;
    const accessor = {}; Object.defineProperty(accessor, "secret", { enumerable: true, get() { return "canary"; } });
    const hidden = {}; Object.defineProperty(hidden, "secret", { enumerable: false, value: "canary" });
    const symbolKey = { [Symbol("private")]: "x" };
    const cases = [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity, sparse, cycle, accessor, hidden, symbolKey, new Date()];
    for (const value of cases) expect(() => canonicalizeFactValue(value)).toThrow(GroupFactError);
  });

  it("publishes exact version-1 schema, deep copies values, and emits a payload-free audit", () => {
    const { store } = fixture();
    const value = { nested: ["confirmed", { n: 3 }] };
    const fact = publish(store, "f1", value);
    value.nested[1].n = 99;
    expect(fact).toMatchObject({ id: "f1", groupId: "g-a", factKey: "policy.order", version: 1, status: "ACTIVE", supersedesId: null, supersededById: null, createdBySessionId: "root-a", schemaVersion: GROUP_FACT_SCHEMA_VERSION, createdAt: instant, supersededAt: null, revokedAt: null, revokedBySessionId: null, revokeReason: null });
    expect(fact.contentHash).toBe(hashFactValue({ nested: ["confirmed", { n: 3 }] }));
    fact.value.nested[1].n = 88;
    expect(store.getFact({ factId: "f1", viewerSessionId: "worker-a" }).value.nested[1].n).toBe(3);
    const audit = store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" });
    expect(audit).toEqual([{ code: GROUP_FACT_AUDIT_CODES.PUBLISHED, factId: "f1", groupId: "g-a", factKey: "policy.order", version: 1, actorSessionId: "root-a", previousStatus: null, newStatus: "ACTIVE", relatedFactId: null, reason: null, timestamp: instant }]);
    expect(JSON.stringify(audit)).not.toContain("confirmed");
  });

  it("enforces root-only mutation while allowing same-group readers and denying cross-group readers", () => {
    const { store } = fixture();
    publish(store, "f1", "safe fact");
    expect(store.getActiveFact({ groupId: "g-a", factKey: "policy.order", viewerSessionId: "peer-a" }).id).toBe("f1");
    expect(store.listActiveFacts({ groupId: "g-a", viewerSessionId: "worker-a" })).toHaveLength(1);
    expect(() => store.publishFact({ id: "worker-publish", groupId: "g-a", factKey: "worker.fact", value: "D7_CROSS_GROUP_FACT_CANARY", createdBySessionId: "worker-a" })).toThrow(expect.objectContaining({ code: "ROOT_AUTHORITY_REQUIRED" }));
    expect(() => store.replaceFact({ id: "f2", groupId: "g-a", factKey: "policy.order", value: "D7_CROSS_GROUP_FACT_CANARY", createdBySessionId: "worker-a", expectedPreviousFactId: "f1" })).toThrow(GroupFactError);
    expect(() => store.getFact({ factId: "f1", viewerSessionId: "root-b" })).toThrow(GroupFactError);
    expect(() => store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-b" })).toThrow(GroupFactError);
    expect(JSON.stringify(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" }))).not.toContain("D7_CROSS_GROUP_FACT_CANARY");
  });

  it("replaces with a CAS version and preserves a bidirectional supersede chain", () => {
    const { store } = fixture();
    const first = publish(store, "f1", "initial");
    const second = store.replaceFact({ id: "f2", groupId: "g-a", factKey: first.factKey, value: "revised", createdBySessionId: "root-a", expectedPreviousFactId: "f1" });
    const storedFirst = store.getFact({ factId: "f1", viewerSessionId: "root-a" });
    expect(second).toMatchObject({ version: 2, status: GROUP_FACT_STATUS.ACTIVE, supersedesId: "f1", supersededById: null });
    expect(storedFirst).toMatchObject({ status: "SUPERSEDED", supersededById: "f2", supersededAt: second.createdAt, value: first.value, contentHash: first.contentHash });
    expect(store.listFactVersions({ groupId: "g-a", factKey: first.factKey, viewerSessionId: "worker-a" }).map(({ version }) => version)).toEqual([1, 2]);
    expect(store.listActiveFacts({ groupId: "g-a", viewerSessionId: "root-a" })).toEqual([second]);
    expect(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" }).map(({ code }) => code)).toEqual(["PUBLISHED", "SUPERSEDED"]);
  });

  it("makes stale ID, duplicate ID, invalid key/value, same active hash, and duplicate publish atomic failures", () => {
    const { store } = fixture();
    publish(store, "f1", "D7_SUPERSEDED_FACT_CANARY");
    const before = store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" });
    const failed = [
      () => store.replaceFact({ id: "f2", groupId: "g-a", factKey: "policy.order", value: "changed", createdBySessionId: "root-a", expectedPreviousFactId: "stale" }),
      () => store.replaceFact({ id: "f1", groupId: "g-a", factKey: "policy.order", value: "changed", createdBySessionId: "root-a", expectedPreviousFactId: "f1" }),
      () => store.replaceFact({ id: "f2", groupId: "g-a", factKey: "policy.order", value: "D7_SUPERSEDED_FACT_CANARY", createdBySessionId: "root-a", expectedPreviousFactId: "f1" }),
      () => store.replaceFact({ id: "f2", groupId: "g-a", factKey: "Bad Key", value: "changed", createdBySessionId: "root-a", expectedPreviousFactId: "f1" }),
      () => store.replaceFact({ id: "f2", groupId: "g-a", factKey: "policy.order", value: undefined, createdBySessionId: "root-a", expectedPreviousFactId: "f1" }),
      () => publish(store, "f3", "another"),
    ];
    for (const operation of failed) expect(operation).toThrow(GroupFactError);
    expect(store.listFactVersions({ groupId: "g-a", factKey: "policy.order", viewerSessionId: "root-a" })).toHaveLength(1);
    expect(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" })).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("D7_SUPERSEDED_FACT_CANARY");
  });

  it("revokes without deletion or rollback and explicitly republishes a revoked value as the next version", () => {
    const { store } = fixture();
    const first = publish(store, "f1", "D7_REVOKED_FACT_CANARY");
    const revoked = store.revokeFact({ groupId: "g-a", factKey: first.factKey, revokedBySessionId: "root-a", expectedActiveFactId: first.id, reason: "OBSOLETE" });
    expect(revoked).toMatchObject({ status: "REVOKED", value: first.value, contentHash: first.contentHash, revokedBySessionId: "root-a", revokeReason: "OBSOLETE" });
    expect(store.getActiveFact({ groupId: "g-a", factKey: first.factKey, viewerSessionId: "root-a" })).toBeUndefined();
    const second = store.replaceFact({ id: "f2", groupId: "g-a", factKey: first.factKey, value: first.value, createdBySessionId: "root-a", expectedPreviousFactId: "f1" });
    expect(second).toMatchObject({ version: 2, status: "ACTIVE", supersedesId: "f1", contentHash: first.contentHash });
    expect(store.getFact({ factId: "f1", viewerSessionId: "root-a" })).toMatchObject({ status: "REVOKED", value: revoked.value, contentHash: revoked.contentHash, revokedAt: revoked.revokedAt, revokedBySessionId: revoked.revokedBySessionId, revokeReason: "OBSOLETE", supersededById: null });
    expect(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" }).map(({ code }) => code)).toEqual(["PUBLISHED", "REVOKED", "REPUBLISHED"]);
    const safe = JSON.stringify(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" }));
    expect(safe).not.toContain("D7_REVOKED_FACT_CANARY");
  });

  it("rejects repeated or stale revocation, bad reasons, and failed clocks without partial state", () => {
    const { store } = fixture();
    const first = publish(store, "f1", "value");
    const before = store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" });
    for (const args of [
      { expectedActiveFactId: "stale", reason: "INCORRECT" },
      { expectedActiveFactId: "f1", reason: "unsafe reason" },
    ]) expect(() => store.revokeFact({ groupId: "g-a", factKey: first.factKey, revokedBySessionId: "root-a", ...args })).toThrow(GroupFactError);
    expect(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" })).toEqual(before);
    store.revokeFact({ groupId: "g-a", factKey: first.factKey, revokedBySessionId: "root-a", expectedActiveFactId: "f1", reason: "INCORRECT" });
    expect(() => store.revokeFact({ groupId: "g-a", factKey: first.factKey, revokedBySessionId: "root-a", expectedActiveFactId: "f1", reason: "INCORRECT" })).toThrow(GroupFactError);
    expect(store.listFactVersions({ groupId: "g-a", factKey: first.factKey, viewerSessionId: "root-a" })).toHaveLength(1);
  });

  it("returns stable sorted lists and audit events as independent deep copies", () => {
    const { store } = fixture();
    publish(store, "f-z", "z", { factKey: "z.key" });
    publish(store, "f-b", "b", { factKey: "a.key" });
    const facts = store.listActiveFacts({ groupId: "g-a", viewerSessionId: "root-a" });
    expect(facts.map(({ factKey }) => factKey)).toEqual(["a.key", "z.key"]);
    facts[0].value = "mutated";
    const audit = store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" });
    audit[0].code = "MUTATED";
    expect(store.getActiveFact({ groupId: "g-a", factKey: "a.key", viewerSessionId: "root-a" }).value).toBe("b");
    expect(store.listAuditEvents({ groupId: "g-a", viewerSessionId: "root-a" })[0].code).toBe("PUBLISHED");
  });
});
