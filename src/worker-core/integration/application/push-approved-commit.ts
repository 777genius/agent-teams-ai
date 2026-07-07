import {
  IntegrationAttemptStatus,
  PushAttemptStatus,
  assertStatus,
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
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type PushApprovedCommitDeps = IntegrationUseCaseDeps & {
  readonly git: GitPort;
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
    return attempt;
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
  await deps.git.push({
    workspacePath: attempt.targetWorkspacePath,
    remote,
    branch,
    commitSha: attempt.commitCandidate.commitSha,
    force,
  });
  const pushedAt = nowIso(deps.clock);
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
