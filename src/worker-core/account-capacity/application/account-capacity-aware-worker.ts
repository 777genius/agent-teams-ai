import { SubscriptionWorkerError } from "../../errors";
import type {
  CapacityAwareSubscriptionWorker,
  SubscriptionWorker,
  SubscriptionWorkerFactory,
  SubscriptionWorkerHealth,
  SubscriptionWorkerPrewarmResult,
  SubscriptionWorkerRunOptions,
  SubscriptionWorkerState,
  WorkerCapacitySnapshot,
} from "../../types";
import {
  defaultAccountIdFromCapacityDetails,
  defaultRuntimeDemandFromCapacityDetails,
  defaultWorkerAccountLimitReasons,
  isWorkerAccountLimitCapacity,
  mergeWorkerAndAccountCapacity,
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  withAccountDetails,
  type WorkerRuntimeDemand,
} from "../domain";
import { normalizeWorkerCapacitySnapshot } from "../domain/worker-capacity-recovery-policy";
import type { WorkerAccountCapacityStore } from "../ports";

export type AccountCapacityAwareWorkerOptions<Job, Result> = {
  readonly worker: SubscriptionWorker<Job, Result>;
  readonly accountCapacityStore: WorkerAccountCapacityStore;
  readonly accountId?: string;
  readonly accountIdFromCapacityDetails?: (
    details: Readonly<Record<string, string>> | undefined,
  ) => string | null;
  readonly runtimeDemand?: WorkerRuntimeDemand;
  readonly runtimeDemandFromCapacityDetails?: (
    details: Readonly<Record<string, string>> | undefined,
  ) => WorkerRuntimeDemand | null;
  readonly limitReasons?: readonly string[];
  readonly clock?: { now(): Date };
};

export type AccountCapacityAwareWorkerFactoryOptions<Job, Result> = Omit<
  AccountCapacityAwareWorkerOptions<Job, Result>,
  "worker"
> & {
  readonly workerFactory: SubscriptionWorkerFactory<Job, Result>;
};

export class AccountCapacityAwareWorker<Job, Result>
  implements CapacityAwareSubscriptionWorker<Job, Result>
{
  private readonly clock: { now(): Date };
  private readonly limitReasons: readonly string[];

  constructor(
    private readonly options: AccountCapacityAwareWorkerOptions<Job, Result>,
  ) {
    this.clock = options.clock ?? systemClock;
    this.limitReasons = options.limitReasons ?? defaultWorkerAccountLimitReasons;
  }

  get workerId(): string {
    return this.options.worker.workerId;
  }

  get state(): SubscriptionWorkerState {
    return this.options.worker.state;
  }

  start(): Promise<void> {
    return this.options.worker.start();
  }

  prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    return this.options.worker.prewarm();
  }

  async run(
    job: Job,
    options?: SubscriptionWorkerRunOptions,
  ): Promise<Result> {
    const current = this.capacity();
    if (current.availability !== "available") {
      throw new SubscriptionWorkerError(
        "subscription_worker_account_unavailable",
        "Worker account capacity is unavailable.",
        {
          details: {
            workerId: this.workerId,
            availability: current.availability,
            ...(current.reason ? { reason: current.reason } : {}),
            ...(current.cooldownUntil
              ? { cooldownUntil: current.cooldownUntil.toISOString() }
              : {}),
            ...(current.details?.accountId
              ? { accountId: current.details.accountId }
              : {}),
          },
        },
      );
    }

    try {
      const result = await this.options.worker.run(job, options);
      this.observeWorkerCapacity(this.workerCapacity());
      return result;
    } catch (error) {
      this.observeWorkerCapacity(this.workerCapacity());
      throw error;
    }
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    const health = await this.options.worker.health();
    const capacity = this.capacity();
    if (capacity.availability === "available" || health.status !== "healthy") {
      return health;
    }
    return {
      status: "degraded",
      state: health.state,
      checkedAt: health.checkedAt,
      failures: [
        {
          code: capacity.reason ?? capacity.availability,
          safeMessage: `Worker account capacity is ${capacity.availability}.`,
        },
      ],
      warnings: health.warnings,
      details: {
        ...(health.details ?? {}),
        ...(capacity.details ?? {}),
      },
    };
  }

  capacity(): WorkerCapacitySnapshot {
    const now = this.clock.now();
    const workerCapacity = normalizeWorkerCapacitySnapshot(
      this.workerCapacity(),
      now,
    );
    this.observeWorkerCapacity(workerCapacity);
    const accountId = this.accountId(workerCapacity);
    if (!accountId) return workerCapacity;
    const demand = this.runtimeDemand(workerCapacity);

    const accountCapacity = this.options.accountCapacityStore.read({
      accountId,
      ...(demand ? { demand } : {}),
      now,
    });
    if (!accountCapacity) {
      return withAccountDetails(workerCapacity, accountId);
    }

    return mergeWorkerAndAccountCapacity(
      withAccountDetails(workerCapacity, accountId),
      withAccountDetails(accountCapacity, accountId),
    );
  }

  dispose(): Promise<void> {
    return this.options.worker.dispose();
  }

  private workerCapacity(): WorkerCapacitySnapshot {
    const worker = this.options.worker;
    if (isCapacityAwareWorker(worker)) return worker.capacity();
    return { availability: "available" };
  }

  private observeWorkerCapacity(capacity: WorkerCapacitySnapshot): void {
    if (!isWorkerAccountLimitCapacity(capacity, this.limitReasons)) return;
    const accountId = this.accountId(capacity);
    if (!accountId) return;
    const demand = this.runtimeDemand(capacity);
    this.options.accountCapacityStore.observe({
      accountId,
      ...(demand ? { demand } : {}),
      capacity,
      observedAt: capacity.lastLimitSignalAt ?? this.clock.now(),
      sourceWorkerId: this.workerId,
    });
  }

  private accountId(capacity: WorkerCapacitySnapshot): string | null {
    const explicitAccountId = normalizeWorkerAccountId(this.options.accountId);
    if (explicitAccountId) return explicitAccountId;
    return (
      this.options.accountIdFromCapacityDetails?.(capacity.details) ??
      defaultAccountIdFromCapacityDetails(capacity.details)
    );
  }

  private runtimeDemand(
    capacity: WorkerCapacitySnapshot,
  ): WorkerRuntimeDemand | null {
    return (
      normalizeWorkerRuntimeDemand(this.options.runtimeDemand) ??
      this.options.runtimeDemandFromCapacityDetails?.(capacity.details) ??
      defaultRuntimeDemandFromCapacityDetails(capacity.details)
    );
  }
}

export function accountCapacityAwareWorkerFactory<Job, Result>(
  options: AccountCapacityAwareWorkerFactoryOptions<Job, Result>,
): SubscriptionWorkerFactory<Job, Result> {
  return (input) =>
    new AccountCapacityAwareWorker({
      worker: options.workerFactory(input),
      accountCapacityStore: options.accountCapacityStore,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.accountIdFromCapacityDetails
        ? {
            accountIdFromCapacityDetails:
              options.accountIdFromCapacityDetails,
          }
        : {}),
      ...(options.runtimeDemand ? { runtimeDemand: options.runtimeDemand } : {}),
      ...(options.runtimeDemandFromCapacityDetails
        ? {
            runtimeDemandFromCapacityDetails:
              options.runtimeDemandFromCapacityDetails,
          }
        : {}),
      ...(options.limitReasons ? { limitReasons: options.limitReasons } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
}

function isCapacityAwareWorker<Job, Result>(
  worker: SubscriptionWorker<Job, Result>,
): worker is CapacityAwareSubscriptionWorker<Job, Result> {
  return typeof (worker as { capacity?: unknown }).capacity === "function";
}

const systemClock = {
  now(): Date {
    return new Date();
  },
};
