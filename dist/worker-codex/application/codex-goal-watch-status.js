import { dateValue, stringValue, } from "./codex-goal-input-values.js";
import { workspaceConflictKey } from "./codex-goal-workspace-conflicts.js";
export async function codexOverviewItemToWatchStatus(item) {
    const jobId = stringValue(item.jobId) ?? "unknown";
    const workspacePath = stringValue(item.workspacePath);
    const recommendedAction = stringValue(item.recommendedAction);
    const nextBestTool = stringValue(item.nextBestTool);
    const continueAfter = continueAfterFromOverviewItem(item);
    const requiresManualReview = nextBestTool === "manual_review" ||
        recommendedAction === "inspect_dirty_workspace" ||
        recommendedAction === "inspect_dirty_failure" ||
        recommendedAction === "inspect_failure" ||
        recommendedAction === "check_log_or_result";
    return {
        runId: jobId,
        workerAlive: item.workerAlive === true,
        safeToContinue: item.safeToContinue === true,
        ...(workspacePath ? { workspaceKey: await workspaceConflictKey(workspacePath) } : {}),
        ...(item.workspaceDirty === undefined
            ? {}
            : { workspaceDirty: item.workspaceDirty === true }),
        ...(requiresManualReview ? { requiresManualReview: true } : {}),
        ...(requiresManualReview
            ? { manualReviewReason: nextBestTool ?? recommendedAction ?? "manual_review" }
            : {}),
        ...(continueAfter ? { continueAfter } : {}),
        summary: item,
    };
}
function continueAfterFromOverviewItem(item) {
    const recommendedAction = stringValue(item.recommendedAction);
    if (recommendedAction !== "continue_after_capacity")
        return undefined;
    const accounts = Array.isArray(item.capacityBlockedAccounts)
        ? item.capacityBlockedAccounts
        : [];
    return accounts
        .map((account) => isRecord(account) ? dateValue(account.cooldownUntil) : undefined)
        .filter((value) => value !== undefined)
        .sort((left, right) => left.getTime() - right.getTime())[0];
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-watch-status.js.map