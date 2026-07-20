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
  InMemoryWorkerAccountCapacityStore,
  InterruptAndContinueWorkerUseCase,
  LaunchPlanStatus,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  buildLaunchPlan,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { describe, expect, it } from "vitest";
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

describe("CommandPolicyRunner", () => {
  it("exposes wrapper runner id in capabilities for runtime policy negotiation", () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    expect(runner.runnerId).toBe("node-process:command-policy");
    expect(runner.capabilities.runnerId).toBe(runner.runnerId);
  });

  it("blocks denied commands before the inner runner is invoked", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    await expect(runner.run({
      command: "git",
      args: ["push", "origin", "main"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow("command_policy_denied:denied_git_subcommand");
    expect(inner.lastArgs).toEqual([]);
  });

  it("delegates allowed commands to the inner runner", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "clean", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    await expect(runner.run({
      command: "git",
      args: ["status", "--short"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).resolves.toMatchObject({ exitCode: 0, stdout: "clean" });
    expect(inner.lastArgs).toEqual(["status", "--short"]);
  });

  it("emits a redacted audit event when a command is denied", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const observability = new MemoryWorkerObservability();
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy(), {
      observability,
      providerId: "codex",
      metadata: { workerId: "worker-a" },
    });

    await expect(runner.run({
      command: "git",
      args: ["push", "https://secret-token@example.com/repo.git", "main"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow("command_policy_denied:denied_git_subcommand");

    expect(observability.events).toHaveLength(1);
    expect(observability.events[0]).toMatchObject({
      name: "command_policy.denied",
      providerId: "codex",
      metadata: {
        reason: "denied_git_subcommand",
        executableName: "git",
        runnerId: "node-process",
        workerId: "worker-a",
      },
    });
    expect(JSON.stringify(observability.events)).not.toContain("secret-token");
  });
});

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
      await expect(access(join(rootDir, "codex-session-cache"))).resolves.toBeUndefined();
      expect(appServer.spawnCount).toBe(1);
      const expectedPathEntries = [
        ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ];
      expect(appServer.envs[0]!.PATH!.split(delimiter)).toEqual(
        expect.arrayContaining(expectedPathEntries),
      );
      expect(appServer.prompts).toEqual([]);
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

  it("does not spend a provider turn during default prewarm", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-prewarm-"));
    const appServer = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn: "forced model turn failure",
    });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:default-prewarm",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(8),
      appServerProcessFactory: appServer.create,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
      });
      expect(appServer.prompts).toEqual([]);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly requested spending warmup", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-warmup-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:explicit-warmup",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(9),
      appServerProcessFactory: appServer.create,
      warmupPrompt: "Return explicit warmup proof.",
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
      });
      expect(appServer.prompts).toEqual(["Return explicit warmup proof."]);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("marks invalid seeded Codex auth as disabled capacity without failing executor startup", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-invalid-seed-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:invalid-seed",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(6),
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(JSON.stringify({
        auth_mode: "api-key",
        tokens: {
          access_token: "invalid-access-token",
          refresh_token: "invalid-refresh-token",
        },
      }));

      expect(worker.capacity()).toMatchObject({
        availability: "disabled",
        reason: "provider_session_invalid",
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("replaces an older persisted Codex session with newer explicit auth json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-reseed-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:reseed",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(9),
      clock: {
        now: () => new Date("2026-05-31T00:10:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(
        codexAuthJsonAt("old-refresh-token", "2026-05-31T00:00:00.000Z"),
      );
      const oldQuotaGroup = worker.capacity().details?.quotaGroup;

      await worker.seedCodexAuthJson(
        codexAuthJsonAt("new-refresh-token", "2026-05-31T00:10:00.000Z"),
      );

      expect(worker.capacity().details?.quotaGroup).toBeDefined();
      expect(worker.capacity().details?.quotaGroup).not.toBe(oldQuotaGroup);
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
          controls: { editMode: "allow-edits" },
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

  it("runs coding work through plain Codex exec when selected", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-plain-workspace-"));
    const runner = new StaticRunner({
      exitCode: 0,
      stdout: "plain exec output",
      stderr: "",
    });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:plain-exec",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(13),
      executionEngine: "plain-exec",
      runner,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "skipped",
        details: {
          engine: "plain-exec",
          engineReusable: "false",
        },
      });
      await expect(
        worker.run({
          prompt: "make a coding edit",
          controls: { editMode: "allow-edits" },
        }),
      ).resolves.toMatchObject({
        outputText: "plain exec output",
      });

      expect(runner.lastArgs).toEqual(
        expect.arrayContaining([
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--model",
          "gpt-test",
          "--",
          "-",
        ]),
      );
      expect(runner.lastArgs).not.toContain("--json");
      expect(runner.lastCwd).toBe(callerWorkspace);
      expect(runner.lastStdin).toContain("make a coding edit");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("runs coding work through first-class app-server goal mode when selected", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-goal-workspace-"));
    const appServer = new FakeAppServerFactory();
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:app-server-goal",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(14),
      executionEngine: "app-server-goal",
      appServerProcessFactory: appServer.create,
      clock,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(
        worker.run({
          prompt: "finish the persistent goal",
          controls: { editMode: "allow-edits" },
        }),
      ).resolves.toMatchObject({
        outputText: "OK",
      });

      expect(appServer.goalObjectives).toEqual([
        "finish the persistent goal",
      ]);
      expect(appServer.prompts).toEqual(["finish the persistent goal"]);
      expect(appServer.threadCwds).toContain(callerWorkspace);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("returns waiting input for a blocked Codex goal and resumes it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-managed-goal-"));
    const callerWorkspace = await mkdtemp(
      join(tmpdir(), "codex-managed-goal-workspace-"),
    );
    const appServer = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["blocked", "complete"],
    });
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:managed-goal",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(15),
      executionEngine: "app-server-goal",
      appServerProcessFactory: appServer.create,
      clock,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      const waiting = await worker.run({
        runId: "worker-managed-goal-1",
        prompt: "finish after blocked goal",
        controls: { editMode: "allow-edits" },
      });

      expect(waiting).toMatchObject({
        status: "waiting_for_input",
        runId: "worker-managed-goal-1",
        request: {
          kind: "missing_context",
          audience: "orchestrator",
        },
        resumeHandle: {
          providerInstanceId: "codex:managed-goal",
          workerId: worker.workerId,
          workspacePath: callerWorkspace,
          threadId: "thread-1",
        },
      });
      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected waiting result");
      }

      const resumed = await worker.resumeManagedRun({
        runId: waiting.runId,
        requestId: waiting.request.id,
        answer: "Use the billing workspace.",
        resumeHandle: waiting.resumeHandle,
        controls: { editMode: "allow-edits" },
      });

      expect(resumed).toMatchObject({
        outputText: "OK",
      });
      expect(appServer.prompts).toEqual([
        "finish after blocked goal",
        expect.stringContaining("Use the billing workspace."),
      ]);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("resumes a managed Codex goal in the workspace from its resume handle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-managed-handle-"));
    const firstWorkspace = await mkdtemp(
      join(tmpdir(), "codex-managed-handle-workspace-"),
    );
    const unexpectedWorkspace = await mkdtemp(
      join(tmpdir(), "codex-managed-handle-unexpected-"),
    );
    const refreshWorkspace = await mkdtemp(
      join(tmpdir(), "codex-managed-handle-refresh-"),
    );
    const appServer = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["blocked", "complete"],
    });
    let runTaskWorkspaceCreates = 0;
    const workspace: WorkspacePort = {
      workspaceId: "managed-handle-test-workspace",
      capabilities: {
        workspaceId: "managed-handle-test-workspace",
        supportsTempDir: true,
        supportsExistingCheckout: true,
        supportsContainer: false,
      },
      async create(input) {
        if (input.purpose !== "run-task") {
          return { path: refreshWorkspace };
        }
        runTaskWorkspaceCreates += 1;
        return {
          path: runTaskWorkspaceCreates === 1 ? firstWorkspace : unexpectedWorkspace,
        };
      },
    };
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:managed-handle",
      stateRootDir: rootDir,
      workspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(16),
      executionEngine: "app-server-goal",
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => performance.now(),
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      const waiting = await worker.run({
        runId: "worker-managed-handle-1",
        prompt: "finish in original workspace",
        controls: { editMode: "allow-edits" },
      });

      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected waiting result");
      }
      expect(waiting.resumeHandle.workspacePath).toBe(firstWorkspace);
      expect(waiting.resumeHandle).toMatchObject({
        providerInstanceId: "codex:managed-handle",
        workerId: worker.workerId,
      });

      const resumed = await worker.resumeManagedRun({
        runId: waiting.runId,
        requestId: waiting.request.id,
        answer: "Use the original workspace.",
        resumeHandle: waiting.resumeHandle,
        controls: { editMode: "allow-edits" },
      });

      expect(resumed).toMatchObject({ outputText: "OK" });
      expect(runTaskWorkspaceCreates).toBe(1);
      expect(appServer.threadCwds).toEqual([firstWorkspace]);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(unexpectedWorkspace, { recursive: true, force: true });
      await rm(refreshWorkspace, { recursive: true, force: true });
    }
  });

  it("recovers a waiting managed Codex goal after worker restart", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-managed-recover-"));
    const callerWorkspace = await mkdtemp(
      join(tmpdir(), "codex-managed-recover-workspace-"),
    );
    const firstAppServer = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["blocked"],
    });
    const secondAppServer = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["complete"],
    });
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const firstWorker = new FileBackendCodexWorker({
      providerInstanceId: "codex:managed-recover",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      model: "gpt-test",
      encryptionKey: new Uint8Array(32).fill(17),
      executionEngine: "app-server-goal",
      appServerProcessFactory: firstAppServer.create,
      clock,
    });

    try {
      await firstWorker.start();
      await firstWorker.seedCodexAuthJson(validAuthJson);
      const waiting = await firstWorker.run({
        runId: "worker-managed-recover-1",
        prompt: "finish after worker restart",
        controls: { editMode: "allow-edits" },
      });

      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected waiting result");
      }
      await firstWorker.dispose();

      const secondWorker = new FileBackendCodexWorker({
        providerInstanceId: "codex:managed-recover",
        stateRootDir: rootDir,
        workspacePath: callerWorkspace,
        codexBinaryPath: "codex",
        model: "gpt-test",
        encryptionKey: new Uint8Array(32).fill(17),
        executionEngine: "app-server-goal",
        appServerProcessFactory: secondAppServer.create,
        clock,
      });

      try {
        await secondWorker.start();
        const recovered = await secondWorker.resumeManagedRun({
          runId: waiting.runId,
          requestId: waiting.request.id,
          answer: "Use the recovered billing context.",
          resumeHandle: waiting.resumeHandle,
          controls: { editMode: "allow-edits" },
        });

        expect(recovered).toMatchObject({ outputText: "OK" });
        expect(secondAppServer.prompts[0]).toContain(
          "Continue a previously blocked managed run.",
        );
        expect(secondAppServer.prompts[0]).toContain(
          "finish after worker restart",
        );
        expect(secondAppServer.prompts[0]).toContain(
          "Use the recovered billing context.",
        );
      } finally {
        await secondWorker.dispose();
      }
    } finally {
      await firstWorker.dispose();
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
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  it("isolates cached Codex homes for separate worker instances", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const appServer = new FakeAppServerFactory();
    const workerOptions = {
      providerInstanceId: "codex:shared-account",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(7),
      appServerProcessFactory: appServer.create,
      executionEngine: "app-server" as const,
      sessionCacheSlots: 1,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    };
    const first = new FileBackendCodexWorker({
      ...workerOptions,
      workerId: "codex-slot-1",
    });
    const second = new FileBackendCodexWorker({
      ...workerOptions,
      workerId: "codex-slot-2",
    });

    try {
      await first.start();
      await second.start();
      await first.seedCodexAuthJson(validAuthJson);
      await second.seedCodexAuthJson(validAuthJson);

      await expect(
        Promise.all([
          first.run({ prompt: "first" }),
          second.run({ prompt: "second" }),
        ]),
      ).resolves.toEqual([
        { outputText: "OK", warnings: [] },
        { outputText: "OK", warnings: [] },
      ]);

      expect(new Set(appServer.codexHomes)).toHaveLength(2);
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
});
