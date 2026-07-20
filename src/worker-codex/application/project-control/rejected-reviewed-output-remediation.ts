import type {
  ReviewedWorkerOutputSnapshot,
  ReviewedWorkerOutputStorePort,
} from "../../reviewed-worker-output";
import { resolveRejectedReviewedWorkerOutputForRemediation } from "../../reviewed-worker-output";

export type RejectedReviewedOutputRemediation = {
  readonly snapshot: ReviewedWorkerOutputSnapshot;
  readonly inputPatch: {
    readonly path: string;
    readonly sha256: string;
    readonly stagedSha256: string;
    readonly baseCommit: string;
    readonly changedPaths: readonly string[];
  };
};

export async function resolveRejectedReviewedOutputRemediation(
  deps: {
    readonly store: ReviewedWorkerOutputStorePort;
    readonly readPatch: (
      snapshot: ReviewedWorkerOutputSnapshot,
    ) => Promise<string>;
    readonly stagedPatchSha256ForRevision: (input: {
      readonly workspacePath: string;
      readonly revision: string;
      readonly patchPath: string;
    }) => Promise<string>;
  },
  input: {
    readonly projectId: string;
    readonly reviewedOutputId: string;
    readonly expectedWorkerJobId: string;
    readonly expectedBaseCommit: string;
    readonly expectedPatchSha256: unknown;
    readonly sourceWorkspacePath: string;
  },
): Promise<RejectedReviewedOutputRemediation> {
  const snapshot = await resolveRejectedReviewedWorkerOutputForRemediation({
    store: deps.store,
    projectId: input.projectId,
    reviewedOutputId: input.reviewedOutputId,
    expectedWorkerJobId: input.expectedWorkerJobId,
  });
  if (
    typeof input.expectedPatchSha256 !== "string" ||
    input.expectedPatchSha256.toLowerCase() !== snapshot.patchSha256
  ) {
    throw new Error(
      "project_control_refill_reviewed_output_admission_patch_hash_mismatch",
    );
  }
  await deps.readPatch(snapshot);
  return {
    snapshot,
    inputPatch: {
      path: snapshot.patchPath,
      sha256: snapshot.patchSha256,
      stagedSha256: await deps.stagedPatchSha256ForRevision({
        workspacePath: input.sourceWorkspacePath,
        revision: input.expectedBaseCommit,
        patchPath: snapshot.patchPath,
      }),
      baseCommit: snapshot.baseCommit,
      changedPaths: snapshot.changedFiles,
    },
  };
}

export function rejectedReviewedOutputRemediationView(
  snapshot: ReviewedWorkerOutputSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    reviewedOutputId: snapshot.reviewedOutputId,
    controllerJobId: snapshot.controllerJobId,
    workerJobId: snapshot.workerJobId,
    baseCommit: snapshot.baseCommit,
    patchSha256: snapshot.patchSha256,
    patchByteLength: snapshot.patchByteLength,
    changedFiles: snapshot.changedFiles,
    decision: snapshot.reviewDecision.decision,
  };
}
