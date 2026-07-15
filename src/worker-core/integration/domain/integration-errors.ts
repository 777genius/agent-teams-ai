import type { PolicyDecision } from "../../access-control";

export enum IntegrationErrorReason {
  InvalidTransition = "invalid_transition",
  InvalidPath = "invalid_path",
  PathOutsideExpectedFiles = "path_outside_expected_files",
  DirtyWorkspace = "dirty_workspace",
  ChecksFailed = "checks_failed",
  SecretScanFailed = "secret_scan_failed",
  DiffCheckFailed = "diff_check_failed",
  UnexpectedFiles = "unexpected_files",
  InvalidCommitMessage = "invalid_commit_message",
  CommitIdentityUnavailable = "commit_identity_unavailable",
  BranchMismatch = "branch_mismatch",
  StaleBase = "stale_base",
  InvalidMergePlan = "invalid_merge_plan",
  MergeParentsMismatch = "merge_parents_mismatch",
  MergeCommitRecoveryMismatch = "merge_commit_recovery_mismatch",
  MergeRollbackFailed = "merge_rollback_failed",
  OutputRollbackFailed = "output_rollback_failed",
  PolicyDenied = "policy_denied",
}

export class IntegrationError extends Error {
  readonly reason: IntegrationErrorReason;
  readonly evidence: readonly string[];
  readonly decision?: PolicyDecision;

  constructor(input: {
    readonly reason: IntegrationErrorReason;
    readonly message?: string;
    readonly evidence?: readonly string[];
    readonly decision?: PolicyDecision;
  }) {
    super(input.message ?? `project_integration_${input.reason}`);
    this.name = "IntegrationError";
    this.reason = input.reason;
    this.evidence = input.evidence ?? [];
    if (input.decision) this.decision = input.decision;
  }
}

export function integrationPolicyDenied(decision: PolicyDecision): IntegrationError {
  return new IntegrationError({
    reason: IntegrationErrorReason.PolicyDenied,
    message: `project_integration_policy_denied:${decision.reason}`,
    decision,
    evidence: decision.evidence,
  });
}
