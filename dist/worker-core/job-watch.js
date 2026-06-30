import { reconcileRunPreview, } from "./run-reconcile-preview.js";
export async function reconcileWatchableJobs(input) {
    const backend = {
        listRunIds: () => input.backend.listJobIds(),
        inspectRun: async (runId) => {
            const status = await input.backend.inspectJob(runId);
            return { ...status, runId: status.jobId };
        },
        continueRun: (runId) => input.backend.continueJob(runId),
    };
    const result = await reconcileRunPreview({
        backend,
        ...(input.jobIds === undefined ? {} : { runIds: input.jobIds }),
        ...(input.policy === undefined
            ? {}
            : {
                policy: {
                    ...(input.policy.continueSafeJobs === undefined
                        ? {}
                        : { continueSafeRuns: input.policy.continueSafeJobs }),
                    ...(input.policy.maxContinuesPerRun === undefined
                        ? {}
                        : { maxContinuesPerRun: input.policy.maxContinuesPerRun }),
                    ...(input.policy.now === undefined ? {} : { now: input.policy.now }),
                },
            }),
    });
    return {
        ok: result.ok,
        checked: result.checked,
        continued: result.continued,
        decisions: result.decisions.map(toLegacyDecision),
    };
}
function toLegacyDecision(decision) {
    if ("status" in decision) {
        const { runId, status, ...rest } = decision;
        const { runId: _runId, ...legacyStatus } = status;
        void _runId;
        return {
            ...rest,
            jobId: runId,
            status: {
                ...legacyStatus,
                jobId: runId,
            },
        };
    }
    const { runId, ...rest } = decision;
    return {
        ...rest,
        jobId: runId,
    };
}
//# sourceMappingURL=job-watch.js.map