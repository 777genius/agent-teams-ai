import {
  IntegrationAttemptStatus,
  markRejected,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  IntegrationError,
  IntegrationErrorReason,
} from "../domain/integration-errors";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";
import type {
  IntegratedOutputLedgerPort,
  RejectedOutputLedgerReceipt,
} from "../ports/integrated-output-ledger-port";
import type { GitPort } from "../ports/git-port";
import type { WorkspaceLockPort } from "../ports/workspace-lock-port";

export type RejectIntegrationAttemptInput = {
  readonly attemptId: string;
  readonly reason: string;
};

export async function rejectIntegrationAttempt(
  deps: IntegrationUseCaseDeps & {
    readonly integratedOutputLedger: IntegratedOutputLedgerPort;
    readonly git?: GitPort;
    readonly locks: WorkspaceLockPort;
  },
  input: RejectIntegrationAttemptInput,
): Promise<IntegrationAttempt & {
  readonly consumedOutputLedger: RejectedOutputLedgerReceipt;
}> {
  const snapshot = await loadIntegrationAttempt(deps.store, input.attemptId);
  const lock = await deps.locks.acquire({
    workspacePath: snapshot.targetWorkspacePath,
    owner: snapshot.attemptId,
  });
  try {
    const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
    if (snapshot.targetWorkspacePath !== attempt.targetWorkspacePath) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.InvalidTransition,
        evidence: ["integration_attempt_target_workspace_changed"],
      });
    }
    return await rejectIntegrationAttemptLocked(deps, attempt, input);
  } finally {
    await deps.locks.release(lock);
  }
}

async function rejectIntegrationAttemptLocked(
  deps: IntegrationUseCaseDeps & {
    readonly integratedOutputLedger: IntegratedOutputLedgerPort;
    readonly git?: GitPort;
  },
  attempt: IntegrationAttempt,
  input: RejectIntegrationAttemptInput,
): Promise<IntegrationAttempt & {
  readonly consumedOutputLedger: RejectedOutputLedgerReceipt;
}> {
  if (attempt.status === IntegrationAttemptStatus.ChecksRunning) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "integration_rejection_checks_running_forbidden",
      evidence: ["checks_must_reach_a_terminal_state_before_rejection"],
    });
  }
  const preparation = await deps.integratedOutputLedger.prepareRejection({
    attempt,
  });
  if (attempt.status === IntegrationAttemptStatus.Rejected) {
    const consumedOutputLedger = await deps.integratedOutputLedger.finalizeRejection({
      preparation,
      rejectedAt: attempt.updatedAt,
      reason: attempt.rejectReason ?? input.reason,
    });
    return { ...attempt, consumedOutputLedger };
  }
  if (attempt.merge && mergeCanStillBePending(attempt.status)) {
    await rollbackRejectedMerge(deps, attempt);
  } else if (!attempt.merge && outputWasApplied(attempt.status)) {
    await rollbackRejectedWorkerOutput(deps, attempt);
  }
  const now = nowIso(deps.clock);
  const updated = markRejected(attempt, {
    reason: input.reason,
    now,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: IntegrationAuditEventType.Rejected,
    occurredAt: now,
    safeReason: input.reason,
  });
  const consumedOutputLedger = await deps.integratedOutputLedger.finalizeRejection({
    preparation,
    rejectedAt: updated.updatedAt,
    reason: input.reason,
  });
  return { ...updated, consumedOutputLedger };
}

function outputWasApplied(status: IntegrationAttemptStatus): boolean {
  return status === IntegrationAttemptStatus.Applied ||
    status === IntegrationAttemptStatus.ChecksFailed ||
    status === IntegrationAttemptStatus.ChecksPassed;
}

function mergeCanStillBePending(status: IntegrationAttemptStatus): boolean {
  return status === IntegrationAttemptStatus.Opened ||
    status === IntegrationAttemptStatus.Applied ||
    status === IntegrationAttemptStatus.ChecksRunning ||
    status === IntegrationAttemptStatus.ChecksFailed ||
    status === IntegrationAttemptStatus.ChecksPassed;
}

async function rollbackRejectedMerge(
  deps: {
    readonly git?: GitPort;
  },
  attempt: IntegrationAttempt,
): Promise<void> {
  if (!deps.git?.abortMerge) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeRollbackFailed,
      evidence: ["git_abort_merge_unavailable"],
    });
  }
  try {
    await deps.git.abortMerge({ attempt });
  } catch (error) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeRollbackFailed,
      evidence: [safeErrorMessage(error)],
    });
  }
}

async function rollbackRejectedWorkerOutput(
  deps: {
    readonly git?: GitPort;
  },
  attempt: IntegrationAttempt,
): Promise<void> {
  const git = deps.git;
  if (!git?.rollbackWorkerOutput) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.OutputRollbackFailed,
      evidence: ["git_output_rollback_unavailable"],
    });
  }
  try {
    await git.rollbackWorkerOutput({ attempt });
  } catch (error) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.OutputRollbackFailed,
      evidence: [safeErrorMessage(error)],
    });
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
