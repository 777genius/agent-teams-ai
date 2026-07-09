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
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
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
      clock,
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

      clock.advanceMs(60_001);
      const capacity = worker.capacity();
      expect(capacity).toMatchObject({
        availability: "available",
      });
      expect(capacity).not.toHaveProperty("reason");
      expect(capacity).not.toHaveProperty("cooldownUntil");
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

  it("rejects unsafe Claude transcript session ids before scanning projects", async () => {
    const rootDir = await tempRoot();
    const configDir = join(rootDir, "config");
    const workspacePath = join(rootDir, "workspace");
    const store = new FileClaudeTranscriptBundleStore(join(rootDir, "bundles"));

    try {
      await mkdir(configDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });

      await expect(
        store.capture({
          sourceConfigDir: configDir,
          cwd: workspacePath,
          sessionId: "../escape",
        }),
      ).rejects.toThrow("claude_safe_id_required");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers stale logical Claude thread locks", async () => {
    const rootDir = await tempRoot();
    const storeRoot = join(rootDir, "thread-store");
    const store = new FileClaudeLogicalThreadStore(storeRoot);
    const threadId = "stale-thread";
    const lockPath = join(
      storeRoot,
      "locks",
      `${hashStringForTest(threadId)}.lock`,
    );

    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({
          storageVersion: "claude-logical-thread-lock-v1",
          lockId: "stale-lock",
          acquiredAt: "2000-01-01T00:00:00.000Z",
          pid: 1,
        })}\n`,
      );

      const state = await store.compareAndSwap({
        threadId,
        expectedGeneration: 0,
        next: {
          threadId,
          cwd: rootDir,
          latestSessionId: "session-a",
          latestBundleId: "bundle-a",
          latestProviderInstanceId: "claude-a",
          latestWorkerId: "worker-a",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      });

      expect(state).toMatchObject({ generation: 1, threadId });
      await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid persisted logical Claude thread state", async () => {
    const rootDir = await tempRoot();
    const storeRoot = join(rootDir, "thread-store");
    const store = new FileClaudeLogicalThreadStore(storeRoot);
    const threadId = "invalid-state-thread";
    const threadPath = join(
      storeRoot,
      "threads",
      `${hashStringForTest(threadId)}.json`,
    );

    try {
      await mkdir(join(storeRoot, "threads"), { recursive: true });
      await writeFile(
        threadPath,
        `${JSON.stringify({
          threadId,
          cwd: "../relative",
          generation: 1,
          updatedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
      );

      await expect(store.read(threadId)).rejects.toThrow(
        "claude_logical_thread_state_invalid",
      );
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
});
