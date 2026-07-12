import type {
  AttemptFailureReason,
  TaskEffectMode,
} from "../domain/safe-execution-policy";
import type {
  AttemptRecord,
  SafeExecutionTaskRecord,
  SafeExecutionTaskStatus,
  TaskRunId,
  WorkspaceRunId,
} from "../domain/safe-execution-task";
import type { AttemptJournal } from "../ports/safe-execution-ports";
import { requireTaskRecord } from "../application/safe-execution-task-records";

export class InMemoryAttemptJournal implements AttemptJournal {
  private readonly records = new Map<string, SafeExecutionTaskRecord>();

  async readTask(input: {
    readonly taskId: TaskRunId;
  }): Promise<SafeExecutionTaskRecord | null> {
    return this.records.get(input.taskId) ?? null;
  }

  async startTask(input: {
    readonly taskId: TaskRunId;
    readonly workspaceRunId: WorkspaceRunId;
    readonly workspacePath: string;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly now: Date;
    readonly resumeCompleted?: boolean;
  }): Promise<SafeExecutionTaskRecord> {
    const existing = this.records.get(input.taskId);
    if (existing) {
      const {
        completedAt: _completedAt,
        result: _result,
        lastFailureReason: _lastFailureReason,
        lastFailureMessage: _lastFailureMessage,
        lastFailureDetails: _lastFailureDetails,
        ...resumable
      } = existing;
      const shouldResumeCompleted =
        existing.status === "completed" && input.resumeCompleted === true;
      const next = {
        ...(shouldResumeCompleted ? resumable : existing),
        status: existing.status === "completed" && !shouldResumeCompleted
          ? existing.status
          : "running",
        updatedAt: input.now,
      } satisfies SafeExecutionTaskRecord;
      this.records.set(input.taskId, next);
      return next;
    }
    const record: SafeExecutionTaskRecord = {
      taskId: input.taskId,
      workspaceRunId: input.workspaceRunId,
      workspacePath: input.workspacePath,
      effectMode: input.effectMode,
      provider: input.provider,
      status: "running",
      startedAt: input.now,
      updatedAt: input.now,
      attempts: [],
    };
    this.records.set(input.taskId, record);
    return record;
  }

  async appendAttempt(input: {
    readonly taskId: TaskRunId;
    readonly attempt: AttemptRecord;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "running",
      updatedAt: input.now,
      attempts: [...record.attempts, input.attempt],
      ...(input.attempt.failureReason
        ? {
            lastFailureReason: input.attempt.failureReason,
            lastFailureMessage: input.attempt.failureMessage,
            ...(input.attempt.failureDetails === undefined
              ? {}
              : { lastFailureDetails: input.attempt.failureDetails }),
          }
        : {}),
    };
    this.records.set(input.taskId, next);
    return next;
  }

  async completeTask(input: {
    readonly taskId: TaskRunId;
    readonly result: unknown;
    readonly outputSummary?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "completed",
      updatedAt: input.now,
      completedAt: input.now,
      result: input.result,
      ...(input.outputSummary === undefined
        ? {}
        : { outputSummary: input.outputSummary }),
    };
    this.records.set(input.taskId, next);
    return next;
  }

  async markPartial(input: {
    readonly taskId: TaskRunId;
    readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
    readonly reason: AttemptFailureReason;
    readonly message?: string;
    readonly details?: Readonly<Record<string, string>>;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: input.status,
      updatedAt: input.now,
      lastFailureReason: input.reason,
      ...(input.message === undefined ? {} : { lastFailureMessage: input.message }),
      ...(input.details === undefined ? {} : { lastFailureDetails: input.details }),
    };
    this.records.set(input.taskId, next);
    return next;
  }
}
