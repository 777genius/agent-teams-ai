import {
  IntegrationAttemptStatus,
  PushAttemptStatus,
  assertStatus,
  markPromoted,
  markPushed,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import {
  IntegrationError,
  IntegrationErrorReason,
  integrationPolicyDenied,
} from "../domain/integration-errors";
import { IntegrationAuditEventType } from "../domain/integration-events";
import type { ProjectIntegrationPolicy } from "../domain/integration-policy";
import {
  createAccessPolicyService,
} from "../../access-control";
import type { GitPort } from "../ports/git-port";
import type { IntegratedOutputLedgerPort } from "../ports/integrated-output-ledger-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type PushApprovedCommitDeps = IntegrationUseCaseDeps & {
  readonly git: GitPort;
  readonly integratedOutputLedger: IntegratedOutputLedgerPort;
};

export type PushApprovedCommitInput = {
  readonly attemptId: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly force?: boolean;
  readonly policy: ProjectIntegrationPolicy;
};

export async function pushApprovedCommit(
  deps: PushApprovedCommitDeps,
  input: PushApprovedCommitInput,
): Promise<IntegrationAttempt> {
  const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  if (attempt.status === IntegrationAttemptStatus.Pushed) {
    return await replayOrPromotePushedCommit(deps, input, attempt);
  }
  assertStatus(attempt, [IntegrationAttemptStatus.CommitCreated]);
  if (!attempt.commitCandidate) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "commit_candidate_required",
    });
  }
  const remote = input.remote ?? attempt.targetRemote;
  const branch = input.branch ?? attempt.targetBranch;
  const force = input.force ?? false;
  const decision = createAccessPolicyService(input.policy.access).canPushBranch({
    workspacePath: attempt.targetWorkspacePath,
    branch,
    remote,
    force,
  });
  if (!decision.allowed) throw integrationPolicyDenied(decision);
  if (force && input.policy.allowForcePush !== true) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.PolicyDenied,
      message: "integration_force_push_denied",
    });
  }
  const currentBranch = await deps.git.currentBranch({
    workspacePath: attempt.targetWorkspacePath,
  });
  if (currentBranch !== branch) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.BranchMismatch,
      evidence: [currentBranch, branch],
    });
  }
  const preparation = await deps.integratedOutputLedger.prepare({
    attempt,
    commitSha: attempt.commitCandidate.commitSha,
  });
  await deps.integratedOutputLedger.preflightFinalize({ preparation });
  const remoteCommit = await deps.git.remoteBranchCommit({
    workspacePath: attempt.targetWorkspacePath,
    remote,
    branch,
  });
  if (remoteCommit !== attempt.commitCandidate.commitSha) {
    await deps.git.push({
      workspacePath: attempt.targetWorkspacePath,
      remote,
      branch,
      commitSha: attempt.commitCandidate.commitSha,
      force,
    });
  }
  const pushedAt = nowIso(deps.clock);
  await deps.integratedOutputLedger.finalize({ preparation, pushedAt });
  const updated = markPushed(attempt, {
    pushAttempt: {
      remote,
      branch,
      commitSha: attempt.commitCandidate.commitSha,
      status: PushAttemptStatus.Pushed,
      pushedAt,
    },
    now: pushedAt,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: IntegrationAuditEventType.Pushed,
    occurredAt: pushedAt,
    commitSha: attempt.commitCandidate.commitSha,
  });
  return updated;
}

async function replayOrPromotePushedCommit(
  deps: PushApprovedCommitDeps,
  input: PushApprovedCommitInput,
  attempt: IntegrationAttempt,
): Promise<IntegrationAttempt> {
  if (!attempt.pushAttempt || !attempt.commitCandidate) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "push_attempt_required",
    });
  }
  const remote = input.remote ?? attempt.pushAttempt.remote;
  const branch = input.branch ?? attempt.pushAttempt.branch;
  const existingPromotion = attempt.promotionAttempts?.find((promotion) =>
    promotion.remote === remote &&
    promotion.branch === branch &&
    promotion.commitSha === attempt.commitCandidate!.commitSha
  );
  await replayIntegratedOutputLedger(deps, attempt);
  if (
    (remote === attempt.pushAttempt.remote &&
      branch === attempt.pushAttempt.branch) ||
    existingPromotion
  ) {
    return attempt;
  }
  if (input.force === true) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.PolicyDenied,
      message: "integration_promotion_force_denied",
    });
  }
  const decision = createAccessPolicyService(input.policy.access).canPushBranch({
    workspacePath: attempt.targetWorkspacePath,
    branch,
    remote,
    force: false,
  });
  if (!decision.allowed) throw integrationPolicyDenied(decision);
  const currentBranch = await deps.git.currentBranch({
    workspacePath: attempt.targetWorkspacePath,
  });
  if (currentBranch !== attempt.targetBranch) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.BranchMismatch,
      evidence: [currentBranch, attempt.targetBranch],
    });
  }
  const expectedTarget = attempt.workerOutput.targetCommit;
  const remoteCommit = await deps.git.remoteBranchCommit({
    workspacePath: attempt.targetWorkspacePath,
    remote,
    branch,
  });
  if (
    remoteCommit !== attempt.commitCandidate.commitSha &&
    (!expectedTarget ||
      remoteCommit?.toLowerCase() !== expectedTarget.toLowerCase())
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.StaleBase,
      message: "integration_promotion_target_changed",
      evidence: [
        branch,
        expectedTarget ?? "missing_expected_target_commit",
        remoteCommit ?? "missing_remote_target_commit",
      ],
    });
  }
  if (remoteCommit !== attempt.commitCandidate.commitSha) {
    await deps.git.push({
      workspacePath: attempt.targetWorkspacePath,
      remote,
      branch,
      commitSha: attempt.commitCandidate.commitSha,
      force: false,
      expectedRemoteCommit: expectedTarget!,
    });
  }
  const promotedAt = nowIso(deps.clock);
  const updated = markPromoted(attempt, {
    promotionAttempt: {
      remote,
      branch,
      commitSha: attempt.commitCandidate.commitSha,
      status: PushAttemptStatus.Pushed,
      pushedAt: promotedAt,
    },
    now: promotedAt,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: IntegrationAuditEventType.Promoted,
    occurredAt: promotedAt,
    commitSha: attempt.commitCandidate.commitSha,
  });
  return updated;
}

async function replayIntegratedOutputLedger(
  deps: PushApprovedCommitDeps,
  attempt: IntegrationAttempt,
): Promise<void> {
  if (!attempt.pushAttempt) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "push_attempt_required",
    });
  }
  const preparation = await deps.integratedOutputLedger.prepare({
    attempt,
    commitSha: attempt.pushAttempt.commitSha,
  });
  await deps.integratedOutputLedger.preflightFinalize({
    preparation,
    pushedAt: attempt.pushAttempt.pushedAt,
  });
  await deps.integratedOutputLedger.finalize({
    preparation,
    pushedAt: attempt.pushAttempt.pushedAt,
  });
}
