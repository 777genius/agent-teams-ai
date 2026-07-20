import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { consumedOutputRecordFor } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import { readVerifiedProducerHandoff } from "./codex-goal-project-verifier-handoff";
import type { ReviewedWorkerOutputSnapshotterPort } from "../../reviewed-worker-output";
import {
  hasRelevantConsumedOutputDebt,
  readCodexGoalConsumedOutputLedgers,
  resolveRejectedUncapturedOutputPatchSha256,
} from "./codex-goal-consumed-output-ledger-io";

export type VerifiedTerminalHandoffRecovery = {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly patchSha256: string;
  readonly baseCommit: string;
  readonly changedFiles: readonly string[];
  readonly reviewDisposition: "unreviewed" | "rejected_uncaptured";
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
  readonly consumedOutputLedgerRoots?: readonly string[];
  readonly expected?: VerifiedTerminalHandoffRecovery;
}): Promise<VerifiedTerminalHandoffRecovery> {
  const handoff = await readVerifiedProducerHandoff({
    producer: input.producer,
  });
  const reviewDisposition = await terminalHandoffReviewDisposition({
    producer: input.producer,
    workspacePath: input.workspacePath,
    patchSha256: handoff.patchSha256,
    consumedOutputLedgerRoots:
      input.consumedOutputLedgerRoots ??
      input.producer.projectAccessScope?.consumedOutputLedgerRoots ??
      [],
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
    reviewDisposition,
  };
  if (input.expected && !sameRecovery(input.expected, verified)) {
    throw new Error(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );
  }
  return verified;
}

async function terminalHandoffReviewDisposition(input: {
  readonly producer: CodexGoalJobManifest;
  readonly workspacePath: string;
  readonly patchSha256: string;
  readonly consumedOutputLedgerRoots: readonly string[];
}): Promise<"unreviewed" | "rejected_uncaptured"> {
  const reviewPath = join(
    input.producer.jobRootDir,
    `${input.producer.taskId}.review.json`,
  );
  let markerBody: string;
  let markerHandle;
  try {
    markerHandle = await open(
      reviewPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const item = await markerHandle.stat();
    if (!item.isFile() || item.size > 1024 * 1024) {
      throw new Error("project_control_terminal_handoff_review_marker_unsafe");
    }
    markerBody = await markerHandle.readFile("utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      await assertNoRejectedLedgerWithoutMarker(input);
      return "unreviewed";
    }
    if (isNodeError(error, "ELOOP")) {
      throw new Error("project_control_terminal_handoff_review_marker_unsafe");
    }
    throw error;
  } finally {
    await markerHandle?.close().catch(() => undefined);
  }

  let marker: unknown;
  try {
    marker = JSON.parse(markerBody);
  } catch {
    throw new Error("project_control_terminal_handoff_review_marker_unsafe");
  }
  if (
    !isRecord(marker) ||
    marker.schemaVersion !== 1 ||
    marker.jobId !== input.producer.jobId ||
    marker.taskId !== input.producer.taskId ||
    !isRecord(marker.status) ||
    marker.reviewedOutput !== undefined ||
    marker.decision !== undefined ||
    input.consumedOutputLedgerRoots.length !== 1
  ) {
    throw new Error("project_control_terminal_handoff_already_reviewed");
  }
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots: input.consumedOutputLedgerRoots,
  });
  const patchSha256 = resolveRejectedUncapturedOutputPatchSha256({
    ledger,
    jobId: input.producer.jobId,
    workspacePath: input.workspacePath,
  });
  if (patchSha256 !== input.patchSha256.toLowerCase()) {
    throw new Error("project_control_terminal_handoff_already_reviewed");
  }
  return "rejected_uncaptured";
}

async function assertNoRejectedLedgerWithoutMarker(input: {
  readonly producer: CodexGoalJobManifest;
  readonly workspacePath: string;
  readonly consumedOutputLedgerRoots: readonly string[];
}): Promise<void> {
  if (input.consumedOutputLedgerRoots.length === 0) return;
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots: input.consumedOutputLedgerRoots,
  });
  if (
    hasRelevantConsumedOutputDebt(ledger, input.producer.jobId) ||
    consumedOutputRecordFor({
      ledger,
      jobId: input.producer.jobId,
      workspacePath: input.workspacePath,
    }) !== undefined
  ) {
    throw new Error("project_control_terminal_handoff_already_reviewed");
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
    left.reviewDisposition === right.reviewDisposition &&
    sameStrings(left.changedFiles, right.changedFiles)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
