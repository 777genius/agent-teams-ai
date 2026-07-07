import {
  actionForRuntimeState,
  classifyRuntimeRunState,
  type RunProgressClassification,
  type RuntimeRecommendedAction,
} from "./runtime-result";
import type { RunEventProviderKind } from "./run-provider-kind";
import {
  decideRunObservation,
  type RunCapacityHint,
  type RunControlInboxSummary,
  type RunLogExcerpt,
  type RunObservationLiveness,
  type RunObservationProgress,
  type RunObservationResult,
  type RunObservationStatus,
  type RunObservationWarning,
  type RunObservationWorkspace,
  type RunReadOnlyDecision,
} from "./run-observability/domain/run-observation-decision-policy";

export {
  decideRunObservation,
} from "./run-observability/domain/run-observation-decision-policy";

export type {
  RunCapacityHint,
  RunControlInboxSummary,
  RunLogExcerpt,
  RunObservationLiveness,
  RunObservationProgress,
  RunObservationResult,
  RunObservationStatus,
  RunObservationWarning,
  RunObservationWorkspace,
  RunReadOnlyDecision,
  RunReadOnlyDecisionKind,
} from "./run-observability/domain/run-observation-decision-policy";

export enum RunProcessSupervisorKind {
  Tmux = "tmux",
  Process = "process",
  Direct = "direct",
  External = "external",
  None = "none",
  Unknown = "unknown",
}

export enum RunProcessAliveReason {
  Tmux = "tmux",
  Pid = "pid",
  FreshProgress = "fresh_progress",
  StaleProgress = "stale_progress",
  TerminalResult = "terminal_result",
  Unknown = "unknown",
}

export type RunObservationProcess = {
  readonly supervisor?: RunProcessSupervisorKind;
  readonly sessionId?: string;
  readonly alive?: boolean;
  readonly aliveReason?: RunProcessAliveReason;
  readonly pid?: number;
  readonly appServerPid?: number;
  readonly cpuActive?: boolean;
  readonly command?: string;
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

export type RunObservationSnapshot = {
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
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
  readonly providerKind: RunEventProviderKind;
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
  if (
    input.resultStatus === "blocked" ||
    input.resultStatus === "waiting_capacity" ||
    input.status === "blocked" ||
    input.status === "running"
  ) {
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
