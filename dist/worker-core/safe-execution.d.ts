import type { WorkerPoolRunOptions } from "./types.js";
export type TaskRunId = string;
export type WorkspaceRunId = string;
export type TaskEffectMode = "read_only" | "workspace_patch" | "external_side_effects";
export type ExistingLockedWorkspaceStrategy = {
    readonly mode: "existing_locked";
    readonly path: string;
    readonly staleLockMs?: number;
    readonly requireGitWorkspace?: boolean;
};
export type WorkspaceStrategy = ExistingLockedWorkspaceStrategy;
export type ContinuationMode = "packet_first" | "disabled";
export type SafeExecutionPolicy = {
    readonly retryOnCapacity?: boolean;
    readonly retryOnAccountUnavailable?: boolean;
    readonly retryOnReconnectRequired?: boolean;
    readonly retryUnknownCleanWorkspace?: boolean;
    readonly retryUnknownChangedWorkspace?: boolean;
    readonly maxAttempts?: number;
    readonly continuationMode?: ContinuationMode;
};
export type AttemptFailureReason = "quota_limited" | "capacity_unavailable" | "account_unavailable" | "reconnect_required" | "permission_required" | "task_timeout" | "provider_output_invalid" | "user_abort" | "unknown_error";
export type AttemptStatus = "running" | "completed" | "blocked" | "failed";
export type SafeExecutionTaskStatus = "running" | "completed" | "partial" | "failed" | "aborted";
export type WorkspaceSnapshotMode = "git" | "filesystem" | "unavailable";
export type WorkspaceSnapshot = {
    readonly mode: WorkspaceSnapshotMode;
    readonly workspacePath: string;
    readonly capturedAt: Date;
    readonly dirty: boolean;
    readonly changedFiles: readonly string[];
    readonly fingerprint: string;
    readonly summary: string;
    readonly diffStat?: string;
    readonly shortDiff?: string;
    readonly truncated?: boolean;
    readonly warnings?: readonly string[];
};
export type AttemptRecord = {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly workerId?: string;
    readonly accountId?: string;
    readonly provider: string;
    readonly startedAt: Date;
    readonly finishedAt?: Date;
    readonly status: AttemptStatus;
    readonly failureReason?: AttemptFailureReason;
    readonly failureMessage?: string;
    readonly workspaceDirtyBefore: boolean;
    readonly workspaceDirtyAfter?: boolean;
    readonly changedFiles: readonly string[];
    readonly lastOutputSummary?: string;
};
export type ContinuationPacket = {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly changedFiles: readonly string[];
    readonly workspaceSummary: string;
    readonly previousOutputSummary?: string;
    readonly message: string;
};
export type SafeExecutionTaskRecord = {
    readonly taskId: TaskRunId;
    readonly workspaceRunId: WorkspaceRunId;
    readonly workspacePath: string;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly status: SafeExecutionTaskStatus;
    readonly startedAt: Date;
    readonly updatedAt: Date;
    readonly attempts: readonly AttemptRecord[];
    readonly completedAt?: Date;
    readonly result?: unknown;
    readonly outputSummary?: string;
    readonly lastFailureReason?: AttemptFailureReason;
    readonly lastFailureMessage?: string;
};
export type WorkspaceLockRecord = {
    readonly taskId: TaskRunId;
    readonly workspacePath: string;
    readonly ownerId: string;
    readonly ownerPid?: number;
    readonly acquiredAt: Date;
    readonly staleLockMs?: number;
};
export type WorkspaceLockHandle = WorkspaceLockRecord & {
    release(): Promise<void>;
};
export interface WorkspaceLockStore {
    acquire(input: {
        readonly taskId: TaskRunId;
        readonly workspacePath: string;
        readonly ownerId: string;
        readonly ownerPid?: number;
        readonly staleLockMs?: number;
        readonly now?: Date;
    }): Promise<WorkspaceLockHandle>;
}
export interface AttemptJournal {
    readTask(input: {
        readonly taskId: TaskRunId;
    }): Promise<SafeExecutionTaskRecord | null>;
    startTask(input: {
        readonly taskId: TaskRunId;
        readonly workspaceRunId: WorkspaceRunId;
        readonly workspacePath: string;
        readonly effectMode: TaskEffectMode;
        readonly provider: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    appendAttempt(input: {
        readonly taskId: TaskRunId;
        readonly attempt: AttemptRecord;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    completeTask(input: {
        readonly taskId: TaskRunId;
        readonly result: unknown;
        readonly outputSummary?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    markPartial(input: {
        readonly taskId: TaskRunId;
        readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
        readonly reason: AttemptFailureReason;
        readonly message?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
}
export interface WorkspaceSnapshotter {
    capture(input: {
        readonly workspacePath: string;
        readonly includeDiff?: boolean;
        readonly abortSignal?: AbortSignal;
    }): Promise<WorkspaceSnapshot>;
}
export interface ContinuationPacketBuilder {
    build(input: {
        readonly taskId: TaskRunId;
        readonly attemptNumber: number;
        readonly provider: string;
        readonly workspacePath: string;
        readonly originalPrompt: string;
        readonly previousFailureReason: AttemptFailureReason;
        readonly snapshot: WorkspaceSnapshot;
        readonly previousOutputSummary?: string;
    }): ContinuationPacket;
}
export type SafeExecutionErrorCode = "safe_execution_invalid_task" | "safe_execution_workspace_locked" | "safe_execution_workspace_not_git" | "safe_execution_external_retry_disabled" | "safe_execution_continuation_disabled" | "safe_execution_attempts_exhausted";
export declare class SafeExecutionError extends Error {
    readonly code: SafeExecutionErrorCode;
    constructor(code: SafeExecutionErrorCode, message: string, options?: {
        readonly cause?: unknown;
        readonly details?: Readonly<Record<string, string>>;
    });
    readonly details: Readonly<Record<string, string>>;
}
export declare function isSafeExecutionError(error: unknown): error is SafeExecutionError;
export type SafeExecutionFailureClassification = {
    readonly reason: AttemptFailureReason;
    readonly safeMessage: string;
    readonly retryable: boolean;
};
export type SafeExecutionWorkerPool<Job, Result> = {
    run(job: Job, options?: WorkerPoolRunOptions): Promise<Result>;
};
export type SafeExecutionRunInput<Job, Result> = {
    readonly taskId: TaskRunId;
    readonly workspace: WorkspaceStrategy;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly pool: SafeExecutionWorkerPool<Job, Result>;
    readonly job: Job;
    readonly originalPrompt: string;
    readonly continuationMode?: ContinuationMode;
    readonly policy?: SafeExecutionPolicy;
    readonly continuationJobFactory?: (input: {
        readonly job: Job;
        readonly continuationPacket: ContinuationPacket;
        readonly attemptNumber: number;
    }) => Job;
    readonly attemptMetadata?: (input: {
        readonly result?: Result;
        readonly error?: unknown;
    }) => {
        readonly workerId?: string;
        readonly accountId?: string;
    };
    readonly classifyError?: (error: unknown) => SafeExecutionFailureClassification;
    readonly summarizeResult?: (result: Result) => string | undefined;
    readonly summarizeError?: (error: unknown) => string | undefined;
    readonly abortSignal?: AbortSignal;
};
export type SafeExecutionRunResult<Result> = {
    readonly status: "completed";
    readonly task: SafeExecutionTaskRecord;
    readonly result: Result;
    readonly attempts: readonly AttemptRecord[];
    readonly replayed: boolean;
} | {
    readonly status: "partial" | "failed" | "aborted";
    readonly task: SafeExecutionTaskRecord;
    readonly attempts: readonly AttemptRecord[];
    readonly reason: AttemptFailureReason;
    readonly safeMessage: string;
    readonly error?: unknown;
};
export type SafeExecutionRunnerOptions = {
    readonly lockStore: WorkspaceLockStore;
    readonly journal: AttemptJournal;
    readonly snapshotter?: WorkspaceSnapshotter;
    readonly continuationPacketBuilder?: ContinuationPacketBuilder;
    readonly ownerId?: string;
    readonly ownerPid?: number;
    readonly clock?: {
        now(): Date;
    };
};
export declare class InMemoryWorkspaceLockStore implements WorkspaceLockStore {
    private readonly locks;
    acquire(input: {
        readonly taskId: TaskRunId;
        readonly workspacePath: string;
        readonly ownerId: string;
        readonly ownerPid?: number;
        readonly staleLockMs?: number;
        readonly now?: Date;
    }): Promise<WorkspaceLockHandle>;
}
export declare class LocalFileWorkspaceLockStore implements WorkspaceLockStore {
    private readonly rootDir;
    constructor(rootDir: string);
    acquire(input: {
        readonly taskId: TaskRunId;
        readonly workspacePath: string;
        readonly ownerId: string;
        readonly ownerPid?: number;
        readonly staleLockMs?: number;
        readonly now?: Date;
    }): Promise<WorkspaceLockHandle>;
}
export declare class InMemoryAttemptJournal implements AttemptJournal {
    private readonly records;
    readTask(input: {
        readonly taskId: TaskRunId;
    }): Promise<SafeExecutionTaskRecord | null>;
    startTask(input: {
        readonly taskId: TaskRunId;
        readonly workspaceRunId: WorkspaceRunId;
        readonly workspacePath: string;
        readonly effectMode: TaskEffectMode;
        readonly provider: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    appendAttempt(input: {
        readonly taskId: TaskRunId;
        readonly attempt: AttemptRecord;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    completeTask(input: {
        readonly taskId: TaskRunId;
        readonly result: unknown;
        readonly outputSummary?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    markPartial(input: {
        readonly taskId: TaskRunId;
        readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
        readonly reason: AttemptFailureReason;
        readonly message?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
}
export declare class LocalFileAttemptJournal implements AttemptJournal {
    private readonly rootDir;
    constructor(rootDir: string);
    readTask(input: {
        readonly taskId: TaskRunId;
    }): Promise<SafeExecutionTaskRecord | null>;
    startTask(input: {
        readonly taskId: TaskRunId;
        readonly workspaceRunId: WorkspaceRunId;
        readonly workspacePath: string;
        readonly effectMode: TaskEffectMode;
        readonly provider: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    appendAttempt(input: {
        readonly taskId: TaskRunId;
        readonly attempt: AttemptRecord;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    completeTask(input: {
        readonly taskId: TaskRunId;
        readonly result: unknown;
        readonly outputSummary?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    markPartial(input: {
        readonly taskId: TaskRunId;
        readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
        readonly reason: AttemptFailureReason;
        readonly message?: string;
        readonly now: Date;
    }): Promise<SafeExecutionTaskRecord>;
    private taskPath;
    private writeTask;
}
export type DefaultWorkspaceSnapshotterOptions = {
    readonly gitBinaryPath?: string;
    readonly commandTimeoutMs?: number;
    readonly maxDiffBytes?: number;
    readonly maxFilesystemEntries?: number;
    readonly ignoredDirectories?: readonly string[];
};
export declare class DefaultWorkspaceSnapshotter implements WorkspaceSnapshotter {
    private readonly gitBinaryPath;
    private readonly commandTimeoutMs;
    private readonly maxDiffBytes;
    private readonly maxFilesystemEntries;
    private readonly ignoredDirectories;
    constructor(options?: DefaultWorkspaceSnapshotterOptions);
    capture(input: {
        readonly workspacePath: string;
        readonly includeDiff?: boolean;
        readonly abortSignal?: AbortSignal;
    }): Promise<WorkspaceSnapshot>;
    private captureGit;
    private captureFilesystem;
    private isGitWorkspace;
    private git;
    private shortGitDiff;
    private gitDiffNameOnly;
    private scanFilesystem;
}
export declare class DefaultContinuationPacketBuilder implements ContinuationPacketBuilder {
    build(input: {
        readonly taskId: TaskRunId;
        readonly attemptNumber: number;
        readonly provider: string;
        readonly workspacePath: string;
        readonly originalPrompt: string;
        readonly previousFailureReason: AttemptFailureReason;
        readonly snapshot: WorkspaceSnapshot;
        readonly previousOutputSummary?: string;
    }): ContinuationPacket;
}
export declare class SafeExecutionRunner {
    private readonly options;
    private readonly snapshotter;
    private readonly continuationPacketBuilder;
    private readonly ownerId;
    private readonly ownerPid;
    private readonly clock;
    constructor(options: SafeExecutionRunnerOptions);
    run<Job, Result>(input: SafeExecutionRunInput<Job, Result>): Promise<SafeExecutionRunResult<Result>>;
}
export declare function promptContinuationJobFactory<Job extends {
    readonly prompt: string;
}>(input: {
    readonly job: Job;
    readonly continuationPacket: ContinuationPacket;
}): Job;
export declare function defaultSafeExecutionErrorClassifier(error: unknown): SafeExecutionFailureClassification;
//# sourceMappingURL=safe-execution.d.ts.map