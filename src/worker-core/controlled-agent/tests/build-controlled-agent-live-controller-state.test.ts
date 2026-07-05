import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ControlledAgentProcessOwnerKind,
  ControlledAgentRunStatus,
  RunEventProviderKind,
  buildControlledAgentLiveControllerState,
  type ControlledAgentProcessOwner,
  type ControlledAgentSession,
} from "../../index";

describe("buildControlledAgentLiveControllerState", () => {
  it("reports live only when owner, persisted state and observed provider status agree", () => {
    const owner = processOwner("owner-1");
    const session = controlledSession({
      owner,
      status: ControlledAgentRunStatus.Running,
    });

    const live = buildControlledAgentLiveControllerState({
      session,
      providerAttached: true,
      currentOwner: owner,
      providerObservedStatus: ControlledAgentRunStatus.Running,
    });

    expect(live).toMatchObject({
      providerRunnerAttached: true,
      live: true,
      ownerMatches: true,
      persistedStatus: "running",
      providerObservedStatus: "running",
    });

    const completed = buildControlledAgentLiveControllerState({
      session,
      providerAttached: true,
      currentOwner: owner,
      providerObservedStatus: ControlledAgentRunStatus.Completed,
    });

    expect(completed).toMatchObject({
      providerRunnerAttached: true,
      live: false,
      ownerMatches: true,
      persistedStatus: "running",
      providerObservedStatus: "completed",
    });
    expect(completed.safeMessage).toContain("observed provider status is not running");
  });

  it("does not treat persisted state or mismatched owner as live ownership", () => {
    const currentOwner = processOwner("owner-current");
    const persistedOwner = processOwner("owner-old");
    const session = controlledSession({
      owner: persistedOwner,
      status: ControlledAgentRunStatus.Running,
    });

    expect(buildControlledAgentLiveControllerState({
      session,
      providerAttached: false,
      currentOwner,
    })).toMatchObject({
      providerRunnerAttached: false,
      live: false,
      ownerMatches: false,
      persistedOwner: { ownerId: "owner-old" },
    });

    expect(buildControlledAgentLiveControllerState({
      session,
      providerAttached: true,
      currentOwner,
      providerObservedStatus: ControlledAgentRunStatus.Running,
    })).toMatchObject({
      providerRunnerAttached: true,
      live: false,
      ownerMatches: false,
    });
  });

  it("does not report live ownership when provider status probing fails", () => {
    const owner = processOwner("owner-1");
    const session = controlledSession({
      owner,
      status: ControlledAgentRunStatus.Running,
    });

    const live = buildControlledAgentLiveControllerState({
      session,
      providerAttached: true,
      currentOwner: owner,
      providerStatusFailed: true,
    });

    expect(live).toMatchObject({
      providerRunnerAttached: true,
      providerStatusFailed: true,
      live: false,
      ownerMatches: true,
      persistedStatus: "running",
    });
    expect(live.safeMessage).toContain("provider status probe failed");
  });
});

function processOwner(ownerId: string): ControlledAgentProcessOwner {
  return {
    schemaVersion: 1,
    ownerId,
    kind: ControlledAgentProcessOwnerKind.DurableMcp,
    startedAt: "2026-07-05T10:00:00.000Z",
    heartbeatAt: "2026-07-05T10:00:00.000Z",
    pid: 1234,
    hostname: "host-a",
    runtimeVersion: "0.1.0-test",
    runtimeSha: "sha-test",
  };
}

function controlledSession(input: {
  readonly owner: ControlledAgentProcessOwner;
  readonly status: ControlledAgentRunStatus;
}): ControlledAgentSession {
  return {
    schemaVersion: 1,
    sessionId: "controller-v1:controlled-agent",
    identity: {
      controllerJobId: "controller-v1",
      projectId: "project-a",
      providerKind: RunEventProviderKind.Codex,
    },
    stateDir: "/tmp/controller-state",
    status: input.status,
    activeRunId: "run-1",
    owner: input.owner,
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    toolSurface: {
      boundary: AccessBoundary.ProjectScopedControl,
      allowedTools: [],
      deniedRawCapabilities: [],
    },
  };
}
