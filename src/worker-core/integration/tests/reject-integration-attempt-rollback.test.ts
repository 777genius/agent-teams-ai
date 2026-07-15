import { describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  IntegrationErrorReason,
  ReviewDecisionStatus,
  rejectIntegrationAttempt,
  runRequiredChecks,
  type CheckRunnerPort,
  type GitPort,
  type IntegratedOutputLedgerPort,
  type IntegrationAttempt,
  type IntegrationAttemptStorePort,
  type IntegrationAuditEvent,
  type ProjectIntegrationCheckSpec,
  type WorkspaceLock,
  type WorkspaceLockPort,
} from "../../index";

describe("rejectIntegrationAttempt output rollback", () => {
  it.each([
    IntegrationAttemptStatus.Applied,
    IntegrationAttemptStatus.ChecksFailed,
    IntegrationAttemptStatus.ChecksPassed,
  ])("rolls back non-merge output under lock before rejecting from %s", async (status) => {
    const fixture = createFixture(status);

    const rejected = await rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    });

    expect(rejected.status).toBe(IntegrationAttemptStatus.Rejected);
    expect(fixture.rollbackCalls).toEqual([fixture.attempt.attemptId]);
    expect(fixture.lockEvents).toEqual(["acquire", "release"]);
    expect(fixture.finalizeCalls()).toBe(1);
  });

  it("fails closed while checks are running without rollback or rejection evidence", async () => {
    const fixture = createFixture(IntegrationAttemptStatus.ChecksRunning);

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.InvalidTransition,
      evidence: ["checks_must_reach_a_terminal_state_before_rejection"],
    });
    expect(fixture.store.get(fixture.attempt.attemptId)).toMatchObject({
      status: IntegrationAttemptStatus.ChecksRunning,
    });
    expect(fixture.rollbackCalls).toEqual([]);
    expect(fixture.lockEvents).toEqual(["acquire", "release"]);
    expect(fixture.prepareCalls()).toBe(0);
    expect(fixture.finalizeCalls()).toBe(0);
  });

  it("fails closed on lock contention and safely retries after checks", async () => {
    const locks = new NonBlockingWorkspaceLock();
    const checkGate = deferred<void>();
    const checkStarted = deferred<void>();
    const fixture = createFixture(IntegrationAttemptStatus.Applied, {
      locks,
      requiredChecks: [{ checkId: "test", command: ["npm", "test"] }],
    });
    const checks: CheckRunnerPort = {
      async runCheck(input) {
        checkStarted.resolve(undefined);
        await checkGate.promise;
        return {
          checkId: input.check.checkId,
          command: input.check.command,
          status: CheckRunStatus.Passed,
          startedAt: input.startedAt,
          completedAt: input.startedAt,
          exitCode: 0,
        };
      },
    };

    const checking = runRequiredChecks(
      { ...fixture.deps, locks, checks },
      { attemptId: fixture.attempt.attemptId },
    );
    await checkStarted.promise;
    await expect(rejectIntegrationAttempt(
      { ...fixture.deps, locks },
      {
        attemptId: fixture.attempt.attemptId,
        reason: "integration rejected",
      },
    )).rejects.toThrow("workspace_locked");
    expect(fixture.rollbackCalls).toEqual([]);

    checkGate.resolve(undefined);
    await expect(checking).resolves.toMatchObject({
      status: IntegrationAttemptStatus.ChecksPassed,
    });
    await expect(rejectIntegrationAttempt(
      { ...fixture.deps, locks },
      {
        attemptId: fixture.attempt.attemptId,
        reason: "integration rejected",
      },
    )).resolves.toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
    });
    expect(fixture.store.get(fixture.attempt.attemptId)).toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
    });
    expect(fixture.rollbackCalls).toEqual([fixture.attempt.attemptId]);
    expect(fixture.finalizeCalls()).toBe(1);
  });

  it("fails closed without recording rejection when rollback fails", async () => {
    const fixture = createFixture(IntegrationAttemptStatus.Applied, {
      rollbackError: new Error("rollback mismatch"),
    });

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.OutputRollbackFailed,
      evidence: ["rollback mismatch"],
    });
    expect(fixture.store.get(fixture.attempt.attemptId)).toMatchObject({
      status: IntegrationAttemptStatus.Applied,
    });
    expect(fixture.finalizeCalls()).toBe(0);
    expect(fixture.lockEvents).toEqual(["acquire", "release"]);
  });

  it("recovers when rejected state persistence fails before ledger finalization", async () => {
    const fixture = createFixture(IntegrationAttemptStatus.Applied);
    fixture.store.failNextUpdate = new Error("state persistence failed");

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).rejects.toThrow("state persistence failed");
    expect(fixture.store.get(fixture.attempt.attemptId)).toMatchObject({
      status: IntegrationAttemptStatus.Applied,
    });
    expect(fixture.finalizeCalls()).toBe(0);

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).resolves.toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
    });
    expect(fixture.rollbackCalls).toEqual([
      fixture.attempt.attemptId,
      fixture.attempt.attemptId,
    ]);
    expect(fixture.finalizeCalls()).toBe(1);
  });

  it("retries ledger finalization from persisted Rejected state without a new timestamp", async () => {
    const fixture = createFixture(IntegrationAttemptStatus.Applied, {
      finalizeError: new Error("ledger finalization failed"),
    });

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).rejects.toThrow("ledger finalization failed");
    expect(fixture.store.get(fixture.attempt.attemptId)).toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "different retry reason",
    })).resolves.toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(fixture.finalizedAt()).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(fixture.store.events).toHaveLength(1);
  });

  it("fails closed when the Git adapter lacks rollback capability", async () => {
    const fixture = createFixture(IntegrationAttemptStatus.Applied, {
      rollbackUnavailable: true,
    });

    await expect(rejectIntegrationAttempt(fixture.deps, {
      attemptId: fixture.attempt.attemptId,
      reason: "integration rejected",
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.OutputRollbackFailed,
      evidence: ["git_output_rollback_unavailable"],
    });
    expect(fixture.finalizeCalls()).toBe(0);
  });
});

function createFixture(
  status: IntegrationAttemptStatus,
  options: {
    readonly locks?: WorkspaceLockPort;
    readonly requiredChecks?: readonly ProjectIntegrationCheckSpec[];
    readonly finalizeError?: Error;
    readonly rollbackError?: Error;
    readonly rollbackUnavailable?: boolean;
  } = {},
) {
  const attempt = integrationAttempt(status, options.requiredChecks ?? []);
  const store = new MemoryAttemptStore(attempt);
  const rollbackCalls: string[] = [];
  const lockEvents: string[] = [];
  let prepareCalls = 0;
  let finalizeCalls = 0;
  let finalizeError = options.finalizeError;
  const finalizedAt: string[] = [];
  const git = options.rollbackUnavailable
    ? ({} as GitPort)
    : ({
        rollbackWorkerOutput: (input: { readonly attempt: IntegrationAttempt }) => {
          rollbackCalls.push(input.attempt.attemptId);
          if (options.rollbackError) throw options.rollbackError;
        },
      } as GitPort);
  const defaultLocks: WorkspaceLockPort = {
    acquire(input) {
      lockEvents.push("acquire");
      return { lockId: "lock-1", ...input };
    },
    release() {
      lockEvents.push("release");
    },
  };
  const locks = options.locks ?? defaultLocks;
  const ledger = {
    async prepareRejection() {
      prepareCalls += 1;
      return {
        attemptId: attempt.attemptId,
        workerJobId: attempt.workerJobId,
        workerWorkspacePath: attempt.sourceWorkspacePath,
        archivePath: "/archive",
        statusPath: "/archive/status",
        patchPath: "/archive/output.patch",
        numstatPath: "/archive/output.numstat",
        hasAuthoredOutput: true,
      };
    },
    async finalizeRejection(input: { readonly rejectedAt: string }) {
      finalizeCalls += 1;
      finalizedAt.push(input.rejectedAt);
      if (finalizeError) {
        const error = finalizeError;
        finalizeError = undefined;
        throw error;
      }
      return {
        ledgerPath: "/ledger/rejected.json",
        archivePath: "/archive",
        status: "rejected" as const,
        idempotentReplay: false,
      };
    },
  } as unknown as IntegratedOutputLedgerPort;
  return {
    attempt,
    store,
    rollbackCalls,
    lockEvents,
    prepareCalls: () => prepareCalls,
    finalizeCalls: () => finalizeCalls,
    finalizedAt: () => finalizedAt,
    deps: {
      store,
      git,
      locks,
      integratedOutputLedger: ledger,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    },
  };
}

function integrationAttempt(
  status: IntegrationAttemptStatus,
  requiredChecks: readonly ProjectIntegrationCheckSpec[],
): IntegrationAttempt {
  return {
    attemptId: "attempt-1",
    projectId: "project-1",
    controllerJobId: "controller-1",
    workerJobId: "worker-1",
    sourceWorkspacePath: "/work/worker",
    targetWorkspacePath: "/work/main",
    targetBranch: "main",
    targetRemote: "origin",
    expectedFiles: ["src/memory.ts"],
    status,
    workerOutput: {
      workerJobId: "worker-1",
      workspacePath: "/work/worker",
      patchPath: "/evidence/output.patch",
      patchSha256: "a".repeat(64),
      baseCommit: "b".repeat(40),
      targetCommit: "b".repeat(40),
      changedFiles: ["src/memory.ts"],
    },
    reviewDecision: {
      reviewedBy: "reviewer-1",
      decision: ReviewDecisionStatus.Approved,
      reason: "reviewed",
      approvedFiles: ["src/memory.ts"],
      requiredChecks,
    },
    checkRuns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class NonBlockingWorkspaceLock implements WorkspaceLockPort {
  private held = false;

  acquire(input: {
    readonly workspacePath: string;
    readonly owner: string;
  }): WorkspaceLock {
    if (this.held) {
      throw new Error("workspace_locked");
    }
    this.held = true;
    return { lockId: `lock-${input.owner}`, ...input };
  }

  release(): void {
    this.held = false;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

class MemoryAttemptStore implements IntegrationAttemptStorePort {
  private current: IntegrationAttempt;
  failNextUpdate: Error | undefined;
  readonly events: IntegrationAuditEvent[] = [];

  constructor(attempt: IntegrationAttempt) {
    this.current = attempt;
  }

  create(attempt: IntegrationAttempt): void {
    this.current = attempt;
  }

  get(attemptId: string): IntegrationAttempt | null {
    return this.current.attemptId === attemptId ? this.current : null;
  }

  update(attempt: IntegrationAttempt): void {
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw error;
    }
    this.current = attempt;
  }

  appendEvent(_attemptId: string, event: IntegrationAuditEvent): void {
    this.events.push(event);
  }
}
