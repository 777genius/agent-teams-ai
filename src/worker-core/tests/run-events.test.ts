import { describe, expect, it } from "vitest";

import {
  RunEventProviderKind,
  RunAccountCapacityStatus,
  RunEventRelayService,
  RunEventProjectionService,
  RunEventRedactionStatus,
  RunEventSeverity,
  RunEventType,
  RunLivenessStatus,
  RunOutcomeStatus,
  RunRuntimeIssueKind,
  RunSafetyStatus,
  RunWorkspaceStatus,
  makeRunEvent,
  parseRunEvent,
  projectRunObservationEvents,
  runEventReadModelsFromSnapshot,
  projectRunReadModelsFromEvents,
  runEventProjectionStateFromEvents,
  runEventProjectionStateFromSnapshot,
  runEventProviderKindFromString,
  sanitizeRunEventPayload,
  type RunEvent,
  type RunEventCursor,
  type RunEventDeliveryCursorStorePort,
  type RunEventProjectionState,
  type RunEventProjectionStateStorePort,
  type RunEventReadRequest,
  type RunEventStorePort,
  type RunObservationPort,
  type RunObservationSnapshot,
} from "../index";

describe("run events", () => {
  it("uses strict provider enums and explicit unknown mapping", () => {
    expect(runEventProviderKindFromString("codex")).toBe(RunEventProviderKind.Codex);
    expect(runEventProviderKindFromString("new-provider")).toBe(
      RunEventProviderKind.Unknown,
    );
  });

  it("builds deterministic sanitized events", () => {
    const event = makeRunEvent({
      runId: "run-a",
      type: RunEventType.ResultUpdated,
      severity: RunEventSeverity.Warning,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      payload: {
        status: "blocked",
        nested: {
          apiToken: "secret",
          auth_payload: "secret",
          safe: "visible",
        },
      },
      idempotencyParts: ["result", "blocked"],
    });
    const same = makeRunEvent({
      runId: "run-a",
      type: RunEventType.ResultUpdated,
      severity: RunEventSeverity.Warning,
      occurredAt: "2026-07-02T00:01:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      payload: { status: "blocked" },
      idempotencyParts: ["result", "blocked"],
    });

    expect(event.eventId).toBe(same.eventId);
    expect(event.observedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(event.correlationId).toBe(event.eventId);
    expect(event.redaction).toBe(RunEventRedactionStatus.Safe);
    expect(event.payload).toMatchObject({
      nested: {
        apiToken: "<redacted>",
        auth_payload: "<redacted>",
        safe: "visible",
      },
    });
    expect(parseRunEvent(event)).toEqual(event);
  });

  it("tolerates legacy v1 events without observedAt or correlationId", () => {
    const modern = makeRunEvent({
      runId: "run-a",
      type: RunEventType.ProgressUpdated,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      payload: {
        status: "running",
        token: "secret",
      },
      idempotencyParts: ["progress", "running"],
    });
    const legacy: Record<string, unknown> = {
      ...modern,
      payload: {
        status: "running",
        token: "secret",
      },
    };
    delete legacy.observedAt;
    delete legacy.correlationId;

    const parsed = parseRunEvent(legacy);

    expect(parsed).toMatchObject({
      observedAt: modern.occurredAt,
      correlationId: modern.eventId,
      payload: {
        status: "running",
        token: "<redacted>",
      },
    });
  });

  it("maps legacy persisted unknown providers to the explicit Unknown enum", () => {
    const event = makeRunEvent({
      runId: "run-a",
      type: RunEventType.ProgressUpdated,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      payload: { status: "running" },
      idempotencyParts: ["progress", "running"],
    });
    const legacy = {
      ...event,
      source: {
        ...event.source,
        providerKind: "legacy-provider",
      },
    };

    const parsed = parseRunEvent(legacy);

    expect(parsed?.source.providerKind).toBe(RunEventProviderKind.Unknown);
  });

  it("includes source identity in deterministic event ids to avoid multi-host collisions", () => {
    const base = {
      runId: "run-a",
      type: RunEventType.ProgressUpdated,
      occurredAt: "2026-07-02T00:00:00.000Z",
      payload: { status: "running" },
      idempotencyParts: ["progress", "running"],
    } as const;
    const hostA = makeRunEvent({
      ...base,
      source: {
        providerKind: RunEventProviderKind.Codex,
        hostId: "host-a",
      },
    });
    const hostARepeat = makeRunEvent({
      ...base,
      occurredAt: "2026-07-02T00:01:00.000Z",
      source: {
        providerKind: RunEventProviderKind.Codex,
        hostId: "host-a",
      },
    });
    const hostB = makeRunEvent({
      ...base,
      source: {
        providerKind: RunEventProviderKind.Codex,
        hostId: "host-b",
      },
    });

    expect(hostARepeat.eventId).toBe(hostA.eventId);
    expect(hostB.eventId).not.toBe(hostA.eventId);
  });

  it("redacts sensitive payload keys recursively", () => {
    const huge = "x".repeat(4_200);
    expect(sanitizeRunEventPayload({
      token: "a",
      OPENAI_API_KEY: "b",
      values: [{ cookie: "c", normal: "d" }],
      huge,
    })).toEqual({
      token: "<redacted>",
      OPENAI_API_KEY: "<redacted>",
      values: [{ cookie: "<redacted>", normal: "d" }],
      huge: `${"x".repeat(4_096)}<truncated>`,
    });
  });

  it("derives read models for unsafe completed-live states", () => {
    const models = runEventReadModelsFromSnapshot(snapshot({
      status: "completed",
      liveness: "alive",
      process: { alive: true },
      result: { exists: true, status: "done" },
      readOnlyDecision: {
        kind: "unsafe_state_mismatch",
        reason: "completed_result_with_live_process",
        safeMessage: "inspect",
        evidence: ["result.status", "process.liveness"],
      },
    }));

    expect(models.safety).toMatchObject({
      status: RunSafetyStatus.Unsafe,
      safeToContinue: false,
      reviewOnly: true,
      issueKind: RunRuntimeIssueKind.CompletedResultWithLiveProcess,
    });
    expect(models.liveness.status).toBe(RunLivenessStatus.CompletedLive);
    expect(models.outcome.status).toBe(RunOutcomeStatus.Completed);
  });

  it("derives review-only workspace and masks account capacity identities", () => {
    const models = runEventReadModelsFromSnapshot(snapshot({
      status: "stopped",
      liveness: "dead",
      workspace: {
        exists: true,
        dirty: true,
        changedFilesCount: 2,
        changedFiles: ["a.ts", "b.ts"],
      },
      capacity: [
        {
          account: "ilovelog@gmail.com",
          status: "auth_invalid",
          availability: "disabled",
          reason: "relogin_required",
        },
      ],
      readOnlyDecision: {
        kind: "manual_review_required",
        reason: "dirty_workspace_without_running_worker",
        safeMessage: "review",
      },
    }));

    expect(models.workspace).toMatchObject({
      status: RunWorkspaceStatus.Dirty,
      reviewOnly: true,
      changedFilesSample: ["a.ts", "b.ts"],
    });
    expect(models.accountCapacity).toMatchObject({
      status: RunAccountCapacityStatus.Blocked,
      blockedCount: 1,
      maskedAccounts: ["il***og@gm***il.com"],
    });
  });

  it("projects observation snapshots into durable run events", () => {
    const initial = snapshot({
      status: "running",
      liveness: "alive",
      progress: {
        status: "running",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    });
    const previousState = runEventProjectionStateFromSnapshot(initial);

    const result = projectRunObservationEvents({
      snapshot: snapshot({
        status: "failed",
        liveness: "dead",
        result: {
          exists: true,
          status: "failed",
          reason: "app_server_goal_blocked",
          updatedAt: "2026-07-02T00:05:00.000Z",
        },
        readOnlyDecision: {
          kind: "manual_review_required",
          reason: "app_server_goal_blocked",
          safeMessage: "review",
        },
      }),
      previousState,
      sequenceStart: 10,
    });

    expect(result.nextState.providerKind).toBe(RunEventProviderKind.Codex);
    expect(result.nextState.readModels).toMatchObject({
      safety: {
        status: RunSafetyStatus.ReviewRequired,
        safeToContinue: false,
      },
      outcome: {
        status: RunOutcomeStatus.Failed,
      },
    });
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        RunEventType.ResultUpdated,
        RunEventType.DecisionChanged,
        RunEventType.Failed,
      ]),
    );
    expect(result.events.map((event) => event.sequence)).toEqual([10, 11, 12]);
  });

  it("rebuilds read models from durable events when projection state is gone", () => {
    const projected = projectRunObservationEvents({
      snapshot: snapshot({
        status: "completed",
        liveness: "alive",
        result: { exists: true, status: "done" },
        readOnlyDecision: {
          kind: "unsafe_state_mismatch",
          reason: "completed_result_with_live_process",
          safeMessage: "inspect",
        },
      }),
    });

    const replayed = projectRunReadModelsFromEvents(projected.events);

    expect(replayed).toMatchObject({
      runId: "run-a",
      providerKind: RunEventProviderKind.Codex,
      safety: {
        status: RunSafetyStatus.Unsafe,
        safeToContinue: false,
        issueKind: RunRuntimeIssueKind.CompletedResultWithLiveProcess,
      },
      liveness: {
        status: RunLivenessStatus.CompletedLive,
      },
      outcome: {
        status: RunOutcomeStatus.Completed,
      },
    });
  });

  it("rebuilds projection state from durable events when projection state is gone", () => {
    const projected = projectRunObservationEvents({
      snapshot: snapshot({
        status: "running",
        liveness: "alive",
        progress: {
          status: "running",
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
        workspace: {
          key: "/work",
          dirty: true,
          changedFilesCount: 1,
          changedFiles: ["a.ts"],
        },
      }),
    });

    const replayed = runEventProjectionStateFromEvents(projected.events);

    expect(replayed).toMatchObject({
      runId: "run-a",
      providerKind: RunEventProviderKind.Codex,
      status: "running",
      progressStatus: "running",
      workspaceSignature: expect.any(String),
      readModels: {
        workspace: {
          status: RunWorkspaceStatus.Dirty,
        },
      },
    });
  });

  it("emits terminal completed event once per state transition", () => {
    const completed = snapshot({
      status: "completed",
      liveness: "dead",
      result: {
        exists: true,
        status: "done",
        updatedAt: "2026-07-02T00:10:00.000Z",
      },
      readOnlyDecision: {
        kind: "review_completed",
        reason: "terminal_result_completed",
        safeMessage: "review",
      },
    });
    const initial = projectRunObservationEvents({ snapshot: completed });
    const repeated = projectRunObservationEvents({
      snapshot: completed,
      previousState: initial.nextState,
    });

    expect(initial.events.some((event) => event.type === RunEventType.Completed))
      .toBe(true);
    expect(repeated.events.some((event) => event.type === RunEventType.Completed))
      .toBe(false);
  });

  it("projects through the service and persists state between polls", async () => {
    const states = new MemoryProjectionStateStore();
    const events = new MemoryRunEventStore();
    const observationPort: RunObservationPort = {
      async observeRun(input) {
        return snapshot({
          runId: input.runId,
          status: "running",
          liveness: "alive",
        });
      },
    };
    const service = new RunEventProjectionService({
      observationPort,
      eventStore: events,
      stateStore: states,
      hostId: "host-a",
      clock: { now: () => new Date("2026-07-02T00:01:00.000Z") },
    });

    const first = await service.projectRun({ runId: "run-a" });
    const second = await service.projectRun({ runId: "run-a" });

    expect(first.events.length).toBeGreaterThan(0);
    expect(first.appendResult.appendedCount).toBe(first.events.length);
    expect(second.events).toHaveLength(0);
    expect(events.events.every((event) => event.source.hostId === "host-a")).toBe(true);
    await expect(states.readProjectionState("run-a")).resolves.toMatchObject({
      runId: "run-a",
      providerKind: RunEventProviderKind.Codex,
    });
  });

  it("recovers when projection state write fails after events were appended", async () => {
    const states = new FailingOnceProjectionStateStore();
    const events = new MemoryRunEventStore();
    const observationPort: RunObservationPort = {
      async observeRun(input) {
        return snapshot({
          runId: input.runId,
          status: "running",
          liveness: "alive",
        });
      },
    };
    const service = new RunEventProjectionService({
      observationPort,
      eventStore: events,
      stateStore: states,
      clock: { now: () => new Date("2026-07-02T00:01:00.000Z") },
    });

    await expect(service.projectRun({ runId: "run-a" }))
      .rejects.toThrow("state_write_failed_once");
    expect(events.events.length).toBeGreaterThan(0);

    const recovered = await service.projectRun({ runId: "run-a" });

    expect(recovered.events).toHaveLength(0);
    expect(recovered.appendResult.appendedCount).toBe(0);
    expect(recovered.appendResult.skippedDuplicateCount).toBe(0);
    await expect(states.readProjectionState("run-a")).resolves.toMatchObject({
      runId: "run-a",
    });
  });

  it("recovers projection state from events when runtime changes after state write failure", async () => {
    const states = new FailingOnceProjectionStateStore();
    const events = new MemoryRunEventStore();
    let currentSnapshot = snapshot({
      status: "running",
      liveness: "alive",
      progress: {
        status: "running",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    });
    const observationPort: RunObservationPort = {
      async observeRun(input) {
        return {
          ...currentSnapshot,
          runId: input.runId,
        };
      },
    };
    const service = new RunEventProjectionService({
      observationPort,
      eventStore: events,
      stateStore: states,
      clock: { now: () => new Date("2026-07-02T00:01:00.000Z") },
    });

    await expect(service.projectRun({ runId: "run-a" }))
      .rejects.toThrow("state_write_failed_once");

    currentSnapshot = snapshot({
      status: "completed",
      liveness: "dead",
      result: {
        exists: true,
        status: "done",
        updatedAt: "2026-07-02T00:02:00.000Z",
      },
      readOnlyDecision: {
        kind: "review_completed",
        reason: "terminal_result_completed",
        safeMessage: "review",
      },
    });
    const recovered = await service.projectRun({ runId: "run-a" });

    expect(recovered.events.map((event) => event.type)).not.toContain(
      RunEventType.ObservationRecorded,
    );
    expect(recovered.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        RunEventType.ResultUpdated,
        RunEventType.DecisionChanged,
        RunEventType.Completed,
      ]),
    );
    expect(recovered.appendResult.appendedCount).toBe(recovered.events.length);
    await expect(states.readProjectionState("run-a")).resolves.toMatchObject({
      runId: "run-a",
      status: "completed",
      resultStatus: "done",
    });
  });

  it("relays events and advances cursor only after publish succeeds", async () => {
    const events = new MemoryRunEventStore();
    const cursorStore = new MemoryDeliveryCursorStore();
    const first = makeRunEvent({
      runId: "run-a",
      type: RunEventType.ProgressUpdated,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      idempotencyParts: ["first"],
    });
    const second = makeRunEvent({
      runId: "run-a",
      type: RunEventType.Completed,
      occurredAt: "2026-07-02T00:01:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex },
      idempotencyParts: ["second"],
    });
    await events.append([first, second]);
    const published: RunEvent[] = [];
    const service = new RunEventRelayService({
      eventStore: events,
      cursorStore,
      publisher: {
        async publish(items) {
          published.push(...items);
        },
      },
    });

    await expect(service.relay({ consumerId: "consumer-a", limit: 1 }))
      .resolves.toMatchObject({
        readCount: 1,
        publishedCount: 1,
        nextCursor: { value: "1" },
      });
    expect(published.map((event) => event.eventId)).toEqual([first.eventId]);
    await expect(cursorStore.readDeliveryCursor("consumer-a")).resolves.toEqual({
      value: "1",
    });

    await expect(service.relay({ consumerId: "consumer-a" }))
      .resolves.toMatchObject({
        readCount: 1,
        nextCursor: { value: "2" },
      });
    expect(published.map((event) => event.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
  });

  it("does not advance relay cursor when publisher fails", async () => {
    const events = new MemoryRunEventStore();
    const cursorStore = new MemoryDeliveryCursorStore();
    await events.append([
      makeRunEvent({
        runId: "run-a",
        type: RunEventType.ProgressUpdated,
        occurredAt: "2026-07-02T00:00:00.000Z",
        source: { providerKind: RunEventProviderKind.Codex },
        idempotencyParts: ["first"],
      }),
    ]);
    const service = new RunEventRelayService({
      eventStore: events,
      cursorStore,
      publisher: {
        async publish() {
          throw new Error("publisher_down");
        },
      },
    });

    await expect(service.relay({ consumerId: "consumer-a" }))
      .rejects.toThrow("publisher_down");
    await expect(cursorStore.readDeliveryCursor("consumer-a")).resolves.toBeNull();
  });
});

class MemoryProjectionStateStore implements RunEventProjectionStateStorePort {
  private readonly states = new Map<string, RunEventProjectionState>();

  async readProjectionState(runId: string): Promise<RunEventProjectionState | null> {
    return this.states.get(runId) ?? null;
  }

  async writeProjectionState(state: RunEventProjectionState): Promise<void> {
    this.states.set(state.runId, state);
  }
}

class FailingOnceProjectionStateStore extends MemoryProjectionStateStore {
  private failNextWrite = true;

  override async writeProjectionState(state: RunEventProjectionState): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("state_write_failed_once");
    }
    await super.writeProjectionState(state);
  }
}

class MemoryRunEventStore implements RunEventStorePort {
  readonly events: RunEvent[] = [];

  async append(events: readonly RunEvent[]) {
    let appendedCount = 0;
    let skippedDuplicateCount = 0;
    const existing = new Set(this.events.map((event) => event.eventId));
    for (const event of events) {
      if (existing.has(event.eventId)) {
        skippedDuplicateCount += 1;
        continue;
      }
      existing.add(event.eventId);
      this.events.push(event);
      appendedCount += 1;
    }
    return {
      appendedCount,
      skippedDuplicateCount,
    };
  }

  async read(input: RunEventReadRequest = {}) {
    return this.readWithInput(input);
  }

  async readWithInput(input: RunEventReadRequest) {
    const start = Number.parseInt(input.cursor?.value ?? "0", 10);
    const typeFilter = input.types === undefined ? null : new Set(input.types);
    const selected: RunEvent[] = [];
    let nextIndex = Number.isFinite(start) ? start : 0;
    for (let index = nextIndex; index < this.events.length; index += 1) {
      nextIndex = index + 1;
      const event = this.events[index];
      if (event === undefined) continue;
      if (input.runId !== undefined && event.runId !== input.runId) continue;
      if (typeFilter && !typeFilter.has(event.type)) continue;
      selected.push(event);
      if (input.limit !== undefined && selected.length >= input.limit) break;
    }
    return {
      events: selected,
      nextCursor: { value: String(nextIndex) },
      warnings: [],
    };
  }
}

class MemoryDeliveryCursorStore implements RunEventDeliveryCursorStorePort {
  private readonly cursors = new Map<string, RunEventCursor>();

  async readDeliveryCursor(consumerId: string): Promise<RunEventCursor | null> {
    return this.cursors.get(consumerId) ?? null;
  }

  async writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    this.cursors.set(input.consumerId, input.cursor);
  }
}

function snapshot(
  input: Partial<RunObservationSnapshot>,
): RunObservationSnapshot {
  return {
    runId: "run-a",
    providerKind: RunEventProviderKind.Codex,
    observedAt: "2026-07-02T00:00:00.000Z",
    status: "running",
    liveness: "alive",
    workspace: {
      key: "/work",
      dirty: false,
      changedFilesCount: 0,
      changedFiles: [],
    },
    process: { alive: true },
    progress: {
      status: "running",
      updatedAt: "2026-07-02T00:00:00.000Z",
      stale: false,
    },
    result: { exists: false },
    logs: {
      exists: true,
      byteLength: 0,
    },
    warnings: [],
    readOnlyDecision: {
      kind: "keep_watching",
      reason: "worker_observable",
      safeMessage: "watch",
    },
    ...input,
  };
}
