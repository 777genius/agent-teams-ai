import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ControlledAgentEventType,
  ControlledAgentRunStatus,
  RunEventProviderKind,
  type ControlledAgentRun,
  type ControlledAgentSession,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalControlledAgentStateStore } from "../index";

describe("LocalControlledAgentStateStore", () => {
  it("persists sessions, latest runs and safe event lines", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "controlled-agent-store-"));
    const store = new LocalControlledAgentStateStore({ rootDir });

    await store.saveSession(session());
    await store.saveRun(run());
    await store.append({
      schemaVersion: 1,
      eventId: "event-1",
      sessionId: "session-1",
      runId: "run-1",
      controllerJobId: "controller-1",
      type: ControlledAgentEventType.RunStarted,
      occurredAt: "2026-07-05T11:00:00.000Z",
      payload: { providerRunId: "provider-run-1" },
    });

    expect(await store.readSession("session-1")).toMatchObject({
      sessionId: "session-1",
      activeRunId: "run-1",
    });
    expect(await store.readRun("run-1")).toMatchObject({
      runId: "run-1",
      providerRunId: "provider-run-1",
    });
    expect(await store.readLatestRunForSession("session-1")).toMatchObject({
      runId: "run-1",
    });
    const eventFiles = await findFiles(rootDir, "events.jsonl");
    expect(eventFiles).toHaveLength(1);
    expect(await readFile(eventFiles[0] as string, "utf8")).toContain(
      '"controlled_agent.run.started"',
    );
  });
});

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...await findFiles(path, fileName));
    if (entry.isFile() && entry.name === fileName) results.push(path);
  }
  return results;
}

function session(): ControlledAgentSession {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    identity: {
      controllerJobId: "controller-1",
      projectId: "project-1",
      providerKind: RunEventProviderKind.Codex,
    },
    stateDir: "/tmp/state",
    status: ControlledAgentRunStatus.Running,
    activeRunId: "run-1",
    createdAt: "2026-07-05T11:00:00.000Z",
    updatedAt: "2026-07-05T11:00:00.000Z",
    toolSurface: {
      boundary: AccessBoundary.ProjectScopedControl,
      allowedTools: [],
      deniedRawCapabilities: [],
    },
  };
}

function run(): ControlledAgentRun {
  return {
    schemaVersion: 1,
    runId: "run-1",
    sessionId: "session-1",
    controllerJobId: "controller-1",
    providerKind: RunEventProviderKind.Codex,
    status: ControlledAgentRunStatus.Running,
    providerRunId: "provider-run-1",
    startedAt: "2026-07-05T11:00:00.000Z",
    updatedAt: "2026-07-05T11:00:00.000Z",
  };
}
