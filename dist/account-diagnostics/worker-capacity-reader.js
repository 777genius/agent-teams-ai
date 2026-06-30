export function createWorkerAccountCapacityReader(options) {
    return {
        async readCapacity(input) {
            const accountId = input.account.capacityAccountId ?? input.identity.providerAccountId;
            if (!accountId)
                return null;
            const capacity = options.store.read({
                accountId,
                now: input.now,
            });
            return capacity ? workerCapacityToDiagnosticSignal(capacity) : null;
        },
    };
}
export function workerCapacityToDiagnosticSignal(capacity) {
    switch (capacity.availability) {
        case "available":
            return {
                availability: "available",
                source: "cached",
                ...(capacity.reason ? { reason: capacity.reason } : {}),
                ...(capacity.details ? { details: capacity.details } : {}),
            };
        case "quota_exhausted":
        case "cooldown":
            return {
                availability: "limited",
                source: "cached",
                reason: capacity.reason ?? capacity.availability,
                ...(capacity.cooldownUntil
                    ? {
                        limitResetAt: capacity.cooldownUntil,
                        rawResetText: capacity.cooldownUntil.toISOString(),
                    }
                    : {}),
                ...(capacity.lastLimitSignalAt
                    ? { checkedAt: capacity.lastLimitSignalAt }
                    : {}),
                ...(capacity.details ? { details: capacity.details } : {}),
            };
        case "disabled":
        case "degraded":
            return {
                availability: "unhealthy",
                source: "cached",
                reason: capacity.reason ?? capacity.availability,
                ...(capacity.details ? { details: capacity.details } : {}),
            };
        case "busy":
        case "warming":
            return {
                availability: "unknown",
                source: "cached",
                reason: capacity.reason ?? capacity.availability,
                ...(capacity.details ? { details: capacity.details } : {}),
            };
    }
}
//# sourceMappingURL=worker-capacity-reader.js.map