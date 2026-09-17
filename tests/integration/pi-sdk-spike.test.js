import { describe, expect, it } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  buildPlanHandoff,
  explicitHistoryText,
  parseJsonObject,
  safeEventRecord,
} from "../../src/pi-sdk-spike.js";

const PRIVATE_CANARY = "PRIVATE_CANARY_A_7F31";

describe("Pi SDK offline acceptance", () => {
  it("keeps two in-memory session histories independent without session files", () => {
    const sessionA = SessionManager.inMemory(process.cwd());
    const sessionB = SessionManager.inMemory(process.cwd());

    sessionA.appendMessage({ role: "user", content: "SESSION_A_ONLY", timestamp: 1 });
    sessionB.appendMessage({ role: "user", content: "SESSION_B_ONLY", timestamp: 2 });

    const historyA = explicitHistoryText(sessionA.buildSessionContext().messages);
    const historyB = explicitHistoryText(sessionB.buildSessionContext().messages);

    expect(sessionA.getSessionId()).not.toBe(sessionB.getSessionId());
    expect(sessionA.getSessionFile()).toBeUndefined();
    expect(sessionB.getSessionFile()).toBeUndefined();
    expect(historyA).toContain("SESSION_A_ONLY");
    expect(historyA).not.toContain("SESSION_B_ONLY");
    expect(historyB).toContain("SESSION_B_ONLY");
    expect(historyB).not.toContain("SESSION_A_ONLY");
  });

  it("projects only allow-listed fields into a source-labelled handoff", () => {
    const handoff = buildPlanHandoff({
      sourceSessionId: "session-a",
      targetSessionId: "session-b",
      supervisorPayload: {
        plan: "Implement the worker task.",
        expectedMarker: "WORKER_OK",
        privateNote: PRIVATE_CANARY,
      },
    });

    expect(handoff).toEqual({
      sourceSessionId: "session-a",
      targetSessionId: "session-b",
      recordType: "PLAN_HANDOFF",
      content: {
        plan: "Implement the worker task.",
        expectedMarker: "WORKER_OK",
      },
    });
    expect(JSON.stringify(handoff)).not.toContain(PRIVATE_CANARY);
  });

  it.each(["thinking_start", "thinking_delta", "thinking_end"])(
    "drops %s before an event record is created",
    (updateType) => {
    const record = safeEventRecord("session-A", {
      type: "message_update",
      assistantMessageEvent: {
        type: updateType,
        delta: PRIVATE_CANARY,
      },
    });

    expect(record).toBeUndefined();
    },
  );

  it("does not copy message content into lifecycle event records", () => {
    const record = safeEventRecord("session-A", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: PRIVATE_CANARY }],
      },
    });

    expect(record).toEqual({
      session: "session-A",
      type: "message_end",
      role: "assistant",
    });
    expect(JSON.stringify(record)).not.toContain(PRIVATE_CANARY);
  });

  it("records text update metadata without copying text content", () => {
    const record = safeEventRecord("session-A", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "visible text",
      },
    });

    expect(record).toEqual({
      session: "session-A",
      type: "message_update",
      updateType: "text_delta",
      explicitTextCharacters: 12,
    });
    expect(JSON.stringify(record)).not.toContain("visible text");
  });

  it("parses a JSON object from an explicit assistant response", () => {
    expect(parseJsonObject('Result: {"status":"accepted"}', "worker")).toEqual({
      status: "accepted",
    });
  });
});
