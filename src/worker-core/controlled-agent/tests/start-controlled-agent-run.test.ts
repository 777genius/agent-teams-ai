import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  RunEventProviderKind,
  ControlledAgentRunStatus,
  startControlledAgentRun,
  type ControlledAgentEvent,
  type ControlledAgentLaunchPlanInput,
  type ControlledAgentRun,
  type ControlledAgentProviderPort,
  type ControlledAgentSession,
} from "../../index";

describe("startControlledAgentRun", () => {
  it("starts the provider only after a ready broker-only launch plan", async () => {
    const started: Array<{
      readonly session: ControlledAgentSession;
      readonly systemPrompt: string;
    }> = [];
    const saved: ControlledAgentSession[] = [];
    const savedRuns: ControlledAgentRun[] = [];
    const events: ControlledAgentEvent[] = [];
    const provider: ControlledAgentProviderPort = {
      async start(input) {
        started.push(input);
        return { providerRunId: "provider-run-1" };
      },
      status() {
        return { status: ControlledAgentRunStatus.Running };
      },
      stop() {
        return { status: ControlledAgentRunStatus.Stopped };
      },
    };

    const result = await startControlledAgentRun(launchInput(true), {
      provider,
      stateStore: {
        readSession() {
          return null;
        },
        saveSession(session) {
          saved.push(session);
        },
        readRun() {
          return null;
        },
        readLatestRunForSession() {
          return null;
        },
        saveRun(run) {
          savedRuns.push(run);
        },
      },
      events: {
        append(event) {
          events.push(event);
        },
      },
      clock: { now: () => new Date("2026-07-05T11:00:00.000Z") },
      idGenerator: {
        randomId: (() => {
          const ids = ["run-1", "event-1"];
          return () => ids.shift() ?? "unused";
        })(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected start success");
    expect(result.session.status).toBe("running");
    expect(result.session.activeRunId).toBe("run-1");
    expect(result.run.providerRunId).toBe("provider-run-1");
    expect(result.provider.providerRunId).toBe("provider-run-1");
    expect(saved).toHaveLength(1);
    expect(savedRuns).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(started[0]?.systemPrompt).toContain("Use only the broker/status tools");
    expect(started[0]?.session.toolSurface.deniedRawCapabilities).toContain(
      "raw_shell",
    );
  });

  it("does not call the provider when enforcement is incomplete", async () => {
    let providerCalled = false;
    const provider: ControlledAgentProviderPort = {
      start() {
        providerCalled = true;
        return {};
      },
      status() {
        return { status: ControlledAgentRunStatus.Running };
      },
      stop() {
        return { status: ControlledAgentRunStatus.Stopped };
      },
    };

    const result = await startControlledAgentRun(launchInput(false), { provider });

    expect(result.ok).toBe(false);
    expect(providerCalled).toBe(false);
    if (result.ok || !("plan" in result)) throw new Error("expected blocked");
    expect(result.plan.reason).toBe("provider_cannot_disable_raw_shell");
  });

  it("does not start a second provider run when the session already has an active run", async () => {
    let providerCalled = false;
    const provider: ControlledAgentProviderPort = {
      start() {
        providerCalled = true;
        return {};
      },
      status() {
        return { status: ControlledAgentRunStatus.Running };
      },
      stop() {
        return { status: ControlledAgentRunStatus.Stopped };
      },
    };

    const result = await startControlledAgentRun(launchInput(true), {
      provider,
      stateStore: {
        readSession() {
          return activeSession();
        },
        saveSession() {
          throw new Error("should not save session");
        },
        readRun() {
          return activeRun();
        },
        readLatestRunForSession() {
          return activeRun();
        },
        saveRun() {
          throw new Error("should not save run");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(providerCalled).toBe(false);
    if (result.ok || !("reason" in result)) {
      throw new Error("expected existing active run block");
    }
    expect(result.reason).toBe("existing_active_run");
    expect(result.run.runId).toBe("run-existing");
  });
});

function launchInput(canDisableRawShell: boolean): ControlledAgentLaunchPlanInput {
  return {
    controllerJobId: "infinity-context-controller-v1",
    sessionId: "session-1",
    stateDir: "/tmp/controller-state",
    boundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: {
      projectId: "infinity-context",
      registryRoot: "/var/data/infinity-context/worker-jobs/registry",
      workspaceRoots: ["/var/data/infinity-context/workspaces"],
      worktreeRoots: ["/var/data/infinity-context/worktrees"],
      jobIdPrefixes: ["infinity-context-"],
      tmuxSessionPrefixes: ["infinity-context-"],
      allowedBranches: ["main"],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: ["account-e"],
    },
    provider: {
      providerKind: RunEventProviderKind.Codex,
      canRestrictToolSurface: true,
      canDisableRawShell,
      canEnforceFilesystemSandbox: true,
      canIsolateHome: true,
      canIsolateTemp: true,
      canRestrictNetwork: true,
    },
  };
}

function activeSession(): ControlledAgentSession {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    identity: {
      controllerJobId: "infinity-context-controller-v1",
      projectId: "infinity-context",
      providerKind: RunEventProviderKind.Codex,
    },
    stateDir: "/tmp/controller-state",
    status: ControlledAgentRunStatus.Running,
    activeRunId: "run-existing",
    createdAt: "2026-07-05T11:00:00.000Z",
    updatedAt: "2026-07-05T11:00:00.000Z",
    toolSurface: {
      boundary: AccessBoundary.ProjectScopedControl,
      allowedTools: [],
      deniedRawCapabilities: [],
    },
  };
}

function activeRun(): ControlledAgentRun {
  return {
    schemaVersion: 1,
    runId: "run-existing",
    sessionId: "session-1",
    controllerJobId: "infinity-context-controller-v1",
    providerKind: RunEventProviderKind.Codex,
    status: ControlledAgentRunStatus.Running,
    startedAt: "2026-07-05T11:00:00.000Z",
    updatedAt: "2026-07-05T11:00:00.000Z",
  };
}
