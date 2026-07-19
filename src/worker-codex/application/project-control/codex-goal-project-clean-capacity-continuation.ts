import type { CodexGoalStatus } from "../../codex-goal-ops";

/**
 * Recognizes only a terminal account-capacity pause on an unchanged workspace.
 * Liveness, admission binding, and attempt-journal consistency remain separate
 * mandatory gates in the project start application flow.
 */
export function isCleanPreStartAdmissionCapacityContinuation(
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
  const failureReason = capacityContinuationFailureReason(status.resultReason);
  if (
    status.workspaceDirty !== false ||
    status.recommendedAction !== "continue_after_capacity" ||
    !failureReason
  ) {
    return false;
  }
  if (status.resultStatus === "waiting_capacity") return true;
  return (
    status.resultStatus === "blocked" &&
    status.progressResultStatus === "waiting_capacity" &&
    status.progressResultReason === failureReason
  );
}

function capacityContinuationFailureReason(
  value: string | undefined,
): "account_unavailable" | "quota_limited" | undefined {
  return value === "account_unavailable" || value === "quota_limited"
    ? value
    : undefined;
}
