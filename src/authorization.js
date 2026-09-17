import { HISTORY_ACCESS, RELATIONSHIPS } from "./group-tree.js";
import { RECORD_EXPOSURES } from "./record-store.js";

const DESCRIPTOR_FIELDS = new Set([
  "recordId",
  "groupId",
  "taskId",
  "sourceSessionId",
  "type",
  "exposure",
  "sourceRecordIds",
  "contentHash",
  "schemaVersion",
  "createdAt",
]);

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new AuthorizationError("INVALID_ARGUMENT", "descriptor must be an object");
  }
  if (Object.keys(descriptor).some((key) => !DESCRIPTOR_FIELDS.has(key))) {
    throw new AuthorizationError(
      "INVALID_ARGUMENT",
      "descriptor contains a non-metadata field",
    );
  }
  for (const field of ["recordId", "sourceSessionId", "groupId", "exposure"]) {
    if (typeof descriptor[field] !== "string" || descriptor[field].trim() === "") {
      throw new AuthorizationError("INVALID_ARGUMENT", "descriptor is incomplete");
    }
  }
  if (!Object.values(RECORD_EXPOSURES).includes(descriptor.exposure)) {
    throw new AuthorizationError(
      "INVALID_ARGUMENT",
      "descriptor exposure is invalid",
    );
  }
}

export function authorizeRecordDescriptor({
  viewerSessionId,
  descriptor,
  groupTree,
} = {}) {
  if (!groupTree) {
    throw new AuthorizationError("INVALID_ARGUMENT", "groupTree is required");
  }
  validateDescriptor(descriptor);

  let source;
  try {
    source = groupTree.getSession(descriptor.sourceSessionId);
  } catch {
    throw new AuthorizationError("INVALID_ARGUMENT", "descriptor source is invalid");
  }
  if (source.groupId !== descriptor.groupId) {
    throw new AuthorizationError("INVALID_ARGUMENT", "descriptor group is invalid");
  }

  let relationship;
  try {
    relationship = groupTree.resolveRelationship(
      viewerSessionId,
      descriptor.sourceSessionId,
    );
  } catch {
    throw new AuthorizationError("INVALID_ARGUMENT", "viewer session is invalid");
  }

  let allowed = false;
  let access;
  let reasonCode;

  if (
    relationship === RELATIONSHIPS.SELF ||
    relationship === RELATIONSHIPS.SUPERIOR
  ) {
    allowed = true;
    access = HISTORY_ACCESS.FULL_EXPLICIT_HISTORY;
    reasonCode =
      relationship === RELATIONSHIPS.SELF ? "ALLOW_SELF" : "ALLOW_ANCESTOR";
  } else if (relationship === RELATIONSHIPS.SUBORDINATE) {
    allowed = descriptor.exposure !== RECORD_EXPOSURES.WORK_RECORD;
    access = HISTORY_ACCESS.DESIGN_CONTEXT_AND_GROUP_FACT;
    if (!allowed) {
      reasonCode = "DENY_WORK_RECORD_TO_DESCENDANT";
    } else {
      reasonCode =
        descriptor.exposure === RECORD_EXPOSURES.GROUP_FACT
          ? "ALLOW_GROUP_FACT"
          : "ALLOW_DESCENDANT_CONTEXT";
    }
  } else if (relationship === RELATIONSHIPS.PEER) {
    allowed = descriptor.exposure === RECORD_EXPOSURES.GROUP_FACT;
    access = HISTORY_ACCESS.GROUP_FACT_ONLY;
    reasonCode = allowed ? "ALLOW_GROUP_FACT" : "DENY_NON_PUBLIC_TO_PEER";
  } else {
    access = HISTORY_ACCESS.DENIED;
    reasonCode = "DENY_CROSS_GROUP";
  }

  return {
    recordId: descriptor.recordId,
    allowed,
    relationship,
    access,
    reasonCode,
  };
}

export function filterAuthorizedDescriptors({
  viewerSessionId,
  descriptors,
  groupTree,
} = {}) {
  if (!Array.isArray(descriptors)) {
    throw new AuthorizationError(
      "INVALID_ARGUMENT",
      "descriptors must be an array",
    );
  }
  const decisions = descriptors.map((descriptor) =>
    authorizeRecordDescriptor({ viewerSessionId, descriptor, groupTree }),
  );
  return {
    descriptors: descriptors
      .filter((_descriptor, index) => decisions[index].allowed)
      .map((descriptor) => structuredClone(descriptor)),
    decisions,
  };
}
