import {
  assertIntegrationAppliedFiles,
  integrationAppliedFiles,
  markWorkerOutputApplied,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import {
  IntegrationError,
  IntegrationErrorReason,
} from "../domain/integration-errors";
import { IntegrationAuditEventType } from "../domain/integration-events";
import type { GitPort } from "../ports/git-port";
import type { WorkspaceLockPort } from "../ports/workspace-lock-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type ApplyWorkerOutputDeps = IntegrationUseCaseDeps & {
  readonly git: GitPort;
  readonly locks: WorkspaceLockPort;
};

export type ApplyWorkerOutputInput = {
  readonly attemptId: string;
  readonly allowedPreExistingDirtyFiles?: readonly string[];
};

export async function applyWorkerOutput(
  deps: ApplyWorkerOutputDeps,
  input: ApplyWorkerOutputInput,
): Promise<IntegrationAttempt> {
  const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  const lock = await deps.locks.acquire({
    workspacePath: attempt.targetWorkspacePath,
    owner: attempt.attemptId,
  });
  try {
    const status = await deps.git.getStatus({
      workspacePath: attempt.targetWorkspacePath,
    });
    if (status.branch !== attempt.targetBranch) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.BranchMismatch,
        evidence: [status.branch, attempt.targetBranch],
      });
    }
    const allowedPreExistingDirtyFiles =
      input.allowedPreExistingDirtyFiles ?? [];
    assertDirtyFilesAllowed(
      status.dirtyFiles,
      attempt.merge ? [] : allowedPreExistingDirtyFiles,
    );
    let updated: IntegrationAttempt;
    try {
      const result = await deps.git.applyWorkerOutput({
        attempt,
        workerOutput: attempt.workerOutput,
        allowAlreadyApplied: attempt.merge
          ? false
          : sameFiles(allowedPreExistingDirtyFiles, attempt.expectedFiles) &&
            sameFiles(status.dirtyFiles, attempt.expectedFiles),
      });
      assertIntegrationAppliedFiles(attempt, result.changedFiles);
      const now = nowIso(deps.clock);
      updated = markWorkerOutputApplied(attempt, {
        changedFiles: result.changedFiles,
        ...(result.mergeSourceCommit
          ? { mergeSourceCommit: result.mergeSourceCommit }
          : {}),
        now,
      });
      await deps.store.update(updated);
    } catch (error) {
      if (attempt.merge) await rollbackFailedMerge(deps.git, attempt, error);
      throw error;
    }
    await recordIntegrationAudit(deps, updated, {
      type: IntegrationAuditEventType.AttemptApplied,
      occurredAt: updated.updatedAt,
      files: integrationAppliedFiles(updated),
    });
    return updated;
  } finally {
    await deps.locks.release(lock);
  }
}

async function rollbackFailedMerge(
  git: GitPort,
  attempt: IntegrationAttempt,
  originalError: unknown,
): Promise<void> {
  if (!git.abortMerge) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeRollbackFailed,
      evidence: ["git_abort_merge_unavailable", safeErrorMessage(originalError)],
    });
  }
  try {
    await git.abortMerge({ attempt });
  } catch (rollbackError) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeRollbackFailed,
      evidence: [
        safeErrorMessage(originalError),
        safeErrorMessage(rollbackError),
      ],
    });
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left.map(normalizeProjectRelativePath))].sort();
  const normalizedRight = [...new Set(right.map(normalizeProjectRelativePath))].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((file, index) => file === normalizedRight[index]);
}

function assertDirtyFilesAllowed(
  dirtyFiles: readonly string[],
  allowedFiles: readonly string[],
): void {
  const allowed = new Set(allowedFiles.map(normalizeProjectRelativePath));
  const unexpected = dirtyFiles
    .map(normalizeProjectRelativePath)
    .filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.DirtyWorkspace,
      evidence: unexpected,
    });
  }
}
