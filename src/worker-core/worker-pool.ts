import type {
  CapacityAwareSubscriptionWorker,
  SubscriptionWorker,
  SubscriptionWorkerHealth,
  SubscriptionWorkerPrewarmResult,
  SubscriptionWorkerState,
  WorkerCapacitySnapshot,
  WorkerPoolHealth,
  WorkerPoolOptions,
  WorkerPoolRestartOptions,
  WorkerPoolRunOptions,
  WorkerPoolRetryPolicy,
  WorkerPoolSlotSnapshot,
  WorkerPoolStats,
  WorkerPoolTimerHandle,
} from "./types";
import {
  assessWorkerCapacityRecovery,
  nextWorkerCapacityRecoveryAt,
  normalizeWorkerCapacitySnapshot,
} from "./account-capacity/domain/worker-capacity-recovery-policy";
import { SubscriptionWorkerError } from "./errors";

type Slot<Job, Result> = {
  readonly index: number;
  readonly worker: SubscriptionWorker<Job, Result>;
  busy: boolean;
};

type QueuedRun<Job, Result> = {
  readonly job: Job;
  readonly options: WorkerPoolRunOptions;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
};

const defaultMaxQueueSize = 1024;
const defaultShutdownTimeoutMs = 30_000;

export class BoundedSubscriptionWorkerPool<Job, Result> {
  private readonly slots: Slot<Job, Result>[] = [];
  private readonly queue: QueuedRun<Job, Result>[] = [];
  private poolState: SubscriptionWorkerState = "created";
  private completedCount = 0;
  private failedCount = 0;
  private restartedCount = 0;
  private inFlightCount = 0;
  private cooldownDrainAt: number | null = null;
  private cooldownDrainTimer: WorkerPoolTimerHandle | null = null;
  private readonly idempotentRuns = new Map<string, Promise<Result>>();

  constructor(private readonly options: WorkerPoolOptions<Job, Result>) {
    if (!options.poolId.trim()) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_empty",
        "Worker pool id is required.",
      );
    }
    if (!Number.isInteger(options.slots) || options.slots <= 0) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_empty",
        "Worker pool must have at least one slot.",
      );
    }
  }

  get poolId(): string {
    return this.options.poolId;
  }

  get state(): SubscriptionWorkerState {
    return this.poolState;
  }

  async start(): Promise<void> {
    if (this.poolState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Worker pool has been disposed.",
      );
    }
    if (this.poolState !== "created" && this.poolState !== "failed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_already_started",
        "Worker pool is already started.",
      );
    }

    this.poolState = "starting";
    try {
      for (let index = 0; index < this.options.slots; index += 1) {
        const slot = this.createSlot(index);
        try {
          await this.withStartTimeout(slot.worker.start(), {
            phase: "start",
            slotIndex: String(slot.index),
            workerId: slot.worker.workerId,
          });
        } catch (error) {
          if (isStartTimeoutError(error)) {
            void slot.worker.dispose().catch(() => {
              // Best-effort cleanup after a timed-out start.
            });
          } else {
            await slot.worker.dispose().catch(() => {
              // Best-effort cleanup after a failed start.
            });
          }
          throw error;
        }
        this.slots.push(slot);
      }
      this.poolState = "started";
      if (this.options.prewarmOnStart) {
        this.poolState = "prewarming";
        await this.withStartTimeout(
          Promise.all(this.slots.map((slot) => slot.worker.prewarm())),
          { phase: "prewarm" },
        );
        this.poolState = "ready";
        this.emit("subscription_worker_pool.prewarmed");
      }
      this.emit("subscription_worker_pool.started");
    } catch (error) {
      this.poolState = "failed";
      if (isStartTimeoutError(error)) {
        void this.disposeStartedSlots().catch(() => {
          // Best-effort cleanup after a timed-out pool start.
        });
        throw error;
      }
      await this.disposeStartedSlots();
      throw new SubscriptionWorkerError(
        "subscription_worker_start_failed",
        "Worker pool failed to start.",
        { cause: error },
      );
    }
  }

  async prewarm(): Promise<readonly SubscriptionWorkerPrewarmResult[]> {
    this.assertRunnable();
    this.poolState = "prewarming";
    try {
      const results = await Promise.all(
        this.slots.map((slot) => slot.worker.prewarm()),
      );
      this.poolState = "ready";
      this.emit("subscription_worker_pool.prewarmed");
      return results;
    } catch (error) {
      this.poolState = "failed";
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Worker pool failed to prewarm.",
        { cause: error },
      );
    }
  }

  run(job: Job, options: WorkerPoolRunOptions = {}): Promise<Result> {
    this.assertRunnable();
    if (options.abortSignal?.aborted) {
      return Promise.reject(runAbortedError());
    }
    if (this.poolState === "draining") {
      return Promise.reject(
        new SubscriptionWorkerError(
          "subscription_worker_pool_draining",
          "Worker pool is draining and does not accept new work.",
        ),
      );
    }

    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.idempotentRuns.get(idempotencyKey);
      if (existing) {
        return waitForIdempotentRun(existing, options.abortSignal);
      }
    }

    const run = this.startRun(job, options);
    if (!idempotencyKey) return run;

    this.idempotentRuns.set(idempotencyKey, run);
    const cleanup = () => {
      if (this.idempotentRuns.get(idempotencyKey) === run) {
        this.idempotentRuns.delete(idempotencyKey);
      }
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private startRun(job: Job, options: WorkerPoolRunOptions): Promise<Result> {
    const selected = this.selectAvailableSlot(job, this.now());
    const available = selected.slot;
    if (available) {
      return this.runOnSlotWithRetry(available, job, options, 1);
    }
    this.scheduleCooldownDrain(selected.snapshots);
    const unavailableError = capacityUnavailableError(selected.snapshots);
    if (unavailableError) return Promise.reject(unavailableError);

    if (
      this.queue.length >= (this.options.maxQueueSize ?? defaultMaxQueueSize)
    ) {
      return Promise.reject(
        new SubscriptionWorkerError(
          "subscription_worker_pool_queue_full",
          "Worker pool queue is full.",
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (result: Result) => {
        if (settled) return;
        settled = true;
        options.abortSignal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        options.abortSignal?.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) this.queue.splice(index, 1);
        rejectOnce(runAbortedError());
      };
      const queued: QueuedRun<Job, Result> = {
        job,
        options,
        resolve: resolveOnce,
        reject: rejectOnce,
      };
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      this.queue.push(queued);
      this.drainQueue();
    });
  }

  async restartSlot(
    slotIndex: number,
    options: WorkerPoolRestartOptions = {},
  ): Promise<void> {
    this.assertRunnable();
    const slot = this.slots[slotIndex];
    if (!slot) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_slot_not_found",
        "Worker pool slot was not found.",
        { details: { slotIndex: String(slotIndex) } },
      );
    }
    if (slot.busy) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_slot_busy",
        "Worker pool slot is busy and cannot be restarted.",
        { details: { slotIndex: String(slotIndex) } },
      );
    }

    this.emit("subscription_worker_pool.slot_restart.started", {
      slotIndex: String(slotIndex),
      workerId: slot.worker.workerId,
    });
    slot.busy = true;
    const next = this.createSlot(slotIndex);
    try {
      await slot.worker.dispose();
      await next.worker.start();
      if (options.prewarm) {
        await next.worker.prewarm();
      }
      this.slots[slotIndex] = next;
    } catch (error) {
      this.slots.splice(slotIndex, 1);
      this.poolState = "failed";
      const restartError = new SubscriptionWorkerError(
        "subscription_worker_pool_slot_restart_failed",
        "Worker pool slot failed to restart.",
        {
          cause: error,
          details: {
            slotIndex: String(slotIndex),
            workerId: next.worker.workerId,
          },
        },
      );
      await next.worker.dispose().catch(() => {
        // Best-effort cleanup after a failed replacement.
      });
      if (this.slots.length === 0) {
        this.rejectQueued(restartError);
      } else {
        this.drainQueue();
      }
      throw restartError;
    }
    this.restartedCount += 1;
    this.emit("subscription_worker_pool.slot_restart.completed", {
      slotIndex: String(slotIndex),
      workerId: next.worker.workerId,
    });
    this.drainQueue();
  }

  async health(): Promise<WorkerPoolHealth> {
    const checkedAt = this.now();
    this.slotSnapshots(checkedAt);
    const slotHealth = await Promise.all(
      this.slots.map((slot) => safeHealth(slot.worker, checkedAt)),
    );
    const unhealthy = slotHealth.filter(
      (health) => health.status === "unhealthy",
    );
    const degraded = slotHealth.filter(
      (health) => health.status === "degraded",
    );
    const status =
      unhealthy.length > 0
        ? "unhealthy"
        : degraded.length > 0 || this.poolState === "failed"
          ? "degraded"
          : "healthy";
    return {
      poolId: this.options.poolId,
      status,
      state: this.poolState,
      checkedAt,
      slots: slotHealth,
      queued: this.queue.length,
      inFlight: this.inFlightCount,
    };
  }

  stats(): WorkerPoolStats {
    return {
      poolId: this.options.poolId,
      state: this.poolState,
      slots: this.slots.length,
      queued: this.queue.length,
      inFlight: this.inFlightCount,
      completed: this.completedCount,
      failed: this.failedCount,
      restarted: this.restartedCount,
    };
  }

  async dispose(): Promise<void> {
    if (this.poolState === "disposed") return;
    this.poolState = "draining";
    this.clearCooldownDrainTimer();
    const deadline =
      Date.now() + (this.options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs);
    while (this.inFlightCount > 0 && Date.now() < deadline) {
      await delay(25);
    }
    if (this.inFlightCount > 0) {
      this.rejectQueued(
        new SubscriptionWorkerError(
          "subscription_worker_shutdown_timeout",
          "Worker pool shutdown timed out with in-flight work.",
        ),
      );
    } else {
      this.rejectQueued(
        new SubscriptionWorkerError(
          "subscription_worker_pool_draining",
          "Worker pool was disposed before queued work started.",
        ),
      );
    }
    await this.disposeStartedSlots();
    this.poolState = "disposed";
    this.emit("subscription_worker_pool.disposed");
  }

  private runOnSlot(
    slot: Slot<Job, Result>,
    job: Job,
    options: WorkerPoolRunOptions,
  ): Promise<Result> {
    if (options.abortSignal?.aborted) {
      return Promise.reject(runAbortedError());
    }
    slot.busy = true;
    this.inFlightCount += 1;
    return slot.worker
      .run(job, options.abortSignal ? { abortSignal: options.abortSignal } : {})
      .then((result) => {
        this.completedCount += 1;
        return result;
      })
      .catch((error) => {
        this.failedCount += 1;
        throw new SubscriptionWorkerError(
          "subscription_worker_pool_slot_failed",
          "Worker pool slot failed to run a task.",
          {
            cause: error,
            details: {
              workerId: slot.worker.workerId,
              slotIndex: String(slot.index),
            },
          },
        );
      })
      .finally(() => {
        slot.busy = false;
        this.inFlightCount -= 1;
        this.drainQueue();
      });
  }

  private createSlot(index: number): Slot<Job, Result> {
    const workerId = `${this.options.poolId}:slot-${index + 1}`;
    return {
      index,
      worker: this.options.workerFactory({
        slotIndex: index,
        workerId,
      }),
      busy: false,
    };
  }

  private drainQueue(): void {
    if (this.poolState === "draining" || this.poolState === "disposed") return;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) return;
      const selected = this.selectAvailableSlot(next.job, this.now());
      if (!selected.slot) {
        this.scheduleCooldownDrain(selected.snapshots);
        const unavailableError = capacityUnavailableError(selected.snapshots);
        if (unavailableError) {
          this.rejectQueued(unavailableError);
        }
        return;
      }
      if (this.queue[0] !== next) {
        continue;
      }
      this.queue.shift();
      if (next.options.abortSignal?.aborted) {
        next.reject(runAbortedError());
        continue;
      }
      void this.runOnSlotWithRetry(selected.slot, next.job, next.options, 1)
        .then(next.resolve)
        .catch(next.reject);
    }
  }

  private async runOnSlotWithRetry(
    slot: Slot<Job, Result>,
    job: Job,
    options: WorkerPoolRunOptions,
    attempt: number,
  ): Promise<Result> {
    try {
      return await this.runOnSlot(slot, job, options);
    } catch (error) {
      if (!this.shouldRetryOnAnotherSlot(slot, options, attempt)) {
        throw error;
      }
      const selected = this.selectAvailableSlot(job, this.now());
      if (!selected.slot) {
        this.scheduleCooldownDrain(selected.snapshots);
        throw error;
      }
      this.emit("subscription_worker_pool.slot_retry", {
        fromSlotIndex: String(slot.index),
        fromWorkerId: slot.worker.workerId,
        toSlotIndex: String(selected.slot.index),
        toWorkerId: selected.slot.worker.workerId,
        attempt: String(attempt + 1),
      });
      return this.runOnSlotWithRetry(selected.slot, job, options, attempt + 1);
    }
  }

  private shouldRetryOnAnotherSlot(
    failedSlot: Slot<Job, Result>,
    options: WorkerPoolRunOptions,
    attempt: number,
  ): boolean {
    const policy = retryPolicy(options, this.options.retryPolicy);
    if (!policy.retryOnSlotCapacityUnavailable) return false;
    if (attempt >= policy.maxAttempts) return false;
    if (options.abortSignal?.aborted) return false;
    return (
      this.slotCapacity(failedSlot, this.now()).availability !== "available"
    );
  }

  private selectAvailableSlot(
    job: Job,
    now: Date,
  ): {
    readonly slot: Slot<Job, Result> | null;
    readonly snapshots: readonly WorkerPoolSlotSnapshot[];
  } {
    const snapshots = this.slotSnapshots(now);
    const available = snapshots.filter(
      (snapshot) =>
        !snapshot.busy && snapshot.capacity.availability === "available",
    );
    if (available.length === 0) {
      return { slot: null, snapshots };
    }

    const selected =
      this.options.slotSelector?.({ slots: snapshots, job, now }) ??
      available[0] ??
      null;
    if (!selected) {
      return { slot: null, snapshots };
    }

    const snapshot = snapshots.find(
      (candidate) => candidate.slotIndex === selected.slotIndex,
    );
    if (
      !snapshot ||
      snapshot.busy ||
      snapshot.capacity.availability !== "available"
    ) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_selector_invalid",
        "Worker pool slot selector returned an unavailable slot.",
        {
          details: {
            slotIndex: String(selected.slotIndex),
            ...(snapshot ? { workerId: snapshot.workerId } : {}),
          },
        },
      );
    }

    return {
      slot: this.slots[snapshot.slotIndex] ?? null,
      snapshots,
    };
  }

  private slotSnapshots(now: Date): readonly WorkerPoolSlotSnapshot[] {
    return this.slots.map((slot) => ({
      slotIndex: slot.index,
      workerId: slot.worker.workerId,
      busy: slot.busy,
      capacity: this.slotCapacity(slot, now),
    }));
  }

  private slotCapacity(
    slot: Slot<Job, Result>,
    now: Date,
  ): WorkerCapacitySnapshot {
    if (slot.busy) return { availability: "busy" };
    const worker = capacityAwareWorker(slot.worker);
    if (!worker) return { availability: "available" };
    return normalizeWorkerCapacitySnapshot(worker.capacity(), now);
  }

  private scheduleCooldownDrain(
    snapshots: readonly WorkerPoolSlotSnapshot[],
  ): void {
    const nextCooldownAt = nextWorkerCapacityRecoveryAt(snapshots);
    if (nextCooldownAt === null) return;
    if (
      this.cooldownDrainAt !== null &&
      this.cooldownDrainAt <= nextCooldownAt
    ) {
      return;
    }

    this.clearCooldownDrainTimer();
    this.cooldownDrainAt = nextCooldownAt;
    this.cooldownDrainTimer = this.setTimer(() => {
      this.cooldownDrainAt = null;
      this.cooldownDrainTimer = null;
      this.drainQueue();
    }, Math.max(0, nextCooldownAt - this.now().getTime()));
  }

  private clearCooldownDrainTimer(): void {
    if (this.cooldownDrainTimer) {
      this.clearTimer(this.cooldownDrainTimer);
      this.cooldownDrainTimer = null;
    }
    this.cooldownDrainAt = null;
  }

  private assertRunnable(): void {
    if (this.poolState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Worker pool has been disposed.",
      );
    }
    if (this.slots.length === 0) {
      throw new SubscriptionWorkerError(
        "subscription_worker_not_started",
        "Worker pool has not been started.",
      );
    }
  }

  private rejectQueued(error: unknown): void {
    const queued = this.queue.splice(0);
    for (const item of queued) item.reject(error);
  }

  private async disposeStartedSlots(): Promise<void> {
    const slots = this.slots.splice(0);
    const results = await Promise.allSettled(
      slots.map((slot) => slot.worker.dispose()),
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected.length > 0) {
      throw new AggregateError(
        rejected.map((result) => result.reason),
        "subscription_worker_pool_dispose_failed",
      );
    }
  }

  private emit(
    name: string,
    metadata: Readonly<Record<string, string>> = {},
  ): void {
    this.options.observability?.emit({
      name,
      metadata: {
        poolId: this.options.poolId,
        slots: String(this.options.slots),
        ...metadata,
      },
    });
  }

  private now(): Date {
    return this.options.clock?.now() ?? new Date();
  }

  private setTimer(callback: () => void, delayMs: number): WorkerPoolTimerHandle {
    return (
      this.options.scheduler?.setTimeout(callback, delayMs) ??
      setTimeout(callback, delayMs)
    );
  }

  private clearTimer(handle: WorkerPoolTimerHandle): void {
    if (this.options.scheduler) {
      this.options.scheduler.clearTimeout(handle);
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private withStartTimeout<T>(
    operation: Promise<T>,
    details: Readonly<Record<string, string>>,
  ): Promise<T> {
    const timeoutMs = this.options.startTimeoutMs;
    if (
      timeoutMs === undefined ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0
    ) {
      return operation;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: WorkerPoolTimerHandle | null = null;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clearTimer(timer);
        callback();
      };
      timer = this.setTimer(() => {
        settle(() =>
          reject(
            new SubscriptionWorkerError(
              "subscription_worker_start_timeout",
              `Worker pool start timed out after ${timeoutMs} ms.`,
              {
                details: {
                  ...details,
                  timeoutMs: String(timeoutMs),
                },
              },
            ),
          ),
        );
      }, timeoutMs);
      operation.then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error)),
      );
    });
  }
}

async function safeHealth<Job, Result>(
  worker: SubscriptionWorker<Job, Result>,
  checkedAt: Date,
): Promise<SubscriptionWorkerHealth> {
  try {
    return await worker.health();
  } catch (error) {
    return {
      status: "unhealthy",
      state: "failed",
      checkedAt,
      failures: [
        {
          code: "subscription_worker_health_failed",
          safeMessage:
            error instanceof Error ? error.message : "Worker health failed.",
        },
      ],
      warnings: [],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAbortedError(): SubscriptionWorkerError {
  return new SubscriptionWorkerError(
    "subscription_worker_pool_run_aborted",
    "Worker pool run was aborted before it started.",
  );
}

function isStartTimeoutError(error: unknown): error is SubscriptionWorkerError {
  return (
    error instanceof SubscriptionWorkerError &&
    error.code === "subscription_worker_start_timeout"
  );
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function waitForIdempotentRun<Result>(
  run: Promise<Result>,
  abortSignal: AbortSignal | undefined,
): Promise<Result> {
  if (!abortSignal) return run;
  if (abortSignal.aborted) return Promise.reject(runAbortedError());

  return new Promise((resolve, reject) => {
    const cleanup = () => abortSignal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(runAbortedError());
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    run.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function retryPolicy(
  options: WorkerPoolRunOptions,
  poolPolicy: WorkerPoolRetryPolicy | undefined,
): Required<WorkerPoolRetryPolicy> {
  const maxAttempts =
    options.retryPolicy?.maxAttempts ?? poolPolicy?.maxAttempts ?? 1;
  return {
    maxAttempts: Math.max(1, maxAttempts),
    retryOnSlotCapacityUnavailable:
      options.retryPolicy?.retryOnSlotCapacityUnavailable ??
      poolPolicy?.retryOnSlotCapacityUnavailable ??
      false,
  };
}

function capacityAwareWorker<Job, Result>(
  worker: SubscriptionWorker<Job, Result>,
): CapacityAwareSubscriptionWorker<Job, Result> | null {
  if ("capacity" in worker && typeof worker.capacity === "function") {
    return worker as CapacityAwareSubscriptionWorker<Job, Result>;
  }
  return null;
}

function capacityUnavailableError(
  snapshots: readonly WorkerPoolSlotSnapshot[],
): SubscriptionWorkerError | null {
  const recovery = assessWorkerCapacityRecovery(snapshots);
  if (recovery.kind !== "unavailable") return null;

  return new SubscriptionWorkerError(
    "subscription_worker_pool_capacity_unavailable",
    "Worker pool has no available or resettable-capacity slots.",
    {
      details: recovery.details,
    },
  );
}
