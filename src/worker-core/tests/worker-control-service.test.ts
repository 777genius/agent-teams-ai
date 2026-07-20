import { describe, expect, it } from "vitest";
import {
  InMemoryActiveAttemptRegistry,
  InterruptAndContinueWorkerUseCase,
  WorkerControlService,
  workerControlTargetMatches,
  type WorkerControlAuthorizationInput,
  type WorkerControlCapability,
  type WorkerControlDeliveryReceipt,
  type WorkerControlInboxStore,
  type WorkerControlSignal,
  type WorkerControlTarget,
} from "../index";

describe("WorkerControlService", () => {
  it("dedupes signals and consumes next-safe-point guidance once", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-06-30T00:00:00.000Z") },
      idFactory: sequentialIds("id"),
    });
    const target = {
      jobId: "job-a",
      taskId: "task-a",
      workspaceId: "/tmp/work",
    };

    const first = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Focus on category 3 reasoning before broad benchmark.",
      idempotencyKey: "guidance-1",
    });
    const duplicate = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Focus on category 3 reasoning before broad benchmark.",
      idempotencyKey: "guidance-1",
    });

    expect(duplicate.signalId).toBe(first.signalId);

    const decision = await service.getDecision({ target });
    expect(decision.safeToContinue).toBe(true);
    expect(decision.deliverableSignals).toHaveLength(1);

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-2",
    });

    expect(batch.signalIds).toEqual([first.signalId]);
    expect(batch.message).toContain("Runtime control inbox instructions");
    expect(batch.message).toContain("category 3 reasoning");

    const after = await service.listSignals({ target, includeExpired: true });
    expect(after[0]?.state).toBe("delivered");
    expect(after[0]?.latestReceipt?.deliveryAttemptId).toBe("attempt-2");

    const secondBatch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-3",
    });
    expect(secondBatch.signalIds).toEqual([]);
  });

  it("confirms deferred continuation delivery only after the provider starts", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
      idFactory: sequentialIds("deferred"),
    });
    const target = {
      jobId: "job-deferred",
      taskId: "task-deferred",
      workspaceId: "/tmp/deferred-work",
    };
    const signal = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Continue the same immutable review.",
    });

    const first = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-pre-task-failure",
      deferDeliveryConfirmation: true,
    });
    expect((await service.listSignals({ target }))[0]?.state).toBe("accepted");

    await service.releaseContinuationDelivery({ batch: first });
    expect((await service.listSignals({ target }))[0]?.state).toBe("pending");

    const second = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-provider-started",
      deferDeliveryConfirmation: true,
    });
    expect(second.signalIds).toEqual([signal.signalId]);
    await service.confirmContinuationDelivery({ batch: second });
    await service.confirmContinuationDelivery({ batch: second });
    expect((await service.listSignals({ target }))[0]?.state).toBe("delivered");
    expect(
      (await store.listReceipts({ target, signalIds: [signal.signalId] }))
        .filter((receipt) => receipt.state === "delivered"),
    ).toHaveLength(1);
  });

  it("does not partially confirm a deferred multi-signal batch", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("atomic-confirm"),
    });
    const target = { jobId: "job-atomic-confirm" };
    await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "First guidance item.",
    });
    await service.enqueueSignal({
      target,
      intent: "policy_update",
      body: "Second guidance item.",
    });
    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-atomic-confirm",
      deferDeliveryConfirmation: true,
    });
    store.failBatchAppend = true;

    await expect(
      service.confirmContinuationDelivery({ batch }),
    ).rejects.toThrow("worker_control_test_batch_append_failed");
    expect(
      (await service.listSignals({ target })).map((view) => view.state),
    ).toEqual(["accepted", "accepted"]);

    store.failBatchAppend = false;
    await service.releaseContinuationDelivery({ batch });
    expect(
      (await service.listSignals({ target })).map((view) => view.state),
    ).toEqual(["pending", "pending"]);
  });

  it("does not report delivered signals as blocked during reconciliation", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-06-30T00:00:00.000Z") },
      idFactory: sequentialIds("reconcile-delivered"),
    });
    const target = {
      jobId: "job-reconcile",
      taskId: "task-reconcile",
      workspaceId: "/tmp/reconcile-work",
    };

    await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Already delivered guidance.",
    });
    await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-delivered",
    });

    const report = await service.reconcile({ target });

    expect(report.deliveredCount).toBe(1);
    expect(report.blockedCount).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("keeps record-only notes out of continuation batches", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("note"),
    });
    const target = { jobId: "job-note" };

    await service.enqueueSignal({
      target,
      intent: "operator_note",
      deliveryMode: "record_only",
      body: "Human reviewed the result.",
    });

    const decision = await service.getDecision({ target });
    expect(decision.recordOnlySignals).toHaveLength(1);
    expect(decision.deliverableSignals).toHaveLength(0);

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-note",
    });
    expect(batch.signalIds).toEqual([]);
    expect(batch.message).toBeUndefined();
  });

  it("blocks unsupported live and idle delivery modes instead of injecting them", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("blocked"),
    });
    const target = { jobId: "job-blocked" };

    await service.enqueueSignal({
      target,
      intent: "guidance",
      deliveryMode: "live_if_supported",
      body: "This must wait for a live-capable adapter.",
    });
    await service.enqueueSignal({
      target,
      intent: "guidance",
      deliveryMode: "idle_turn_if_supported",
      body: "This must wait for an idle-turn-capable adapter.",
    });

    const decision = await service.getDecision({ target });
    expect(decision.safeToContinue).toBe(false);
    expect(decision.blockedSignals).toHaveLength(2);
    expect(decision.deliverableSignals).toHaveLength(0);

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-blocked",
    });
    expect(batch.signalIds).toEqual([]);
  });

  it("requires explicit support before delivering pause-then-continue signals", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("pause"),
    });
    const target = { jobId: "job-pause" };
    const signal = await service.enqueueSignal({
      target,
      intent: "pause_requested",
      deliveryMode: "pause_then_continue",
      body: "Pause safely, then continue with this guidance.",
    });

    const defaultDecision = await service.getDecision({ target });
    expect(defaultDecision.safeToContinue).toBe(false);
    expect(defaultDecision.blockedSignals[0]?.blockedReason).toBe(
      "pause_then_continue_not_supported",
    );

    const blockedBatch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-pause-blocked",
    });
    expect(blockedBatch.signalIds).toEqual([]);

    const supportedCapabilities: WorkerControlCapability = {
      supportsRecordOnly: true,
      supportsNextSafePoint: true,
      supportsPauseThenContinue: true,
      supportsInterruptThenContinue: false,
      supportsIdleTurnInput: false,
      supportsLiveInput: false,
      canDetectActiveTurn: true,
      canAcknowledgeDelivery: false,
    };
    const supportedBatch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-pause-supported",
      capabilities: supportedCapabilities,
    });

    expect(supportedBatch.signalIds).toEqual([signal.signalId]);
    expect(supportedBatch.message).toContain("pause_then_continue");
  });

  it("delivers interrupt-then-continue guidance at the next safe point when no interrupt is available", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("interrupt-fallback"),
    });
    const target = { jobId: "job-interrupt-fallback" };
    const signal = await service.enqueueSignal({
      target,
      intent: "guidance",
      deliveryMode: "interrupt_then_continue",
      body: "Urgent guidance for the next safe continuation.",
    });

    const decision = await service.getDecision({ target });
    expect(decision.safeToContinue).toBe(true);
    expect(decision.deliverableSignals[0]?.signal.signalId).toBe(signal.signalId);

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-interrupt-fallback",
    });
    expect(batch.signalIds).toEqual([signal.signalId]);
    expect(batch.message).toContain("interrupt_then_continue");
    expect(batch.message).toContain("Urgent guidance");
  });

  it("interrupts a registered active attempt through the use case", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("interrupt"),
    });
    const registry = new InMemoryActiveAttemptRegistry();
    const target = {
      jobId: "job-interrupt",
      taskId: "task-interrupt",
      workspaceId: "/tmp/interrupt-workspace",
    };
    const abortController = new AbortController();
    const lease = registry.register({
      taskId: "task-interrupt",
      attemptNumber: 1,
      provider: "codex",
      workspacePath: "/tmp/interrupt-workspace",
      target: {
        ...target,
        attemptId: "task-interrupt:attempt-1",
      },
      startedAt: new Date("2026-06-30T00:00:00.000Z"),
      abortController,
    });
    const useCase = new InterruptAndContinueWorkerUseCase({
      control: service,
      activeAttemptRegistry: registry,
    });

    const result = await useCase.execute({
      target,
      message: "Stop the broad run and continue from current WIP.",
      caller: { kind: "orchestrator", id: "lead-agent" },
    });

    expect(result.status).toBe("interrupted");
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toMatchObject({
      code: "runtime_controlled_interrupt",
      signalId: result.signal.signalId,
      requestedBy: "lead-agent",
    });

    lease.release();

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "task-interrupt:attempt-2",
    });
    expect(batch.signalIds).toEqual([result.signal.signalId]);
    expect(batch.message).toContain("Stop the broad run");
  });

  it("keeps interrupted control signals deliverable for the safe continuation", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("interrupted"),
    });
    const target = { jobId: "job-interrupted" };
    const signal = await service.enqueueSignal({
      target,
      intent: "guidance",
      deliveryMode: "interrupt_then_continue",
      body: "Continue after the controlled interrupt.",
    });
    await store.appendReceipt({
      schemaVersion: 1,
      receiptId: "receipt-interrupted",
      signalId: signal.signalId,
      target,
      state: "interrupted",
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      metadata: {},
    });

    const decision = await service.getDecision({ target });
    expect(decision.safeToContinue).toBe(true);
    expect(decision.deliverableSignals[0]?.signal.signalId).toBe(signal.signalId);

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-after-interrupt",
    });
    expect(batch.signalIds).toEqual([signal.signalId]);
    expect(batch.message).toContain("Continue after the controlled interrupt.");
  });

  it("expires stale signals and keeps superseded signals out of continuation", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-06-30T12:00:00.000Z") },
      idFactory: sequentialIds("signal"),
    });
    const target = { jobId: "job-state" };

    const expired = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Old guidance",
      expiresAt: new Date("2026-06-30T11:00:00.000Z"),
    });
    const superseded = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Superseded guidance",
    });
    const replacement = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Replacement guidance",
      supersedesSignalIds: [superseded.signalId],
    });

    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-state",
      now: new Date("2026-06-30T12:00:00.000Z"),
    });

    expect(batch.signalIds).toEqual([replacement.signalId]);
    expect(batch.message).toContain("Replacement guidance");
    expect(batch.message?.includes("Superseded guidance")).toBe(false);
    expect(batch.message?.includes("Old guidance")).toBe(false);

    const views = await service.listSignals({
      target,
      includeExpired: true,
      now: new Date("2026-06-30T12:00:00.000Z"),
    });
    const states = Object.fromEntries(
      views.map((view) => [view.signal.signalId, view.state]),
    );
    expect(states).toEqual({
      [expired.signalId]: "expired",
      [superseded.signalId]: "superseded",
      [replacement.signalId]: "delivered",
    });
  });

  it("does not supersede delivered guidance and requires a corrective signal", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("delivered"),
    });
    const target = { jobId: "job-delivered" };

    const original = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Old guidance that will be delivered.",
    });
    await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-delivered",
    });

    await expect(
      service.markSuperseded({
        target,
        signalId: original.signalId,
        reason: "operator_changed_mind",
      }),
    ).rejects.toThrow("worker_control_signal_already_delivered_use_corrective_signal");

    await expect(
      service.enqueueSignal({
        target,
        intent: "guidance",
        body: "Corrective guidance after a delivered signal.",
        supersedesSignalIds: [original.signalId],
      }),
    ).rejects.toThrow("worker_control_signal_already_delivered_use_corrective_signal");

    const corrective = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Corrective guidance after a delivered signal.",
    });
    const batch = await service.consumeForContinuation({
      target,
      deliveryAttemptId: "attempt-corrective",
    });

    expect(batch.signalIds).toEqual([corrective.signalId]);
    expect(batch.message).toContain("Corrective guidance");
  });

  it("does not supersede accepted in-flight guidance", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("accepted"),
    });
    const target = { jobId: "job-accepted" };
    const signal = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Claimed but not yet delivered.",
    });
    await store.appendReceipt({
      schemaVersion: 1,
      receiptId: "receipt-accepted",
      signalId: signal.signalId,
      target,
      state: "accepted",
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      deliveryAttemptId: "attempt-in-flight",
      metadata: {},
    });

    await expect(
      service.markSuperseded({
        target,
        signalId: signal.signalId,
      }),
    ).rejects.toThrow("worker_control_signal_delivery_in_progress");
  });

  it("authorizes enqueue and supersede operations through a policy hook", async () => {
    const store = new InMemoryWorkerControlInboxStore();
    const calls: WorkerControlAuthorizationInput[] = [];
    const service = new WorkerControlService({
      store,
      idFactory: sequentialIds("authz"),
      authorizationPolicy: {
        authorizeWorkerControl: (input) => {
          calls.push(input);
          if (input.caller.kind === "orchestrator" && input.intent === "stop_requested") {
            return {
              allowed: false,
              reason: "worker_control_policy_denied_stop",
            };
          }
          return { allowed: true };
        },
      },
    });
    const target = { jobId: "job-authz" };

    await expect(
      service.enqueueSignal({
        target,
        intent: "stop_requested",
        body: "Stop this worker.",
        caller: { kind: "orchestrator", id: "lead-a" },
      }),
    ).rejects.toThrow("worker_control_policy_denied_stop");
    expect(await service.listSignals({ target })).toHaveLength(0);

    const pending = await service.enqueueSignal({
      target,
      intent: "guidance",
      body: "Allowed guidance.",
      caller: { kind: "agent", id: "lead-agent" },
    });
    await service.markSuperseded({
      target,
      signalId: pending.signalId,
      caller: { kind: "agent", id: "lead-agent" },
    });

    expect(calls.map((call) => call.operation)).toEqual([
      "enqueue",
      "enqueue",
      "supersede",
    ]);
    expect(calls[1]).toMatchObject({
      caller: { kind: "agent", id: "lead-agent" },
      target,
      intent: "guidance",
      deliveryMode: "next_safe_point",
    });
  });

  it("treats job-only targets as compatible with more specific runtime targets", () => {
    expect(
      workerControlTargetMatches(
        { jobId: "job-a", taskId: "task-a", workspaceId: "/tmp/work" },
        { jobId: "job-a" },
      ),
    ).toBe(true);
  });
});

class InMemoryWorkerControlInboxStore implements WorkerControlInboxStore {
  private readonly signals: WorkerControlSignal[] = [];
  private readonly receipts: WorkerControlDeliveryReceipt[] = [];
  failBatchAppend = false;

  async appendSignal(signal: WorkerControlSignal): Promise<WorkerControlSignal> {
    this.signals.push(signal);
    return signal;
  }

  async listSignals(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlSignal[]> {
    const signalIds = new Set(input.signalIds ?? []);
    return this.signals
      .filter((signal) =>
        input.target ? workerControlTargetMatches(input.target, signal.target) : true
      )
      .filter((signal) =>
        signalIds.size === 0 || signalIds.has(signal.signalId)
      );
  }

  async appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt> {
    this.receipts.push(receipt);
    return receipt;
  }

  async appendReceipts(
    receipts: readonly WorkerControlDeliveryReceipt[],
  ): Promise<readonly WorkerControlDeliveryReceipt[]> {
    if (this.failBatchAppend) {
      throw new Error("worker_control_test_batch_append_failed");
    }
    this.receipts.push(...receipts);
    return receipts;
  }

  async tryClaimDelivery(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt | null> {
    if (
      this.receipts.some((existing) =>
        existing.signalId === receipt.signalId &&
        existing.state === "accepted"
      )
    ) {
      return null;
    }
    this.receipts.push(receipt);
    return receipt;
  }

  async releaseDeliveryClaim(input: {
    readonly target: WorkerControlTarget;
    readonly signalId: string;
    readonly deliveryAttemptId?: string;
  }): Promise<boolean> {
    const index = this.receipts.findIndex((receipt) =>
      receipt.signalId === input.signalId &&
      receipt.state === "accepted" &&
      (input.deliveryAttemptId === undefined ||
        receipt.deliveryAttemptId === input.deliveryAttemptId) &&
      workerControlTargetMatches(input.target, receipt.target)
    );
    if (index < 0) return false;
    this.receipts.splice(index, 1);
    return true;
  }

  async listReceipts(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlDeliveryReceipt[]> {
    const signalIds = new Set(input.signalIds ?? []);
    return this.receipts
      .filter((receipt) =>
        input.target ? workerControlTargetMatches(input.target, receipt.target) : true
      )
      .filter((receipt) =>
        signalIds.size === 0 || signalIds.has(receipt.signalId)
      );
  }
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
