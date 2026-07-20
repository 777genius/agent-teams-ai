import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkerControlService,
  type WorkerControlDeliveryReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "../index";

describe("LocalFileWorkerControlInboxStore", () => {
  it("persists control signals and receipts across store instances", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-"));
    const broadTarget = { jobId: "job-a" };
    const runtimeTarget = {
      jobId: "job-a",
      taskId: "task-a",
      workspaceId: "/tmp/workspace-a",
    };

    try {
      const first = new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({ rootDir }),
        idFactory: sequentialIds("first"),
      });
      const signal = await first.enqueueSignal({
        target: broadTarget,
        intent: "guidance",
        body: "Keep the benchmark changes architecture-neutral.",
        idempotencyKey: "architecture-guidance",
      });

      const restarted = new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({ rootDir }),
        idFactory: sequentialIds("second"),
      });
      const batch = await restarted.consumeForContinuation({
        target: runtimeTarget,
        deliveryAttemptId: "attempt-2",
      });

      expect(batch.signalIds).toEqual([signal.signalId]);
      expect(batch.message).toContain("architecture-neutral");

      const views = await restarted.listSignals({
        target: runtimeTarget,
        includeExpired: true,
      });
      expect(views[0]?.state).toBe("delivered");
      expect(views[0]?.latestReceipt?.deliveryAttemptId).toBe("attempt-2");

      const laterBatch = await restarted.consumeForContinuation({
        target: {
          jobId: "job-a",
          taskId: "task-b",
          workspaceId: "/tmp/workspace-a",
        },
        deliveryAttemptId: "attempt-3",
      });
      expect(laterBatch.signalIds).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists deferred multi-signal confirmation as one delivery batch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-batch-"));
    const target = { jobId: "job-deferred-batch" };
    try {
      const service = new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({ rootDir }),
        idFactory: sequentialIds("deferred-batch"),
      });
      await service.enqueueSignal({
        target,
        intent: "guidance",
        body: "First item.",
      });
      await service.enqueueSignal({
        target,
        intent: "policy_update",
        body: "Second item.",
      });
      const batch = await service.consumeForContinuation({
        target,
        deliveryAttemptId: "attempt-deferred-batch",
        deferDeliveryConfirmation: true,
      });

      expect(
        (await service.listSignals({ target })).map((view) => view.state),
      ).toEqual(["accepted", "accepted"]);
      await service.confirmContinuationDelivery({ batch });

      const restarted = new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({ rootDir }),
      });
      expect(
        (await restarted.listSignals({ target })).map((view) => view.state),
      ).toEqual(["delivered", "delivered"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("claims broad job-level delivery atomically across concurrent consumers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-"));
    const service = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      idFactory: sequentialIds("claim"),
    });

    try {
      const signal = await service.enqueueSignal({
        target: { jobId: "job-claim" },
        intent: "guidance",
        body: "Apply exactly once.",
      });

      const [first, second] = await Promise.all([
        service.consumeForContinuation({
          target: { jobId: "job-claim", taskId: "task-a" },
          deliveryAttemptId: "attempt-a",
        }),
        service.consumeForContinuation({
          target: { jobId: "job-claim", taskId: "task-b" },
          deliveryAttemptId: "attempt-b",
        }),
      ]);

      const deliveredIds = [...first.signalIds, ...second.signalIds];
      expect(deliveredIds).toEqual([signal.signalId]);
      expect([first.signalIds.length, second.signalIds.length].sort()).toEqual([
        0,
        1,
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves exact-once delivery invariants across concurrent mixed signals", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-"));
    const service = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir }),
      clock: { now: () => new Date("2026-06-30T12:00:00.000Z") },
      idFactory: sequentialIds("matrix"),
    });
    const target = { jobId: "job-matrix" };
    const expectedDelivered = new Set<string>();

    try {
      for (let index = 0; index < 12; index += 1) {
        const signal = await service.enqueueSignal({
          target,
          intent: "guidance",
          body: `Matrix guidance ${index}`,
          priority: index % 3 === 0 ? "high" : "normal",
          ...(index % 4 === 0
            ? { expiresAt: new Date("2026-06-30T11:00:00.000Z") }
            : {}),
        });
        if (index % 4 !== 0) expectedDelivered.add(signal.signalId);
      }

      await service.enqueueSignal({
        target,
        intent: "operator_note",
        deliveryMode: "record_only",
        body: "Record-only audit marker.",
      });
      const superseded = await service.enqueueSignal({
        target,
        intent: "guidance",
        body: "Superseded matrix guidance.",
      });
      const replacement = await service.enqueueSignal({
        target,
        intent: "guidance",
        body: "Replacement matrix guidance.",
        supersedesSignalIds: [superseded.signalId],
      });
      expectedDelivered.add(replacement.signalId);

      const batches = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          service.consumeForContinuation({
            target: { jobId: "job-matrix", taskId: `task-${index}` },
            deliveryAttemptId: `attempt-${index}`,
          })
        ),
      );

      const delivered = batches.flatMap((batch) => batch.signalIds);
      expect(new Set(delivered)).toEqual(expectedDelivered);
      expect(delivered).toHaveLength(expectedDelivered.size);

      const second = await service.consumeForContinuation({
        target,
        deliveryAttemptId: "attempt-after-matrix",
      });
      expect(second.signalIds).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("repairs stale accepted delivery claims back to pending delivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-"));
    const store = new LocalFileWorkerControlInboxStore({ rootDir });
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-06-30T12:10:00.000Z") },
      idFactory: sequentialIds("repair"),
    });
    const target = { jobId: "job-repair" };

    try {
      const signal = await service.enqueueSignal({
        target,
        intent: "guidance",
        body: "Recover this delivery after crash.",
      });
      await store.tryClaimDelivery?.(receipt({
        signalId: signal.signalId,
        target,
        deliveryAttemptId: "attempt-crashed",
        createdAt: new Date("2026-06-30T12:00:00.000Z"),
      }));

      await expect(service.reconcile({ target })).resolves.toMatchObject({
        acceptedCount: 1,
        pendingCount: 0,
        repairedCount: 0,
      });

      const repaired = await service.reconcile({
        target,
        repair: true,
        acceptedStaleAfterMs: 60_000,
      });
      expect(repaired).toMatchObject({
        acceptedCount: 0,
        pendingCount: 1,
        repairedCount: 1,
        repairedSignalIds: [signal.signalId],
      });

      const batch = await service.consumeForContinuation({
        target,
        deliveryAttemptId: "attempt-recovered",
      });
      expect(batch.signalIds).toEqual([signal.signalId]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps fresh accepted delivery claims unrepaired", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "worker-control-inbox-"));
    const store = new LocalFileWorkerControlInboxStore({ rootDir });
    const service = new WorkerControlService({
      store,
      clock: { now: () => new Date("2026-06-30T12:00:10.000Z") },
      idFactory: sequentialIds("fresh"),
    });
    const target = { jobId: "job-fresh" };

    try {
      const signal = await service.enqueueSignal({
        target,
        intent: "guidance",
        body: "Do not release a fresh claim.",
      });
      await store.tryClaimDelivery?.(receipt({
        signalId: signal.signalId,
        target,
        deliveryAttemptId: "attempt-running",
        createdAt: new Date("2026-06-30T12:00:00.000Z"),
      }));

      const report = await service.reconcile({
        target,
        repair: true,
        acceptedStaleAfterMs: 60_000,
      });

      expect(report).toMatchObject({
        acceptedCount: 1,
        pendingCount: 0,
        repairedCount: 0,
      });
      const batch = await service.consumeForContinuation({
        target,
        deliveryAttemptId: "attempt-not-yet",
      });
      expect(batch.signalIds).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function receipt(input: {
  readonly signalId: string;
  readonly target: { readonly jobId: string };
  readonly deliveryAttemptId: string;
  readonly createdAt: Date;
}): WorkerControlDeliveryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `${input.deliveryAttemptId}-receipt`,
    signalId: input.signalId,
    target: input.target,
    state: "accepted",
    createdAt: input.createdAt,
    deliveryAttemptId: input.deliveryAttemptId,
    metadata: {},
  };
}
