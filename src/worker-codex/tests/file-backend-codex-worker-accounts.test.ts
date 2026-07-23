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
import {
  codexStartupControlPrompt,
  isCodexProviderContentPolicyRejection,
} from "../file-backend-codex-safe-executor";
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
  it("replaces provider-rejected wording with broker guidance", () => {
    const details = {
      rawCause:
        "codex_app_server_error:This content was flagged for possible cybersecurity risk.",
    };
    expect(isCodexProviderContentPolicyRejection(details)).toBe(true);
    const prompt = codexStartupControlPrompt({
      originalPrompt: "Rejected original wording.",
      replaceRejectedPrompt: true,
      controlBatch: {
        target: { jobId: "review-job" },
        deliveryAttemptId: "review-job:attempt-2",
        signals: [],
        signalIds: ["replacement-guidance"],
        message: "Review local application correctness and return a verdict.",
      },
    });
    expect(prompt).toContain(
      "Review local application correctness and return a verdict.",
    );
    expect(prompt).not.toContain("Rejected original wording.");
    expect(prompt).toContain("replacement task wording");
  });

  it("persists and resumes a provider-rejected task with one replacement prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-policy-resume-"));
    const workspacePath = await gitWorkspace("codex-policy-resume-workspace-");
    const clock = {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const jobId = "codex-policy-review-job";
    const taskId = "codex-policy-review-task";
    const originalPrompt = "Rejected original security-review wording.";
    const replacementGuidance =
      "Review the local application correctness invariants and return a verdict.";
    const canonicalWorkspacePath = await realpath(workspacePath);
    await writeFile(
      join(workspacePath, "README.md"),
      "immutable candidate patch\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    const { stdout: admittedPatch } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--binary"],
      { cwd: workspacePath },
    );
    expect(admittedPatch).toContain("immutable candidate patch");
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock,
      idFactory: sequentialIds("codex-policy-control"),
    });
    const rejectedAppServer = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn:
        "codex_app_server_error:This content was flagged for possible cybersecurity risk.",
    });
    const firstExecutor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      controlInbox,
      accounts: [
        {
          codexAuthJson: codexAuthJson("policy-review-account"),
          worker: {
            providerInstanceId: "codex-policy-review-account",
            stateRootDir: rootDir,
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(73),
            appServerProcessFactory: rejectedAppServer.create,
            runner: new StaticRunner({
              exitCode: 1,
              stdout: "",
              stderr:
                "codex_app_server_error:This content was flagged for possible cybersecurity risk.",
            }),
            clock,
          },
        },
      ],
      clock,
    });

    try {
      const failed = await firstExecutor.run({
        jobId,
        taskId,
        prompt: originalPrompt,
        controls: { editMode: "allow-edits" },
      });
      expect(failed.status).toBe("failed");
      if (failed.status !== "failed") throw new Error("expected failed");
      expect(failed.task.taskId).toBe(taskId);
      expect(failed.task.workspacePath).toBe(canonicalWorkspacePath);
      expect(failed.attempts).toHaveLength(1);
      expect(rejectedAppServer.prompts).toEqual([originalPrompt]);

      const { stdout: patchAfterFailure } = await execFileAsync(
        "git",
        ["diff", "HEAD", "--binary"],
        { cwd: workspacePath },
      );
      expect(patchAfterFailure).toBe(admittedPatch);
      await firstExecutor.dispose();

      await controlInbox.enqueueSignal({
        target: { jobId, taskId, workspaceId: workspacePath },
        intent: "guidance",
        body: replacementGuidance,
      });

      const resumedAppServer = new FakeAppServerFactory();
      const resumedExecutor = new FileBackendCodexSafeExecutor({
        stateRootDir: rootDir,
        workspacePath,
        controlInbox,
        accounts: [
          {
            codexAuthJson: codexAuthJson("policy-review-account"),
            worker: {
              providerInstanceId: "codex-policy-review-account",
              stateRootDir: rootDir,
              codexBinaryPath: "codex",
              encryptionKey: new Uint8Array(32).fill(73),
              appServerProcessFactory: resumedAppServer.create,
              runner: new StaticRunner({
                exitCode: 0,
                stdout: "",
                stderr: "",
              }),
              clock,
            },
          },
        ],
        clock,
      });
      try {
        const resumed = await resumedExecutor.run({
          jobId,
          taskId,
          prompt: originalPrompt,
          controls: { editMode: "allow-edits" },
        });
        expect(resumed.status).toBe("completed");
        if (resumed.status !== "completed") {
          throw new Error(`expected completed: ${resumed.status}`);
        }
        expect(resumed.task.taskId).toBe(taskId);
        expect(resumed.task.workspacePath).toBe(canonicalWorkspacePath);
        expect(resumed.attempts).toHaveLength(2);
        const continuationPrompt = resumedAppServer.prompts[0] ?? "";
        expect(continuationPrompt).not.toContain(originalPrompt);
        expect(continuationPrompt.split(replacementGuidance)).toHaveLength(2);
        expect(continuationPrompt).toContain(`Task id: ${taskId}`);

        const { stdout: patchAfter } = await execFileAsync(
          "git",
          ["diff", "HEAD", "--binary"],
          { cwd: workspacePath },
        );
        expect(patchAfter).toBe(admittedPatch);
      } finally {
        await resumedExecutor.dispose();
      }
    } finally {
      await firstExecutor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
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
              stderr: slotIndex === 0 ? "You've hit your usage limit." : "",
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

  it("marks a blocked seeded-auth worker available after the source auth file changes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-auth-reseed-"));
    const authJsonPath = join(rootDir, "auth.json");
    await writeFile(authJsonPath, codexAuthJson("old-account-token"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex-auth-reseed-account",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(42),
      appServerProcessFactory: new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }).create,
      runner: new StaticRunner({
        exitCode: 1,
        stdout: "",
        stderr: "You've hit your usage limit.",
      }),
      capacityPolicy: {
        quotaCooldownMs: 60_000,
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJsonFile(authJsonPath);
      await expect(worker.run({ prompt: "hit quota" })).rejects.toMatchObject({
        code: "subscription_worker_run_failed",
      });
      expect(worker.capacity()).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });

      await writeFile(authJsonPath, codexAuthJson("new-account-token"));

      expect(worker.capacity()).toMatchObject({
        availability: "available",
        reason: "auth_reseed_pending",
      });
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("delivers startup guidance across retries and resumes a completed task only for new guidance", async () => {
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
        throw new Error(
          `expected completed: ${result.reason}:${result.safeMessage}`,
        );
      }
      expect(result.replayed).toBe(false);
      expect(result.task.effectMode).toBe("workspace_patch");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(appServers[0]!.prompts).toHaveLength(1);
      expect(appServers[0]!.prompts[0]).toContain(
        "Original task:\nImplement the safe task.",
      );
      expect(appServers[0]!.prompts[0]).toContain(
        "Preserve current WIP and continue with targeted tests first.",
      );
      const continuationPrompt = appServers[1]!.prompts[0] ?? "";
      const canonicalWorkspacePath = await realpath(workspacePath);
      expect(continuationPrompt).toContain(
        "Continue the same task in the current workspace.",
      );
      expect(continuationPrompt).toContain("Task id: codex-safe-switch-task");
      expect(continuationPrompt).toContain("Attempt: 2");
      expect(continuationPrompt).toContain("Provider: codex");
      expect(continuationPrompt).toContain(
        `Workspace: ${canonicalWorkspacePath}`,
      );
      expect(continuationPrompt).toContain(
        "Previous attempt stopped because: quota_limited",
      );
      expect(continuationPrompt).toContain(
        "Original task:\nImplement the safe task.",
      );
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
        continuationPrompt.split(
          "Preserve current WIP and continue with targeted tests first.",
        ),
      ).toHaveLength(2);
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
      const pauseView = controlViews.find(
        (view) => view.signal.signalId === pauseSignal.signalId,
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

      await controlInbox.enqueueSignal({
        target: {
          jobId: "codex-safe-switch-job",
          taskId: "codex-safe-switch-task",
          workspaceId: workspacePath,
        },
        intent: "guidance",
        body: "Re-open the completed task and add the missing focused assertion.",
      });
      const guidedContinuation = await executor.run({
        jobId: "codex-safe-switch-job",
        taskId: "codex-safe-switch-task",
        prompt: "Implement the safe task.",
        controls: { editMode: "allow-edits" },
      });
      expect(guidedContinuation.status).toBe("completed");
      if (guidedContinuation.status !== "completed") {
        throw new Error("expected guided continuation");
      }
      expect(guidedContinuation.replayed).toBe(false);
      expect(guidedContinuation.attempts).toHaveLength(3);
      expect(appServers[1]!.prompts).toHaveLength(2);
      expect(appServers[1]!.prompts[1]).toContain(
        "Re-open the completed task and add the missing focused assertion.",
      );
      expect(appServers[1]!.prompts[1]).not.toContain(
        "Previous attempt stopped because",
      );
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
        throw new Error(
          `expected completed: ${result.reason}:${result.safeMessage}`,
        );
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
      expect(continuationPrompt).toContain(
        "Runtime control inbox instructions",
      );
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
    const workspacePath = await gitWorkspace(
      "codex-safe-invalid-seed-workspace-",
    );
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const appServers = [new FakeAppServerFactory(), new FakeAppServerFactory()];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson:
          index === 0
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
    const workspacePath = await mkdtemp(
      join(tmpdir(), "codex-safe-not-git-workspace-"),
    );
    await writeFile(
      join(workspacePath, ".git"),
      "gitdir: /nonexistent/gitdir\n",
      "utf8",
    );
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
    const workspacePath = await mkdtemp(
      join(tmpdir(), "codex-safe-duplicate-workspace-"),
    );
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
    const rootDir = await mkdtemp(
      join(tmpdir(), "codex-safe-duplicate-allowed-"),
    );
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
});
