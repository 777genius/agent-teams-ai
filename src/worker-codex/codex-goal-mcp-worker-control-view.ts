import {
  type WorkerControlActor,
  type WorkerControlCaller,
  type WorkerControlDecision,
  type WorkerControlDeliveryReceipt,
  type WorkerControlSignal,
  type WorkerControlSignalView,
} from "@vioxen/subscription-runtime/worker-core";
import type { WorkerControlMcpArgs } from "./codex-goal-mcp-inputs";
import {
  accountNames,
  stringValue,
} from "./codex-goal-mcp-values";

type JsonObject = Readonly<Record<string, unknown>>;

export function signalIdList(value: unknown): readonly string[] {
  return accountNames(value);
}

export function workerControlCallerArgs(
  args: WorkerControlMcpArgs,
): { readonly caller?: WorkerControlCaller } {
  const callerKind = (
    stringValue(args.callerKind) ?? stringValue(args.callerActor)
  ) as WorkerControlActor | undefined;
  const callerId = stringValue(args.callerId);
  if (!callerKind && !callerId) return {};
  const createdBy = stringValue(args.createdBy) as WorkerControlActor | undefined;
  return {
    caller: {
      kind: callerKind ?? createdBy ?? "operator",
      ...(callerId ? { id: callerId } : {}),
    },
  };
}

export function parseIsoDate(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be an ISO date string`);
  }
  return date;
}

export function workerControlDecisionJson(
  decision: WorkerControlDecision,
  includeBodies: boolean,
): JsonObject {
  return {
    target: decision.target,
    safeToContinue: decision.safeToContinue,
    pendingCount: decision.pendingSignals.length,
    deliverableCount: decision.deliverableSignals.length,
    blockedCount: decision.blockedSignals.length,
    recordOnlyCount: decision.recordOnlySignals.length,
    warnings: decision.warnings,
    pendingSignals: decision.pendingSignals.map((view) =>
      workerControlSignalViewJson(view, includeBodies)
    ),
    deliverableSignalIds: decision.deliverableSignals.map((view) =>
      view.signal.signalId
    ),
    blockedSignals: decision.blockedSignals.map((view) =>
      workerControlSignalViewJson(view, includeBodies)
    ),
  };
}

export function workerControlSignalViewJson(
  view: WorkerControlSignalView,
  includeBody: boolean,
): JsonObject {
  return {
    signal: workerControlSignalJson(view.signal, includeBody),
    state: view.state,
    expired: view.expired,
    deliverable: view.deliverable,
    ...(view.blockedReason ? { blockedReason: view.blockedReason } : {}),
    ...(view.latestReceipt
      ? { latestReceipt: workerControlReceiptJson(view.latestReceipt) }
      : {}),
  };
}

export function workerControlSignalJson(
  signal: WorkerControlSignal,
  includeBody: boolean,
): JsonObject {
  return {
    signalId: signal.signalId,
    idempotencyKey: signal.idempotencyKey,
    target: signal.target,
    intent: signal.intent,
    deliveryMode: signal.deliveryMode,
    createdAt: signal.createdAt.toISOString(),
    createdBy: signal.createdBy,
    priority: signal.priority,
    ...(signal.expiresAt ? { expiresAt: signal.expiresAt.toISOString() } : {}),
    supersedesSignalIds: signal.supersedesSignalIds,
    metadata: signal.metadata,
    ...(includeBody ? { body: signal.body } : {}),
  };
}

export function workerControlReceiptJson(
  receipt: WorkerControlDeliveryReceipt,
): JsonObject {
  return {
    receiptId: receipt.receiptId,
    signalId: receipt.signalId,
    target: receipt.target,
    state: receipt.state,
    createdAt: receipt.createdAt.toISOString(),
    ...(receipt.deliveryAttemptId
      ? { deliveryAttemptId: receipt.deliveryAttemptId }
      : {}),
    ...(receipt.deliveredAt
      ? { deliveredAt: receipt.deliveredAt.toISOString() }
      : {}),
    ...(receipt.appliedAt ? { appliedAt: receipt.appliedAt.toISOString() } : {}),
    ...(receipt.rejectedReason ? { rejectedReason: receipt.rejectedReason } : {}),
    ...(receipt.failure ? { failure: receipt.failure } : {}),
    metadata: receipt.metadata,
  };
}

export function jobIdsFromValue(value: unknown): readonly string[] {
  return accountNames(value);
}
