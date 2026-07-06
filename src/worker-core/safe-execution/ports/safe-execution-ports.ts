import type {
  ActiveAttemptRegistry,
  WorkerControlContinuationBatch,
  WorkerControlContinuationSource,
  WorkerControlTarget,
} from "../../control";
import type { WorkerPoolRunOptions } from "../../types";
import type {
  AttemptFailureReason,
  ContinuationMode,
  SafeExecutionFailureClassification,
  SafeExecutionPolicy,
  TaskEffectMode,
} from "../domain/safe-execution-policy";
import type {
  AttemptRecord,
  AttemptUsage,
  ContinuationPacket,
  SafeExecutionTaskRecord,
  SafeExecutionTaskStatus,
  TaskRunId,
  WorkspaceLockHandle,
  WorkspaceRunId,
  WorkspaceSnapshot,
  WorkspaceStrategy,
} from "../domain/safe-execution-task";

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
  readTask(input: { readonly taskId: TaskRunId }): Promise<SafeExecutionTaskRecord | null>;
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
    readonly details?: Readonly<Record<string, string>>;
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
    readonly controlBatch?: WorkerControlContinuationBatch;
  }): ContinuationPacket;
}

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
  readonly classifyError?: (
    error: unknown,
  ) => SafeExecutionFailureClassification;
  readonly summarizeResult?: (result: Result) => string | undefined;
  readonly attemptUsage?: (result: Result) => AttemptUsage | undefined;
  readonly summarizeError?: (error: unknown) => string | undefined;
  readonly summarizeErrorOutput?: (error: unknown) => string | undefined;
  readonly controlTarget?: WorkerControlTarget;
  readonly abortSignal?: AbortSignal;
};

export type SafeExecutionRunResult<Result> =
  | {
      readonly status: "completed";
      readonly task: SafeExecutionTaskRecord;
      readonly result: Result;
      readonly attempts: readonly AttemptRecord[];
      readonly replayed: boolean;
    }
  | {
      readonly status: "waiting_capacity" | "partial" | "failed" | "aborted";
      readonly task: SafeExecutionTaskRecord;
      readonly attempts: readonly AttemptRecord[];
      readonly reason: AttemptFailureReason;
      readonly safeMessage: string;
      readonly failureDetails?: Readonly<Record<string, string>>;
      readonly error?: unknown;
    };

export type SafeExecutionRunnerOptions = {
  readonly lockStore: WorkspaceLockStore;
  readonly journal: AttemptJournal;
  readonly snapshotter?: WorkspaceSnapshotter;
  readonly continuationPacketBuilder?: ContinuationPacketBuilder;
  readonly controlInbox?: WorkerControlContinuationSource;
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly clock?: { now(): Date };
};
