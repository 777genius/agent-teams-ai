import type {
  RunObservationLiveness,
  RunObservationStatus,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalStatus } from "../codex-goal-ops";

export function codexGoalOrphanRunStatus(input: {
  readonly status: CodexGoalStatus;
  readonly workerAlive: boolean;
}): RunObservationStatus {
  if (input.status.resultStatus === "done" || input.status.resultStatus === "completed") {
    return "completed";
  }
  if (input.status.resultStatus === "failed") return "failed";
  if (input.workerAlive && input.status.progressStatus === "running") return "running";
  if (input.workerAlive) return "running";
  return "unknown";
}

export function codexGoalOrphanLiveness(input: {
  readonly workerAlive: boolean;
  readonly progressStale: boolean;
  readonly logStale: boolean;
}): RunObservationLiveness {
  if (!input.workerAlive) return "dead";
  return input.progressStale || input.logStale ? "stale" : "alive";
}

export function codexGoalOrphanManualReviewReasons(input: {
  readonly heartbeatOnlyNoOutput: boolean;
}): readonly string[] {
  return [
    "missing_job_manifest",
    ...(input.heartbeatOnlyNoOutput ? ["heartbeat_only_no_output"] : []),
  ];
}
