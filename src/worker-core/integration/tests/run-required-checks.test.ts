import { describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationAuditEventType,
  IntegrationAttemptStatus,
  ReviewDecisionStatus,
  markWorkerOutputApplied,
  openIntegrationAttempt,
  runRequiredChecks,
  type CheckRun,
  type CheckRunnerPort,
  type IntegrationAttempt,
  type IntegrationAttemptStorePort,
  type IntegrationAuditEvent,
  type ProjectIntegrationCheckSpec,
} from "../../index";

describe("runRequiredChecks", () => {
  it("runs review-required checks through the check runner port", async () => {
    const requiredChecks: readonly ProjectIntegrationCheckSpec[] = [
      {
        checkId: "lint",
        command: ["npm", "run", "lint"],
        cwd: "packages/app",
        timeoutMs: 30_000,
      },
      {
        checkId: "test:memory",
        command: ["npm", "test", "--", "memory"],
      },
    ];
    const attempt = createAttempt({
      requiredChecks,
      status: IntegrationAttemptStatus.Applied,
    });
    const store = new MemoryAttemptStore(attempt);
    const checks = new RecordingCheckRunner([
      CheckRunStatus.Passed,
      CheckRunStatus.Passed,
    ]);

    const checked = await runRequiredChecks({
      store,
      checks,
      clock: new SequenceClock([
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
        "2026-01-01T00:00:04.000Z",
      ]),
    }, {
      attemptId: attempt.attemptId,
    });

    expect(checks.calls).toEqual([
      {
        workspacePath: "/work/project-main",
        check: requiredChecks[0],
        startedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        workspacePath: "/work/project-main",
        check: requiredChecks[1],
        startedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect(checked).toMatchObject({
      status: IntegrationAttemptStatus.ChecksPassed,
      checkRuns: [
        {
          checkId: "lint",
          status: CheckRunStatus.Passed,
          startedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          checkId: "test:memory",
          status: CheckRunStatus.Passed,
          startedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    expect(store.updates.map((update) => update.status)).toEqual([
      IntegrationAttemptStatus.ChecksRunning,
      IntegrationAttemptStatus.ChecksPassed,
    ]);
    expect(store.events.map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt,
      status: event.status,
    }))).toEqual([
      {
        type: IntegrationAuditEventType.ChecksStarted,
        occurredAt: "2026-01-01T00:00:01.000Z",
        status: IntegrationAttemptStatus.ChecksRunning,
      },
      {
        type: IntegrationAuditEventType.ChecksPassed,
        occurredAt: "2026-01-01T00:00:04.000Z",
        status: IntegrationAttemptStatus.ChecksPassed,
      },
    ]);
  });

  it("records a failed check outcome when any required check does not pass", async () => {
    const attempt = createAttempt({
      requiredChecks: [
        {
          checkId: "lint",
          command: ["npm", "run", "lint"],
        },
        {
          checkId: "test:memory",
          command: ["npm", "test", "--", "memory"],
        },
      ],
      status: IntegrationAttemptStatus.Applied,
    });
    const store = new MemoryAttemptStore(attempt);
    const checks = new RecordingCheckRunner([
      CheckRunStatus.Passed,
      CheckRunStatus.TimedOut,
    ]);

    const checked = await runRequiredChecks({
      store,
      checks,
      clock: new SequenceClock([
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
        "2026-01-01T00:00:04.000Z",
      ]),
    }, {
      attemptId: attempt.attemptId,
    });

    expect(checked.status).toBe(IntegrationAttemptStatus.ChecksFailed);
    expect(checked.checkRuns.map((run) => run.status)).toEqual([
      CheckRunStatus.Passed,
      CheckRunStatus.TimedOut,
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      IntegrationAuditEventType.ChecksStarted,
      IntegrationAuditEventType.ChecksFailed,
    ]);
  });

  it.each([
    IntegrationAttemptStatus.ChecksRunning,
    IntegrationAttemptStatus.ChecksPassed,
  ])("does not dispatch checks for %s attempts", async (status) => {
    const attempt = createAttempt({
      status,
      requiredChecks: [
        {
          checkId: "test:memory",
          command: ["npm", "test", "--", "memory"],
        },
      ],
    });
    const store = new MemoryAttemptStore(attempt);
    const checks = new RecordingCheckRunner([CheckRunStatus.Failed]);

    const checked = await runRequiredChecks({
      store,
      checks,
      clock: new SequenceClock(["2026-01-01T00:00:01.000Z"]),
    }, {
      attemptId: attempt.attemptId,
    });

    expect(checked).toBe(attempt);
    expect(checks.calls).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(store.events).toEqual([]);
  });
});

function createAttempt(input: {
  readonly status: IntegrationAttemptStatus;
  readonly requiredChecks: readonly ProjectIntegrationCheckSpec[];
}): IntegrationAttempt {
  const opened = openIntegrationAttempt({
    attemptId: "attempt-1",
    projectId: "project-1",
    controllerJobId: "controller-1",
    sourceWorkspacePath: "/work/project-worker",
    targetWorkspacePath: "/work/project-main",
    targetBranch: "main",
    targetRemote: "origin",
    workerOutput: {
      workerJobId: "worker-1",
      workspacePath: "/work/project-worker",
      commitSha: "def456",
      changedFiles: ["src/memory.ts"],
    },
    reviewDecision: {
      reviewedBy: "controller",
      decision: ReviewDecisionStatus.Approved,
      reason: "approved worker output",
      approvedFiles: ["src/memory.ts"],
      requiredChecks: input.requiredChecks,
    },
    now: "2026-01-01T00:00:00.000Z",
  });
  const applied = markWorkerOutputApplied(opened, {
    changedFiles: ["src/memory.ts"],
    now: "2026-01-01T00:00:00.500Z",
  });
  if (input.status === IntegrationAttemptStatus.Applied) return applied;
  if (input.status === IntegrationAttemptStatus.ChecksRunning) {
    return {
      ...applied,
      status: IntegrationAttemptStatus.ChecksRunning,
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
  }
  if (input.status === IntegrationAttemptStatus.ChecksPassed) {
    return {
      ...applied,
      status: IntegrationAttemptStatus.ChecksPassed,
      checkRuns: [
        {
          checkId: "test:memory",
          command: ["npm", "test", "--", "memory"],
          status: CheckRunStatus.Passed,
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          exitCode: 0,
        },
      ],
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
  }
  return {
    ...applied,
    status: input.status,
  };
}

class MemoryAttemptStore implements IntegrationAttemptStorePort {
  readonly updates: IntegrationAttempt[] = [];
  readonly events: IntegrationAuditEvent[] = [];
  private readonly attempts = new Map<string, IntegrationAttempt>();

  constructor(attempt: IntegrationAttempt) {
    this.attempts.set(attempt.attemptId, attempt);
  }

  get(attemptId: string): IntegrationAttempt | null {
    return this.attempts.get(attemptId) ?? null;
  }

  update(attempt: IntegrationAttempt): void {
    this.updates.push(attempt);
    this.attempts.set(attempt.attemptId, attempt);
  }

  create(attempt: IntegrationAttempt): void {
    this.attempts.set(attempt.attemptId, attempt);
  }

  appendEvent(_attemptId: string, event: IntegrationAuditEvent): void {
    this.events.push(event);
  }
}

class RecordingCheckRunner implements CheckRunnerPort {
  readonly calls: CheckRunInput[] = [];

  constructor(private readonly statuses: readonly CheckRunStatus[]) {}

  runCheck(input: CheckRunInput): CheckRun {
    this.calls.push(input);
    const status = this.statuses[this.calls.length - 1] ?? CheckRunStatus.Passed;
    return {
      checkId: input.check.checkId,
      command: input.check.command,
      status,
      startedAt: input.startedAt,
      completedAt: input.startedAt,
      exitCode: status === CheckRunStatus.Passed ? 0 : 1,
    };
  }
}

type CheckRunInput = Parameters<CheckRunnerPort["runCheck"]>[0];

class SequenceClock {
  private index = 0;

  constructor(private readonly values: readonly string[]) {}

  now(): Date {
    const value = this.values[Math.min(this.index, this.values.length - 1)];
    if (value === undefined) {
      throw new Error("sequence_clock_values_required");
    }
    this.index += 1;
    return new Date(value);
  }
}
