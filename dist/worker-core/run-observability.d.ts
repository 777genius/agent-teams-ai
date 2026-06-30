export type RunObservationStatus = "running" | "stopped" | "completed" | "failed" | "unknown";
export type RunObservationLiveness = "alive" | "dead" | "stale" | "unknown";
export type RunReadOnlyDecisionKind = "keep_watching" | "review_completed" | "manual_review_required" | "capacity_blocked" | "stale_needs_inspection" | "unsafe_state_mismatch";
export type RunObservationWarning = {
    readonly code: string;
    readonly message: string;
    readonly severity?: "info" | "warning" | "blocked" | "critical";
};
export type RunObservationWorkspace = {
    readonly path?: string;
    readonly key?: string;
    readonly exists?: boolean;
    readonly dirty?: boolean;
    readonly changedFilesCount?: number;
    readonly changedFiles?: readonly string[];
    readonly warning?: string;
};
export type RunObservationProcess = {
    readonly supervisor?: string;
    readonly sessionId?: string;
    readonly alive?: boolean;
    readonly pid?: number;
    readonly appServerPid?: number;
    readonly command?: string;
    readonly warning?: string;
};
export type RunObservationProgress = {
    readonly status?: string;
    readonly updatedAt?: string;
    readonly heartbeatAgeMs?: number;
    readonly staleAfterMs?: number;
    readonly stale?: boolean;
    readonly silentStale?: boolean;
    readonly heartbeatOnlyNoOutput?: boolean;
    readonly attemptCount?: number;
    readonly currentAccount?: string;
};
export type RunObservationResult = {
    readonly exists?: boolean;
    readonly status?: string;
    readonly reason?: string;
    readonly details?: Readonly<Record<string, string>>;
    readonly updatedAt?: string;
    readonly path?: string;
    readonly warning?: string;
};
export type RunLogExcerpt = {
    readonly path?: string;
    readonly exists?: boolean;
    readonly updatedAt?: string;
    readonly updatedAgeMs?: number;
    readonly staleAfterMs?: number;
    readonly stale?: boolean;
    readonly byteLength?: number;
    readonly tailLines?: number;
    readonly tail?: string;
    readonly truncated?: boolean;
    readonly warning?: string;
};
export type RunArtifactSummary = {
    readonly kind: string;
    readonly path?: string;
    readonly exists?: boolean;
    readonly updatedAt?: string;
    readonly byteLength?: number;
    readonly warning?: string;
};
export type RunCapacityHint = {
    readonly account?: string;
    readonly status?: string;
    readonly availability?: string;
    readonly reason?: string;
    readonly cooldownUntil?: string;
    readonly warning?: string;
};
export type RunControlInboxSummary = {
    readonly pendingCount?: number;
    readonly acceptedCount?: number;
    readonly deliverableCount?: number;
    readonly deliveredCount?: number;
    readonly failedCount?: number;
    readonly latestSignalAt?: string;
    readonly latestDeliveredAt?: string;
    readonly blockedDeliveryCount?: number;
    readonly safeToContinue?: boolean;
};
export type RunReadOnlyDecision = {
    readonly kind: RunReadOnlyDecisionKind;
    readonly reason: string;
    readonly safeMessage: string;
    readonly evidence?: readonly string[];
};
export type RunObservationSnapshot = {
    readonly runId: string;
    readonly providerKind: string;
    readonly observedAt: string;
    readonly status: RunObservationStatus;
    readonly liveness: RunObservationLiveness;
    readonly workspace?: RunObservationWorkspace;
    readonly process?: RunObservationProcess;
    readonly progress?: RunObservationProgress;
    readonly result?: RunObservationResult;
    readonly logs?: RunLogExcerpt;
    readonly artifacts?: readonly RunArtifactSummary[];
    readonly capacity?: readonly RunCapacityHint[];
    readonly controlInbox?: RunControlInboxSummary;
    readonly manualReviewReasons?: readonly string[];
    readonly warnings: readonly RunObservationWarning[];
    readonly readOnlyDecision: RunReadOnlyDecision;
};
export type RunObservationPort = {
    listRunIds?(): Promise<readonly string[]>;
    observeRun(input: RunObservationRequest): Promise<RunObservationSnapshot>;
};
export type RunObservationRequest = {
    readonly runId: string;
    readonly tailLines?: number;
    readonly includeLogTail?: boolean;
    readonly includeChangedFiles?: boolean;
};
export type RunObservationServiceOptions = {
    readonly clock?: {
        now(): Date;
    };
};
export declare class RunObservationService {
    private readonly port;
    private readonly clock;
    constructor(port: RunObservationPort, options?: RunObservationServiceOptions);
    observeRun(input: RunObservationRequest): Promise<RunObservationSnapshot>;
    observeRuns(input?: {
        readonly runIds?: readonly string[];
        readonly tailLines?: number;
        readonly includeLogTail?: boolean;
        readonly includeChangedFiles?: boolean;
    }): Promise<readonly RunObservationSnapshot[]>;
    listRunIds(): Promise<readonly string[]>;
}
export declare function decideRunObservation(input: {
    readonly status: RunObservationStatus;
    readonly liveness: RunObservationLiveness;
    readonly workspace?: RunObservationWorkspace;
    readonly progress?: RunObservationProgress;
    readonly result?: RunObservationResult;
    readonly capacity?: readonly RunCapacityHint[];
    readonly controlInbox?: RunControlInboxSummary;
    readonly manualReviewReasons?: readonly string[];
    readonly warnings?: readonly RunObservationWarning[];
}): RunReadOnlyDecision;
//# sourceMappingURL=run-observability.d.ts.map