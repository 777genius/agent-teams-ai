import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type {
  RunnerPort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  accountCapacityAwareWorkerFactory,
} from "@vioxen/subscription-runtime/worker-core";
import { describe, expect, it } from "vitest";
import { FileBackendCodexSafeExecutor, FileBackendCodexWorker } from "../index";
import { NodeProcessRunner } from "../node-process-runner";

const validAuthJson = codexAuthJson("refresh-token");

describe("FileBackendCodexWorker", () => {
  it("exposes lifecycle, seed, prewarm, health, and dispose", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(7),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await expect(worker.health()).resolves.toMatchObject({
        status: "unhealthy",
      });
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.health()).resolves.toMatchObject({
        status: "healthy",
      });
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
        details: {
          engine: "app-server-pool",
          engineReusable: "true",
        },
      });
      expect(appServer.spawnCount).toBe(1);
      expect(appServer.envs[0]).toMatchObject({ PATH: process.env.PATH });
      expect(appServer.prompts).toEqual(["Return exactly OK."]);
      await worker.dispose();
      await expect(access(join(rootDir, "codex-cache"))).rejects.toThrow();
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has been disposed.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires explicit start before running work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(8),
    });

    try {
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has not been started.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates direct job system prompts before runtime dispatch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(6),
    });

    try {
      await worker.start();
      await expect(
        worker.run({ prompt: "hello", systemPrompt: " " }),
      ).rejects.toThrow("job.systemPrompt must not be empty");
      await expect(
        worker.run({
          prompt: "hello",
          systemPrompt: "x".repeat(256 * 1024 + 1),
        }),
      ).rejects.toThrow("job.systemPrompt exceeds 262144 bytes");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown Codex execution engines", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));

    try {
      expect(() => new FileBackendCodexWorker({
        providerInstanceId: "codex:test",
        stateRootDir: rootDir,
        codexBinaryPath: "codex",
        encryptionKey: new Uint8Array(32).fill(12),
        executionEngine: "unknown" as never,
      })).toThrow("file_backend_codex_execution_engine_invalid");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs coding work through packaged Codex exec when selected", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-exec-workspace-"));
    const appServer = new FakeAppServerFactory();
    const runner = new StaticRunner({
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: "agent_message",
        message: "packaged exec output",
      })}\n`,
      stderr: "",
    });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:packaged-exec",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(11),
      executionEngine: "packaged-exec",
      appServerProcessFactory: appServer.create,
      runner,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
        details: {
          engine: "packaged-json",
          engineReusable: "false",
        },
      });
      await expect(
        worker.run({
          prompt: "make a coding edit",
          controls: { permissionMode: "allow-edits" },
        }),
      ).resolves.toMatchObject({
        outputText: "packaged exec output",
      });

      expect(appServer.spawnCount).toBe(0);
      expect(runner.lastArgs).toEqual(
        expect.arrayContaining([
          "exec",
          "--json",
          "--model",
          "gpt-test",
          "--sandbox",
          "workspace-write",
        ]),
      );
      expect(runner.lastCwd).toBe(callerWorkspace);
      expect(runner.lastStdin).toContain("make a coding edit");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous custom workspace options", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const customWorkspace: WorkspacePort = {
      workspaceId: "custom-test-workspace",
      capabilities: {
        workspaceId: "custom-test-workspace",
        supportsContainer: false,
        supportsExistingCheckout: true,
        supportsTempDir: false,
      },
      async create() {
        return { path: rootDir };
      },
    };

    try {
      expect(() => new FileBackendCodexWorker({
        providerInstanceId: "codex:test",
        stateRootDir: rootDir,
        workspace: customWorkspace,
        workspacePath: join(rootDir, "borrowed"),
        codexBinaryPath: "codex",
        encryptionKey: new Uint8Array(32).fill(3),
      })).toThrow("file_backend_codex_workspace_conflict");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs tasks in a borrowed caller workspace without deleting it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-caller-workspace-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(5),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });
    const canaryPath = join(callerWorkspace, "canary.txt");
    await writeFile(canaryPath, "safe", "utf8");

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.run({ prompt: "hello" })).resolves.toEqual({
        outputText: "OK",
        warnings: [],
      });
      expect(appServer.threadCwds).toContain(callerWorkspace);
      await worker.dispose();
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("keeps prewarm work out of the borrowed caller workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-caller-workspace-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(4),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
      });
      expect(appServer.threadCwds.length).toBeGreaterThan(0);
      expect(appServer.threadCwds).not.toContain(callerWorkspace);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("waits and retries when another slot is refreshing the same provider session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const runner = new RefreshingFakeRunner();
    const appServer = new FakeAppServerFactory();
    const key = new Uint8Array(32).fill(9);
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const first = new FileBackendCodexWorker({
      workerId: "slot-1",
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: key,
      appServerProcessFactory: appServer.create,
      runner,
      clock,
      refreshConflictRetryMaxMs: 2_000,
    });
    const second = new FileBackendCodexWorker({
      workerId: "slot-2",
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: key,
      appServerProcessFactory: appServer.create,
      runner,
      clock,
      refreshConflictRetryMaxMs: 2_000,
    });

    try {
      await first.start();
      await second.start();
      await first.seedCodexAuthJson(
        JSON.stringify({
          ...JSON.parse(validAuthJson),
          tokens: {
            refresh_token: "refresh-token",
            access_token: "access-token",
            expiry: "2026-05-31T00:06:00.000Z",
          },
          last_refresh: "2026-05-30T23:00:00.000Z",
        }),
      );

      await expect(
        Promise.all([
          first.run({ prompt: "first" }),
          second.run({ prompt: "second" }),
        ]),
      ).resolves.toEqual([
        { outputText: "OK", warnings: [] },
        { outputText: "OK", warnings: [] },
      ]);
      expect(runner.runCount).toBe(1);
      expect([...appServer.prompts].sort()).toEqual(["first", "second"]);
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries quota-limited Codex work on a different account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory(),
      new FakeAppServerFactory(),
    ];
    const workers: FileBackendCodexWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      Parameters<FileBackendCodexWorker["run"]>[0],
      Awaited<ReturnType<FileBackendCodexWorker["run"]>>
    >({
      poolId: "codex-quota-account-aware-pool",
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
          const worker = new FileBackendCodexWorker({
            workerId,
            providerInstanceId: `codex-quota-account-${slotIndex + 1}`,
            stateRootDir: rootDir,
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(slotIndex + 10),
            appServerProcessFactory: appServers[slotIndex]!.create,
            runner: new StaticRunner({
              exitCode: slotIndex === 0 ? 1 : 0,
              stdout: slotIndex === 0 ? "" : "OK",
              stderr:
                slotIndex === 0 ? "You've hit your usage limit." : "",
            }),
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
      await workers[0]!.seedCodexAuthJson(codexAuthJson("account-a-token"));
      await workers[1]!.seedCodexAuthJson(codexAuthJson("account-a-token"));
      await workers[2]!.seedCodexAuthJson(codexAuthJson("account-b-token"));

      await expect(pool.run({ prompt: "review" })).resolves.toEqual({
        outputText: "OK",
        warnings: [],
      });

      const accountId = workers[0]!.capacity().details?.quotaGroup;
      expect(accountId).toBeTruthy();
      expect(
        accountCapacityStore.read({ accountId: accountId!, now: clock.now() }),
      ).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
      expect(appServers[0]!.prompts).toEqual(["review"]);
      expect(appServers[1]!.prompts).toEqual([]);
      expect(appServers[2]!.prompts).toEqual(["review"]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-switches safe Codex work to another account with a continuation packet", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-executor-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-workspace-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`safe-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-safe-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 20),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "You've hit your usage limit." : "",
          }),
          capacityPolicy: {
            quotaCooldownMs: 60_000,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-switch-task",
        prompt: "Implement the safe task.",
        controls: { permissionMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.replayed).toBe(false);
      expect(result.task.effectMode).toBe("workspace_patch");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(appServers[0]!.prompts).toEqual(["Implement the safe task."]);
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
      expect(appServers[1]!.prompts[0]).toContain("Do not restart from scratch");
      expect(appServers[0]!.threadCwds).toContain(workspacePath);
      expect(appServers[1]!.threadCwds).toContain(workspacePath);

      const replayed = await executor.run({
        taskId: "codex-safe-switch-task",
        prompt: "Implement the safe task.",
        controls: { permissionMode: "allow-edits" },
      });
      expect(replayed.status).toBe("completed");
      if (replayed.status !== "completed") throw new Error("expected replay");
      expect(replayed.replayed).toBe(true);
      expect(appServers[1]!.prompts).toHaveLength(1);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("stops dirty unknown safe Codex work by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-unknown-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-unknown-workspace-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "transient runtime failure",
        writeFileOnTurn: {
          relativePath: "partial.txt",
          content: "partial\n",
        },
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`unknown-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-unknown-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 60),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "transient runtime failure" : "",
          }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-unknown-task",
        prompt: "Implement the unknown-retry task.",
        controls: { permissionMode: "allow-edits" },
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error(`expected failed: ${result.status}`);
      }
      expect(result.reason).toBe("unknown_error");
      expect(result.safeMessage).toContain("unknown error changed the workspace");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.failureReason).toBe("unknown_error");
      expect(result.attempts[0]?.failureMessage).toBe("Codex runtime failed.");
      expect(appServers[0]!.prompts).toEqual([
        "Implement the unknown-retry task.",
      ]);
      expect(appServers[1]!.prompts).toEqual([]);
      expect(appServers[1]!.threadCwds).toEqual([]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("continues dirty unknown safe Codex work when explicitly allowed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-unknown-opt-in-"));
    const workspacePath = await mkdtemp(
      join(tmpdir(), "codex-safe-unknown-opt-in-workspace-"),
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "transient runtime failure",
        writeFileOnTurn: {
          relativePath: "partial.txt",
          content: "partial\n",
        },
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`unknown-opt-in-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-unknown-opt-in-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 62),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "transient runtime failure" : "",
          }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-unknown-opt-in-task",
        prompt: "Implement the unknown-retry task.",
        controls: { permissionMode: "allow-edits" },
        safeExecutionPolicy: { retryUnknownChangedWorkspace: true },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("unknown_error");
      expect(result.attempts[0]?.failureMessage).toBe("Codex runtime failed.");
      expect(appServers[0]!.prompts).toEqual([
        "Implement the unknown-retry task.",
      ]);
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
      expect(appServers[1]!.prompts[0]).toContain(
        "Previous attempt stopped because: unknown_error",
      );
      expect(appServers[1]!.threadCwds).toContain(workspacePath);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("cycles safe Codex work through accounts for three rounds by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-cycle-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-cycle-workspace-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`cycle-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-cycle-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 30),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: 1,
            stdout: "",
            stderr: "You've hit your usage limit.",
          }),
          capacityPolicy: {
            quotaCooldownMs: 0,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-cycle-default-task",
        prompt: "Implement the safe cyclic task.",
        controls: { permissionMode: "allow-edits" },
      });

      expect(result.status).toBe("partial");
      if (result.status !== "partial") throw new Error("expected partial");
      expect(result.attempts).toHaveLength(6);
      expect(result.reason).toBe("quota_limited");
      expect(result.safeMessage).toBe("Safe execution has no attempts remaining.");
      expect(result.attempts.map((attempt) => attempt.failureReason)).toEqual([
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
      ]);
      expect(appServers[0]!.prompts).toHaveLength(3);
      expect(appServers[1]!.prompts).toHaveLength(3);
      expect(appServers[0]!.prompts[0]).toBe("Implement the safe cyclic task.");
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("allows safe Codex account cycles to be bounded per executor", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-cycle-one-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-cycle-one-workspace-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      maxAccountCycles: 1,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`single-cycle-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-single-cycle-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 40),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: 1,
            stdout: "",
            stderr: "You've hit your usage limit.",
          }),
          capacityPolicy: {
            quotaCooldownMs: 0,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-cycle-one-task",
        prompt: "Implement the one-cycle task.",
        controls: { permissionMode: "allow-edits" },
      });

      expect(result.status).toBe("partial");
      expect(result.attempts).toHaveLength(2);
      expect(appServers[0]!.prompts).toHaveLength(1);
      expect(appServers[1]!.prompts).toHaveLength(1);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("resumes a partial safe Codex goal on another account after executor restart", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-goal-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-goal-workspace-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const firstAccountServer = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn: "You've hit your usage limit.",
    });
    const firstExecutor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      maxAccountCycles: 1,
      accounts: [
        {
          codexAuthJson: codexAuthJson("goal-account-a"),
          worker: {
            providerInstanceId: "codex-goal-account-a",
            stateRootDir: rootDir,
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(31),
            appServerProcessFactory: firstAccountServer.create,
            runner: new StaticRunner({
              exitCode: 1,
              stdout: "",
              stderr: "You've hit your usage limit.",
            }),
            capacityPolicy: {
              quotaCooldownMs: 60_000,
            },
            clock,
          },
        },
      ],
      clock,
    });

    try {
      const first = await firstExecutor.run({
        taskId: "codex-goal-until-done",
        prompt: "Finish the long goal.",
        controls: { permissionMode: "allow-edits" },
      });

      expect(first.status).toBe("partial");
      if (first.status !== "partial") throw new Error("expected partial");
      expect(first.reason).toBe("quota_limited");
      expect(first.attempts).toHaveLength(1);
      expect(firstAccountServer.prompts).toEqual(["Finish the long goal."]);
    } finally {
      await firstExecutor.dispose();
    }

    const secondAccountServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory(),
    ];
    const secondExecutor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: secondAccountServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(
          index === 0 ? "goal-account-a" : "goal-account-b",
        ),
        worker: {
          providerInstanceId: `codex-goal-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 40),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "You've hit your usage limit." : "",
          }),
          capacityPolicy: {
            quotaCooldownMs: 60_000,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const resumed = await secondExecutor.run({
        taskId: "codex-goal-until-done",
        prompt: "Finish the long goal.",
        controls: { permissionMode: "allow-edits" },
      });

      if (resumed.status !== "completed") {
        throw new Error(
          `expected completed after resume: ${resumed.reason}:${resumed.safeMessage}`,
        );
      }
      expect(resumed.replayed).toBe(false);
      expect(resumed.attempts).toHaveLength(2);
      expect(resumed.attempts[0]?.failureReason).toBe("quota_limited");
      expect(secondAccountServers[0]!.prompts).toEqual([]);
      expect(secondAccountServers[1]!.prompts[0]).toContain(
        "Continue the same task",
      );
      expect(secondAccountServers[1]!.prompts[0]).toContain(
        "Previous attempt stopped because: quota_limited",
      );
      expect(secondAccountServers[1]!.threadCwds).toContain(workspacePath);
    } finally {
      await secondExecutor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

type FakeAppServerFactoryOptions = {
  readonly emitTopLevelErrorOnTurn?: string;
  readonly writeFileOnTurn?: {
    readonly relativePath: string;
    readonly content: string;
  };
};

class FakeAppServerFactory {
  spawnCount = 0;
  readonly prompts: string[] = [];
  readonly threadCwds: string[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.envs.push(input.env);
    return new FakeAppServerProcess(
      (prompt) => this.prompts.push(prompt),
      (cwd) => this.threadCwds.push(cwd),
      this.options,
    );
  };
}

class FakeAppServerProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: () => undefined,
  };
  private nextThreadId = 1;
  private nextTurnId = 1;
  private readonly threadCwdsById = new Map<string, string>();

  constructor(
    private readonly onPrompt: (prompt: string) => void,
    private readonly onThreadCwd: (cwd: string) => void,
    private readonly options: FakeAppServerFactoryOptions,
  ) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "initialize") {
        this.respond(request.id, { userAgent: "fake-codex" });
        continue;
      }
      if (request.method === "thread/start") {
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        const cwd = request.params?.cwd;
        if (typeof cwd === "string") {
          this.onThreadCwd(cwd);
          this.threadCwdsById.set(threadId, cwd);
        }
        this.respond(request.id, { thread: { id: threadId } });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.onPrompt(prompt);
        this.respond(request.id, { turn: { id: turnId } });
        setTimeout(() => {
          void this.writeConfiguredTurnFile(request.params).then(() => {
            if (this.options.emitTopLevelErrorOnTurn) {
              this.stdout.emit(
                "data",
                `${JSON.stringify({
                  method: "error",
                  message: this.options.emitTopLevelErrorOnTurn,
                })}\n`,
              );
              return;
            }
            this.notify("item/agentMessage/delta", {
              turnId,
              delta: "OK",
            });
            this.notify("turn/completed", {
              turn: { id: turnId, status: { type: "completed" } },
            });
          });
        }, 1);
        continue;
      }
      this.respond(request.id, {});
    }
  }

  private async writeConfiguredTurnFile(
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const write = this.options.writeFileOnTurn;
    if (!write) return;
    const threadId = params?.threadId;
    if (typeof threadId !== "string") return;
    const cwd = this.threadCwdsById.get(threadId);
    if (!cwd) return;
    await writeFile(join(cwd, write.relativePath), write.content, "utf8");
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class StaticRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {}

  lastArgs: readonly string[] = [];
  lastCwd = "";
  lastStdin = "";

  async run(input: Parameters<RunnerPort["run"]>[0]) {
    this.lastArgs = input.args;
    this.lastCwd = input.cwd;
    this.lastStdin = new TextDecoder().decode(input.stdin);
    return {
      ...this.result,
      durationMs: 1,
    };
  }
}

class RefreshingFakeRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };
  runCount = 0;

  async run(input: Parameters<RunnerPort["run"]>[0]) {
    this.runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const authPath = input.env.REVIEWROUTER_CODEX_AUTH_PATH;
    if (!authPath) {
      throw new Error("missing_auth_path");
    }
    const { readFile, writeFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as {
      tokens: { access_token?: string; expiry?: string };
      last_refresh?: string;
    };
    auth.tokens.access_token = `access-token-refreshed-${this.runCount}`;
    auth.tokens.expiry = "2026-05-31T23:00:00.000Z";
    auth.last_refresh = "2026-05-31T00:05:00.000Z";
    await writeFile(authPath, JSON.stringify(auth), "utf8");
    return { exitCode: 0, stdout: "OK", stderr: "", durationMs: 50 };
  }
}

function codexAuthJson(refreshToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: "access-token",
      expiry: "2026-05-31T23:00:00.000Z",
    },
    last_refresh: "2026-05-31T00:00:00.000Z",
  });
}

function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

describe("NodeProcessRunner", () => {
  it("rejects non-zero process exits with a safe error", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("rejects timed-out work even when the process exits zero after SIGTERM", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("does not spawn work for an already-aborted signal", async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run({
        command: "/path/that/must/not/spawn",
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("node_process_runner_aborted");
  });
});
