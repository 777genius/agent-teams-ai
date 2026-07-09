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
  it("prewarms context-only and runs Claude tasks with a stable config dir", async () => {
    const rootDir = await tempRoot();
    const engine = new RecordingClaudeEngine({ outputText: "answer" });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-main",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine,
      model: "sonnet",
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      const prewarm = await worker.prewarm();
      const result = await worker.run({ prompt: "review diff" });

      expect(prewarm).toMatchObject({
        status: "ready",
        details: { mode: "context-only", configDir: worker.configDir },
      });
      expect(engine.records).toHaveLength(1);
      expect(engine.records[0]).toMatchObject({
        model: "sonnet",
        prompt: "review diff",
        session: {
          configDir: worker.configDir,
          oauthToken: "claude-oauth-secret",
        },
      });
      expect(result).toMatchObject({ outputText: "answer" });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("injects worker control inbox guidance into Claude safe-point runs once", async () => {
    const rootDir = await tempRoot();
    const engine = new RecordingClaudeEngine({ outputText: "guided-answer" });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock: { now: () => new Date("2026-06-30T00:00:00.000Z") },
      idFactory: sequentialIds("control"),
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-guided",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine,
      controlInbox,
    });

    try {
      await controlInbox.enqueueSignal({
        target: { jobId: "job-guided" },
        intent: "guidance",
        body: "Prefer targeted unit tests before broad verification.",
        idempotencyKey: "guide-once",
      });
      const pauseSignal = await controlInbox.enqueueSignal({
        target: { jobId: "job-guided" },
        intent: "pause_requested",
        deliveryMode: "pause_then_continue",
        body: "Pause before continuing unless Claude support is explicit.",
      });

      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      const first = await worker.run({
        jobId: "job-guided",
        runId: "run-guided-1",
        prompt: "review diff",
      });
      const second = await worker.run({
        jobId: "job-guided",
        runId: "run-guided-2",
        prompt: "continue review",
      });

      expect(engine.records[0]?.prompt).toContain("review diff");
      expect(engine.records[0]?.prompt).toContain("Updated task from operator");
      expect(engine.records[0]?.prompt).toContain("targeted unit tests");
      expect(engine.records[0]?.prompt).not.toContain(
        "Pause before continuing unless Claude support is explicit.",
      );
      expect(engine.records[0]?.appendSystemPrompt).toContain(
        "Runtime control inbox instructions",
      );
      expect(engine.records[0]?.appendSystemPrompt).toContain(
        "trusted system-level operator instructions",
      );
      expect(engine.records[0]?.appendSystemPrompt).toContain("targeted unit tests");
      expect(
        engine.records[0]?.appendSystemPrompt?.includes(
          "Pause before continuing unless Claude support is explicit.",
        ),
      ).toBe(false);
      expect(first.workerControlSignalIds).toEqual(["control-1"]);
      expect(engine.records[1]?.prompt).toBe("continue review");
      expect(second.workerControlSignalIds).toBeUndefined();
      const controlViews = await controlInbox.listSignals({
        target: { jobId: "job-guided" },
        includeExpired: true,
      });
      const pauseView = controlViews.find((view) =>
        view.signal.signalId === pauseSignal.signalId
      );
      expect(pauseView).toMatchObject({
        state: "pending",
        blockedReason: "pause_then_continue_not_supported",
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("injects worker control inbox guidance into Claude logical thread runs", async () => {
    const rootDir = await tempRoot();
    const sharedWorkspacePath = join(rootDir, "shared-workspace");
    const engine = new RecordingClaudeEngine({
      outputText: "thread-guided",
      sessionIds: ["thread-session-1"],
      writeTranscripts: true,
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock: { now: () => new Date("2026-06-30T00:00:00.000Z") },
      idFactory: sequentialIds("thread-control"),
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-thread-guided",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine,
      workspace: new FixedWorkspace(sharedWorkspacePath),
      workspacePath: sharedWorkspacePath,
      controlInbox,
    });

    try {
      await controlInbox.enqueueSignal({
        target: { jobId: "thread-guided-job" },
        intent: "guidance",
        body: "Preserve the existing logical thread context.",
      });
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });

      const result = await worker.run({
        jobId: "thread-guided-job",
        threadId: "logical-guided-thread",
        prompt: "continue thread",
      });

      expect(engine.records[0]?.prompt).toContain("continue thread");
      expect(engine.records[0]?.prompt).toContain("Updated task from operator");
      expect(engine.records[0]?.prompt).toContain(
        "Preserve the existing logical thread context.",
      );
      expect(engine.records[0]?.appendSystemPrompt).toContain(
        "Runtime control inbox instructions",
      );
      expect(engine.records[0]?.runtimeThread).toEqual({
        threadId: "logical-guided-thread",
      });
      expect(result).toMatchObject({
        outputText: "thread-guided",
        workerControlSignalIds: ["thread-control-1"],
        thread: { latestSessionId: "thread-session-1" },
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates direct job system prompts before runtime dispatch", async () => {
    const rootDir = await tempRoot();
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-main",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine: new RecordingClaudeEngine(),
    });

    try {
      await worker.start();
      await expect(
        worker.run({ prompt: "review", systemPrompt: "" }),
      ).rejects.toThrow("job.systemPrompt must not be empty");
      await expect(
        worker.run({
          prompt: "review",
          systemPrompt: "x".repeat(256 * 1024 + 1),
        }),
      ).rejects.toThrow("job.systemPrompt exceeds 262144 bytes");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("surfaces shared Claude quota groups without sharing config dirs", async () => {
    const rootDir = await tempRoot();
    const workers = [
      new FileBackendClaudeWorker({
        workerId: "claude-slot-a",
        providerInstanceId: "claude-a",
        stateRootDir: rootDir,
        encryptionKey: encryptionKey(),
        engine: new RecordingClaudeEngine(),
      }),
      new FileBackendClaudeWorker({
        workerId: "claude-slot-b",
        providerInstanceId: "claude-b",
        stateRootDir: rootDir,
        encryptionKey: encryptionKey(),
        engine: new RecordingClaudeEngine(),
      }),
    ];

    try {
      await Promise.all(workers.map((worker) => worker.start()));
      await Promise.all(
        workers.map((worker) =>
          worker.seedClaudeOAuth({ oauthToken: "shared-claude-oauth-secret" }),
        ),
      );

      const firstCapacity = workers[0]!.capacity();
      const secondCapacity = workers[1]!.capacity();
      const health = await Promise.all(
        workers.map((worker) => worker.health()),
      );

      expect(workers[0]!.configDir).not.toBe(workers[1]!.configDir);
      expect(firstCapacity.details?.quotaGroup).toBe(
        secondCapacity.details?.quotaGroup,
      );
      expect(firstCapacity.details?.accountId).toBe(
        firstCapacity.details?.quotaGroup,
      );
      expect(secondCapacity.details?.accountId).toBe(
        secondCapacity.details?.quotaGroup,
      );
      expect(firstCapacity.details).toMatchObject({
        providerInstanceId: "claude-a",
        configDir: workers[0]!.configDir,
      });
      expect(secondCapacity.details).toMatchObject({
        providerInstanceId: "claude-b",
        configDir: workers[1]!.configDir,
      });
      expect(health[0]?.details?.quotaGroup).toBe(
        firstCapacity.details?.quotaGroup,
      );
      expect(health[1]?.details?.quotaGroup).toBe(
        secondCapacity.details?.quotaGroup,
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.dispose()));
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("supports an explicit capacity account id across distinct OAuth tokens", async () => {
    const rootDir = await tempRoot();
    const workers = [
      new FileBackendClaudeWorker({
        workerId: "claude-slot-a",
        providerInstanceId: "claude-capacity-a",
        stateRootDir: rootDir,
        encryptionKey: encryptionKey(),
        engine: new RecordingClaudeEngine(),
        capacityAccountId: " claude-account-main ",
      }),
      new FileBackendClaudeWorker({
        workerId: "claude-slot-b",
        providerInstanceId: "claude-capacity-b",
        stateRootDir: rootDir,
        encryptionKey: encryptionKey(),
        engine: new RecordingClaudeEngine(),
      }),
    ];

    try {
      await Promise.all(workers.map((worker) => worker.start()));
      await workers[0]!.seedClaudeOAuth({ oauthToken: "first-oauth-token" });
      await workers[1]!.seedClaudeOAuth({
        oauthToken: "second-oauth-token",
      });
      expect(workers[1]!.capacity().details?.accountId).toBe(
        workers[1]!.capacity().details?.quotaGroup,
      );
      await workers[1]!.seedClaudeOAuth({
        oauthToken: "second-oauth-token",
        capacityAccountId: "claude-account-main",
      });

      const firstCapacity = workers[0]!.capacity();
      const secondCapacity = workers[1]!.capacity();

      expect(firstCapacity.details?.accountId).toBe("claude-account-main");
      expect(secondCapacity.details?.accountId).toBe("claude-account-main");
      expect(firstCapacity.details?.quotaGroup).toBeTruthy();
      expect(secondCapacity.details?.quotaGroup).toBeTruthy();
      expect(firstCapacity.details?.quotaGroup).not.toBe(
        secondCapacity.details?.quotaGroup,
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.dispose()));
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists a late capacity account id update across worker restarts", async () => {
    const rootDir = await tempRoot();
    const key = encryptionKey();
    const first = new FileBackendClaudeWorker({
      providerInstanceId: "claude-capacity-restart",
      stateRootDir: rootDir,
      encryptionKey: key,
      engine: new RecordingClaudeEngine(),
    });
    const restarted = new FileBackendClaudeWorker({
      providerInstanceId: "claude-capacity-restart",
      stateRootDir: rootDir,
      encryptionKey: key,
      engine: new RecordingClaudeEngine(),
    });

    try {
      await first.start();
      await first.seedClaudeOAuth({ oauthToken: "restart-oauth-token" });
      await first.seedClaudeOAuth({
        oauthToken: "restart-oauth-token",
        capacityAccountId: "claude-account-main",
      });
      expect(first.capacity().details?.accountId).toBe("claude-account-main");
      await first.dispose();

      await restarted.start();
      await restarted.seedClaudeOAuth({ oauthToken: "restart-oauth-token" });

      expect(restarted.capacity().details?.accountId).toBe(
        "claude-account-main",
      );
    } finally {
      await Promise.all([
        first.dispose().catch(() => undefined),
        restarted.dispose().catch(() => undefined),
      ]);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries late capacity account id persistence after a stale generation", async () => {
    const rootDir = await tempRoot();
    const store = new StaleOnceSessionStore(
      "claude-capacity-stale",
      sessionArtifactFromClaudeOAuth({
        oauthToken: "stale-oauth-token",
        configDir: "/tmp/claude-config",
      }),
    );
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-capacity-stale",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine: new RecordingClaudeEngine(),
    });
    (
      worker as unknown as {
        sessionStore: SessionStorePort;
      }
    ).sessionStore = store;

    try {
      await worker.start();
      await worker.seedClaudeOAuth({
        oauthToken: "stale-oauth-token",
        capacityAccountId: "claude-account-main",
      });

      expect(store.writeCount).toBe(2);
      expect(worker.capacity().details?.accountId).toBe(
        "claude-account-main",
      );
      expect(
        validateClaudeSessionArtifact(store.current.artifact).session.metadata
          ?.capacityAccountId,
      ).toBe("claude-account-main");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("can opt into spending warmup prompt prewarm", async () => {
    const rootDir = await tempRoot();
    const engine = new RecordingClaudeEngine({ outputText: "OK" });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-warmup",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine,
      warmupPrompt: "Return exactly OK.",
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      const prewarm = await worker.prewarm();

      expect(prewarm).toMatchObject({
        status: "ready",
        details: { mode: "warmup-task" },
      });
      expect(engine.records.map((record) => record.prompt)).toEqual([
        "Return exactly OK.",
      ]);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
