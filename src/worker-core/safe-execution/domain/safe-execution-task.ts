import type {
  AttemptFailureReason,
  TaskEffectMode,
} from "./safe-execution-policy";

export type TaskRunId = string;
export type WorkspaceRunId = string;

export type ExistingLockedWorkspaceStrategy = {
  readonly mode: "existing_locked";
  readonly path: string;
  readonly staleLockMs?: number;
  readonly requireGitWorkspace?: boolean;
};

export type WorkspaceStrategy = ExistingLockedWorkspaceStrategy;

export type AttemptStatus = "running" | "completed" | "blocked" | "failed";

export type SafeExecutionTaskStatus =
  | "running"
  | "completed"
  | "waiting_capacity"
  | "partial"
  | "failed"
  | "aborted";

export type WorkspaceSnapshotMode = "git" | "filesystem" | "unavailable";

export type WorkspaceSnapshot = {
  readonly mode: WorkspaceSnapshotMode;
  readonly workspacePath: string;
  readonly capturedAt: Date;
  readonly dirty: boolean;
  readonly changedFiles: readonly string[];
  readonly diffNumstat?: readonly WorkspaceDiffFileStat[];
  readonly fingerprint: string;
  readonly summary: string;
  readonly diffStat?: string;
  readonly shortDiff?: string;
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
};

export type WorkspaceDiffFileStat = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: boolean;
};

export type AttemptUsageSource =
  | "provider_structured"
  | "legacy_text_reported"
  | "unavailable";

export type AttemptUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type AttemptPatchStatsSource =
  | "git_numstat_delta"
  | "git_numstat_delta_dirty_baseline"
  | "unavailable";

export type AttemptPatchStats = {
  readonly additions: number;
  readonly deletions: number;
  readonly source: AttemptPatchStatsSource;
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
  readonly failureDetails?: Readonly<Record<string, string>>;
  readonly workspaceDirtyBefore: boolean;
  readonly workspaceDirtyAfter?: boolean;
  readonly changedFiles: readonly string[];
  readonly usage?: AttemptUsage;
  readonly usageSource?: AttemptUsageSource;
  readonly patch?: AttemptPatchStats;
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
  readonly workerControlSignalIds?: readonly string[];
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
  readonly lastFailureDetails?: Readonly<Record<string, string>>;
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
