import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import { readVerifiedProducerHandoff } from "./codex-goal-project-verifier-handoff";
import type { ReviewedWorkerOutputSnapshotterPort } from "../../reviewed-worker-output";

export type VerifiedTerminalHandoffRecovery = {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly patchSha256: string;
  readonly baseCommit: string;
  readonly changedFiles: readonly string[];
};

export function terminalHandoffDependencyRecoveryRequested(input: {
  readonly status: Pick<
    CodexGoalStatus,
    "workspaceDirty" | "resultExists" | "resultStatus" | "recommendedAction"
  >;
  readonly reviewedOutputId?: string;
  readonly forceStart: boolean;
  readonly dependencyBootstrap?: string;
  readonly confirmDependencyBootstrap: boolean;
}): boolean {
  return (
    input.status.workspaceDirty === true &&
    !input.reviewedOutputId &&
    input.forceStart &&
    input.dependencyBootstrap === "install" &&
    input.confirmDependencyBootstrap &&
    input.status.resultExists === true &&
    input.status.resultStatus === "done" &&
    input.status.recommendedAction === "review_completed"
  );
}

/**
 * Binds a same-job recovery to the terminal handoff that the runtime already
 * published. This does not approve the output: it only proves that the dirty
 * workspace still contains the exact captured bytes before another attempt.
 */
export async function verifyTerminalHandoffRecovery(input: {
  readonly producer: CodexGoalJobManifest;
  readonly workspacePath: string;
  readonly snapshotter: ReviewedWorkerOutputSnapshotterPort;
  readonly expected?: VerifiedTerminalHandoffRecovery;
}): Promise<VerifiedTerminalHandoffRecovery> {
  await assertNoReviewDecision(input.producer);
  const handoff = await readVerifiedProducerHandoff({
    producer: input.producer,
  });
  const current = await input.snapshotter.capture({
    workspacePath: input.workspacePath,
  });
  const currentChangedFiles = uniqueSorted(current.changedFiles);
  const handoffChangedFiles = uniqueSorted(handoff.changedPaths);
  if (
    current.baseCommit !== handoff.baseCommit ||
    sha256(current.patch) !== handoff.patchSha256 ||
    !sameStrings(currentChangedFiles, handoffChangedFiles)
  ) {
    throw new Error(
      "project_control_terminal_handoff_workspace_changed_after_capture",
    );
  }
  const verified = {
    manifestPath: handoff.manifestPath,
    manifestSha256: handoff.manifestSha256,
    patchSha256: handoff.patchSha256,
    baseCommit: handoff.baseCommit,
    changedFiles: handoffChangedFiles,
  };
  if (input.expected && !sameRecovery(input.expected, verified)) {
    throw new Error(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );
  }
  return verified;
}

async function assertNoReviewDecision(
  producer: CodexGoalJobManifest,
): Promise<void> {
  const reviewPath = join(
    producer.jobRootDir,
    `${producer.taskId}.review.json`,
  );
  try {
    const item = await lstat(reviewPath);
    if (item.isSymbolicLink() || !item.isFile()) {
      throw new Error("project_control_terminal_handoff_review_marker_unsafe");
    }
    throw new Error("project_control_terminal_handoff_already_reviewed");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

function sameRecovery(
  left: VerifiedTerminalHandoffRecovery,
  right: VerifiedTerminalHandoffRecovery,
): boolean {
  return (
    left.manifestPath === right.manifestPath &&
    left.manifestSha256 === right.manifestSha256 &&
    left.patchSha256 === right.patchSha256 &&
    left.baseCommit === right.baseCommit &&
    sameStrings(left.changedFiles, right.changedFiles)
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
