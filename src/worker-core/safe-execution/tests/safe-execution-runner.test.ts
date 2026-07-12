import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../../../worker-local/safe-execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedSubscriptionWorkerPool,
  InMemoryActiveAttemptRegistry,
  InMemoryAttemptJournal,
  InMemoryWorkspaceLockStore,
  InterruptAndContinueWorkerUseCase,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  WorkerControlService,
  defaultSafeExecutionErrorClassifier,
  type WorkspaceSnapshot,
} from "../../index";
import {
  cleanupTemporaryPaths,
  deferred,
  execFileAsync,
  FakePromptWorker,
  gitWorkspace,
  InMemoryWorkerControlInboxStore,
  sequentialIds,
  type PromptJob,
  type PromptResult,
} from "./safe-execution-test-support";

describe("SafeExecutionRunner", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await cleanupTemporaryPaths(cleanupPaths);
  });

  it("continues dirty quota-limited work on another account in the same locked workspace", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-quota-",
    );
    const workers: FakePromptWorker[] = [];
    const slotRuns: string[] = [];
    const pool = new BoundedSubscriptionWorkerPool<PromptJob, PromptResult>({
      poolId: "safe-execution-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FakePromptWorker(workerId, async (job, self) => {
          slotRuns.push(self.workerId);
          if (slotIndex === 0) {
            await writeFile(
              join(job.workspacePath, "feature.txt"),
              "partial\n",
            );
            self.capacitySnapshot = {
              availability: "cooldown",
              reason: "quota_limited",
              cooldownUntil: new Date(Date.now() + 60_000),
              details: { accountId: "account-a" },
            };
            throw new SubscriptionWorkerError(
              "subscription_worker_run_failed",
              "Quota limited.",
              { details: { reason: "quota_limited", accountId: "account-a" } },
            );
          }
          expect(job.prompt).toContain("Continue the same task");
          expect(job.prompt).toContain("Do not restart from scratch");
          expect(
            await readFile(join(job.workspacePath, "feature.txt"), "utf8"),
          ).toBe("partial\n");
          await writeFile(join(job.workspacePath, "feature.txt"), "done\n");
          return { output: "completed on account-b" };
        });
        worker.capacitySnapshot = {
          availability: "available",
          details: { accountId: slotIndex === 0 ? "account-a" : "account-b" },
        };
        workers.push(worker);
        return worker;
      },
    });
    await pool.start();

    const journal = new InMemoryAttemptJournal();
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });

    const result = await runner.run({
      taskId: "task-quota",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "Implement feature.", workspacePath },
      originalPrompt: "Implement feature.",
      policy: { maxAttempts: 2 },
      summarizeResult: (value) => value.output,
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.replayed).toBe(false);
    expect(slotRuns).toEqual([
      "safe-execution-pool:slot-1",
      "safe-execution-pool:slot-2",
    ]);
    expect(await readFile(join(workspacePath, "feature.txt"), "utf8")).toBe(
      "done\n",
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.failureReason).toBe("quota_limited");
    expect(result.attempts[0]?.workerId).toBe("safe-execution-pool:slot-1");
    expect(result.attempts[0]?.accountId).toBe("account-a");
    expect(result.attempts[1]?.status).toBe("completed");
    expect(workers[0]?.capacity().availability).toBe("cooldown");

    await pool.dispose();
  }, 15_000);

  it("injects worker control inbox guidance into continuation prompts", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-control-",
    );
    let runs = 0;
    let consumed = 0;
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        if (runs === 1) {
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        }
        expect(job.prompt).toContain("Runtime control inbox instructions");
        expect(job.prompt).toContain("Focus on temporal normalization first.");
        return { output: "done with guidance" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      controlInbox: {
        async consumeForContinuation(input) {
          consumed += 1;
          return {
            target: input.target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: [],
            signalIds: ["signal-guidance"],
            message:
              "Runtime control inbox instructions:\nFocus on temporal normalization first.",
          };
        },
      },
    });

    const result = await runner.run({
      taskId: "task-control",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "Improve benchmark.", workspacePath },
      originalPrompt: "Improve benchmark.",
      controlTarget: {
        jobId: "job-control",
        taskId: "task-control",
        workspaceId: workspacePath,
      },
      policy: { maxAttempts: 2 },
    });

    expect(result.status).toBe("completed");
    expect(consumed).toBe(1);
  });

  it("continues dirty runtime-interrupted work with queued urgent guidance", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-interrupt-",
    );
    const store = new InMemoryWorkerControlInboxStore();
    const control = new WorkerControlService({
      store,
      idFactory: sequentialIds("runtime-interrupt"),
    });
    const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
    const useCase = new InterruptAndContinueWorkerUseCase({
      control,
      activeAttemptRegistry,
    });
    const target = {
      jobId: "job-runtime-interrupt",
      taskId: "task-runtime-interrupt",
      workspaceId: workspacePath,
    };
    let runs = 0;
    const pool = {
      async run(
        job: PromptJob,
        options?: { readonly abortSignal?: AbortSignal },
      ): Promise<PromptResult> {
        runs += 1;
        if (runs === 1) {
          await writeFile(join(job.workspacePath, "feature.txt"), "partial\n");
          const interrupt = await useCase.execute({
            target,
            message:
              "Stop the broad run and inspect the targeted recall slice.",
            caller: { kind: "orchestrator", id: "lead-agent" },
          });
          expect(interrupt.status).toBe("interrupted");
          expect(options?.abortSignal?.aborted).toBe(true);
          throw new Error("provider observed runtime abort");
        }
        expect(job.prompt).toContain(
          "Previous attempt stopped because: runtime_interrupted",
        );
        expect(job.prompt).toContain("Runtime control inbox instructions");
        expect(job.prompt).toContain("targeted recall slice");
        expect(job.prompt).toContain("Changed files:\n- feature.txt");
        expect(
          await readFile(join(job.workspacePath, "feature.txt"), "utf8"),
        ).toBe("partial\n");
        await writeFile(join(job.workspacePath, "feature.txt"), "done\n");
        return { output: "continued after interrupt" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      controlInbox: control,
      activeAttemptRegistry,
    });

    const result = await runner.run({
      taskId: "task-runtime-interrupt",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "Improve benchmark.", workspacePath },
      originalPrompt: "Improve benchmark.",
      controlTarget: target,
      policy: { maxAttempts: 2 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(runs).toBe(2);
    expect(result.attempts[0]?.failureReason).toBe("runtime_interrupted");
    expect(result.attempts[0]?.workspaceDirtyAfter).toBe(true);
    expect(await readFile(join(workspacePath, "feature.txt"), "utf8")).toBe(
      "done\n",
    );
    const signals = await control.listSignals({ target, includeExpired: true });
    expect(signals[0]?.state).toBe("delivered");
  });

  it("continues dirty work after a goal slice exhausts max turns", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-goal-slice-",
    );
    let runs = 0;
    const prompts: string[] = [];
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        prompts.push(job.prompt);
        if (runs === 1) {
          await writeFile(join(job.workspacePath, "slice.txt"), "partial\n");
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Codex app-server goal slice exhausted.",
            {
              details: {
                reason: "goal_slice_exhausted",
                rawCause: "codex_app_server_goal_max_turns_exceeded:20",
              },
            },
          );
        }
        expect(job.prompt).toContain("Continue the same task");
        expect(job.prompt).toContain(
          "Previous attempt stopped because: goal_slice_exhausted",
        );
        expect(job.prompt).toContain("Previous output summary:");
        expect(job.prompt).toContain("Wrote slice.txt before the turn limit.");
        expect(job.prompt).toContain("Changed files:\n- slice.txt");
        expect(
          await readFile(join(job.workspacePath, "slice.txt"), "utf8"),
        ).toBe("partial\n");
        await writeFile(join(job.workspacePath, "slice.txt"), "done\n");
        return { output: "completed after next goal slice" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
      taskId: "task-goal-slice",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "Finish the long goal.", workspacePath },
      originalPrompt: "Finish the long goal.",
      policy: {
        maxAttempts: 2,
        retryUnknownChangedWorkspace: false,
        retryUnknownCleanWorkspace: false,
      },
      summarizeErrorOutput: () => "Wrote slice.txt before the turn limit.",
      summarizeResult: (value) => value.output,
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(runs).toBe(2);
    expect(prompts[0]).toBe("Finish the long goal.");
    expect(prompts[1]).toContain("Continue the same task");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.failureReason).toBe("goal_slice_exhausted");
    expect(result.attempts[0]?.failureMessage).toBe(
      "Codex app-server goal slice exhausted.",
    );
    expect(result.attempts[0]?.workspaceDirtyAfter).toBe(true);
    expect(result.attempts[1]?.status).toBe("completed");
    expect(await readFile(join(workspacePath, "slice.txt"), "utf8")).toBe(
      "done\n",
    );
  });

  it("does not consume control inbox guidance for reconnect repair continuations", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-control-reconnect-",
    );
    let runs = 0;
    let consumed = 0;
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        if (runs === 1) {
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Provider session needs reconnect.",
            { details: { reason: "needs_reconnect" } },
          );
        }
        expect(job.prompt.includes("Runtime control inbox instructions")).toBe(
          false,
        );
        return { output: "done after reconnect repair" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      controlInbox: {
        async consumeForContinuation(input) {
          consumed += 1;
          if (consumed === 1) {
            return {
              target: input.target,
              deliveryAttemptId: input.deliveryAttemptId,
              signals: [],
              signalIds: [],
            };
          }
          return {
            target: input.target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: [],
            signalIds: ["signal-guidance"],
            message:
              "Runtime control inbox instructions:\nThis should not be consumed.",
          };
        },
      },
    });

    const result = await runner.run({
      taskId: "task-control-reconnect",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "Repair account.", workspacePath },
      originalPrompt: "Repair account.",
      controlContinuationJobFactory: ({
        job,
        originalPrompt,
        controlBatch,
      }) => ({
        job: {
          ...job,
          prompt: `${originalPrompt}\n${controlBatch.message ?? ""}`,
        },
        originalPrompt: `${originalPrompt}\n${controlBatch.message ?? ""}`,
      }),
      controlTarget: {
        jobId: "job-control-reconnect",
        taskId: "task-control-reconnect",
        workspaceId: workspacePath,
      },
      policy: { maxAttempts: 2 },
    });

    expect(result.status).toBe("completed");
    expect(consumed).toBe(1);
  });

  it("rejects concurrent tasks for the same existing workspace lock", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-lock-",
    );
    const gate = deferred<void>();
    const entered = deferred<void>();
    const pool = {
      async run(): Promise<PromptResult> {
        entered.resolve();
        await gate.promise;
        return { output: "done" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const first = runner.run({
      taskId: "task-lock-1",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "first", workspacePath },
      originalPrompt: "first",
      policy: { maxAttempts: 1 },
    });
    await entered.promise;

    await expect(
      runner.run({
        taskId: "task-lock-2",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool,
        job: { prompt: "second", workspacePath },
        originalPrompt: "second",
        policy: { maxAttempts: 1 },
      }),
    ).rejects.toMatchObject({
      code: "safe_execution_workspace_locked",
    });

    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("replaces a workspace lock owned by a dead process without requiring staleLockMs", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-dead-lock-",
    );
    const lockStore = new InMemoryWorkspaceLockStore();
    const deadOwner = await lockStore.acquire({
      taskId: "task-dead-lock-owner",
      workspacePath,
      ownerId: "dead-owner",
      ownerPid: 9_999_999,
    });

    const replacement = await lockStore.acquire({
      taskId: "task-dead-lock-replacement",
      workspacePath,
      ownerId: "replacement-owner",
      ownerPid: process.pid,
    });

    expect(replacement.taskId).toBe("task-dead-lock-replacement");
    await replacement.release();
    await deadOwner.release();
  });

  it("replays a completed task by taskId without running the worker again", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-replay-",
    );
    let runs = 0;
    const pool = {
      async run(): Promise<PromptResult> {
        runs += 1;
        return { output: "already done" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });
    const input = {
      taskId: "task-replay",
      workspace: { mode: "existing_locked", path: workspacePath } as const,
      effectMode: "workspace_patch" as const,
      provider: "codex",
      pool,
      job: { prompt: "do once", workspacePath },
      originalPrompt: "do once",
      policy: { maxAttempts: 1 },
    };

    const first = await runner.run(input);
    const second = await runner.run(input);

    if (first.status !== "completed") throw new Error("expected completed");
    if (second.status !== "completed")
      throw new Error("expected replayed completed");
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ output: "already done" });
    expect(runs).toBe(1);
  });

  it("fails fast when a git worktree is required but the workspace is not git", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "safe-execution-not-git-"),
    );
    cleanupPaths.push(workspacePath);
    let runs = 0;
    const pool = {
      async run(): Promise<PromptResult> {
        runs += 1;
        return { output: "should not run" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const originalGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = [tmpdir(), originalGitCeiling]
      .filter(Boolean)
      .join(":");
    const result = await runner
      .run({
        taskId: "task-require-git",
        workspace: {
          mode: "existing_locked",
          path: workspacePath,
          requireGitWorkspace: true,
        },
        effectMode: "workspace_patch",
        provider: "codex",
        pool,
        job: { prompt: "do work", workspacePath },
        originalPrompt: "do work",
        policy: { maxAttempts: 1 },
      })
      .finally(() => {
        if (originalGitCeiling === undefined) {
          delete process.env.GIT_CEILING_DIRECTORIES;
        } else {
          process.env.GIT_CEILING_DIRECTORIES = originalGitCeiling;
        }
      });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed result");
    expect(result.failureDetails).toMatchObject({
      safeExecutionCode: "safe_execution_workspace_not_git",
    });
    expect(runs).toBe(0);
  });

  it("returns a structured failure when the initial workspace snapshot fails", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-snapshot-fail-",
    );
    const journal = new InMemoryAttemptJournal();
    let runs = 0;
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          throw Object.assign(new Error("git status failed"), {
            exitCode: 128,
            stderr: "fatal: bad revision\n",
          });
        },
      },
    });

    const result = await runner.run({
      taskId: "task-snapshot-fail",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          runs += 1;
          return { output: "should not run" };
        },
      },
      job: { prompt: "do work", workspacePath },
      originalPrompt: "do work",
      policy: { maxAttempts: 1 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("unknown_error");
    expect(result.safeMessage).toBe("git status failed");
    expect(result.attempts).toHaveLength(0);
    expect(result.failureDetails).toMatchObject({
      exitCode: "128",
      stderrTail: "fatal: bad revision",
      rawCause: "git status failed",
    });
    expect(result.task.status).toBe("failed");
    expect(
      (await journal.readTask({ taskId: "task-snapshot-fail" }))
        ?.lastFailureDetails,
    ).toMatchObject({ exitCode: "128" });
    expect(runs).toBe(0);
  });

  it("stops on permission_required without switching accounts", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-permission-",
    );
    let runs = 0;
    const pool = {
      async run(): Promise<PromptResult> {
        runs += 1;
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          "Permission required.",
          { details: { reason: "permission_required" } },
        );
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
      taskId: "task-permission",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "needs approval", workspacePath },
      originalPrompt: "needs approval",
      policy: { maxAttempts: 3 },
      continuationJobFactory: ({ continuationPacket }) => ({
        prompt: continuationPacket.message,
        workspacePath,
      }),
    });

    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("permission_required");
    expect(result.attempts).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it("stops after an unknown error when the workspace became dirty", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-unknown-",
    );
    let runs = 0;
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        await writeFile(join(job.workspacePath, "unknown.txt"), "dirty\n");
        throw new Error("unexpected failure");
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
      taskId: "task-unknown",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "make change", workspacePath },
      originalPrompt: "make change",
      policy: { maxAttempts: 2 },
      continuationJobFactory: ({ continuationPacket }) => ({
        prompt: continuationPacket.message,
        workspacePath,
      }),
    });

    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("unknown_error");
    expect(result.safeMessage).toContain("unknown error changed the workspace");
    expect(result.attempts).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it("stops after an unknown error when a clean workspace got a new commit", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-commit-change-",
    );
    let runs = 0;
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        await writeFile(join(job.workspacePath, "committed.txt"), "done\n");
        await execFileAsync("git", ["add", "committed.txt"], {
          cwd: job.workspacePath,
        });
        await execFileAsync(
          "git",
          [
            "-c",
            "user.name=Subscription Runtime Tests",
            "-c",
            "user.email=tests@example.com",
            "commit",
            "-m",
            "Worker committed change",
          ],
          { cwd: job.workspacePath },
        );
        throw new Error("provider_output_invalid");
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
      taskId: "task-commit-change",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "commit then fail", workspacePath },
      originalPrompt: "commit then fail",
      policy: { maxAttempts: 2 },
    });

    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("unknown_error");
    expect(result.safeMessage).toContain("unknown error changed the workspace");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.workspaceDirtyBefore).toBe(false);
    expect(result.attempts[0]?.workspaceDirtyAfter).toBe(false);
    expect(runs).toBe(1);
  });

  it("continues dirty unknown work when the policy explicitly allows it", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-unknown-continue-",
    );
    let runs = 0;
    let resumedPrompt = "";
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        if (runs === 1) {
          await writeFile(join(job.workspacePath, "unknown.txt"), "partial\n");
          throw new Error("transient runtime failure");
        }
        resumedPrompt = job.prompt;
        expect(
          await readFile(join(job.workspacePath, "unknown.txt"), "utf8"),
        ).toBe("partial\n");
        await writeFile(join(job.workspacePath, "unknown.txt"), "done\n");
        return { output: "continued" };
      },
    };
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
      taskId: "task-unknown-continue",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool,
      job: { prompt: "make change", workspacePath },
      originalPrompt: "make change",
      policy: {
        maxAttempts: 2,
        retryUnknownChangedWorkspace: true,
      },
      continuationJobFactory: ({ continuationPacket }) => ({
        prompt: continuationPacket.message,
        workspacePath,
      }),
      summarizeResult: (value) => value.output,
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.failureReason).toBe("unknown_error");
    expect(result.attempts[0]?.failureMessage).toBe(
      "transient runtime failure",
    );
    expect(resumedPrompt).toContain("Continue the same task");
    expect(resumedPrompt).toContain(
      "Previous attempt stopped because: unknown_error",
    );
    expect(await readFile(join(workspacePath, "unknown.txt"), "utf8")).toBe(
      "done\n",
    );
    expect(runs).toBe(2);
  }, 15_000);

  it("classifies wrapped provider failures from worker pool causes", () => {
    const providerFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Codex task timed out.",
      { details: { code: "task_timeout" } },
    );
    const poolFailure = new SubscriptionWorkerError(
      "subscription_worker_pool_slot_failed",
      "Worker pool slot failed to run a task.",
      {
        cause: providerFailure,
        details: { workerId: "worker-a", slotIndex: "0" },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(poolFailure)).toEqual({
      reason: "task_timeout",
      safeMessage: "Codex task timed out.",
      retryable: true,
    });
  });

  it("classifies invalid provider output without collapsing to unknown_error", () => {
    const providerFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Codex provider output was invalid.",
      { details: { code: "provider_output_invalid" } },
    );

    expect(defaultSafeExecutionErrorClassifier(providerFailure)).toEqual({
      reason: "provider_output_invalid",
      safeMessage: "Codex provider output was invalid.",
      retryable: true,
    });
  });

  it("classifies Codex app-server goal blocks as capacity unavailability", () => {
    const providerFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Codex app-server goal backend is temporarily blocked.",
      {
        details: {
          code: "backend_unavailable",
          rawCause: "codex_app_server_goal_blocked",
        },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(providerFailure)).toMatchObject({
      reason: "capacity_unavailable",
      safeMessage: "Codex app-server goal backend is temporarily blocked.",
      retryable: true,
      details: {
        code: "backend_unavailable",
        rawCause: "codex_app_server_goal_blocked",
      },
    });
  });

  it("preserves worker pool recovery hints for auth-stale capacity failures", () => {
    const poolFailure = new SubscriptionWorkerError(
      "subscription_worker_pool_capacity_unavailable",
      "Worker pool has no available or resettable-capacity slots.",
      {
        details: {
          availability: "disabled:1",
          reasons: "auth_invalid:1",
          recoveryHint:
            "One or more worker account slots look auth-stale. Run account diagnostics, relogin the affected slot or sync the per-account auth root to this host, then retry the worker.",
        },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(poolFailure)).toMatchObject({
      reason: "capacity_unavailable",
      safeMessage: "Worker pool has no available or resettable-capacity slots.",
      retryable: true,
      details: {
        availability: "disabled:1",
        reasons: "auth_invalid:1",
        recoveryHint: expect.stringContaining("sync the per-account auth root"),
      },
    });
  });

  it("parks clean work as waiting_capacity when every account is temporarily unavailable", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-wait-capacity-",
    );
    const journal = new InMemoryAttemptJournal();
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });

    const result = await runner.run({
      taskId: "task-wait-capacity",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          throw new SubscriptionWorkerError(
            "subscription_worker_pool_capacity_unavailable",
            "Worker pool has no available accounts.",
            {
              details: {
                availability: "quota_exhausted:2",
                reasons: "quota_limited:2",
                waitUntil: "2026-06-01T01:00:00.000Z",
              },
            },
          );
        },
      },
      job: { prompt: "Implement feature.", workspacePath },
      originalPrompt: "Implement feature.",
      policy: { maxAttempts: 1 },
    });

    expect(result.status).toBe("waiting_capacity");
    if (result.status !== "waiting_capacity") {
      throw new Error("expected waiting_capacity");
    }
    expect(result.reason).toBe("capacity_unavailable");
    expect(result.task.status).toBe("waiting_capacity");
    expect(result.failureDetails).toMatchObject({
      availability: "quota_exhausted:2",
      reasons: "quota_limited:2",
    });
    expect(
      (await journal.readTask({ taskId: "task-wait-capacity" }))?.status,
    ).toBe("waiting_capacity");
  }, 15_000);
});

function nodeSafeExecutionAdapters() {
  return {
    snapshotter: new DefaultWorkspaceSnapshotter(),
    workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
    runtime: new NodeSafeExecutionRuntime(),
  };
}
