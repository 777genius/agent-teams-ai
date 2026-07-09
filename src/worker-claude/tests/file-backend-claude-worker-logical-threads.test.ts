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
  it("retries a quota-limited logical Claude thread on another account without advancing the failed attempt", async () => {
    const rootDir = await tempRoot();
    const sharedWorkspacePath = join(rootDir, "shared-workspace");
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const engines = [
      new RecordingClaudeEngine({
        outputText: "account-a-slot-1",
        sessionIds: ["session-a"],
        writeTranscripts: true,
      }),
      new RecordingClaudeEngine({
        throwMessage: "rate_limit_exceeded",
      }),
      new RecordingClaudeEngine({
        outputText: "account-b-slot-3",
        sessionIds: ["session-c"],
        writeTranscripts: true,
      }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerThreadJob,
      FileBackendClaudeWorkerThreadResult
    >({
      poolId: "claude-thread-quota-retry-pool",
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
            providerInstanceId: `claude-thread-quota-retry-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            workspace: new FixedWorkspace(sharedWorkspacePath),
            workspacePath: sharedWorkspacePath,
            capacityPolicy: {
              ...(slotIndex === 0 ? { softMaxRunsPerWindow: 1 } : {}),
              windowMs: 60_000,
              quotaCooldownMs: 60_000,
            },
            clock,
          });
          workers.push(worker);
          return worker as unknown as SubscriptionWorker<
            FileBackendClaudeWorkerThreadJob,
            FileBackendClaudeWorkerThreadResult
          >;
        },
      }),
    });

    try {
      await pool.start();
      await workers[0]!.seedClaudeOAuth({ oauthToken: "account-a-token" });
      await workers[1]!.seedClaudeOAuth({ oauthToken: "account-a-token" });
      await workers[2]!.seedClaudeOAuth({ oauthToken: "account-b-token" });

      const first = await pool.run({
        threadId: "logical-quota-retry-thread",
        prompt: "remember QQUOTARETRY",
      });
      const second = await pool.run({
        threadId: "logical-quota-retry-thread",
        prompt: "recall QQUOTARETRY",
      });

      expect(first).toMatchObject({
        outputText: "account-a-slot-1",
        thread: {
          generation: 1,
          latestSessionId: "session-a",
          latestWorkerId: "claude-thread-quota-retry-pool:slot-1",
        },
      });
      expect(second).toMatchObject({
        outputText: "account-b-slot-3",
        thread: {
          generation: 2,
          latestSessionId: "session-c",
          latestWorkerId: "claude-thread-quota-retry-pool:slot-3",
        },
      });
      expect(engines[1]!.records[0]?.runtimeThread).toEqual({
        threadId: "logical-quota-retry-thread",
        resumeSessionId: "session-a",
      });
      expect(engines[2]!.records[0]?.runtimeThread).toEqual({
        threadId: "logical-quota-retry-thread",
        resumeSessionId: "session-a",
      });
      expect(engines[1]!.records.map((record) => record.prompt)).toEqual([
        "recall QQUOTARETRY",
      ]);
      expect(engines[2]!.records.map((record) => record.prompt)).toEqual([
        "recall QQUOTARETRY",
      ]);
      await expect(
        readFile(
          fakeClaudeTranscriptPath(
            workers[2]!.configDir,
            sharedWorkspacePath,
            "session-a",
          ),
          "utf8",
        ),
      ).resolves.toContain("remember QQUOTARETRY");
      expect(workers[1]!.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent logical Claude thread runs before provider execution", async () => {
    const rootDir = await tempRoot();
    const sharedWorkspacePath = join(rootDir, "shared-workspace");
    const engines = [
      new RecordingClaudeEngine({
        outputText: "slot-1",
        sessionIds: ["session-a", "session-a2"],
        writeTranscripts: true,
        delayMs: 20,
      }),
      new RecordingClaudeEngine({
        outputText: "slot-2",
        sessionIds: ["session-b", "session-b2"],
        writeTranscripts: true,
        delayMs: 20,
      }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerThreadJob,
      FileBackendClaudeWorkerThreadResult
    >({
      poolId: "claude-thread-concurrent-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FileBackendClaudeWorker({
          workerId,
          providerInstanceId: `claude-thread-concurrent-${slotIndex + 1}`,
          stateRootDir: rootDir,
          encryptionKey: encryptionKey(),
          engine: engines[slotIndex]!,
          workspace: new FixedWorkspace(sharedWorkspacePath),
          workspacePath: sharedWorkspacePath,
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

      const results = await Promise.all([
        pool.run({
          threadId: "logical-concurrent-thread",
          prompt: "first concurrent",
        }),
        pool.run({
          threadId: "logical-concurrent-thread",
          prompt: "second concurrent",
        }),
      ]);
      const sortedThreads = results
        .map((result) => result.thread)
        .sort((left, right) => left.generation - right.generation);
      const firstThread = sortedThreads[0]!;
      const secondThread = sortedThreads[1]!;

      expect(firstThread).toMatchObject({
        generation: 1,
        threadId: "logical-concurrent-thread",
      });
      expect(secondThread).toMatchObject({
        generation: 2,
        threadId: "logical-concurrent-thread",
      });
      expect(await transcriptBundleIds(rootDir)).toHaveLength(1);
      const records = engines.flatMap((engine) => engine.records);
      expect(records).toHaveLength(2);
      expect(
        records.filter((record) => record.runtimeThread?.resumeSessionId),
      ).toEqual([
        expect.objectContaining({
          runtimeThread: {
            threadId: "logical-concurrent-thread",
            resumeSessionId: firstThread.latestSessionId,
          },
        }),
      ]);

      const afterConflict = await pool.run({
        threadId: "logical-concurrent-thread",
        prompt: "after conflict",
      });
      const afterConflictEngineIndex = engines.findIndex((engine) =>
        engine.records.some((record) => record.prompt === "after conflict"),
      );
      expect(afterConflictEngineIndex).toBeGreaterThanOrEqual(0);
      const afterConflictRecord =
        engines[afterConflictEngineIndex]?.records.find(
          (record) => record.prompt === "after conflict",
        );

      expect(afterConflict.thread).toMatchObject({
        generation: 3,
        latestSessionId: afterConflict.telemetry?.providerSessionId,
      });
      expect(await transcriptBundleIds(rootDir)).toEqual([
        afterConflict.thread.latestBundleId,
      ]);
      expect(afterConflictRecord?.runtimeThread).toEqual({
        threadId: "logical-concurrent-thread",
        resumeSessionId: secondThread.latestSessionId,
      });
      await expect(
        readFile(
          fakeClaudeTranscriptPath(
            workers[afterConflictEngineIndex]!.configDir,
            sharedWorkspacePath,
            secondThread.latestSessionId!,
          ),
          "utf8",
        ),
      ).resolves.toContain("concurrent");
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
