import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import {
  buildPlanHandoff,
  countEvents,
  explicitHistoryText,
  latestAssistantText,
  parseJsonObject,
  safeEventRecord,
} from "../src/pi-sdk-spike.js";

const PRIVATE_CANARY = "PRIVATE_CANARY_A_7F31";
const DEFAULT_MODEL = "kimi/kimi-k2.7-code";

function readModelSpec() {
  const argument = process.argv.find((value) => value.startsWith("--model="));
  return argument?.slice("--model=".length) || process.env.PI_SPIKE_MODEL || DEFAULT_MODEL;
}

function splitModelSpec(modelSpec) {
  const separator = modelSpec.indexOf("/");
  if (separator <= 0 || separator === modelSpec.length - 1) {
    throw new Error(`Invalid model '${modelSpec}'. Expected provider/model.`);
  }
  return {
    provider: modelSpec.slice(0, separator),
    modelId: modelSpec.slice(separator + 1),
  };
}

async function createIsolatedSession({ cwd, model, modelRuntime }) {
  const sessionManager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      "You are a deterministic SDK integration probe. Follow the requested JSON schema exactly and do not use markdown fences.",
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  return { ...result, sessionManager };
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDirectory, "..");
  const artifactPath = resolve(projectRoot, "artifacts", "pi-dual-session-spike.json");
  const modelSpec = readModelSpec();
  const { provider, modelId } = splitModelSpec(modelSpec);

  const modelRuntime = await ModelRuntime.create();
  const availableModels = await modelRuntime.getAvailable();
  const isAvailable = availableModels.some(
    (candidate) => candidate.provider === provider && candidate.id === modelId,
  );
  if (!isAvailable) {
    const available = availableModels.map((candidate) => `${candidate.provider}/${candidate.id}`);
    throw new Error(
      `Model '${modelSpec}' is not authenticated and available. Available models: ${available.join(", ") || "none"}`,
    );
  }
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    throw new Error(`Pi could not resolve model '${modelSpec}'.`);
  }

  let sessionA;
  let sessionB;
  let unsubscribeA;
  let unsubscribeB;
  const events = [];

  try {
    const [createdA, createdB] = await Promise.all([
      createIsolatedSession({ cwd: projectRoot, model, modelRuntime }),
      createIsolatedSession({ cwd: projectRoot, model, modelRuntime }),
    ]);
    sessionA = createdA.session;
    sessionB = createdB.session;

    unsubscribeA = sessionA.subscribe((event) => {
      const record = safeEventRecord("session-A", event);
      if (record) events.push(record);
    });
    unsubscribeB = sessionB.subscribe((event) => {
      const record = safeEventRecord("session-B", event);
      if (record) events.push(record);
    });

    await sessionA.prompt(`Return exactly one JSON object with this schema and these values: {"plan":"Validate that an independent worker session can parse a source-labelled handoff.","expectedMarker":"WORKER_OK","privateNote":"${PRIVATE_CANARY}"}. Do not omit or rename fields.`);

    const supervisorPayload = parseJsonObject(
      latestAssistantText(sessionA),
      "session-A",
    );
    const handoff = buildPlanHandoff({
      sourceSessionId: createdA.sessionManager.getSessionId(),
      targetSessionId: createdB.sessionManager.getSessionId(),
      supervisorPayload,
    });

    const serializedHandoff = JSON.stringify(handoff);
    if (serializedHandoff.includes(PRIVATE_CANARY)) {
      throw new Error("Projection failure: the private canary entered the handoff.");
    }

    await sessionB.prompt(`Parse this source-labelled handoff:\n${serializedHandoff}\nReturn exactly one JSON object: {"receivedSourceSessionId":"<sourceSessionId>","parsedMarker":"<expectedMarker>","status":"accepted"}.`);

    const workerPayload = parseJsonObject(latestAssistantText(sessionB), "session-B");
    const historyA = explicitHistoryText(sessionA.state.messages);
    const historyB = explicitHistoryText(sessionB.state.messages);
    const sessionAId = createdA.sessionManager.getSessionId();
    const sessionBId = createdB.sessionManager.getSessionId();

    const checks = {
      distinctSessionIds: sessionAId !== sessionBId,
      distinctHistoryArrays: sessionA.state.messages !== sessionB.state.messages,
      bothSessionsProducedHistory:
        sessionA.state.messages.length > 0 && sessionB.state.messages.length > 0,
      supervisorHistoryContainsCanary: historyA.includes(PRIVATE_CANARY),
      handoffExcludesCanary: !serializedHandoff.includes(PRIVATE_CANARY),
      workerHistoryExcludesCanary: !historyB.includes(PRIVATE_CANARY),
      workerParsedSource:
        workerPayload.receivedSourceSessionId === handoff.sourceSessionId,
      workerParsedMarker:
        workerPayload.parsedMarker === handoff.content.expectedMarker,
      workerAcceptedHandoff: workerPayload.status === "accepted",
      usageMetadataAvailable:
        Number.isFinite(sessionA.getSessionStats().tokens.total) &&
        Number.isFinite(sessionB.getSessionStats().tokens.total),
      sessionAEmittedEvents: events.some((event) => event.session === "session-A"),
      sessionBEmittedEvents: events.some((event) => event.session === "session-B"),
      inMemorySessionsHaveNoFiles:
        createdA.sessionManager.getSessionFile() === undefined &&
        createdB.sessionManager.getSessionFile() === undefined,
    };
    const passed = Object.values(checks).every(Boolean);

    const artifact = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      piSdkVersion: VERSION,
      model: modelSpec,
      execution: {
        sessionsCreatedConcurrently: true,
        promptsExecutedSequentially: true,
        toolsEnabled: false,
        persistence: "in-memory",
      },
      sessions: {
        supervisor: {
          id: sessionAId,
          messageCount: sessionA.state.messages.length,
          stats: sessionA.getSessionStats(),
        },
        worker: {
          id: sessionBId,
          messageCount: sessionB.state.messages.length,
          stats: sessionB.getSessionStats(),
        },
      },
      projection: {
        handoff,
        supervisorFieldsObserved: Object.keys(supervisorPayload).sort(),
        privateFieldExcluded: !("privateNote" in handoff.content),
      },
      workerResult: workerPayload,
      eventCounts: countEvents(events),
      eventSample: events.slice(0, 40),
      checks,
      passed,
    };

    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`\nArtifact: ${artifactPath}\n`);
    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    unsubscribeA?.();
    unsubscribeB?.();
    sessionA?.dispose();
    sessionB?.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
