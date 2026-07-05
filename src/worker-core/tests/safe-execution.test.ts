import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BoundedSubscriptionWorkerPool,
  DefaultWorkspaceSnapshotter,
  InMemoryActiveAttemptRegistry,
  InMemoryAttemptJournal,
  InMemoryWorkspaceLockStore,
  InterruptAndContinueWorkerUseCase,
  LocalFileAttemptJournal,
  LocalFileWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  WorkerControlService,
  defaultSafeExecutionErrorClassifier,
  workerControlTargetMatches,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
  type WorkerControlDeliveryReceipt,
  type WorkerControlInboxStore,
  type WorkerControlSignal,
  type WorkerControlTarget,
  type WorkspaceSnapshot,
} from "../index";

const execFileAsync = promisify(execFile);

type PromptJob = {
  readonly prompt: string;
  readonly workspacePath: string;
};

type PromptResult = {
  readonly output: string;
};

describe("SafeExecutionRunner", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  it("continues dirty quota-limited work on another account in the same locked workspace", async () => {
    const workspacePath = await gitWorkspace("safe-execution-quota-");
    const workers: FakePromptWorker[] = [];
    const slotRuns: string[] = [];
    const pool = new BoundedSubscriptionWorkerPool<PromptJob, PromptResult>({
      poolId: "safe-execution-pool",
      slots: 2,
      workerFactory: ({ slotIndex, workerId }) => {
        const worker = new FakePromptWorker(workerId, async (job, self) => {
          slotRuns.push(self.workerId);
          if (slotIndex === 0) {
            await writeFile(join(job.workspacePath, "feature.txt"), "partial\n");
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
          expect(await readFile(join(job.workspacePath, "feature.txt"), "utf8"))
            .toBe("partial\n");
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
    const workspacePath = await gitWorkspace("safe-execution-control-");
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
    const workspacePath = await gitWorkspace("safe-execution-interrupt-");
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
            message: "Stop the broad run and inspect the targeted recall slice.",
            caller: { kind: "orchestrator", id: "lead-agent" },
          });
          expect(interrupt.status).toBe("interrupted");
          expect(options?.abortSignal?.aborted).toBe(true);
          throw new Error("provider observed runtime abort");
        }
        expect(job.prompt).toContain("Previous attempt stopped because: runtime_interrupted");
        expect(job.prompt).toContain("Runtime control inbox instructions");
        expect(job.prompt).toContain("targeted recall slice");
        expect(job.prompt).toContain("Changed files:\n- feature.txt");
        expect(await readFile(join(job.workspacePath, "feature.txt"), "utf8"))
          .toBe("partial\n");
        await writeFile(join(job.workspacePath, "feature.txt"), "done\n");
        return { output: "continued after interrupt" };
      },
    };
    const runner = new SafeExecutionRunner({
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
    const workspacePath = await gitWorkspace("safe-execution-goal-slice-");
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
        expect(await readFile(join(job.workspacePath, "slice.txt"), "utf8"))
          .toBe("partial\n");
        await writeFile(join(job.workspacePath, "slice.txt"), "done\n");
        return { output: "completed after next goal slice" };
      },
    };
    const runner = new SafeExecutionRunner({
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
    const workspacePath = await gitWorkspace("safe-execution-control-reconnect-");
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
        expect(job.prompt.includes("Runtime control inbox instructions")).toBe(false);
        return { output: "done after reconnect repair" };
      },
    };
    const runner = new SafeExecutionRunner({
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
      controlTarget: {
        jobId: "job-control-reconnect",
        taskId: "task-control-reconnect",
        workspaceId: workspacePath,
      },
      policy: { maxAttempts: 2 },
    });

    expect(result.status).toBe("completed");
    expect(consumed).toBe(0);
  });

  it("rejects concurrent tasks for the same existing workspace lock", async () => {
    const workspacePath = await gitWorkspace("safe-execution-lock-");
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

  it("replaces a file workspace lock owned by a dead process without requiring staleLockMs", async () => {
    const workspacePath = await gitWorkspace("safe-execution-dead-lock-");
    const lockRoot = await mkdtemp(join(tmpdir(), "safe-execution-lock-store-"));
    cleanupPaths.push(lockRoot);
    const lockStore = new LocalFileWorkspaceLockStore(lockRoot);
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
    const workspacePath = await gitWorkspace("safe-execution-replay-");
    let runs = 0;
    const pool = {
      async run(): Promise<PromptResult> {
        runs += 1;
        return { output: "already done" };
      },
    };
    const runner = new SafeExecutionRunner({
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
    if (second.status !== "completed") throw new Error("expected replayed completed");
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ output: "already done" });
    expect(runs).toBe(1);
  });

  it("fails fast when a git worktree is required but the workspace is not git", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "safe-execution-not-git-"));
    cleanupPaths.push(workspacePath);
    let runs = 0;
    const pool = {
      async run(): Promise<PromptResult> {
        runs += 1;
        return { output: "should not run" };
      },
    };
    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
    });

    const result = await runner.run({
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
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed result");
    expect(result.failureDetails).toMatchObject({
      safeExecutionCode: "safe_execution_workspace_not_git",
    });
    expect(runs).toBe(0);
  });

  it("returns a structured failure when the initial workspace snapshot fails", async () => {
    const workspacePath = await gitWorkspace("safe-execution-snapshot-fail-");
    const journal = new InMemoryAttemptJournal();
    let runs = 0;
    const runner = new SafeExecutionRunner({
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
    const workspacePath = await gitWorkspace("safe-execution-permission-");
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
    const workspacePath = await gitWorkspace("safe-execution-unknown-");
    let runs = 0;
    const pool = {
      async run(job: PromptJob): Promise<PromptResult> {
        runs += 1;
        await writeFile(join(job.workspacePath, "unknown.txt"), "dirty\n");
        throw new Error("unexpected failure");
      },
    };
    const runner = new SafeExecutionRunner({
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
    const workspacePath = await gitWorkspace("safe-execution-commit-change-");
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

  it(
    "continues dirty unknown work when the policy explicitly allows it",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-unknown-continue-");
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
          expect(await readFile(join(job.workspacePath, "unknown.txt"), "utf8"))
            .toBe("partial\n");
          await writeFile(join(job.workspacePath, "unknown.txt"), "done\n");
          return { output: "continued" };
        },
      };
      const runner = new SafeExecutionRunner({
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
      expect(result.attempts[0]?.failureMessage).toBe("transient runtime failure");
      expect(resumedPrompt).toContain("Continue the same task");
      expect(resumedPrompt).toContain(
        "Previous attempt stopped because: unknown_error",
      );
      expect(await readFile(join(workspacePath, "unknown.txt"), "utf8")).toBe(
        "done\n",
      );
      expect(runs).toBe(2);
    },
    15_000,
  );

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

  it(
    "parks clean work as waiting_capacity when every account is temporarily unavailable",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-wait-capacity-");
      const journal = new InMemoryAttemptJournal();
      const runner = new SafeExecutionRunner({
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
    },
    15_000,
  );

  it(
    "resumes clean waiting_capacity work with a continuation packet after capacity returns",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-resume-capacity-");
      const journal = new InMemoryAttemptJournal();
      const firstRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });

      const first = await firstRunner.run({
        taskId: "task-resume-capacity",
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
        job: { prompt: "Implement capacity-resume feature.", workspacePath },
        originalPrompt: "Implement capacity-resume feature.",
        policy: { maxAttempts: 1 },
      });

      expect(first.status).toBe("waiting_capacity");
      expect(first.attempts).toHaveLength(1);
      expect(first.task.lastFailureReason).toBe("capacity_unavailable");

      let resumedPrompt = "";
      const secondRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });
      const resumed = await secondRunner.run({
        taskId: "task-resume-capacity",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            resumedPrompt = job.prompt;
            await writeFile(join(job.workspacePath, "capacity.txt"), "done\n");
            return { output: "capacity returned" };
          },
        },
        job: { prompt: "Implement capacity-resume feature.", workspacePath },
        originalPrompt: "Implement capacity-resume feature.",
        policy: { maxAttempts: 2 },
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.attempts).toHaveLength(2);
      expect(resumedPrompt).toContain("Continue the same task");
      expect(resumedPrompt).toContain(
        "Previous attempt stopped because: capacity_unavailable",
      );
      expect(await readFile(join(workspacePath, "capacity.txt"), "utf8")).toBe(
        "done\n",
      );
    },
    15_000,
  );

  it("classifies raw Codex app-server goal blocks before unknown_error", () => {
    const processFailure = Object.assign(
      new Error("node_process_runner_failed:1:codex_app_server_goal_blocked"),
      {
        exitCode: 1,
        stdout: "",
        stderr: "codex_app_server_goal_blocked",
      },
    );

    expect(defaultSafeExecutionErrorClassifier(processFailure)).toMatchObject({
      reason: "capacity_unavailable",
      safeMessage: "Codex app-server goal backend is temporarily blocked.",
      retryable: true,
      details: {
        exitCode: "1",
        stderrTail: "codex_app_server_goal_blocked",
        rawCause: expect.stringContaining("codex_app_server_goal_blocked"),
      },
    });
  });

  it("classifies invalid auth from wrapped plain error causes", () => {
    const authFailure = new Error(
      "node_process_runner_failed:1: HTTP error: 401 Unauthorized. " +
        "refresh_token_invalidated: Your session has ended. Please log out and sign in again.",
    );
    const poolFailure = new SubscriptionWorkerError(
      "subscription_worker_pool_slot_failed",
      "Worker pool slot failed to run a task.",
      {
        cause: authFailure,
        details: { workerId: "worker-a", slotIndex: "0" },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(poolFailure)).toEqual({
      reason: "account_unavailable",
      safeMessage: "Provider account session is unavailable.",
      retryable: true,
    });
  });

  it("preserves unknown runtime failure cause metadata", () => {
    const providerFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Codex runtime failed.",
      {
        details: {
          reason: "unknown_runtime_failure",
          exitCode: "7",
          stderrTail: "forced fallback failure",
          rawCause: "codex_json_exec_failed:7:forced fallback failure",
        },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(providerFailure)).toMatchObject({
      reason: "unknown_error",
      safeMessage: "Codex runtime failed.",
      retryable: true,
      details: {
        reason: "unknown_runtime_failure",
        exitCode: "7",
        stderrTail: "forced fallback failure",
        rawCause: "codex_json_exec_failed:7:forced fallback failure",
      },
    });
  });

  it(
    "marks retryable partial work when no continuation job can be built",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-no-continuation-");
      const journal = new InMemoryAttemptJournal();
      let runs = 0;
      const runner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });

      const result = await runner.run({
        taskId: "task-no-continuation",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(job: { readonly workspacePath: string }): Promise<PromptResult> {
            runs += 1;
            await writeFile(join(job.workspacePath, "partial.txt"), "partial\n");
            throw new SubscriptionWorkerError(
              "subscription_worker_run_failed",
              "Quota limited.",
              { details: { reason: "quota_limited" } },
            );
          },
        },
        job: { workspacePath },
        originalPrompt: "finish no-continuation task",
        policy: { maxAttempts: 2 },
      });

      if (result.status !== "partial") throw new Error("expected partial");
      expect(result.reason).toBe("quota_limited");
      expect(result.safeMessage).toContain("continuationJobFactory");
      expect(result.task.status).toBe("partial");
      expect((await journal.readTask({ taskId: "task-no-continuation" }))?.status)
        .toBe("partial");
      expect(result.attempts).toHaveLength(1);
      expect(runs).toBe(1);
    },
    15_000,
  );

  it(
    "keeps a resumed partial task partial when no continuation job can be built",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-resume-no-continuation-");
      const journal = new InMemoryAttemptJournal();
      const firstRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });
      await firstRunner.run({
        taskId: "task-resume-no-continuation",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            await writeFile(join(job.workspacePath, "partial.txt"), "partial\n");
            throw new SubscriptionWorkerError(
              "subscription_worker_run_failed",
              "Quota limited.",
              { details: { reason: "quota_limited" } },
            );
          },
        },
        job: { prompt: "make partial", workspacePath },
        originalPrompt: "make partial",
        policy: { maxAttempts: 1 },
      });

      let resumedRuns = 0;
      const secondRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });
      const result = await secondRunner.run({
        taskId: "task-resume-no-continuation",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(): Promise<PromptResult> {
            resumedRuns += 1;
            return { output: "should not run" };
          },
        },
        job: { workspacePath },
        originalPrompt: "make partial",
        policy: { maxAttempts: 2 },
      });

      if (result.status !== "partial") throw new Error("expected partial");
      expect(result.reason).toBe("quota_limited");
      expect(result.safeMessage).toContain("continuationJobFactory");
      expect(result.task.status).toBe("partial");
      expect(result.attempts).toHaveLength(1);
      expect(resumedRuns).toBe(0);
    },
    15_000,
  );

  it("does not rerun an interrupted running task with unrecorded workspace changes", async () => {
    const workspacePath = await gitWorkspace("safe-execution-interrupted-dirty-");
    const journal = new InMemoryAttemptJournal();
    await journal.startTask({
      taskId: "task-interrupted-dirty",
      workspaceRunId: "workspace:interrupted",
      workspacePath,
      effectMode: "workspace_patch",
      provider: "codex",
      now: new Date("2026-05-31T00:00:00.000Z"),
    });
    await writeFile(join(workspacePath, "worker-output.txt"), "partial\n");

    let runs = 0;
    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    const result = await runner.run({
      taskId: "task-interrupted-dirty",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          runs += 1;
          return { output: "should not run" };
        },
      },
      job: { prompt: "finish interrupted task", workspacePath },
      originalPrompt: "finish interrupted task",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.reason).toBe("unknown_error");
    expect(result.safeMessage).toContain("interrupted running task");
    expect(result.task.status).toBe("partial");
    expect(result.attempts).toHaveLength(0);
    expect(result.failureDetails).toMatchObject({
      workspaceMode: "git",
      changedFileCount: "1",
      changedFiles: "worker-output.txt",
    });
    expect(runs).toBe(0);
  });

  it(
    "resumes a partial task from the local file journal with a continuation packet",
    async () => {
      const workspacePath = await gitWorkspace("safe-execution-journal-");
      const stateRoot = await tempPath("safe-execution-state-");
      const journal = new LocalFileAttemptJournal(stateRoot);
      const firstRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });
      await firstRunner.run({
        taskId: "task-journal",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            await writeFile(join(job.workspacePath, "journal.txt"), "partial\n");
            throw new SubscriptionWorkerError(
              "subscription_worker_run_failed",
              "Quota limited.",
              { details: { reason: "quota_limited" } },
            );
          },
        },
        job: { prompt: "finish journal task", workspacePath },
        originalPrompt: "finish journal task",
        policy: { maxAttempts: 1 },
      });

      let resumedPrompt = "";
      const secondRunner = new SafeExecutionRunner({
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
      });
      const result = await secondRunner.run({
        taskId: "task-journal",
        workspace: { mode: "existing_locked", path: workspacePath },
        effectMode: "workspace_patch",
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            resumedPrompt = job.prompt;
            await writeFile(join(job.workspacePath, "journal.txt"), "done\n");
            return { output: "resumed" };
          },
        },
        job: { prompt: "finish journal task", workspacePath },
        originalPrompt: "finish journal task",
        policy: { maxAttempts: 2 },
      });

      expect(result.status).toBe("completed");
      expect(result.attempts).toHaveLength(2);
      expect(resumedPrompt).toContain("Continue the same task");
      expect(resumedPrompt).toContain("Previous attempt stopped because: quota_limited");
      expect(await readFile(join(workspacePath, "journal.txt"), "utf8")).toBe(
        "done\n",
      );
    },
    15_000,
  );

  it("uses only safe read-only git snapshot commands", async () => {
    const workspacePath = await tempPath("safe-execution-git-commands-");
    const logPath = join(workspacePath, "git.log");
    const fakeGitPath = join(workspacePath, "fake-git.cjs");
    await writeFile(
      fakeGitPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.GIT_COMMAND_LOG, args.join(' ') + '\\n');",
        "if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') { console.log('true'); process.exit(0); }",
        "if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') { console.log('tree-hash'); process.exit(0); }",
        "if (args[0] === 'status') { process.stdout.write(' M tracked.txt\\0'); process.exit(0); }",
        "if (args[0] === 'diff' && args.includes('--name-only')) { console.log('tracked.txt'); process.exit(0); }",
        "if (args[0] === 'diff' && args.includes('--stat')) { console.log(' tracked.txt | 1 +'); process.exit(0); }",
        "if (args[0] === 'diff') { console.log('diff --git a/tracked.txt b/tracked.txt'); process.exit(0); }",
        "process.exit(1);",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(fakeGitPath, 0o700);
    const original = process.env.GIT_COMMAND_LOG;
    process.env.GIT_COMMAND_LOG = logPath;
    try {
      const snapshotter = new DefaultWorkspaceSnapshotter({
        gitBinaryPath: fakeGitPath,
      });
      const snapshot = await snapshotter.capture({
        workspacePath,
        includeDiff: true,
      });
      expect(snapshot.changedFiles).toEqual(["tracked.txt"]);
    } finally {
      if (original === undefined) {
        delete process.env.GIT_COMMAND_LOG;
      } else {
        process.env.GIT_COMMAND_LOG = original;
      }
    }

    const commands = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(commands).toEqual([
      "rev-parse --is-inside-work-tree --show-prefix --show-toplevel",
      "status --porcelain=v1 -z --untracked-files=all -- .",
      "rev-parse HEAD^{tree}",
      "diff --relative --name-only --no-ext-diff -- .",
      "diff --relative --cached --name-only --no-ext-diff -- .",
      "diff --relative --stat --no-ext-diff -- .",
      "diff --relative --cached --stat --no-ext-diff -- .",
      "diff --relative --numstat --no-ext-diff -- .",
      "diff --relative --cached --numstat --no-ext-diff -- .",
      "diff --relative --no-ext-diff -- .",
      "diff --relative --cached --no-ext-diff -- .",
    ]);
    expect(commands.join("\n")).not.toMatch(/\b(reset|clean|checkout|apply)\b/);
  });

  it("does not report a full filesystem snapshot as worker-changed files", async () => {
    const workspacePath = await tempPath("safe-execution-filesystem-delta-");
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [".claude/settings.json", ".worktrees/old/file.ts"],
        fingerprint: "before",
        summary: "before filesystem scan",
      },
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: [
          ".claude/settings.json",
          ".worktrees/old/file.ts",
          "src/worker-output.ts",
        ],
        fingerprint: "after",
        summary: "after filesystem scan",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-filesystem-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it("does not report pre-existing git changes as worker-changed files", async () => {
    const workspacePath = await tempPath("safe-execution-git-delta-");
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts"],
        fingerprint: "before",
        summary: "before git status",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts", "src/worker-output.ts"],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-git-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it("records structured usage and observed patch LoC on completed attempts", async () => {
    const workspacePath = await tempPath("safe-execution-stats-");
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [],
        diffNumstat: [],
        fingerprint: "before",
        summary: "before git status",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/worker-output.ts"],
        diffNumstat: [
          {
            path: "src/worker-output.ts",
            additions: 12,
            deletions: 3,
          },
        ],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-stats",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<{
          readonly output: string;
          readonly usage: {
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly totalTokens: number;
          };
        }> {
          return {
            output: "done",
            usage: {
              inputTokens: 100,
              outputTokens: 25,
              totalTokens: 125,
            },
          };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
      summarizeResult: (value) => value.output,
      attemptUsage: (value) => value.usage,
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
    expect(result.attempts[0]?.usageSource).toBe("provider_structured");
    expect(result.attempts[0]?.patch).toEqual({
      additions: 12,
      deletions: 3,
      source: "git_numstat_delta",
    });
  });

  it("uses delta when snapshot modes change during an attempt", async () => {
    const workspacePath = await tempPath("safe-execution-mixed-delta-");
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [".worktrees/old/file.ts", "src/pre-existing.ts"],
        fingerprint: "before",
        summary: "before filesystem scan",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts", "src/worker-output.ts"],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-mixed-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it(
    "scopes git snapshots to the requested workspace subdirectory",
    async () => {
      const repoPath = await tempPath("safe-execution-git-scope-");
      await execFileAsync("git", ["init"], { cwd: repoPath });
      await mkdir(join(repoPath, "app"), { recursive: true });
      await mkdir(join(repoPath, "other"), { recursive: true });
      await writeFile(join(repoPath, "app", "inside.txt"), "base\n", "utf8");
      await writeFile(join(repoPath, "app", "old name.txt"), "base\n", "utf8");
      await writeFile(join(repoPath, "other", "outside.txt"), "base\n", "utf8");
      await writeFile(join(repoPath, "app", "delete name.txt"), "base\n", "utf8");
      await writeFile(
        join(repoPath, "other", "outside old name.txt"),
        "base\n",
        "utf8",
      );
      await execFileAsync("git", ["add", "."], { cwd: repoPath });
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
        { cwd: repoPath },
      );

      await writeFile(join(repoPath, "app", "inside.txt"), "changed\n", "utf8");
      await writeFile(join(repoPath, "app", "new.txt"), "new\n", "utf8");
      await writeFile(join(repoPath, "app", "new file.txt"), "new\n", "utf8");
      await mkdir(join(repoPath, "app", "nested"), { recursive: true });
      await writeFile(
        join(repoPath, "app", "nested", "untracked.txt"),
        "new\n",
        "utf8",
      );
      await writeFile(join(repoPath, "app", "staged.txt"), "staged\n", "utf8");
      await rm(join(repoPath, "app", "delete name.txt"));
      await writeFile(
        join(repoPath, "other", "outside.txt"),
        "changed\n",
        "utf8",
      );
      await execFileAsync("git", ["mv", "app/old name.txt", "app/new name.txt"], {
        cwd: repoPath,
      });
      await execFileAsync(
        "git",
        ["mv", "other/outside old name.txt", "other/outside new name.txt"],
        { cwd: repoPath },
      );
      await execFileAsync("git", ["add", "app/staged.txt", "other/outside.txt"], {
        cwd: repoPath,
      });

      const snapshot = await new DefaultWorkspaceSnapshotter().capture({
        workspacePath: join(repoPath, "app"),
        includeDiff: true,
      });

      expect(snapshot.changedFiles).toEqual([
        "delete name.txt",
        "inside.txt",
        "nested/untracked.txt",
        "new file.txt",
        "new name.txt",
        "new.txt",
        "staged.txt",
      ]);
      expect(snapshot.summary).toBe("Git workspace has 7 changed file(s).");
      expect(snapshot.diffStat).toContain("inside.txt");
      expect(snapshot.diffStat).toContain("staged.txt");
      expect(snapshot.diffStat).not.toContain("outside.txt");
      expect(snapshot.shortDiff).toContain("diff --git a/inside.txt b/inside.txt");
      expect(snapshot.shortDiff).toContain("diff --git a/staged.txt b/staged.txt");
      expect(snapshot.shortDiff).not.toContain("outside.txt");
    },
    15_000,
  );

  it(
    "fingerprints git snapshots using the requested workspace subtree",
    async () => {
      const repoPath = await tempPath("safe-execution-git-tree-scope-");
      await execFileAsync("git", ["init"], { cwd: repoPath });
      await mkdir(join(repoPath, "app"), { recursive: true });
      await mkdir(join(repoPath, "other"), { recursive: true });
      await writeFile(join(repoPath, "app", "inside.txt"), "base\n", "utf8");
      await writeFile(join(repoPath, "other", "outside.txt"), "base\n", "utf8");
      await execFileAsync("git", ["add", "."], { cwd: repoPath });
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
        { cwd: repoPath },
      );

      const snapshotter = new DefaultWorkspaceSnapshotter();
      const before = await snapshotter.capture({
        workspacePath: join(repoPath, "app"),
      });

      await writeFile(join(repoPath, "other", "outside.txt"), "outside\n", "utf8");
      await execFileAsync("git", ["add", "other/outside.txt"], {
        cwd: repoPath,
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
          "Outside commit",
        ],
        { cwd: repoPath },
      );
      const afterOutsideCommit = await snapshotter.capture({
        workspacePath: join(repoPath, "app"),
      });

      await writeFile(join(repoPath, "app", "inside.txt"), "inside\n", "utf8");
      await execFileAsync("git", ["add", "app/inside.txt"], { cwd: repoPath });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Subscription Runtime Tests",
          "-c",
          "user.email=tests@example.com",
          "commit",
          "-m",
          "Inside commit",
        ],
        { cwd: repoPath },
      );
      const afterInsideCommit = await snapshotter.capture({
        workspacePath: join(repoPath, "app"),
      });

      expect(before.dirty).toBe(false);
      expect(afterOutsideCommit.dirty).toBe(false);
      expect(afterInsideCommit.dirty).toBe(false);
      expect(afterOutsideCommit.fingerprint).toBe(before.fingerprint);
      expect(afterInsideCommit.fingerprint).not.toBe(before.fingerprint);
    },
    15_000,
  );

  async function tempPath(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    cleanupPaths.push(path);
    return path;
  }

  async function gitWorkspace(prefix: string): Promise<string> {
    const workspacePath = await tempPath(prefix);
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
});

class FakePromptWorker
  implements CapacityAwareSubscriptionWorker<PromptJob, PromptResult>
{
  state: SubscriptionWorkerState = "created";
  capacitySnapshot: WorkerCapacitySnapshot = { availability: "available" };

  constructor(
    readonly workerId: string,
    private readonly handler: (
      job: PromptJob,
      self: FakePromptWorker,
    ) => Promise<PromptResult>,
  ) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.state = "ready";
    return {
      status: "ready",
      warmedAt: new Date(),
      warnings: [],
    };
  }

  run(job: PromptJob): Promise<PromptResult> {
    return this.handler(job, this);
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    return {
      status: "healthy",
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacitySnapshot;
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class InMemoryWorkerControlInboxStore implements WorkerControlInboxStore {
  private readonly signals: WorkerControlSignal[] = [];
  private readonly receipts: WorkerControlDeliveryReceipt[] = [];

  async appendSignal(signal: WorkerControlSignal): Promise<WorkerControlSignal> {
    this.signals.push(signal);
    return signal;
  }

  async listSignals(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlSignal[]> {
    return this.signals.filter((signal) =>
      (!input.target || workerControlTargetMatches(input.target, signal.target)) &&
      (!input.signalIds || input.signalIds.includes(signal.signalId))
    );
  }

  async tryClaimDelivery(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt | null> {
    if (
      this.receipts.some((existing) =>
        existing.signalId === receipt.signalId &&
        existing.state === "accepted" &&
        existing.deliveryAttemptId === receipt.deliveryAttemptId
      )
    ) {
      return null;
    }
    this.receipts.push(receipt);
    return receipt;
  }

  async appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt> {
    this.receipts.push(receipt);
    return receipt;
  }

  async listReceipts(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlDeliveryReceipt[]> {
    return this.receipts.filter((receipt) =>
      (!input.target || workerControlTargetMatches(input.target, receipt.target)) &&
      (!input.signalIds || input.signalIds.includes(receipt.signalId))
    );
  }
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
