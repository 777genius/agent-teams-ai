import type {
  ReviewedWorkerOutputApproval,
  ReviewedWorkerOutputSnapshot,
  ReviewedWorkerOutputWorkspaceSnapshot,
} from "../domain/reviewed-worker-output";

export interface ReviewedWorkerOutputSnapshotterPort {
  capture(input: {
    readonly workspacePath: string;
  }): Promise<ReviewedWorkerOutputWorkspaceSnapshot>;
}

export interface ReviewedWorkerOutputStorePort {
  create(input: {
    readonly snapshot: Omit<ReviewedWorkerOutputSnapshot, "patchPath">;
    readonly patch: string;
  }): Promise<ReviewedWorkerOutputSnapshot>;

  commitApproval(input: {
    readonly approval: ReviewedWorkerOutputApproval;
    readonly reviewMarkerContent: string;
  }): Promise<void>;

  get(reviewedOutputId: string): Promise<ReviewedWorkerOutputSnapshot | undefined>;
}

export interface ReviewedWorkerOutputReviewMarkerVerifierPort {
  verify(input: {
    readonly markerPath: string;
    readonly snapshot: ReviewedWorkerOutputSnapshot;
  }): Promise<{
    readonly markerSha256: string;
    readonly markerContent: string;
  }>;
}
