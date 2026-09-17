import { createHash } from "node:crypto";

export const RECORD_TYPES = Object.freeze([
  "WORK_DIRECTIVE",
  "PLAN",
  "DESIGN_DECISION",
  "IMPLEMENTATION_REPORT",
  "PATCH_SUMMARY",
  "TEST_EVIDENCE",
  "ISSUE",
  "HANDOFF",
  "ARTIFACT",
  "SUMMARY",
]);

export const RECORD_EXPOSURES = Object.freeze({
  WORK_RECORD: "WORK_RECORD",
  DESIGN_CONTEXT: "DESIGN_CONTEXT",
  GROUP_FACT: "GROUP_FACT",
});

const EXPOSURE_RANK = Object.freeze({
  [RECORD_EXPOSURES.WORK_RECORD]: 0,
  [RECORD_EXPOSURES.DESIGN_CONTEXT]: 1,
  [RECORD_EXPOSURES.GROUP_FACT]: 2,
});

const EXPOSURE_BY_RANK = Object.freeze([
  RECORD_EXPOSURES.WORK_RECORD,
  RECORD_EXPOSURES.DESIGN_CONTEXT,
  RECORD_EXPOSURES.GROUP_FACT,
]);

export class DevelopmentRecordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DevelopmentRecordError";
    this.code = code;
  }
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DevelopmentRecordError(
      "INVALID_ARGUMENT",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function snapshot(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function normalizePayload(payload) {
  try {
    const json = JSON.stringify(payload);
    if (json === undefined) {
      throw new TypeError("top-level value is not JSON serializable");
    }
    return JSON.parse(json);
  } catch {
    throw new DevelopmentRecordError(
      "INVALID_PAYLOAD",
      "payload must be JSON serializable",
    );
  }
}

function hashPayload(payload) {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function descriptorFromRecord(record) {
  const { id, payload: _payload, ...metadata } = record;
  return { recordId: id, ...snapshot(metadata) };
}

export class DevelopmentRecordStore {
  #records = new Map();

  constructor({ groupTree, taskManager, now = () => new Date() } = {}) {
    if (!groupTree || !taskManager) {
      throw new DevelopmentRecordError(
        "INVALID_ARGUMENT",
        "groupTree and taskManager are required",
      );
    }
    this.groupTree = groupTree;
    this.taskManager = taskManager;
    this.now = now;
  }

  createRecord({
    id,
    groupId,
    taskId,
    sourceSessionId,
    type,
    exposure,
    payload,
    sourceRecordIds = [],
  } = {}) {
    id = nonEmpty(id, "id");
    groupId = nonEmpty(groupId, "groupId");
    taskId = nonEmpty(taskId, "taskId");
    sourceSessionId = nonEmpty(sourceSessionId, "sourceSessionId");
    type = nonEmpty(type, "type");

    if (this.#records.has(id)) {
      throw new DevelopmentRecordError(
        "RECORD_ALREADY_EXISTS",
        `record ${id} already exists`,
      );
    }
    if (!RECORD_TYPES.includes(type)) {
      throw new DevelopmentRecordError(
        "INVALID_RECORD_TYPE",
        `invalid record type ${type}`,
      );
    }
    if (
      !Array.isArray(sourceRecordIds) ||
      sourceRecordIds.some(
        (sourceId) => typeof sourceId !== "string" || sourceId.trim() === "",
      )
    ) {
      throw new DevelopmentRecordError(
        "INVALID_ARGUMENT",
        "sourceRecordIds must contain non-empty strings",
      );
    }

    const normalizedPayload = normalizePayload(payload);
    const normalizedSourceIds = sourceRecordIds.map((sourceId) => sourceId.trim());

    let task;
    let session;
    try {
      task = this.taskManager.getTask(taskId);
      session = this.groupTree.getSession(sourceSessionId);
      this.groupTree.getGroup(groupId);
    } catch {
      throw new DevelopmentRecordError(
        "GROUP_MISMATCH",
        "record references must belong to one group",
      );
    }
    if (task.groupId !== groupId || session.groupId !== groupId) {
      throw new DevelopmentRecordError(
        "GROUP_MISMATCH",
        "record references must belong to one group",
      );
    }

    let strictestSourceRank = null;
    for (const sourceId of normalizedSourceIds) {
      const source = this.#records.get(sourceId);
      if (!source) {
        throw new DevelopmentRecordError(
          "SOURCE_RECORD_NOT_FOUND",
          `source record ${sourceId} not found`,
        );
      }
      if (source.groupId !== groupId) {
        throw new DevelopmentRecordError(
          "GROUP_MISMATCH",
          "source record belongs to another group",
        );
      }
      const sourceRank = EXPOSURE_RANK[source.exposure];
      strictestSourceRank =
        strictestSourceRank === null
          ? sourceRank
          : Math.min(strictestSourceRank, sourceRank);
    }

    if (exposure === undefined) {
      if (strictestSourceRank === null) {
        throw new DevelopmentRecordError(
          "INVALID_EXPOSURE",
          "exposure is required for a source record",
        );
      }
      exposure = EXPOSURE_BY_RANK[strictestSourceRank];
    } else {
      exposure = nonEmpty(exposure, "exposure");
    }
    if (!Object.hasOwn(EXPOSURE_RANK, exposure)) {
      throw new DevelopmentRecordError(
        "INVALID_EXPOSURE",
        `invalid exposure ${exposure}`,
      );
    }
    if (
      strictestSourceRank !== null &&
      EXPOSURE_RANK[exposure] > strictestSourceRank
    ) {
      throw new DevelopmentRecordError(
        "EXPOSURE_ESCALATION",
        "derived record exposure is broader than its sources",
      );
    }

    let createdAt;
    try {
      createdAt = new Date(this.now()).toISOString();
    } catch {
      throw new DevelopmentRecordError(
        "INVALID_ARGUMENT",
        "now must return a valid date",
      );
    }

    const record = {
      id,
      groupId,
      taskId,
      sourceSessionId,
      type,
      exposure,
      payload: normalizedPayload,
      sourceRecordIds: normalizedSourceIds,
      contentHash: hashPayload(normalizedPayload),
      schemaVersion: 1,
      createdAt,
    };
    this.#records.set(id, record);
    return snapshot(record);
  }

  getRecord(recordId) {
    const id = nonEmpty(recordId, "recordId");
    const record = this.#records.get(id);
    if (!record) {
      throw new DevelopmentRecordError(
        "RECORD_NOT_FOUND",
        `record ${id} not found`,
      );
    }
    return snapshot(record);
  }

  getDescriptor(recordId) {
    return descriptorFromRecord(this.getRecord(recordId));
  }

  listDescriptors({ groupId, taskId, sourceSessionId } = {}) {
    if (groupId !== undefined) {
      groupId = nonEmpty(groupId, "groupId");
      try {
        this.groupTree.getGroup(groupId);
      } catch {
        throw new DevelopmentRecordError(
          "GROUP_MISMATCH",
          `group ${groupId} not found`,
        );
      }
    }
    if (taskId !== undefined) taskId = nonEmpty(taskId, "taskId");
    if (sourceSessionId !== undefined) {
      sourceSessionId = nonEmpty(sourceSessionId, "sourceSessionId");
    }

    return [...this.#records.values()]
      .filter(
        (record) =>
          (groupId === undefined || record.groupId === groupId) &&
          (taskId === undefined || record.taskId === taskId) &&
          (sourceSessionId === undefined ||
            record.sourceSessionId === sourceSessionId),
      )
      .map(descriptorFromRecord);
  }
}
