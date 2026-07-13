import { createHash } from "node:crypto";
import {
  assertFilesWithinExpected,
  normalizeExpectedFiles,
  type WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  approvedReviewDecision,
  reviewedOutputAsWorkerOutput,
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputFormat,
  type CaptureReviewedWorkerOutputInput,
  type ReviewedWorkerOutputIdentity,
  type ReviewedWorkerOutputSnapshot,
} from "../domain/reviewed-worker-output";
import type {
  ReviewedWorkerOutputReviewMarkerVerifierPort,
  ReviewedWorkerOutputSnapshotterPort,
  ReviewedWorkerOutputStorePort,
} from "../ports/reviewed-worker-output-ports";

export type ReviewedWorkerOutputDeps = {
  readonly snapshotter: ReviewedWorkerOutputSnapshotterPort;
  readonly store: ReviewedWorkerOutputStorePort;
  readonly locks: WorkspaceLockPort;
  readonly clock?: { now(): Date };
};

export async function captureReviewedWorkerOutput(
  deps: ReviewedWorkerOutputDeps,
  input: CaptureReviewedWorkerOutputInput,
): Promise<ReviewedWorkerOutputSnapshot> {
  const expectedPatchSha256 = normalizeSha256(input.expectedPatchSha256);
  const approvedFiles = normalizeExpectedFiles(input.approvedFiles);
  const lock = await deps.locks.acquire({
    workspacePath: input.workspacePath,
    owner: `reviewed-output:${input.controllerJobId}:${input.workerJobId}`,
  });
  try {
    const captured = await deps.snapshotter.capture({
      workspacePath: input.workspacePath,
    });
    const changedFiles = normalizeExpectedFiles(captured.changedFiles);
    assertFilesWithinExpected(changedFiles, approvedFiles);
    const patchSha256 = sha256(captured.patch);
    if (patchSha256 !== expectedPatchSha256) {
      throw new Error("reviewed_worker_output_patch_hash_mismatch");
    }
    const reviewDecision = approvedReviewDecision({
      reviewedBy: input.reviewedBy,
      reason: input.reason,
      approvedFiles,
      requiredChecks: input.requiredChecks,
    });
    const capturedAt = (deps.clock ?? { now: () => new Date() })
      .now()
      .toISOString();
    const reviewedOutputId = reviewedWorkerOutputId({
      format: reviewedWorkerOutputFormat,
      formatRevision: 1,
      projectId: input.projectId,
      controllerJobId: input.controllerJobId,
      workerJobId: input.workerJobId,
      taskId: input.taskId,
      sourceWorkspacePath: input.workspacePath,
      baseCommit: captured.baseCommit,
      patchSha256,
      changedFiles,
      reviewDecision,
    });
    return await deps.store.create({
      snapshot: {
        format: reviewedWorkerOutputFormat,
        formatRevision: 1,
        reviewedOutputId,
        projectId: input.projectId,
        controllerJobId: input.controllerJobId,
        workerJobId: input.workerJobId,
        taskId: input.taskId,
        sourceWorkspacePath: input.workspacePath,
        patchSha256,
        patchByteLength: Buffer.byteLength(captured.patch),
        baseCommit: captured.baseCommit,
        changedFiles,
        reviewDecision,
        capturedAt,
      },
      patch: captured.patch,
    });
  } finally {
    await deps.locks.release(lock);
  }
}

export function reviewedWorkerOutputId(
  input: ReviewedWorkerOutputIdentity,
): string {
  return sha256(reviewedWorkerOutputIdentityPayload(input));
}

export async function verifyReviewedWorkerOutputStillMatches(
  deps: Pick<ReviewedWorkerOutputDeps, "snapshotter" | "locks">,
  snapshot: ReviewedWorkerOutputSnapshot,
): Promise<void> {
  const lock = await deps.locks.acquire({
    workspacePath: snapshot.sourceWorkspacePath,
    owner: `reviewed-output-verify:${snapshot.controllerJobId}:${snapshot.workerJobId}`,
  });
  try {
    const current = await deps.snapshotter.capture({
      workspacePath: snapshot.sourceWorkspacePath,
    });
    const currentChangedFiles = normalizeExpectedFiles(current.changedFiles);
    if (
      current.baseCommit !== snapshot.baseCommit ||
      sha256(current.patch) !== snapshot.patchSha256 ||
      JSON.stringify(currentChangedFiles) !== JSON.stringify(snapshot.changedFiles)
    ) {
      throw new Error("reviewed_worker_output_workspace_changed_after_capture");
    }
  } finally {
    await deps.locks.release(lock);
  }
}

export async function commitReviewedWorkerOutputApproval(input: {
  readonly store: ReviewedWorkerOutputStorePort;
  readonly markerVerifier: ReviewedWorkerOutputReviewMarkerVerifierPort;
  readonly snapshot: ReviewedWorkerOutputSnapshot;
  readonly reviewMarkerPath: string;
  readonly clock?: { now(): Date };
}): Promise<void> {
  const verified = await input.markerVerifier.verify({
    markerPath: input.reviewMarkerPath,
    snapshot: input.snapshot,
  });
  await input.store.commitApproval({
    approval: {
      format: "reviewed-worker-output-approval",
      formatRevision: 1,
      reviewedOutputId: input.snapshot.reviewedOutputId,
      reviewMarkerPath: input.reviewMarkerPath,
      reviewMarkerSha256: verified.markerSha256,
      committedAt: (input.clock ?? { now: () => new Date() }).now().toISOString(),
    },
    reviewMarkerContent: verified.markerContent,
  });
}

export async function resolveReviewedWorkerOutput(input: {
  readonly store: ReviewedWorkerOutputStorePort;
  readonly projectId: string;
  readonly reviewedOutputId: string;
  readonly expectedWorkerJobId?: string;
}): Promise<{
  readonly snapshot: ReviewedWorkerOutputSnapshot;
  readonly workerOutput: ReturnType<typeof reviewedOutputAsWorkerOutput>;
}> {
  const snapshot = await input.store.get(normalizeSha256(input.reviewedOutputId));
  if (!snapshot) throw new Error("reviewed_worker_output_not_found");
  if (snapshot.projectId !== input.projectId) {
    throw new Error("reviewed_worker_output_project_mismatch");
  }
  if (
    input.expectedWorkerJobId !== undefined &&
    snapshot.workerJobId !== input.expectedWorkerJobId
  ) {
    throw new Error("reviewed_worker_output_job_mismatch");
  }
  return {
    snapshot,
    workerOutput: reviewedOutputAsWorkerOutput(snapshot),
  };
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("reviewed_worker_output_sha256_invalid");
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
