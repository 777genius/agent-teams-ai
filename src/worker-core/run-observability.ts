import {
  actionForRuntimeState,
  classifyRuntimeRunState,
  type RunProgressClassification,
  type RuntimeRecommendedAction,
} from "./runtime-result";

export type RunObservationStatus =
  | "running"
  | "stopped"
  | "completed"
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

export type RunObservationProcess = {
  readonly supervisor?: string;
  readonly sessionId?: string;
  readonly alive?: boolean;
  readonly pid?: number;
  readonly appServerPid?: number;
  readonly cpuActive?: boolean;
  readonly command?: string;
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

export type RunArtifactSummary = {
  readonly kind: string;
  readonly path?: string;
  readonly exists?: boolean;
  readonly updatedAt?: string;
  readonly byteLength?: number;
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

export type RunObservationSnapshot = {
  readonly runId: string;
  readonly providerKind: string;
  readonly observedAt: string;
  readonly status: RunObservationStatus;
  readonly liveness: RunObservationLiveness;
  readonly classification?: RunProgressClassification;
  readonly recommendedAction?: RuntimeRecommendedAction;
  readonly workspace?: RunObservationWorkspace;
  readonly process?: RunObservationProcess;
  readonly progress?: RunObservationProgress;
  readonly result?: RunObservationResult;
  readonly logs?: RunLogExcerpt;
  readonly artifacts?: readonly RunArtifactSummary[];
  readonly capacity?: readonly RunCapacityHint[];
  readonly controlInbox?: RunControlInboxSummary;
  readonly manualReviewReasons?: readonly string[];
  readonly warnings: readonly RunObservationWarning[];
  readonly readOnlyDecision: RunReadOnlyDecision;
};

export type RunObservationPort = {
  listRunIds?(): Promise<readonly string[]>;
  observeRun(input: RunObservationRequest): Promise<RunObservationSnapshot>;
};

export type RunObservationRequest = {
  readonly runId: string;
  readonly tailLines?: number;
  readonly includeLogTail?: boolean;
  readonly includeChangedFiles?: boolean;
};

export type RunObservationHistoryEntry = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerKind: string;
  readonly observedAt: string;
  readonly workspaceDirty?: boolean;
  readonly changedFilesCount?: number;
  readonly workspaceSignature?: string;
  readonly resultExists?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly resultUpdatedAt?: string;
  readonly logUpdatedAt?: string;
  readonly logByteLength?: number;
};

export type RunObservationGrowth = {
  readonly previousObservedAt?: string;
  readonly logGrew: boolean;
  readonly resultChanged: boolean;
  readonly workspaceChanged: boolean;
  readonly anyGrowth: boolean;
};

export type RunObservationHistoryStorePort = {
  readObservation(runId: string): Promise<RunObservationHistoryEntry | null>;
  writeObservation(entry: RunObservationHistoryEntry): Promise<void>;
};

export type RunObservationServiceOptions = {
  readonly clock?: { now(): Date };
};

export class RunObservationService {
  private readonly clock: { now(): Date };

  constructor(
    private readonly port: RunObservationPort,
    options: RunObservationServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  async observeRun(input: RunObservationRequest): Promise<RunObservationSnapshot> {
    return normalizeRunObservation({
      snapshot: await this.port.observeRun(input),
      observedAt: this.clock.now(),
    });
  }

  async observeRuns(input: {
    readonly runIds?: readonly string[];
    readonly tailLines?: number;
    readonly includeLogTail?: boolean;
    readonly includeChangedFiles?: boolean;
  } = {}): Promise<readonly RunObservationSnapshot[]> {
    const runIds = input.runIds ?? await this.listRunIds();
    return Promise.all(
      runIds.map((runId) =>
        this.observeRun({
          runId,
          ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
          ...(input.includeLogTail === undefined
            ? {}
            : { includeLogTail: input.includeLogTail }),
          ...(input.includeChangedFiles === undefined
            ? {}
            : { includeChangedFiles: input.includeChangedFiles }),
        })
      ),
    );
  }

  async listRunIds(): Promise<readonly string[]> {
    if (!this.port.listRunIds) return [];
    return this.port.listRunIds();
  }
}

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
  if (input.capacity?.some((hint) => isBlockedCapacity(hint)) === true) {
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

export function runObservationHistoryEntryFromSnapshot(
  snapshot: Pick<
    RunObservationSnapshot,
    "runId" | "providerKind" | "observedAt" | "workspace" | "result" | "logs"
  >,
): RunObservationHistoryEntry {
  const signature = workspaceSignature(snapshot.workspace);
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    providerKind: snapshot.providerKind,
    observedAt: snapshot.observedAt,
    ...(snapshot.workspace?.dirty === undefined
      ? {}
      : { workspaceDirty: snapshot.workspace.dirty }),
    ...(snapshot.workspace?.changedFilesCount === undefined
      ? {}
      : { changedFilesCount: snapshot.workspace.changedFilesCount }),
    ...(signature === undefined ? {} : { workspaceSignature: signature }),
    ...(snapshot.result?.exists === undefined ? {} : { resultExists: snapshot.result.exists }),
    ...(snapshot.result?.status === undefined ? {} : { resultStatus: snapshot.result.status }),
    ...(snapshot.result?.reason === undefined ? {} : { resultReason: snapshot.result.reason }),
    ...(snapshot.result?.updatedAt === undefined
      ? {}
      : { resultUpdatedAt: snapshot.result.updatedAt }),
    ...(snapshot.logs?.updatedAt === undefined ? {} : { logUpdatedAt: snapshot.logs.updatedAt }),
    ...(snapshot.logs?.byteLength === undefined
      ? {}
      : { logByteLength: snapshot.logs.byteLength }),
  };
}

export function compareRunObservationHistory(
  previous: RunObservationHistoryEntry | null,
  current: RunObservationHistoryEntry,
): RunObservationGrowth {
  if (!previous) {
    return {
      logGrew: false,
      resultChanged: false,
      workspaceChanged: false,
      anyGrowth: false,
    };
  }
  const logGrew = current.logByteLength !== undefined &&
    previous.logByteLength !== undefined &&
    current.logByteLength > previous.logByteLength;
  const resultChanged = changed(previous.resultExists, current.resultExists) ||
    changed(previous.resultStatus, current.resultStatus) ||
    changed(previous.resultReason, current.resultReason) ||
    changed(previous.resultUpdatedAt, current.resultUpdatedAt);
  const workspaceChanged = changed(previous.workspaceDirty, current.workspaceDirty) ||
    changed(previous.changedFilesCount, current.changedFilesCount) ||
    changed(previous.workspaceSignature, current.workspaceSignature);
  return {
    previousObservedAt: previous.observedAt,
    logGrew,
    resultChanged,
    workspaceChanged,
    anyGrowth: logGrew || resultChanged || workspaceChanged,
  };
}

function normalizeRunObservation(input: {
  readonly snapshot: RunObservationSnapshot;
  readonly observedAt: Date;
}): RunObservationSnapshot {
  const manualReviewReasons = input.snapshot.manualReviewReasons ?? [];
  const warnings = input.snapshot.warnings ?? [];
  const classification = input.snapshot.classification ??
    classifyRuntimeRunState({
      status: input.snapshot.status,
      liveness: input.snapshot.liveness,
      workspaceDirty: input.snapshot.workspace?.dirty,
      changedFilesCount: input.snapshot.workspace?.changedFilesCount,
      processAlive: input.snapshot.process?.alive,
      processCpuActive: input.snapshot.process?.cpuActive,
      processCommand: input.snapshot.process?.command,
      progressStatus: input.snapshot.progress?.status,
      progressStale: input.snapshot.progress?.stale,
      progressSilentStale: input.snapshot.progress?.silentStale,
      heartbeatOnlyNoOutput: input.snapshot.progress?.heartbeatOnlyNoOutput,
      resultExists: input.snapshot.result?.exists,
      resultStatus: input.snapshot.result?.status,
      resultReason: input.snapshot.result?.reason,
      logStale: input.snapshot.logs?.stale,
      logByteLength: input.snapshot.logs?.byteLength,
      capacity: input.snapshot.capacity,
      controlInboxPendingCount: input.snapshot.controlInbox?.pendingCount,
    });
  const recommendedAction = input.snapshot.recommendedAction ??
    actionForRuntimeState({
      status: runtimeStatusForObservation({
        status: input.snapshot.status,
        resultStatus: input.snapshot.result?.status,
        workspaceDirty: input.snapshot.workspace?.dirty,
        changedFilesCount: input.snapshot.workspace?.changedFilesCount,
      }),
      classification,
      reason: input.snapshot.result?.reason,
      changedFilesCount: input.snapshot.workspace?.changedFilesCount,
    });
  const readOnlyDecision = input.snapshot.readOnlyDecision ??
    decideRunObservation({
      status: input.snapshot.status,
      liveness: input.snapshot.liveness,
      ...(input.snapshot.workspace === undefined
        ? {}
        : { workspace: input.snapshot.workspace }),
      ...(input.snapshot.progress === undefined
        ? {}
        : { progress: input.snapshot.progress }),
      ...(input.snapshot.result === undefined
        ? {}
        : { result: input.snapshot.result }),
      ...(input.snapshot.logs === undefined
        ? {}
        : { logs: input.snapshot.logs }),
      ...(input.snapshot.capacity === undefined
        ? {}
        : { capacity: input.snapshot.capacity }),
      ...(input.snapshot.controlInbox === undefined
        ? {}
        : { controlInbox: input.snapshot.controlInbox }),
      manualReviewReasons,
      warnings,
    });
  return {
    ...input.snapshot,
    observedAt: input.snapshot.observedAt || input.observedAt.toISOString(),
    classification,
    recommendedAction,
    manualReviewReasons,
    warnings,
    readOnlyDecision,
  };
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

function workspaceSignature(
  workspace: RunObservationWorkspace | undefined,
): string | undefined {
  if (!workspace) return undefined;
  const changedFiles = workspace.changedFiles?.slice().sort((left, right) =>
    left.localeCompare(right)
  );
  return JSON.stringify({
    dirty: workspace.dirty,
    changedFilesCount: workspace.changedFilesCount,
    changedFiles,
    warning: workspace.warning,
  });
}

function changed<T>(previous: T | undefined, current: T | undefined): boolean {
  return previous !== current;
}

const systemClock = {
  now(): Date {
    return new Date();
  },
};

function runtimeStatusForObservation(input: {
  readonly status: RunObservationStatus;
  readonly resultStatus?: string | undefined;
  readonly workspaceDirty?: boolean | undefined;
  readonly changedFilesCount?: number | undefined;
}) {
  if (input.resultStatus === "done" || input.resultStatus === "completed") {
    return "done" as const;
  }
  if (input.resultStatus === "blocked" || input.status === "running") {
    return "blocked" as const;
  }
  if (
    input.resultStatus === "partial" ||
    (input.status !== "completed" &&
      (input.workspaceDirty || (input.changedFilesCount ?? 0) > 0))
  ) {
    return "partial" as const;
  }
  return "failed" as const;
}
