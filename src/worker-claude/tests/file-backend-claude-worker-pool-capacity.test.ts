import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ClockPort,
  ProviderTaskTelemetry,
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
} from "@vioxen/subscription-runtime/provider-claude";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  type SubscriptionWorker,
  type WorkerPoolScheduler,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  FileBackendClaudeWorker,
  FileClaudeLogicalThreadStore,
  FileClaudeTranscriptBundleStore,
  FileClaudeRateLimitTelemetry,
  type ClaudeRateLimitTelemetrySnapshot,
  type ClaudeRateLimitTelemetrySource,
  type ClaudeRateLimitWindowName,
  type FileBackendClaudeWorkerJob,
  type FileBackendClaudeWorkerResult,
  type FileBackendClaudeWorkerThreadJob,
  type FileBackendClaudeWorkerThreadResult,
} from "../index";
import {
  FixedWorkspace,
  ManualScheduler,
  MutableClock,
  MutableRateLimitTelemetry,
  RecordingClaudeEngine,
  StaleOnceSessionStore,
  encryptionKey,
  fakeClaudeTranscriptPath,
  hashStringForTest,
  rateLimitSnapshot,
  sequentialIds,
  tempRoot,
  transcriptBundleIds,
  writeFakeClaudeTranscript,
} from "./file-backend-claude-worker-test-support";

describe("FileBackendClaudeWorker", () => {
  it("works inside the generic pool and rotates away from cooldown slots", async () => {
    const rootDir = await tempRoot();
    const engines = [
      new RecordingClaudeEngine({ outputText: "slot-1" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerJob,
      FileBackendClaudeWorkerResult
    >({
      poolId: "claude-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FileBackendClaudeWorker({
          workerId,
          providerInstanceId: `claude-${slotIndex + 1}`,
          stateRootDir: rootDir,
          encryptionKey: encryptionKey(),
          engine: engines[slotIndex]!,
          capacityPolicy: {
            softMaxRunsPerWindow: 1,
            windowMs: 60_000,
          },
        });
        workers.push(worker);
        return worker;
      },
    });

    try {
      await pool.start();
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: `${worker.workerId}-token` }),
        ),
      );

      await expect(pool.run({ prompt: "first" })).resolves.toMatchObject({
        outputText: "slot-1",
      });
      await expect(pool.run({ prompt: "second" })).resolves.toMatchObject({
        outputText: "slot-2",
      });

      expect(engines[0]!.records.map((record) => record.prompt)).toEqual([
        "first",
      ]);
      expect(engines[1]!.records.map((record) => record.prompt)).toEqual([
        "second",
      ]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rotates away from workers whose Claude limit telemetry crosses the threshold", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date());
    const resetAt = new Date(clock.now().getTime() + 60 * 60 * 1000);
    const telemetry = [
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
    ];
    const engines = [
      new RecordingClaudeEngine({ outputText: "slot-1" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      Parameters<FileBackendClaudeWorker["run"]>[0],
      Awaited<ReturnType<FileBackendClaudeWorker["run"]>>
    >({
      poolId: "claude-rate-limit-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FileBackendClaudeWorker({
          workerId,
          providerInstanceId: `claude-limit-${slotIndex + 1}`,
          stateRootDir: rootDir,
          encryptionKey: encryptionKey(),
          engine: engines[slotIndex]!,
          rateLimitTelemetry: telemetry[slotIndex]!,
          capacityPolicy: {
            rateLimitMinRemainingPercent: 10,
          },
          clock,
        });
        workers.push(worker);
        return worker;
      },
    });

    try {
      await pool.start();
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: `${worker.workerId}-token` }),
        ),
      );

      await expect(pool.run({ prompt: "review" })).resolves.toMatchObject({
        outputText: "slot-2",
      });

      expect(workers[0]!.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
      });
      expect(engines[0]!.records).toHaveLength(0);
      expect(engines[1]!.records.map((record) => record.prompt)).toEqual([
        "review",
      ]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("propagates Claude account cooldown across same-token workers", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const telemetry = [
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
    ];
    const engines = [
      new RecordingClaudeEngine({ outputText: "slot-1" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
      new RecordingClaudeEngine({ outputText: "slot-3" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      Parameters<FileBackendClaudeWorker["run"]>[0],
      Awaited<ReturnType<FileBackendClaudeWorker["run"]>>
    >({
      poolId: "claude-account-aware-pool",
      slots: 3,
      clock,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-account-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            rateLimitTelemetry: telemetry[slotIndex]!,
            capacityPolicy: {
              rateLimitMinRemainingPercent: 10,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await workers[0]!.seedClaudeOAuth({ oauthToken: "shared-token" });
      await workers[1]!.seedClaudeOAuth({ oauthToken: "shared-token" });
      await workers[2]!.seedClaudeOAuth({ oauthToken: "other-token" });

      await expect(pool.run({ prompt: "first" })).resolves.toMatchObject({
        outputText: "slot-3",
      });

      expect(workers[0]!.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "rate_limit_threshold",
      });
      expect(engines[0]!.records).toHaveLength(0);
      expect(engines[1]!.records).toHaveLength(0);
      expect(engines[2]!.records.map((record) => record.prompt)).toEqual([
        "first",
      ]);

      clock.advanceMs(60 * 60 * 1000 + 1);

      await expect(pool.run({ prompt: "after-reset" })).resolves.toMatchObject({
        outputText: "slot-1",
      });
      expect(engines[0]!.records.map((record) => record.prompt)).toEqual([
        "after-reset",
      ]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("surfaces Claude account cooldown in sibling worker health", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const telemetry = [
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerJob,
      FileBackendClaudeWorkerResult
    >({
      poolId: "claude-account-health-pool",
      slots: 3,
      clock,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-account-health-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: new RecordingClaudeEngine({
              outputText: `slot-${slotIndex + 1}`,
            }),
            rateLimitTelemetry: telemetry[slotIndex]!,
            capacityPolicy: {
              rateLimitMinRemainingPercent: 10,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await workers[0]!.seedClaudeOAuth({ oauthToken: "shared-token" });
      await workers[1]!.seedClaudeOAuth({ oauthToken: "shared-token" });
      await workers[2]!.seedClaudeOAuth({ oauthToken: "other-token" });

      const health = await pool.health();

      expect(health.status).toBe("degraded");
      expect(health.slots[0]).toMatchObject({
        status: "degraded",
        failures: [{ code: "rate_limit_threshold" }],
        details: {
          accountId: workers[0]!.capacity().details?.accountId,
          quotaGroup: workers[0]!.capacity().details?.quotaGroup,
          providerInstanceId: "claude-account-health-1",
        },
      });
      expect(health.slots[1]).toMatchObject({
        status: "degraded",
        failures: [{ code: "rate_limit_threshold" }],
        details: {
          accountId: workers[0]!.capacity().details?.accountId,
          quotaGroup: workers[0]!.capacity().details?.quotaGroup,
          providerInstanceId: "claude-account-health-2",
        },
      });
      expect(health.slots[2]).toMatchObject({
        status: "healthy",
        details: {
          providerInstanceId: "claude-account-health-3",
        },
      });

      clock.advanceMs(60 * 60 * 1000 + 1);

      const recoveredHealth = await pool.health();

      expect(recoveredHealth.status).toBe("healthy");
      expect(recoveredHealth.slots).toHaveLength(3);
      expect(recoveredHealth.slots.map((slot) => slot.status)).toEqual([
        "healthy",
        "healthy",
        "healthy",
      ]);
      expect(recoveredHealth.slots[0]?.details).toMatchObject({
        accountId: workers[0]!.capacity().details?.accountId,
        quotaGroup: workers[0]!.capacity().details?.quotaGroup,
        providerInstanceId: "claude-account-health-1",
      });
      expect(recoveredHealth.slots[1]?.details).toMatchObject({
        accountId: workers[1]!.capacity().details?.accountId,
        quotaGroup: workers[1]!.capacity().details?.quotaGroup,
        providerInstanceId: "claude-account-health-2",
      });
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("drains queued Claude account cooldown work after account reset", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const scheduler = new ManualScheduler();
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const telemetry = [
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
    ];
    const engines = [
      new RecordingClaudeEngine({ outputText: "slot-1" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerJob,
      FileBackendClaudeWorkerResult
    >({
      poolId: "claude-account-queue-pool",
      slots: 2,
      clock,
      scheduler,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-account-queue-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            rateLimitTelemetry: telemetry[slotIndex]!,
            capacityPolicy: {
              rateLimitMinRemainingPercent: 10,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: "shared-account-token" }),
        ),
      );

      const queued = pool.run({ prompt: "after-reset" });

      expect(pool.stats().queued).toBe(1);
      expect(scheduler.delays()).toEqual([60 * 60 * 1000]);
      expect(engines[0]!.records).toHaveLength(0);
      expect(engines[1]!.records).toHaveLength(0);

      clock.advanceMs(60 * 60 * 1000 + 1);
      scheduler.runNext();

      await expect(queued).resolves.toMatchObject({
        outputText: "slot-1",
      });
      expect(engines[0]!.records.map((record) => record.prompt)).toEqual([
        "after-reset",
      ]);
      expect(pool.stats().queued).toBe(0);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("removes aborted queued Claude account cooldown work before reset drain", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const scheduler = new ManualScheduler();
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const telemetry = [
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      })),
      new MutableRateLimitTelemetry(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 12, resetsAt: resetAt },
      })),
    ];
    const engines = [
      new RecordingClaudeEngine({ outputText: "slot-1" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerJob,
      FileBackendClaudeWorkerResult
    >({
      poolId: "claude-account-abort-queue-pool",
      slots: 2,
      clock,
      scheduler,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-account-abort-queue-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            rateLimitTelemetry: telemetry[slotIndex]!,
            capacityPolicy: {
              rateLimitMinRemainingPercent: 10,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: "shared-account-token" }),
        ),
      );

      const controller = new AbortController();
      const queued = pool.run(
        { prompt: "must-not-run" },
        { abortSignal: controller.signal },
      );
      expect(pool.stats().queued).toBe(1);

      controller.abort();

      await expect(queued).rejects.toThrow("Worker pool run was aborted");
      expect(pool.stats().queued).toBe(0);

      clock.advanceMs(60 * 60 * 1000 + 1);
      scheduler.runNext();

      expect(engines[0]!.records).toHaveLength(0);
      expect(engines[1]!.records).toHaveLength(0);
      expect(pool.stats().queued).toBe(0);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries the same job on another Claude worker after quota cooldown", async () => {
    const rootDir = await tempRoot();
    const engines = [
      new RecordingClaudeEngine({ throwMessage: "rate_limit_exceeded" }),
      new RecordingClaudeEngine({ outputText: "slot-2" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      Parameters<FileBackendClaudeWorker["run"]>[0],
      Awaited<ReturnType<FileBackendClaudeWorker["run"]>>
    >({
      poolId: "claude-quota-pool",
      slots: 2,
      retryPolicy: {
        maxAttempts: 2,
        retryOnSlotCapacityUnavailable: true,
      },
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FileBackendClaudeWorker({
          workerId,
          providerInstanceId: `claude-quota-${slotIndex + 1}`,
          stateRootDir: rootDir,
          encryptionKey: encryptionKey(),
          engine: engines[slotIndex]!,
          capacityPolicy: {
            quotaCooldownMs: 60_000,
          },
        });
        workers.push(worker);
        return worker;
      },
    });

    try {
      await pool.start();
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: `${worker.workerId}-token` }),
        ),
      );

      await expect(pool.run({ prompt: "review" })).resolves.toMatchObject({
        outputText: "slot-2",
      });

      expect(workers[0]!.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
      expect(engines[0]!.records.map((record) => record.prompt)).toEqual([
        "review",
      ]);
      expect(engines[1]!.records.map((record) => record.prompt)).toEqual([
        "review",
      ]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries quota-limited Claude work on a different account", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const engines = [
      new RecordingClaudeEngine({ throwMessage: "rate_limit_exceeded" }),
      new RecordingClaudeEngine({ outputText: "same-account-slot-2" }),
      new RecordingClaudeEngine({ outputText: "other-account-slot-3" }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerJob,
      FileBackendClaudeWorkerResult
    >({
      poolId: "claude-quota-account-aware-pool",
      slots: 3,
      clock,
      retryPolicy: {
        maxAttempts: 3,
        retryOnSlotCapacityUnavailable: true,
      },
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-quota-account-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            capacityPolicy: {
              quotaCooldownMs: 60_000,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await workers[0]!.seedClaudeOAuth({ oauthToken: "account-a-token" });
      await workers[1]!.seedClaudeOAuth({ oauthToken: "account-a-token" });
      await workers[2]!.seedClaudeOAuth({ oauthToken: "account-b-token" });

      await expect(pool.run({ prompt: "review" })).resolves.toMatchObject({
        outputText: "other-account-slot-3",
      });

      const accountId = workers[0]!.capacity().details?.quotaGroup;
      expect(accountId).toBeTruthy();
      expect(
        accountCapacityStore.read({ accountId: accountId!, now: clock.now() }),
      ).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
      expect(engines[0]!.records.map((record) => record.prompt)).toEqual([
        "review",
      ]);
      expect(engines[1]!.records).toHaveLength(0);
      expect(engines[2]!.records.map((record) => record.prompt)).toEqual([
        "review",
      ]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
