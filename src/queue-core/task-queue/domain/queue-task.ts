export enum SubscriptionTaskStatusKind {
  Queued = "queued",
  Leased = "leased",
  Completed = "completed",
  RetryScheduled = "retry_scheduled",
  DeadLettered = "dead_lettered",
}

export type SubscriptionTaskStatus = `${SubscriptionTaskStatusKind}`;

export enum SubscriptionQueueEnqueueStatus {
  Accepted = "accepted",
  IdempotentReplay = "idempotent_replay",
}

export enum SubscriptionQueueFailureStatus {
  RetryScheduled = "retry_scheduled",
  DeadLettered = "dead_lettered",
}

export type SubscriptionQueueTask<Job> = {
  readonly taskId: string;
  readonly job: Job;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey?: string;
  readonly runAfter: Date;
  readonly createdAt: Date;
  readonly metadata: Readonly<Record<string, string>>;
};

export type SubscriptionQueueClaim<Job> = {
  readonly task: SubscriptionQueueTask<Job>;
  readonly leaseId: string;
  readonly leaseExpiresAt: Date;
};

export type SubscriptionQueueEnqueueInput<Job> = {
  readonly taskId?: string;
  readonly job: Job;
  readonly idempotencyKey?: string;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type SubscriptionQueueEnqueueResult =
  | {
      readonly status: `${SubscriptionQueueEnqueueStatus.Accepted}`;
      readonly taskId: string;
    }
  | {
      readonly status: `${SubscriptionQueueEnqueueStatus.IdempotentReplay}`;
      readonly taskId: string;
    };

export type SubscriptionQueueFailResult =
  | {
      readonly status: `${SubscriptionQueueFailureStatus.RetryScheduled}`;
      readonly nextAttempt: number;
      readonly runAfter: Date;
    }
  | {
      readonly status: `${SubscriptionQueueFailureStatus.DeadLettered}`;
    };
