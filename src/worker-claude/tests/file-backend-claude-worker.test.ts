import { spawnSync } from "node:child_process";
import {
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
  accountCapacityAwareWorkerFactory,
  type SubscriptionWorker,
  type WorkerPoolScheduler,
} from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendClaudeWorker,
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

  it("reports cooldown capacity after a configured soft run limit", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-capacity",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine: new RecordingClaudeEngine({ outputText: "answer" }),
      capacityPolicy: {
        softMaxRunsPerWindow: 1,
        windowMs: 1_000,
      },
      clock,
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await worker.run({ prompt: "first" });

      expect(worker.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "soft_run_limit",
        recentRuns: 1,
        softLimitRemainingRuns: 0,
      });

      clock.advanceMs(1_001);
      expect(worker.capacity()).toMatchObject({
        availability: "available",
        recentRuns: 0,
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("marks quota-limited failures as cooldown capacity", async () => {
    const rootDir = await tempRoot();
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-quota",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine: new RecordingClaudeEngine({
        throwMessage: "rate_limit_exceeded",
      }),
      capacityPolicy: {
        quotaCooldownMs: 60_000,
      },
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await expect(worker.run({ prompt: "review" })).rejects.toThrow(
        "Claude quota or usage limit was reached.",
      );

      expect(worker.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("captures Claude statusLine rate limits into normalized telemetry", async () => {
    const rootDir = await tempRoot();
    const telemetry = new FileClaudeRateLimitTelemetry({
      directory: join(rootDir, "rate-limit-telemetry"),
    });

    try {
      await telemetry.prepare();
      const settings = JSON.parse(await readFile(telemetry.settingsPath, "utf8"));
      const command = settings.statusLine.command;
      const resetAtSeconds = Math.floor(
        new Date("2026-06-01T05:00:00.000Z").getTime() / 1000,
      );
      const result = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        input: JSON.stringify({
          version: "2.1.159",
          model: { id: "claude-sonnet-4-6" },
          rate_limits: {
            five_hour: {
              used_percentage: 91,
              resets_at: resetAtSeconds,
            },
          },
        }),
      });

      expect(result.status).toBe(0);
      expect(telemetry.latest()).toMatchObject({
        model: "claude-sonnet-4-6",
        version: "2.1.159",
        windows: {
          five_hour: {
            usedPercentage: 91,
            remainingPercentage: 9,
            resetsAt: new Date("2026-06-01T05:00:00.000Z"),
          },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("captures and materializes Claude transcript bundles", async () => {
    const rootDir = await tempRoot();
    const configA = join(rootDir, "config-a");
    const configB = join(rootDir, "config-b");
    const workspacePath = join(rootDir, "workspace");
    const store = new FileClaudeTranscriptBundleStore(join(rootDir, "bundles"));

    try {
      await writeFakeClaudeTranscript({
        configDir: configA,
        workspacePath,
        sessionId: "session-a",
        text: "remember QTBUNDLE",
      });

      const bundle = await store.capture({
        sourceConfigDir: configA,
        cwd: workspacePath,
        sessionId: "session-a",
      });
      await store.materialize({
        bundleId: bundle.bundleId,
        targetConfigDir: configB,
      });

      await expect(
        readFile(
          fakeClaudeTranscriptPath(configB, workspacePath, "session-a"),
          "utf8",
        ),
      ).resolves.toContain("QTBUNDLE");
      expect(bundle).toMatchObject({
        cwd: await realpath(workspacePath),
        sessionId: "session-a",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects transcript bundle paths that traverse outside the target config dir", async () => {
    const rootDir = await tempRoot();
    const bundleRoot = join(rootDir, "bundles");
    const bundleId = "malicious-bundle";
    const bundleDir = join(bundleRoot, "bundles", bundleId);
    const targetConfigDir = join(rootDir, "target-config");
    const escapedPath = join(rootDir, "escape.txt");
    const store = new FileClaudeTranscriptBundleStore(bundleRoot);

    try {
      await mkdir(bundleDir, { recursive: true });
      await writeFile(
        join(bundleDir, "manifest.json"),
        `${JSON.stringify({
          bundleId,
          cwd: rootDir,
          sessionId: "session-a",
          sourceConfigDir: join(rootDir, "source-config"),
          files: ["safe/../../escape.txt"],
          capturedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
      );
      await writeFile(join(bundleDir, "escape.txt"), "must not escape", "utf8");

      await expect(
        store.materialize({
          bundleId,
          targetConfigDir,
        }),
      ).rejects.toThrow("claude_safe_relative_path_required");
      await expect(readFile(escapedPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects transcript bundle payloads that are not regular files", async () => {
    const rootDir = await tempRoot();
    const bundleRoot = join(rootDir, "bundles");
    const bundleId = "directory-payload-bundle";
    const bundleDir = join(bundleRoot, "bundles", bundleId);
    const filesDir = join(bundleDir, "files");
    const relativePath = "projects/workspace/session-a.jsonl";
    const targetConfigDir = join(rootDir, "target-config");
    const targetPath = join(targetConfigDir, relativePath);
    const store = new FileClaudeTranscriptBundleStore(bundleRoot);

    try {
      await mkdir(join(filesDir, relativePath), { recursive: true });
      await writeFile(
        join(bundleDir, "manifest.json"),
        `${JSON.stringify({
          bundleId,
          cwd: rootDir,
          sessionId: "session-a",
          sourceConfigDir: join(rootDir, "source-config"),
          files: [relativePath],
          capturedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
      );

      await expect(
        store.materialize({
          bundleId,
          targetConfigDir,
        }),
      ).rejects.toThrow("claude_transcript_bundle_file_invalid");
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports cooldown from Claude rate-limit telemetry and restores after reset", async () => {
    const rootDir = await tempRoot();
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const telemetry = new MutableRateLimitTelemetry();
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    telemetry.set(rateLimitSnapshot(clock.now(), {
      five_hour: { usedPercentage: 92, resetsAt: resetAt },
    }));
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-threshold",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      engine: new RecordingClaudeEngine({ outputText: "answer" }),
      rateLimitTelemetry: telemetry,
      capacityPolicy: {
        rateLimitMinRemainingPercent: 10,
      },
      clock,
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });

      expect(worker.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
        details: {
          rateLimitWindow: "five_hour",
          rateLimitRemainingPercent: "8",
          rateLimitResetAt: resetAt.toISOString(),
          rateLimitUsedPercentage: "92",
        },
      });

      clock.advanceMs(60 * 60 * 1000 + 1);
      expect(worker.capacity()).toMatchObject({
        availability: "available",
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

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

  it("protects logical Claude thread state from concurrent worker updates", async () => {
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

      const outcomes = await Promise.allSettled([
        pool.run({
          threadId: "logical-concurrent-thread",
          prompt: "first concurrent",
        }),
        pool.run({
          threadId: "logical-concurrent-thread",
          prompt: "second concurrent",
        }),
      ]);
      const fulfilled = outcomes.filter(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<FileBackendClaudeWorkerThreadResult> =>
          outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]!.value.thread).toMatchObject({
        generation: 1,
        threadId: "logical-concurrent-thread",
      });
      expect(rejected[0]!.reason).toBeInstanceOf(Error);
      expect((rejected[0]!.reason as Error).message).toContain(
        "Worker pool slot failed to run a task.",
      );

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
        generation: 2,
        latestSessionId: afterConflict.telemetry?.providerSessionId,
      });
      expect(afterConflictRecord?.runtimeThread).toEqual({
        threadId: "logical-concurrent-thread",
        resumeSessionId: fulfilled[0]!.value.thread.latestSessionId,
      });
      await expect(
        readFile(
          fakeClaudeTranscriptPath(
            workers[afterConflictEngineIndex]!.configDir,
            sharedWorkspacePath,
            fulfilled[0]!.value.thread.latestSessionId!,
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

class RecordingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "recording-claude-engine";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };
  readonly records: ClaudeTaskEngineInput[] = [];

  constructor(
    private readonly options: {
      readonly outputText?: string;
      readonly throwMessage?: string;
      readonly sessionIds?: readonly string[];
      readonly writeTranscripts?: boolean;
      readonly delayMs?: number;
    } = {},
  ) {}

  async run(
    input: ClaudeTaskEngineInput,
  ): Promise<ClaudeTaskExecutionResult> {
    this.records.push(input);
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.throwMessage) {
      throw new Error(this.options.throwMessage);
    }
    const sessionId =
      this.options.sessionIds?.[this.records.length - 1] ??
      `session-${this.records.length}`;
    if (this.options.writeTranscripts) {
      if (!input.session.configDir) {
        throw new Error("recording_claude_config_dir_required");
      }
      await writeFakeClaudeTranscript({
        configDir: input.session.configDir,
        workspacePath: input.workspacePath,
        sessionId,
        text: input.prompt,
      });
    }
    return {
      outputText: this.options.outputText ?? "ok",
      telemetry: {
        providerRunId: `run-${this.records.length}`,
        providerSessionId: sessionId,
      } satisfies ProviderTaskTelemetry,
      warnings: [],
    };
  }

  async dispose(): Promise<void> {}
}

class MutableClock implements ClockPort {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  monotonicMs(): number {
    return this.current.getTime();
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class MutableRateLimitTelemetry implements ClaudeRateLimitTelemetrySource {
  constructor(private snapshot: ClaudeRateLimitTelemetrySnapshot | null = null) {}

  latest(): ClaudeRateLimitTelemetrySnapshot | null {
    return this.snapshot;
  }

  set(snapshot: ClaudeRateLimitTelemetrySnapshot | null): void {
    this.snapshot = snapshot;
  }
}

class ManualScheduler implements WorkerPoolScheduler {
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  delays(): number[] {
    return Array.from(this.timers.values(), (timer) => timer.delayMs);
  }

  runNext(): void {
    const entry = this.timers.entries().next().value;
    if (!entry) {
      throw new Error("manual_scheduler_empty");
    }
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
  }
}

class FixedWorkspace implements WorkspacePort {
  readonly workspaceId = "fixed-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: false,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(private readonly workspacePath: string) {}

  async create() {
    await mkdir(this.workspacePath, { recursive: true, mode: 0o700 });
    return { path: this.workspacePath };
  }
}

class StaleOnceSessionStore implements SessionStorePort {
  readonly storeId = "stale-once-session-store";
  readonly custody = "local-only" as const;
  readonly capabilities = {
    storeId: this.storeId,
    custody: this.custody,
    supportsRead: true,
    supportsWriteback: true,
    supportsCompareAndSwap: true,
    supportsIdempotency: false,
    supportsDelete: false,
    supportsAuditLog: false,
    supportsMetadataOnlyHealthCheck: false,
    plaintextAvailableToBackend: true,
    maxArtifactBytes: 256_000,
  };
  writeCount = 0;
  current: SessionEnvelope;

  constructor(
    providerInstanceId: string,
    artifact: SessionArtifact,
  ) {
    this.current = {
      providerInstanceId,
      providerId: "claude",
      artifact,
      generation: 1,
      generationHash: "generation-1",
      storageVersion: "stale-once-session-store-v1",
      custody: this.custody,
      metadata: {},
    };
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
  }): Promise<SessionEnvelope | null> {
    if (input.providerInstanceId !== this.current.providerInstanceId) {
      return null;
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== this.current.providerId
    ) {
      return null;
    }
    return this.current;
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
  }) {
    this.writeCount += 1;
    if (this.writeCount === 1) {
      this.current = {
        ...this.current,
        generation: this.current.generation + 1,
        generationHash: "generation-2",
      };
      return {
        status: "stale_generation" as const,
        currentGeneration: this.current.generation,
        currentGenerationHash: this.current.generationHash,
      };
    }

    this.current = {
      ...this.current,
      providerInstanceId: input.providerInstanceId,
      artifact: input.nextArtifact,
      generation: input.expectedGeneration + 1,
      generationHash: "generation-3",
    };
    return {
      status: "accepted" as const,
      generation: this.current.generation,
      generationHash: this.current.generationHash,
    };
  }
}

function rateLimitSnapshot(
  observedAt: Date,
  windows: Partial<
    Record<
      ClaudeRateLimitWindowName,
      { readonly usedPercentage: number; readonly resetsAt: Date }
    >
  >,
): ClaudeRateLimitTelemetrySnapshot {
  return {
    observedAt,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, window]) => [
        name,
        {
          usedPercentage: window!.usedPercentage,
          remainingPercentage: Math.max(0, 100 - window!.usedPercentage),
          resetsAt: window!.resetsAt,
        },
      ]),
    ) as ClaudeRateLimitTelemetrySnapshot["windows"],
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "subscription-runtime-claude-worker-"));
}

function encryptionKey(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

async function writeFakeClaudeTranscript(input: {
  readonly configDir: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly text: string;
}): Promise<void> {
  const path = fakeClaudeTranscriptPath(
    input.configDir,
    input.workspacePath,
    input.sessionId,
  );
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await mkdir(input.workspacePath, { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify({
      type: "assistant",
      sessionId: input.sessionId,
      text: input.text,
    })}\n`,
    "utf8",
  );
}

function fakeClaudeTranscriptPath(
  configDir: string,
  workspacePath: string,
  sessionId: string,
): string {
  return join(configDir, "projects", fakeClaudeProjectKey(workspacePath), `${sessionId}.jsonl`);
}

function fakeClaudeProjectKey(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/gu, "-");
}
