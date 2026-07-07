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

  it("reports cooldown before generic unsafe status for parked capacity runs", async () => {
    const continued: string[] = [];
    const continueAfter = new Date("2026-06-01T01:00:00.000Z");
    const backend = fakeBackend([
      run({
        runId: "parked-capacity",
        safeToContinue: false,
        continueAfter,
      }),
    ], continued);

    const result = await reconcileRunPreview({
      backend,
      policy: {
        continueSafeRuns: true,
        now: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    expect(result.continued).toBe(0);
    expect(continued).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      runId: "parked-capacity",
      action: "skipped",
      reason: "continue_cooldown",
      status: {
        continueAfter,
      },
    });
  });

  it("preserves manual-review guidance for app-server blocked runs", async () => {
    const continued: string[] = [];
    const backend = fakeBackend([
      run({
        runId: "blocked-controller",
        safeToContinue: true,
        requiresManualReview: true,
        manualReviewReason: "app_server_goal_blocked",
      }),
    ], continued);

    const result = await reconcileRunPreview({
      backend,
      policy: {
        continueSafeRuns: true,
      },
    });

    expect(result.continued).toBe(0);
    expect(continued).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      runId: "blocked-controller",
      action: "manual_review",
      reason: "app_server_goal_blocked",
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
  readonly requiresManualReview?: boolean;
  readonly manualReviewReason?: string;
  readonly continueAfter?: Date;
}): RunReconcilePreviewStatus {
  return {
    runId: input.runId,
    workerAlive: input.workerAlive ?? false,
    safeToContinue: input.safeToContinue ?? false,
    ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
    ...(input.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: input.workspaceDirty }),
    ...(input.requiresManualReview === undefined
      ? {}
      : { requiresManualReview: input.requiresManualReview }),
    ...(input.manualReviewReason === undefined
      ? {}
      : { manualReviewReason: input.manualReviewReason }),
    ...(input.continueAfter === undefined
      ? {}
      : { continueAfter: input.continueAfter }),
  };
}
