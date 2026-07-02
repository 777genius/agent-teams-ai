import {
  RunEventSeverity,
  RunEventType,
  type RunEvent,
  type RunEventCursor,
  type RunEventReadWarning,
  type RunEventStorePort,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  WorkerControlDeliveryMode,
  WorkerControlIntent,
  WorkerControlPriority,
  WorkerControlSignal,
  WorkerControlTarget,
} from "@vioxen/subscription-runtime/worker-core";

export enum RunEventOrchestratorActionKind {
  Notify = "notify",
  EnqueueControl = "enqueue_control",
  Skip = "skip",
}

export enum RunEventOrchestratorNotificationKind {
  RunCompleted = "run_completed",
  RunNeedsAttention = "run_needs_attention",
  RuntimeUnsafe = "runtime_unsafe",
  CapacityBlocked = "capacity_blocked",
}

export enum RunEventOrchestratorSkipReason {
  AlreadyProcessed = "already_processed",
  CooldownActive = "cooldown_active",
  MaxAttemptsExceeded = "max_attempts_exceeded",
  NoPolicyAction = "no_policy_action",
}

export type RunEventOrchestratorCooldown = {
  readonly key: string;
  readonly until: string;
};

export type RunEventOrchestratorActionAttempt = {
  readonly key: string;
  readonly count: number;
  readonly latestEventId: string;
  readonly latestAttemptAt: string;
};

export type RunEventOrchestratorPolicyState = {
  readonly schemaVersion: 1;
  readonly orchestratorId: string;
  readonly cursor?: RunEventCursor;
  readonly processedEventIds: readonly string[];
  readonly cooldowns: readonly RunEventOrchestratorCooldown[];
  readonly actionAttempts?: readonly RunEventOrchestratorActionAttempt[];
  readonly updatedAt: string;
};

export type RunEventOrchestratorStateStorePort = {
  readState(orchestratorId: string): Promise<RunEventOrchestratorPolicyState | null>;
  writeState(state: RunEventOrchestratorPolicyState): Promise<void>;
};

export type RunEventOrchestratorNotification = {
  readonly idempotencyKey: string;
  readonly kind: RunEventOrchestratorNotificationKind;
  readonly title: string;
  readonly body: string;
  readonly event: RunEvent;
};

export type RunEventOrchestratorNotificationPort = {
  notify(notification: RunEventOrchestratorNotification): Promise<void>;
};

export type RunEventOrchestratorControlCommand = {
  readonly idempotencyKey: string;
  readonly target: WorkerControlTarget;
  readonly intent: WorkerControlIntent;
  readonly deliveryMode: WorkerControlDeliveryMode;
  readonly body: string;
  readonly priority: WorkerControlPriority;
  readonly metadata: Readonly<Record<string, string>>;
};

export type RunEventOrchestratorControlResult = {
  readonly signalId?: string;
  readonly deduped?: boolean;
};

export type RunEventOrchestratorControlPort = {
  enqueue(command: RunEventOrchestratorControlCommand): Promise<RunEventOrchestratorControlResult>;
};

export type RunEventOrchestratorAppliedAction =
  | {
      readonly kind: RunEventOrchestratorActionKind.Notify;
      readonly eventId: string;
      readonly runId: string;
      readonly idempotencyKey: string;
      readonly notificationKind: RunEventOrchestratorNotificationKind;
    }
  | {
      readonly kind: RunEventOrchestratorActionKind.EnqueueControl;
      readonly eventId: string;
      readonly runId: string;
      readonly idempotencyKey: string;
      readonly signalId?: string;
      readonly deduped?: boolean;
    }
  | {
      readonly kind: RunEventOrchestratorActionKind.Skip;
      readonly eventId: string;
      readonly runId: string;
      readonly reason: RunEventOrchestratorSkipReason;
    };

export type RunEventOrchestratorTickResult = {
  readonly orchestratorId: string;
  readonly readCount: number;
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly actions: readonly RunEventOrchestratorAppliedAction[];
  readonly nextCursor?: RunEventCursor;
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventOrchestratorPolicy = {
  readonly actionCooldownMs?: number;
  readonly actionAttemptLimit?: number;
  readonly maxControlAttempts?: number;
  readonly processedEventLimit?: number;
};

export class RunEventOrchestratorService {
  private readonly actionCooldownMs: number;
  private readonly actionAttemptLimit: number;
  private readonly maxControlAttempts: number;
  private readonly processedEventLimit: number;
  private readonly clock: { now(): Date };

  constructor(private readonly options: {
    readonly eventStore: RunEventStorePort;
    readonly stateStore: RunEventOrchestratorStateStorePort;
    readonly controlPort: RunEventOrchestratorControlPort;
    readonly notificationPort: RunEventOrchestratorNotificationPort;
    readonly policy?: RunEventOrchestratorPolicy;
    readonly clock?: { now(): Date };
  }) {
    this.actionCooldownMs = options.policy?.actionCooldownMs ?? 10 * 60_000;
    this.actionAttemptLimit = options.policy?.actionAttemptLimit ?? 1_000;
    this.maxControlAttempts = options.policy?.maxControlAttempts ?? 3;
    this.processedEventLimit = options.policy?.processedEventLimit ?? 1_000;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async tick(input: {
    readonly orchestratorId: string;
    readonly limit?: number;
    readonly runId?: string;
    readonly types?: readonly RunEventType[];
  }): Promise<RunEventOrchestratorTickResult> {
    if (!input.orchestratorId.trim()) {
      throw new Error("run_event_orchestrator_id_required");
    }
    const state = await this.readState(input.orchestratorId);
    const read = await this.options.eventStore.read({
      ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.types === undefined ? {} : { types: input.types }),
    });
    const now = this.clock.now();
    const processedEventIds = new Set(state.processedEventIds);
    const cooldowns = new Map(
      state.cooldowns
        .filter((item) => new Date(item.until).getTime() > now.getTime())
        .map((item) => [item.key, item.until] as const),
    );
    const actionAttempts = new Map(
      (state.actionAttempts ?? []).map((item) => [item.key, item] as const),
    );
    const actions: RunEventOrchestratorAppliedAction[] = [];
    let skippedCount = 0;
    let processedCount = 0;

    for (const event of read.events) {
      if (processedEventIds.has(event.eventId)) {
        skippedCount += 1;
        actions.push(skipAction(event, RunEventOrchestratorSkipReason.AlreadyProcessed));
        continue;
      }
      const plans = planActionsForEvent(event);
      if (plans.length === 0) {
        skippedCount += 1;
        actions.push(skipAction(event, RunEventOrchestratorSkipReason.NoPolicyAction));
        processedEventIds.add(event.eventId);
        continue;
      }
      for (const plan of plans) {
        if (cooldowns.has(plan.cooldownKey)) {
          skippedCount += 1;
          actions.push(skipAction(event, RunEventOrchestratorSkipReason.CooldownActive));
          continue;
        }
        if (plan.kind === RunEventOrchestratorActionKind.Notify) {
          await this.options.notificationPort.notify(plan.notification);
          actions.push({
            kind: RunEventOrchestratorActionKind.Notify,
            eventId: event.eventId,
            runId: event.runId,
            idempotencyKey: plan.notification.idempotencyKey,
            notificationKind: plan.notification.kind,
          });
        } else {
          const existingAttemptCount = actionAttempts.get(plan.attemptKey)?.count ?? 0;
          if (existingAttemptCount >= this.maxControlAttempts) {
            skippedCount += 1;
            actions.push(
              skipAction(event, RunEventOrchestratorSkipReason.MaxAttemptsExceeded),
            );
            continue;
          }
          const nextAttemptCount = existingAttemptCount + 1;
          const command = commandWithAttemptMetadata({
            command: plan.command,
            attemptKey: plan.attemptKey,
            attemptCount: nextAttemptCount,
            maxAttempts: this.maxControlAttempts,
          });
          const result = await this.options.controlPort.enqueue(command);
          actionAttempts.set(plan.attemptKey, {
            key: plan.attemptKey,
            count: nextAttemptCount,
            latestEventId: event.eventId,
            latestAttemptAt: now.toISOString(),
          });
          actions.push({
            kind: RunEventOrchestratorActionKind.EnqueueControl,
            eventId: event.eventId,
            runId: event.runId,
            idempotencyKey: command.idempotencyKey,
            ...(result.signalId === undefined ? {} : { signalId: result.signalId }),
            ...(result.deduped === undefined ? {} : { deduped: result.deduped }),
          });
        }
        cooldowns.set(
          plan.cooldownKey,
          new Date(now.getTime() + this.actionCooldownMs).toISOString(),
        );
      }
      processedEventIds.add(event.eventId);
      processedCount += 1;
    }

    const nextState: RunEventOrchestratorPolicyState = {
      schemaVersion: 1,
      orchestratorId: input.orchestratorId,
      ...(read.nextCursor === undefined ? {} : { cursor: read.nextCursor }),
      processedEventIds: [...processedEventIds].slice(-this.processedEventLimit),
      cooldowns: [...cooldowns.entries()].map(([key, until]) => ({ key, until })),
      actionAttempts: [...actionAttempts.values()].slice(-this.actionAttemptLimit),
      updatedAt: now.toISOString(),
    };
    await this.options.stateStore.writeState(nextState);
    return {
      orchestratorId: input.orchestratorId,
      readCount: read.events.length,
      processedCount,
      skippedCount,
      actions,
      ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
      warnings: read.warnings,
    };
  }

  private async readState(
    orchestratorId: string,
  ): Promise<RunEventOrchestratorPolicyState> {
    return await this.options.stateStore.readState(orchestratorId) ?? {
      schemaVersion: 1,
      orchestratorId,
      processedEventIds: [],
      cooldowns: [],
      actionAttempts: [],
      updatedAt: this.clock.now().toISOString(),
    };
  }
}

type PlannedAction =
  | {
      readonly kind: RunEventOrchestratorActionKind.Notify;
      readonly cooldownKey: string;
      readonly notification: RunEventOrchestratorNotification;
    }
  | {
      readonly kind: RunEventOrchestratorActionKind.EnqueueControl;
      readonly attemptKey: string;
      readonly cooldownKey: string;
      readonly command: RunEventOrchestratorControlCommand;
    };

function planActionsForEvent(event: RunEvent): readonly PlannedAction[] {
  switch (event.type) {
    case RunEventType.Completed:
      return [notifyPlan(event, RunEventOrchestratorNotificationKind.RunCompleted)];
    case RunEventType.Failed:
    case RunEventType.Blocked:
    case RunEventType.Stale:
      return [
        notifyPlan(event, RunEventOrchestratorNotificationKind.RunNeedsAttention),
        controlPlan(event, "orchestrator_review_required", "high"),
      ];
    case RunEventType.UnsafeStateDetected:
      return [
        notifyPlan(event, RunEventOrchestratorNotificationKind.RuntimeUnsafe),
        controlPlan(event, "orchestrator_unsafe_state_detected", "high"),
      ];
    case RunEventType.CapacityChanged:
      return event.severity === RunEventSeverity.Blocked ||
          event.severity === RunEventSeverity.Critical
        ? [notifyPlan(event, RunEventOrchestratorNotificationKind.CapacityBlocked)]
        : [];
    case RunEventType.DecisionChanged:
      return decisionChangedPlans(event);
    case RunEventType.ControlInboxChanged:
      return [];
    case RunEventType.ObservationRecorded:
    case RunEventType.ProgressUpdated:
    case RunEventType.OutputGrew:
    case RunEventType.WorkspaceChanged:
    case RunEventType.ResultUpdated:
    case RunEventType.MaintenancePaused:
      return [];
  }
}

function decisionChangedPlans(event: RunEvent): readonly PlannedAction[] {
  const decisionKind = stringPayload(event, "kind");
  if (decisionKind === "unsafe_state_mismatch") {
    return [
      notifyPlan(event, RunEventOrchestratorNotificationKind.RuntimeUnsafe),
      controlPlan(event, "orchestrator_unsafe_state_detected", "high"),
    ];
  }
  if (
    decisionKind === "manual_review_required" ||
    decisionKind === "stale_needs_inspection" ||
    decisionKind === "capacity_blocked"
  ) {
    return [
      notifyPlan(event, RunEventOrchestratorNotificationKind.RunNeedsAttention),
      controlPlan(event, "orchestrator_review_required", "normal"),
    ];
  }
  return [];
}

function notifyPlan(
  event: RunEvent,
  kind: RunEventOrchestratorNotificationKind,
): PlannedAction {
  const reason = eventReason(event);
  return {
    kind: RunEventOrchestratorActionKind.Notify,
    cooldownKey: cooldownKey("notify", event, reason),
    notification: {
      idempotencyKey: idempotencyKey("notify", event),
      kind,
      title: notificationTitle(kind, event),
      body: notificationBody(event, reason),
      event,
    },
  };
}

function controlPlan(
  event: RunEvent,
  reason: string,
  priority: WorkerControlPriority,
): PlannedAction {
  const attemptKey = cooldownKey("control", event, reason);
  return {
    kind: RunEventOrchestratorActionKind.EnqueueControl,
    attemptKey,
    cooldownKey: attemptKey,
    command: {
      idempotencyKey: idempotencyKey("control", event),
      target: targetFromEvent(event),
      intent: "operator_note",
      deliveryMode: "record_only",
      body: `Orchestrator review required for ${event.runId}: ${event.type}. ${eventReason(event)}`,
      priority,
      metadata: {
        source: "run-event-orchestrator",
        eventId: event.eventId,
        eventType: event.type,
        runId: event.runId,
        correlationId: event.correlationId,
        causationId: event.eventId,
        ...(event.causationId === undefined
          ? {}
          : { parentCausationId: event.causationId }),
        reason,
      },
    },
  };
}

function commandWithAttemptMetadata(input: {
  readonly command: RunEventOrchestratorControlCommand;
  readonly attemptKey: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}): RunEventOrchestratorControlCommand {
  return {
    ...input.command,
    metadata: {
      ...input.command.metadata,
      attemptKey: input.attemptKey,
      attemptCount: String(input.attemptCount),
      maxAttempts: String(input.maxAttempts),
    },
  };
}

function targetFromEvent(event: RunEvent): WorkerControlTarget {
  return {
    jobId: event.jobId ?? event.runId,
    taskId: event.runId,
    ...(event.source.workspaceKey === undefined
      ? {}
      : { workspaceId: event.source.workspaceKey }),
  };
}

function skipAction(
  event: RunEvent,
  reason: RunEventOrchestratorSkipReason,
): RunEventOrchestratorAppliedAction {
  return {
    kind: RunEventOrchestratorActionKind.Skip,
    eventId: event.eventId,
    runId: event.runId,
    reason,
  };
}

function notificationTitle(
  kind: RunEventOrchestratorNotificationKind,
  event: RunEvent,
): string {
  switch (kind) {
    case RunEventOrchestratorNotificationKind.RunCompleted:
      return `Run completed: ${event.runId}`;
    case RunEventOrchestratorNotificationKind.RuntimeUnsafe:
      return `Unsafe runtime state: ${event.runId}`;
    case RunEventOrchestratorNotificationKind.CapacityBlocked:
      return `Capacity blocked: ${event.runId}`;
    case RunEventOrchestratorNotificationKind.RunNeedsAttention:
      return `Run needs attention: ${event.runId}`;
  }
}

function notificationBody(event: RunEvent, reason: string): string {
  return `${event.type} ${event.severity}: ${reason}`;
}

function eventReason(event: RunEvent): string {
  return stringPayload(event, "reason") ??
    stringPayload(event, "status") ??
    stringPayload(event, "classification") ??
    "no_reason";
}

function stringPayload(event: RunEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function idempotencyKey(prefix: string, event: RunEvent): string {
  return `run-event-orchestrator:${prefix}:${event.eventId}`;
}

function cooldownKey(prefix: string, event: RunEvent, reason: string): string {
  return `${prefix}:${event.runId}:${event.type}:${reason}`;
}
