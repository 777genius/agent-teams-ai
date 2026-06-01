import { RuntimeInvariantError } from "./errors";

export type SessionRuntimeState =
  | "missing"
  | "seeded"
  | "preleased"
  | "restored"
  | "validated"
  | "refreshing"
  | "writeback_pending"
  | "active"
  | "needs_reconnect"
  | "stale";

export type LeaseRuntimeState =
  | "requested"
  | "granted"
  | "denied"
  | "finalized"
  | "writeback_started"
  | "writeback_committed"
  | "idempotent_replay"
  | "stale_generation"
  | "expired";

const sessionTransitions: Record<
  SessionRuntimeState,
  readonly SessionRuntimeState[]
> = {
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

const leaseTransitions: Record<
  LeaseRuntimeState,
  readonly LeaseRuntimeState[]
> = {
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

export function assertSessionTransition(
  from: SessionRuntimeState,
  to: SessionRuntimeState,
): void {
  assertTransition("session", sessionTransitions, from, to);
}

export function assertLeaseTransition(
  from: LeaseRuntimeState,
  to: LeaseRuntimeState,
): void {
  assertTransition("lease", leaseTransitions, from, to);
}

function assertTransition<TState extends string>(
  name: string,
  transitions: Record<TState, readonly TState[]>,
  from: TState,
  to: TState,
): void {
  if (!transitions[from].includes(to)) {
    throw new RuntimeInvariantError(
      `Invalid ${name} transition: ${from} -> ${to}`,
    );
  }
}
