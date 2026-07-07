import { describe, expect, it } from "vitest";
import {
  createBullSubscriptionProcessor,
  BullSubscriptionTaskQueue,
} from "../index";
import {
  buildBullSubscriptionQueueAddRequest,
  defaultBullSubscriptionTaskJobName,
} from "../subscription-task-queue";
import { resolveBullSubscriptionProcessorTask } from "../processor-adapter";
import {
  decodeBullSubscriptionRuntimeJob,
  encodeBullSubscriptionRuntimeJob,
  isBullSubscriptionRuntimeEnvelope,
} from "../bull-runtime-envelope";

describe("Bull subscription queue adapter", () => {
  it("keeps envelope compatibility behind the runtime-envelope slice", () => {
    const encoded = encodeBullSubscriptionRuntimeJob({
      job: { value: "work" },
      idempotencyKey: "idem-1",
    });

    expect(isBullSubscriptionRuntimeEnvelope(encoded)).toBe(true);
    expect(decodeBullSubscriptionRuntimeJob(encoded)).toEqual({
      job: { value: "work" },
      idempotencyKey: "idem-1",
      isEnvelope: true,
    });
    expect(decodeBullSubscriptionRuntimeJob("legacy-job")).toEqual({
      job: "legacy-job",
      isEnvelope: false,
    });
  });

  it("builds Bull add requests at the subscription task queue boundary", () => {
    const request = buildBullSubscriptionQueueAddRequest({
      input: {
        job: "work",
        taskId: "task-1",
        idempotencyKey: "idem-1",
        runAfter: new Date("2026-01-01T00:00:01.000Z"),
      },
      retryPolicy: {
        maxAttempts: 4,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(request).toEqual({
      name: defaultBullSubscriptionTaskJobName,
      data: {
        __subscriptionRuntime: {
          version: 1,
          job: "work",
          idempotencyKey: "idem-1",
        },
      },
      options: {
        jobId: "task-1",
        attempts: 4,
        delay: 1000,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  });

  it("rejects invalid enqueue input before handing work to Bull", async () => {
    const queue = new BullSubscriptionTaskQueue<string>({
      queue: {
        async add() {
          throw new Error("add should not be called");
        },
      },
    });

    await expect(
      queue.enqueue({ job: "work", taskId: "   " }),
    ).rejects.toMatchObject({
      code: "subscription_queue_invalid_input",
    });
  });

  it("maps enqueue to a host-provided Bull-compatible queue", async () => {
    const calls: unknown[] = [];
    const queue = new BullSubscriptionTaskQueue<string>({
      queue: {
        async add(name, data, options) {
          calls.push({ name, data, options });
          return { id: "job-1" };
        },
      },
      retryPolicy: {
        maxAttempts: 5,
        baseDelayMs: 250,
        maxDelayMs: 10_000,
      },
    });

    await expect(
      queue.enqueue({ job: "work", taskId: "task-1" }),
    ).resolves.toEqual({
      status: "accepted",
      taskId: "job-1",
    });
    expect(calls).toEqual([
      {
        name: "subscription-runtime-task",
        data: "work",
        options: expect.objectContaining({
          jobId: "task-1",
          attempts: 5,
          backoff: { type: "exponential", delay: 250 },
        }),
      },
    ]);
  });

  it("uses idempotency key as Bull job id when task id is absent", async () => {
    const calls: unknown[] = [];
    const queue = new BullSubscriptionTaskQueue<string>({
      queue: {
        async add(name, data, options) {
          calls.push({ name, data, options });
          return { id: options?.jobId ?? "missing-job-id" };
        },
      },
    });

    await expect(
      queue.enqueue({ job: "work", idempotencyKey: "idem-1" }),
    ).resolves.toEqual({
      status: "accepted",
      taskId: "idem-1",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        data: {
          __subscriptionRuntime: {
            version: 1,
            job: "work",
            idempotencyKey: "idem-1",
          },
        },
        options: expect.objectContaining({ jobId: "idem-1" }),
      }),
    ]);
  });

  it("keeps explicit task id ahead of idempotency key for Bull job id", async () => {
    const calls: unknown[] = [];
    const queue = new BullSubscriptionTaskQueue<string>({
      queue: {
        async add(name, data, options) {
          calls.push({ name, data, options });
          return { id: options?.jobId ?? "missing-job-id" };
        },
      },
    });

    await expect(
      queue.enqueue({
        job: "work",
        taskId: "task-1",
        idempotencyKey: "idem-1",
      }),
    ).resolves.toEqual({
      status: "accepted",
      taskId: "task-1",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        data: {
          __subscriptionRuntime: {
            version: 1,
            job: "work",
            idempotencyKey: "idem-1",
          },
        },
        options: expect.objectContaining({ jobId: "task-1" }),
      }),
    ]);
  });

  it("runs Bull jobs through a worker pool without importing Bull", async () => {
    const handler = createBullSubscriptionProcessor<string, string>({
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
        run: async (job) => `ok:${job}`,
      },
    });

    await expect(handler({ id: "1", data: "job" })).resolves.toBe("ok:job");
  });

  it("preserves explicit idempotency key separately from Bull job id", async () => {
    let queuedData: unknown;
    const queue = new BullSubscriptionTaskQueue<string>({
      queue: {
        async add(_name, data, options) {
          queuedData = data;
          return { id: options?.jobId ?? "missing-job-id" };
        },
      },
    });
    await expect(
      queue.enqueue({
        job: "work",
        taskId: "task-1",
        idempotencyKey: "idem-1",
      }),
    ).resolves.toEqual({
      status: "accepted",
      taskId: "task-1",
    });
    const runs: unknown[] = [];
    const handler = createBullSubscriptionProcessor<string, string>({
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
        run: async (job, options) => {
          runs.push({ job, options });
          return `ok:${job}`;
        },
      },
    });

    await expect(
      handler({ id: "task-1", data: queuedData as string }),
    ).resolves.toBe("ok:work");
    expect(runs).toEqual([
      {
        job: "work",
        options: {
          idempotencyKey: "idem-1",
        },
      },
    ]);
  });

  it("passes decoded job data to custom Bull job mappers", async () => {
    let queuedData: unknown;
    const queue = new BullSubscriptionTaskQueue<{ readonly value: string }>({
      queue: {
        async add(_name, data, options) {
          queuedData = data;
          return { id: options?.jobId ?? "missing-job-id" };
        },
      },
    });
    await queue.enqueue({
      job: { value: "work" },
      taskId: "task-1",
      idempotencyKey: "idem-1",
    });
    const mappedData: unknown[] = [];
    const handler = createBullSubscriptionProcessor<
      { readonly value: string },
      string
    >({
      mapJob: (job) => {
        mappedData.push(job.data);
        return { value: `mapped:${job.data.value}` };
      },
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
        run: async (job) => `ok:${job.value}`,
      },
    });

    await expect(
      handler({
        id: "task-1",
        data: queuedData as { readonly value: string },
      }),
    ).resolves.toBe("ok:mapped:work");
    expect(mappedData).toEqual([{ value: "work" }]);
  });

  it("resolves processor task data without depending on the Bull adapter", () => {
    const resolved = resolveBullSubscriptionProcessorTask({
      job: {
        id: "task-1",
        data: encodeBullSubscriptionRuntimeJob({
          job: { value: "work" },
          idempotencyKey: "idem-1",
        }) as { readonly value: string },
      },
      mapJob: (job) => ({ value: `mapped:${job.data.value}` }),
      getIdempotencyKey: (job) => `custom:${job.data.value}`,
    });

    expect(resolved).toEqual({
      task: { value: "mapped:work" },
      idempotencyKey: "custom:work",
    });
  });
});
