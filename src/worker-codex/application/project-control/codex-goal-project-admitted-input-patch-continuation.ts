import type { CodexGoalStatus } from "../../codex-goal-ops";

const capacityContinuationReasons = new Set([
  "quota_limited",
  "capacity_unavailable",
  "account_unavailable",
  "model_unavailable",
  "reconnect_required",
]);

/**
 * Recognizes only a runtime-authored capacity pause. Workspace identity is
 * deliberately verified separately against the immutable pre-start admission
 * receipt before a continuation can launch.
 */
export function isAdmittedInputPatchCapacityContinuation(
  status: Pick<
    CodexGoalStatus,
    | "workspaceDirty"
    | "recommendedAction"
    | "resultStatus"
    | "resultReason"
    | "progressResultStatus"
    | "progressResultReason"
  >,
): boolean {
  if (
    status.workspaceDirty !== true ||
    status.recommendedAction !== "continue_after_capacity"
  ) {
    return false;
  }
  return (
    status.resultStatus === "waiting_capacity" ||
    status.progressResultStatus === "waiting_capacity" ||
    capacityContinuationReasons.has(status.resultReason ?? "") ||
    capacityContinuationReasons.has(status.progressResultReason ?? "")
  );
}
