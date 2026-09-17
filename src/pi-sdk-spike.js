/**
 * Pure helpers shared by the online Pi SDK spike and offline acceptance tests.
 *
 * They deliberately expose only explicit assistant text and allow-listed
 * handoff fields. Hidden thinking updates are rejected before a record exists.
 */

export function explicitText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function explicitHistoryText(messages) {
  return messages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map(explicitText)
    .join("\n");
}

export function latestAssistantText(session) {
  const assistantMessage = [...session.state.messages]
    .reverse()
    .find((message) => message?.role === "assistant");
  const text = explicitText(assistantMessage).trim();
  if (!text) {
    throw new Error("The session did not produce an explicit assistant text response.");
  }
  return text;
}

export function parseJsonObject(text, label) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error(`${label} did not contain a JSON object.`);
  }
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export function requireString(value, field, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function buildPlanHandoff({ sourceSessionId, targetSessionId, supervisorPayload }) {
  return {
    sourceSessionId,
    targetSessionId,
    recordType: "PLAN_HANDOFF",
    content: {
      plan: requireString(supervisorPayload.plan, "plan", "session-A"),
      expectedMarker: requireString(
        supervisorPayload.expectedMarker,
        "expectedMarker",
        "session-A",
      ),
    },
  };
}

export function safeEventRecord(sessionLabel, event) {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update?.type !== "text_delta" || typeof update.delta !== "string") {
      return undefined;
    }
  }
  const record = { session: sessionLabel, type: event.type };
  if (event.type === "message_start" || event.type === "message_end") {
    record.role = event.message?.role ?? "unknown";
  }
  if (event.type === "message_update") {
    record.updateType = event.assistantMessageEvent.type;
    record.explicitTextCharacters = event.assistantMessageEvent.delta.length;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    record.toolName = event.toolName;
  }
  return record;
}

export function countEvents(events) {
  const counts = {};
  for (const event of events) {
    const key = `${event.session}:${event.type}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
