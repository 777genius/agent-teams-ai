import { describe, expect, it } from "vitest";
import { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
import {
  InMemorySubscriptionTaskQueue,
  QueueProcessorStateKind,
  SubscriptionQueueProcessor,
  SubscriptionQueueEnqueueStatus,
  SubscriptionQueueError,
  SubscriptionQueueErrorCodeKind,
  SubscriptionQueueFailureStatus,
  SubscriptionTaskStatusKind,
  assertRetryPolicy,
  computeBackoffDelayMs,
  type SubscriptionQueueClaim,
  type SubscriptionTaskQueuePort,
} from "../index";
import type {
  SubscriptionWorker,
  SubscriptionWorkerRunOptions,
  SubscriptionWorkerState,
} from "@vioxen/subscription-runtime/worker-core";

describe("subscription queue core", () => {
  it("keeps queue discriminators string-compatible through exported enums", () => {
    expect(SubscriptionTaskStatusKind.Queued).toBe("queued");
    expect(SubscriptionQueueEnqueueStatus.Accepted).toBe("accepted");
    expect(SubscriptionQueueFailureStatus.RetryScheduled).toBe(
      "retry_scheduled",
    );
    expect(QueueProcessorStateKind.Stopped).toBe("stopped");
    expect(SubscriptionQueueErrorCodeKind.Duplicate).toBe(
      "subscription_queue_duplicate",
    );
  });

  it("deduplicates enqueue by idempotency key", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });

    const first = await queue.enqueue({
      job: "a",
      idempotencyKey: "idem",
    });
    const second = await queue.enqueue({
      job: "b",
      idempotencyKey: "idem",
    });

    expect(second).toEqual({
      status: "idempotent_replay",
      taskId: first.taskId,
    });
  });

  it("claims, retries with backoff, then completes", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });
    await queue.enqueue({
      taskId: "task-1",
      job: "job",
      maxAttempts: 2,
      runAfter: new Date("2026-05-31T00:00:00.000Z"),
    });
    const claim = await queue.claim({
      leaseTtlMs: 60_000,
      now: new Date("2026-05-31T00:00:00.000Z"),
    });
    expect(claim?.task.taskId).toBe("task-1");
    if (!claim) throw new Error("missing_claim");

    await expect(
      queue.fail({
        taskId: claim.task.taskId,
        leaseId: claim.leaseId,
        error: new Error("boom"),
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 10,
          jitterRatio: 0,
        },
        now: new Date("2026-05-31T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "retry_scheduled",
      nextAttempt: 2,
    });

    const retry = await queue.claim({
      leaseTtlMs: 60_000,
      now: new Date("2026-05-31T00:00:00.010Z"),
    });
    expect(retry?.task.attempt).toBe(2);
    if (!retry) throw new Error("missing_retry");
    await queue.complete({
      taskId: retry.task.taskId,
      leaseId: retry.leaseId,
      result: "ok",
    });
    await expect(queue.size({ includeDelayed: true })).resolves.toBe(0);
  });

  it("reclaims expired in-memory leases without consuming attempts", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "lease-expiry",
    });
    await queue.enqueue({
      taskId: "task-1",
      job: "job",
      maxAttempts: 2,
      runAfter: new Date("2026-05-31T00:00:00.000Z"),
    });

    const first = await queue.claim({
      leaseTtlMs: 10,
      now: new Date("2026-05-31T00:00:00.000Z"),
    });
    if (!first) throw new Error("missing_first_claim");

    await expect(
      queue.claim({
        leaseTtlMs: 10,
        now: new Date("2026-05-31T00:00:00.009Z"),
      }),
    ).resolves.toBeNull();

    const reclaimed = await queue.claim({
      leaseTtlMs: 10,
      now: new Date("2026-05-31T00:00:00.010Z"),
    });
    expect(reclaimed?.task.taskId).toBe("task-1");
    expect(reclaimed?.task.attempt).toBe(1);
    expect(reclaimed?.leaseId).not.toBe(first.leaseId);
  });

  it("processes queued work through a bounded worker pool", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });
    await queue.enqueue({ job: "a" });
    await queue.enqueue({ job: "b" });
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "pool",
      slots: 2,
      workerFactory: ({ workerId }) => new EchoWorker(workerId),
    });
    await pool.start();
    const processor = new SubscriptionQueueProcessor({
      queue,
      workerPool: pool,
      idleDelayMs: 5,
    });
    processor.start();

    await eventually(async () => {
      expect(processor.stats().completed).toBe(2);
    });
    await processor.stop();
    await pool.dispose();
  });

  it("drains in-flight work on stop without consuming attempts", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "graceful-stop",
    });
    await queue.enqueue({ taskId: "task-1", job: "job", maxAttempts: 1 });
    const worker = new BlockingWorker("blocking");
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "pool",
      slots: 1,
      workerFactory: () => worker,
    });
    await pool.start();
    const processor = new SubscriptionQueueProcessor({
      queue,
      workerPool: pool,
      idleDelayMs: 5,
    });
    processor.start();

    await worker.started.promise;
    const stopping = processor.stop();
    await delay(20);
    expect(processor.stats()).toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 0,
    });

    worker.resolve("ok:job");
    await stopping;
    await pool.dispose();

    expect(processor.stats()).toMatchObject({
      state: "stopped",
      completed: 1,
      failed: 0,
      retried: 0,
      deadLettered: 0,
    });
    await expect(queue.size({ includeDelayed: true })).resolves.toBe(0);
  });

  it("aborts in-flight work after shutdown grace and leaves retry accounting intact", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "grace-timeout",
    });
    await queue.enqueue({ taskId: "task-1", job: "job", maxAttempts: 2 });
    const worker = new BlockingWorker("blocking");
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "pool",
      slots: 1,
      workerFactory: () => worker,
    });
    await pool.start();
    const processor = new SubscriptionQueueProcessor({
      queue,
      workerPool: pool,
      idleDelayMs: 5,
      shutdownGraceMs: 5,
      retryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });
    processor.start();

    await worker.started.promise;
    await processor.stop();
    await pool.dispose();

    expect(processor.stats()).toMatchObject({
      state: "stopped",
      completed: 0,
      failed: 1,
      retried: 1,
      deadLettered: 0,
    });
    await expect(queue.size({ includeDelayed: true })).resolves.toBe(1);
  });

  it("passes idempotency and abort context through the queue processor port", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "processor-port",
    });
    await queue.enqueue({
      taskId: "task-1",
      job: "job",
      idempotencyKey: "idem-1",
    });
    const runOptions: unknown[] = [];
    const processor = new SubscriptionQueueProcessor<string, string>({
      queue,
      workerPool: {
        stats: () => ({}),
        run: async (_job, options) => {
          runOptions.push(options);
          return "ok";
        },
      },
      idleDelayMs: 5,
    });
    processor.start();

    await eventually(async () => {
      expect(processor.stats().completed).toBe(1);
    });
    await processor.stop();

    expect(runOptions).toHaveLength(1);
    expect(runOptions[0]).toMatchObject({ idempotencyKey: "idem-1" });
    expect(
      (runOptions[0] as { abortSignal?: AbortSignal }).abortSignal?.aborted,
    ).toBe(false);
  });

  it("releases claims that resolve after stop without starting new work", async () => {
    const queue = new DeferredClaimQueue();
    const runs: unknown[] = [];
    const processor = new SubscriptionQueueProcessor<string, string>({
      queue,
      workerPool: {
        stats: () => ({
          poolId: "pool",
          state: "ready",
          slots: 1,
          queued: 0,
          inFlight: 0,
          completed: 0,
          failed: 0,
          restarted: 0,
        }),
        run: async (job) => {
          runs.push(job);
          return `ok:${job}`;
        },
      },
      idleDelayMs: 5,
    });
    processor.start();

    await queue.claimStarted.promise;
    const stopping = processor.stop();
    queue.resolveClaim();
    await stopping;

    expect(runs).toEqual([]);
    expect(queue.releases).toEqual([{ taskId: "task-1", leaseId: "lease-1" }]);
    expect(processor.stats()).toMatchObject({
      state: "stopped",
      claimed: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
    });
  });

  it("computes bounded exponential backoff", () => {
    expect(
      computeBackoffDelayMs({
        attempt: 3,
        policy: {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 250,
          jitterRatio: 0,
        },
      }),
    ).toBe(250);
  });

  it("rejects invalid retry policies with a queue-domain error", () => {
    expect(() =>
      assertRetryPolicy({
        maxAttempts: 0,
        baseDelayMs: 100,
        maxDelayMs: 100,
      }),
    ).toThrowError(SubscriptionQueueError);
  });
});

class DeferredClaimQueue implements SubscriptionTaskQueuePort<string, string> {
  readonly queueId = "deferred-claim";
  readonly claimStarted = deferred<void>();
  readonly releases: unknown[] = [];
  private readonly claimResult =
    deferred<SubscriptionQueueClaim<string> | null>();

  async enqueue() {
    return { status: "accepted" as const, taskId: "task-1" };
  }

  async claim(): Promise<SubscriptionQueueClaim<string> | null> {
    this.claimStarted.resolve();
    return this.claimResult.promise;
  }

  resolveClaim(): void {
    this.claimResult.resolve({
      task: {
        taskId: "task-1",
        job: "job",
        attempt: 1,
        maxAttempts: 1,
        runAfter: new Date(),
        createdAt: new Date(),
        metadata: {},
      },
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
  }

  async release(input: { readonly taskId: string; readonly leaseId: string }) {
    this.releases.push(input);
  }

  async complete(): Promise<void> {
    throw new Error("unexpected_complete");
  }

  async fail(): Promise<never> {
    throw new Error("unexpected_fail");
  }

  async size(): Promise<number> {
    return 0;
  }
}

class EchoWorker implements SubscriptionWorker<string, string> {
  state = "created" as const;

  constructor(readonly workerId: string) {}

  async start(): Promise<void> {}

  async prewarm() {
    return { status: "ready" as const, warmedAt: new Date(), warnings: [] };
  }

  async run(job: string): Promise<string> {
    return `ok:${job}`;
  }

  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  async dispose(): Promise<void> {}
}

class BlockingWorker implements SubscriptionWorker<string, string> {
  state: SubscriptionWorkerState = "created";
  readonly started = deferred<void>();
  private finish: {
    readonly resolve: (result: string) => void;
    readonly reject: (error: unknown) => void;
  } | null = null;

  constructor(readonly workerId: string) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm() {
    return { status: "ready" as const, warmedAt: new Date(), warnings: [] };
  }

  async run(
    job: string,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<string> {
    this.started.resolve();
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error("worker_aborted"));
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      this.finish = {
        resolve: (result) => {
          options.abortSignal?.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          options.abortSignal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      void job;
    });
  }

  resolve(result: string): void {
    this.finish?.resolve(result);
  }

  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

async function eventually(
  assertion: () => Promise<void> | void,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
