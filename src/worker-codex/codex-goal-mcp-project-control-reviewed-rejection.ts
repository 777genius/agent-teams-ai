import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  recordTerminalOutputDecision,
  ReviewDecisionStatus,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  captureLocalTerminalOutputBackup,
  LocalConsumedOutputLedgerWriter,
} from "@vioxen/subscription-runtime/worker-local";
import {
  captureGitWorkspaceChangedFiles,
  captureGitWorkspacePatch,
} from "./codex-goal-runtime-result-io";
import type { ReviewedWorkerOutputSnapshot } from "./reviewed-worker-output";

export async function recordRejectedReviewedOutput(input: {
  readonly scope: ProjectAccessScope;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly snapshot: ReviewedWorkerOutputSnapshot;
}) {
  if (input.snapshot.reviewDecision.decision !== ReviewDecisionStatus.Rejected) {
    throw new Error("reviewed_worker_output_rejected_decision_required");
  }
  if (
    resolve(input.snapshot.sourceWorkspacePath) !== resolve(input.workspacePath)
  ) {
    throw new Error("reviewed_worker_output_rejected_workspace_mismatch");
  }
  const ledgerRoots = input.scope.consumedOutputLedgerRoots ?? [];
  if (ledgerRoots.length !== 1) {
    throw new Error("project_control_consumed_output_ledger_required");
  }
  const backup = await captureLocalTerminalOutputBackup({
    archiveRoot: join(input.jobRootDir, "archives"),
    archiveName:
      `${input.snapshot.workerJobId}-rejected-reviewed-` +
      input.snapshot.reviewedOutputId,
    workspacePath: input.workspacePath,
    changedFiles: input.snapshot.changedFiles,
    sourcePatchPath: input.snapshot.patchPath,
  });
  if (!backup.hasAuthoredOutput) {
    throw new Error("reviewed_worker_output_rejected_authored_output_required");
  }
  return await recordTerminalOutputDecision(
    { writer: new LocalConsumedOutputLedgerWriter() },
    {
      allowedLedgerRoots: ledgerRoots,
      ledgerRoot: ledgerRoots[0]!,
      decision: {
        schemaVersion: 1,
        jobId: input.snapshot.workerJobId,
        attemptId: input.snapshot.reviewedOutputId,
        status: "rejected",
        closedAt: input.snapshot.capturedAt,
        archivePath: backup.archivePath,
        note:
          `Rejected reviewed worker output ${input.snapshot.reviewedOutputId}: ` +
          input.snapshot.reviewDecision.reason,
        backup: {
          workspace: input.workspacePath,
          statusPath: backup.statusPath,
          patchPath: backup.patchPath,
          numstatPath: backup.numstatPath,
        },
      },
    },
  );
}

export async function recordRejectedUncapturedOutput(input: {
  readonly scope: ProjectAccessScope;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly closedAt: string;
  readonly reason: string;
}) {
  const ledgerRoots = input.scope.consumedOutputLedgerRoots ?? [];
  if (ledgerRoots.length !== 1) {
    throw new Error("project_control_consumed_output_ledger_required");
  }
  const [changedFiles, patch] = await Promise.all([
    captureGitWorkspaceChangedFiles({ workspacePath: input.workspacePath }),
    captureGitWorkspacePatch({ workspacePath: input.workspacePath }),
  ]);
  if (changedFiles.length === 0 || !patch.trim()) {
    throw new Error("uncaptured_rejected_output_authored_output_required");
  }
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  const attemptId = `uncaptured-rejection-${patchSha256}`;
  const archiveRoot = join(input.jobRootDir, "archives");
  const sourcePatchPath = join(archiveRoot, `.${attemptId}.patch`);
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  await writeFile(sourcePatchPath, patch, { encoding: "utf8", mode: 0o600 });
  let backup;
  try {
    backup = await captureLocalTerminalOutputBackup({
      archiveRoot,
      archiveName: `${input.jobId}-rejected-uncaptured-${patchSha256}`,
      workspacePath: input.workspacePath,
      changedFiles,
      sourcePatchPath,
    });
  } finally {
    await rm(sourcePatchPath, { force: true });
  }
  if (!backup.hasAuthoredOutput) {
    throw new Error("uncaptured_rejected_output_authored_output_required");
  }
  return await recordTerminalOutputDecision(
    { writer: new LocalConsumedOutputLedgerWriter() },
    {
      allowedLedgerRoots: ledgerRoots,
      ledgerRoot: ledgerRoots[0]!,
      decision: {
        schemaVersion: 1,
        jobId: input.jobId,
        attemptId,
        status: "rejected",
        closedAt: input.closedAt,
        archivePath: backup.archivePath,
        note: `Rejected uncaptured worker output: ${input.reason}`,
        backup: {
          workspace: input.workspacePath,
          statusPath: backup.statusPath,
          patchPath: backup.patchPath,
          numstatPath: backup.numstatPath,
        },
      },
    },
  );
}
