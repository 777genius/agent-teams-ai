import { describe, expect, it } from "vitest";
import {
  reconcileRunPreview,
  type RunReconcilePreviewBackend,
  type RunReconcilePreviewStatus,
} from "../index";
import { reconcileWatchableJobs } from "../job-watch";

describe("reconcileRunPreview", () => {
  it("continues only safe stopped runs within the configured budget", async () => {
    const continued: string[] = [];
    const backend = fakeBackend([
      run({ runId: "running", workerAlive: true }),
      run({ runId: "safe-a", safeToContinue: true }),
      run({ runId: "safe-b", safeToContinue: true }),
      run({ runId: "dirty", safeToContinue: true, workspaceDirty: true }),
    ], continued);

    const result = await reconcileRunPreview({
      backend,
      policy: {
        continueSafeRuns: true,
        maxContinuesPerRun: 1,
      },
    });

    expect(result.continued).toBe(1);
    expect(continued).toEqual(["safe-a"]);
    expect(result.decisions.map((decision) => [
      decision.runId,
      decision.action,
      decision.reason,
    ])).toEqual([
      ["running", "wait", "worker_alive"],
      ["safe-a", "continued", "safe_to_continue"],
      ["safe-b", "skipped", "max_continues_reached"],
      ["dirty", "manual_review", "workspace_dirty"],
    ]);
  });

  it("blocks multiple potential writers for the same workspace", async () => {
    const continued: string[] = [];
    const backend = fakeBackend([
      run({ runId: "safe-a", safeToContinue: true, workspaceKey: "/work" }),
      run({ runId: "safe-b", safeToContinue: true, workspaceKey: "/work" }),
    ], continued);

    const result = await reconcileRunPreview({
      backend,
      policy: {
        continueSafeRuns: true,
        maxContinuesPerRun: 2,
      },
    });

    expect(result.continued).toBe(0);
    expect(continued).toEqual([]);
    expect(result.decisions.map((decision) => [
      decision.runId,
      decision.action,
      decision.reason,
    ])).toEqual([
      ["safe-a", "blocked", "single_writer_workspace_conflict"],
      ["safe-b", "blocked", "single_writer_workspace_conflict"],
    ]);
  });

  it("supports dry-run reconciliation without continuing runs", async () => {
    const continued: string[] = [];
    const backend = fakeBackend([
      run({ runId: "safe", safeToContinue: true }),
    ], continued);

    const result = await reconcileRunPreview({ backend });

    expect(result.continued).toBe(0);
    expect(continued).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      runId: "safe",
      action: "would_continue",
      reason: "dry_run",
    });
  });

  it("keeps the old job-watch API as a deprecated compatibility shim", async () => {
    const result = await reconcileWatchableJobs({
      backend: {
        async listJobIds() {
          return ["job-a"];
        },
        async inspectJob(jobId) {
          return {
            jobId,
            workerAlive: false,
            safeToContinue: true,
          };
        },
        async continueJob(jobId) {
          return { ok: true, summary: { jobId } };
        },
      },
    });

    expect(result.decisions[0]).toMatchObject({
      jobId: "job-a",
      action: "would_continue",
      reason: "dry_run",
    });
  });
});

function fakeBackend(
  statuses: readonly RunReconcilePreviewStatus[],
  continued: string[],
): RunReconcilePreviewBackend {
  const byId = new Map(statuses.map((status) => [status.runId, status]));
  return {
    async listRunIds() {
      return [...byId.keys()];
    },
    async inspectRun(runId) {
      const status = byId.get(runId);
      if (!status) throw new Error(`missing run ${runId}`);
      return status;
    },
    async continueRun(runId) {
      continued.push(runId);
      return {
        ok: true,
        summary: { runId },
      };
    },
  };
}

function run(input: {
  readonly runId: string;
  readonly workerAlive?: boolean;
  readonly safeToContinue?: boolean;
  readonly workspaceKey?: string;
  readonly workspaceDirty?: boolean;
}): RunReconcilePreviewStatus {
  return {
    runId: input.runId,
    workerAlive: input.workerAlive ?? false,
    safeToContinue: input.safeToContinue ?? false,
    ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
    ...(input.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: input.workspaceDirty }),
  };
}
