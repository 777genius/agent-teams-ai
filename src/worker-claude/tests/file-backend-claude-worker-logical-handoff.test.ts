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
  it("hands off one logical Claude thread to another worker after soft cooldown", async () => {
    const rootDir = await tempRoot();
    const sharedWorkspacePath = join(rootDir, "shared-workspace");
    const engines = [
      new RecordingClaudeEngine({
        outputText: "first-worker",
        sessionIds: ["session-a"],
        writeTranscripts: true,
      }),
      new RecordingClaudeEngine({
        outputText: "second-worker",
        sessionIds: ["session-b"],
        writeTranscripts: true,
      }),
    ];
    const workers: FileBackendClaudeWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      FileBackendClaudeWorkerThreadJob,
      FileBackendClaudeWorkerThreadResult
    >({
      poolId: "claude-thread-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FileBackendClaudeWorker({
          workerId,
          providerInstanceId: `claude-thread-${slotIndex + 1}`,
          stateRootDir: rootDir,
          encryptionKey: encryptionKey(),
          engine: engines[slotIndex]!,
          workspace: new FixedWorkspace(sharedWorkspacePath),
          workspacePath: sharedWorkspacePath,
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

      const first = await pool.run({
        threadId: "logical-review-thread",
        prompt: "remember QTHREAD",
      });
      const second = await pool.run({
        threadId: "logical-review-thread",
        prompt: "recall QTHREAD",
      });

      expect(first).toMatchObject({
        outputText: "first-worker",
        thread: {
          generation: 1,
          latestSessionId: "session-a",
          latestWorkerId: "claude-thread-pool:slot-1",
        },
      });
      expect(second).toMatchObject({
        outputText: "second-worker",
        thread: {
          generation: 2,
          latestSessionId: "session-b",
          latestWorkerId: "claude-thread-pool:slot-2",
        },
      });
      expect(engines[0]!.records[0]?.runtimeThread).toEqual({
        threadId: "logical-review-thread",
      });
      expect(engines[1]!.records[0]?.runtimeThread).toEqual({
        threadId: "logical-review-thread",
        resumeSessionId: "session-a",
      });
      await expect(
        readFile(
          fakeClaudeTranscriptPath(
            workers[1]!.configDir,
            sharedWorkspacePath,
            "session-a",
          ),
          "utf8",
        ),
      ).resolves.toContain("remember QTHREAD");
      expect(workers[0]!.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "soft_run_limit",
      });
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("hands off a logical Claude thread to a different account when the first account is cooling down", async () => {
    const rootDir = await tempRoot();
    const sharedWorkspacePath = join(rootDir, "shared-workspace");
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const telemetry = [
      new MutableRateLimitTelemetry(),
      new MutableRateLimitTelemetry(),
      new MutableRateLimitTelemetry(),
    ];
    const engines = [
      new RecordingClaudeEngine({
        outputText: "account-a-slot-1",
        sessionIds: ["session-a"],
        writeTranscripts: true,
      }),
      new RecordingClaudeEngine({
        outputText: "account-a-slot-2",
        sessionIds: ["session-b"],
        writeTranscripts: true,
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
      poolId: "claude-thread-account-aware-pool",
      slots: 3,
      clock,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendClaudeWorker({
            workerId,
            providerInstanceId: `claude-thread-account-${slotIndex + 1}`,
            stateRootDir: rootDir,
            encryptionKey: encryptionKey(),
            engine: engines[slotIndex]!,
            workspace: new FixedWorkspace(sharedWorkspacePath),
            workspacePath: sharedWorkspacePath,
            rateLimitTelemetry: telemetry[slotIndex]!,
            capacityPolicy: {
              rateLimitMinRemainingPercent: 10,
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
        threadId: "logical-cross-account-thread",
        prompt: "remember QCROSSACCOUNT",
      });
      telemetry[0]!.set(rateLimitSnapshot(clock.now(), {
        five_hour: { usedPercentage: 92, resetsAt: resetAt },
      }));

      const second = await pool.run({
        threadId: "logical-cross-account-thread",
        prompt: "recall QCROSSACCOUNT",
      });

      expect(first).toMatchObject({
        outputText: "account-a-slot-1",
        thread: {
          generation: 1,
          latestSessionId: "session-a",
          latestWorkerId: "claude-thread-account-aware-pool:slot-1",
        },
      });
      expect(second).toMatchObject({
        outputText: "account-b-slot-3",
        thread: {
          generation: 2,
          latestSessionId: "session-c",
          latestWorkerId: "claude-thread-account-aware-pool:slot-3",
        },
      });
      expect(engines[1]!.records).toHaveLength(0);
      expect(engines[2]!.records[0]?.runtimeThread).toEqual({
        threadId: "logical-cross-account-thread",
        resumeSessionId: "session-a",
      });
      await expect(
        readFile(
          fakeClaudeTranscriptPath(
            workers[2]!.configDir,
            sharedWorkspacePath,
            "session-a",
          ),
          "utf8",
        ),
      ).resolves.toContain("remember QCROSSACCOUNT");
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
