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
} from "../../index";
import {
  cleanupTemporaryPaths,
  gitWorkspace,
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
      controlContinuationJobFactory: ({ job, originalPrompt, controlBatch }) => {
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
                message: "Runtime control inbox instructions:\nAdd the assertion.",
              };
        },
      },
    });
    const run = (maxAttempts: number) => runner.run({
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
      controlContinuationJobFactory: ({ job, originalPrompt, controlBatch }) => {
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
