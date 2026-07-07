export type RunObservationStatus =
  | "running"
  | "stopped"
  | "completed"
  | "blocked"
  | "failed"
  | "unknown";

export type RunObservationLiveness =
  | "alive"
  | "dead"
  | "stale"
  | "unknown";

export type RunReadOnlyDecisionKind =
  | "keep_watching"
  | "review_completed"
  | "manual_review_required"
  | "capacity_blocked"
  | "stale_needs_inspection"
  | "unsafe_state_mismatch";

export type RunObservationWarning = {
  readonly code: string;
  readonly message: string;
  readonly severity?: "info" | "warning" | "blocked" | "critical";
};

export type RunObservationWorkspace = {
  readonly path?: string;
  readonly key?: string;
  readonly exists?: boolean;
  readonly dirty?: boolean;
  readonly changedFilesCount?: number;
  readonly changedFiles?: readonly string[];
  readonly warning?: string;
};

export type RunObservationProgress = {
  readonly status?: string;
  readonly updatedAt?: string;
  readonly heartbeatAgeMs?: number;
  readonly staleAfterMs?: number;
  readonly stale?: boolean;
  readonly silentStale?: boolean;
  readonly heartbeatOnlyNoOutput?: boolean;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
};

export type RunObservationResult = {
  readonly exists?: boolean;
  readonly status?: string;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly updatedAt?: string;
  readonly path?: string;
  readonly warning?: string;
};

export type RunLogExcerpt = {
  readonly path?: string;
  readonly exists?: boolean;
  readonly updatedAt?: string;
  readonly updatedAgeMs?: number;
  readonly staleAfterMs?: number;
  readonly stale?: boolean;
  readonly byteLength?: number;
  readonly tailLines?: number;
  readonly tail?: string;
  readonly truncated?: boolean;
  readonly warning?: string;
};

export type RunCapacityHint = {
  readonly account?: string;
  readonly status?: string;
  readonly availability?: string;
  readonly reason?: string;
  readonly cooldownUntil?: string;
  readonly warning?: string;
};

export type RunControlInboxSummary = {
  readonly pendingCount?: number;
  readonly acceptedCount?: number;
  readonly deliverableCount?: number;
  readonly deliveredCount?: number;
  readonly failedCount?: number;
  readonly latestSignalAt?: string;
  readonly latestDeliveredAt?: string;
  readonly blockedDeliveryCount?: number;
  readonly safeToContinue?: boolean;
};

export type RunReadOnlyDecision = {
  readonly kind: RunReadOnlyDecisionKind;
  readonly reason: string;
  readonly safeMessage: string;
  readonly evidence?: readonly string[];
};

export function decideRunObservation(input: {
  readonly status: RunObservationStatus;
  readonly liveness: RunObservationLiveness;
  readonly workspace?: RunObservationWorkspace;
  readonly progress?: RunObservationProgress;
  readonly result?: RunObservationResult;
  readonly logs?: RunLogExcerpt;
  readonly capacity?: readonly RunCapacityHint[];
  readonly controlInbox?: RunControlInboxSummary;
  readonly manualReviewReasons?: readonly string[];
  readonly warnings?: readonly RunObservationWarning[];
}): RunReadOnlyDecision {
  if (input.status === "completed" && input.liveness === "alive") {
    return decision(
      "unsafe_state_mismatch",
      "completed_result_with_live_process",
      "A terminal result exists while the worker still appears alive. Inspect process, result and journal before acting.",
      ["result.status", "process.liveness"],
    );
  }
  if (input.status !== "running" && input.progress?.status === "running") {
    return decision(
      "unsafe_state_mismatch",
      "stopped_run_with_running_progress",
      "The normalized status and progress file disagree. Inspect status sources before acting.",
      ["status", "progress.status"],
    );
  }
  if (input.liveness === "stale" || input.progress?.silentStale) {
    return decision(
      "stale_needs_inspection",
      "observable_progress_stale",
      "The worker may be alive, but observable progress is stale. Inspect logs, process tree and workspace before acting.",
      ["progress.heartbeatAgeMs", "progress.staleAfterMs"],
    );
  }
  if (input.progress?.heartbeatOnlyNoOutput) {
    return decision(
      "stale_needs_inspection",
      "heartbeat_only_no_output",
      "The worker heartbeat is fresh, but there is no result, log output or workspace change. Inspect process tree, app-server and workspace before stopping or recovery.",
      ["progress.heartbeatAgeMs", "logs.byteLength", "result.exists", "workspace.changedFiles"],
    );
  }
  if (input.status === "completed") {
    return decision(
      "review_completed",
      "terminal_result_completed",
      "The run appears completed. Review outputs, logs and workspace before merging or marking reviewed.",
      ["result.status", "workspace.changedFiles"],
    );
  }
  if (input.capacity && hasOnlyBlockedCapacity(input.capacity)) {
    return decision(
      "capacity_blocked",
      "account_or_capacity_unavailable",
      "At least one account or capacity hint is blocked. Wait, relogin, or let a separate decision layer choose recovery.",
      ["capacity"],
    );
  }
  if ((input.manualReviewReasons ?? []).length > 0) {
    return decision(
      "manual_review_required",
      input.manualReviewReasons?.[0] ?? "manual_review_required",
      "This run requires manual review. Watch remains read-only and will not start, stop or continue it.",
      ["manualReviewReasons"],
    );
  }
  if (input.workspace?.dirty && input.status !== "running") {
    return decision(
      "manual_review_required",
      "dirty_workspace_without_running_worker",
      "The workspace has changes and no active worker. Review the diff before taking any control action.",
      ["workspace.changedFiles"],
    );
  }
  if (input.status === "stopped") {
    return decision(
      "manual_review_required",
      "stopped_without_terminal_result",
      "The run is stopped without a completed or failed terminal result. Inspect result, logs and workspace before any recovery.",
      ["status", "result.exists", "process.liveness"],
    );
  }
  if (input.status === "failed" || input.status === "unknown") {
    return decision(
      "manual_review_required",
      input.result?.reason ?? "non_running_or_unknown_failure",
      "The run is failed or unknown. Inspect result, logs and workspace before any recovery.",
      ["result.reason", "status"],
    );
  }
  if ((input.controlInbox?.pendingCount ?? 0) > 0) {
    return decision(
      "keep_watching",
      "guidance_pending",
      "Control inbox guidance is pending. Continue watching until the next safe continuation or operator action.",
      ["controlInbox.pendingCount", "controlInbox.safeToContinue"],
    );
  }
  if ((input.controlInbox?.deliveredCount ?? 0) > 0) {
    return decision(
      "keep_watching",
      "guidance_delivered",
      "Control inbox guidance was delivered. Continue watching the worker result.",
      ["controlInbox.deliveredCount", "controlInbox.latestDeliveredAt"],
    );
  }
  return decision(
    "keep_watching",
    "worker_observable",
    "The run is observable. Continue watching; no control action is implied by this read-only snapshot.",
    ["liveness", "progress"],
  );
}

function decision(
  kind: RunReadOnlyDecisionKind,
  reason: string,
  safeMessage: string,
  evidence?: readonly string[],
): RunReadOnlyDecision {
  return {
    kind,
    reason,
    safeMessage,
    ...(evidence ? { evidence } : {}),
  };
}

function isBlockedCapacity(hint: RunCapacityHint): boolean {
  return hint.status === "auth_missing" ||
    hint.status === "auth_invalid" ||
    hint.availability === "cooldown" ||
    hint.availability === "quota_exhausted" ||
    hint.availability === "disabled";
}

function hasOnlyBlockedCapacity(capacity: readonly RunCapacityHint[]): boolean {
  return capacity.length > 0 && capacity.every((hint) => isBlockedCapacity(hint));
}
