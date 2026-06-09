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
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendClaudeWorker,
  FileClaudeTranscriptBundleStore,
  FileClaudeRateLimitTelemetry,
  type ClaudeRateLimitTelemetrySnapshot,
  type ClaudeRateLimitTelemetrySource,
  type ClaudeRateLimitWindowName,
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
      Parameters<FileBackendClaudeWorker["run"]>[0],
      Awaited<ReturnType<FileBackendClaudeWorker["run"]>>
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
    } = {},
  ) {}

  async run(
    input: ClaudeTaskEngineInput,
  ): Promise<ClaudeTaskExecutionResult> {
    this.records.push(input);
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
