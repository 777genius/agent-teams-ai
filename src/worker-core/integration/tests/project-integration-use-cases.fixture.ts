import {
  AccessBoundary,
  CheckRunStatus,
  ReviewDecisionStatus,
  SecretScanStatus,
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

export const MERGE_TARGET_COMMIT = "a".repeat(40);
export const MERGE_SOURCE_COMMIT = "b".repeat(40);
export const EMPTY_PATCH_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function mergeInput() {
  const base = input();
  const { commitSha: _commitSha, ...workerOutput } = base.workerOutput;
  return {
    ...base,
    merge: {
      sourceRemote: "origin",
      sourceBranch: "base",
      sourceCommit: MERGE_SOURCE_COMMIT,
      expectedTargetCommit: MERGE_TARGET_COMMIT,
    },
    workerOutput: {
      ...workerOutput,
      patchPath: "/evidence/merge-resolution.patch",
      patchSha256: "d".repeat(64),
      baseCommit: MERGE_TARGET_COMMIT,
      changedFiles: ["src/memory.ts"],
    },
    reviewDecision: {
      ...base.reviewDecision,
      approvedFiles: ["src/memory.ts"],
    },
  };
}

export function topologyOnlyMergeInput() {
  const candidate = mergeInput();
  const patchPath = "/evidence/reviewed-empty.patch";
  return {
    ...candidate,
    workerOutput: {
      ...candidate.workerOutput,
      patchPath,
      patchSha256: EMPTY_PATCH_SHA256,
      changedFiles: [],
      evidencePaths: [patchPath],
    },
    reviewDecision: {
      ...candidate.reviewDecision,
      approvedFiles: [],
    },
  };
}

export function input() {
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

export function policy(): ProjectIntegrationPolicy {
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

export function createFixture(options: {
  readonly checkStatus?: CheckRunStatus;
  readonly secretScanStatus?: SecretScanStatus;
  readonly clockNow?: () => Date;
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
    scanner,
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
        clock: {
          now: options.clockNow ??
            (() => new Date("2026-01-01T00:00:00.000Z")),
        },
      };
    },
  };
}

export class FakeIntegratedOutputLedger implements IntegratedOutputLedgerPort {
  prepareError?: Error;
  preflightError?: Error;
  finalizeError?: Error;
  prepareCalls = 0;
  finalizeCalls = 0;
  readonly finalizedAt: string[] = [];
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
    readonly pushedAt: string;
  }) {
    this.finalizeCalls += 1;
    this.finalizedAt.push(input.pushedAt);
    if (this.finalizeError) throw this.finalizeError;
    return {
      ledgerPath: "/ledger/item.json",
      archivePath: input.preparation.archivePath,
      commitSha: input.preparation.commitSha,
      idempotentReplay: false,
    };
  }

  async preflightFinalize() {
    if (this.preflightError) throw this.preflightError;
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

export class MemoryAttemptStore implements IntegrationAttemptStorePort {
  private attempts = new Map<string, IntegrationAttempt>();
  failNextUpdate: Error | undefined;

  constructor(private readonly events: IntegrationAuditEvent[]) {}

  create(attempt: IntegrationAttempt): void {
    if (this.attempts.has(attempt.attemptId)) throw new Error("duplicate");
    this.attempts.set(attempt.attemptId, attempt);
  }

  get(attemptId: string): IntegrationAttempt | null {
    return this.attempts.get(attemptId) ?? null;
  }

  update(attempt: IntegrationAttempt): void {
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw error;
    }
    this.attempts.set(attempt.attemptId, attempt);
  }

  appendEvent(_attemptId: string, event: IntegrationAuditEvent): void {
    this.events.push(event);
  }
}

export class FakeGit implements GitPort {
  readonly calls: string[] = [];
  dirtyFiles: readonly string[] = [];
  branch = "main";
  remoteCommit: string | null = null;
  lastAllowAlreadyApplied: boolean | undefined;
  appliedFiles: readonly string[] = ["src/memory.ts"];
  commitParents: readonly string[] | undefined;
  lastExpectedParentCommits: readonly string[] | undefined;
  lastCommittedFiles: readonly string[] | undefined;
  lastPushedBranch: string | undefined;
  lastExpectedRemoteCommit: string | undefined;
  abortMergeError: Error | undefined;
  changedSinceCommitFiles: readonly string[] | undefined;
  lastChangedSinceCommit: string | undefined;

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
    this.dirtyFiles = this.appliedFiles;
    return { changedFiles: this.appliedFiles };
  }

  diffCheck() {
    this.calls.push("diffCheck");
    return { ok: true };
  }

  changedFilesSinceCommit(input: { readonly commit: string }) {
    this.calls.push("changedSinceCommit");
    this.lastChangedSinceCommit = input.commit;
    return this.changedSinceCommitFiles ?? this.dirtyFiles;
  }

  commit(input: {
    readonly files: readonly string[];
    readonly expectedParentCommits?: readonly string[];
  }) {
    this.calls.push("commit");
    this.lastExpectedParentCommits = input.expectedParentCommits;
    this.lastCommittedFiles = input.files;
    this.dirtyFiles = [];
    return {
      commitSha: "abc123",
      ...(input.expectedParentCommits
        ? { parentCommits: this.commitParents ?? input.expectedParentCommits }
        : {}),
      diffStat: "1 file changed",
    };
  }

  abortMerge() {
    this.calls.push("abortMerge");
    if (this.abortMergeError) throw this.abortMergeError;
    this.dirtyFiles = [];
  }

  push(input: {
    readonly branch: string;
    readonly commitSha: string;
    readonly expectedRemoteCommit?: string;
  }) {
    this.calls.push("push");
    this.lastPushedBranch = input.branch;
    this.lastExpectedRemoteCommit = input.expectedRemoteCommit;
    this.remoteCommit = input.commitSha;
  }

  remoteBranchCommit() {
    this.calls.push("remote");
    return this.remoteCommit;
  }

  currentBranch() {
    this.calls.push("branch");
    return this.branch;
  }
}

export class FakeChecks implements CheckRunnerPort {
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

export class FakeScanner implements SecretScannerPort {
  lastFiles: readonly string[] | undefined;

  constructor(private readonly status: SecretScanStatus) {}

  scanFiles(input: { readonly files: readonly string[] }) {
    this.lastFiles = input.files;
    return {
      status: this.status,
      ...(this.status === SecretScanStatus.Failed
        ? { safeMessage: "secret-like content" }
        : {}),
    };
  }
}

export class FakeLocks implements WorkspaceLockPort {
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
