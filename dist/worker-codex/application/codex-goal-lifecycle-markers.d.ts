/// <reference types="node" />
type JsonObject = Readonly<Record<string, unknown>>;
type CodexGoalLifecycleBrief = {
    readonly silentStale?: boolean | undefined;
    readonly heartbeatOnlyNoOutput?: boolean | undefined;
    readonly lastProgressAt?: string | undefined;
    readonly lastProgressAgeMs?: number | undefined;
    readonly staleAfterMs?: number | undefined;
    readonly logByteLength?: number | undefined;
};
export declare function readCodexGoalLifecycleMarkers(input: {
    readonly jobRootDir: string;
    readonly taskId: string;
}): Promise<readonly JsonObject[]>;
export declare function writeCodexGoalReviewMarker(input: {
    readonly jobId: string;
    readonly taskId: string;
    readonly jobRootDir: string;
    readonly note: string;
    readonly status: unknown;
}): Promise<string>;
export declare function writeCodexGoalStopEvent(input: {
    readonly jobId: string;
    readonly taskId: string;
    readonly jobRootDir: string;
    readonly tmuxSession?: string;
    readonly stopCommand: string;
    readonly forceStop: boolean;
    readonly statusBefore: unknown;
    readonly statusAfter: unknown;
    readonly brief: CodexGoalLifecycleBrief;
}): Promise<string>;
export declare function writeCodexGoalMaintenancePauseEvent(input: {
    readonly jobId: string;
    readonly taskId: string;
    readonly jobRootDir: string;
    readonly tmuxSession: string;
    readonly stopCommand: string;
    readonly reason: string;
    readonly forcePause: boolean;
    readonly statusBefore: unknown;
    readonly statusAfter: unknown;
    readonly brief: CodexGoalLifecycleBrief;
}): Promise<string>;
export declare function writeCodexGoalStoppedProgress(input: {
    readonly progressPath: string;
    readonly taskId: string;
    readonly status: "stopped" | "maintenance_paused";
    readonly reason?: string;
}): Promise<void>;
export {};
//# sourceMappingURL=codex-goal-lifecycle-markers.d.ts.map