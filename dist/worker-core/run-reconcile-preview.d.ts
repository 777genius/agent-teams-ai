export type RunReconcilePreviewStatus = {
    readonly runId: string;
    readonly workerAlive: boolean;
    readonly safeToContinue: boolean;
    readonly workspaceKey?: string;
    readonly workspaceDirty?: boolean;
    readonly requiresManualReview?: boolean;
    readonly manualReviewReason?: string;
    readonly continueAfter?: Date;
    readonly summary?: Readonly<Record<string, unknown>>;
};
export type RunReconcilePreviewContinueResult = {
    readonly ok: boolean;
    readonly reason?: string;
    readonly summary?: Readonly<Record<string, unknown>>;
};
export type RunReconcilePreviewBackend = {
    listRunIds(): Promise<readonly string[]>;
    inspectRun(runId: string): Promise<RunReconcilePreviewStatus>;
    continueRun(runId: string): Promise<RunReconcilePreviewContinueResult>;
};
export type RunReconcilePreviewPolicy = {
    readonly continueSafeRuns?: boolean;
    readonly maxContinuesPerRun?: number;
    readonly now?: Date;
};
export type RunReconcilePreviewDecision = {
    readonly runId: string;
    readonly action: "wait";
    readonly reason: "worker_alive";
    readonly status: RunReconcilePreviewStatus;
} | {
    readonly runId: string;
    readonly action: "manual_review";
    readonly reason: string;
    readonly status: RunReconcilePreviewStatus;
} | {
    readonly runId: string;
    readonly action: "blocked";
    readonly reason: string;
    readonly status: RunReconcilePreviewStatus;
} | {
    readonly runId: string;
    readonly action: "skipped";
    readonly reason: string;
    readonly status: RunReconcilePreviewStatus;
} | {
    readonly runId: string;
    readonly action: "would_continue";
    readonly reason: "dry_run";
    readonly status: RunReconcilePreviewStatus;
} | {
    readonly runId: string;
    readonly action: "continued";
    readonly reason: "safe_to_continue";
    readonly status: RunReconcilePreviewStatus;
    readonly result: RunReconcilePreviewContinueResult;
} | {
    readonly runId: string;
    readonly action: "inspect_failed";
    readonly reason: string;
};
export type RunReconcilePreviewResult = {
    readonly ok: boolean;
    readonly checked: number;
    readonly continued: number;
    readonly decisions: readonly RunReconcilePreviewDecision[];
};
export declare function reconcileRunPreview(input: {
    readonly backend: RunReconcilePreviewBackend;
    readonly runIds?: readonly string[];
    readonly policy?: RunReconcilePreviewPolicy;
}): Promise<RunReconcilePreviewResult>;
//# sourceMappingURL=run-reconcile-preview.d.ts.map