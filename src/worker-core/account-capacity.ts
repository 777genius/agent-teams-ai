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
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null;
  observe(input: WorkerAccountLimitSignal): void;
  clear(input: { readonly accountId: string }): void;
};

export type WorkerRuntimeDemand = {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string;
};

export type WorkerAccountLimitSignal = {
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
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
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return null;
    const demand = normalizeWorkerRuntimeDemand(input.demand);
    const now = input.now ?? new Date();
    const current = this.readByKey(accountCapacityKey(accountId, demand), now);
    if (current) return current;
    if (demand) {
      return this.readByKey(accountCapacityKey(accountId, null), now);
    }
    return this.readAggregate(accountId, now);
  }

  private readByKey(key: string, now: Date): WorkerCapacitySnapshot | null {
    const current = this.records.get(key);
    if (!current) return null;
    if (
      current.cooldownUntil &&
      current.cooldownUntil.getTime() <= now.getTime()
    ) {
      this.records.delete(key);
      return null;
    }
    return current;
  }

  private readAggregate(
    accountId: string,
    now: Date,
  ): WorkerCapacitySnapshot | null {
    const prefix = `${accountId}\u0000`;
    let selected: WorkerCapacitySnapshot | null = null;
    for (const key of this.records.keys()) {
      if (key !== accountId && !key.startsWith(prefix)) continue;
      const capacity = this.readByKey(key, now);
      if (!capacity) continue;
      if (
        !selected ||
        !shouldKeepExistingWorkerAccountCapacity(selected, capacity)
      ) {
        selected = capacity;
      }
    }
    return selected;
  }

  observe(input: WorkerAccountLimitSignal): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    const capacity = normalizeWorkerAccountCapacitySignal(input);
    if (!capacity) return;
    const demand = normalizeWorkerRuntimeDemand(input.demand) ??
      defaultRuntimeDemandFromCapacityDetails(input.capacity.details);

    const existing = this.read({
      accountId,
      ...(demand ? { demand } : {}),
      now: input.observedAt,
    });
    if (
      existing &&
      shouldKeepExistingWorkerAccountCapacity(existing, capacity)
    ) {
      return;
    }
    this.records.set(accountCapacityKey(accountId, demand), capacity);
  }

  clear(input: { readonly accountId: string }): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    const prefix = `${accountId}\u0000`;
    for (const key of this.records.keys()) {
      if (key === accountId || key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
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
    const now = this.clock.now();
    const workerCapacity = normalizeWorkerCapacity(
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
    if (!isAccountLimitCapacity(capacity, this.limitReasons)) return;
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

  private runtimeDemand(capacity: WorkerCapacitySnapshot): WorkerRuntimeDemand | null {
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

export function defaultAccountIdFromCapacityDetails(
  details: Readonly<Record<string, string>> | undefined,
): string | null {
  return normalizeWorkerAccountId(
    details?.accountId ?? details?.quotaGroup ?? details?.subscriptionAccountId,
  );
}

export function normalizeWorkerAccountId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeWorkerRuntimeDemand(
  value: WorkerRuntimeDemand | null | undefined,
): WorkerRuntimeDemand | null {
  const provider = value?.provider.trim();
  if (!provider) return null;
  const model = optionalTrimmed(value?.model);
  const reasoningEffort = optionalTrimmed(value?.reasoningEffort);
  const serviceTier = optionalTrimmed(value?.serviceTier);
  return {
    provider,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function defaultRuntimeDemandFromCapacityDetails(
  details: Readonly<Record<string, string>> | undefined,
): WorkerRuntimeDemand | null {
  const provider = details?.capacityProvider ?? details?.provider ?? "";
  const model = details?.capacityModel ?? details?.model;
  const reasoningEffort =
    details?.capacityReasoningEffort ?? details?.reasoningEffort;
  const serviceTier = details?.capacityServiceTier ?? details?.serviceTier;
  return normalizeWorkerRuntimeDemand({
    provider,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  });
}

export function workerRuntimeDemandKey(
  value: WorkerRuntimeDemand | null | undefined,
): string | null {
  const demand = normalizeWorkerRuntimeDemand(value);
  if (!demand) return null;
  return [
    `provider=${demand.provider}`,
    `model=${demand.model ?? ""}`,
    `reasoningEffort=${demand.reasoningEffort ?? ""}`,
    `serviceTier=${demand.serviceTier ?? ""}`,
  ].join("\u001f");
}

export function normalizeWorkerAccountCapacitySignal(
  input: WorkerAccountLimitSignal,
): WorkerCapacitySnapshot | null {
  const accountId = normalizeWorkerAccountId(input.accountId);
  if (!accountId) return null;
  const capacity = input.capacity;
  if (!isPersistableWorkerAccountCapacity(capacity)) return null;
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
      accountId,
      ...runtimeDemandDetails(
        normalizeWorkerRuntimeDemand(input.demand) ??
          defaultRuntimeDemandFromCapacityDetails(capacity.details),
      ),
      ...(input.sourceWorkerId ? { sourceWorkerId: input.sourceWorkerId } : {}),
    },
  };
}

export function shouldKeepExistingWorkerAccountCapacity(
  existing: WorkerCapacitySnapshot,
  next: WorkerCapacitySnapshot,
): boolean {
  if (severity(existing) > severity(next)) return true;
  if (severity(existing) < severity(next)) return false;
  const existingResetAt = existing.cooldownUntil?.getTime();
  const nextResetAt = next.cooldownUntil?.getTime();
  if (nextResetAt === undefined) return true;
  if (existingResetAt === undefined) return false;
  return existingResetAt >= nextResetAt;
}

function isAccountLimitCapacity(
  capacity: WorkerCapacitySnapshot,
  limitReasons: readonly string[],
): boolean {
  if (!isPersistableWorkerAccountCapacity(capacity)) return false;
  if (!capacity.reason) return true;
  return limitReasons.includes(capacity.reason);
}

export function isPersistableWorkerAccountCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return isPersistableWorkerAccountAvailability(capacity.availability);
}

export function isPersistableWorkerAccountAvailability(
  value: unknown,
): value is WorkerCapacitySnapshot["availability"] {
  return (
    value === "cooldown" ||
    value === "quota_exhausted"
  );
}

function mergeWorkerAndAccountCapacity(
  worker: WorkerCapacitySnapshot,
  account: WorkerCapacitySnapshot,
): WorkerCapacitySnapshot {
  if (worker.availability === "available") {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
      },
    };
  }
  if (severity(account) > severity(worker)) {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
      },
    };
  }
  if (
    severity(account) === severity(worker) &&
    worker.cooldownUntil &&
    account.cooldownUntil &&
    account.cooldownUntil.getTime() > worker.cooldownUntil.getTime()
  ) {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
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

function normalizeWorkerCapacity(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableCapacity(capacity) ||
    !capacity.cooldownUntil ||
    capacity.cooldownUntil.getTime() > now.getTime()
  ) {
    return capacity;
  }

  const {
    cooldownUntil: _cooldownUntil,
    lastLimitSignalAt: _lastLimitSignalAt,
    reason: _reason,
    ...rest
  } = capacity;
  return {
    ...rest,
    availability: "available",
  };
}

function isResettableCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
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

function accountCapacityKey(
  accountId: string,
  demand: WorkerRuntimeDemand | null,
): string {
  const demandKey = workerRuntimeDemandKey(demand);
  return demandKey ? `${accountId}\u0000${demandKey}` : accountId;
}

function runtimeDemandDetails(
  demand: WorkerRuntimeDemand | null,
): Readonly<Record<string, string>> {
  if (!demand) return {};
  return {
    capacityProvider: demand.provider,
    ...(demand.model ? { capacityModel: demand.model } : {}),
    ...(demand.reasoningEffort
      ? { capacityReasoningEffort: demand.reasoningEffort }
      : {}),
    ...(demand.serviceTier ? { capacityServiceTier: demand.serviceTier } : {}),
  };
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
