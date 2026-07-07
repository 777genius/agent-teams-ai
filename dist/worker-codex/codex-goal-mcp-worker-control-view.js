import { accountNames, stringValue, } from "./codex-goal-mcp-values.js";
export function signalIdList(value) {
    return accountNames(value);
}
export function workerControlCallerArgs(args) {
    const callerKind = (stringValue(args.callerKind) ?? stringValue(args.callerActor));
    const callerId = stringValue(args.callerId);
    if (!callerKind && !callerId)
        return {};
    const createdBy = stringValue(args.createdBy);
    return {
        caller: {
            kind: callerKind ?? createdBy ?? "operator",
            ...(callerId ? { id: callerId } : {}),
        },
    };
}
export function parseIsoDate(value, name) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${name} must be an ISO date string`);
    }
    return date;
}
export function workerControlDecisionJson(decision, includeBodies) {
    return {
        target: decision.target,
        safeToContinue: decision.safeToContinue,
        pendingCount: decision.pendingSignals.length,
        deliverableCount: decision.deliverableSignals.length,
        blockedCount: decision.blockedSignals.length,
        recordOnlyCount: decision.recordOnlySignals.length,
        warnings: decision.warnings,
        pendingSignals: decision.pendingSignals.map((view) => workerControlSignalViewJson(view, includeBodies)),
        deliverableSignalIds: decision.deliverableSignals.map((view) => view.signal.signalId),
        blockedSignals: decision.blockedSignals.map((view) => workerControlSignalViewJson(view, includeBodies)),
    };
}
export function workerControlSignalViewJson(view, includeBody) {
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
export function workerControlSignalJson(signal, includeBody) {
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
export function workerControlReceiptJson(receipt) {
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
export function jobIdsFromValue(value) {
    return accountNames(value);
}
//# sourceMappingURL=codex-goal-mcp-worker-control-view.js.map