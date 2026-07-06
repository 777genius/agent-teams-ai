import { randomUUID } from "node:crypto";
import {
  SubscriptionQueueEnqueueStatus,
  SubscriptionQueueError,
  SubscriptionQueueErrorCodeKind,
  SubscriptionQueueFailureStatus,
  SubscriptionTaskStatusKind,
  computeBackoffDelayMs,
  type SubscriptionQueueClaim,
  type SubscriptionQueueEnqueueInput,
  type SubscriptionQueueEnqueueResult,
  type SubscriptionQueueFailResult,
  type SubscriptionQueueTask,
  type SubscriptionRetryPolicy,
  type SubscriptionTaskStatus,
} from "../domain";
import type { SubscriptionTaskQueuePort } from "../ports";

type QueueRecord<Job, Result> = {
  task: SubscriptionQueueTask<Job>;
  status: SubscriptionTaskStatus;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  result: Result | null;
  error: string | null;
};

export class InMemorySubscriptionTaskQueue<
  Job,
  Result = unknown,
> implements SubscriptionTaskQueuePort<Job, Result> {
  readonly queueId: string;
  private readonly records = new Map<string, QueueRecord<Job, Result>>();
  private readonly idempotency = new Map<string, string>();
  private closed = false;

  constructor(options: { readonly queueId: string }) {
    if (!options.queueId.trim()) {
      throw new SubscriptionQueueError(
        SubscriptionQueueErrorCodeKind.Closed,
        "Queue id is required.",
      );
    }
    this.queueId = options.queueId;
  }

  async enqueue(
    input: SubscriptionQueueEnqueueInput<Job>,
  ): Promise<SubscriptionQueueEnqueueResult> {
    this.assertOpen();
    if (input.idempotencyKey) {
      const existingTaskId = this.idempotency.get(input.idempotencyKey);
      if (existingTaskId) {
        return {
          status: SubscriptionQueueEnqueueStatus.IdempotentReplay,
          taskId: existingTaskId,
        };
      }
    }

    const taskId = input.taskId ?? randomUUID();
    if (this.records.has(taskId)) {
      throw new SubscriptionQueueError(
        SubscriptionQueueErrorCodeKind.Duplicate,
        "Task id already exists.",
      );
    }
    const task: SubscriptionQueueTask<Job> = {
      taskId,
      job: input.job,
      attempt: 1,
      maxAttempts: input.maxAttempts ?? 3,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      runAfter: input.runAfter ?? new Date(),
      createdAt: new Date(),
      metadata: input.metadata ?? {},
    };
    this.records.set(taskId, {
      task,
      status: SubscriptionTaskStatusKind.Queued,
      leaseId: null,
      leaseExpiresAt: null,
      result: null,
      error: null,
    });
    if (input.idempotencyKey)
      this.idempotency.set(input.idempotencyKey, taskId);
    return { status: SubscriptionQueueEnqueueStatus.Accepted, taskId };
  }

  async claim(input: {
    readonly leaseTtlMs: number;
    readonly now?: Date;
  }): Promise<SubscriptionQueueClaim<Job> | null> {
    this.assertOpen();
    const now = input.now ?? new Date();
    for (const record of this.records.values()) {
      if (!isClaimable(record, now)) continue;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
      record.status = SubscriptionTaskStatusKind.Leased;
      record.leaseId = leaseId;
      record.leaseExpiresAt = leaseExpiresAt;
      return {
        task: record.task,
        leaseId,
        leaseExpiresAt,
      };
    }
    return null;
  }

  async complete(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly result: Result;
  }): Promise<void> {
    const record = this.requireLeased(input.taskId, input.leaseId);
    record.status = SubscriptionTaskStatusKind.Completed;
    record.result = input.result;
    record.leaseId = null;
    record.leaseExpiresAt = null;
  }

  async release(input: {
    readonly taskId: string;
    readonly leaseId: string;
  }): Promise<void> {
    const record = this.requireLeased(input.taskId, input.leaseId);
    record.status = SubscriptionTaskStatusKind.Queued;
    record.leaseId = null;
    record.leaseExpiresAt = null;
  }

  async fail(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly error: unknown;
    readonly retryPolicy: SubscriptionRetryPolicy;
    readonly now?: Date;
  }): Promise<SubscriptionQueueFailResult> {
    const record = this.requireLeased(input.taskId, input.leaseId);
    const now = input.now ?? new Date();
    record.error = safeError(input.error);
    record.leaseId = null;
    record.leaseExpiresAt = null;

    if (
      record.task.attempt >=
      Math.min(record.task.maxAttempts, input.retryPolicy.maxAttempts)
    ) {
      record.status = SubscriptionTaskStatusKind.DeadLettered;
      return { status: SubscriptionQueueFailureStatus.DeadLettered };
    }

    const nextAttempt = record.task.attempt + 1;
    const runAfter = new Date(
      now.getTime() +
        computeBackoffDelayMs({
          attempt: record.task.attempt,
          policy: input.retryPolicy,
          random: () => 0.5,
        }),
    );
    record.status = SubscriptionTaskStatusKind.RetryScheduled;
    record.task = {
      ...record.task,
      attempt: nextAttempt,
      runAfter,
    };
    return {
      status: SubscriptionQueueFailureStatus.RetryScheduled,
      nextAttempt,
      runAfter,
    };
  }

  async size(
    input: { readonly includeDelayed?: boolean } = {},
  ): Promise<number> {
    const now = new Date();
    return [...this.records.values()].filter((record) => {
      if (
        record.status !== SubscriptionTaskStatusKind.Queued &&
        record.status !== SubscriptionTaskStatusKind.RetryScheduled
      ) {
        return false;
      }
      if (input.includeDelayed) return true;
      return record.task.runAfter <= now;
    }).length;
  }

  close(): void {
    this.closed = true;
  }

  private requireLeased(
    taskId: string,
    leaseId: string,
  ): QueueRecord<Job, Result> {
    const record = this.records.get(taskId);
    if (!record || record.leaseId !== leaseId) {
      throw new SubscriptionQueueError(
        SubscriptionQueueErrorCodeKind.JobNotFound,
        "Leased task was not found.",
      );
    }
    return record;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SubscriptionQueueError(
        SubscriptionQueueErrorCodeKind.Closed,
        "Subscription task queue is closed.",
      );
    }
  }
}

function isClaimable<Job, Result>(
  record: QueueRecord<Job, Result>,
  now: Date,
): boolean {
  if (
    record.status === SubscriptionTaskStatusKind.Leased &&
    record.leaseExpiresAt
  ) {
    return record.leaseExpiresAt <= now;
  }
  return (
    (record.status === SubscriptionTaskStatusKind.Queued ||
      record.status === SubscriptionTaskStatusKind.RetryScheduled) &&
    record.task.runAfter <= now
  );
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (typeof error === "string") return error.slice(0, 500);
  return "unknown";
}
