import { posix } from "node:path";

import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  integrationAppliedFiles,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
} from "./integration-attempt";

export type OperatorArtifactRecoveryPermit = {
  readonly schemaVersion: 1;
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly expectedAttemptStatus: IntegrationAttemptStatus.ChecksPassed;
  readonly targetWorkspacePath: string;
  readonly targetBranch: string;
  readonly targetHeadSha: string;
  readonly candidatePatchSha256: string;
  readonly candidatePatchSize: number;
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly mode: number;
    readonly mtimeMs: number;
    readonly mtimeToleranceMs?: number;
  };
  readonly check: {
    readonly checkId: string;
    readonly command: readonly string[];
    readonly startedAt: string;
    readonly completedAt: string;
  };
};

export type ValidatedOperatorArtifactRecovery = {
  readonly appliedFiles: readonly string[];
  readonly artifactPath: string;
  readonly expectedDirtyFiles: readonly string[];
};

export function validateOperatorArtifactRecoveryAttempt(input: {
  readonly attempt: IntegrationAttempt;
  readonly permit: OperatorArtifactRecoveryPermit;
}): ValidatedOperatorArtifactRecovery {
  const { attempt, permit } = input;
  assertEqual(
    attempt.controllerJobId,
    permit.controllerJobId,
    "controller_mismatch",
  );
  assertEqual(attempt.projectId, permit.projectId, "project_mismatch");
  assertEqual(attempt.attemptId, permit.attemptId, "attempt_mismatch");
  assertEqual(attempt.status, permit.expectedAttemptStatus, "status_mismatch");
  assertEqual(
    attempt.targetWorkspacePath,
    permit.targetWorkspacePath,
    "workspace_mismatch",
  );
  assertEqual(attempt.targetBranch, permit.targetBranch, "branch_mismatch");

  if (!/^[a-f0-9]{40}$/i.test(permit.targetHeadSha)) {
    throw new Error("operator_artifact_recovery_head_invalid");
  }
  assertSha256(permit.candidatePatchSha256, "candidate_patch_sha256_invalid");
  assertSafeSize(permit.candidatePatchSize, "candidate_patch_size_invalid");
  if (!attempt.workerOutput.patchPath || !attempt.workerOutput.patchSha256) {
    throw new Error("operator_artifact_recovery_patch_source_required");
  }
  assertEqual(
    (
      attempt.workerOutput.targetCommit ??
      attempt.workerOutput.baseCommit ??
      ""
    ).toLowerCase(),
    permit.targetHeadSha.toLowerCase(),
    "target_commit_mismatch",
  );
  assertEqual(
    attempt.workerOutput.patchSha256.toLowerCase(),
    permit.candidatePatchSha256.toLowerCase(),
    "candidate_patch_mismatch",
  );

  assertSha256(permit.artifact.sha256, "artifact_sha256_invalid");
  assertSafeSize(permit.artifact.size, "artifact_size_invalid");
  if (
    !Number.isInteger(permit.artifact.mode) ||
    permit.artifact.mode < 0 ||
    permit.artifact.mode > 0o777
  ) {
    throw new Error("operator_artifact_recovery_artifact_mode_invalid");
  }
  if (
    !Number.isFinite(permit.artifact.mtimeMs) ||
    permit.artifact.mtimeMs < 0
  ) {
    throw new Error("operator_artifact_recovery_artifact_mtime_invalid");
  }
  if (
    permit.artifact.mtimeToleranceMs !== undefined &&
    (!Number.isInteger(permit.artifact.mtimeToleranceMs) ||
      permit.artifact.mtimeToleranceMs < 0 ||
      permit.artifact.mtimeToleranceMs > 2_000)
  ) {
    throw new Error(
      "operator_artifact_recovery_artifact_mtime_tolerance_invalid",
    );
  }
  const artifactPath = normalizeProjectRelativePath(permit.artifact.path);
  if (
    artifactPath === "." ||
    artifactPath.endsWith("/") ||
    posix.basename(artifactPath) === ""
  ) {
    throw new Error("operator_artifact_recovery_artifact_path_invalid");
  }

  const matchingCheckRuns = attempt.checkRuns.filter(
    (run) => run.checkId === permit.check.checkId,
  );
  if (matchingCheckRuns.length !== 1) {
    throw new Error("operator_artifact_recovery_check_provenance_ambiguous");
  }
  const checkRun = matchingCheckRuns[0]!;
  const checkStartedAt = Date.parse(permit.check.startedAt);
  const checkCompletedAt = Date.parse(permit.check.completedAt);
  if (
    !Number.isFinite(checkStartedAt) ||
    !Number.isFinite(checkCompletedAt) ||
    checkStartedAt > checkCompletedAt
  ) {
    throw new Error("operator_artifact_recovery_check_time_invalid");
  }
  if (
    checkRun.status !== CheckRunStatus.Passed ||
    !sameStrings(checkRun.command, permit.check.command) ||
    checkRun.startedAt !== permit.check.startedAt ||
    checkRun.completedAt !== permit.check.completedAt
  ) {
    throw new Error("operator_artifact_recovery_check_provenance_mismatch");
  }

  const appliedFiles = uniqueSorted(integrationAppliedFiles(attempt));
  if (appliedFiles.includes(artifactPath)) {
    throw new Error("operator_artifact_recovery_artifact_overlaps_output");
  }
  return {
    appliedFiles,
    artifactPath,
    expectedDirtyFiles: uniqueSorted([...appliedFiles, artifactPath]),
  };
}

function assertEqual(actual: string, expected: string, reason: string): void {
  if (actual !== expected) {
    throw new Error(`operator_artifact_recovery_${reason}`);
  }
}

function assertSha256(value: string, reason: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`operator_artifact_recovery_${reason}`);
  }
}

function assertSafeSize(value: number, reason: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`operator_artifact_recovery_${reason}`);
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
