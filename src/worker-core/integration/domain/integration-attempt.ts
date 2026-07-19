import { isAbsolute, posix } from "node:path";

import type { BaseRevisionStatus } from "../../base-revision";
import {
  IntegrationError,
  IntegrationErrorReason,
} from "./integration-errors";

export enum IntegrationAttemptStatus {
  Opened = "opened",
  Applied = "applied",
  ChecksRunning = "checks_running",
  ChecksFailed = "checks_failed",
  ChecksPassed = "checks_passed",
  CommitCreated = "commit_created",
  Pushed = "pushed",
  Rejected = "rejected",
}

export enum ReviewDecisionStatus {
  Approved = "approved",
  Rejected = "rejected",
  NeedsHuman = "needs_human",
}

export enum CheckRunStatus {
  Passed = "passed",
  Failed = "failed",
  TimedOut = "timed_out",
}

export enum SecretScanStatus {
  Passed = "passed",
  Failed = "failed",
}

export enum PushAttemptStatus {
  Pushed = "pushed",
  Failed = "failed",
}

export type ProjectIntegrationCheckSpec = {
  readonly checkId: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
};

export type WorkerOutput = {
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly commitSha?: string;
  readonly patchPath?: string;
  readonly patchSha256?: string;
  readonly sourcePatchPath?: string;
  readonly summaryPath?: string;
  readonly handoffManifestPath?: string;
  readonly handoffManifestSha256?: string;
  readonly baseCommit?: string;
  readonly targetCommit?: string;
  readonly baseStatus?: BaseRevisionStatus;
  readonly baseRevisionReasons?: readonly string[];
  readonly changedFiles: readonly string[];
  readonly evidencePaths?: readonly string[];
};

export type ReviewDecision = {
  readonly reviewedBy: string;
  readonly decision: ReviewDecisionStatus;
  readonly reason: string;
  readonly approvedFiles: readonly string[];
  readonly requiredChecks: readonly ProjectIntegrationCheckSpec[];
  readonly riskyPaths?: readonly string[];
};

export type CheckRun = {
  readonly checkId: string;
  readonly command: readonly string[];
  readonly status: CheckRunStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode?: number;
  readonly safeOutputTail?: string;
};

export type CheckRunRollup = {
  readonly status:
    | IntegrationAttemptStatus.ChecksFailed
    | IntegrationAttemptStatus.ChecksPassed;
  readonly failedCheckIds: readonly string[];
};

export type MergeIntegrationPlan = {
  readonly sourceRemote: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly expectedTargetCommit: string;
};

export type CommitCandidate = {
  readonly commitSha: string;
  readonly parentCommits?: readonly string[];
  readonly message: string;
  readonly files: readonly string[];
  readonly diffStat?: string;
  readonly secretScanStatus: SecretScanStatus;
  readonly createdAt: string;
};

export type PushAttempt = {
  readonly remote: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly status: PushAttemptStatus;
  readonly pushedAt: string;
};

export type IntegrationAttempt = {
  readonly attemptId: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId: string;
  readonly sourceWorkspacePath: string;
  readonly targetWorkspacePath: string;
  readonly targetBranch: string;
  readonly targetRemote: string;
  readonly expectedFiles: readonly string[];
  readonly merge?: MergeIntegrationPlan;
  readonly appliedFiles?: readonly string[];
  readonly status: IntegrationAttemptStatus;
  readonly workerOutput: WorkerOutput;
  readonly reviewDecision: ReviewDecision;
  readonly checkRuns: readonly CheckRun[];
  readonly commitCandidate?: CommitCandidate;
  readonly pushAttempt?: PushAttempt;
  readonly promotionAttempts?: readonly PushAttempt[];
  readonly rejectReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type OpenIntegrationAttemptInput = {
  readonly attemptId: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly sourceWorkspacePath: string;
  readonly targetWorkspacePath: string;
  readonly targetBranch: string;
  readonly targetRemote: string;
  readonly merge?: MergeIntegrationPlan;
  readonly workerOutput: WorkerOutput;
  readonly reviewDecision: ReviewDecision;
  readonly now: string;
};

export function openIntegrationAttempt(
  input: OpenIntegrationAttemptInput,
): IntegrationAttempt {
  if (input.reviewDecision.decision !== ReviewDecisionStatus.Approved) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "integration_attempt_requires_approved_review",
    });
  }
  const expectedFiles = normalizeExpectedFiles(input.reviewDecision.approvedFiles);
  const merge = input.merge
    ? normalizeMergeIntegrationPlan(input.merge, input.workerOutput)
    : undefined;
  if (!merge || input.workerOutput.changedFiles.length > 0) {
    assertFilesWithinExpected(input.workerOutput.changedFiles, expectedFiles);
  }
  return {
    attemptId: input.attemptId,
    projectId: input.projectId,
    controllerJobId: input.controllerJobId,
    workerJobId: input.workerOutput.workerJobId,
    sourceWorkspacePath: input.sourceWorkspacePath,
    targetWorkspacePath: input.targetWorkspacePath,
    targetBranch: input.targetBranch,
    targetRemote: input.targetRemote,
    expectedFiles,
    ...(merge ? { merge } : {}),
    status: IntegrationAttemptStatus.Opened,
    workerOutput: {
      ...input.workerOutput,
      changedFiles:
        merge && input.workerOutput.changedFiles.length === 0
          ? []
          : normalizeExpectedFiles(input.workerOutput.changedFiles),
    },
    reviewDecision: {
      ...input.reviewDecision,
      approvedFiles: expectedFiles,
    },
    checkRuns: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function markWorkerOutputApplied(
  attempt: IntegrationAttempt,
  input: {
    readonly changedFiles: readonly string[];
    readonly now: string;
  },
): IntegrationAttempt {
  assertStatus(attempt, [IntegrationAttemptStatus.Opened]);
  const changedFiles = normalizeExpectedFiles(input.changedFiles);
  assertIntegrationAppliedFiles(attempt, changedFiles);
  return {
    ...attempt,
    status: IntegrationAttemptStatus.Applied,
    ...(attempt.merge
      ? { appliedFiles: changedFiles }
      : {
          workerOutput: {
            ...attempt.workerOutput,
            changedFiles,
          },
        }),
    updatedAt: input.now,
  };
}

export function markChecksRunning(
  attempt: IntegrationAttempt,
  now: string,
): IntegrationAttempt {
  assertStatus(attempt, [
    IntegrationAttemptStatus.Applied,
    IntegrationAttemptStatus.ChecksFailed,
  ]);
  return {
    ...attempt,
    status: IntegrationAttemptStatus.ChecksRunning,
    updatedAt: now,
  };
}

export function recordCheckRuns(
  attempt: IntegrationAttempt,
  input: {
    readonly checkRuns: readonly CheckRun[];
    readonly now: string;
  },
): IntegrationAttempt {
  assertStatus(attempt, [IntegrationAttemptStatus.ChecksRunning]);
  return {
    ...attempt,
    status: integrationStatusForCheckRuns(input.checkRuns),
    checkRuns: input.checkRuns,
    updatedAt: input.now,
  };
}

export function allCheckRunsPassed(checkRuns: readonly CheckRun[]): boolean {
  return checkRuns.every((run) => run.status === CheckRunStatus.Passed);
}

export function integrationStatusForCheckRuns(
  checkRuns: readonly CheckRun[],
): IntegrationAttemptStatus.ChecksFailed | IntegrationAttemptStatus.ChecksPassed {
  return rollupCheckRuns(checkRuns).status;
}

export function rollupCheckRuns(checkRuns: readonly CheckRun[]): CheckRunRollup {
  const failedCheckIds = [
    ...new Set(checkRuns
      .filter((run) => run.status !== CheckRunStatus.Passed)
      .map((run) => run.checkId)),
  ].sort();
  return {
    status: failedCheckIds.length > 0
      ? IntegrationAttemptStatus.ChecksFailed
      : IntegrationAttemptStatus.ChecksPassed,
    failedCheckIds,
  };
}

export function markCommitCreated(
  attempt: IntegrationAttempt,
  input: {
    readonly commitCandidate: CommitCandidate;
    readonly now: string;
  },
): IntegrationAttempt {
  assertStatus(attempt, [IntegrationAttemptStatus.ChecksPassed]);
  assertIntegrationCommitFiles(attempt, input.commitCandidate.files);
  if (attempt.merge) {
    assertMergeCommitParents(
      input.commitCandidate.parentCommits,
      attempt.merge,
    );
  }
  return {
    ...attempt,
    status: IntegrationAttemptStatus.CommitCreated,
    commitCandidate: {
      ...input.commitCandidate,
      files: normalizeExpectedFiles(input.commitCandidate.files),
    },
    updatedAt: input.now,
  };
}

export function integrationAppliedFiles(
  attempt: IntegrationAttempt,
): readonly string[] {
  return attempt.appliedFiles ?? attempt.workerOutput.changedFiles;
}

export function assertIntegrationAppliedFiles(
  attempt: IntegrationAttempt,
  files: readonly string[],
): void {
  if (!attempt.merge) {
    assertFilesWithinExpected(files, attempt.expectedFiles);
    return;
  }
  if (attempt.workerOutput.changedFiles.length > 0) {
    assertFilesInclude(
      files,
      attempt.workerOutput.changedFiles,
      "reviewed_merge_patch_files_missing",
    );
  }
}

export function assertIntegrationCommitFiles(
  attempt: IntegrationAttempt,
  files: readonly string[],
): void {
  if (!attempt.merge) {
    assertFilesWithinExpected(files, attempt.expectedFiles);
    return;
  }
  assertSameFiles(
    files,
    integrationAppliedFiles(attempt),
    "merge_commit_files_mismatch",
  );
}

export function assertMergeCommitParents(
  parentCommits: readonly string[] | undefined,
  merge: MergeIntegrationPlan,
): void {
  const expected = [merge.expectedTargetCommit, merge.sourceCommit];
  if (
    !parentCommits ||
    parentCommits.length !== expected.length ||
    !parentCommits.every((parent, index) => parent === expected[index])
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeParentsMismatch,
      evidence: [
        `expected:${expected.join(",")}`,
        `actual:${parentCommits?.join(",") ?? "missing"}`,
      ],
    });
  }
}

function normalizeMergeIntegrationPlan(
  merge: MergeIntegrationPlan,
  workerOutput: WorkerOutput,
): MergeIntegrationPlan {
  const normalized = {
    sourceRemote: requiredMergeValue(merge.sourceRemote, "source_remote"),
    sourceBranch: requiredMergeValue(merge.sourceBranch, "source_branch"),
    sourceCommit: normalizeMergeCommit(merge.sourceCommit, "source_commit"),
    expectedTargetCommit: normalizeMergeCommit(
      merge.expectedTargetCommit,
      "expected_target_commit",
    ),
  };
  if (normalized.sourceCommit === normalized.expectedTargetCommit) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidMergePlan,
      evidence: ["merge_parents_must_differ"],
    });
  }
  if (workerOutput.baseCommit !== normalized.expectedTargetCommit) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidMergePlan,
      evidence: [
        `worker_base:${workerOutput.baseCommit ?? "missing"}`,
        `target:${normalized.expectedTargetCommit}`,
      ],
    });
  }
  if (!workerOutput.patchPath || !workerOutput.patchSha256) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidMergePlan,
      evidence: ["reviewed_resolution_patch_required"],
    });
  }
  return normalized;
}

function normalizeMergeCommit(value: string, field: string): string {
  const normalized = requiredMergeValue(value, field).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidMergePlan,
      evidence: [`${field}_invalid`],
    });
  }
  return normalized;
}

function requiredMergeValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidMergePlan,
      evidence: [`${field}_required`],
    });
  }
  return normalized;
}

export function markPushed(
  attempt: IntegrationAttempt,
  input: {
    readonly pushAttempt: PushAttempt;
    readonly now: string;
  },
): IntegrationAttempt {
  assertStatus(attempt, [IntegrationAttemptStatus.CommitCreated]);
  if (!attempt.commitCandidate) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "commit_candidate_required",
    });
  }
  if (input.pushAttempt.commitSha !== attempt.commitCandidate.commitSha) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "push_commit_sha_mismatch",
    });
  }
  return {
    ...attempt,
    status: IntegrationAttemptStatus.Pushed,
    pushAttempt: input.pushAttempt,
    updatedAt: input.now,
  };
}

export function markPromoted(
  attempt: IntegrationAttempt,
  input: {
    readonly promotionAttempt: PushAttempt;
    readonly now: string;
  },
): IntegrationAttempt {
  assertStatus(attempt, [IntegrationAttemptStatus.Pushed]);
  if (!attempt.commitCandidate || !attempt.pushAttempt) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "pushed_commit_candidate_required",
    });
  }
  if (input.promotionAttempt.commitSha !== attempt.commitCandidate.commitSha) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "promotion_commit_sha_mismatch",
    });
  }
  return {
    ...attempt,
    promotionAttempts: [
      ...(attempt.promotionAttempts ?? []),
      input.promotionAttempt,
    ],
    updatedAt: input.now,
  };
}

export function markRejected(
  attempt: IntegrationAttempt,
  input: {
    readonly reason: string;
    readonly now: string;
  },
): IntegrationAttempt {
  assertNotTerminal(attempt);
  return {
    ...attempt,
    status: IntegrationAttemptStatus.Rejected,
    rejectReason: input.reason,
    updatedAt: input.now,
  };
}

export function normalizeExpectedFiles(paths: readonly string[]): readonly string[] {
  const normalized = [...new Set(paths.map(normalizeProjectRelativePath))].sort();
  if (normalized.length === 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidPath,
      message: "expected_files_required",
    });
  }
  return normalized;
}

export function normalizeProjectRelativePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidPath,
      evidence: [path],
    });
  }
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    segments.includes("..") ||
    segments.includes(".git")
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidPath,
      evidence: [path],
    });
  }
  return normalized;
}

export function assertFilesWithinExpected(
  files: readonly string[],
  expectedFiles: readonly string[],
): void {
  const expected = new Set(normalizeExpectedFiles(expectedFiles));
  const outside = normalizeExpectedFiles(files).filter((file) => !expected.has(file));
  if (outside.length > 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.PathOutsideExpectedFiles,
      evidence: outside,
    });
  }
}

function assertFilesInclude(
  files: readonly string[],
  requiredFiles: readonly string[],
  evidencePrefix: string,
): void {
  const actual = new Set(normalizeExpectedFiles(files));
  const missing = normalizeExpectedFiles(requiredFiles).filter(
    (file) => !actual.has(file),
  );
  if (missing.length > 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.UnexpectedFiles,
      evidence: [`${evidencePrefix}:${missing.join(",")}`],
    });
  }
}

function assertSameFiles(
  files: readonly string[],
  expectedFiles: readonly string[],
  evidencePrefix: string,
): void {
  const actual = normalizeExpectedFiles(files);
  const expected = normalizeExpectedFiles(expectedFiles);
  if (
    actual.length !== expected.length ||
    !actual.every((file, index) => file === expected[index])
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.UnexpectedFiles,
      evidence: [
        `${evidencePrefix}:expected=${expected.join(",")};actual=${actual.join(",")}`,
      ],
    });
  }
}

export function assertStatus(
  attempt: IntegrationAttempt,
  allowed: readonly IntegrationAttemptStatus[],
): void {
  if (!allowed.includes(attempt.status)) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      evidence: [attempt.status],
    });
  }
}

export function assertNotTerminal(attempt: IntegrationAttempt): void {
  if (
    attempt.status === IntegrationAttemptStatus.Pushed ||
    attempt.status === IntegrationAttemptStatus.Rejected
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      evidence: [attempt.status],
    });
  }
}

export function isConventionalCommitMessage(message: string): boolean {
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?: .+/.test(
    message,
  );
}
