import { describe, expect, it } from "vitest";

import {
  RunEventOrchestratorActionKind,
  RunEventOrchestratorNotificationKind,
  RunEventOrchestratorSkipReason,
  RunEventOrchestratorService,
  type RunEventOrchestratorControlCommand,
  type RunEventOrchestratorControlPort,
  type RunEventOrchestratorNotification,
  type RunEventOrchestratorNotificationPort,
  type RunEventOrchestratorPolicy,
  type RunEventOrchestratorPolicyState,
  type RunEventOrchestratorStateStorePort,
} from "../index";
import {
  RunEventProviderKind,
  RunEventSeverity,
  RunEventType,
  makeRunEvent,
  type RunEvent,
  type RunEventAppendResult,
  type RunEventCursor,
  type RunEventReadRequest,
  type RunEventStorePort,
} from "@vioxen/subscription-runtime/worker-core";

describe("RunEventOrchestratorService", () => {
  it("notifies on completed events and advances cursor", async () => {
    const eventStore = new MemoryRunEventStore([
      event(RunEventType.Completed, { idempotencyParts: ["completed"] }),
    ]);
    const stateStore = new MemoryOrchestratorStateStore();
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore,
      stateStore,
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result).toMatchObject({
      readCount: 1,
      processedCount: 1,
      actions: [
        {
          kind: RunEventOrchestratorActionKind.Notify,
          notificationKind: RunEventOrchestratorNotificationKind.RunCompleted,
        },
      ],
      nextCursor: { value: "1" },
    });
    expect(notifications.items).toHaveLength(1);
    expect(control.items).toHaveLength(0);
    await expect(stateStore.readState("orch-a")).resolves.toMatchObject({
      cursor: { value: "1" },
    });
  });

  it("writes record-only control guidance for failed events", async () => {
    const failed = event(RunEventType.Failed, {
      severity: RunEventSeverity.Critical,
      payload: { reason: "app_server_goal_blocked" },
      correlationId: "corr-run-a",
      causationId: "parent-event",
      idempotencyParts: ["failed"],
    });
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([failed]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions.map((item) => item.kind)).toEqual([
      RunEventOrchestratorActionKind.Notify,
      RunEventOrchestratorActionKind.EnqueueControl,
    ]);
    expect(notifications.items).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorNotificationKind.RunNeedsAttention,
      }),
    ]);
    expect(control.items).toEqual([
      expect.objectContaining({
        deliveryMode: "record_only",
        intent: "operator_note",
        priority: "high",
        target: expect.objectContaining({
          jobId: "run-a",
          taskId: "run-a",
        }),
        metadata: expect.objectContaining({
          eventId: failed.eventId,
          eventType: "run.failed",
          runId: "run-a",
          correlationId: "corr-run-a",
          causationId: failed.eventId,
          parentCausationId: "parent-event",
          attemptKey: "control:run-a:run.failed:orchestrator_review_required",
          attemptCount: "1",
          maxAttempts: "3",
        }),
      }),
    ]);
  });

  it("does not create a control loop from control inbox change events", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.ControlInboxChanged, {
          idempotencyParts: ["control-inbox"],
        }),
      ]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorActionKind.Skip,
      }),
    ]);
    expect(control.items).toHaveLength(0);
    expect(notifications.items).toHaveLength(0);
  });

  it("suppresses repeated action families while cooldown is active", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.Stale, {
          payload: { reason: "heartbeat_only_no_output" },
          idempotencyParts: ["stale-a"],
        }),
        event(RunEventType.Stale, {
          payload: { reason: "heartbeat_only_no_output" },
          idempotencyParts: ["stale-b"],
        }),
      ]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(notifications.items).toHaveLength(1);
    expect(control.items).toHaveLength(1);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: RunEventOrchestratorActionKind.Skip,
          reason: "cooldown_active",
        }),
      ]),
    );
  });

  it("stops enqueueing control guidance after max control attempts", async () => {
    const stateStore = new MemoryOrchestratorStateStore();
    await stateStore.writeState({
      schemaVersion: 1,
      orchestratorId: "orch-a",
      processedEventIds: [],
      cooldowns: [],
      actionAttempts: [{
        key: "control:run-a:run.stale:orchestrator_review_required",
        count: 1,
        latestEventId: "older-event",
        latestAttemptAt: "2026-07-01T00:00:00.000Z",
      }],
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.Stale, {
          payload: { reason: "heartbeat_only_no_output" },
          idempotencyParts: ["stale"],
        }),
      ]),
      stateStore,
      control,
      notifications,
      policy: {
        maxControlAttempts: 1,
      },
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(notifications.items).toHaveLength(1);
    expect(control.items).toHaveLength(0);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: RunEventOrchestratorActionKind.Skip,
          reason: RunEventOrchestratorSkipReason.MaxAttemptsExceeded,
        }),
      ]),
    );
    await expect(stateStore.readState("orch-a")).resolves.toMatchObject({
      actionAttempts: [
        expect.objectContaining({
          key: "control:run-a:run.stale:orchestrator_review_required",
          count: 1,
        }),
      ],
    });
  });

  it("raises unsafe notification and record-only guidance for unsafe state", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const unsafe = event(RunEventType.UnsafeStateDetected, {
      severity: RunEventSeverity.Critical,
      payload: { reason: "completed_result_with_live_process" },
      idempotencyParts: ["unsafe"],
    });
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([unsafe]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions.map((item) => item.kind)).toEqual([
      RunEventOrchestratorActionKind.Notify,
      RunEventOrchestratorActionKind.EnqueueControl,
    ]);
    expect(notifications.items).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorNotificationKind.RuntimeUnsafe,
      }),
    ]);
    expect(control.items).toEqual([
      expect.objectContaining({
        deliveryMode: "record_only",
        priority: "high",
        metadata: expect.objectContaining({
          reason: "orchestrator_unsafe_state_detected",
        }),
      }),
    ]);
  });

  it("notifies but does not enqueue control for blocked capacity events", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.CapacityChanged, {
          severity: RunEventSeverity.Blocked,
          payload: { reason: "account_or_capacity_unavailable" },
          idempotencyParts: ["capacity"],
        }),
      ]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorActionKind.Notify,
        notificationKind: RunEventOrchestratorNotificationKind.CapacityBlocked,
      }),
    ]);
    expect(control.items).toHaveLength(0);
    expect(notifications.items).toHaveLength(1);
  });

  it("keeps maintenance pause as a no-policy action", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.MaintenancePaused, {
          payload: { reason: "resize" },
          idempotencyParts: ["maintenance"],
        }),
      ]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorActionKind.Skip,
        reason: "no_policy_action",
      }),
    ]);
    expect(control.items).toHaveLength(0);
    expect(notifications.items).toHaveLength(0);
  });

  it("maps manual-review decision changes to attention and control guidance", async () => {
    const control = new MemoryControlPort();
    const notifications = new MemoryNotificationPort();
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.DecisionChanged, {
          severity: RunEventSeverity.Blocked,
          payload: {
            kind: "manual_review_required",
            reason: "dirty_workspace_without_running_worker",
          },
          idempotencyParts: ["decision"],
        }),
      ]),
      stateStore: new MemoryOrchestratorStateStore(),
      control,
      notifications,
    });

    const result = await service.tick({ orchestratorId: "orch-a" });

    expect(result.actions.map((item) => item.kind)).toEqual([
      RunEventOrchestratorActionKind.Notify,
      RunEventOrchestratorActionKind.EnqueueControl,
    ]);
    expect(notifications.items).toEqual([
      expect.objectContaining({
        kind: RunEventOrchestratorNotificationKind.RunNeedsAttention,
      }),
    ]);
    expect(control.items).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: "orchestrator_review_required",
        }),
      }),
    ]);
  });

  it("does not advance cursor when a notification fails", async () => {
    const stateStore = new MemoryOrchestratorStateStore();
    const notifications = new MemoryNotificationPort({ fail: true });
    const service = serviceWith({
      eventStore: new MemoryRunEventStore([
        event(RunEventType.Completed, { idempotencyParts: ["completed"] }),
      ]),
      stateStore,
      control: new MemoryControlPort(),
      notifications,
    });

    await expect(service.tick({ orchestratorId: "orch-a" }))
      .rejects.toThrow("notification_failed");
    await expect(stateStore.readState("orch-a")).resolves.toBeNull();
  });
});

function serviceWith(input: {
  readonly eventStore: RunEventStorePort;
  readonly stateStore: RunEventOrchestratorStateStorePort;
  readonly control: RunEventOrchestratorControlPort;
  readonly notifications: RunEventOrchestratorNotificationPort;
  readonly policy?: RunEventOrchestratorPolicy;
}) {
  return new RunEventOrchestratorService({
    eventStore: input.eventStore,
    stateStore: input.stateStore,
    controlPort: input.control,
    notificationPort: input.notifications,
    clock: { now: () => new Date("2026-07-02T00:00:00.000Z") },
    policy: {
      actionCooldownMs: 60_000,
      ...input.policy,
    },
  });
}

function event(
  type: RunEventType,
  input: {
    readonly severity?: RunEventSeverity;
    readonly payload?: Record<string, string>;
    readonly correlationId?: string;
    readonly causationId?: string;
    readonly idempotencyParts: readonly string[];
  },
): RunEvent {
  return makeRunEvent({
    runId: "run-a",
    type,
    occurredAt: "2026-07-02T00:00:00.000Z",
    source: {
      providerKind: RunEventProviderKind.Codex,
    },
    payload: input.payload ?? {},
    idempotencyParts: input.idempotencyParts,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
  });
}

class MemoryRunEventStore implements RunEventStorePort {
  constructor(private readonly events: readonly RunEvent[]) {}

  async append(): Promise<RunEventAppendResult> {
    throw new Error("append_not_supported");
  }

  async read(input: RunEventReadRequest = {}) {
    const start = Number.parseInt(input.cursor?.value ?? "0", 10);
    const selected = this.events.slice(
      start,
      input.limit === undefined ? undefined : start + input.limit,
    );
    return {
      events: selected,
      nextCursor: { value: String(start + selected.length) },
      warnings: [],
    };
  }
}

class MemoryOrchestratorStateStore implements RunEventOrchestratorStateStorePort {
  private readonly states = new Map<string, RunEventOrchestratorPolicyState>();

  async readState(
    orchestratorId: string,
  ): Promise<RunEventOrchestratorPolicyState | null> {
    return this.states.get(orchestratorId) ?? null;
  }

  async writeState(state: RunEventOrchestratorPolicyState): Promise<void> {
    this.states.set(state.orchestratorId, state);
  }
}

class MemoryNotificationPort implements RunEventOrchestratorNotificationPort {
  readonly items: RunEventOrchestratorNotification[] = [];

  constructor(private readonly options: { readonly fail?: boolean } = {}) {}

  async notify(notification: RunEventOrchestratorNotification): Promise<void> {
    if (this.options.fail) throw new Error("notification_failed");
    this.items.push(notification);
  }
}

class MemoryControlPort implements RunEventOrchestratorControlPort {
  readonly items: RunEventOrchestratorControlCommand[] = [];

  async enqueue(command: RunEventOrchestratorControlCommand) {
    this.items.push(command);
    return {
      signalId: `signal-${this.items.length}`,
    };
  }
}
