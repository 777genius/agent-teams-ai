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
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacitySignalScope,
  type WorkerAccountCapacityRechecker,
  type WorkerAccountCapacityState,
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
  readonly accountWideLimitReasons?: readonly string[];
  readonly capacityRechecker?: WorkerAccountCapacityRechecker;
  readonly requireCapacityRecheckWhenDue?: boolean;
  readonly recheckClaimTtlMs?: number;
  readonly recheckFailureCooldownMs?: number;
  readonly clock?: { now(): Date };
};

export type AccountCapacityAwareWorkerFactoryOptions<Job, Result> = Omit<
  AccountCapacityAwareWorkerOptions<Job, Result>,
  "worker" | "capacityRechecker"
> & {
  readonly workerFactory: SubscriptionWorkerFactory<Job, Result>;
  readonly capacityRecheckerFactory?: (
    input: Parameters<SubscriptionWorkerFactory<Job, Result>>[0],
  ) => WorkerAccountCapacityRechecker | undefined;
};

export class AccountCapacityAwareWorker<Job, Result>
  implements CapacityAwareSubscriptionWorker<Job, Result>
{
  private readonly clock: { now(): Date };
  private readonly limitReasons: readonly string[];
  private readonly accountWideLimitReasons: readonly string[];

  constructor(
    private readonly options: AccountCapacityAwareWorkerOptions<Job, Result>,
  ) {
    this.clock = options.clock ?? systemClock;
    this.limitReasons = options.limitReasons ?? defaultWorkerAccountLimitReasons;
    this.accountWideLimitReasons = options.accountWideLimitReasons ?? [];
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

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    await this.recheckDueCapacity();
    this.assertCapacityAvailable();
    return this.options.worker.prewarm();
  }

  async run(
    job: Job,
    options?: SubscriptionWorkerRunOptions,
  ): Promise<Result> {
    await this.recheckDueCapacity();
    this.assertCapacityAvailable();
    try {
      const result = await this.options.worker.run(job, options);
      this.observeWorkerCapacity(this.workerCapacity());
      return result;
    } catch (error) {
      const capacity = this.workerCapacity();
      const state = this.observeWorkerCapacity(capacity);
      if (state && isWorkerAccountLimitCapacity(capacity, this.limitReasons)) {
        await this.recheckState(
          state,
          WorkerAccountCapacityRecheckMode.Refresh,
        );
      }
      throw error;
    }
  }

  private assertCapacityAvailable(): void {
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

  private observeWorkerCapacity(
    capacity: WorkerCapacitySnapshot,
  ): WorkerAccountCapacityState | null {
    if (!isWorkerAccountLimitCapacity(capacity, this.limitReasons)) return null;
    const accountId = this.accountId(capacity);
    if (!accountId) return null;
    const demand = this.runtimeDemand(capacity);
    const accountWide = Boolean(
      capacity.reason && this.accountWideLimitReasons.includes(capacity.reason),
    );
    return this.options.accountCapacityStore.observe({
      accountId,
      ...(accountWide
        ? { scope: WorkerAccountCapacitySignalScope.AccountWide }
        : {}),
      ...(!accountWide && demand ? { demand } : {}),
      capacity,
      observedAt: capacity.lastLimitSignalAt ?? this.clock.now(),
      sourceWorkerId: this.workerId,
    });
  }

  private async recheckDueCapacity(): Promise<void> {
    const now = this.clock.now();
    const workerCapacity = normalizeWorkerCapacitySnapshot(
      this.workerCapacity(),
      now,
    );
    const accountId = this.accountId(workerCapacity);
    if (!accountId) return;
    const demand = this.runtimeDemand(workerCapacity);
    const state = this.options.accountCapacityStore.readState({
      accountId,
      ...(demand ? { demand } : {}),
      now,
    });
    if (state?.phase !== WorkerAccountCapacityPhase.RecheckDue) return;
    if (!this.options.capacityRechecker) {
      if (!this.options.requireCapacityRecheckWhenDue) return;
      throw new SubscriptionWorkerError(
        "subscription_worker_account_unavailable",
        "Worker account quota requires a provider recheck before use.",
        {
          details: {
            workerId: this.workerId,
            accountId,
            availability: "cooldown",
            reason: "quota_recheck_unavailable",
          },
        },
      );
    }
    await this.recheckState(state, WorkerAccountCapacityRecheckMode.DueOnly);
    const after = this.options.accountCapacityStore.readState({
      accountId,
      ...(demand ? { demand } : {}),
      now: this.clock.now(),
    });
    if (after?.phase === WorkerAccountCapacityPhase.RecheckDue) {
      throw new SubscriptionWorkerError(
        "subscription_worker_account_unavailable",
        "Worker account quota recheck did not resolve capacity.",
        {
          details: {
            workerId: this.workerId,
            accountId,
            availability: "cooldown",
            reason: "quota_recheck_unresolved",
          },
        },
      );
    }
  }

  private async recheckState(
    state: WorkerAccountCapacityState,
    mode: WorkerAccountCapacityRecheckMode,
  ): Promise<void> {
    const rechecker = this.options.capacityRechecker;
    if (!rechecker) return;
    const now = this.clock.now();
    const claim = this.options.accountCapacityStore.tryClaimRecheck({
      state,
      ownerId: this.workerId,
      now,
      ttlMs: this.options.recheckClaimTtlMs ?? 90_000,
      mode,
    });
    if (claim.status !== WorkerAccountCapacityClaimStatus.Claimed) return;
    try {
      const observed = await rechecker.recheck({
        accountId: claim.claim.accountId,
        demand: claim.claim.demand,
        previous: claim.claim.previous,
        now,
      });
      const resolution = observed.availability === "available"
        ? { type: WorkerAccountCapacityResolutionType.Available } as const
        : observed.availability === "quota_exhausted" ||
            observed.availability === "cooldown"
          ? {
              type: WorkerAccountCapacityResolutionType.Limited,
              capacity: observed,
            } as const
          : {
              type: WorkerAccountCapacityResolutionType.Retry,
              retryAt: new Date(
                now.getTime() +
                  (this.options.recheckFailureCooldownMs ?? 60_000),
              ),
              reason: "quota_recheck_inconclusive",
            } as const;
      this.options.accountCapacityStore.resolveRecheck({
        claim: claim.claim,
        observedAt: this.clock.now(),
        resolution,
      });
    } catch {
      this.options.accountCapacityStore.resolveRecheck({
        claim: claim.claim,
        observedAt: this.clock.now(),
        resolution: {
          type: WorkerAccountCapacityResolutionType.Retry,
          retryAt: new Date(
            this.clock.now().getTime() +
              (this.options.recheckFailureCooldownMs ?? 60_000),
          ),
          reason: "quota_recheck_failed",
        },
      });
    }
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
  return (input) => {
    const capacityRechecker = options.capacityRecheckerFactory?.(input);
    return new AccountCapacityAwareWorker({
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
      ...(options.accountWideLimitReasons
        ? { accountWideLimitReasons: options.accountWideLimitReasons }
        : {}),
      ...(capacityRechecker ? { capacityRechecker } : {}),
      ...(options.requireCapacityRecheckWhenDue
        ? { requireCapacityRecheckWhenDue: true }
        : {}),
      ...(options.recheckClaimTtlMs
        ? { recheckClaimTtlMs: options.recheckClaimTtlMs }
        : {}),
      ...(options.recheckFailureCooldownMs
        ? { recheckFailureCooldownMs: options.recheckFailureCooldownMs }
        : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  };
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
