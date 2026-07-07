import { join } from "node:path";

import {
  AccessBoundary,
  AccessDecisionReason,
  ProjectOperation,
  type AccessPolicyContext,
  createAccessPolicyService,
} from "../../access-control";
import {
  IntegrationError,
  IntegrationErrorReason,
  integrationPolicyDenied,
} from "./integration-errors";
import {
  isConventionalCommitMessage,
  normalizeExpectedFiles,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
  type OpenIntegrationAttemptInput,
} from "./integration-attempt";

export type ProjectIntegrationPolicy = {
  readonly access: AccessPolicyContext;
  readonly allowedPathPrefixes?: readonly string[];
  readonly requiredCheckIds?: readonly string[];
  readonly allowForcePush?: boolean;
  readonly allowStaleBase?: boolean;
};

export function assertCanOpenIntegrationAttempt(
  policy: ProjectIntegrationPolicy,
  input: OpenIntegrationAttemptInput,
): void {
  if (policy.access.boundary !== AccessBoundary.ProjectScopedControl) {
    throw integrationPolicyDenied({
      allowed: false,
      boundary: policy.access.boundary,
      operation: ProjectOperation.IntegrateCommit,
      reason: AccessDecisionReason.BoundaryInsufficient,
      evidence: ["project_scoped_control_required"],
    });
  }
  const access = createAccessPolicyService(policy.access);
  const workerDecision = access.canStartWorker({
    jobId: input.workerOutput.workerJobId,
    workspacePath: input.workerOutput.workspacePath,
  });
  if (!workerDecision.allowed) throw integrationPolicyDenied(workerDecision);
  const integrationDecision = access.canIntegrateCommit({
    workspacePath: input.targetWorkspacePath,
    branch: input.targetBranch,
  });
  if (!integrationDecision.allowed) {
    throw integrationPolicyDenied(integrationDecision);
  }
  const pushDecision = access.canPushBranch({
    workspacePath: input.targetWorkspacePath,
    branch: input.targetBranch,
    remote: input.targetRemote,
    force: false,
  });
  if (!pushDecision.allowed) throw integrationPolicyDenied(pushDecision);
  assertBaseRevisionAllowed(policy, input);
  assertExpectedFilesAllowed(policy, input.reviewDecision.approvedFiles);
  for (const file of input.reviewDecision.approvedFiles) {
    const writeDecision = access.canWritePath({
      path: join(input.targetWorkspacePath, normalizeProjectRelativePath(file)),
    });
    if (!writeDecision.allowed) throw integrationPolicyDenied(writeDecision);
  }
}

function assertBaseRevisionAllowed(
  policy: ProjectIntegrationPolicy,
  input: OpenIntegrationAttemptInput,
): void {
  if (
    input.workerOutput.baseStatus === "needs_rebase_check" &&
    policy.allowStaleBase !== true
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.StaleBase,
      evidence: [
        ...(input.workerOutput.baseCommit
          ? [`base:${input.workerOutput.baseCommit}`]
          : []),
        ...(input.workerOutput.targetCommit
          ? [`target:${input.workerOutput.targetCommit}`]
          : []),
        ...(input.workerOutput.baseRevisionReasons ?? []),
      ],
    });
  }
}

export function assertExpectedFilesAllowed(
  policy: ProjectIntegrationPolicy,
  files: readonly string[],
): void {
  const normalized = normalizeExpectedFiles(files);
  const allowedPrefixes = policy.allowedPathPrefixes?.map(normalizeAllowedPathPrefix);
  if (!allowedPrefixes || allowedPrefixes.length === 0) return;
  const outside = normalized.filter((file) =>
    !allowedPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  );
  if (outside.length > 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.PathOutsideExpectedFiles,
      evidence: outside,
    });
  }
}

function normalizeAllowedPathPrefix(prefix: string): string {
  return normalizeProjectRelativePath(prefix).replace(/\/+$/, "");
}

export function assertRequiredChecksSatisfied(
  policy: ProjectIntegrationPolicy,
  attempt: IntegrationAttempt,
): void {
  const required = new Set(policy.requiredCheckIds ?? []);
  for (const check of attempt.reviewDecision.requiredChecks) {
    required.add(check.checkId);
  }
  const completed = new Set(attempt.checkRuns.map((run) => run.checkId));
  const missing = [...required].filter((checkId) => !completed.has(checkId));
  if (missing.length > 0) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.ChecksFailed,
      evidence: missing,
    });
  }
}

export function assertCommitMessageAllowed(message: string): void {
  if (!isConventionalCommitMessage(message)) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidCommitMessage,
      evidence: [message],
    });
  }
}
