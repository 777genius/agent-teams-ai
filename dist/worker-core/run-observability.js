export class RunObservationService {
    port;
    clock;
    constructor(port, options = {}) {
        this.port = port;
        this.clock = options.clock ?? systemClock;
    }
    async observeRun(input) {
        return normalizeRunObservation({
            snapshot: await this.port.observeRun(input),
            observedAt: this.clock.now(),
        });
    }
    async observeRuns(input = {}) {
        const runIds = input.runIds ?? await this.listRunIds();
        return Promise.all(runIds.map((runId) => this.observeRun({
            runId,
            ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
            ...(input.includeLogTail === undefined
                ? {}
                : { includeLogTail: input.includeLogTail }),
            ...(input.includeChangedFiles === undefined
                ? {}
                : { includeChangedFiles: input.includeChangedFiles }),
        })));
    }
    async listRunIds() {
        if (!this.port.listRunIds)
            return [];
        return this.port.listRunIds();
    }
}
export function decideRunObservation(input) {
    if (input.status === "completed" && input.liveness === "alive") {
        return decision("unsafe_state_mismatch", "completed_result_with_live_process", "A terminal result exists while the worker still appears alive. Inspect process, result and journal before acting.", ["result.status", "process.liveness"]);
    }
    if (input.status !== "running" && input.progress?.status === "running") {
        return decision("unsafe_state_mismatch", "stopped_run_with_running_progress", "The normalized status and progress file disagree. Inspect status sources before acting.", ["status", "progress.status"]);
    }
    if (input.liveness === "stale" || input.progress?.silentStale) {
        return decision("stale_needs_inspection", "observable_progress_stale", "The worker may be alive, but observable progress is stale. Inspect logs, process tree and workspace before acting.", ["progress.heartbeatAgeMs", "progress.staleAfterMs"]);
    }
    if (input.progress?.heartbeatOnlyNoOutput) {
        return decision("stale_needs_inspection", "heartbeat_only_no_output", "The worker heartbeat is fresh, but there is no result, log output or workspace change. Inspect process tree, app-server and workspace before stopping or recovery.", ["progress.heartbeatAgeMs", "logs.byteLength", "result.exists", "workspace.changedFiles"]);
    }
    if (input.status === "completed") {
        return decision("review_completed", "terminal_result_completed", "The run appears completed. Review outputs, logs and workspace before merging or marking reviewed.", ["result.status", "workspace.changedFiles"]);
    }
    if (input.capacity?.some((hint) => isBlockedCapacity(hint)) === true) {
        return decision("capacity_blocked", "account_or_capacity_unavailable", "At least one account or capacity hint is blocked. Wait, relogin, or let a separate decision layer choose recovery.", ["capacity"]);
    }
    if ((input.manualReviewReasons ?? []).length > 0) {
        return decision("manual_review_required", input.manualReviewReasons?.[0] ?? "manual_review_required", "This run requires manual review. Watch remains read-only and will not start, stop or continue it.", ["manualReviewReasons"]);
    }
    if (input.workspace?.dirty && input.status !== "running") {
        return decision("manual_review_required", "dirty_workspace_without_running_worker", "The workspace has changes and no active worker. Review the diff before taking any control action.", ["workspace.changedFiles"]);
    }
    if (input.status === "stopped") {
        return decision("manual_review_required", "stopped_without_terminal_result", "The run is stopped without a completed or failed terminal result. Inspect result, logs and workspace before any recovery.", ["status", "result.exists", "process.liveness"]);
    }
    if (input.status === "failed" || input.status === "unknown") {
        return decision("manual_review_required", input.result?.reason ?? "non_running_or_unknown_failure", "The run is failed or unknown. Inspect result, logs and workspace before any recovery.", ["result.reason", "status"]);
    }
    if ((input.controlInbox?.pendingCount ?? 0) > 0) {
        return decision("keep_watching", "guidance_pending", "Control inbox guidance is pending. Continue watching until the next safe continuation or operator action.", ["controlInbox.pendingCount", "controlInbox.safeToContinue"]);
    }
    if ((input.controlInbox?.deliveredCount ?? 0) > 0) {
        return decision("keep_watching", "guidance_delivered", "Control inbox guidance was delivered. Continue watching the worker result.", ["controlInbox.deliveredCount", "controlInbox.latestDeliveredAt"]);
    }
    return decision("keep_watching", "worker_observable", "The run is observable. Continue watching; no control action is implied by this read-only snapshot.", ["liveness", "progress"]);
}
function normalizeRunObservation(input) {
    const manualReviewReasons = input.snapshot.manualReviewReasons ?? [];
    const warnings = input.snapshot.warnings ?? [];
    const readOnlyDecision = input.snapshot.readOnlyDecision ??
        decideRunObservation({
            status: input.snapshot.status,
            liveness: input.snapshot.liveness,
            ...(input.snapshot.workspace === undefined
                ? {}
                : { workspace: input.snapshot.workspace }),
            ...(input.snapshot.progress === undefined
                ? {}
                : { progress: input.snapshot.progress }),
            ...(input.snapshot.result === undefined
                ? {}
                : { result: input.snapshot.result }),
            ...(input.snapshot.logs === undefined
                ? {}
                : { logs: input.snapshot.logs }),
            ...(input.snapshot.capacity === undefined
                ? {}
                : { capacity: input.snapshot.capacity }),
            ...(input.snapshot.controlInbox === undefined
                ? {}
                : { controlInbox: input.snapshot.controlInbox }),
            manualReviewReasons,
            warnings,
        });
    return {
        ...input.snapshot,
        observedAt: input.snapshot.observedAt || input.observedAt.toISOString(),
        manualReviewReasons,
        warnings,
        readOnlyDecision,
    };
}
function decision(kind, reason, safeMessage, evidence) {
    return {
        kind,
        reason,
        safeMessage,
        ...(evidence ? { evidence } : {}),
    };
}
function isBlockedCapacity(hint) {
    return hint.status === "auth_missing" ||
        hint.status === "auth_invalid" ||
        hint.availability === "cooldown" ||
        hint.availability === "quota_exhausted" ||
        hint.availability === "disabled";
}
const systemClock = {
    now() {
        return new Date();
    },
};
//# sourceMappingURL=run-observability.js.map