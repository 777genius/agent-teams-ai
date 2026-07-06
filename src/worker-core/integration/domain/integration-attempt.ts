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
  readonly summaryPath?: string;
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

export type CommitCandidate = {
  readonly commitSha: string;
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
  readonly status: IntegrationAttemptStatus;
  readonly workerOutput: WorkerOutput;
  readonly reviewDecision: ReviewDecision;
  readonly checkRuns: readonly CheckRun[];
  readonly commitCandidate?: CommitCandidate;
  readonly pushAttempt?: PushAttempt;
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
  assertFilesWithinExpected(input.workerOutput.changedFiles, expectedFiles);
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
    status: IntegrationAttemptStatus.Opened,
    workerOutput: {
      ...input.workerOutput,
      changedFiles: normalizeExpectedFiles(input.workerOutput.changedFiles),
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
  assertFilesWithinExpected(changedFiles, attempt.expectedFiles);
  return {
    ...attempt,
    status: IntegrationAttemptStatus.Applied,
    workerOutput: {
      ...attempt.workerOutput,
      changedFiles,
    },
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
  assertFilesWithinExpected(input.commitCandidate.files, attempt.expectedFiles);
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
