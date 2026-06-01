import { describe, expect, it } from "vitest";
import {
  BoundedSubscriptionWorkerPool,
  type SubscriptionWorker,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
} from "../index";

describe("BoundedSubscriptionWorkerPool", () => {
  it("runs no more than the configured slot count concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "test-pool",
      slots: 2,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(20);
          active -= 1;
          return `done:${job}`;
        }),
    });

    await pool.start();
    const results = await Promise.all([
      pool.run("a"),
      pool.run("b"),
      pool.run("c"),
      pool.run("d"),
    ]);
    await pool.dispose();

    expect(results).toEqual(["done:a", "done:b", "done:c", "done:d"]);
    expect(maxActive).toBe(2);
    expect(pool.stats()).toMatchObject({
      completed: 4,
      failed: 0,
      state: "disposed",
    });
  });

  it("rejects work when the bounded queue is full", async () => {
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "bounded",
      slots: 1,
      maxQueueSize: 1,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          await delay(50);
          return job;
        }),
    });

    await pool.start();
    const first = pool.run("first");
    const queued = pool.run("queued");
    await expect(pool.run("overflow")).rejects.toThrow(
      "Worker pool queue is full.",
    );
    await expect(first).resolves.toBe("first");
    await expect(queued).resolves.toBe("queued");
    await pool.dispose();
  });

  it("removes aborted queued work before it reaches a worker", async () => {
    const seen: string[] = [];
    let releaseFirst: () => void = () => {
      throw new Error("first_job_release_missing");
    };
    let resolveFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "abort-queued",
      slots: 1,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          seen.push(job);
          if (job === "first") {
            resolveFirstStarted?.();
            await new Promise<void>((release) => {
              releaseFirst = release;
            });
          }
          return job;
        }),
    });

    await pool.start();
    const first = pool.run("first");
    await firstStarted;
    const controller = new AbortController();
    const aborted = pool.run("aborted", {
      abortSignal: controller.signal,
    });
    const next = pool.run("next");
    controller.abort();
    releaseFirst();
    await expect(aborted).rejects.toThrow("Worker pool run was aborted");
    await expect(first).resolves.toBe("first");
    await expect(next).resolves.toBe("next");
    await pool.dispose();
    expect(seen).toEqual(["first", "next"]);
  });

  it("rejects already-aborted work without entering the worker", async () => {
    const seen: string[] = [];
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "already-aborted",
      slots: 1,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          seen.push(job);
          return job;
        }),
    });
    const controller = new AbortController();
    controller.abort();

    await pool.start();
    await expect(
      pool.run("aborted", { abortSignal: controller.signal }),
    ).rejects.toThrow("Worker pool run was aborted");
    await pool.dispose();
    expect(seen).toEqual([]);
  });

  it("prewarms all slots and aggregates health", async () => {
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "health",
      slots: 3,
      prewarmOnStart: true,
      workerFactory: ({ workerId }) => new FakeWorker(workerId),
    });

    await pool.start();
    const health = await pool.health();
    await pool.dispose();

    expect(health).toMatchObject({
      status: "healthy",
      slots: [
        { status: "healthy" },
        { status: "healthy" },
        { status: "healthy" },
      ],
    });
  });

  it("restarts an idle slot and prewarms the replacement", async () => {
    const disposed: string[] = [];
    const workers: FakeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "restart",
      slots: 2,
      workerFactory: ({ workerId }) => {
        const worker = new FakeWorker(workerId, async (job) => job);
        worker.onDispose = () => disposed.push(workerId);
        workers.push(worker);
        return worker;
      },
    });

    await pool.start();
    await pool.restartSlot(0, { prewarm: true });
    const result = await pool.run("ok");
    await pool.dispose();

    expect(result).toBe("ok");
    expect(disposed).toContain("restart:slot-1");
    expect(workers).toHaveLength(3);
    expect(workers[2]?.workerId).toBe("restart:slot-1");
    expect(workers[2]?.prewarmed).toBe(true);
    expect(pool.stats().restarted).toBe(1);
  });

  it("does not run queued work on a replacement slot before restart completes", async () => {
    const seen: string[] = [];
    const workers: FakeWorker[] = [];
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "restart-publish",
      slots: 1,
      workerFactory: ({ workerId }) => {
        const worker = new FakeWorker(workerId, async (job) => {
          seen.push(job);
          return job;
        });
        workers.push(worker);
        if (workers.length === 2) {
          worker.onStart = () => replacementStarted.resolve();
          worker.startGate = releaseReplacement.promise;
        }
        return worker;
      },
    });

    await pool.start();
    const restart = pool.restartSlot(0);
    await replacementStarted.promise;
    const queued = pool.run("queued");

    await delay(20);
    expect(seen).toEqual([]);

    releaseReplacement.resolve();
    await restart;
    await expect(queued).resolves.toBe("queued");
    await pool.dispose();
    expect(seen).toEqual(["queued"]);
  });

  it("does not leave a disposed slot runnable after restart failure", async () => {
    const workers: FakeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "restart-failure",
      slots: 1,
      workerFactory: ({ workerId }) => {
        const worker = new FakeWorker(workerId, async (job) => job);
        workers.push(worker);
        if (workers.length === 2) {
          worker.failStart = true;
        }
        return worker;
      },
    });

    await pool.start();
    await expect(pool.restartSlot(0)).rejects.toThrow(
      "Worker pool slot failed to restart.",
    );
    expect(workers[0]?.state).toBe("disposed");
    expect(pool.stats().slots).toBe(0);
    await expect(pool.health()).resolves.toMatchObject({
      status: "degraded",
      state: "failed",
    });
    expect(() => pool.run("must-not-run")).toThrow(
      "Worker pool has not been started.",
    );
    await pool.dispose();
  });
});

class FakeWorker implements SubscriptionWorker<string, string> {
  state: SubscriptionWorkerState = "created";
  prewarmed = false;
  failStart = false;
  startGate: Promise<void> | null = null;

  constructor(
    readonly workerId: string,
    private readonly handler: (job: string) => Promise<string> = async (job) =>
      `ok:${job}`,
  ) {}

  onDispose: (() => void) | null = null;
  onStart: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.failStart) throw new Error("fake_start_failed");
    this.onStart?.();
    await this.startGate;
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.prewarmed = true;
    this.state = "ready";
    return {
      status: "ready",
      warmedAt: new Date(),
      warnings: [],
    };
  }

  async run(job: string): Promise<string> {
    return this.handler(job);
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
    this.onDispose?.();
  }
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
