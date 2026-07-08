import type {
  ActiveAttemptRegistry,
  WorkerControlContinuationSource,
  WorkerControlTarget,
} from "../../control";
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
  TaskRunId,
  WorkspaceRunId,
  WorkspaceStrategy,
} from "../domain/safe-execution-task";
import type {
  AttemptJournal,
  ContinuationPacketBuilder,
  SafeExecutionRuntime,
  SafeExecutionWorkerPool,
  SafeExecutionWorkspaceAccess,
  WorkspaceLockStore,
  WorkspaceSnapshotter,
} from "../ports/safe-execution-ports";

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
  readonly workspaceAccess?: SafeExecutionWorkspaceAccess;
  readonly runtime?: SafeExecutionRuntime;
  readonly continuationPacketBuilder?: ContinuationPacketBuilder;
  readonly controlInbox?: WorkerControlContinuationSource;
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly clock?: { now(): Date };
};

export type SafeExecutionStartedTaskInput = {
  readonly taskId: TaskRunId;
  readonly workspaceRunId: WorkspaceRunId;
  readonly workspacePath: string;
  readonly effectMode: TaskEffectMode;
  readonly provider: string;
  readonly now: Date;
};
