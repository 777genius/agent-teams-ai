export type SessionRuntimeState = "missing" | "seeded" | "preleased" | "restored" | "validated" | "refreshing" | "writeback_pending" | "active" | "needs_reconnect" | "stale";
export type LeaseRuntimeState = "requested" | "granted" | "denied" | "finalized" | "writeback_started" | "writeback_committed" | "idempotent_replay" | "stale_generation" | "expired";
export declare function assertSessionTransition(from: SessionRuntimeState, to: SessionRuntimeState): void;
export declare function assertLeaseTransition(from: LeaseRuntimeState, to: LeaseRuntimeState): void;
//# sourceMappingURL=state-machines.d.ts.map