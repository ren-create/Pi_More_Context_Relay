import { describe, expect, it } from "vitest";

import { authorizeRecordDescriptor, filterAuthorizedDescriptors } from "../../src/authorization.js";
import { GroupTreeManager } from "../../src/group-tree.js";
import {
  DevelopmentRecordStore,
  RECORD_EXPOSURES,
} from "../../src/record-store.js";
import { TaskManager, TASK_STATUS } from "../../src/task-manager.js";

const PRIVATE_CANARY = "PRIVATE_CANARY_A_7F31";

function setup() {
  const groupTree = new GroupTreeManager();
  const node = (id, parentId = null) => ({
    id,
    piSessionRef: `pi-${id}`,
    displayRole: "role",
    status: "active",
    ...(parentId === null ? {} : { parentId }),
  });

  groupTree.createGroup({
    id: "g1",
    name: "one",
    policyVersion: "v1",
    rootSession: node("root"),
  });
  for (const [id, parentId] of [
    ["a", "root"],
    ["b", "root"],
    ["a1", "a"],
  ]) {
    groupTree.addSession({ ...node(id, parentId), groupId: "g1" });
  }
  groupTree.createGroup({
    id: "g2",
    name: "two",
    policyVersion: "v1",
    rootSession: node("other"),
  });

  const taskManager = new TaskManager({ groupTree });
  taskManager.createTask({
    id: "t1",
    groupId: "g1",
    issuerSessionId: "root",
    assigneeSessionId: "a",
    goal: "implement",
    acceptanceCriteria: ["works"],
  });
  const store = new DevelopmentRecordStore({
    groupTree,
    taskManager,
    now: () => "2026-09-15T00:00:00.000Z",
  });
  return { groupTree, taskManager, store };
}

function createRecord(store, overrides = {}) {
  return store.createRecord({
    id: "r1",
    groupId: "g1",
    taskId: "t1",
    sourceSessionId: "a",
    type: "IMPLEMENTATION_REPORT",
    exposure: RECORD_EXPOSURES.WORK_RECORD,
    payload: { status: "done" },
    ...overrides,
  });
}

describe("TaskManager", () => {
  it.each([
    ["self", "root", "root"],
    ["ancestor", "root", "a1"],
  ])("allows a %s issuer", (_name, issuerSessionId, assigneeSessionId) => {
    const { taskManager } = setup();
    const task = taskManager.createTask({
      id: "task-new",
      groupId: "g1",
      issuerSessionId,
      assigneeSessionId,
      goal: "do work",
      acceptanceCriteria: ["done"],
    });
    expect(task.status).toBe(TASK_STATUS.PENDING);
  });

  it.each([
    ["descendant", "a1", "root"],
    ["peer", "b", "a"],
    ["cross-group", "other", "a"],
  ])("rejects a %s issuer", (_name, issuerSessionId, assigneeSessionId) => {
    const { taskManager } = setup();
    expect(() =>
      taskManager.createTask({
        id: "task-new",
        groupId: "g1",
        issuerSessionId,
        assigneeSessionId,
        goal: "do work",
        acceptanceCriteria: ["done"],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TASK_ASSIGNMENT" }));
  });

  it("enforces the frozen state transitions", () => {
    const { taskManager } = setup();
    expect(() => taskManager.transitionTask("t1", "COMPLETED")).toThrowError(
      expect.objectContaining({ code: "INVALID_TASK_TRANSITION" }),
    );
    expect(taskManager.transitionTask("t1", "IN_PROGRESS").status).toBe(
      TASK_STATUS.IN_PROGRESS,
    );
    expect(() => taskManager.transitionTask("t1", "IN_PROGRESS")).toThrowError(
      expect.objectContaining({ code: "INVALID_TASK_TRANSITION" }),
    );
    expect(taskManager.transitionTask("t1", "COMPLETED").status).toBe(
      TASK_STATUS.COMPLETED,
    );
    expect(() => taskManager.transitionTask("t1", "FAILED")).toThrowError(
      expect.objectContaining({ code: "INVALID_TASK_TRANSITION" }),
    );
  });

  it("returns defensive task and list snapshots", () => {
    const { taskManager } = setup();
    const task = taskManager.getTask("t1");
    task.goal = "mutated";
    task.acceptanceCriteria[0] = "mutated";
    const list = taskManager.listAssignedTasks("a");
    list[0].status = "mutated";

    expect(taskManager.getTask("t1")).toMatchObject({
      goal: "implement",
      acceptanceCriteria: ["works"],
      status: TASK_STATUS.PENDING,
    });
    expect(taskManager.listTasks("g1").map((item) => item.id)).toEqual(["t1"]);
  });

  it("rejects duplicate IDs and invalid acceptance criteria", () => {
    const { taskManager } = setup();
    expect(() =>
      taskManager.createTask({
        id: "t1",
        groupId: "g1",
        issuerSessionId: "root",
        assigneeSessionId: "a",
        goal: "duplicate",
        acceptanceCriteria: ["done"],
      }),
    ).toThrowError(expect.objectContaining({ code: "TASK_ALREADY_EXISTS" }));
    expect(() =>
      taskManager.createTask({
        id: "bad",
        groupId: "g1",
        issuerSessionId: "root",
        assigneeSessionId: "a",
        goal: "bad",
        acceptanceCriteria: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("DevelopmentRecordStore", () => {
  it("creates stable hashes and payload-free compatible descriptors", () => {
    const { groupTree, store } = setup();
    const first = createRecord(store, { payload: { z: 2, a: "ok" } });
    const second = createRecord(store, {
      id: "r2",
      payload: { a: "ok", z: 2 },
    });
    const descriptor = store.getDescriptor("r1");

    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
    expect(descriptor).toMatchObject({
      recordId: "r1",
      sourceSessionId: "a",
      exposure: RECORD_EXPOSURES.WORK_RECORD,
    });
    expect(descriptor).not.toHaveProperty("id");
    expect(descriptor).not.toHaveProperty("payload");
    expect(
      authorizeRecordDescriptor({ viewerSessionId: "root", descriptor, groupTree }),
    ).toMatchObject({ allowed: true, recordId: "r1" });
  });

  it("normalizes stored payloads to JSON data and returns defensive records", () => {
    const { store } = setup();
    const record = createRecord(store, {
      payload: { kept: true, omitted: undefined, notFinite: Number.NaN },
    });
    record.payload.kept = false;

    expect(store.getRecord("r1").payload).toEqual({ kept: true, notFinite: null });
  });

  it("inherits the strictest source exposure by default", () => {
    const { store } = setup();
    createRecord(store, {
      id: "design",
      exposure: RECORD_EXPOSURES.DESIGN_CONTEXT,
    });
    createRecord(store, {
      id: "public",
      exposure: RECORD_EXPOSURES.GROUP_FACT,
    });
    const derived = createRecord(store, {
      id: "summary",
      type: "SUMMARY",
      exposure: undefined,
      sourceRecordIds: ["design", "public"],
    });

    expect(derived.exposure).toBe(RECORD_EXPOSURES.DESIGN_CONTEXT);
  });

  it("allows stricter derived exposure and rejects exposure escalation", () => {
    const { store } = setup();
    createRecord(store, {
      id: "source",
      exposure: RECORD_EXPOSURES.DESIGN_CONTEXT,
    });
    expect(
      createRecord(store, {
        id: "strict",
        exposure: RECORD_EXPOSURES.WORK_RECORD,
        sourceRecordIds: ["source"],
      }).exposure,
    ).toBe(RECORD_EXPOSURES.WORK_RECORD);
    expect(() =>
      createRecord(store, {
        id: "broad",
        exposure: RECORD_EXPOSURES.GROUP_FACT,
        sourceRecordIds: ["source"],
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_ESCALATION" }));
  });

  it.each([
    ["unknown task", { taskId: "missing" }, "GROUP_MISMATCH"],
    ["cross-group source", { sourceSessionId: "other" }, "GROUP_MISMATCH"],
    ["invalid type", { type: "THINKING_TRACE" }, "INVALID_RECORD_TYPE"],
    ["invalid exposure", { exposure: "PUBLIC" }, "INVALID_EXPOSURE"],
    ["missing exposure", { exposure: undefined }, "INVALID_EXPOSURE"],
    ["invalid payload", { payload: 1n }, "INVALID_PAYLOAD"],
    ["unknown source record", { sourceRecordIds: ["missing"] }, "SOURCE_RECORD_NOT_FOUND"],
  ])("rejects %s", (_name, overrides, code) => {
    const { store } = setup();
    expect(() => createRecord(store, overrides)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

const MATRIX_CASES = [
  ["SELF", "a", "WORK_RECORD", true, "ALLOW_SELF"],
  ["SELF", "a", "DESIGN_CONTEXT", true, "ALLOW_SELF"],
  ["SELF", "a", "GROUP_FACT", true, "ALLOW_SELF"],
  ["SUPERIOR", "root", "WORK_RECORD", true, "ALLOW_ANCESTOR"],
  ["SUPERIOR", "root", "DESIGN_CONTEXT", true, "ALLOW_ANCESTOR"],
  ["SUPERIOR", "root", "GROUP_FACT", true, "ALLOW_ANCESTOR"],
  ["SUBORDINATE", "a1", "WORK_RECORD", false, "DENY_WORK_RECORD_TO_DESCENDANT"],
  ["SUBORDINATE", "a1", "DESIGN_CONTEXT", true, "ALLOW_DESCENDANT_CONTEXT"],
  ["SUBORDINATE", "a1", "GROUP_FACT", true, "ALLOW_GROUP_FACT"],
  ["PEER", "b", "WORK_RECORD", false, "DENY_NON_PUBLIC_TO_PEER"],
  ["PEER", "b", "DESIGN_CONTEXT", false, "DENY_NON_PUBLIC_TO_PEER"],
  ["PEER", "b", "GROUP_FACT", true, "ALLOW_GROUP_FACT"],
  ["UNRELATED", "other", "WORK_RECORD", false, "DENY_CROSS_GROUP"],
  ["UNRELATED", "other", "DESIGN_CONTEXT", false, "DENY_CROSS_GROUP"],
  ["UNRELATED", "other", "GROUP_FACT", false, "DENY_CROSS_GROUP"],
];

describe("descriptor authorization", () => {
  it.each(MATRIX_CASES)(
    "applies %s/%s",
    (relationship, viewerSessionId, exposure, allowed, reasonCode) => {
      const { groupTree, store } = setup();
      createRecord(store, { exposure });
      const descriptor = store.getDescriptor("r1");

      expect(
        authorizeRecordDescriptor({ viewerSessionId, descriptor, groupTree }),
      ).toMatchObject({ allowed, relationship, reasonCode });
    },
  );

  it("filters descriptors without loading or exposing denied record bodies", () => {
    const { groupTree, store } = setup();
    createRecord(store, {
      id: "private",
      exposure: RECORD_EXPOSURES.WORK_RECORD,
      payload: { secret: PRIVATE_CANARY },
    });
    createRecord(store, {
      id: "public",
      exposure: RECORD_EXPOSURES.GROUP_FACT,
      payload: { status: "ready" },
    });
    const descriptors = store.listDescriptors({ groupId: "g1" });
    const result = filterAuthorizedDescriptors({
      viewerSessionId: "b",
      descriptors,
      groupTree,
    });

    expect(descriptors.map((item) => item.recordId)).toEqual(["private", "public"]);
    expect(result.descriptors.map((item) => item.recordId)).toEqual(["public"]);
    expect(result.decisions).toHaveLength(2);
    expect(JSON.stringify(descriptors)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY);
  });

  it("rejects payload-bearing or body-like descriptors without echoing content", () => {
    const { groupTree } = setup();
    for (const unsafeField of ["payload", "note"]) {
      let thrown;
      try {
        authorizeRecordDescriptor({
          viewerSessionId: "b",
          groupTree,
          descriptor: {
            recordId: "r1",
            groupId: "g1",
            sourceSessionId: "a",
            exposure: RECORD_EXPOSURES.GROUP_FACT,
            [unsafeField]: PRIVATE_CANARY,
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(String(thrown)).not.toContain(PRIVATE_CANARY);
    }
  });

  it("does not authorize a denied descriptor through a duplicate allowed record ID", () => {
    const { groupTree, store } = setup();
    createRecord(store, { exposure: RECORD_EXPOSURES.GROUP_FACT });
    const publicDescriptor = store.getDescriptor("r1");
    const privateDescriptor = {
      ...publicDescriptor,
      exposure: RECORD_EXPOSURES.WORK_RECORD,
    };

    const result = filterAuthorizedDescriptors({
      viewerSessionId: "b",
      descriptors: [publicDescriptor, privateDescriptor],
      groupTree,
    });

    expect(result.decisions.map((decision) => decision.allowed)).toEqual([
      true,
      false,
    ]);
    expect(result.descriptors).toEqual([publicDescriptor]);
  });
});
