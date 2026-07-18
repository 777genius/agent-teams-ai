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
  if (
    status.workspaceDirty !== false ||
    status.recommendedAction !== "continue_after_capacity"
  ) {
    return false;
  }
  if (
    status.resultReason === "model_unavailable" ||
    status.progressResultReason === "model_unavailable"
  ) {
    return (
      (status.resultReason === "model_unavailable" &&
        (status.resultStatus === "waiting_capacity" ||
          status.resultStatus === "failed")) ||
      (status.progressResultReason === "model_unavailable" &&
        (status.progressResultStatus === "waiting_capacity" ||
          status.progressResultStatus === "failed"))
    );
  }
  if (status.resultReason !== "account_unavailable") return false;
  if (status.resultStatus === "waiting_capacity") return true;
  return (
    status.resultStatus === "blocked" &&
    status.progressResultStatus === "waiting_capacity" &&
    status.progressResultReason === "account_unavailable"
  );
}
