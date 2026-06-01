import { RuntimeInvariantError } from "./errors.js";
const sessionTransitions = {
    missing: ["seeded"],
    seeded: ["preleased"],
    preleased: ["restored", "stale"],
    restored: ["validated", "needs_reconnect"],
    validated: ["refreshing", "active", "needs_reconnect"],
    refreshing: ["writeback_pending", "active", "needs_reconnect"],
    writeback_pending: ["active", "stale"],
    active: [],
    needs_reconnect: [],
    stale: [],
};
const leaseTransitions = {
    requested: ["granted", "denied", "expired"],
    granted: ["finalized", "expired"],
    denied: [],
    finalized: ["writeback_started", "expired"],
    writeback_started: [
        "writeback_committed",
        "idempotent_replay",
        "stale_generation",
        "expired",
    ],
    writeback_committed: [],
    idempotent_replay: [],
    stale_generation: [],
    expired: [],
};
export function assertSessionTransition(from, to) {
    assertTransition("session", sessionTransitions, from, to);
}
export function assertLeaseTransition(from, to) {
    assertTransition("lease", leaseTransitions, from, to);
}
function assertTransition(name, transitions, from, to) {
    if (!transitions[from].includes(to)) {
        throw new RuntimeInvariantError(`Invalid ${name} transition: ${from} -> ${to}`);
    }
}
//# sourceMappingURL=state-machines.js.map