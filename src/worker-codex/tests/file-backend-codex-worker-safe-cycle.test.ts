import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execPath } from "node:process";
import { promisify } from "node:util";
import type {
  ObservabilityPort,
  RuntimeEvent,
  RuntimeMetric,
  RunnerPort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  BoundedSubscriptionWorkerPool,
  InMemoryActiveAttemptRegistry,
  InMemoryAttemptJournal,
  InMemoryWorkerAccountCapacityStore,
  InterruptAndContinueWorkerUseCase,
  LaunchPlanStatus,
  SubscriptionWorkerError,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  buildLaunchPlan,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { describe, expect, it, vi } from "vitest";
import {
  CommandPolicyRunner,
  FileBackendCodexSafeExecutor,
  FileBackendCodexWorker,
} from "../index";
import { NodeProcessRunner } from "../node-process-runner";
import {
  FakeAppServerFactory,
  MemoryWorkerObservability,
  RefreshingFakeRunner,
  StaticRunner,
  codexAuthJson,
  codexAuthJsonAt,
  codexAuthJsonForAccount,
  gitWorkspace,
  isolatedWorkspaceCommandPolicy,
  sequentialIds,
  validAuthJson,
  waitUntil,
} from "./file-backend-codex-worker-test-support";

const execFileAsync = promisify(execFile);

describe("CommandPolicyRunner", () => {
  it("surfaces prewarm setup failure before consuming task attempts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-prewarm-"));
    const workspacePath = await gitWorkspace("codex-safe-prewarm-workspace-");
    const appServer = new FakeAppServerFactory();
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      prewarmOnStart: true,
      maxAccountCycles: 5,
      accounts: [{
        codexAuthJson: codexAuthJson("prewarm-account"),
        worker: {
          providerInstanceId: "codex-prewarm-account",
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(91),
          appServerProcessFactory: appServer.create,
        },
      }],
    });
    const failure = new SubscriptionWorkerError(
      "subscription_worker_prewarm_failed",
      "Worker pool failed to prewarm.",
    );
    const start = vi.spyOn(executor, "start").mockRejectedValue(failure);

    try {
      await expect(executor.run({
        taskId: "codex-safe-prewarm-task",
        prompt: "Do not execute this synthetic task.",
        controls: { editMode: "allow-edits" },
      })).rejects.toBe(failure);
      expect(start).toHaveBeenCalledTimes(1);
      expect(appServer.prompts).toEqual([]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("stops dirty unknown safe Codex work by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-unknown-"));
    const workspacePath = await gitWorkspace("codex-safe-unknown-workspace-");
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
        controls: { editMode: "allow-edits" },
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

  it("does not switch accounts for clean unknown Codex output by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-clean-unknown-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-clean-unknown-workspace-",
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "Codex provider output was invalid.",
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`clean-unknown-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-clean-unknown-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 64),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr:
              index === 0 ? "Codex provider output was invalid." : "",
          }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-clean-unknown-task",
        prompt: "Implement the clean unknown task.",
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error(`expected failed: ${result.status}`);
      }
      expect(result.reason).toBe("unknown_error");
      expect(result.safeMessage).toBe("Codex runtime failed.");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.failureReason).toBe("unknown_error");
      expect(appServers[0]!.prompts).toEqual([
        "Implement the clean unknown task.",
      ]);
      expect(appServers[1]!.prompts).toEqual([]);
      expect(appServers[1]!.threadCwds).toEqual([]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("repairs a reconnect-required Codex session once on the same account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-reconnect-repair-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-reconnect-repair-workspace-",
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorsOnTurns: ["login required", "login required", null],
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`reconnect-repair-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-reconnect-repair-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 66),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "login required" : "",
          }),
          capacityPolicy: {
            reconnectCooldownMs: 10,
            maxReconnectRetriesPerAccount: 1,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-reconnect-repair-task",
        prompt: "Implement the reconnect repair task.",
        controls: { editMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("reconnect_required");
      expect(appServers[0]!.prompts).toHaveLength(3);
      expect(appServers[0]!.prompts[0]).toBe(
        "Implement the reconnect repair task.",
      );
      expect(appServers[0]!.prompts[1]).toBe(
        "Implement the reconnect repair task.",
      );
      expect(appServers[0]!.prompts[2]).toContain("Continue the same task");
      expect(appServers[1]!.prompts).toEqual([]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("switches accounts after the reconnect repair budget is exhausted", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-reconnect-switch-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-reconnect-switch-workspace-",
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorsOnTurns: [
          "login required",
          "login required",
          "login required",
          "login required",
        ],
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`reconnect-switch-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-reconnect-switch-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 68),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "login required" : "",
          }),
          capacityPolicy: {
            reconnectCooldownMs: 10,
            maxReconnectRetriesPerAccount: 1,
          },
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-reconnect-switch-task",
        prompt: "Implement the reconnect switch task.",
        controls: { editMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts[0]?.failureReason).toBe("reconnect_required");
      expect(result.attempts[1]?.failureReason).toBe("reconnect_required");
      expect(appServers[0]!.prompts).toHaveLength(4);
      expect(appServers[1]!.prompts).toHaveLength(1);
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("switches accounts for invalid Codex auth without retrying the broken account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-auth-invalid-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-auth-invalid-workspace-",
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn:
          "refresh_token_invalidated: Your refresh token was revoked.",
      }),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`auth-invalid-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-auth-invalid-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 70),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr:
              index === 0
                ? "refresh_token_invalidated: Your refresh token was revoked."
                : "",
          }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-auth-invalid-task",
        prompt: "Implement the auth invalid task.",
        controls: { editMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("account_unavailable");
      expect(appServers[0]!.prompts).toEqual(["Implement the auth invalid task."]);
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs a newly reserved account after a persisted unavailable attempt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-reserved-resume-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-reserved-resume-workspace-",
    );
    const now = new Date("2026-05-31T00:05:00.000Z");
    const clock = { now: () => now, monotonicMs: () => performance.now() };
    await writeFile(join(workspacePath, "input.ts"), "export const input = 1;\n");
    await execFileAsync("git", ["add", "input.ts"], { cwd: workspacePath });
    const stagedPatch = (await execFileAsync(
      "git",
      ["diff", "--cached", "--binary", "--no-ext-diff"],
      { cwd: workspacePath, encoding: "utf8" },
    )).stdout;
    const journal = new InMemoryAttemptJournal();
    await journal.startTask({
      taskId: "reserved-resume-task",
      workspaceRunId: "reserved-resume-workspace",
      workspacePath,
      effectMode: "workspace_patch",
      provider: "codex",
      now,
    });
    await journal.appendAttempt({
      taskId: "reserved-resume-task",
      attempt: {
        taskId: "reserved-resume-task",
        attemptNumber: 1,
        accountId: "account-c",
        provider: "codex",
        startedAt: now,
        finishedAt: now,
        status: "blocked",
        failureReason: "account_unavailable",
        workspaceDirtyBefore: true,
        workspaceDirtyAfter: true,
        changedFiles: [],
      },
      now,
    });
    await journal.markPartial({
      taskId: "reserved-resume-task",
      status: "waiting_capacity",
      reason: "account_unavailable",
      now,
    });

    const reservedAccount = new FakeAppServerFactory();
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      journal,
      maxAccountCycles: 2,
      accounts: [{
        codexAuthJson: codexAuthJson("reserved-account-g"),
        worker: {
          providerInstanceId: "reserved-account-g",
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(81),
          appServerProcessFactory: reservedAccount.create,
          clock,
        },
      }],
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "reserved-resume-task",
        prompt: "Review the admitted patch.",
        controls: { editMode: "allow-edits" },
      });
      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}`);
      }
      expect(result.replayed).toBe(false);
      expect(result.attempts).toHaveLength(2);
      expect(reservedAccount.prompts).toHaveLength(1);
      expect(reservedAccount.prompts[0]).toContain("Continue the same task");
      expect((await execFileAsync(
        "git",
        ["diff", "--cached", "--binary", "--no-ext-diff"],
        { cwd: workspacePath, encoding: "utf8" },
      )).stdout).toBe(stagedPatch);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("continues dirty unknown safe Codex work when explicitly allowed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-unknown-opt-in-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-unknown-opt-in-workspace-",
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
        controls: { editMode: "allow-edits" },
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
    const workspacePath = await gitWorkspace("codex-safe-cycle-workspace-");
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
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("waiting_capacity");
      if (result.status !== "waiting_capacity") {
        throw new Error("expected waiting capacity");
      }
      expect(result.attempts).toHaveLength(10);
      expect(result.reason).toBe("quota_limited");
      expect(result.safeMessage).toBe("Safe execution has no attempts remaining.");
      expect(result.attempts.map((attempt) => attempt.failureReason)).toEqual([
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
        "quota_limited",
      ]);
      expect(appServers[0]!.prompts).toHaveLength(5);
      expect(appServers[1]!.prompts).toHaveLength(5);
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
    const workspacePath = await gitWorkspace("codex-safe-cycle-one-workspace-");
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
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("waiting_capacity");
      expect(result.attempts).toHaveLength(2);
      expect(appServers[0]!.prompts).toHaveLength(1);
      expect(appServers[1]!.prompts).toHaveLength(1);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("continues a native Codex goal on the next account after a usage limit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-live-goal-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-live-goal-workspace-",
    );
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
      maxAccountCycles: 1,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`live-goal-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-live-goal-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 50),
          executionEngine: "app-server-goal",
          serviceTier: "fast",
          reasoningEffort: "xhigh",
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: index === 0 ? 1 : 0,
            stdout: "",
            stderr: index === 0 ? "You've hit your usage limit." : "",
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
        taskId: "codex-live-goal-until-done",
        prompt: "Finish the native goal.",
        controls: { editMode: "allow-edits" },
        metadata: {
          codexGoalObjective: "Finish the native goal objective.",
        },
      });

      if (result.status !== "completed") {
        throw new Error(
          `expected completed after live handoff: ${result.reason}:${result.safeMessage}`,
        );
      }
      expect(result.replayed).toBe(false);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(appServers[0]!.prompts).toEqual(["Finish the native goal."]);
      expect(appServers[1]!.prompts[0]).toContain("Continue the same task");
      expect(appServers[1]!.prompts[0]).toContain(
        "Previous attempt stopped because: quota_limited",
      );
      expect(appServers[1]!.goalObjectives).toEqual([
        "Finish the native goal objective.",
      ]);
      expect(appServers[1]!.threadCwds).toContain(workspacePath);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("resumes a parked safe Codex goal on another account after executor restart", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-goal-"));
    const workspacePath = await gitWorkspace("codex-safe-goal-workspace-");
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
        controls: { editMode: "allow-edits" },
      });

      expect(first.status).toBe("waiting_capacity");
      if (first.status !== "waiting_capacity") {
        throw new Error("expected waiting capacity");
      }
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
        controls: { editMode: "allow-edits" },
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
