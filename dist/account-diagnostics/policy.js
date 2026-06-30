export function chooseDiagnosticSignal(input) {
    const normalized = input.signals.filter(isActionableSignal);
    const live = normalized.find((signal) => signal.source === "live_probe");
    if (input.probeMode === "live_probe" && live) {
        return withCheckedAt(live, input.checkedAt);
    }
    const sorted = [...normalized].sort(compareSignals);
    const selected = sorted[0];
    if (selected)
        return withCheckedAt(selected, input.checkedAt);
    return {
        availability: "available",
        source: "cached",
        checkedAt: input.checkedAt,
    };
}
export function recommendedActionForAvailability(availability) {
    switch (availability) {
        case "available":
            return "none";
        case "limited":
            return "wait";
        case "reconnect_required":
            return "relogin";
        case "auth_unknown":
        case "unhealthy":
        case "unknown":
            return "inspect";
    }
}
export function isSchedulerEligible(availability) {
    return availability === "available";
}
export function accountAvailabilitySeverity(availability) {
    switch (availability) {
        case "reconnect_required":
            return 100;
        case "auth_unknown":
            return 95;
        case "limited":
            return 90;
        case "unhealthy":
            return 80;
        case "unknown":
            return 40;
        case "available":
            return 10;
    }
}
function compareSignals(left, right) {
    const severityDelta = accountAvailabilitySeverity(right.availability) -
        accountAvailabilitySeverity(left.availability);
    if (severityDelta !== 0)
        return severityDelta;
    const sourceDelta = sourcePriority(right.source) - sourcePriority(left.source);
    if (sourceDelta !== 0)
        return sourceDelta;
    const leftReset = left.limitResetAt?.getTime();
    const rightReset = right.limitResetAt?.getTime();
    if (leftReset === undefined && rightReset !== undefined)
        return 1;
    if (leftReset !== undefined && rightReset === undefined)
        return -1;
    if (leftReset !== undefined && rightReset !== undefined) {
        return rightReset - leftReset;
    }
    return 0;
}
function isActionableSignal(signal) {
    return signal.availability !== "available" || signal.source !== "cached";
}
function sourcePriority(source) {
    switch (source) {
        case "live_probe":
            return 30;
        case "health":
            return 20;
        case "cached":
            return 10;
    }
}
function withCheckedAt(signal, checkedAt) {
    return {
        ...signal,
        checkedAt: signal.checkedAt ?? checkedAt,
    };
}
//# sourceMappingURL=policy.js.map