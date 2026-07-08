export function codexGoalOrphanRunStatus(input) {
    if (input.status.resultStatus === "done" || input.status.resultStatus === "completed") {
        return "completed";
    }
    if (input.status.resultStatus === "failed")
        return "failed";
    if (input.workerAlive && input.status.progressStatus === "running")
        return "running";
    if (input.workerAlive)
        return "running";
    return "unknown";
}
export function codexGoalOrphanLiveness(input) {
    if (!input.workerAlive)
        return "dead";
    return input.progressStale || input.logStale ? "stale" : "alive";
}
export function codexGoalOrphanManualReviewReasons(input) {
    return [
        "missing_job_manifest",
        ...(input.heartbeatOnlyNoOutput ? ["heartbeat_only_no_output"] : []),
    ];
}
//# sourceMappingURL=codex-goal-orphan-observation-policy.js.map