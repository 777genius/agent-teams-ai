import {
  reconcileRunPreview,
  type RunReconcilePreviewBackend,
  type RunReconcilePreviewContinueResult,
  type RunReconcilePreviewDecision,
  type RunReconcilePreviewPolicy,
  type RunReconcilePreviewResult,
  type RunReconcilePreviewStatus,
} from "./run-reconcile-preview";

/**
 * @deprecated Use RunReconcilePreviewStatus from run-reconcile-preview.
 */
export type WatchableJobStatus = Omit<RunReconcilePreviewStatus, "runId"> & {
  readonly jobId: string;
};

/**
 * @deprecated Use RunReconcilePreviewContinueResult from run-reconcile-preview.
 */
export type WatchableJobContinueResult = RunReconcilePreviewContinueResult;

/**
 * @deprecated Use RunReconcilePreviewBackend from run-reconcile-preview.
 */
export type WatchableJobBackend = {
  listJobIds(): Promise<readonly string[]>;
  inspectJob(jobId: string): Promise<WatchableJobStatus>;
  continueJob(jobId: string): Promise<WatchableJobContinueResult>;
};

/**
 * @deprecated Use RunReconcilePreviewPolicy from run-reconcile-preview.
 */
export type ReconcileWatchableJobsPolicy = Omit<
  RunReconcilePreviewPolicy,
  "continueSafeRuns"
> & {
  readonly continueSafeJobs?: boolean;
};

/**
 * @deprecated Use RunReconcilePreviewDecision from run-reconcile-preview.
 */
export type WatchableJobDecision = LegacyWatchableJobDecision;

/**
 * @deprecated Use RunReconcilePreviewResult from run-reconcile-preview.
 */
export type ReconcileWatchableJobsResult = Omit<
  RunReconcilePreviewResult,
  "decisions"
> & {
  readonly decisions: readonly WatchableJobDecision[];
};

export async function reconcileWatchableJobs(input: {
  readonly backend: WatchableJobBackend;
  readonly jobIds?: readonly string[];
  readonly policy?: ReconcileWatchableJobsPolicy;
}): Promise<ReconcileWatchableJobsResult> {
  const backend: RunReconcilePreviewBackend = {
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

type LegacyWatchableJobDecision = RunReconcilePreviewDecision extends infer Decision
  ? Decision extends { readonly status: RunReconcilePreviewStatus }
    ? Omit<Decision, "runId" | "status"> & {
        readonly jobId: string;
        readonly status: WatchableJobStatus;
      }
    : Decision extends { readonly runId: string }
      ? Omit<Decision, "runId"> & { readonly jobId: string }
      : never
  : never;

function toLegacyDecision(
  decision: RunReconcilePreviewDecision,
): WatchableJobDecision {
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
    } as WatchableJobDecision;
  }
  const { runId, ...rest } = decision;
  return {
    ...rest,
    jobId: runId,
  } as WatchableJobDecision;
}
