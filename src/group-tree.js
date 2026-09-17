/**
 * In-memory group/session topology for the first Day 3-4 vertical slice.
 * This module deliberately has no Pi, persistence, or record dependencies.
 */

export const RELATIONSHIPS = Object.freeze({
  SELF: "SELF",
  SUPERIOR: "SUPERIOR",
  SUBORDINATE: "SUBORDINATE",
  PEER: "PEER",
  UNRELATED: "UNRELATED",
});

export const HISTORY_ACCESS = Object.freeze({
  FULL_EXPLICIT_HISTORY: "FULL_EXPLICIT_HISTORY",
  DESIGN_CONTEXT_AND_GROUP_FACT: "DESIGN_CONTEXT_AND_GROUP_FACT",
  GROUP_FACT_ONLY: "GROUP_FACT_ONLY",
  DENIED: "DENIED",
});

export class GroupTreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GroupTreeError";
    this.code = code;
  }
}

const nonEmpty = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GroupTreeError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value.trim();
};

const snapshot = (value) => structuredClone(value);

export class GroupTreeManager {
  #groups = new Map();
  #sessions = new Map();
  #children = new Map();
  #piRefs = new Map();

  createGroup({ id, name, policyVersion, rootSession } = {}) {
    id = nonEmpty(id, "id");
    name = nonEmpty(name, "name");
    policyVersion = nonEmpty(policyVersion, "policyVersion");
    if (!rootSession || typeof rootSession !== "object") {
      throw new GroupTreeError("ROOT_SESSION_REQUIRED", "rootSession is required");
    }
    if (this.#groups.has(id)) throw new GroupTreeError("GROUP_ALREADY_EXISTS", `group ${id} already exists`);
    const root = this.#normalizeSession({ ...rootSession, groupId: id, parentId: null });
    if (this.#sessions.has(root.id)) throw new GroupTreeError("SESSION_ALREADY_EXISTS", `session ${root.id} already exists`);
    if (this.#piRefs.has(root.piSessionRef)) throw new GroupTreeError("PI_SESSION_ALREADY_REGISTERED", `pi session ${root.piSessionRef} already registered`);
    const group = { id, name, rootSessionId: root.id, policyVersion };
    this.#groups.set(id, group);
    this.#sessions.set(root.id, root);
    this.#children.set(root.id, []);
    this.#piRefs.set(root.piSessionRef, root.id);
    return { group: snapshot(group), rootSession: snapshot(root) };
  }

  getGroup(groupId) {
    const id = nonEmpty(groupId, "groupId");
    const group = this.#groups.get(id);
    if (!group) throw new GroupTreeError("GROUP_NOT_FOUND", `group ${id} not found`);
    return snapshot(group);
  }

  listGroups() { return snapshot([...this.#groups.values()]); }

  addSession({ id, groupId, piSessionRef, displayRole, parentId, status } = {}) {
    id = nonEmpty(id, "id"); groupId = nonEmpty(groupId, "groupId");
    if (this.#sessions.has(id)) throw new GroupTreeError("SESSION_ALREADY_EXISTS", `session ${id} already exists`);
    if (this.#piRefs.has(nonEmpty(piSessionRef, "piSessionRef"))) throw new GroupTreeError("PI_SESSION_ALREADY_REGISTERED", `pi session ${piSessionRef} already registered`);
    this.getGroup(groupId);
    if (parentId === null || parentId === undefined || String(parentId).trim() === "") {
      throw new GroupTreeError("ROOT_SESSION_REQUIRED", "only createGroup may create a root session");
    }
    parentId = nonEmpty(parentId, "parentId");
    const parent = this.#sessions.get(parentId);
    if (!parent) throw new GroupTreeError("SESSION_NOT_FOUND", `parent session ${parentId} not found`);
    if (parent.groupId !== groupId) throw new GroupTreeError("PARENT_GROUP_MISMATCH", `parent ${parentId} belongs to another group`);
    const node = this.#normalizeSession({ id, groupId, piSessionRef, displayRole, parentId, status });
    this.#sessions.set(id, node); this.#children.set(id, []); this.#children.get(parentId).push(id); this.#piRefs.set(node.piSessionRef, id);
    return snapshot(node);
  }

  getSession(sessionId) { return snapshot(this.#getSession(sessionId)); }

  listSessions(groupId) {
    const id = nonEmpty(groupId, "groupId"); this.getGroup(id);
    return snapshot([...this.#sessions.values()].filter((node) => node.groupId === id));
  }

  getParent(sessionId) {
    const node = this.#getSession(sessionId); return node.parentId === null ? null : snapshot(this.#getSession(node.parentId));
  }

  getChildren(sessionId) { const node = this.#getSession(sessionId); return snapshot(this.#children.get(node.id).map((id) => this.#getSession(id))); }

  getAncestors(sessionId) {
    const result = []; let parentId = this.#getSession(sessionId).parentId;
    while (parentId !== null) { const parent = this.#getSession(parentId); result.push(parent); parentId = parent.parentId; }
    return snapshot(result);
  }

  getDescendants(sessionId) {
    const result = []; const visit = (id) => { for (const childId of this.#children.get(id)) { result.push(this.#getSession(childId)); visit(childId); } };
    visit(this.#getSession(sessionId).id); return snapshot(result);
  }

  isAncestor(ancestorSessionId, descendantSessionId) {
    const ancestor = this.#getSession(ancestorSessionId); let parentId = this.#getSession(descendantSessionId).parentId;
    while (parentId !== null) { if (parentId === ancestor.id) return true; parentId = this.#getSession(parentId).parentId; }
    return false;
  }

  resolveRelationship(readerSessionId, sourceSessionId) {
    const reader = this.#getSession(readerSessionId); const source = this.#getSession(sourceSessionId);
    if (reader.id === source.id) return RELATIONSHIPS.SELF;
    if (reader.groupId !== source.groupId) return RELATIONSHIPS.UNRELATED;
    if (this.isAncestor(reader.id, source.id)) return RELATIONSHIPS.SUPERIOR;
    if (this.isAncestor(source.id, reader.id)) return RELATIONSHIPS.SUBORDINATE;
    return RELATIONSHIPS.PEER;
  }

  resolveHistoryAccess(viewerSessionId, ownerSessionId) {
    const relationship = this.resolveRelationship(viewerSessionId, ownerSessionId);
    if (relationship === RELATIONSHIPS.SELF) return { access: HISTORY_ACCESS.FULL_EXPLICIT_HISTORY, relationship, reasonCode: "ALLOW_SELF" };
    if (relationship === RELATIONSHIPS.SUPERIOR) return { access: HISTORY_ACCESS.FULL_EXPLICIT_HISTORY, relationship, reasonCode: "ALLOW_ANCESTOR" };
    if (relationship === RELATIONSHIPS.UNRELATED) return { access: HISTORY_ACCESS.DENIED, relationship, reasonCode: "DENY_CROSS_GROUP" };
    if (relationship === RELATIONSHIPS.SUBORDINATE) {
      return { access: HISTORY_ACCESS.DESIGN_CONTEXT_AND_GROUP_FACT, relationship, reasonCode: "ALLOW_DESCENDANT_CONTEXT" };
    }
    return { access: HISTORY_ACCESS.GROUP_FACT_ONLY, relationship, reasonCode: "ALLOW_GROUP_FACT_ONLY" };
  }

  #getSession(sessionId) { const id = nonEmpty(sessionId, "sessionId"); const node = this.#sessions.get(id); if (!node) throw new GroupTreeError("SESSION_NOT_FOUND", `session ${id} not found`); return node; }

  #normalizeSession({ id, groupId, piSessionRef, displayRole, parentId, status } = {}) {
    return { id: nonEmpty(id, "id"), groupId: nonEmpty(groupId, "groupId"), piSessionRef: nonEmpty(piSessionRef, "piSessionRef"), displayRole: nonEmpty(displayRole, "displayRole"), parentId: parentId === null ? null : nonEmpty(parentId, "parentId"), status: nonEmpty(status, "status") };
  }
}
