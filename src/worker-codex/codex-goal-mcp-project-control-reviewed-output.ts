import {
  matchesAnyPattern,
  ReviewDecisionStatus,
  matchesAnyPattern,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
} from "./codex-goal-mcp-project-git";
import { requiredRawString } from "./codex-goal-mcp-values";

export function parseReviewedOutputMerge(
  scope: ProjectAccessScope,
  value: NonNullable<ProjectControlMcpArgs["merge"]>,
) {
  const sourceRemote = requiredRawString(value.sourceRemote, "merge.sourceRemote");
  const sourceBranch = requiredRawString(value.sourceBranch, "merge.sourceBranch");
  const sourceCommit = requiredRawString(value.sourceCommit, "merge.sourceCommit")
    .toLowerCase();
  const expectedTargetCommit = requiredRawString(
    value.expectedTargetCommit,
    "merge.expectedTargetCommit",
  ).toLowerCase();
  assertSafeGitRemoteName(sourceRemote, "merge.sourceRemote");
  assertSafeGitRefName(sourceBranch, "merge.sourceBranch");
  assertSafeGitCommitSha(sourceCommit);
  assertSafeGitCommitSha(expectedTargetCommit);
  if (sourceCommit === expectedTargetCommit) {
    throw new Error("reviewed_worker_output_merge_distinct_parents_required");
  }
  if (!scope.allowedGitRemotes?.includes(sourceRemote)) {
    throw new Error("reviewed_worker_output_merge_source_remote_denied");
  }
  if (!matchesAnyPattern(sourceBranch, scope.allowedBranches ?? [])) {
    throw new Error("reviewed_worker_output_merge_source_branch_denied");
  }
  return { sourceRemote, sourceBranch, sourceCommit, expectedTargetCommit };
}

export function requiredReviewDecision(value: unknown): ReviewDecisionStatus {
  if (value === "approved") return ReviewDecisionStatus.Approved;
  if (value === "rejected") return ReviewDecisionStatus.Rejected;
  if (value === "needs_human") return ReviewDecisionStatus.NeedsHuman;
  throw new Error("reviewed_worker_output_review_decision_required");
}
