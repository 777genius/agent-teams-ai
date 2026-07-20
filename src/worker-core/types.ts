import type {
  ObservabilityPort,
  ProviderTask,
  ProviderTaskResult,
  RuntimeEvent,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";

export type SubscriptionWorkerState =
  | "created"
  | "starting"
  | "started"
  | "prewarming"
  | "ready"
  | "draining"
  | "disposed"
  | "failed";

export type SubscriptionWorkerHealth =
  | {
      readonly status: "healthy";
      readonly state: SubscriptionWorkerState;
      readonly checkedAt: Date;
      readonly warnings: readonly RuntimeWarning[];
      readonly details?: Readonly<Record<string, string>>;
    }
  | {
      readonly status: "degraded" | "unhealthy";
      readonly state: SubscriptionWorkerState;
      readonly checkedAt: Date;
      readonly failures: readonly {
        readonly code: string;
        readonly safeMessage: string;
      }[];
      readonly warnings: readonly RuntimeWarning[];
      readonly details?: Readonly<Record<string, string>>;
    };

export type SubscriptionWorkerPrewarmResult = {
  readonly status: "ready" | "skipped";
  readonly warmedAt: Date;
  readonly details?: Readonly<Record<string, string>>;
  readonly warnings: readonly RuntimeWarning[];
};

export type WorkerSlotAvailability =
  | "available"
  | "busy"
  | "warming"
  | "cooldown"
  | "quota_exhausted"
  | "degraded"
  | "disabled";

export type WorkerCapacitySnapshot = {
  readonly availability: WorkerSlotAvailability;
  readonly reason?: string;
  readonly cooldownUntil?: Date;
  readonly recentRuns?: number;
  readonly softLimitRemainingRuns?: number;
  readonly lastLimitSignalAt?: Date;
  readonly details?: Readonly<Record<string, string>>;
};

export type SubscriptionWorkerRunOptions = {
  readonly abortSignal?: AbortSignal;
  readonly onProviderTaskStarted?: () => Promise<void> | void;
};

export interface SubscriptionWorker<Job, Result> {
  readonly workerId: string;
  readonly state: SubscriptionWorkerState;

  start(): Promise<void>;
  prewarm(): Promise<SubscriptionWorkerPrewarmResult>;
  run(job: Job, options?: SubscriptionWorkerRunOptions): Promise<Result>;
  health(): Promise<SubscriptionWorkerHealth>;
  dispose(): Promise<void>;
}

export interface CapacityAwareSubscriptionWorker<Job, Result>
  extends SubscriptionWorker<Job, Result> {
  capacity(): WorkerCapacitySnapshot;
}

export type SubscriptionWorkerFactory<Job, Result> = (input: {
  readonly slotIndex: number;
  readonly workerId: string;
}) => SubscriptionWorker<Job, Result>;

export type WorkerPoolSlotSnapshot = {
  readonly slotIndex: number;
  readonly workerId: string;
  readonly busy: boolean;
  readonly capacity: WorkerCapacitySnapshot;
};

export type WorkerSlotSelector<Job> = (input: {
  readonly slots: readonly WorkerPoolSlotSnapshot[];
  readonly job: Job;
  readonly now: Date;
}) => WorkerPoolSlotSnapshot | null;

export type WorkerPoolOptions<Job, Result> = {
  readonly poolId: string;
  readonly slots: number;
  readonly workerFactory: SubscriptionWorkerFactory<Job, Result>;
  readonly clock?: WorkerPoolClock;
  readonly scheduler?: WorkerPoolScheduler;
  readonly slotSelector?: WorkerSlotSelector<Job>;
  readonly retryPolicy?: WorkerPoolRetryPolicy;
  readonly maxQueueSize?: number;
  readonly startTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly prewarmOnStart?: boolean;
  readonly observability?: ObservabilityPort;
};

export type WorkerPoolClock = {
  now(): Date;
};

export type WorkerPoolScheduler = {
  setTimeout(callback: () => void, delayMs: number): WorkerPoolTimerHandle;
  clearTimeout(handle: WorkerPoolTimerHandle): void;
};

export type WorkerPoolTimerHandle = unknown;

export type WorkerPoolRunOptions = {
  readonly idempotencyKey?: string;
  readonly abortSignal?: AbortSignal;
  readonly onProviderTaskStarted?: () => Promise<void> | void;
  readonly retryPolicy?: WorkerPoolRetryPolicy;
};

export type WorkerPoolRetryPolicy = {
  readonly maxAttempts?: number;
  readonly retryOnSlotCapacityUnavailable?: boolean;
  readonly capacityPollMs?: number;
};

export type WorkerPoolHealth = {
  readonly poolId: string;
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly state: SubscriptionWorkerState;
  readonly checkedAt: Date;
  readonly slots: readonly SubscriptionWorkerHealth[];
  readonly queued: number;
  readonly inFlight: number;
};

export type WorkerPoolStats = {
  readonly poolId: string;
  readonly state: SubscriptionWorkerState;
  readonly slots: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly completed: number;
  readonly failed: number;
  readonly restarted: number;
};

export type WorkerPoolRestartOptions = {
  readonly prewarm?: boolean;
};

export type WorkerTaskEnvelope<Job> = {
  readonly taskId: string;
  readonly job: Job;
  readonly idempotencyKey?: string;
  readonly attempt: number;
  readonly createdAt: Date;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ProviderTaskWorkerJob = {
  readonly runId?: string;
  readonly providerInstanceId?: string;
  readonly task: ProviderTask;
  readonly abortSignal?: AbortSignal;
};

export type ProviderTaskWorkerResult = {
  readonly task: ProviderTaskResult;
  readonly warnings: readonly RuntimeWarning[];
};

export type WorkerRuntimeEvent = RuntimeEvent & {
  readonly workerId?: string;
  readonly poolId?: string;
};
