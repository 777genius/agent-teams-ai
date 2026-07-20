import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../../../worker-local/safe-execution";
import {
  InMemoryAttemptJournal,
  InMemoryWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  WorkerControlService,
  type WorkerControlContinuationBatch,
} from "../../index";
import {
  cleanupTemporaryPaths,
  gitWorkspace,
  InMemoryWorkerControlInboxStore,
  sequentialIds,
  type PromptJob,
  type PromptResult,
} from "./safe-execution-test-support";

describe("SafeExecutionRunner deferred guidance", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await cleanupTemporaryPaths(cleanupPaths);
  });

  it("releases mid-run guidance when the next provider attempt never starts", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-mid-run-control-",
    );
    const store = new InMemoryWorkerControlInboxStore();
    const control = new WorkerControlService({
      store,
      idFactory: sequentialIds("mid-run-control"),
    });
    const target = {
      jobId: "job-mid-run-control",
      taskId: "task-mid-run-control",
      workspaceId: workspacePath,
    };
    let runs = 0;
    const runner = new SafeExecutionRunner({
      snapshotter: new DefaultWorkspaceSnapshotter(),
      workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
      runtime: new NodeSafeExecutionRuntime(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      controlInbox: control,
    });
    const controlContinuationJobFactory = ({
      job,
      originalPrompt,
      controlBatch,
    }: {
      readonly job: PromptJob;
      readonly originalPrompt: string;
      readonly controlBatch: WorkerControlContinuationBatch;
    }) => {
      const prompt = `${originalPrompt}\n${controlBatch.message ?? ""}`;
      return { job: { ...job, prompt }, originalPrompt: prompt };
    };

    const interrupted = await runner.run({
      taskId: target.taskId,
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          runs += 1;
          if (runs === 1) {
            await control.enqueueSignal({
              target,
              intent: "guidance",
              body: "Preserve the admitted immutable patch.",
            });
            throw new SubscriptionWorkerError(
              "subscription_worker_run_failed",
              "Quota limited.",
              { details: { reason: "quota_limited" } },
            );
          }
          expect(job.prompt).toContain("Preserve the admitted immutable patch.");
          throw new SubscriptionWorkerError(
            "subscription_worker_account_unavailable",
            "Account unavailable before provider task start.",
          );
        },
      },
      job: { prompt: "Review the patch.", workspacePath },
      originalPrompt: "Review the patch.",
      controlTarget: target,
      controlContinuationJobFactory,
      policy: { maxAttempts: 2 },
    });
    expect(interrupted.status).toBe("waiting_capacity");
    expect((await control.listSignals({ target }))[0]?.state).toBe("pending");

    const completed = await runner.run({
      taskId: target.taskId,
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob, options): Promise<PromptResult> {
          expect(job.prompt).toContain("Preserve the admitted immutable patch.");
          await options?.onProviderTaskStarted?.();
          return { output: "formal accept" };
        },
      },
      job: { prompt: "Review the patch.", workspacePath },
      originalPrompt: "Review the patch.",
      controlTarget: target,
      controlContinuationJobFactory,
      policy: { maxAttempts: 1 },
    });
    expect(completed.status).toBe("completed");
    expect((await control.listSignals({ target }))[0]?.state).toBe("delivered");
    expect(
      (await store.listReceipts({ target }))
        .filter((receipt) => receipt.state === "delivered"),
    ).toHaveLength(1);
  });
});
