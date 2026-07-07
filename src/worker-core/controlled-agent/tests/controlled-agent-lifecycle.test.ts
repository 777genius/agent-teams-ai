import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ControlledAgentRunStatus,
  ReconcileControlledAgentRunReason,
  RunEventProviderKind,
  reconcileControlledAgentRun,
  stopControlledAgentRun,
  type ControlledAgentRun,
  type ControlledAgentProviderPort,
  type ControlledAgentSession,
  type ControllerStateStorePort,
} from "../../index";

describe("controlled agent lifecycle", () => {
  it("stops a running provider run and clears the session active run", async () => {
    const store = new MemoryStateStore(session(), run());
    const provider: ControlledAgentProviderPort = {
      start() {
        return {};
      },
      status() {
        return { status: ControlledAgentRunStatus.Running };
      },
      stop() {
        return {
          status: ControlledAgentRunStatus.Stopped,
          safeMessage: "stopped by test",
          stoppedAt: "2026-07-05T12:00:00.000Z",
        };
      },
    };

    const result = await stopControlledAgentRun({
      sessionId: "session-1",
      reason: "test",
    }, {
      stateStore: store,
      provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected stop success");
    expect(result.session.activeRunId).toBeUndefined();
    expect(result.run.status).toBe(ControlledAgentRunStatus.Stopped);
    expect(store.savedSession?.status).toBe(ControlledAgentRunStatus.Stopped);
    expect(store.savedRun?.safeMessage).toBe("stopped by test");
  });

  it("reconciles a terminal provider status into persisted state", async () => {
    const store = new MemoryStateStore(session(), run());
    const providerStops: string[] = [];
    const provider: ControlledAgentProviderPort = {
      start() {
        return {};
      },
      status() {
        return {
          status: ControlledAgentRunStatus.Stale,
          safeMessage: "provider process missing",
          observedAt: "2026-07-05T12:30:00.000Z",
        };
      },
      stop(input) {
        providerStops.push(input.reason ?? "");
        return { status: ControlledAgentRunStatus.Stopped };
      },
    };

    const result = await reconcileControlledAgentRun("session-1", {
      stateStore: store,
      provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reconcile success");
    expect(result.session.status).toBe(ControlledAgentRunStatus.Stale);
    expect(result.run.status).toBe(ControlledAgentRunStatus.Stale);
    expect(result.run.stoppedAt).toBe("2026-07-05T12:30:00.000Z");
    expect(providerStops).toEqual(["controlled_agent_reconcile_terminal:stale"]);
  });

  it("does not clear an active run when terminal provider cleanup fails", async () => {
    const store = new MemoryStateStore(session(), run());
    const provider: ControlledAgentProviderPort = {
      start() {
        return {};
      },
      status() {
        return {
          status: ControlledAgentRunStatus.Blocked,
          safeMessage: "controller blocked",
          observedAt: "2026-07-05T12:30:00.000Z",
        };
      },
      stop() {
        throw new Error("provider cleanup failed");
      },
    };

    const result = await reconcileControlledAgentRun("session-1", {
      stateStore: store,
      provider,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reconcile cleanup failure");
    expect(result.reason).toBe(ReconcileControlledAgentRunReason.ProviderCleanupFailed);
    expect(result.safeMessage).toBe("provider cleanup failed");
    expect(store.savedSession).toBeUndefined();
    expect(store.savedRun).toBeUndefined();
  });

  it("does not treat persisted terminal controller state as healthy when the provider reports running", async () => {
    const scenarios: Array<{
      readonly name: string;
      readonly sessionStatus: ControlledAgentRunStatus;
      readonly runStatus: ControlledAgentRunStatus;
      readonly expectedStatus: ControlledAgentRunStatus;
      readonly existingSafeMessage?: string;
    }> = [
      {
        name: "blocked session",
        sessionStatus: ControlledAgentRunStatus.Blocked,
        runStatus: ControlledAgentRunStatus.Running,
        expectedStatus: ControlledAgentRunStatus.Blocked,
        existingSafeMessage: "Codex app-server goal backend is temporarily blocked.",
      },
      {
        name: "stopped run",
        sessionStatus: ControlledAgentRunStatus.Running,
        runStatus: ControlledAgentRunStatus.Stopped,
        expectedStatus: ControlledAgentRunStatus.Stopped,
      },
    ];

    for (const scenario of scenarios) {
      const store = new MemoryStateStore(
        { ...session(), status: scenario.sessionStatus },
        {
          ...run(),
          status: scenario.runStatus,
          ...(scenario.existingSafeMessage === undefined
            ? {}
            : { safeMessage: scenario.existingSafeMessage }),
        },
      );
      const providerStops: string[] = [];
      const provider: ControlledAgentProviderPort = {
        start() {
          return {};
        },
        status() {
          return {
            status: ControlledAgentRunStatus.Running,
            providerAttached: true,
            providerRunId: `provider-${scenario.name}`,
          };
        },
        stop(input) {
          providerStops.push(input.reason ?? "");
          return { status: ControlledAgentRunStatus.Stopped };
        },
      };

      const result = await reconcileControlledAgentRun("session-1", {
        stateStore: store,
        provider,
        clock: { now: () => new Date("2026-07-05T12:45:00.000Z") },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected reconcile success for ${scenario.name}`);
      expect(result.reason).toBe(ReconcileControlledAgentRunReason.ProviderTerminalStatus);
      expect(result.session.activeRunId).toBeUndefined();
      expect(result.session.status).toBe(scenario.expectedStatus);
      expect(result.run.status).toBe(scenario.expectedStatus);
      expect(result.run.stoppedAt).toBe("2026-07-05T12:45:00.000Z");
      expect(providerStops).toEqual([
        `controlled_agent_reconcile_persisted_terminal:${scenario.expectedStatus}`,
      ]);
      if (scenario.existingSafeMessage) {
        expect(result.run.safeMessage).toBe(scenario.existingSafeMessage);
      }
    }
  });
});

class MemoryStateStore implements ControllerStateStorePort {
  savedSession?: ControlledAgentSession;
  savedRun?: ControlledAgentRun;

  constructor(
    private currentSession: ControlledAgentSession | null,
    private currentRun: ControlledAgentRun | null,
  ) {}

  readSession(): ControlledAgentSession | null {
    return this.currentSession;
  }

  saveSession(session: ControlledAgentSession): void {
    this.savedSession = session;
    this.currentSession = session;
  }

  readRun(): ControlledAgentRun | null {
    return this.currentRun;
  }

  readLatestRunForSession(): ControlledAgentRun | null {
    return this.currentRun;
  }

  saveRun(run: ControlledAgentRun): void {
    this.savedRun = run;
    this.currentRun = run;
  }
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
