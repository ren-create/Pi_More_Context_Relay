import { RELATIONSHIPS } from "./group-tree.js";

export const TASK_STATUS = Object.freeze({
  PENDING: "PENDING", IN_PROGRESS: "IN_PROGRESS", COMPLETED: "COMPLETED", FAILED: "FAILED",
});

export class TaskError extends Error {
  constructor(code, message) { super(message); this.name = "TaskError"; this.code = code; }
}

const text = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") throw new TaskError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  return value.trim();
};
const copy = (value) => structuredClone(value);

export class TaskManager {
  #tasks = new Map();
  constructor({ groupTree } = {}) {
    if (!groupTree || typeof groupTree.getGroup !== "function") throw new TaskError("INVALID_ARGUMENT", "groupTree is required");
    this.groupTree = groupTree;
  }
  createTask({ id, groupId, issuerSessionId, assigneeSessionId, goal, acceptanceCriteria } = {}) {
    id = text(id, "id"); groupId = text(groupId, "groupId"); issuerSessionId = text(issuerSessionId, "issuerSessionId"); assigneeSessionId = text(assigneeSessionId, "assigneeSessionId"); goal = text(goal, "goal");
    if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length < 1 || acceptanceCriteria.some((item) => typeof item !== "string" || item.trim() === "")) throw new TaskError("INVALID_ARGUMENT", "acceptanceCriteria must contain at least one non-empty string");
    if (this.#tasks.has(id)) throw new TaskError("TASK_ALREADY_EXISTS", `task ${id} already exists`);
    try { this.groupTree.getGroup(groupId); const issuer = this.groupTree.getSession(issuerSessionId); const assignee = this.groupTree.getSession(assigneeSessionId); if (issuer.groupId !== groupId || assignee.groupId !== groupId) throw new TaskError("INVALID_TASK_ASSIGNMENT", "sessions must belong to task group"); const relation = this.groupTree.resolveRelationship(issuerSessionId, assigneeSessionId); if (![RELATIONSHIPS.SELF, RELATIONSHIPS.SUPERIOR].includes(relation)) throw new TaskError("INVALID_TASK_ASSIGNMENT", "issuer must be assignee or an ancestor"); }
    catch (error) { if (error instanceof TaskError) throw error; throw new TaskError("INVALID_TASK_ASSIGNMENT", "task sessions are invalid"); }
    const task = { id, groupId, issuerSessionId, assigneeSessionId, goal, acceptanceCriteria: acceptanceCriteria.map((item) => item.trim()), status: TASK_STATUS.PENDING };
    this.#tasks.set(id, task); return copy(task);
  }
  getTask(taskId) { const id = text(taskId, "taskId"); const task = this.#tasks.get(id); if (!task) throw new TaskError("TASK_NOT_FOUND", `task ${id} not found`); return copy(task); }
  listTasks(groupId) { groupId = text(groupId, "groupId"); try { this.groupTree.getGroup(groupId); } catch { throw new TaskError("INVALID_ARGUMENT", `group ${groupId} is invalid`); } return copy([...this.#tasks.values()].filter((task) => task.groupId === groupId)); }
  listAssignedTasks(sessionId) { sessionId = text(sessionId, "sessionId"); try { this.groupTree.getSession(sessionId); } catch { throw new TaskError("INVALID_ARGUMENT", `session ${sessionId} is invalid`); } return copy([...this.#tasks.values()].filter((task) => task.assigneeSessionId === sessionId)); }
  transitionTask(taskId, nextStatus) {
    const task = this.getTask(taskId); nextStatus = text(nextStatus, "nextStatus");
    if (!Object.values(TASK_STATUS).includes(nextStatus)) throw new TaskError("INVALID_TASK_TRANSITION", `invalid task status ${nextStatus}`);
    const valid = { PENDING: ["IN_PROGRESS"], IN_PROGRESS: ["COMPLETED", "FAILED"], COMPLETED: [], FAILED: [] };
    if (!valid[task.status].includes(nextStatus)) throw new TaskError("INVALID_TASK_TRANSITION", `cannot transition task ${task.id}`);
    task.status = nextStatus; this.#tasks.set(task.id, task); return copy(task);
  }
}
