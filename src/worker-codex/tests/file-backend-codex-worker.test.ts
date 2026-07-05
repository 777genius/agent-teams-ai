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

const validAuthJson = codexAuthJson("refresh-token");
const execFileAsync = promisify(execFile);

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
    const workspacePath = await gitWorkspace("codex-safe-workspace-");
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
        writeFileOnTurn: {
          relativePath: "wip.txt",
          content: "partial implementation\n",
        },
      }),
      new FakeAppServerFactory(),
    ];
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock,
      idFactory: sequentialIds("codex-control"),
    });
    await controlInbox.enqueueSignal({
      target: { jobId: "codex-safe-switch-job" },
      intent: "guidance",
      body: "Preserve current WIP and continue with targeted tests first.",
    });
    const pauseSignal = await controlInbox.enqueueSignal({
      target: { jobId: "codex-safe-switch-job" },
      intent: "pause_requested",
      deliveryMode: "pause_then_continue",
      body: "Pause before continuation unless the provider explicitly supports it.",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      controlInbox,
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
        jobId: "codex-safe-switch-job",
        taskId: "codex-safe-switch-task",
        prompt: "Implement the safe task.",
        controls: { editMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.replayed).toBe(false);
      expect(result.task.effectMode).toBe("workspace_patch");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(appServers[0]!.prompts).toEqual(["Implement the safe task."]);
      const continuationPrompt = appServers[1]!.prompts[0] ?? "";
      const canonicalWorkspacePath = await realpath(workspacePath);
      expect(continuationPrompt).toContain(
        "Continue the same task in the current workspace.",
      );
      expect(continuationPrompt).toContain("Task id: codex-safe-switch-task");
      expect(continuationPrompt).toContain("Attempt: 2");
      expect(continuationPrompt).toContain("Provider: codex");
      expect(continuationPrompt).toContain(`Workspace: ${canonicalWorkspacePath}`);
      expect(continuationPrompt).toContain(
        "Previous attempt stopped because: quota_limited",
      );
      expect(continuationPrompt).toContain("Original task:\nImplement the safe task.");
      expect(continuationPrompt).toContain("Current workspace summary:");
      expect(continuationPrompt).toContain("Git workspace has");
      expect(continuationPrompt).toContain("Changed files:\n- wip.txt");
      expect(continuationPrompt).toContain(
        "Runtime control inbox instructions:",
      );
      expect(continuationPrompt).toContain("Signal id: codex-control-1");
      expect(continuationPrompt).toContain(
        "Preserve current WIP and continue with targeted tests first.",
      );
      expect(
        continuationPrompt.includes(
          "Pause before continuation unless the provider explicitly supports it.",
        ),
      ).toBe(false);
      expect(continuationPrompt).toContain("Do not restart from scratch");
      expect(continuationPrompt.includes("access_token")).toBe(false);
      expect(continuationPrompt.includes("refresh_token")).toBe(false);
      expect(continuationPrompt.includes("codexAuthJson")).toBe(false);
      expect(appServers[0]!.threadCwds).toContain(workspacePath);
      expect(appServers[1]!.threadCwds).toContain(workspacePath);
      const controlViews = await controlInbox.listSignals({
        target: { jobId: "codex-safe-switch-job" },
        includeExpired: true,
      });
      const pauseView = controlViews.find((view) =>
        view.signal.signalId === pauseSignal.signalId
      );
      expect(pauseView).toMatchObject({
        state: "pending",
        blockedReason: "pause_then_continue_not_supported",
      });

      const replayed = await executor.run({
        jobId: "codex-safe-switch-job",
        taskId: "codex-safe-switch-task",
        prompt: "Implement the safe task.",
        controls: { editMode: "allow-edits" },
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

  it("interrupts an active Codex app-server goal and resumes with guidance through safe continuation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-interrupt-"));
    const workspacePath = await gitWorkspace("codex-safe-interrupt-workspace-");
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory({
        holdTurnOpen: true,
        writeFileOnTurn: {
          relativePath: "wip.txt",
          content: "partial implementation\n",
        },
      }),
      new FakeAppServerFactory(),
    ];
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock,
      idFactory: sequentialIds("codex-interrupt-control"),
    });
    const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
    const guidance = new InterruptAndContinueWorkerUseCase({
      control: controlInbox,
      activeAttemptRegistry,
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      controlInbox,
      activeAttemptRegistry,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`interrupt-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-interrupt-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 40),
          executionEngine: "app-server-goal",
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({
            exitCode: 0,
            stdout: "",
            stderr: "",
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
      const resultPromise = executor.run({
        jobId: "codex-safe-interrupt-job",
        taskId: "codex-safe-interrupt-task",
        prompt: "Implement the interruptible safe task.",
        controls: { editMode: "allow-edits" },
        maxAccountCycles: 1,
      });

      await waitUntil(async () => {
        if (appServers[0]!.prompts.length === 0) return false;
        await access(join(workspacePath, "wip.txt"));
        return true;
      });

      const interrupt = await guidance.execute({
        target: {
          jobId: "codex-safe-interrupt-job",
          taskId: "codex-safe-interrupt-task",
          workspaceId: workspacePath,
        },
        message: "Stop the broad run and inspect the targeted recall slice.",
        caller: { kind: "orchestrator", id: "lead-agent" },
      });
      expect(interrupt.status).toBe("interrupted");

      const result = await resultPromise;
      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("runtime_interrupted");
      expect(result.attempts[0]?.workspaceDirtyAfter).toBe(true);
      expect(appServers[0]!.prompts).toEqual([
        "Implement the interruptible safe task.",
      ]);
      const continuationPrompt = appServers[1]!.prompts[0] ?? "";
      expect(continuationPrompt).toContain("Continue the same task");
      expect(continuationPrompt).toContain(
        "Previous attempt stopped because: runtime_interrupted",
      );
      expect(continuationPrompt).toContain("Runtime control inbox instructions");
      expect(continuationPrompt).toContain("targeted recall slice");
      expect(continuationPrompt).toContain("Changed files:\n- wip.txt");
      expect(continuationPrompt.includes("access_token")).toBe(false);
      expect(continuationPrompt.includes("refresh_token")).toBe(false);
      const controlViews = await controlInbox.listSignals({
        target: {
          jobId: "codex-safe-interrupt-job",
          taskId: "codex-safe-interrupt-task",
          workspaceId: workspacePath,
        },
        includeExpired: true,
      });
      expect(controlViews[0]?.state).toBe("delivered");
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("skips invalid seeded Codex accounts and runs safe work on the next slot", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-invalid-seed-"));
    const workspacePath = await gitWorkspace("codex-safe-invalid-seed-workspace-");
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [
      new FakeAppServerFactory(),
      new FakeAppServerFactory(),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: index === 0
          ? JSON.stringify({
              auth_mode: "api-key",
              tokens: {
                access_token: "invalid-access-token",
                refresh_token: "invalid-refresh-token",
              },
            })
          : codexAuthJson("valid-second-account"),
        worker: {
          providerInstanceId: `codex-invalid-seed-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 22),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 0, stdout: "OK", stderr: "" }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-invalid-seed-task",
        prompt: "Implement the safe task.",
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("completed");
      expect(appServers[0]!.prompts).toEqual([]);
      expect(appServers[1]!.prompts).toEqual(["Implement the safe task."]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("fails safe Codex work before starting accounts when the workspace is not git", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-not-git-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-not-git-workspace-"));
    await writeFile(join(workspacePath, ".git"), "gitdir: /nonexistent/gitdir\n", "utf8");
    const appServer = new FakeAppServerFactory();
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: [
        {
          codexAuthJson: codexAuthJson("not-git-account"),
          worker: {
            providerInstanceId: "codex-not-git-account",
            stateRootDir: rootDir,
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(71),
            appServerProcessFactory: appServer.create,
            runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
          },
        },
      ],
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-not-git-task",
        prompt: "This should not start.",
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("expected failed");
      expect(result.reason).toBe("unknown_error");
      expect(result.safeMessage).toBe(
        "Safe execution requires a git worktree workspace.",
      );
      expect(result.attempts).toHaveLength(0);
      expect(result.failureDetails).toMatchObject({
        safeExecutionCode: "safe_execution_workspace_not_git",
        workspacePath: await realpath(workspacePath),
      });
      expect(appServer.spawnCount).toBe(0);
      expect(appServer.prompts).toEqual([]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects duplicate Codex account identities before starting safe work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-duplicate-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-safe-duplicate-workspace-"));
    const appServers = [new FakeAppServerFactory(), new FakeAppServerFactory()];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJsonForAccount(
          `duplicate-refresh-${index + 1}`,
          "acct-duplicate",
        ),
        worker: {
          providerInstanceId: `codex-duplicate-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 67),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
        },
      })),
    });

    try {
      await expect(executor.start()).rejects.toMatchObject({
        code: "subscription_worker_start_failed",
        details: {
          code: "file_backend_codex_duplicate_account_identity",
          accounts: "codex-duplicate-account-1,codex-duplicate-account-2",
          identitySource: "id_token_account_id",
        },
      });
      expect(appServers[0]!.spawnCount).toBe(0);
      expect(appServers[1]!.spawnCount).toBe(0);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("allows duplicate Codex account identities only when explicitly enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-duplicate-allowed-"));
    const workspacePath = await mkdtemp(
      join(tmpdir(), "codex-safe-duplicate-allowed-workspace-"),
    );
    const appServers = [new FakeAppServerFactory(), new FakeAppServerFactory()];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      allowDuplicateAccountIdentities: true,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJsonForAccount(
          `allowed-duplicate-refresh-${index + 1}`,
          "acct-duplicate-allowed",
        ),
        worker: {
          providerInstanceId: `codex-duplicate-allowed-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 69),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
        },
      })),
    });

    try {
      await expect(executor.start()).resolves.toBeUndefined();
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

      expect(result.status).toBe("partial");
      if (result.status !== "partial") throw new Error("expected partial");
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

  it("resumes a partial safe Codex goal on another account after executor restart", async () => {
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

type FakeAppServerFactoryOptions = {
  readonly emitTopLevelErrorOnTurn?: string;
  readonly emitTopLevelErrorsOnTurns?: readonly (string | null)[];
  readonly goalStatusesAfterTurns?: readonly string[];
  readonly holdTurnOpen?: boolean;
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
  readonly goalObjectives: string[] = [];
  private emittedTurnErrors = 0;

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.envs.push(input.env);
    return new FakeAppServerProcess(
      (prompt) => this.prompts.push(prompt),
      (cwd) => this.threadCwds.push(cwd),
      (objective) => this.goalObjectives.push(objective),
      () => this.configuredTurnError(),
      this.options,
    );
  };

  private configuredTurnError(): string | null {
    const sequence = this.options.emitTopLevelErrorsOnTurns;
    if (sequence) {
      const value = sequence[this.emittedTurnErrors];
      this.emittedTurnErrors += 1;
      return value ?? null;
    }
    return this.options.emitTopLevelErrorOnTurn ?? null;
  }
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
  private completedTurnCount = 0;
  private readonly threadCwdsById = new Map<string, string>();
  private readonly goals = new Map<
    string,
    { objective: string; status: string }
  >();

  constructor(
    private readonly onPrompt: (prompt: string) => void,
    private readonly onThreadCwd: (cwd: string) => void,
    private readonly onGoalObjective: (objective: string) => void,
    private readonly nextTurnError: () => string | null,
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
      if (request.method === "thread/goal/set") {
        const threadId = String(request.params?.threadId ?? "");
        const objective = String(request.params?.objective ?? "");
        const status = String(request.params?.status ?? "active");
        this.goals.set(threadId, { objective, status });
        this.onGoalObjective(objective);
        this.respond(request.id, {
          goal: {
            threadId,
            objective,
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        });
        continue;
      }
      if (request.method === "thread/goal/get") {
        const threadId = String(request.params?.threadId ?? "");
        const goal = this.goals.get(threadId);
        this.respond(request.id, {
          goal: goal
            ? {
                threadId,
                objective: goal.objective,
                status: goal.status,
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 0,
                updatedAt: 0,
              }
            : null,
        });
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
            if (this.options.holdTurnOpen) {
              this.notify("turn/started", {
                threadId: String(request.params?.threadId ?? ""),
                turn: { id: turnId, status: "inProgress" },
              });
              return;
            }
            const errorMessage = this.nextTurnError();
            if (errorMessage) {
              this.stdout.emit(
                "data",
                `${JSON.stringify({
                  method: "error",
                  message: errorMessage,
                })}\n`,
              );
              return;
            }
            this.markGoalAfterCompletedTurn(
              String(request.params?.threadId ?? ""),
            );
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

  private markGoalAfterCompletedTurn(threadId: string): void {
    const goal = this.goals.get(threadId);
    if (!goal) return;
    const nextStatus =
      this.options.goalStatusesAfterTurns?.[this.completedTurnCount] ??
      "complete";
    this.completedTurnCount += 1;
    this.goals.set(threadId, { ...goal, status: nextStatus });
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

class MemoryWorkerObservability implements ObservabilityPort {
  readonly events: RuntimeEvent[] = [];
  readonly metrics: Array<{ readonly metric: RuntimeMetric; readonly value?: number }> = [];
  readonly timings: Array<{ readonly metric: RuntimeMetric; readonly durationMs: number }> = [];

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }

  count(metric: RuntimeMetric, value?: number): void {
    this.metrics.push({ metric, ...(value === undefined ? {} : { value }) });
  }

  timing(metric: RuntimeMetric, durationMs: number): void {
    this.timings.push({ metric, durationMs });
  }
}

function isolatedWorkspaceCommandPolicy() {
  const plan = buildLaunchPlan({
    boundary: AccessBoundary.IsolatedWorkspaceWrite,
    scope: {
      projectId: "project",
      readRoots: ["/tmp/project"],
      isolatedWorkspaceRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      worktreeRoots: ["/tmp/project-worktrees"],
      registryRoot: "/tmp/worker-jobs",
      allowedBranches: ["main"],
      jobIdPrefixes: ["project-"],
    },
    adapter: {
      canEnforceFilesystemPolicy: true,
      canIsolateHome: true,
      canIsolateTemp: true,
      canDisableRawShell: true,
      canBrokerProjectControl: true,
      canRestrictNetwork: true,
    },
  });
  if (plan.status !== LaunchPlanStatus.Ready) {
    throw new Error("test_command_policy_launch_plan_blocked");
  }
  return plan.commandPolicy;
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
  return codexAuthJsonAt(refreshToken, "2026-05-31T00:00:00.000Z");
}

function codexAuthJsonForAccount(
  refreshToken: string,
  accountId: string,
): string {
  const auth = JSON.parse(codexAuthJson(refreshToken)) as {
    tokens: { id_token?: string };
  };
  auth.tokens.id_token = fakeJwt({
    "https://api.openai.com/auth.chatgpt_account_id": accountId,
  });
  return JSON.stringify(auth);
}

function codexAuthJsonAt(refreshToken: string, lastRefresh: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: "access-token",
      expiry: "2026-05-31T23:00:00.000Z",
    },
    last_refresh: lastRefresh,
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

async function gitWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Subscription Runtime Tests",
      "-c",
      "user.email=tests@example.com",
      "commit",
      "-m",
      "Initial commit",
    ],
    { cwd: workspacePath },
  );
  return workspacePath;
}

function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("wait_until_timeout");
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

  it("terminates a process when stdin stream writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "require('node:fs').closeSync(0);",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/EPIPE|broken pipe/i);
  });

  it("keeps non-zero process output when stdin also breaks", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7);"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("keeps timeout classification when shutdown also breaks stdin", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => {",
            "  try { require('node:fs').closeSync(0); } catch {}",
            "  setTimeout(() => process.exit(0), 20);",
            "});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("terminates a process when stdout sink writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stdout.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdout: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stdout:sink exploded",
    );
  });

  it("keeps output sink classification when abort fires during shutdown", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });
    const controller = new AbortController();

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stdout.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdout: {
          write: () => {
            queueMicrotask(() => controller.abort());
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stdout:sink exploded",
    );
  });

  it("terminates a process when stderr sink writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stderr.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stderr: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stderr:sink exploded",
    );
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
