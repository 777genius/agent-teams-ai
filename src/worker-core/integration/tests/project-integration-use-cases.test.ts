import { describe, expect, it } from "vitest";

import {
  AccessBoundary,
  CheckRunStatus,
  IntegrationAuditEventType,
  IntegrationAttemptStatus,
  IntegrationError,
  IntegrationErrorReason,
  PushAttemptStatus,
  ReviewDecisionStatus,
  SecretScanStatus,
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  rejectIntegrationAttempt,
  rollupCheckRuns,
  runRequiredChecks,
  type CheckRun,
  type CheckRunnerPort,
  type GitPort,
  type IntegrationAttempt,
  type IntegratedOutputLedgerPort,
  type IntegratedOutputLedgerPreparation,
  type RejectedOutputLedgerPreparation,
  type IntegrationAttemptStorePort,
  type IntegrationAuditEvent,
  type ProjectAccessScope,
  type ProjectIntegrationCheckSpec,
  type ProjectIntegrationPolicy,
  type SecretScannerPort,
  type WorkspaceLock,
  type WorkspaceLockPort,
} from "../../index";

describe("project integration use cases", () => {
  it("opens, applies, checks, commits and pushes a reviewed worker output", async () => {
    const fixture = createFixture();

    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });
    const committed = await commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    const pushed = await pushApprovedCommit(fixture.deps(), {
      attemptId: committed.attemptId,
      policy: policy(),
    });

    expect(pushed).toMatchObject({
      status: IntegrationAttemptStatus.Pushed,
      pushAttempt: {
        status: PushAttemptStatus.Pushed,
        remote: "origin",
        branch: "main",
        commitSha: "abc123",
      },
    });
    expect(fixture.git.calls).toEqual([
      "status",
      "apply",
      "diffCheck",
      "status",
      "commit",
      "branch",
      "push",
    ]);
    expect(fixture.events.map((event) => event.type)).toEqual([
      IntegrationAuditEventType.AttemptOpened,
      IntegrationAuditEventType.AttemptApplied,
      IntegrationAuditEventType.ChecksStarted,
      IntegrationAuditEventType.ChecksPassed,
      IntegrationAuditEventType.CommitCreated,
      IntegrationAuditEventType.Pushed,
    ]);
  });

  it("rejects dirty unrelated target workspaces before applying worker output", async () => {
    const fixture = createFixture();
    fixture.git.dirtyFiles = ["src/unrelated.ts"];
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());

    await expect(applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.DirtyWorkspace,
      evidence: ["src/unrelated.ts"],
    });
    expect(fixture.git.calls).toEqual(["status"]);
  });

  it("allows already-applied recovery only for exact expected dirty files", async () => {
    const recoverable = createFixture();
    recoverable.git.dirtyFiles = ["src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(recoverable.deps(), input());

    await applyWorkerOutput(recoverable.deps(), {
      attemptId: opened.attemptId,
      allowedPreExistingDirtyFiles: ["src/memory.ts"],
    });
    expect(recoverable.git.lastAllowAlreadyApplied).toBe(true);

    const superset = createFixture();
    superset.git.dirtyFiles = ["src/memory.ts"];
    const second = await openProjectIntegrationAttempt(superset.deps(), {
      ...input(),
      attemptId: "attempt-2",
    });
    await applyWorkerOutput(superset.deps(), {
      attemptId: second.attemptId,
      allowedPreExistingDirtyFiles: ["src/memory.ts", "src/extra.ts"],
    });
    expect(superset.git.lastAllowAlreadyApplied).toBe(false);
  });

  it("does not commit when required checks failed", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.InvalidTransition,
    });
    expect(fixture.git.calls).toEqual(["status", "apply"]);
  });

  it("can retry required checks after a transient check failure", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const failed = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    fixture.checks.status = CheckRunStatus.Passed;
    const retried = await runRequiredChecks(fixture.deps(), {
      attemptId: failed.attemptId,
    });

    expect(retried.status).toBe(IntegrationAttemptStatus.ChecksPassed);
    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: retried.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).resolves.toMatchObject({
      status: IntegrationAttemptStatus.CommitCreated,
    });
  });

  it("records terminal consumed-output evidence before marking an attempt rejected", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());

    const rejected = await rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "review rejected",
    });

    expect(rejected).toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
      rejectReason: "review rejected",
      consumedOutputLedger: {
        status: "rejected",
        ledgerPath: "/ledger/rejected.json",
      },
    });
    expect(fixture.ledger.prepareRejectionCalls).toBe(1);
    expect(fixture.ledger.finalizeRejectionCalls).toBe(1);
    expect(fixture.ledger.lastRejectedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(fixture.events.at(-1)?.type).toBe(IntegrationAuditEventType.Rejected);
  });

  it("rolls timed-out required checks into failed integration status", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.TimedOut,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });

    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    expect(checked).toMatchObject({
      status: IntegrationAttemptStatus.ChecksFailed,
      checkRuns: [
        {
          checkId: "test:memory",
          status: CheckRunStatus.TimedOut,
        },
      ],
    });
    expect(rollupCheckRuns(checked.checkRuns)).toEqual({
      status: IntegrationAttemptStatus.ChecksFailed,
      failedCheckIds: ["test:memory"],
    });
    expect(fixture.events.at(-1)?.type).toBe(
      IntegrationAuditEventType.ChecksFailed,
    );
  });

  it("blocks commit when secret scan fails", async () => {
    const fixture = createFixture({
      secretScanStatus: SecretScanStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.SecretScanFailed,
    });
    expect(fixture.git.calls).toEqual([
      "status",
      "apply",
      "diffCheck",
      "status",
    ]);
  });

  it("fails before git push when ledger preparation is unavailable", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.ledger.prepareError = new Error("ledger_not_writable");

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    })).rejects.toThrow("ledger_not_writable");
    expect(fixture.git.calls).not.toContain("push");
  });

  it("does not mark an attempt pushed when ledger finalization fails", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.ledger.finalizeError = new Error("ledger_finalize_failed");

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    })).rejects.toThrow("ledger_finalize_failed");
    expect(fixture.git.calls).toContain("push");
    expect(fixture.store.get(opened.attemptId)?.status)
      .toBe(IntegrationAttemptStatus.CommitCreated);
  });

  it("re-verifies ledger evidence when a pushed attempt is replayed", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });

    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(1);
    expect(fixture.ledger.prepareCalls).toBe(2);
    expect(fixture.ledger.finalizeCalls).toBe(2);
  });

  it("fails closed when opening an attempt outside branch policy", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      targetBranch: "feature/outside",
    })).rejects.toBeInstanceOf(IntegrationError);
  });

  it("opens an attempt when an allowed path prefix has a trailing slash", async () => {
    const fixture = createFixture();
    const base = input();
    const approvedFile = "src/worker-codex/codex-goal-runner.ts";

    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...base,
      policy: {
        ...policy(),
        allowedPathPrefixes: ["src/worker-codex/"],
      },
      workerOutput: {
        ...base.workerOutput,
        changedFiles: [approvedFile],
      },
      reviewDecision: {
        ...base.reviewDecision,
        approvedFiles: [approvedFile],
      },
    });

    expect(opened.expectedFiles).toEqual([approvedFile]);
    expect(fixture.events).toMatchObject([
      {
        type: IntegrationAuditEventType.AttemptOpened,
        files: [approvedFile],
      },
    ]);
  });

  it("blocks stale worker output until review policy allows a rebase check", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      workerOutput: {
        ...input().workerOutput,
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
        baseRevisionReasons: ["target_advanced", "output_changed_on_stale_base"],
      },
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.StaleBase,
      evidence: [
        "base:abc1234",
        "target:def5678",
        "target_advanced",
        "output_changed_on_stale_base",
      ],
    });
  });

  it("allows stale worker output when integration policy explicitly accepts it", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      policy: {
        ...policy(),
        allowStaleBase: true,
      },
      workerOutput: {
        ...input().workerOutput,
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
        baseRevisionReasons: ["target_advanced", "output_changed_on_stale_base"],
      },
    })).resolves.toMatchObject({
      workerOutput: {
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
      },
    });
  });
});

function input() {
  return {
    policy: policy(),
    attemptId: "attempt-1",
    projectId: "infinity-context",
    controllerJobId: "infinity-context-controller",
    sourceWorkspacePath: "/work/infinity-context-child",
    targetWorkspacePath: "/work/infinity-context-main",
    targetBranch: "main",
    targetRemote: "origin",
    workerOutput: {
      workerJobId: "infinity-context-child-v1",
      workspacePath: "/work/infinity-context-child",
      commitSha: "def456",
      changedFiles: ["src/memory.ts"],
    },
    reviewDecision: {
      reviewedBy: "controller",
      decision: ReviewDecisionStatus.Approved,
      reason: "focused worker output reviewed",
      approvedFiles: ["src/memory.ts"],
      requiredChecks: [
        {
          checkId: "test:memory",
          command: ["npm", "test", "--", "memory"],
        },
      ],
    },
  };
}

function policy(): ProjectIntegrationPolicy {
  return {
    access: {
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    },
    allowedPathPrefixes: ["src"],
    requiredCheckIds: ["test:memory"],
  };
}

function scope(): ProjectAccessScope {
  return {
    projectId: "infinity-context",
    workspaceRoots: [
      "/work/infinity-context-main",
      "/work/infinity-context-child",
    ],
    worktreeRoots: ["/work/infinity-context-child"],
    registryRoot: "/var/data/worker-jobs/registry",
    jobIdPrefixes: ["infinity-context-"],
    tmuxSessionPrefixes: ["infinity-context-"],
    allowedBranches: ["main"],
    allowedGitRemotes: ["origin"],
  };
}

function createFixture(options: {
  readonly checkStatus?: CheckRunStatus;
  readonly secretScanStatus?: SecretScanStatus;
} = {}) {
  const events: IntegrationAuditEvent[] = [];
  const store = new MemoryAttemptStore(events);
  const git = new FakeGit();
  const locks = new FakeLocks();
  const checks = new FakeChecks(options.checkStatus ?? CheckRunStatus.Passed);
  const scanner = new FakeScanner(
    options.secretScanStatus ?? SecretScanStatus.Passed,
  );
  const ledger = new FakeIntegratedOutputLedger();
  return {
    events,
    checks,
    git,
    ledger,
    store,
    deps() {
      return {
        store,
        git,
        commitIdentity: {
          approvedIdentity: () => ({
            name: "Approved Integrator",
            email: "integrator@example.com",
          }),
        },
        integratedOutputLedger: ledger,
        locks,
        checks,
        scanner,
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      };
    },
  };
}

class FakeIntegratedOutputLedger implements IntegratedOutputLedgerPort {
  prepareError?: Error;
  finalizeError?: Error;
  prepareCalls = 0;
  finalizeCalls = 0;
  prepareRejectionCalls = 0;
  finalizeRejectionCalls = 0;
  lastRejectedAt?: string;

  async prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation> {
    this.prepareCalls += 1;
    if (this.prepareError) throw this.prepareError;
    return {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      commitSha: input.commitSha,
      archivePath: "/archive",
      statusPath: "/archive/status",
      patchPath: "/archive/patch",
      numstatPath: "/archive/numstat",
    };
  }

  async finalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
  }) {
    this.finalizeCalls += 1;
    if (this.finalizeError) throw this.finalizeError;
    return {
      ledgerPath: "/ledger/item.json",
      archivePath: input.preparation.archivePath,
      commitSha: input.preparation.commitSha,
      idempotentReplay: false,
    };
  }

  async prepareRejection(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<RejectedOutputLedgerPreparation> {
    this.prepareRejectionCalls += 1;
    return {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      archivePath: "/archive/rejected",
      statusPath: "/archive/rejected/status",
      patchPath: "/archive/rejected/patch",
      numstatPath: "/archive/rejected/numstat",
      hasAuthoredOutput: true,
    };
  }

  async finalizeRejection(input: {
    readonly preparation: RejectedOutputLedgerPreparation;
    readonly rejectedAt: string;
  }) {
    this.finalizeRejectionCalls += 1;
    this.lastRejectedAt = input.rejectedAt;
    return {
      ledgerPath: "/ledger/rejected.json",
      archivePath: input.preparation.archivePath,
      status: "rejected" as const,
      idempotentReplay: false,
    };
  }
}

class MemoryAttemptStore implements IntegrationAttemptStorePort {
  private attempts = new Map<string, IntegrationAttempt>();

  constructor(private readonly events: IntegrationAuditEvent[]) {}

  create(attempt: IntegrationAttempt): void {
    if (this.attempts.has(attempt.attemptId)) throw new Error("duplicate");
    this.attempts.set(attempt.attemptId, attempt);
  }

  get(attemptId: string): IntegrationAttempt | null {
    return this.attempts.get(attemptId) ?? null;
  }

  update(attempt: IntegrationAttempt): void {
    this.attempts.set(attempt.attemptId, attempt);
  }

  appendEvent(_attemptId: string, event: IntegrationAuditEvent): void {
    this.events.push(event);
  }
}

class FakeGit implements GitPort {
  readonly calls: string[] = [];
  dirtyFiles: readonly string[] = [];
  branch = "main";
  lastAllowAlreadyApplied: boolean | undefined;

  getStatus() {
    this.calls.push("status");
    return {
      branch: this.branch,
      dirtyFiles: this.dirtyFiles,
    };
  }

  applyWorkerOutput(input: { readonly allowAlreadyApplied?: boolean }) {
    this.calls.push("apply");
    this.lastAllowAlreadyApplied = input.allowAlreadyApplied;
    this.dirtyFiles = ["src/memory.ts"];
    return { changedFiles: ["src/memory.ts"] };
  }

  diffCheck() {
    this.calls.push("diffCheck");
    return { ok: true };
  }

  commit() {
    this.calls.push("commit");
    this.dirtyFiles = [];
    return {
      commitSha: "abc123",
      diffStat: "1 file changed",
    };
  }

  push() {
    this.calls.push("push");
  }

  currentBranch() {
    this.calls.push("branch");
    return this.branch;
  }
}

class FakeChecks implements CheckRunnerPort {
  constructor(public status: CheckRunStatus) {}

  runCheck(input: {
    readonly check: ProjectIntegrationCheckSpec;
    readonly startedAt: string;
  }): CheckRun {
    return {
      checkId: input.check.checkId,
      command: input.check.command,
      status: this.status,
      startedAt: input.startedAt,
      completedAt: input.startedAt,
      exitCode: this.status === CheckRunStatus.Passed ? 0 : 1,
    };
  }
}

class FakeScanner implements SecretScannerPort {
  constructor(private readonly status: SecretScanStatus) {}

  scanFiles() {
    return {
      status: this.status,
      ...(this.status === SecretScanStatus.Failed
        ? { safeMessage: "secret-like content" }
        : {}),
    };
  }
}

class FakeLocks implements WorkspaceLockPort {
  acquire(input: {
    readonly workspacePath: string;
    readonly owner: string;
  }): WorkspaceLock {
    return {
      lockId: "lock-1",
      workspacePath: input.workspacePath,
      owner: input.owner,
    };
  }

  release(_lock: WorkspaceLock): void {}
}
