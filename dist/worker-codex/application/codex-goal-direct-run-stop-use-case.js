import { buildCodexGoalNoTmuxCommand, reconcileCodexGoalRuntimeResult, } from "../codex-goal-ops.js";
export async function stopDirectCodexGoalRun(input) {
    if (!input.confirmStop) {
        return {
            ok: false,
            reason: "confirm_stop_required",
            jobId: input.manifest.jobId,
            requiredOverride: "confirmStop",
            noTmuxCommand: buildCodexGoalNoTmuxCommand(input.launch),
            status: input.status,
            brief: input.brief,
        };
    }
    if (input.status.resultStatus === "done" || input.status.resultStatus === "completed") {
        return {
            ok: true,
            mode: "stop",
            reason: "terminal_result_already_present",
            jobId: input.manifest.jobId,
            taskId: input.launch.config.taskId,
            statusBefore: input.status,
            brief: input.brief,
            resultReconciliation: null,
            safeMessage: "Direct-run job already has a terminal result. Review workspace/log/result before continuing or recovery.",
        };
    }
    if (input.brief.workerAlive) {
        return {
            ok: false,
            reason: "direct_run_stop_not_supported",
            jobId: input.manifest.jobId,
            taskId: input.launch.config.taskId,
            status: input.status,
            brief: input.brief,
            workerSupervisorKind: input.brief.workerSupervisorKind,
            workerAliveReason: input.brief.workerAliveReason,
            ...(input.status.progressPid === undefined ? {} : { pid: input.status.progressPid }),
            safeMessage: "Direct-run worker appears alive without a tmux session. Use a provider-safe control signal or stop the owning process outside this tool, then reconcile.",
        };
    }
    const resultReconciliation = await reconcileCodexGoalRuntimeResult({
        config: input.launch.config,
        status: input.status,
        reason: "direct_run_not_alive",
        preservePatch: true,
        silentStale: input.brief.silentStale,
        heartbeatOnlyNoOutput: input.brief.heartbeatOnlyNoOutput,
    });
    return {
        ok: true,
        mode: "stop",
        reason: "direct_run_not_alive_reconciled",
        jobId: input.manifest.jobId,
        taskId: input.launch.config.taskId,
        statusBefore: input.status,
        brief: input.brief,
        resultReconciliation,
        safeMessage: "Direct-run job has no live worker and no tmux session. Reconciled runtime result; review workspace/log/result before continuing or recovery.",
    };
}
//# sourceMappingURL=codex-goal-direct-run-stop-use-case.js.map