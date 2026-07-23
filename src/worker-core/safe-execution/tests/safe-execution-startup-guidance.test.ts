import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../../../worker-local/safe-execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAttemptJournal,
  InMemoryWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  WorkerControlService,
} from "../../index";
import {
  cleanupTemporaryPaths,
  gitWorkspace,
  InMemoryWorkerControlInboxStore,
  type PromptJob,
  type PromptResult,
} from "./safe-execution-test-support";

describe("SafeExecutionRunner startup guidance", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await cleanupTemporaryPaths(cleanupPaths);
  });

  it("injects pending guidance when a clean stopped task is started again", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-stopped-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    await journal.startTask({
      taskId: "task-stopped-guidance",
      workspaceRunId: "workspace-stopped-guidance",
      workspacePath,
      effectMode: "workspace_patch",
      provider: "codex",
      now: new Date("2026-07-12T00:00:00.000Z"),
    });
    const runner = new SafeExecutionRunner({
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
      controlInbox: {
        async consumeForContinuation(input) {
          return {
            target: input.target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: [],
            signalIds: ["stopped-guidance"],
            message: "Runtime control inbox instructions:\nUse the new scope.",
          };
        },
      },
    });

    const result = await runner.run({
      taskId: "task-stopped-guidance",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          expect(job.prompt).toContain("Use the new scope.");
          return { output: "continued stopped task" };
        },
      },
      job: { prompt: "Original scope.", workspacePath },
      originalPrompt: "Original scope.",
      controlContinuationJobFactory: ({
        job,
        originalPrompt,
        controlBatch,
      }) => {
        const prompt = `${originalPrompt}\n${controlBatch.message ?? ""}`;
        return { job: { ...job, prompt }, originalPrompt: prompt };
      },
      policy: { maxAttempts: 1 },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.replayed).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  it("releases startup guidance when account refresh fails before provider task start", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-pre-task-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    const control = new WorkerControlService({
      store: new InMemoryWorkerControlInboxStore(),
    });
    const taskId = "task-pre-task-guidance";
    const target = { jobId: taskId, workspaceId: workspacePath };
    await control.enqueueSignal({
      target,
      intent: "guidance",
      body: "Continue the same immutable reviewer input.",
    });
    const runner = new SafeExecutionRunner({
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
      controlInbox: control,
    });
    const run = (pool: {
      run(
        job: PromptJob,
        options?: {
          readonly onProviderTaskStarted?: () => Promise<void> | void;
        },
      ): Promise<PromptResult>;
    }) =>
      runner.run({
        taskId,
        workspace: { mode: "existing_locked" as const, path: workspacePath },
        effectMode: "workspace_patch" as const,
        provider: "codex",
        pool,
        job: { prompt: "Review the patch.", workspacePath },
        originalPrompt: "Review the patch.",
        controlTarget: target,
        controlContinuationJobFactory: ({
          job,
          originalPrompt,
          controlBatch,
        }) => {
          const prompt = `${originalPrompt}\n${controlBatch.message ?? ""}`;
          return { job: { ...job, prompt }, originalPrompt: prompt };
        },
        policy: { maxAttempts: 1 },
      });

    const unavailable = await run({
      async run(job) {
        expect(job.prompt).toContain("same immutable reviewer input");
        throw new SubscriptionWorkerError(
          "subscription_worker_account_unavailable",
          "Account refresh failed before provider task start.",
          { details: { reason: "account_unavailable" } },
        );
      },
    });
    expect(unavailable.status).toBe("waiting_capacity");
    expect((await control.listSignals({ target }))[0]?.state).toBe("pending");

    const completed = await run({
      async run(job, options) {
        expect(job.prompt).toContain("same immutable reviewer input");
        await options?.onProviderTaskStarted?.();
        return { output: "formal accept" };
      },
    });
    expect(completed.status).toBe("completed");
    expect((await control.listSignals({ target }))[0]?.state).toBe("delivered");
  });

  it("uses broker replacement wording when guidance resumes a failed provider input", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-replacement-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    const control = new WorkerControlService({
      store: new InMemoryWorkerControlInboxStore(),
    });
    const taskId = "task-replacement-guidance";
    const target = { jobId: taskId, workspaceId: workspacePath };
    const originalPrompt = "Original wording rejected by the provider.";
    const run = (pool: { run(job: PromptJob): Promise<PromptResult> }) =>
      new SafeExecutionRunner({
        snapshotter: new DefaultWorkspaceSnapshotter(),
        workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
        runtime: new NodeSafeExecutionRuntime(),
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
        controlInbox: control,
      }).run({
        taskId,
        workspace: { mode: "existing_locked" as const, path: workspacePath },
        effectMode: "workspace_patch" as const,
        provider: "codex",
        pool,
        job: {
          prompt: originalPrompt,
          workspacePath,
          goalObjective: originalPrompt,
        },
        originalPrompt,
        controlTarget: target,
        controlContinuationJobFactory: ({
          job,
          controlBatch,
          previousFailureDetails,
        }) => {
          expect(previousFailureDetails?.rawCause).toContain(
            "content was flagged",
          );
          const prompt = controlBatch.message ?? "";
          return {
            job: { ...job, prompt, goalObjective: prompt },
            originalPrompt: prompt,
            replaceContinuationOriginalPrompt: true,
          };
        },
        policy: { maxAttempts: 1 },
      });

    const failed = await run({
      async run() {
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          "Provider rejected the input.",
          {
            details: {
              code: "unknown_runtime_failure",
              rawCause:
                "codex_app_server_error:This content was flagged for possible cybersecurity risk.",
            },
          },
        );
      },
    });
    expect(failed.status).toBe("failed");

    await control.enqueueSignal({
      target,
      intent: "guidance",
      body: "Review the local application correctness invariants.",
    });
    const completed = await run({
      async run(job) {
        expect(job.prompt).toContain(
          "Review the local application correctness invariants.",
        );
        expect(job.prompt).not.toContain(originalPrompt);
        expect(
          job.prompt.split(
            "Review the local application correctness invariants.",
          ),
        ).toHaveLength(2);
        expect(job.goalObjective).toContain(
          "Review the local application correctness invariants.",
        );
        expect(job.goalObjective).not.toContain(originalPrompt);
        expect(
          job.goalObjective?.split(
            "Review the local application correctness invariants.",
          ),
        ).toHaveLength(2);
        return { output: "formal accept" };
      },
    });
    expect(completed.status).toBe("completed");
  });

  it("preserves ordinary failed-task guidance across a resumed retry", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-ordinary-guidance-retry-",
    );
    const journal = new InMemoryAttemptJournal();
    const control = new WorkerControlService({
      store: new InMemoryWorkerControlInboxStore(),
    });
    const taskId = "task-ordinary-guidance-retry";
    const target = { jobId: taskId, workspaceId: workspacePath };
    const guidance = "Re-check the focused application invariant.";
    let runs = 0;
    const run = (maxAttempts: number) =>
      new SafeExecutionRunner({
        snapshotter: new DefaultWorkspaceSnapshotter(),
        workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
        runtime: new NodeSafeExecutionRuntime(),
        lockStore: new InMemoryWorkspaceLockStore(),
        journal,
        controlInbox: control,
      }).run({
        taskId,
        workspace: { mode: "existing_locked" as const, path: workspacePath },
        effectMode: "workspace_patch" as const,
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            runs += 1;
            if (runs === 1) {
              throw new SubscriptionWorkerError(
                "subscription_worker_run_failed",
                "Provider runtime failed.",
                {
                  details: {
                    code: "unknown_runtime_failure",
                    rawCause: "ordinary_unknown_runtime_failure",
                  },
                },
              );
            }
            expect(job.prompt.split(guidance)).toHaveLength(2);
            if (runs === 2) {
              throw new SubscriptionWorkerError(
                "subscription_worker_run_failed",
                "Quota limited.",
                { details: { reason: "quota_limited" } },
              );
            }
            return { output: "formal accept" };
          },
        },
        job: { prompt: "Review the patch.", workspacePath },
        originalPrompt: "Review the patch.",
        controlTarget: target,
        controlContinuationJobFactory: ({
          job,
          originalPrompt,
          controlBatch,
        }) => {
          const prompt = `${originalPrompt}\n${controlBatch.message ?? ""}`;
          return { job: { ...job, prompt }, originalPrompt: prompt };
        },
        policy: { maxAttempts },
      });

    const failed = await run(1);
    expect(failed.status).toBe("failed");
    await control.enqueueSignal({
      target,
      intent: "guidance",
      body: guidance,
    });
    const completed = await run(2);
    expect(completed.status).toBe("completed");
    expect(runs).toBe(3);
  });

  it("grants a fresh retry budget when guidance resumes a completed task", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-completed-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    let controlCalls = 0;
    let runs = 0;
    const runner = new SafeExecutionRunner({
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
      controlInbox: {
        async consumeForContinuation(input) {
          controlCalls += 1;
          return controlCalls === 1
            ? {
                target: input.target,
                deliveryAttemptId: input.deliveryAttemptId,
                signals: [],
                signalIds: [],
              }
            : {
                target: input.target,
                deliveryAttemptId: input.deliveryAttemptId,
                signals: [],
                signalIds: ["completed-guidance"],
                message:
                  "Runtime control inbox instructions:\nAdd the assertion.",
              };
        },
      },
    });
    const run = (maxAttempts: number) =>
      runner.run({
        taskId: "task-completed-guidance",
        workspace: { mode: "existing_locked" as const, path: workspacePath },
        effectMode: "workspace_patch" as const,
        provider: "codex",
        pool: {
          async run(job: PromptJob): Promise<PromptResult> {
            runs += 1;
            if (runs === 2) {
              expect(job.prompt).toContain("Add the assertion.");
              throw new SubscriptionWorkerError(
                "subscription_worker_run_failed",
                "Quota limited.",
                { details: { reason: "quota_limited" } },
              );
            }
            if (runs === 3) expect(job.prompt).toContain("Add the assertion.");
            return { output: `run-${runs}` };
          },
        },
        job: { prompt: "Original task.", workspacePath },
        originalPrompt: "Original task.",
        controlContinuationJobFactory: ({
          job,
          originalPrompt,
          controlBatch,
        }) => {
          const prompt = `${originalPrompt}\n${controlBatch.message ?? ""}`;
          return { job: { ...job, prompt }, originalPrompt: prompt };
        },
        policy: { maxAttempts },
      });

    const initial = await run(1);
    expect(initial.status).toBe("completed");
    const resumed = await run(2);
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") throw new Error("expected completed");
    expect(resumed.replayed).toBe(false);
    expect(runs).toBe(3);
    expect(resumed.attempts).toHaveLength(3);
  });

  it("does not replay completed external side effects for pending guidance", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-external-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    const baseOptions = {
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    };
    const initialRunner = new SafeExecutionRunner(baseOptions);
    const initial = await initialRunner.run({
      taskId: "task-external-guidance",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "external_side_effects",
      provider: "codex",
      pool: { run: async () => ({ output: "sent once" }) },
      job: { prompt: "Send once.", workspacePath },
      originalPrompt: "Send once.",
      policy: { maxAttempts: 1 },
    });
    expect(initial.status).toBe("completed");

    let consumed = 0;
    let reruns = 0;
    const resumedRunner = new SafeExecutionRunner({
      ...baseOptions,
      controlInbox: {
        async consumeForContinuation(input) {
          consumed += 1;
          return {
            target: input.target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: [],
            signalIds: ["unsafe-repeat"],
            message: "Repeat the external action.",
          };
        },
      },
    });
    const replay = await resumedRunner.run({
      taskId: "task-external-guidance",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "external_side_effects",
      provider: "codex",
      pool: {
        async run() {
          reruns += 1;
          return { output: "must not run" };
        },
      },
      job: { prompt: "Send once.", workspacePath },
      originalPrompt: "Send once.",
      controlContinuationJobFactory: ({ job, originalPrompt }) => ({
        job,
        originalPrompt,
      }),
      policy: { maxAttempts: 1 },
    });
    expect(replay.status).toBe("completed");
    if (replay.status !== "completed") throw new Error("expected replay");
    expect(replay.replayed).toBe(true);
    expect(consumed).toBe(0);
    expect(reruns).toBe(0);
  });

  it("preserves a completed result when startup is already aborted", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-aborted-guidance-",
    );
    const journal = new InMemoryAttemptJournal();
    const baseOptions = {
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    };
    const initialRunner = new SafeExecutionRunner(baseOptions);
    await initialRunner.run({
      taskId: "task-aborted-guidance",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: { run: async () => ({ output: "original result" }) },
      job: { prompt: "Original.", workspacePath },
      originalPrompt: "Original.",
    });
    const before = await journal.readTask({ taskId: "task-aborted-guidance" });
    const abort = new AbortController();
    abort.abort();
    let consumed = 0;
    const resumedRunner = new SafeExecutionRunner({
      ...baseOptions,
      controlInbox: {
        async consumeForContinuation(input) {
          consumed += 1;
          return {
            target: input.target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: [],
            signalIds: ["aborted-guidance"],
            message: "New guidance.",
          };
        },
      },
    });
    const replay = await resumedRunner.run({
      taskId: "task-aborted-guidance",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: { run: async () => ({ output: "must not run" }) },
      job: { prompt: "Original.", workspacePath },
      originalPrompt: "Original.",
      controlContinuationJobFactory: ({ job, originalPrompt }) => ({
        job,
        originalPrompt,
      }),
      abortSignal: abort.signal,
    });
    expect(replay.status).toBe("completed");
    expect(consumed).toBe(0);
    expect(await journal.readTask({ taskId: "task-aborted-guidance" })).toEqual(
      before,
    );
  });
});
