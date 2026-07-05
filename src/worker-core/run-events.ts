import { createHash } from "node:crypto";

import {
  type RunCapacityHint,
  type RunControlInboxSummary,
  type RunLogExcerpt,
  type RunObservationPort,
  type RunObservationProgress,
  type RunObservationRequest,
  type RunObservationResult,
  RunObservationService,
  type RunObservationSnapshot,
  type RunObservationWorkspace,
  type RunProcessAliveReason,
  type RunProcessSupervisorKind,
} from "./run-observability";
import {
  isRunEventProviderKind,
  RunEventProviderKind,
  runEventProviderKindFromString,
} from "./run-provider-kind";

export {
  RunEventProviderKind,
  runEventProviderKindFromString,
} from "./run-provider-kind";

export enum RunEventType {
  ObservationRecorded = "run.observation.recorded",
  ProgressUpdated = "run.progress.updated",
  OutputGrew = "run.output.grew",
  WorkspaceChanged = "run.workspace.changed",
  ResultUpdated = "run.result.updated",
  DecisionChanged = "run.decision.changed",
  CapacityChanged = "run.capacity.changed",
  ControlInboxChanged = "run.control_inbox.changed",
  MaintenancePaused = "run.maintenance.paused",
  Completed = "run.completed",
  Blocked = "run.blocked",
  Failed = "run.failed",
  Stale = "run.stale",
  UnsafeStateDetected = "run.unsafe_state_detected",
}

export enum RunEventSeverity {
  Info = "info",
  Warning = "warning",
  Blocked = "blocked",
  Critical = "critical",
}

export enum RunEventRedactionStatus {
  Safe = "safe",
}

export enum RunRuntimeIssueKind {
  None = "none",
  WorkerObservable = "worker_observable",
  TerminalResultCompleted = "terminal_result_completed",
  CompletedResultWithLiveProcess = "completed_result_with_live_process",
  StoppedRunWithRunningProgress = "stopped_run_with_running_progress",
  ObservableProgressStale = "observable_progress_stale",
  HeartbeatOnlyNoOutput = "heartbeat_only_no_output",
  AccountOrCapacityUnavailable = "account_or_capacity_unavailable",
  DirtyWorkspaceWithoutRunningWorker = "dirty_workspace_without_running_worker",
  StoppedWithoutTerminalResult = "stopped_without_terminal_result",
  NonRunningOrUnknownFailure = "non_running_or_unknown_failure",
  GuidancePending = "guidance_pending",
  GuidanceDelivered = "guidance_delivered",
  ManualReviewRequired = "manual_review_required",
  ControlInboxBlocked = "control_inbox_blocked",
  Unknown = "unknown",
}

export enum RunSafetyStatus {
  Safe = "safe",
  Watch = "watch",
  ReviewRequired = "review_required",
  Blocked = "blocked",
  Unsafe = "unsafe",
  Unknown = "unknown",
}

export enum RunSafetyConfidence {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export enum RunLivenessStatus {
  Alive = "alive",
  Dead = "dead",
  Stale = "stale",
  Quiet = "quiet",
  CompletedLive = "completed_live",
  Unknown = "unknown",
}

export enum RunWorkspaceStatus {
  Clean = "clean",
  Dirty = "dirty",
  Missing = "missing",
  Unknown = "unknown",
  Warning = "warning",
}

export enum RunAccountCapacityStatus {
  Available = "available",
  Blocked = "blocked",
  Cooldown = "cooldown",
  Unknown = "unknown",
}

export enum RunOutcomeStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Blocked = "blocked",
  Partial = "partial",
  NeedsAttention = "needs_attention",
  Unknown = "unknown",
}

export enum RunControlInboxStatus {
  Clear = "clear",
  Pending = "pending",
  Delivered = "delivered",
  Blocked = "blocked",
  Unsafe = "unsafe",
  Unknown = "unknown",
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type RunEventSource = {
  readonly providerKind: RunEventProviderKind;
  readonly hostId?: string;
  readonly registryRootDir?: string;
  readonly workspaceKey?: string;
};

export type RunEvent = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly jobId?: string;
  readonly type: RunEventType;
  readonly severity: RunEventSeverity;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly sequence?: number;
  readonly source: RunEventSource;
  readonly redaction: RunEventRedactionStatus;
  readonly payload: JsonObject;
};

export type RunEventCursor = {
  readonly value: string;
};

export enum RunEventCompactionSafetyMode {
  PreserveDeliveryCursors = "preserve_delivery_cursors",
  Force = "force",
}

export type RunEventRetentionPolicy = {
  readonly safetyMode?: RunEventCompactionSafetyMode;
  readonly keepEventsAfter?: string;
  readonly keepLatestEventsPerRun?: number;
  readonly compactDeliveredEvents?: boolean;
  readonly dropInvalidLines?: boolean;
};

export type RunEventDeliveryCursorSnapshot = {
  readonly consumerId: string;
  readonly cursor: RunEventCursor;
  readonly lineNumber: number;
};

export type RunEventDeliveryCursorRewrite = {
  readonly consumerId: string;
  readonly previousCursor: RunEventCursor;
  readonly nextCursor: RunEventCursor;
  readonly invalidatedUnreadEvents: boolean;
};

export type RunEventCompactionPlan = {
  readonly schemaVersion: 1;
  readonly safetyMode: RunEventCompactionSafetyMode;
  readonly totalLineCount: number;
  readonly validEventCount: number;
  readonly invalidLineCount: number;
  readonly retainedLineCount: number;
  readonly removableLineCount: number;
  readonly blockedByCursorLineCount: number;
  readonly cursorFloorLine?: number;
  readonly deliveryCursors: readonly RunEventDeliveryCursorSnapshot[];
  readonly cursorRewrites: readonly RunEventDeliveryCursorRewrite[];
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventCompactionResult = RunEventCompactionPlan & {
  readonly compacted: boolean;
};

export type RunEventCompactionPort = {
  planCompaction(policy?: RunEventRetentionPolicy): Promise<RunEventCompactionPlan>;
  compact(policy?: RunEventRetentionPolicy): Promise<RunEventCompactionResult>;
};

export type RunEventAppendResult = {
  readonly appendedCount: number;
  readonly skippedDuplicateCount: number;
};

export type RunEventReadWarning = {
  readonly code: string;
  readonly message: string;
  readonly lineNumber?: number;
};

export type RunEventReadRequest = {
  readonly cursor?: RunEventCursor;
  readonly limit?: number;
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly sourceProviderKind?: RunEventProviderKind;
  readonly sourceRegistryRootDir?: string;
  readonly types?: readonly RunEventType[];
};

export type RunEventReadResult = {
  readonly events: readonly RunEvent[];
  readonly nextCursor?: RunEventCursor;
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventStorePort = {
  append(events: readonly RunEvent[]): Promise<RunEventAppendResult>;
  read(input?: RunEventReadRequest): Promise<RunEventReadResult>;
};

export type RunEventProjectionStateStorePort = {
  readProjectionState(runId: string): Promise<RunEventProjectionState | null>;
  writeProjectionState(state: RunEventProjectionState): Promise<void>;
};

export type RunEventPublisherPort = {
  publish(events: readonly RunEvent[]): Promise<void>;
};

export type RunEventDeliveryCursorStorePort = {
  readDeliveryCursor(consumerId: string): Promise<RunEventCursor | null>;
  writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void>;
};

export type RunEventRelayResult = {
  readonly consumerId: string;
  readonly readCount: number;
  readonly publishedCount: number;
  readonly nextCursor?: RunEventCursor;
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventProjectionState = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly observedAt: string;
  readonly status: string;
  readonly liveness: string;
  readonly progressStatus?: string;
  readonly progressUpdatedAt?: string;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly resultUpdatedAt?: string;
  readonly logByteLength?: number;
  readonly workspaceSignature?: string;
  readonly capacitySignature?: string;
  readonly controlInboxSignature?: string;
  readonly decisionKind?: string;
  readonly decisionReason?: string;
  readonly readModels: RunEventReadModels;
};

export type RunEventProjectionResult = {
  readonly events: readonly RunEvent[];
  readonly nextState: RunEventProjectionState;
};

export type RunEventReadModels = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly observedAt: string;
  readonly safety: RunSafetyReadModel;
  readonly liveness: RunLivenessReadModel;
  readonly workspace: RunWorkspaceReadModel;
  readonly accountCapacity: RunAccountCapacityReadModel;
  readonly outcome: RunOutcomeReadModel;
  readonly controlInbox: RunControlInboxReadModel;
};

export type RunSafetyReadModel = {
  readonly status: RunSafetyStatus;
  readonly safeToContinue: boolean;
  readonly reviewOnly: boolean;
  readonly issueKind: RunRuntimeIssueKind;
  readonly reason: string;
  readonly confidence: RunSafetyConfidence;
  readonly evidence: readonly string[];
};

export type RunLivenessReadModel = {
  readonly status: RunLivenessStatus;
  readonly processAlive?: boolean;
  readonly aliveReason?: RunProcessAliveReason;
  readonly supervisor?: RunProcessSupervisorKind;
  readonly processPid?: number;
  readonly heartbeatAgeMs?: number;
  readonly staleAfterMs?: number;
  readonly logByteLength?: number;
  readonly lastProgressAt?: string;
  readonly lastLogAt?: string;
};

export type RunWorkspaceReadModel = {
  readonly status: RunWorkspaceStatus;
  readonly reviewOnly: boolean;
  readonly exists?: boolean;
  readonly dirty?: boolean;
  readonly changedFilesCount?: number;
  readonly changedFilesSample: readonly string[];
  readonly warning?: string;
};

export type RunAccountCapacityReadModel = {
  readonly status: RunAccountCapacityStatus;
  readonly totalHints: number;
  readonly blockedCount: number;
  readonly cooldownCount: number;
  readonly maskedAccounts: readonly string[];
  readonly reasons: readonly string[];
};

export type RunOutcomeReadModel = {
  readonly status: RunOutcomeStatus;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly updatedAt?: string;
};

export type RunControlInboxReadModel = {
  readonly status: RunControlInboxStatus;
  readonly pendingCount: number;
  readonly deliveredCount: number;
  readonly blockedDeliveryCount: number;
  readonly safeToContinue?: boolean;
  readonly latestSignalAt?: string;
  readonly latestDeliveredAt?: string;
};

export class RunEventProjectionService {
  private readonly observationService: RunObservationService;

  constructor(private readonly options: {
    readonly observationPort: RunObservationPort;
    readonly eventStore: RunEventStorePort;
    readonly stateStore: RunEventProjectionStateStorePort;
    readonly hostId?: string;
    readonly registryRootDir?: string;
    readonly clock?: { now(): Date };
  }) {
    this.observationService = new RunObservationService(
      options.observationPort,
      options.clock === undefined ? {} : { clock: options.clock },
    );
  }

  async projectRun(
    input: RunObservationRequest,
  ): Promise<RunEventProjectionResult & {
    readonly appendResult: RunEventAppendResult;
  }> {
    const snapshot = await this.observationService.observeRun(input);
    const storedState = await this.options.stateStore.readProjectionState(
      snapshot.runId,
    );
    const previousState = storedState ??
      await this.recoverProjectionStateFromEvents(snapshot.runId);
    const projected = projectRunObservationEvents({
      snapshot,
      previousState,
      ...(this.options.hostId === undefined ? {} : { hostId: this.options.hostId }),
      ...(this.options.registryRootDir === undefined
        ? {}
        : { registryRootDir: this.options.registryRootDir }),
    });
    const appendResult = await this.options.eventStore.append(projected.events);
    await this.options.stateStore.writeProjectionState(projected.nextState);
    return {
      ...projected,
      appendResult,
    };
  }

  private async recoverProjectionStateFromEvents(
    runId: string,
  ): Promise<RunEventProjectionState | null> {
    const replayed = await this.options.eventStore.read({ runId });
    return runEventProjectionStateFromEvents(replayed.events);
  }
}

export class RunEventRelayService {
  constructor(private readonly options: {
    readonly eventStore: RunEventStorePort;
    readonly cursorStore: RunEventDeliveryCursorStorePort;
    readonly publisher: RunEventPublisherPort;
  }) {}

  async relay(input: {
    readonly consumerId: string;
    readonly limit?: number;
    readonly runId?: string;
    readonly types?: readonly RunEventType[];
  }): Promise<RunEventRelayResult> {
    if (!input.consumerId.trim()) {
      throw new Error("run_event_relay_consumer_id_required");
    }
    const cursor = await this.options.cursorStore.readDeliveryCursor(
      input.consumerId,
    );
    const read = await this.options.eventStore.read({
      ...(cursor === null ? {} : { cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.types === undefined ? {} : { types: input.types }),
    });
    if (read.events.length > 0) {
      await this.options.publisher.publish(read.events);
    }
    if (read.nextCursor !== undefined) {
      await this.options.cursorStore.writeDeliveryCursor({
        consumerId: input.consumerId,
        cursor: read.nextCursor,
      });
    }
    return {
      consumerId: input.consumerId,
      readCount: read.events.length,
      publishedCount: read.events.length,
      ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
      warnings: read.warnings,
    };
  }
}

export function projectRunObservationEvents(input: {
  readonly snapshot: RunObservationSnapshot;
  readonly previousState?: RunEventProjectionState | null;
  readonly hostId?: string;
  readonly registryRootDir?: string;
  readonly sequenceStart?: number;
}): RunEventProjectionResult {
  const nextState = runEventProjectionStateFromSnapshot(input.snapshot);
  const previous = input.previousState ?? null;
  const events: RunEvent[] = [];
  const source = runEventSourceFromSnapshot({
    snapshot: input.snapshot,
    providerKind: nextState.providerKind,
    ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
    ...(input.registryRootDir === undefined
      ? {}
      : { registryRootDir: input.registryRootDir }),
  });
  const push = (
    type: RunEventType,
    severity: RunEventSeverity,
    payload: JsonObject,
    idempotencyParts: readonly JsonValue[],
  ) => {
    const sequence = input.sequenceStart === undefined
      ? undefined
      : input.sequenceStart + events.length;
    events.push(makeRunEvent({
      runId: input.snapshot.runId,
      type,
      severity,
      occurredAt: input.snapshot.observedAt,
      ...(sequence === undefined ? {} : { sequence }),
      source,
      payload,
      idempotencyParts,
    }));
  };

  if (!previous) {
    push(
      RunEventType.ObservationRecorded,
      RunEventSeverity.Info,
      snapshotPayload(input.snapshot),
      ["initial", nextState.status, nextState.liveness],
    );
  }

  if (
    !previous ||
    previous.progressStatus !== nextState.progressStatus ||
    previous.progressUpdatedAt !== nextState.progressUpdatedAt
  ) {
    push(
      RunEventType.ProgressUpdated,
      RunEventSeverity.Info,
      compactJsonObject({
        status: input.snapshot.progress?.status,
        updatedAt: input.snapshot.progress?.updatedAt,
        attemptCount: input.snapshot.progress?.attemptCount,
        currentAccount: input.snapshot.progress?.currentAccount,
        heartbeatAgeMs: input.snapshot.progress?.heartbeatAgeMs,
        staleAfterMs: input.snapshot.progress?.staleAfterMs,
        stale: input.snapshot.progress?.stale,
        silentStale: input.snapshot.progress?.silentStale,
        heartbeatOnlyNoOutput: input.snapshot.progress?.heartbeatOnlyNoOutput,
      }),
      ["progress", nextState.progressStatus ?? null, nextState.progressUpdatedAt ?? null],
    );
  }

  if (
    previous?.logByteLength !== undefined &&
    nextState.logByteLength !== undefined &&
    nextState.logByteLength > previous.logByteLength
  ) {
    push(
      RunEventType.OutputGrew,
      RunEventSeverity.Info,
      compactJsonObject({
        byteLength: nextState.logByteLength,
        previousByteLength: previous.logByteLength,
        updatedAt: input.snapshot.logs?.updatedAt,
      }),
      ["output", nextState.logByteLength, input.snapshot.logs?.updatedAt ?? null],
    );
  }

  if (!previous || previous.workspaceSignature !== nextState.workspaceSignature) {
    push(
      RunEventType.WorkspaceChanged,
      input.snapshot.workspace?.dirty ? RunEventSeverity.Warning : RunEventSeverity.Info,
      workspacePayload(input.snapshot.workspace),
      ["workspace", nextState.workspaceSignature ?? null],
    );
  }

  if (
    !previous ||
    previous.resultStatus !== nextState.resultStatus ||
    previous.resultReason !== nextState.resultReason ||
    previous.resultUpdatedAt !== nextState.resultUpdatedAt
  ) {
    push(
      RunEventType.ResultUpdated,
      resultSeverity(input.snapshot.result?.status),
      compactJsonObject({
        exists: input.snapshot.result?.exists,
        status: input.snapshot.result?.status,
        reason: input.snapshot.result?.reason,
        updatedAt: input.snapshot.result?.updatedAt,
      }),
      [
        "result",
        nextState.resultStatus ?? null,
        nextState.resultReason ?? null,
        nextState.resultUpdatedAt ?? null,
      ],
    );
  }

  if (
    !previous ||
    previous.decisionKind !== nextState.decisionKind ||
    previous.decisionReason !== nextState.decisionReason
  ) {
    push(
      RunEventType.DecisionChanged,
      decisionSeverity(input.snapshot.readOnlyDecision.kind),
      compactJsonObject({
        kind: input.snapshot.readOnlyDecision.kind,
        reason: input.snapshot.readOnlyDecision.reason,
        evidence: jsonArray(input.snapshot.readOnlyDecision.evidence),
      }),
      [
        "decision",
        nextState.decisionKind ?? null,
        nextState.decisionReason ?? null,
      ],
    );
  }

  if (!previous || previous.capacitySignature !== nextState.capacitySignature) {
    push(
      RunEventType.CapacityChanged,
      capacitySeverity(input.snapshot.capacity),
      compactJsonObject({ capacity: capacityPayload(input.snapshot.capacity) }),
      ["capacity", nextState.capacitySignature ?? null],
    );
  }

  if (!previous || previous.controlInboxSignature !== nextState.controlInboxSignature) {
    push(
      RunEventType.ControlInboxChanged,
      controlInboxSeverity(input.snapshot.controlInbox),
      compactJsonObject({ controlInbox: controlInboxPayload(input.snapshot.controlInbox) }),
      ["controlInbox", nextState.controlInboxSignature ?? null],
    );
  }

  if (
    input.snapshot.progress?.status === "maintenance_paused" &&
    previous?.progressStatus !== "maintenance_paused"
  ) {
    push(
      RunEventType.MaintenancePaused,
      RunEventSeverity.Warning,
      compactJsonObject({
        reason: input.snapshot.result?.reason,
        progressUpdatedAt: input.snapshot.progress.updatedAt,
      }),
      ["maintenance", input.snapshot.progress.updatedAt ?? null],
    );
  }

  if (
    (input.snapshot.liveness === "stale" || input.snapshot.progress?.stale === true) &&
    previous?.liveness !== input.snapshot.liveness
  ) {
    push(
      RunEventType.Stale,
      RunEventSeverity.Warning,
      compactJsonObject({
        liveness: input.snapshot.liveness,
        heartbeatAgeMs: input.snapshot.progress?.heartbeatAgeMs,
        staleAfterMs: input.snapshot.progress?.staleAfterMs,
      }),
      ["stale", input.snapshot.liveness, input.snapshot.progress?.heartbeatAgeMs ?? null],
    );
  }

  if (
    input.snapshot.readOnlyDecision.kind === "unsafe_state_mismatch" &&
    previous?.decisionKind !== "unsafe_state_mismatch"
  ) {
    push(
      RunEventType.UnsafeStateDetected,
      RunEventSeverity.Critical,
      compactJsonObject({
        reason: input.snapshot.readOnlyDecision.reason,
        evidence: jsonArray(input.snapshot.readOnlyDecision.evidence),
      }),
      ["unsafe", input.snapshot.readOnlyDecision.reason],
    );
  }

  if (input.snapshot.status === "failed" && previous?.status !== "failed") {
    push(
      RunEventType.Failed,
      RunEventSeverity.Critical,
      compactJsonObject({
        reason: input.snapshot.result?.reason,
        classification: input.snapshot.classification,
        recommendedAction: input.snapshot.recommendedAction,
      }),
      ["failed", input.snapshot.result?.reason ?? null],
    );
  }

  if (
    input.snapshot.readOnlyDecision.kind === "manual_review_required" &&
    input.snapshot.status !== "failed" &&
    previous?.decisionKind !== "manual_review_required"
  ) {
    push(
      RunEventType.Blocked,
      RunEventSeverity.Blocked,
      compactJsonObject({
        reason: input.snapshot.readOnlyDecision.reason,
        status: input.snapshot.status,
        liveness: input.snapshot.liveness,
      }),
      ["blocked", input.snapshot.readOnlyDecision.reason],
    );
  }

  if (input.snapshot.status === "completed" && previous?.status !== "completed") {
    push(
      RunEventType.Completed,
      RunEventSeverity.Info,
      compactJsonObject({
        resultStatus: input.snapshot.result?.status,
        workspaceDirty: input.snapshot.workspace?.dirty,
        changedFilesCount: input.snapshot.workspace?.changedFilesCount,
      }),
      ["completed", input.snapshot.result?.updatedAt ?? input.snapshot.observedAt],
    );
  }

  return {
    events,
    nextState,
  };
}

export function runEventProjectionStateFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunEventProjectionState {
  const workspaceSignatureValue = workspaceSignature(snapshot.workspace);
  const capacitySignatureValue = stableJsonString(capacityPayload(snapshot.capacity));
  const controlInboxSignatureValue = stableJsonString(
    controlInboxPayload(snapshot.controlInbox),
  );
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    providerKind: runEventProviderKindFromString(snapshot.providerKind),
    observedAt: snapshot.observedAt,
    status: snapshot.status,
    liveness: snapshot.liveness,
    ...(snapshot.progress?.status === undefined
      ? {}
      : { progressStatus: snapshot.progress.status }),
    ...(snapshot.progress?.updatedAt === undefined
      ? {}
      : { progressUpdatedAt: snapshot.progress.updatedAt }),
    ...(snapshot.result?.status === undefined ? {} : { resultStatus: snapshot.result.status }),
    ...(snapshot.result?.reason === undefined ? {} : { resultReason: snapshot.result.reason }),
    ...(snapshot.result?.updatedAt === undefined
      ? {}
      : { resultUpdatedAt: snapshot.result.updatedAt }),
    ...(snapshot.logs?.byteLength === undefined
      ? {}
      : { logByteLength: snapshot.logs.byteLength }),
    ...(workspaceSignatureValue === undefined
      ? {}
      : { workspaceSignature: workspaceSignatureValue }),
    capacitySignature: capacitySignatureValue,
    controlInboxSignature: controlInboxSignatureValue,
    decisionKind: snapshot.readOnlyDecision.kind,
    decisionReason: snapshot.readOnlyDecision.reason,
    readModels: runEventReadModelsFromSnapshot(snapshot),
  };
}

export function makeRunEvent(input: {
  readonly runId: string;
  readonly jobId?: string;
  readonly type: RunEventType;
  readonly severity?: RunEventSeverity;
  readonly occurredAt: string;
  readonly observedAt?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly sequence?: number;
  readonly source: RunEventSource;
  readonly payload?: JsonObject;
  readonly idempotencyParts?: readonly JsonValue[];
}): RunEvent {
  const payload = sanitizeRunEventPayload(input.payload ?? {});
  const eventId = runEventId({
    runId: input.runId,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    type: input.type,
    source: input.source,
    idempotencyParts: input.idempotencyParts ?? [payload],
  });
  return {
    schemaVersion: 1,
    eventId,
    runId: input.runId,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    type: input.type,
    severity: input.severity ?? RunEventSeverity.Info,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt ?? input.occurredAt,
    correlationId: input.correlationId ?? eventId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    source: input.source,
    redaction: RunEventRedactionStatus.Safe,
    payload,
  };
}

export function parseRunEvent(value: unknown): RunEvent | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (
    typeof value.eventId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.type !== "string" ||
    typeof value.severity !== "string" ||
    typeof value.occurredAt !== "string" ||
    value.redaction !== RunEventRedactionStatus.Safe ||
    !isRecord(value.source) ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  if (!isRunEventType(value.type)) return null;
  if (!isRunEventSeverity(value.severity)) return null;
  const providerKindText = value.source.providerKind;
  if (typeof providerKindText !== "string") return null;
  const providerKind = isRunEventProviderKind(providerKindText)
    ? providerKindText
    : runEventProviderKindFromString(providerKindText);
  if (!optionalString(value.jobId)) return null;
  if (!optionalString(value.observedAt)) return null;
  if (!optionalString(value.correlationId)) return null;
  if (!optionalString(value.causationId)) return null;
  if (!optionalNumber(value.sequence)) return null;
  if (!optionalString(value.source.hostId)) return null;
  if (!optionalString(value.source.registryRootDir)) return null;
  if (!optionalString(value.source.workspaceKey)) return null;
  const payload = coerceJsonObject(value.payload);
  if (!payload) return null;
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    runId: value.runId,
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    type: value.type,
    severity: value.severity,
    occurredAt: value.occurredAt,
    observedAt: value.observedAt ?? value.occurredAt,
    correlationId: value.correlationId ?? value.eventId,
    ...(value.causationId === undefined ? {} : { causationId: value.causationId }),
    ...(value.sequence === undefined ? {} : { sequence: value.sequence }),
    source: {
      providerKind,
      ...(value.source.hostId === undefined ? {} : { hostId: value.source.hostId }),
      ...(value.source.registryRootDir === undefined
        ? {}
        : { registryRootDir: value.source.registryRootDir }),
      ...(value.source.workspaceKey === undefined
        ? {}
        : { workspaceKey: value.source.workspaceKey }),
    },
    redaction: RunEventRedactionStatus.Safe,
    payload: sanitizeRunEventPayload(payload),
  };
}

export function runEventReadModelsFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunEventReadModels {
  const issueKind = runtimeIssueKindFromDecisionReason(
    snapshot.readOnlyDecision.reason,
  );
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    providerKind: runEventProviderKindFromString(snapshot.providerKind),
    observedAt: snapshot.observedAt,
    safety: safetyReadModelFromSnapshot(snapshot, issueKind),
    liveness: livenessReadModelFromSnapshot(snapshot),
    workspace: workspaceReadModelFromSnapshot(snapshot),
    accountCapacity: accountCapacityReadModelFromSnapshot(snapshot),
    outcome: outcomeReadModelFromSnapshot(snapshot),
    controlInbox: controlInboxReadModelFromSnapshot(snapshot),
  };
}

export function projectRunReadModelsFromEvents(
  events: readonly RunEvent[],
): RunEventReadModels | null {
  const replayed = replayRunObservationSnapshotFromEvents(events);
  return replayed === null ? null : runEventReadModelsFromSnapshot(replayed);
}

export function runEventProjectionStateFromEvents(
  events: readonly RunEvent[],
): RunEventProjectionState | null {
  const replayed = replayRunObservationSnapshotFromEvents(events);
  return replayed === null ? null : runEventProjectionStateFromSnapshot(replayed);
}

function replayRunObservationSnapshotFromEvents(
  events: readonly RunEvent[],
): RunObservationSnapshot | null {
  const first = events[0];
  if (first === undefined) return null;
  const runId = first.runId;
  const sourceEvents = events.filter((event) => event.runId === runId);
  const latest = sourceEvents[sourceEvents.length - 1] ?? first;
  let status: RunObservationSnapshot["status"] = "unknown";
  let liveness: RunObservationSnapshot["liveness"] = "unknown";
  let readOnlyDecision: RunObservationSnapshot["readOnlyDecision"] = {
    kind: "manual_review_required",
    reason: "event_replay_without_runtime_snapshot",
    safeMessage:
      "Projected state was rebuilt from events only. Inspect live runtime before control actions.",
    evidence: ["run-events"],
  };
  let workspace: RunObservationWorkspace | undefined;
  let progress: RunObservationProgress | undefined;
  let result: RunObservationResult | undefined;
  let logs: RunLogExcerpt | undefined;
  let capacity: readonly RunCapacityHint[] | undefined;
  let controlInbox: RunControlInboxSummary | undefined;

  for (const event of sourceEvents) {
    switch (event.type) {
      case RunEventType.ObservationRecorded:
        status = observationStatusFromPayload(event.payload) ?? status;
        liveness = observationLivenessFromPayload(event.payload) ?? liveness;
        readOnlyDecision = decisionFromPayload(event.payload) ?? readOnlyDecision;
        break;
      case RunEventType.ProgressUpdated:
        progress = progressFromPayload(event.payload);
        break;
      case RunEventType.OutputGrew:
        logs = outputFromPayload(event.payload);
        break;
      case RunEventType.WorkspaceChanged:
        workspace = workspaceFromPayload(event.payload);
        break;
      case RunEventType.ResultUpdated:
        result = resultFromPayload(event.payload);
        break;
      case RunEventType.DecisionChanged:
        readOnlyDecision = decisionFromPayload(event.payload) ?? readOnlyDecision;
        break;
      case RunEventType.CapacityChanged:
        capacity = capacityFromEventPayload(event.payload);
        break;
      case RunEventType.ControlInboxChanged:
        controlInbox = controlInboxFromEventPayload(event.payload);
        break;
      case RunEventType.MaintenancePaused:
        progress = {
          ...(progress ?? {}),
          status: "maintenance_paused",
          ...(stringFromJson(event.payload.progressUpdatedAt) === undefined
            ? {}
            : { updatedAt: stringFromJson(event.payload.progressUpdatedAt) as string }),
        };
        break;
      case RunEventType.Completed:
        status = "completed";
        result = {
          ...(result ?? {}),
          exists: true,
          ...(stringFromJson(event.payload.resultStatus) === undefined
            ? {}
            : { status: stringFromJson(event.payload.resultStatus) as string }),
        };
        break;
      case RunEventType.Failed:
        status = "failed";
        result = {
          ...(result ?? {}),
          exists: true,
          status: "failed",
          ...(stringFromJson(event.payload.reason) === undefined
            ? {}
            : { reason: stringFromJson(event.payload.reason) as string }),
        };
        break;
      case RunEventType.Blocked:
        readOnlyDecision = {
          kind: "manual_review_required",
          reason: stringFromJson(event.payload.reason) ?? "run_blocked",
          safeMessage:
            "Run was blocked according to the event log. Inspect runtime before control actions.",
          evidence: ["run.blocked"],
        };
        break;
      case RunEventType.Stale:
        liveness = "stale";
        progress = {
          ...(progress ?? {}),
          stale: true,
          ...(numberFromJson(event.payload.heartbeatAgeMs) === undefined
            ? {}
            : { heartbeatAgeMs: numberFromJson(event.payload.heartbeatAgeMs) as number }),
          ...(numberFromJson(event.payload.staleAfterMs) === undefined
            ? {}
            : { staleAfterMs: numberFromJson(event.payload.staleAfterMs) as number }),
        };
        break;
      case RunEventType.UnsafeStateDetected:
        readOnlyDecision = {
          kind: "unsafe_state_mismatch",
          reason: stringFromJson(event.payload.reason) ?? "unsafe_state_detected",
          safeMessage:
            "Unsafe state was detected according to the event log. Inspect runtime before control actions.",
          evidence: stringArrayFromJson(event.payload.evidence),
        };
        break;
    }
  }

  return {
    runId,
    providerKind: first.source.providerKind,
    observedAt: latest.observedAt,
    status,
    liveness,
    warnings: [],
    readOnlyDecision,
    ...(workspace === undefined ? {} : { workspace }),
    ...(progress === undefined ? {} : { progress }),
    ...(result === undefined ? {} : { result }),
    ...(logs === undefined ? {} : { logs }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(controlInbox === undefined ? {} : { controlInbox }),
  };
}

export function sanitizeRunEventPayload(input: JsonObject): JsonObject {
  return sanitizeJsonObject(input, 0);
}

function safetyReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
  issueKind: RunRuntimeIssueKind,
): RunSafetyReadModel {
  const decision = snapshot.readOnlyDecision;
  const evidence = decision.evidence ?? [];
  switch (decision.kind) {
    case "review_completed":
      return {
        status: RunSafetyStatus.ReviewRequired,
        safeToContinue: false,
        reviewOnly: true,
        issueKind,
        reason: decision.reason,
        confidence: RunSafetyConfidence.High,
        evidence,
      };
    case "keep_watching":
      return {
        status: RunSafetyStatus.Watch,
        safeToContinue: true,
        reviewOnly: false,
        issueKind,
        reason: decision.reason,
        confidence: RunSafetyConfidence.High,
        evidence,
      };
    case "capacity_blocked":
      return {
        status: RunSafetyStatus.Blocked,
        safeToContinue: false,
        reviewOnly: true,
        issueKind,
        reason: decision.reason,
        confidence: RunSafetyConfidence.High,
        evidence,
      };
    case "stale_needs_inspection":
    case "manual_review_required":
      return {
        status: RunSafetyStatus.ReviewRequired,
        safeToContinue: false,
        reviewOnly: true,
        issueKind,
        reason: decision.reason,
        confidence: RunSafetyConfidence.High,
        evidence,
      };
    case "unsafe_state_mismatch":
      return {
        status: RunSafetyStatus.Unsafe,
        safeToContinue: false,
        reviewOnly: true,
        issueKind,
        reason: decision.reason,
        confidence: RunSafetyConfidence.High,
        evidence,
      };
  }
}

function livenessReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunLivenessReadModel {
  const status = (() => {
    if (snapshot.status === "completed" && snapshot.liveness === "alive") {
      return RunLivenessStatus.CompletedLive;
    }
    if (snapshot.progress?.heartbeatOnlyNoOutput) return RunLivenessStatus.Quiet;
    if (snapshot.liveness === "alive") return RunLivenessStatus.Alive;
    if (snapshot.liveness === "dead") return RunLivenessStatus.Dead;
    if (snapshot.liveness === "stale" || snapshot.progress?.stale) {
      return RunLivenessStatus.Stale;
    }
    return RunLivenessStatus.Unknown;
  })();
  return {
    status,
    ...(snapshot.process?.alive === undefined ? {} : { processAlive: snapshot.process.alive }),
    ...(snapshot.process?.aliveReason === undefined
      ? {}
      : { aliveReason: snapshot.process.aliveReason }),
    ...(snapshot.process?.supervisor === undefined
      ? {}
      : { supervisor: snapshot.process.supervisor }),
    ...(snapshot.process?.pid === undefined ? {} : { processPid: snapshot.process.pid }),
    ...(snapshot.progress?.heartbeatAgeMs === undefined
      ? {}
      : { heartbeatAgeMs: snapshot.progress.heartbeatAgeMs }),
    ...(snapshot.progress?.staleAfterMs === undefined
      ? {}
      : { staleAfterMs: snapshot.progress.staleAfterMs }),
    ...(snapshot.logs?.byteLength === undefined ? {} : { logByteLength: snapshot.logs.byteLength }),
    ...(snapshot.progress?.updatedAt === undefined
      ? {}
      : { lastProgressAt: snapshot.progress.updatedAt }),
    ...(snapshot.logs?.updatedAt === undefined ? {} : { lastLogAt: snapshot.logs.updatedAt }),
  };
}

function workspaceReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunWorkspaceReadModel {
  const workspace = snapshot.workspace;
  const status = (() => {
    if (!workspace) return RunWorkspaceStatus.Unknown;
    if (workspace.warning) return RunWorkspaceStatus.Warning;
    if (workspace.exists === false) return RunWorkspaceStatus.Missing;
    if (workspace.dirty) return RunWorkspaceStatus.Dirty;
    if (workspace.dirty === false) return RunWorkspaceStatus.Clean;
    return RunWorkspaceStatus.Unknown;
  })();
  const reviewOnly = status === RunWorkspaceStatus.Dirty &&
    snapshot.status !== "running";
  return {
    status,
    reviewOnly,
    ...(workspace?.exists === undefined ? {} : { exists: workspace.exists }),
    ...(workspace?.dirty === undefined ? {} : { dirty: workspace.dirty }),
    ...(workspace?.changedFilesCount === undefined
      ? {}
      : { changedFilesCount: workspace.changedFilesCount }),
    changedFilesSample: [...(workspace?.changedFiles ?? [])].slice(0, 50),
    ...(workspace?.warning === undefined ? {} : { warning: workspace.warning }),
  };
}

function accountCapacityReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunAccountCapacityReadModel {
  const hints = snapshot.capacity ?? [];
  const blocked = hints.filter(isBlockedCapacityHint);
  const cooldown = hints.filter((hint) => hint.availability === "cooldown");
  const status = (() => {
    if (hints.length === 0) return RunAccountCapacityStatus.Unknown;
    if (blocked.length > 0) return RunAccountCapacityStatus.Blocked;
    if (cooldown.length > 0) return RunAccountCapacityStatus.Cooldown;
    return RunAccountCapacityStatus.Available;
  })();
  return {
    status,
    totalHints: hints.length,
    blockedCount: blocked.length,
    cooldownCount: cooldown.length,
    maskedAccounts: uniqueStrings(
      hints.map((hint) => maskAccountIdentity(hint.account)).filter(isString),
    ),
    reasons: uniqueStrings(hints.map((hint) => hint.reason).filter(isString)),
  };
}

function outcomeReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunOutcomeReadModel {
  const status = (() => {
    if (snapshot.status === "running") return RunOutcomeStatus.Running;
    if (snapshot.status === "completed") return RunOutcomeStatus.Completed;
    if (snapshot.status === "failed") return RunOutcomeStatus.Failed;
    if (snapshot.readOnlyDecision.kind === "capacity_blocked") {
      return RunOutcomeStatus.Blocked;
    }
    if (snapshot.readOnlyDecision.kind === "manual_review_required" ||
        snapshot.readOnlyDecision.kind === "stale_needs_inspection" ||
        snapshot.readOnlyDecision.kind === "unsafe_state_mismatch") {
      return RunOutcomeStatus.NeedsAttention;
    }
    if (
      snapshot.workspace?.dirty ||
      (snapshot.workspace?.changedFilesCount ?? 0) > 0
    ) {
      return RunOutcomeStatus.Partial;
    }
    return RunOutcomeStatus.Unknown;
  })();
  return {
    status,
    ...(snapshot.result?.status === undefined ? {} : { resultStatus: snapshot.result.status }),
    ...(snapshot.result?.reason === undefined ? {} : { reason: snapshot.result.reason }),
    ...(snapshot.result?.updatedAt === undefined ? {} : { updatedAt: snapshot.result.updatedAt }),
  };
}

function controlInboxReadModelFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunControlInboxReadModel {
  const controlInbox = snapshot.controlInbox;
  const pendingCount = controlInbox?.pendingCount ?? 0;
  const deliveredCount = controlInbox?.deliveredCount ?? 0;
  const blockedDeliveryCount = controlInbox?.blockedDeliveryCount ?? 0;
  const status = (() => {
    if (!controlInbox) return RunControlInboxStatus.Unknown;
    if (controlInbox.safeToContinue === false) return RunControlInboxStatus.Unsafe;
    if (blockedDeliveryCount > 0) return RunControlInboxStatus.Blocked;
    if (pendingCount > 0) return RunControlInboxStatus.Pending;
    if (deliveredCount > 0) return RunControlInboxStatus.Delivered;
    return RunControlInboxStatus.Clear;
  })();
  return {
    status,
    pendingCount,
    deliveredCount,
    blockedDeliveryCount,
    ...(controlInbox?.safeToContinue === undefined
      ? {}
      : { safeToContinue: controlInbox.safeToContinue }),
    ...(controlInbox?.latestSignalAt === undefined
      ? {}
      : { latestSignalAt: controlInbox.latestSignalAt }),
    ...(controlInbox?.latestDeliveredAt === undefined
      ? {}
      : { latestDeliveredAt: controlInbox.latestDeliveredAt }),
  };
}

function observationStatusFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["status"] | undefined {
  const status = stringFromJson(payload.status);
  switch (status) {
    case "running":
    case "stopped":
    case "completed":
    case "failed":
    case "unknown":
      return status;
    default:
      return undefined;
  }
}

function observationLivenessFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["liveness"] | undefined {
  const liveness = stringFromJson(payload.liveness);
  switch (liveness) {
    case "alive":
    case "dead":
    case "stale":
    case "unknown":
      return liveness;
    default:
      return undefined;
  }
}

function decisionFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["readOnlyDecision"] | undefined {
  const source = objectFromJson(payload.readOnlyDecision) ?? payload;
  const kind = stringFromJson(source.kind);
  const reason = stringFromJson(source.reason);
  if (!kind || !reason) return undefined;
  switch (kind) {
    case "keep_watching":
    case "review_completed":
    case "manual_review_required":
    case "capacity_blocked":
    case "stale_needs_inspection":
    case "unsafe_state_mismatch":
      return {
        kind,
        reason,
        safeMessage:
          "Decision was rebuilt from run events. Inspect live runtime before control actions.",
        evidence: stringArrayFromJson(source.evidence),
      };
    default:
      return undefined;
  }
}

function progressFromPayload(payload: JsonObject): RunObservationProgress {
  return {
    ...(stringFromJson(payload.status) === undefined
      ? {}
      : { status: stringFromJson(payload.status) as string }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
    ...(numberFromJson(payload.heartbeatAgeMs) === undefined
      ? {}
      : { heartbeatAgeMs: numberFromJson(payload.heartbeatAgeMs) as number }),
    ...(numberFromJson(payload.staleAfterMs) === undefined
      ? {}
      : { staleAfterMs: numberFromJson(payload.staleAfterMs) as number }),
    ...(booleanFromJson(payload.stale) === undefined
      ? {}
      : { stale: booleanFromJson(payload.stale) as boolean }),
    ...(booleanFromJson(payload.silentStale) === undefined
      ? {}
      : { silentStale: booleanFromJson(payload.silentStale) as boolean }),
    ...(booleanFromJson(payload.heartbeatOnlyNoOutput) === undefined
      ? {}
      : {
        heartbeatOnlyNoOutput: booleanFromJson(
          payload.heartbeatOnlyNoOutput,
        ) as boolean,
      }),
    ...(numberFromJson(payload.attemptCount) === undefined
      ? {}
      : { attemptCount: numberFromJson(payload.attemptCount) as number }),
    ...(stringFromJson(payload.currentAccount) === undefined
      ? {}
      : { currentAccount: stringFromJson(payload.currentAccount) as string }),
  };
}

function workspaceFromPayload(payload: JsonObject): RunObservationWorkspace {
  return {
    ...(stringFromJson(payload.path) === undefined
      ? {}
      : { path: stringFromJson(payload.path) as string }),
    ...(stringFromJson(payload.key) === undefined
      ? {}
      : { key: stringFromJson(payload.key) as string }),
    ...(booleanFromJson(payload.exists) === undefined
      ? {}
      : { exists: booleanFromJson(payload.exists) as boolean }),
    ...(booleanFromJson(payload.dirty) === undefined
      ? {}
      : { dirty: booleanFromJson(payload.dirty) as boolean }),
    ...(numberFromJson(payload.changedFilesCount) === undefined
      ? {}
      : { changedFilesCount: numberFromJson(payload.changedFilesCount) as number }),
    changedFiles: stringArrayFromJson(payload.changedFiles),
    ...(stringFromJson(payload.warning) === undefined
      ? {}
      : { warning: stringFromJson(payload.warning) as string }),
  };
}

function resultFromPayload(payload: JsonObject): RunObservationResult {
  return {
    ...(booleanFromJson(payload.exists) === undefined
      ? {}
      : { exists: booleanFromJson(payload.exists) as boolean }),
    ...(stringFromJson(payload.status) === undefined
      ? {}
      : { status: stringFromJson(payload.status) as string }),
    ...(stringFromJson(payload.reason) === undefined
      ? {}
      : { reason: stringFromJson(payload.reason) as string }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
  };
}

function outputFromPayload(payload: JsonObject): RunLogExcerpt {
  return {
    exists: true,
    ...(numberFromJson(payload.byteLength) === undefined
      ? {}
      : { byteLength: numberFromJson(payload.byteLength) as number }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
  };
}

function capacityFromEventPayload(
  payload: JsonObject,
): readonly RunCapacityHint[] | undefined {
  const items = objectArrayFromJson(payload.capacity);
  if (items === undefined) return undefined;
  return items.map((item) => ({
    ...(stringFromJson(item.account) === undefined
      ? {}
      : { account: stringFromJson(item.account) as string }),
    ...(stringFromJson(item.status) === undefined
      ? {}
      : { status: stringFromJson(item.status) as string }),
    ...(stringFromJson(item.availability) === undefined
      ? {}
      : { availability: stringFromJson(item.availability) as string }),
    ...(stringFromJson(item.reason) === undefined
      ? {}
      : { reason: stringFromJson(item.reason) as string }),
    ...(stringFromJson(item.cooldownUntil) === undefined
      ? {}
      : { cooldownUntil: stringFromJson(item.cooldownUntil) as string }),
    ...(stringFromJson(item.warning) === undefined
      ? {}
      : { warning: stringFromJson(item.warning) as string }),
  }));
}

function controlInboxFromEventPayload(
  payload: JsonObject,
): RunControlInboxSummary | undefined {
  const source = objectFromJson(payload.controlInbox);
  if (source === undefined) return undefined;
  return {
    ...(numberFromJson(source.pendingCount) === undefined
      ? {}
      : { pendingCount: numberFromJson(source.pendingCount) as number }),
    ...(numberFromJson(source.deliveredCount) === undefined
      ? {}
      : { deliveredCount: numberFromJson(source.deliveredCount) as number }),
    ...(numberFromJson(source.blockedDeliveryCount) === undefined
      ? {}
      : {
        blockedDeliveryCount: numberFromJson(
          source.blockedDeliveryCount,
        ) as number,
      }),
    ...(booleanFromJson(source.safeToContinue) === undefined
      ? {}
      : { safeToContinue: booleanFromJson(source.safeToContinue) as boolean }),
    ...(stringFromJson(source.latestSignalAt) === undefined
      ? {}
      : { latestSignalAt: stringFromJson(source.latestSignalAt) as string }),
    ...(stringFromJson(source.latestDeliveredAt) === undefined
      ? {}
      : { latestDeliveredAt: stringFromJson(source.latestDeliveredAt) as string }),
  };
}

function runEventId(input: {
  readonly runId: string;
  readonly jobId?: string;
  readonly type: RunEventType;
  readonly source: RunEventSource;
  readonly idempotencyParts: readonly JsonValue[];
}): string {
  const material = stableJsonString({
    runId: input.runId,
    jobId: input.jobId ?? null,
    type: input.type,
    source: {
      providerKind: input.source.providerKind,
      hostId: input.source.hostId ?? null,
      registryRootDir: input.source.registryRootDir ?? null,
      workspaceKey: input.source.workspaceKey ?? null,
    },
    idempotencyParts: input.idempotencyParts,
  });
  return createHash("sha256").update(material).digest("hex");
}

function runEventSourceFromSnapshot(input: {
  readonly snapshot: RunObservationSnapshot;
  readonly providerKind: RunEventProviderKind;
  readonly hostId?: string;
  readonly registryRootDir?: string;
}): RunEventSource {
  return {
    providerKind: input.providerKind,
    ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
    ...(input.registryRootDir === undefined
      ? {}
      : { registryRootDir: input.registryRootDir }),
    ...(input.snapshot.workspace?.key === undefined
      ? {}
      : { workspaceKey: input.snapshot.workspace.key }),
  };
}

function snapshotPayload(snapshot: RunObservationSnapshot): JsonObject {
  return compactJsonObject({
    status: snapshot.status,
    liveness: snapshot.liveness,
    classification: snapshot.classification,
    recommendedAction: snapshot.recommendedAction,
    readOnlyDecision: {
      kind: snapshot.readOnlyDecision.kind,
      reason: snapshot.readOnlyDecision.reason,
    },
  });
}

function resultSeverity(status: string | undefined): RunEventSeverity {
  if (status === "failed") return RunEventSeverity.Critical;
  if (status === "blocked") return RunEventSeverity.Blocked;
  return RunEventSeverity.Info;
}

function decisionSeverity(kind: string): RunEventSeverity {
  if (kind === "unsafe_state_mismatch") return RunEventSeverity.Critical;
  if (
    kind === "manual_review_required" ||
    kind === "capacity_blocked" ||
    kind === "stale_needs_inspection"
  ) {
    return RunEventSeverity.Blocked;
  }
  return RunEventSeverity.Info;
}

function capacitySeverity(
  capacity: readonly RunCapacityHint[] | undefined,
): RunEventSeverity {
  return capacity?.some((item) =>
    item.availability === "cooldown" ||
    item.status === "blocked" ||
    item.status === "invalid"
  ) ? RunEventSeverity.Blocked : RunEventSeverity.Info;
}

function controlInboxSeverity(
  controlInbox: RunControlInboxSummary | undefined,
): RunEventSeverity {
  if ((controlInbox?.blockedDeliveryCount ?? 0) > 0) {
    return RunEventSeverity.Warning;
  }
  return RunEventSeverity.Info;
}

function workspacePayload(
  workspace: RunObservationWorkspace | undefined,
): JsonObject {
  return compactJsonObject({
    path: workspace?.path,
    key: workspace?.key,
    exists: workspace?.exists,
    dirty: workspace?.dirty,
    changedFilesCount: workspace?.changedFilesCount,
    changedFiles: jsonArray(workspace?.changedFiles?.slice(0, 200)),
    warning: workspace?.warning,
  });
}

function workspaceSignature(
  workspace: RunObservationWorkspace | undefined,
): string | undefined {
  if (!workspace) return undefined;
  return stableJsonString(compactJsonObject({
    dirty: workspace.dirty,
    changedFilesCount: workspace.changedFilesCount,
    changedFiles: [...(workspace.changedFiles ?? [])].sort(),
  }));
}

function capacityPayload(
  capacity: readonly RunCapacityHint[] | undefined,
): readonly JsonObject[] {
  return [...(capacity ?? [])]
    .map((item) =>
      compactJsonObject({
        account: maskAccountIdentity(item.account),
        status: item.status,
        availability: item.availability,
        reason: item.reason,
        cooldownUntil: item.cooldownUntil,
        warning: item.warning,
      })
    )
    .sort((left, right) =>
      String(left.account ?? "").localeCompare(String(right.account ?? ""))
    );
}

function controlInboxPayload(
  controlInbox: RunControlInboxSummary | undefined,
): JsonObject {
  return compactJsonObject({
    pendingCount: controlInbox?.pendingCount,
    acceptedCount: controlInbox?.acceptedCount,
    deliverableCount: controlInbox?.deliverableCount,
    deliveredCount: controlInbox?.deliveredCount,
    failedCount: controlInbox?.failedCount,
    blockedDeliveryCount: controlInbox?.blockedDeliveryCount,
    safeToContinue: controlInbox?.safeToContinue,
    latestSignalAt: controlInbox?.latestSignalAt,
    latestDeliveredAt: controlInbox?.latestDeliveredAt,
  });
}

function compactJsonObject(
  input: Readonly<Record<string, JsonValue | undefined>>,
): JsonObject {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value as JsonValue] as const);
  return Object.fromEntries(entries) as JsonObject;
}

function jsonArray(value: readonly string[] | undefined): readonly JsonValue[] | undefined {
  return value?.map((item) => item);
}

function sanitizeJsonObject(input: JsonObject, depth: number): JsonObject {
  if (depth > 12) return {};
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input).slice(0, 200)) {
    if (isSensitiveKey(key)) {
      output[key] = "<redacted>";
      continue;
    }
    output[key] = sanitizeJsonValue(value, depth + 1);
  }
  return output;
}

function sanitizeJsonValue(value: JsonValue, depth: number): JsonValue {
  if (typeof value === "string") {
    return value.length > 4_096 ? `${value.slice(0, 4_096)}<truncated>` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth > 12) return [];
    return value.slice(0, 500).map((item) => sanitizeJsonValue(item, depth + 1));
  }
  return sanitizeJsonObject(value as JsonObject, depth);
}

function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|apiKey|apiToken|token|secret|credential|cookie|authorization|authJson|authPayload|auth[_-]?json|auth[_-]?payload)/i
    .test(key);
}

function runtimeIssueKindFromDecisionReason(reason: string): RunRuntimeIssueKind {
  switch (reason) {
    case RunRuntimeIssueKind.WorkerObservable:
      return RunRuntimeIssueKind.WorkerObservable;
    case RunRuntimeIssueKind.TerminalResultCompleted:
      return RunRuntimeIssueKind.TerminalResultCompleted;
    case RunRuntimeIssueKind.CompletedResultWithLiveProcess:
      return RunRuntimeIssueKind.CompletedResultWithLiveProcess;
    case RunRuntimeIssueKind.StoppedRunWithRunningProgress:
      return RunRuntimeIssueKind.StoppedRunWithRunningProgress;
    case RunRuntimeIssueKind.ObservableProgressStale:
      return RunRuntimeIssueKind.ObservableProgressStale;
    case RunRuntimeIssueKind.HeartbeatOnlyNoOutput:
      return RunRuntimeIssueKind.HeartbeatOnlyNoOutput;
    case RunRuntimeIssueKind.AccountOrCapacityUnavailable:
      return RunRuntimeIssueKind.AccountOrCapacityUnavailable;
    case RunRuntimeIssueKind.DirtyWorkspaceWithoutRunningWorker:
      return RunRuntimeIssueKind.DirtyWorkspaceWithoutRunningWorker;
    case RunRuntimeIssueKind.StoppedWithoutTerminalResult:
      return RunRuntimeIssueKind.StoppedWithoutTerminalResult;
    case RunRuntimeIssueKind.NonRunningOrUnknownFailure:
      return RunRuntimeIssueKind.NonRunningOrUnknownFailure;
    case RunRuntimeIssueKind.GuidancePending:
      return RunRuntimeIssueKind.GuidancePending;
    case RunRuntimeIssueKind.GuidanceDelivered:
      return RunRuntimeIssueKind.GuidanceDelivered;
    case RunRuntimeIssueKind.ManualReviewRequired:
      return RunRuntimeIssueKind.ManualReviewRequired;
    case RunRuntimeIssueKind.ControlInboxBlocked:
      return RunRuntimeIssueKind.ControlInboxBlocked;
    default:
      return RunRuntimeIssueKind.Unknown;
  }
}

function isBlockedCapacityHint(hint: RunCapacityHint): boolean {
  return hint.status === "auth_missing" ||
    hint.status === "auth_invalid" ||
    hint.status === "blocked" ||
    hint.status === "invalid" ||
    hint.availability === "cooldown" ||
    hint.availability === "quota_exhausted" ||
    hint.availability === "disabled";
}

function maskAccountIdentity(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  if (at < 0) {
    return trimmed.length <= 4
      ? "***"
      : `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  return `${maskPart(local)}@${maskDomain(domain)}`;
}

function maskPart(value: string): string {
  if (value.length <= 2) return `${value[0] ?? ""}***`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function maskDomain(value: string): string {
  const [name = "", ...rest] = value.split(".");
  const suffix = rest.length === 0 ? "" : `.${rest.join(".")}`;
  return `${maskPart(name)}${suffix}`;
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function stableJsonString(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJsonValue);
  const sorted: Record<string, JsonValue> = {};
  const objectValue = value as JsonObject;
  for (const key of Object.keys(objectValue).sort()) {
    sorted[key] = sortJsonValue(objectValue[key] ?? null);
  }
  return sorted;
}

function coerceJsonObject(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const coerced = coerceJsonValue(item);
    if (coerced === undefined) return null;
    output[key] = coerced;
  }
  return output;
}

function coerceJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const coerced = coerceJsonValue(item);
      if (coerced === undefined) return undefined;
      items.push(coerced);
    }
    return items;
  }
  if (isRecord(value)) return coerceJsonObject(value) ?? undefined;
  return undefined;
}

function stringFromJson(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberFromJson(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanFromJson(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectFromJson(value: JsonValue | undefined): JsonObject | undefined {
  return value !== undefined && value !== null &&
      typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function objectArrayFromJson(
  value: JsonValue | undefined,
): readonly JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.filter((item): item is JsonObject =>
    item !== null && typeof item === "object" && !Array.isArray(item)
  );
  return output.length === value.length ? output : undefined;
}

function stringArrayFromJson(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function isRunEventType(value: string): value is RunEventType {
  return Object.values(RunEventType).includes(value as RunEventType);
}

export function isRunEventCompactionSafetyMode(
  value: string,
): value is RunEventCompactionSafetyMode {
  return Object.values(RunEventCompactionSafetyMode).includes(
    value as RunEventCompactionSafetyMode,
  );
}

function isRunEventSeverity(value: string): value is RunEventSeverity {
  return Object.values(RunEventSeverity).includes(value as RunEventSeverity);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
