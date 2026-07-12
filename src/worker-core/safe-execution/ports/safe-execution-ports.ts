import type { WorkerControlContinuationBatch } from "../../control";
import type { WorkerPoolRunOptions } from "../../types";
import type {
  AttemptFailureReason,
  TaskEffectMode,
} from "../domain/safe-execution-policy";
import type {
  AttemptRecord,
  ContinuationPacket,
  SafeExecutionTaskRecord,
  SafeExecutionTaskStatus,
  TaskRunId,
  WorkspaceLockHandle,
  WorkspaceRunId,
  WorkspaceSnapshot,
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
    readonly resumeCompleted?: boolean;
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

export interface SafeExecutionWorkspaceAccess {
  canonicalizePath(input: { readonly path: string }): Promise<string>;
  assertGitWorkspace(input: {
    readonly workspacePath: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<void>;
}

export interface SafeExecutionRuntime {
  createOwnerId(): string;
  currentPid(): number | undefined;
}

export interface SafeExecutionCommandRunner {
  run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<{
    readonly stdout: string;
    readonly stderr: string;
  }>;
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
