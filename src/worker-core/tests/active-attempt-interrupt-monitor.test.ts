import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryActiveAttemptRegistry } from "../control/active-attempt-registry";
import { ActiveAttemptInterruptMonitor } from "../control/active-attempt-interrupt-monitor";
import {
  WorkerControlService,
  workerControlTargetMatches,
} from "../control/worker-control-service";
import type {
  WorkerControlDeliveryReceipt,
  WorkerControlInboxStore,
  WorkerControlSignal,
  WorkerControlTarget,
} from "../control/types";

describe("ActiveAttemptInterruptMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts a locally active attempt from a durable cross-process signal", async () => {
    const control = new WorkerControlService({
      store: new InMemoryWorkerControlInboxStore(),
    });
    const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
    const target = {
      jobId: "job-cross-process-guidance",
      taskId: "task-cross-process-guidance",
      workspaceId: "/tmp/cross-process-guidance",
    };
    const abortController = new AbortController();
    const lease = activeAttemptRegistry.register({
      taskId: target.taskId,
      attemptNumber: 1,
      provider: "codex",
      workspacePath: target.workspaceId,
      target: { ...target, attemptId: `${target.taskId}:attempt-1` },
      startedAt: new Date("2026-07-16T00:00:00.000Z"),
      abortController,
    });
    const monitor = new ActiveAttemptInterruptMonitor({
      control,
      activeAttemptRegistry,
      pollIntervalMs: 5,
    });

    try {
      monitor.start(target);
      const signal = await control.enqueueSignal({
        target,
        intent: "guidance",
        deliveryMode: "interrupt_then_continue",
        body: "Finalize the existing reviewed output.",
        createdBy: "orchestrator",
      });

      await waitUntil(() => abortController.signal.aborted);
      expect(abortController.signal.reason).toMatchObject({
        code: "runtime_controlled_interrupt",
        signalId: signal.signalId,
        requestedBy: "orchestrator",
      });
    } finally {
      await monitor.stop();
      lease.release();
    }
  });

  it("waits for the matching attempt to register without losing the signal", async () => {
    const control = new WorkerControlService({
      store: new InMemoryWorkerControlInboxStore(),
    });
    const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
    const target = {
      jobId: "job-late-attempt",
      taskId: "task-late-attempt",
      workspaceId: "/tmp/late-attempt",
    };
    const monitor = new ActiveAttemptInterruptMonitor({
      control,
      activeAttemptRegistry,
      pollIntervalMs: 5,
    });
    let lease:
      ReturnType<InMemoryActiveAttemptRegistry["register"]> | undefined;
    try {
      monitor.start(target);
      await control.enqueueSignal({
        target,
        intent: "guidance",
        deliveryMode: "interrupt_then_continue",
        body: "Apply at the next safe active attempt.",
      });
      await delay(15);

      const abortController = new AbortController();
      lease = activeAttemptRegistry.register({
        taskId: target.taskId,
        attemptNumber: 1,
        provider: "codex",
        workspacePath: target.workspaceId,
        target: { ...target, attemptId: `${target.taskId}:attempt-1` },
        startedAt: new Date("2026-07-16T00:00:00.000Z"),
        abortController,
      });

      await waitUntil(() => abortController.signal.aborted);
    } finally {
      await monitor.stop();
      lease?.release();
    }
  });

  it("wakes a sleeping unref poll synchronously when stopped", async () => {
    vi.useFakeTimers();
    const listSignals = vi.fn(async () => []);
    const monitor = new ActiveAttemptInterruptMonitor({
      control: { listSignals },
      activeAttemptRegistry: new InMemoryActiveAttemptRegistry(),
      pollIntervalMs: 60_000,
    });
    const target = {
      jobId: "job-stop-sleeping-monitor",
      taskId: "task-stop-sleeping-monitor",
      workspaceId: "/tmp/stop-sleeping-monitor",
    };

    monitor.start(target);
    await Promise.resolve();
    await Promise.resolve();
    expect(listSignals).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    let stopped = false;
    const stopPromise = monitor.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await stopPromise;
  });
});

class InMemoryWorkerControlInboxStore implements WorkerControlInboxStore {
  private readonly signals: WorkerControlSignal[] = [];
  private readonly receipts: WorkerControlDeliveryReceipt[] = [];

  async appendSignal(
    signal: WorkerControlSignal,
  ): Promise<WorkerControlSignal> {
    this.signals.push(signal);
    return signal;
  }

  async listSignals(
    input: {
      readonly target?: WorkerControlTarget;
      readonly signalIds?: readonly string[];
    } = {},
  ): Promise<readonly WorkerControlSignal[]> {
    const signalIds = new Set(input.signalIds ?? []);
    return this.signals
      .filter((signal) =>
        input.target
          ? workerControlTargetMatches(input.target, signal.target)
          : true,
      )
      .filter(
        (signal) => signalIds.size === 0 || signalIds.has(signal.signalId),
      );
  }

  async appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt> {
    this.receipts.push(receipt);
    return receipt;
  }

  async listReceipts(
    input: {
      readonly target?: WorkerControlTarget;
      readonly signalIds?: readonly string[];
    } = {},
  ): Promise<readonly WorkerControlDeliveryReceipt[]> {
    const signalIds = new Set(input.signalIds ?? []);
    return this.receipts
      .filter((receipt) =>
        input.target
          ? workerControlTargetMatches(input.target, receipt.target)
          : true,
      )
      .filter(
        (receipt) => signalIds.size === 0 || signalIds.has(receipt.signalId),
      );
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met");
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
