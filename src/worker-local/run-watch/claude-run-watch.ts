import {
  RunObservationService,
  RunEventProviderKind,
  decideRunObservation,
  type RunObservationSnapshot,
  type RunObservationWarning,
} from "@vioxen/subscription-runtime/worker-core";
import { ClaudeRunObservationAdapter } from "../../worker-claude/claude-run-observation";

export type ClaudeRunWatchArgs = {
  readonly stateRootDir?: string;
  readonly runArtifactsRootDir?: string;
  readonly jobId?: string;
  readonly jobIds?: string | readonly string[];
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly limit?: number;
  readonly includeChangedFiles?: boolean;
  readonly includeLogTail?: boolean;
};

export async function watchClaudeRuns(args: ClaudeRunWatchArgs): Promise<Record<string, unknown>> {
  const adapter = new ClaudeRunObservationAdapter({
    ...(args.stateRootDir === undefined ? {} : { stateRootDir: args.stateRootDir }),
    ...(args.runArtifactsRootDir === undefined
      ? {}
      : { runArtifactsRootDir: args.runArtifactsRootDir }),
    ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
    ...(args.tailLines === undefined ? {} : { tailLines: args.tailLines }),
  });
  const service = new RunObservationService(adapter);
  const explicitRunIds = [
    ...(args.jobId ? [args.jobId] : []),
    ...jobIdsFromValue(args.jobIds),
  ];
  const listedRunIds = explicitRunIds.length
    ? explicitRunIds
    : await service.listRunIds();
  const runIds = args.limit === undefined
    ? listedRunIds
    : listedRunIds.slice(0, args.limit);
  const snapshots = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return await service.observeRun({
          runId,
          ...(args.tailLines === undefined ? {} : { tailLines: args.tailLines }),
          includeChangedFiles: args.includeChangedFiles === true,
          includeLogTail: args.includeLogTail === true,
        });
      } catch (error) {
        return failedRunObservationSnapshot({
          runId,
          error,
        });
      }
    }),
  );
  const observationFailures = snapshots
    .filter((snapshot) =>
      snapshot.warnings.some((warning) => warning.code === "run_observation_failed")
    )
    .map((snapshot) => ({
      runId: snapshot.runId,
      warnings: snapshot.warnings.filter((warning) =>
        warning.code === "run_observation_failed"
      ),
    }));
  return {
    ok: observationFailures.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind: RunEventProviderKind.Claude,
    ...(args.stateRootDir === undefined ? {} : { stateRootDir: args.stateRootDir }),
    ...(args.runArtifactsRootDir === undefined
      ? {}
      : { runArtifactsRootDir: args.runArtifactsRootDir }),
    totalRuns: listedRunIds.length,
    returnedRuns: snapshots.length,
    truncated: args.limit === undefined ? false : listedRunIds.length > runIds.length,
    summary: summarizeRunObservationSnapshots(snapshots),
    ...(observationFailures.length ? { observationFailures } : {}),
    snapshots,
  };
}

function failedRunObservationSnapshot(input: {
  readonly runId: string;
  readonly error: unknown;
}): RunObservationSnapshot {
  const warnings: readonly RunObservationWarning[] = [{
    code: "run_observation_failed",
    message: input.error instanceof Error ? input.error.message : String(input.error),
    severity: "warning",
  }];
  const manualReviewReasons = ["run_observation_failed"];
  return {
    runId: input.runId,
    providerKind: RunEventProviderKind.Claude,
    observedAt: new Date().toISOString(),
    status: "unknown",
    liveness: "unknown",
    warnings,
    manualReviewReasons,
    readOnlyDecision: decideRunObservation({
      status: "unknown",
      liveness: "unknown",
      manualReviewReasons,
      warnings,
    }),
  };
}

function summarizeRunObservationSnapshots(
  snapshots: readonly { readonly status: string; readonly liveness: string; readonly readOnlyDecision: { readonly kind: string }; readonly warnings: readonly unknown[] }[],
): Record<string, number> {
  return {
    running: snapshots.filter((snapshot) => snapshot.status === "running").length,
    completed: snapshots.filter((snapshot) => snapshot.status === "completed").length,
    failed: snapshots.filter((snapshot) => snapshot.status === "failed").length,
    stopped: snapshots.filter((snapshot) => snapshot.status === "stopped").length,
    unknown: snapshots.filter((snapshot) => snapshot.status === "unknown").length,
    alive: snapshots.filter((snapshot) => snapshot.liveness === "alive").length,
    stale: snapshots.filter((snapshot) => snapshot.liveness === "stale").length,
    manualReview: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "manual_review_required"
    ).length,
    capacityBlocked: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "capacity_blocked"
    ).length,
    unsafeStateMismatch: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "unsafe_state_mismatch"
    ).length,
    warnings: snapshots.reduce((count, snapshot) => count + snapshot.warnings.length, 0),
  };
}

function jobIdsFromValue(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") return value;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
