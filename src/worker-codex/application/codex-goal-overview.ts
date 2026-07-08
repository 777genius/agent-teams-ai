import {
  reconcileRunPreview,
  type RunReconcilePreviewDecision,
} from "@vioxen/subscription-runtime/worker-core";
import {
  listCodexGoalJobs,
} from "../codex-goal-jobs";
import {
  registryRootFromInput,
  type CodexGoalJobLifecycleInput,
  type CodexGoalJobOverviewInput,
  type CodexGoalJobWatchInput,
} from "./codex-goal-use-case-inputs";
import {
  booleanValue,
  numberValue,
  stringValue,
} from "./codex-goal-input-values";
import {
  jobIdsFromValue,
} from "./codex-goal-worker-control-view";
import { buildCodexGoalOverviewItem } from "./codex-goal-overview-item";
import {
  codexOverviewItemToWatchStatus,
} from "./codex-goal-watch-status";
import {
  applyWorkspaceConflictToOverviewJob,
  buildCodexGoalWorkspaceConflicts,
  workspaceConflictJobIds,
} from "./codex-goal-workspace-conflicts";

type JsonObject = Readonly<Record<string, unknown>>;

type ContinueStoredJob = (
  args: CodexGoalJobLifecycleInput,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
) => Promise<JsonObject>;

export type CodexGoalOverviewDeps = {
  readonly continueStoredJob: ContinueStoredJob;
};

export async function buildCodexGoalOverviewView(
  args: CodexGoalJobOverviewInput,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromInput(args);
  const summaries = await listCodexGoalJobs({ registryRootDir });
  const jobIdPrefix = stringValue(args.jobIdPrefix);
  const matchingSummaries = jobIdPrefix
    ? summaries.filter((summary) => summary.jobId.startsWith(jobIdPrefix))
    : summaries;
  const limit = numberValue(args.limit);
  const selectedSummaries = limit ? matchingSummaries.slice(0, limit) : matchingSummaries;
  const staleAfterMs = numberValue(args.staleAfterMs) ?? 10 * 60_000;
  const tailLines = numberValue(args.tailLines) ?? 5;
  const rawJobs = await Promise.all(
    selectedSummaries.map((summary) =>
      buildCodexGoalOverviewItem({
        registryRootDir,
        jobId: summary.jobId,
        staleAfterMs,
        tailLines,
      })
    ),
  );
  const workspaceConflicts = await buildCodexGoalWorkspaceConflicts(rawJobs);
  const conflictJobIds = workspaceConflictJobIds(workspaceConflicts);
  const jobs = rawJobs.map((job) => applyWorkspaceConflictToOverviewJob({
    job,
    conflictJobIds,
  }));
  const okJobs = jobs.filter((job) => job.ok);
  return {
    ok: jobs.every((job) => job.ok),
    safeToOperate: workspaceConflicts.length === 0,
    registryRootDir,
    ...(jobIdPrefix ? { jobIdPrefix } : {}),
    totalJobs: summaries.length,
    ...(jobIdPrefix ? { matchedJobs: matchingSummaries.length } : {}),
    returnedJobs: jobs.length,
    truncated: selectedSummaries.length < matchingSummaries.length,
    summary: {
      running: okJobs.filter((job) => job.workerAlive).length,
      silentStale: okJobs.filter((job) => job.silentStale).length,
      safeToContinue: okJobs.filter((job) => job.safeToContinue).length,
      needsHumanRelogin: okJobs.filter((job) => job.needsHumanRelogin).length,
      manualReview: okJobs.filter((job) => job.nextBestTool === "manual_review").length,
      completed: okJobs.filter((job) => job.resultStatus === "completed").length,
      workspaceConflicts: workspaceConflicts.length,
      blockedBySingleWriter: okJobs.filter((job) => job.blockedBySingleWriter).length,
      unavailable: jobs.filter((job) => !job.ok).length,
    },
    workspaceConflicts,
    jobs,
  };
}

export async function reconcilePreviewCodexGoalJobsView(
  args: CodexGoalJobWatchInput,
  deps: CodexGoalOverviewDeps,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromInput(args);
  const staleAfterMs = numberValue(args.staleAfterMs) ?? 10 * 60_000;
  const tailLines = numberValue(args.tailLines) ?? 5;
  const explicitJobIds = jobIdsFromValue(args.jobIds);
  const result = await reconcileRunPreview({
    ...(explicitJobIds.length ? { runIds: explicitJobIds } : {}),
    policy: {
      continueSafeRuns: booleanValue(args.continueSafeJobs) === true,
      maxContinuesPerRun: numberValue(args.maxContinuesPerRun) ?? 1,
    },
    backend: {
      async listRunIds() {
        return (await listCodexGoalJobs({ registryRootDir }))
          .map((summary) => summary.jobId);
      },
      async inspectRun(jobId) {
        const item = await buildCodexGoalOverviewItem({
          registryRootDir,
          jobId,
          staleAfterMs,
          tailLines,
        });
        return codexOverviewItemToWatchStatus(item);
      },
      async continueRun(jobId) {
        const summary = await deps.continueStoredJob({
          registryRootDir,
          jobId,
          confirmContinue: true,
          ...(booleanValue(args.skipDoctor) === true ? { skipDoctor: true } : {}),
        }, {
          confirmKey: "confirmContinue",
          mode: "continue",
        });
        return {
          ok: summary.ok === true,
          ...(typeof summary.reason === "string" ? { reason: summary.reason } : {}),
          summary,
        };
      },
    },
  });
  return {
    ok: true,
    safeToOperate: result.ok,
    registryRootDir,
    mode: booleanValue(args.continueSafeJobs) === true
      ? "continue_safe_jobs"
      : "dry_run",
    checked: result.checked,
    continued: result.continued,
    decisions: result.decisions.map(reconcilePreviewDecisionJson),
  };
}

function reconcilePreviewDecisionJson(
  decision: RunReconcilePreviewDecision,
): JsonObject {
  if ("status" in decision) {
    return {
      ...decision,
      jobId: decision.runId,
      status: {
        ...decision.status,
        jobId: decision.runId,
      },
    };
  }
  return {
    ...decision,
    jobId: decision.runId,
  };
}
