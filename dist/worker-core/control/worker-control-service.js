import { createHash, randomUUID } from "node:crypto";
import { compileWorkerControlSignalsForContinuation } from "./continuation-signal-compiler.js";
const defaultCapabilities = {
    supportsRecordOnly: true,
    supportsNextSafePoint: true,
    supportsPauseThenContinue: false,
    supportsInterruptThenContinue: false,
    supportsIdleTurnInput: false,
    supportsLiveInput: false,
    canDetectActiveTurn: false,
    canAcknowledgeDelivery: false,
};
class PermissiveWorkerControlAuthorizationPolicy {
    authorizeWorkerControl() {
        return { allowed: true };
    }
}
export class WorkerControlService {
    options;
    clock;
    idFactory;
    authorizationPolicy;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? { now: () => new Date() };
        this.idFactory = options.idFactory ?? randomUUID;
        this.authorizationPolicy =
            options.authorizationPolicy ?? new PermissiveWorkerControlAuthorizationPolicy();
    }
    async enqueueSignal(input) {
        const now = input.createdAt ?? this.clock.now();
        const target = normalizeTarget(input.target);
        const body = normalizeBody(input.body);
        const deliveryMode = input.deliveryMode ?? defaultDeliveryMode(input.intent);
        const caller = normalizeCaller(input.caller, input.createdBy);
        await this.authorize({
            caller,
            operation: "enqueue",
            target,
            intent: input.intent,
            deliveryMode,
        });
        const idempotencyKey = input.idempotencyKey?.trim() ||
            stableIdempotencyKey({
                target,
                intent: input.intent,
                deliveryMode,
                body,
            });
        const existing = (await this.options.store.listSignals({ target }))
            .find((signal) => signal.idempotencyKey === idempotencyKey);
        if (existing)
            return existing;
        for (const supersededSignalId of input.supersedesSignalIds ?? []) {
            await this.assertSignalCanBeSuperseded({
                target,
                signalId: supersededSignalId,
                now,
            });
        }
        const signal = {
            schemaVersion: 1,
            signalId: input.signalId?.trim() || this.idFactory(),
            idempotencyKey,
            target,
            intent: input.intent,
            deliveryMode,
            body,
            createdAt: now,
            createdBy: caller.kind,
            priority: input.priority ?? "normal",
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            supersedesSignalIds: [...(input.supersedesSignalIds ?? [])],
            metadata: normalizeMetadata(input.metadata),
        };
        await this.options.store.appendSignal(signal);
        for (const supersededSignalId of signal.supersedesSignalIds) {
            await this.markSuperseded({
                target,
                signalId: supersededSignalId,
                supersededBySignalId: signal.signalId,
                reason: "superseded_by_new_signal",
                now,
                caller,
            });
        }
        return signal;
    }
    async listSignals(query = {}) {
        const now = query.now ?? this.clock.now();
        const signals = await this.options.store.listSignals({
            ...(query.target === undefined ? {} : { target: normalizeTarget(query.target) }),
            ...(query.signalIds === undefined ? {} : { signalIds: query.signalIds }),
        });
        const receipts = await this.options.store.listReceipts({
            ...(query.target === undefined ? {} : { target: normalizeTarget(query.target) }),
            ...(query.signalIds === undefined ? {} : { signalIds: query.signalIds }),
        });
        const states = new Set(query.states ?? []);
        return signals
            .map((signal) => signalView({
            signal: query.includeBodies === false
                ? { ...signal, body: "" }
                : signal,
            receipts,
            capabilities: defaultCapabilities,
            now,
        }))
            .filter((view) => query.includeExpired === true || !view.expired)
            .filter((view) => states.size === 0 || states.has(view.state))
            .sort(compareSignalViews);
    }
    async getDecision(input) {
        const target = normalizeTarget(input.target);
        const capabilities = input.capabilities ?? defaultCapabilities;
        const views = await this.signalViews({
            target,
            capabilities,
            now: input.now ?? this.clock.now(),
        });
        const pendingSignals = views.filter((view) => view.state === "pending");
        const deliverableSignals = views.filter((view) => view.deliverable);
        const blockedSignals = pendingSignals.filter((view) => !view.deliverable && view.signal.deliveryMode !== "record_only");
        const recordOnlySignals = pendingSignals.filter((view) => view.signal.deliveryMode === "record_only");
        const warnings = [
            ...(blockedSignals.length
                ? [`${blockedSignals.length} pending control signal(s) are blocked by delivery capability or policy.`]
                : []),
            ...(recordOnlySignals.length
                ? [`${recordOnlySignals.length} record-only control signal(s) will not be injected into worker continuation.`]
                : []),
        ];
        return {
            target,
            safeToContinue: blockedSignals.length === 0,
            pendingSignals,
            deliverableSignals,
            blockedSignals,
            recordOnlySignals,
            warnings,
        };
    }
    async reconcile(input) {
        const target = normalizeTarget(input.target);
        const capabilities = input.capabilities ?? defaultCapabilities;
        const now = input.now ?? this.clock.now();
        const initialViews = await this.signalViews({
            target,
            capabilities,
            now,
        });
        const repair = input.repair === true
            ? await this.repairAcceptedDeliveryClaims({
                views: initialViews,
                now,
                ...(input.acceptedStaleAfterMs === undefined
                    ? {}
                    : { acceptedStaleAfterMs: input.acceptedStaleAfterMs }),
            })
            : { repairedSignalIds: [], warnings: [] };
        const views = repair.repairedSignalIds.length === 0
            ? initialViews
            : await this.signalViews({ target, capabilities, now });
        return {
            target,
            signalCount: views.length,
            pendingCount: views.filter((view) => view.state === "pending").length,
            acceptedCount: views.filter((view) => view.state === "accepted").length,
            deliverableCount: views.filter((view) => view.deliverable).length,
            blockedCount: views.filter((view) => view.blockedReason).length,
            expiredCount: views.filter((view) => view.state === "expired").length,
            supersededCount: views.filter((view) => view.state === "superseded").length,
            deliveredCount: views.filter((view) => view.state === "delivered").length,
            acknowledgedCount: views.filter((view) => view.state === "acknowledged").length,
            failedCount: views.filter((view) => view.state === "failed").length,
            repairedCount: repair.repairedSignalIds.length,
            repairedSignalIds: repair.repairedSignalIds,
            warnings: [
                ...(views.some((view) => view.blockedReason)
                    ? ["One or more control signals cannot be delivered with current capabilities."]
                    : []),
                ...repair.warnings,
            ],
        };
    }
    async markSuperseded(input) {
        const target = normalizeTarget(input.target);
        const signal = await this.findSignalOrThrow(target, input.signalId);
        await this.assertSignalCanBeSuperseded({
            target,
            signalId: signal.signalId,
            now: input.now ?? this.clock.now(),
            signal,
        });
        await this.authorize({
            caller: normalizeCaller(input.caller),
            operation: "supersede",
            target,
            signalId: signal.signalId,
            intent: signal.intent,
            deliveryMode: signal.deliveryMode,
        });
        return this.appendReceipt({
            target,
            signalId: input.signalId,
            state: "superseded",
            createdAt: input.now ?? this.clock.now(),
            metadata: {
                ...(input.supersededBySignalId
                    ? { supersededBySignalId: input.supersededBySignalId }
                    : {}),
                ...(input.reason ? { reason: input.reason } : {}),
            },
        });
    }
    async consumeForContinuation(input) {
        const target = normalizeTarget(input.target);
        const now = input.now ?? this.clock.now();
        const capabilities = input.capabilities ?? defaultCapabilities;
        const views = await this.signalViews({ target, capabilities, now });
        const expired = views.filter((view) => view.state === "pending" && view.expired);
        for (const view of expired) {
            await this.appendReceipt({
                target: view.signal.target,
                signalId: view.signal.signalId,
                state: "expired",
                createdAt: now,
            });
        }
        const deliverable = views
            .filter((view) => view.deliverable)
            .map((view) => view.signal);
        const claimed = [];
        for (const signal of deliverable) {
            const accepted = await this.tryClaimDelivery({
                target: signal.target,
                signalId: signal.signalId,
                state: "accepted",
                createdAt: now,
                deliveryAttemptId: input.deliveryAttemptId,
            });
            if (!accepted)
                continue;
            claimed.push(signal);
            await this.appendReceipt({
                target: signal.target,
                signalId: signal.signalId,
                state: "delivered",
                createdAt: now,
                deliveryAttemptId: input.deliveryAttemptId,
                deliveredAt: now,
            });
        }
        const message = compileWorkerControlSignalsForContinuation(claimed);
        return {
            target,
            deliveryAttemptId: input.deliveryAttemptId,
            signals: claimed,
            signalIds: claimed.map((signal) => signal.signalId),
            ...(message === undefined ? {} : { message }),
        };
    }
    async signalViews(input) {
        const signals = await this.options.store.listSignals({ target: input.target });
        const receipts = await this.options.store.listReceipts({ target: input.target });
        return signals
            .map((signal) => signalView({
            signal,
            receipts,
            capabilities: input.capabilities,
            now: input.now,
        }))
            .sort(compareSignalViews);
    }
    async signalViewFor(input) {
        const receipts = await this.options.store.listReceipts({
            target: input.target,
            signalIds: [input.signal.signalId],
        });
        return signalView({
            signal: input.signal,
            receipts,
            capabilities: input.capabilities,
            now: input.now,
        });
    }
    async findSignalOrThrow(target, signalId) {
        const normalizedSignalId = signalId.trim();
        if (!normalizedSignalId)
            throw new Error("worker_control_signal_id_required");
        const signal = (await this.options.store.listSignals({
            target,
            signalIds: [normalizedSignalId],
        }))[0];
        if (!signal)
            throw new Error("worker_control_signal_not_found");
        return signal;
    }
    async assertSignalCanBeSuperseded(input) {
        const signal = input.signal ??
            await this.findSignalOrThrow(input.target, input.signalId);
        const view = await this.signalViewFor({
            signal,
            target: input.target,
            capabilities: defaultCapabilities,
            now: input.now,
        });
        if (isInProgressDeliveryState(view.state)) {
            throw new Error("worker_control_signal_delivery_in_progress");
        }
        if (view.state !== "pending" && view.state !== "expired") {
            throw new Error("worker_control_signal_already_delivered_use_corrective_signal");
        }
    }
    async authorize(input) {
        const decision = await this.authorizationPolicy.authorizeWorkerControl(input);
        if (!decision.allowed) {
            throw new Error(decision.reason ?? "worker_control_unauthorized");
        }
    }
    async repairAcceptedDeliveryClaims(input) {
        const releaseDeliveryClaim = this.options.store.releaseDeliveryClaim;
        const accepted = input.views.filter((view) => view.state === "accepted" && view.latestReceipt?.state === "accepted");
        if (accepted.length === 0) {
            return { repairedSignalIds: [], warnings: [] };
        }
        if (!releaseDeliveryClaim) {
            return {
                repairedSignalIds: [],
                warnings: [
                    "Accepted control signal delivery claims cannot be repaired by the configured store.",
                ],
            };
        }
        const staleAfterMs = input.acceptedStaleAfterMs ?? 5 * 60 * 1000;
        const repairedSignalIds = [];
        for (const view of accepted) {
            const receipt = view.latestReceipt;
            if (!receipt)
                continue;
            if (input.now.getTime() - receipt.createdAt.getTime() < staleAfterMs) {
                continue;
            }
            const released = await releaseDeliveryClaim.call(this.options.store, {
                target: receipt.target,
                signalId: receipt.signalId,
                ...(receipt.deliveryAttemptId === undefined
                    ? {}
                    : { deliveryAttemptId: receipt.deliveryAttemptId }),
            });
            if (released)
                repairedSignalIds.push(view.signal.signalId);
        }
        return {
            repairedSignalIds,
            warnings: repairedSignalIds.length === 0
                ? ["No stale accepted control signal delivery claims were repaired."]
                : [],
        };
    }
    appendReceipt(input) {
        return this.options.store.appendReceipt(this.deliveryReceipt(input));
    }
    async tryClaimDelivery(input) {
        const receipt = this.deliveryReceipt(input);
        if (this.options.store.tryClaimDelivery) {
            return this.options.store.tryClaimDelivery(receipt);
        }
        return this.options.store.appendReceipt(receipt);
    }
    deliveryReceipt(input) {
        return {
            schemaVersion: 1,
            receiptId: this.idFactory(),
            signalId: input.signalId,
            target: normalizeTarget(input.target),
            state: input.state,
            createdAt: input.createdAt,
            ...(input.deliveryAttemptId === undefined
                ? {}
                : { deliveryAttemptId: input.deliveryAttemptId }),
            ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
            ...(input.appliedAt === undefined ? {} : { appliedAt: input.appliedAt }),
            ...(input.rejectedReason === undefined
                ? {}
                : { rejectedReason: input.rejectedReason }),
            ...(input.failure === undefined ? {} : { failure: input.failure }),
            metadata: normalizeMetadata(input.metadata),
        };
    }
}
export function normalizeWorkerControlTarget(target) {
    return normalizeTarget(target);
}
export function workerControlTargetMatches(query, target) {
    const normalizedQuery = normalizeTarget(query);
    const normalizedTarget = normalizeTarget(target);
    return (normalizedQuery.jobId === normalizedTarget.jobId &&
        optionalMatch(normalizedQuery.taskId, normalizedTarget.taskId) &&
        optionalMatch(normalizedQuery.workerId, normalizedTarget.workerId) &&
        optionalMatch(normalizedQuery.attemptId, normalizedTarget.attemptId) &&
        optionalMatch(normalizedQuery.providerSessionId, normalizedTarget.providerSessionId) &&
        optionalMatch(normalizedQuery.workspaceId, normalizedTarget.workspaceId));
}
function signalView(input) {
    const receipts = input.receipts
        .filter((receipt) => receipt.signalId === input.signal.signalId)
        .sort(compareReceiptsNewestFirst);
    const latestReceipt = receipts[0];
    const expired = Boolean(input.signal.expiresAt &&
        input.signal.expiresAt.getTime() <= input.now.getTime());
    const state = expired && latestReceipt === undefined
        ? "expired"
        : latestReceipt?.state ?? "pending";
    const blockedReason = blockedReasonForSignal({
        signal: input.signal,
        state,
        expired,
        capabilities: input.capabilities,
    });
    return {
        signal: input.signal,
        state,
        ...(latestReceipt === undefined ? {} : { latestReceipt }),
        expired,
        deliverable: !blockedReason && isContinuationDeliveryMode(input.signal.deliveryMode),
        ...(blockedReason === undefined ? {} : { blockedReason }),
    };
}
function blockedReasonForSignal(input) {
    if (input.state !== "pending" &&
        !isInterruptedSignalReadyForContinuation(input.signal, input.state)) {
        return "signal_not_pending";
    }
    if (input.expired)
        return "signal_expired";
    if (input.signal.deliveryMode === "record_only")
        return undefined;
    if (input.signal.deliveryMode === "next_safe_point" &&
        !input.capabilities.supportsNextSafePoint) {
        return "next_safe_point_not_supported";
    }
    if (input.signal.deliveryMode === "pause_then_continue" &&
        !input.capabilities.supportsPauseThenContinue) {
        return "pause_then_continue_not_supported";
    }
    if (input.signal.deliveryMode === "interrupt_then_continue" &&
        !input.capabilities.supportsInterruptThenContinue &&
        !input.capabilities.supportsNextSafePoint) {
        return "interrupt_then_continue_not_supported";
    }
    if (input.signal.deliveryMode === "idle_turn_if_supported" &&
        !input.capabilities.supportsIdleTurnInput) {
        return "idle_turn_input_not_supported";
    }
    if (input.signal.deliveryMode === "live_if_supported" &&
        !input.capabilities.supportsLiveInput) {
        return "live_input_not_supported";
    }
    return undefined;
}
function isContinuationDeliveryMode(mode) {
    return (mode === "next_safe_point" ||
        mode === "pause_then_continue" ||
        mode === "interrupt_then_continue");
}
function isInterruptedSignalReadyForContinuation(signal, state) {
    return (signal.deliveryMode === "interrupt_then_continue" &&
        state === "interrupted");
}
function isInProgressDeliveryState(state) {
    return (state === "accepted" ||
        state === "interrupt_requested" ||
        state === "interrupting");
}
function defaultDeliveryMode(intent) {
    if (intent === "operator_note")
        return "record_only";
    return "next_safe_point";
}
function normalizeCaller(caller, fallbackActor = "operator") {
    const kind = caller?.kind ?? fallbackActor;
    return {
        kind,
        ...(cleanOptional(caller?.id) === undefined
            ? {}
            : { id: cleanOptional(caller?.id) }),
    };
}
function normalizeTarget(target) {
    const jobId = target.jobId.trim();
    if (!jobId)
        throw new Error("worker_control_job_id_required");
    return {
        jobId,
        ...(cleanOptional(target.taskId) === undefined
            ? {}
            : { taskId: cleanOptional(target.taskId) }),
        ...(cleanOptional(target.workerId) === undefined
            ? {}
            : { workerId: cleanOptional(target.workerId) }),
        ...(cleanOptional(target.attemptId) === undefined
            ? {}
            : { attemptId: cleanOptional(target.attemptId) }),
        ...(cleanOptional(target.providerSessionId) === undefined
            ? {}
            : { providerSessionId: cleanOptional(target.providerSessionId) }),
        ...(cleanOptional(target.workspaceId) === undefined
            ? {}
            : { workspaceId: cleanOptional(target.workspaceId) }),
    };
}
function normalizeBody(body) {
    const normalized = body.trim();
    if (!normalized)
        throw new Error("worker_control_body_required");
    if (normalized.length > 24_000) {
        throw new Error("worker_control_body_too_large");
    }
    return normalized;
}
function normalizeMetadata(metadata) {
    if (!metadata)
        return {};
    return Object.fromEntries(Object.entries(metadata)
        .map(([key, value]) => [key.trim(), value.trim()])
        .filter(([key, value]) => key && value));
}
function stableIdempotencyKey(input) {
    return createHash("sha256")
        .update(JSON.stringify({
        target: input.target,
        intent: input.intent,
        deliveryMode: input.deliveryMode,
        body: input.body,
    }))
        .digest("hex");
}
function compareSignalViews(left, right) {
    const priority = priorityRank(right.signal.priority) -
        priorityRank(left.signal.priority);
    if (priority !== 0)
        return priority;
    const created = left.signal.createdAt.getTime() - right.signal.createdAt.getTime();
    if (created !== 0)
        return created;
    return left.signal.signalId.localeCompare(right.signal.signalId);
}
function priorityRank(priority) {
    if (priority === "high")
        return 3;
    if (priority === "normal")
        return 2;
    return 1;
}
function compareReceiptsNewestFirst(left, right) {
    const created = right.createdAt.getTime() - left.createdAt.getTime();
    if (created !== 0)
        return created;
    return receiptStateRank(right.state) - receiptStateRank(left.state);
}
function receiptStateRank(state) {
    switch (state) {
        case "acknowledged":
            return 7;
        case "delivered":
            return 6;
        case "accepted":
            return 5;
        case "failed":
            return 4;
        case "continued":
            return 4;
        case "interrupted":
            return 4;
        case "interrupting":
            return 4;
        case "interrupt_requested":
            return 4;
        case "rejected":
            return 3;
        case "expired":
            return 2;
        case "superseded":
            return 1;
    }
}
function optionalMatch(queryValue, targetValue) {
    return queryValue === undefined || targetValue === undefined ||
        queryValue === targetValue;
}
function cleanOptional(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
//# sourceMappingURL=worker-control-service.js.map