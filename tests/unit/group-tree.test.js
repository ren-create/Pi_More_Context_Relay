import { describe, expect, it } from "vitest";
import {
  GroupTreeManager,
  HISTORY_ACCESS,
  RELATIONSHIPS,
} from "../../src/group-tree.js";

const root = (id = "root") => ({ id, piSessionRef: `pi-${id}`, displayRole: "supervisor", status: "active" });
const makeTree = () => {
  const manager = new GroupTreeManager();
  manager.createGroup({ id: "g1", name: "demo", policyVersion: "v1", rootSession: root() });
  manager.addSession({ id: "a", groupId: "g1", piSessionRef: "pi-a", displayRole: "worker", status: "active", parentId: "root" });
  manager.addSession({ id: "b", groupId: "g1", piSessionRef: "pi-b", displayRole: "tester", status: "active", parentId: "root" });
  manager.addSession({ id: "a1", groupId: "g1", piSessionRef: "pi-a1", displayRole: "subworker", status: "active", parentId: "a" });
  manager.addSession({ id: "a2", groupId: "g1", piSessionRef: "pi-a2", displayRole: "subworker", status: "active", parentId: "a" });
  return manager;
};

describe("GroupTreeManager", () => {
  it("creates exactly one root and supports bidirectional tree lookup", () => {
    const manager = makeTree();
    expect(manager.getGroup("g1").rootSessionId).toBe("root");
    expect(manager.getParent("root")).toBeNull();
    expect(manager.getChildren("root").map((n) => n.id)).toEqual(["a", "b"]);
    expect(manager.getParent("a").id).toBe("root");
    expect(manager.getChildren("a").map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(manager.getAncestors("a2").map((n) => n.id)).toEqual(["a", "root"]);
    expect(manager.getDescendants("root").map((n) => n.id)).toEqual(["a", "a1", "a2", "b"]);
  });

  it.each([
    ["self", "root", "root", RELATIONSHIPS.SELF, makeTree],
    ["superior", "root", "a1", RELATIONSHIPS.SUPERIOR, makeTree],
    ["subordinate", "a1", "root", RELATIONSHIPS.SUBORDINATE, makeTree],
    ["peer", "a1", "b", RELATIONSHIPS.PEER, makeTree],
    ["unrelated", "a", "other", RELATIONSHIPS.UNRELATED, () => {
      const manager = makeTree();
      manager.createGroup({ id: "g2", name: "other", policyVersion: "v1", rootSession: root("other") });
      return manager;
    }],
  ])("resolves %s relationship", (_name, reader, source, expected, managerFactory) => {
    expect(managerFactory().resolveRelationship(reader, source)).toBe(expected);
  });

  it.each([
    ["root", "a1", HISTORY_ACCESS.FULL_EXPLICIT_HISTORY, "ALLOW_ANCESTOR"],
    ["a1", "a1", HISTORY_ACCESS.FULL_EXPLICIT_HISTORY, "ALLOW_SELF"],
    ["a1", "root", HISTORY_ACCESS.DESIGN_CONTEXT_AND_GROUP_FACT, "ALLOW_DESCENDANT_CONTEXT"],
    ["a1", "b", HISTORY_ACCESS.GROUP_FACT_ONLY, "ALLOW_GROUP_FACT_ONLY"],
  ])("resolves history access %s -> %s", (viewer, owner, access, reasonCode) => {
    expect(makeTree().resolveHistoryAccess(viewer, owner)).toMatchObject({ access, reasonCode });
  });

  it("denies cross-group history", () => {
    const manager = makeTree();
    manager.createGroup({ id: "g2", name: "other", policyVersion: "v1", rootSession: root("other") });
    expect(manager.resolveHistoryAccess("a", "other")).toMatchObject({ access: HISTORY_ACCESS.DENIED, reasonCode: "DENY_CROSS_GROUP" });
  });

  it.each([
    ["second group", () => makeTree().createGroup({ id: "g1", name: "again", policyVersion: "v1", rootSession: root("x") }), "GROUP_ALREADY_EXISTS"],
    ["unknown parent", () => makeTree().addSession({ id: "x", groupId: "g1", piSessionRef: "pi-x", displayRole: "worker", status: "active", parentId: "missing" }), "SESSION_NOT_FOUND"],
    ["second root", () => makeTree().addSession({ id: "x", groupId: "g1", piSessionRef: "pi-x", displayRole: "worker", status: "active", parentId: null }), "ROOT_SESSION_REQUIRED"],
    ["cross-group parent", () => { const m = makeTree(); m.createGroup({ id: "g2", name: "other", policyVersion: "v1", rootSession: root("other") }); return m.addSession({ id: "x", groupId: "g1", piSessionRef: "pi-x", displayRole: "worker", status: "active", parentId: "other" }); }, "PARENT_GROUP_MISMATCH"],
    ["duplicate node", () => makeTree().addSession({ id: "a", groupId: "g1", piSessionRef: "pi-new", displayRole: "worker", status: "active", parentId: "root" }), "SESSION_ALREADY_EXISTS"],
    ["duplicate Pi ref", () => makeTree().addSession({ id: "x", groupId: "g1", piSessionRef: "pi-a", displayRole: "worker", status: "active", parentId: "root" }), "PI_SESSION_ALREADY_REGISTERED"],
  ])("rejects %s", (_name, action, code) => expect(action).toThrowError(expect.objectContaining({ code })));

  it("is strict for ancestry and returns defensive snapshots", () => {
    const manager = makeTree();
    expect(manager.isAncestor("a", "a")).toBe(false);
    const node = manager.getSession("a"); node.displayRole = "changed";
    expect(manager.getSession("a").displayRole).toBe("worker");
    const children = manager.getChildren("root"); children[0].id = "mutated";
    expect(manager.getChildren("root")[0].id).toBe("a");
  });

  it("uses tree topology rather than misleading display roles", () => {
    const manager = new GroupTreeManager();
    manager.createGroup({ id: "g1", name: "demo", policyVersion: "v1", rootSession: { ...root("misleading-root"), displayRole: "worker" } });
    manager.addSession({ id: "misleading-child", groupId: "g1", piSessionRef: "pi-child", displayRole: "supervisor", status: "active", parentId: "misleading-root" });
    expect(manager.resolveRelationship("misleading-root", "misleading-child")).toBe(RELATIONSHIPS.SUPERIOR);
    expect(manager.resolveHistoryAccess("misleading-root", "misleading-child").access).toBe(HISTORY_ACCESS.FULL_EXPLICIT_HISTORY);
    expect(manager.resolveRelationship("misleading-child", "misleading-root")).toBe(RELATIONSHIPS.SUBORDINATE);
  });
});
