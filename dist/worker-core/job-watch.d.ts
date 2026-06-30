import { type RunReconcilePreviewContinueResult, type RunReconcilePreviewDecision, type RunReconcilePreviewPolicy, type RunReconcilePreviewResult, type RunReconcilePreviewStatus } from "./run-reconcile-preview.js";
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
export type ReconcileWatchableJobsPolicy = Omit<RunReconcilePreviewPolicy, "continueSafeRuns"> & {
    readonly continueSafeJobs?: boolean;
};
/**
 * @deprecated Use RunReconcilePreviewDecision from run-reconcile-preview.
 */
export type WatchableJobDecision = LegacyWatchableJobDecision;
/**
 * @deprecated Use RunReconcilePreviewResult from run-reconcile-preview.
 */
export type ReconcileWatchableJobsResult = Omit<RunReconcilePreviewResult, "decisions"> & {
    readonly decisions: readonly WatchableJobDecision[];
};
/**
 * @deprecated This is a compatibility alias for the legacy codex_goal_watch
 * control preview. Use reconcileRunPreview for new code, or
 * RunObservationService for true read-only watch.
 */
export declare function reconcileWatchableJobs(input: {
    readonly backend: WatchableJobBackend;
    readonly jobIds?: readonly string[];
    readonly policy?: ReconcileWatchableJobsPolicy;
}): Promise<ReconcileWatchableJobsResult>;
type LegacyWatchableJobDecision = RunReconcilePreviewDecision extends infer Decision ? Decision extends {
    readonly status: RunReconcilePreviewStatus;
} ? Omit<Decision, "runId" | "status"> & {
    readonly jobId: string;
    readonly status: WatchableJobStatus;
} : Decision extends {
    readonly runId: string;
} ? Omit<Decision, "runId"> & {
    readonly jobId: string;
} : never : never;
export {};
//# sourceMappingURL=job-watch.d.ts.map