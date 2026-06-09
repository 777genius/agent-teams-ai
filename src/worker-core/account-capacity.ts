import { SubscriptionWorkerError } from "./errors";
import type {
  CapacityAwareSubscriptionWorker,
  SubscriptionWorker,
  SubscriptionWorkerHealth,
  SubscriptionWorkerPrewarmResult,
  SubscriptionWorkerFactory,
  SubscriptionWorkerRunOptions,
  SubscriptionWorkerState,
  WorkerCapacitySnapshot,
} from "./types";

export type WorkerAccountCapacityStore = {
  read(input: {
    readonly accountId: string;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null;
  observe(input: WorkerAccountLimitSignal): void;
  clear(input: { readonly accountId: string }): void;
};

export type WorkerAccountLimitSignal = {
  readonly accountId: string;
  readonly capacity: WorkerCapacitySnapshot;
  readonly observedAt: Date;
  readonly sourceWorkerId?: string;
};

export type AccountCapacityAwareWorkerOptions<Job, Result> = {
  readonly worker: SubscriptionWorker<Job, Result>;
  readonly accountCapacityStore: WorkerAccountCapacityStore;
  readonly accountId?: string;
  readonly accountIdFromCapacityDetails?: (
    details: Readonly<Record<string, string>> | undefined,
  ) => string | null;
  readonly limitReasons?: readonly string[];
  readonly clock?: { now(): Date };
};

export type AccountCapacityAwareWorkerFactoryOptions<Job, Result> = Omit<
  AccountCapacityAwareWorkerOptions<Job, Result>,
  "worker"
> & {
  readonly workerFactory: SubscriptionWorkerFactory<Job, Result>;
};

const defaultLimitReasons = [
  "rate_limit_threshold",
  "quota_limited",
  "account_exhausted",
] as const;

export class InMemoryWorkerAccountCapacityStore
  implements WorkerAccountCapacityStore
{
  private readonly records = new Map<string, WorkerCapacitySnapshot>();

  read(input: {
    readonly accountId: string;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null {
    const current = this.records.get(input.accountId);
    if (!current) return null;
    const now = input.now ?? new Date();
    if (
      current.cooldownUntil &&
      current.cooldownUntil.getTime() <= now.getTime()
    ) {
      this.records.delete(input.accountId);
      return null;
    }
    return current;
  }

  observe(input: WorkerAccountLimitSignal): void {
    const capacity = normalizeAccountCapacitySignal(input);
    if (!capacity) return;

    const existing = this.read({
      accountId: input.accountId,
      now: input.observedAt,
    });
    if (existing && shouldKeepExistingAccountCapacity(existing, capacity)) {
      return;
    }
    this.records.set(input.accountId, capacity);
  }

  clear(input: { readonly accountId: string }): void {
    this.records.delete(input.accountId);
  }
}

export class AccountCapacityAwareWorker<Job, Result>
  implements CapacityAwareSubscriptionWorker<Job, Result>
{
  private readonly clock: { now(): Date };
  private readonly limitReasons: readonly string[];

  constructor(
    private readonly options: AccountCapacityAwareWorkerOptions<Job, Result>,
  ) {
    this.clock = options.clock ?? systemClock;
    this.limitReasons = options.limitReasons ?? defaultLimitReasons;
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
    const workerCapacity = this.workerCapacity();
    this.observeWorkerCapacity(workerCapacity);
    const accountId = this.accountId(workerCapacity);
    if (!accountId) return workerCapacity;

    const accountCapacity = this.options.accountCapacityStore.read({
      accountId,
      now: this.clock.now(),
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
    if (!isAccountLimitCapacity(capacity, this.limitReasons)) return;
    const accountId = this.accountId(capacity);
    if (!accountId) return;
    this.options.accountCapacityStore.observe({
      accountId,
      capacity,
      observedAt: capacity.lastLimitSignalAt ?? this.clock.now(),
      sourceWorkerId: this.workerId,
    });
  }

  private accountId(capacity: WorkerCapacitySnapshot): string | null {
    if (this.options.accountId) return this.options.accountId;
    return (
      this.options.accountIdFromCapacityDetails?.(capacity.details) ??
      defaultAccountIdFromCapacityDetails(capacity.details)
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
      ...(options.limitReasons ? { limitReasons: options.limitReasons } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
}

export function defaultAccountIdFromCapacityDetails(
  details: Readonly<Record<string, string>> | undefined,
): string | null {
  const accountId =
    details?.accountId ?? details?.quotaGroup ?? details?.subscriptionAccountId;
  return accountId && accountId.trim() ? accountId : null;
}

function normalizeAccountCapacitySignal(
  input: WorkerAccountLimitSignal,
): WorkerCapacitySnapshot | null {
  const capacity = input.capacity;
  if (!isPersistableAccountCapacity(capacity)) return null;
  if (
    capacity.cooldownUntil &&
    capacity.cooldownUntil.getTime() <= input.observedAt.getTime()
  ) {
    return null;
  }
  return {
    availability: capacity.availability,
    ...(capacity.reason ? { reason: capacity.reason } : {}),
    ...(capacity.cooldownUntil
      ? { cooldownUntil: capacity.cooldownUntil }
      : {}),
    lastLimitSignalAt: input.observedAt,
    details: {
      ...(capacity.details ?? {}),
      accountId: input.accountId,
      ...(input.sourceWorkerId ? { sourceWorkerId: input.sourceWorkerId } : {}),
    },
  };
}

function shouldKeepExistingAccountCapacity(
  existing: WorkerCapacitySnapshot,
  next: WorkerCapacitySnapshot,
): boolean {
  if (severity(existing) > severity(next)) return true;
  if (severity(existing) < severity(next)) return false;
  if (!existing.cooldownUntil || !next.cooldownUntil) return true;
  return existing.cooldownUntil.getTime() >= next.cooldownUntil.getTime();
}

function isAccountLimitCapacity(
  capacity: WorkerCapacitySnapshot,
  limitReasons: readonly string[],
): boolean {
  if (!isPersistableAccountCapacity(capacity)) return false;
  if (!capacity.reason) return true;
  return limitReasons.includes(capacity.reason);
}

function isPersistableAccountCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

function mergeWorkerAndAccountCapacity(
  worker: WorkerCapacitySnapshot,
  account: WorkerCapacitySnapshot,
): WorkerCapacitySnapshot {
  if (worker.availability === "available") return account;
  if (severity(account) > severity(worker)) {
    return {
      ...account,
      details: {
        ...(worker.details ?? {}),
        ...(account.details ?? {}),
      },
    };
  }
  if (
    worker.availability === "cooldown" &&
    account.availability === "cooldown" &&
    worker.cooldownUntil &&
    account.cooldownUntil &&
    account.cooldownUntil.getTime() > worker.cooldownUntil.getTime()
  ) {
    return {
      ...account,
      details: {
        ...(worker.details ?? {}),
        ...(account.details ?? {}),
      },
    };
  }
  return worker;
}

function withAccountDetails(
  capacity: WorkerCapacitySnapshot,
  accountId: string,
): WorkerCapacitySnapshot {
  return {
    ...capacity,
    details: {
      ...(capacity.details ?? {}),
      accountId,
    },
  };
}

function severity(capacity: WorkerCapacitySnapshot): number {
  switch (capacity.availability) {
    case "disabled":
      return 70;
    case "quota_exhausted":
      return 60;
    case "cooldown":
      return 50;
    case "degraded":
      return 40;
    case "warming":
      return 30;
    case "busy":
      return 20;
    case "available":
      return 10;
  }
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
