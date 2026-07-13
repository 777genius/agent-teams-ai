import {
  ReviewDecisionStatus,
  type ProjectIntegrationCheckSpec,
  type ReviewDecision,
  type WorkerOutput,
} from "@vioxen/subscription-runtime/worker-core";

export const reviewedWorkerOutputFormat = "reviewed-worker-output";

export type ReviewedWorkerOutputSnapshot = {
  readonly format: typeof reviewedWorkerOutputFormat;
  readonly formatRevision: 1;
  readonly reviewedOutputId: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly sourceWorkspacePath: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly patchByteLength: number;
  readonly baseCommit: string;
  readonly changedFiles: readonly string[];
  readonly reviewDecision: ReviewDecision;
  readonly capturedAt: string;
};

export type CaptureReviewedWorkerOutputInput = {
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly expectedPatchSha256: string;
  readonly decision: ReviewDecisionStatus;
  readonly reviewedBy: string;
  readonly reason: string;
  readonly approvedFiles: readonly string[];
  readonly requiredChecks: readonly ProjectIntegrationCheckSpec[];
};

export type ReviewedWorkerOutputWorkspaceSnapshot = {
  readonly patch: string;
  readonly baseCommit: string;
  readonly changedFiles: readonly string[];
};

export type ReviewedWorkerOutputIdentity = Pick<
  ReviewedWorkerOutputSnapshot,
  | "format"
  | "formatRevision"
  | "projectId"
  | "controllerJobId"
  | "workerJobId"
  | "taskId"
  | "sourceWorkspacePath"
  | "baseCommit"
  | "patchSha256"
  | "changedFiles"
  | "reviewDecision"
>;

export type ReviewedWorkerOutputReviewAttestation = {
  readonly format: "reviewed-worker-output-review-attestation";
  readonly formatRevision: 1;
  readonly reviewedOutputId: string;
  readonly reviewMarkerPath: string;
  readonly reviewMarkerSha256: string;
  readonly committedAt: string;
};

export function reviewedWorkerOutputIdentityPayload(
  input: ReviewedWorkerOutputIdentity,
): string {
  return JSON.stringify({
    format: input.format,
    formatRevision: input.formatRevision,
    projectId: input.projectId,
    controllerJobId: input.controllerJobId,
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    sourceWorkspacePath: input.sourceWorkspacePath,
    baseCommit: input.baseCommit,
    patchSha256: input.patchSha256,
    changedFiles: input.changedFiles,
    reviewDecision: input.reviewDecision,
  });
}

export function reviewedOutputAsWorkerOutput(
  snapshot: ReviewedWorkerOutputSnapshot,
): WorkerOutput {
  return {
    workerJobId: snapshot.workerJobId,
    workspacePath: snapshot.sourceWorkspacePath,
    patchPath: snapshot.patchPath,
    patchSha256: snapshot.patchSha256,
    baseCommit: snapshot.baseCommit,
    changedFiles: snapshot.changedFiles,
    evidencePaths: [snapshot.patchPath],
  };
}

export function reviewedOutputDecision(input: {
  readonly decision: ReviewDecisionStatus;
  readonly reviewedBy: string;
  readonly reason: string;
  readonly approvedFiles: readonly string[];
  readonly requiredChecks: readonly ProjectIntegrationCheckSpec[];
}): ReviewDecision {
  return {
    reviewedBy: input.reviewedBy,
    decision: input.decision,
    reason: input.reason,
    approvedFiles: input.approvedFiles,
    requiredChecks: input.requiredChecks,
  };
}
