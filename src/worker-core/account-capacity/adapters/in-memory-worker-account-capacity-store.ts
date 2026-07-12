import { randomUUID } from "node:crypto";
import type { WorkerCapacitySnapshot } from "../../types";
import type { ObservabilityPort } from "../../../core";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacityResolveStatus,
  WorkerAccountCapacitySignalScope,
  WorkerAccountCapacityMetric,
  defaultRuntimeDemandFromCapacityDetails,
  normalizeWorkerAccountCapacitySignal,
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  shouldKeepExistingWorkerAccountCapacity,
  workerRuntimeDemandKey,
  type WorkerAccountCapacityRecheckClaim,
  type WorkerAccountCapacityRecheckResolution,
  type WorkerAccountCapacityState,
  type WorkerAccountLimitSignal,
  type WorkerRuntimeDemand,
} from "../domain";
import type { WorkerAccountCapacityStore } from "../ports";

type InMemoryCapacityRecord = {
  readonly recordId: string;
  readonly revision: string;
  readonly accountId: string;
  readonly demand: WorkerRuntimeDemand | null;
  readonly capacity: WorkerCapacitySnapshot;
};

export class InMemoryWorkerAccountCapacityStore
  implements WorkerAccountCapacityStore
{
  private readonly records = new Map<string, InMemoryCapacityRecord>();
  private readonly claims = new Map<string, WorkerAccountCapacityRecheckClaim>();

  constructor(
    private readonly options: { readonly observability?: ObservabilityPort } = {},
  ) {}

  read(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null {
    const state = this.readState({
      accountId: input.accountId,
      ...(input.demand ? { demand: input.demand } : {}),
      now: input.now ?? new Date(),
    });
    if (!state) return null;
    if (state.phase === WorkerAccountCapacityPhase.Blocking) return state.capacity;
    const claim = this.claims.get(state.recordId);
    if (claim && claim.expiresAt.getTime() > (input.now ?? new Date()).getTime()) {
      return recheckInProgressCapacity(state.capacity, claim.expiresAt);
    }
    return null;
  }

  readState(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now: Date;
  }): WorkerAccountCapacityState | null {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return null;
    const demand = normalizeWorkerRuntimeDemand(input.demand);
    const record = demand
      ? selectPreferredRecord(
          [
            this.records.get(accountCapacityKey(accountId, demand)),
            this.records.get(accountCapacityKey(accountId, null)),
          ],
          input.now,
        )
      : this.readAggregateRecord(accountId, input.now);
    return record ? stateFromRecord(record, input.now) : null;
  }

  observe(input: WorkerAccountLimitSignal): WorkerAccountCapacityState | null {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return null;
    const capacity = normalizeWorkerAccountCapacitySignal(input);
    if (!capacity) return null;
    const demand = input.scope === WorkerAccountCapacitySignalScope.AccountWide
      ? null
      : normalizeWorkerRuntimeDemand(input.demand) ??
        defaultRuntimeDemandFromCapacityDetails(input.capacity.details);
    const key = accountCapacityKey(accountId, demand);
    const existing = this.records.get(key);
    const claim = this.claims.get(key);
    const activeClaim = Boolean(
      claim && claim.expiresAt.getTime() > input.observedAt.getTime(),
    );
    if (
      existing &&
      stateFromRecord(existing, input.observedAt).phase ===
        WorkerAccountCapacityPhase.Blocking &&
      shouldKeepExistingWorkerAccountCapacity(existing.capacity, capacity)
    ) {
      if (!activeClaim) return stateFromRecord(existing, input.observedAt);
      const refreshed: InMemoryCapacityRecord = {
        ...existing,
        revision: randomUUID(),
      };
      this.records.set(key, refreshed);
      this.claims.delete(key);
      return stateFromRecord(refreshed, input.observedAt);
    }
    const record: InMemoryCapacityRecord = {
      recordId: key,
      revision: randomUUID(),
      accountId,
      demand,
      capacity,
    };
    this.records.set(key, record);
    this.claims.delete(key);
    recordTimeToReset(this.options.observability, capacity, input.observedAt);
    return stateFromRecord(record, input.observedAt);
  }

  tryClaimRecheck(input: {
    readonly state: WorkerAccountCapacityState;
    readonly ownerId: string;
    readonly now: Date;
    readonly ttlMs: number;
    readonly mode: WorkerAccountCapacityRecheckMode;
  }) {
    const current = this.records.get(input.state.recordId);
    if (!current) return { status: WorkerAccountCapacityClaimStatus.Missing } as const;
    if (current.revision !== input.state.revision) {
      return { status: WorkerAccountCapacityClaimStatus.Conflict } as const;
    }
    const state = stateFromRecord(current, input.now);
    if (
      input.mode === WorkerAccountCapacityRecheckMode.DueOnly &&
      state.phase === WorkerAccountCapacityPhase.RecheckDue
    ) {
      this.options.observability?.count(WorkerAccountCapacityMetric.RecheckDue);
    }
    if (
      input.mode === WorkerAccountCapacityRecheckMode.DueOnly &&
      state.phase !== WorkerAccountCapacityPhase.RecheckDue
    ) {
      return { status: WorkerAccountCapacityClaimStatus.NotDue, state } as const;
    }
    const existingClaim = this.claims.get(current.recordId);
    if (existingClaim && existingClaim.expiresAt.getTime() > input.now.getTime()) {
      this.options.observability?.count(WorkerAccountCapacityMetric.RecheckBusy);
      return {
        status: WorkerAccountCapacityClaimStatus.Busy,
        retryAt: existingClaim.expiresAt,
      } as const;
    }
    const claim: WorkerAccountCapacityRecheckClaim = {
      claimId: randomUUID(),
      recordId: current.recordId,
      baseRevision: current.revision,
      accountId: current.accountId,
      demand: current.demand,
      ownerId: input.ownerId,
      claimedAt: input.now,
      expiresAt: new Date(input.now.getTime() + Math.max(1, input.ttlMs)),
      previous: current.capacity,
    };
    this.claims.set(current.recordId, claim);
    return { status: WorkerAccountCapacityClaimStatus.Claimed, claim } as const;
  }

  resolveRecheck(input: {
    readonly claim: WorkerAccountCapacityRecheckClaim;
    readonly observedAt: Date;
    readonly resolution: WorkerAccountCapacityRecheckResolution;
  }) {
    if (
      input.resolution.type === WorkerAccountCapacityResolutionType.Retry &&
      input.resolution.reason === "quota_recheck_failed"
    ) {
      this.options.observability?.count(WorkerAccountCapacityMetric.RecheckFailed);
    }
    const storedClaim = this.claims.get(input.claim.recordId);
    if (!storedClaim || storedClaim.claimId !== input.claim.claimId) {
      return { status: WorkerAccountCapacityResolveStatus.StaleClaim };
    }
    if (storedClaim.expiresAt.getTime() <= input.observedAt.getTime()) {
      this.claims.delete(input.claim.recordId);
      return { status: WorkerAccountCapacityResolveStatus.StaleClaim };
    }
    const current = this.records.get(input.claim.recordId);
    if (!current) {
      this.claims.delete(input.claim.recordId);
      return { status: WorkerAccountCapacityResolveStatus.Missing };
    }
    if (current.revision !== input.claim.baseRevision) {
      this.claims.delete(input.claim.recordId);
      return { status: WorkerAccountCapacityResolveStatus.Conflict };
    }
    const next = resolvedCapacity(input);
    if (next) {
      const record: InMemoryCapacityRecord = {
        ...current,
        revision: randomUUID(),
        capacity: next,
      };
      this.records.set(current.recordId, record);
      if (input.resolution.type === WorkerAccountCapacityResolutionType.Limited) {
        recordTimeToReset(
          this.options.observability,
          record.capacity,
          input.observedAt,
        );
      }
      this.claims.delete(current.recordId);
      return {
        status: WorkerAccountCapacityResolveStatus.Applied,
        state: stateFromRecord(record, input.observedAt),
      };
    }
    this.records.delete(current.recordId);
    this.claims.delete(current.recordId);
    return { status: WorkerAccountCapacityResolveStatus.Applied };
  }

  releaseRecheck(input: { readonly claim: WorkerAccountCapacityRecheckClaim }): void {
    const stored = this.claims.get(input.claim.recordId);
    if (stored?.claimId === input.claim.claimId) {
      this.claims.delete(input.claim.recordId);
    }
  }

  clear(input: { readonly accountId: string }): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    const prefix = `${accountId}\u0000`;
    for (const key of this.records.keys()) {
      if (key === accountId || key.startsWith(prefix)) {
        this.records.delete(key);
        this.claims.delete(key);
      }
    }
  }

  private readAggregateRecord(
    accountId: string,
    now: Date,
  ): InMemoryCapacityRecord | null {
    const prefix = `${accountId}\u0000`;
    const candidates: InMemoryCapacityRecord[] = [];
    for (const [key, record] of this.records) {
      if (key !== accountId && !key.startsWith(prefix)) continue;
      candidates.push(record);
    }
    return selectPreferredRecord(candidates, now);
  }
}

function selectPreferredRecord(
  records: readonly (InMemoryCapacityRecord | undefined)[],
  now: Date,
): InMemoryCapacityRecord | null {
  const present = records.filter(
    (record): record is InMemoryCapacityRecord => record !== undefined,
  );
  const active = present.filter(
    (record) =>
      stateFromRecord(record, now).phase === WorkerAccountCapacityPhase.Blocking,
  );
  const candidates = active.length > 0 ? active : present;
  let selected: InMemoryCapacityRecord | null = null;
  for (const record of candidates) {
    if (
      !selected ||
      !shouldKeepExistingWorkerAccountCapacity(selected.capacity, record.capacity)
    ) {
      selected = record;
    }
  }
  return selected;
}

function stateFromRecord(
  record: InMemoryCapacityRecord,
  now: Date,
): WorkerAccountCapacityState {
  const recheckDue = Boolean(
    record.capacity.cooldownUntil &&
      record.capacity.cooldownUntil.getTime() <= now.getTime(),
  );
  return {
    recordId: record.recordId,
    revision: record.revision,
    accountId: record.accountId,
    demand: record.demand,
    capacity: record.capacity,
    phase: recheckDue
      ? WorkerAccountCapacityPhase.RecheckDue
      : WorkerAccountCapacityPhase.Blocking,
  };
}

function recheckInProgressCapacity(
  previous: WorkerCapacitySnapshot,
  retryAt: Date,
): WorkerCapacitySnapshot {
  return {
    availability: "cooldown",
    reason: "quota_recheck_in_progress",
    cooldownUntil: retryAt,
    ...(previous.lastLimitSignalAt
      ? { lastLimitSignalAt: previous.lastLimitSignalAt }
      : {}),
    ...(previous.details ? { details: previous.details } : {}),
  };
}

function resolvedCapacity(input: {
  readonly claim: WorkerAccountCapacityRecheckClaim;
  readonly observedAt: Date;
  readonly resolution: WorkerAccountCapacityRecheckResolution;
}): WorkerCapacitySnapshot | null {
  if (input.resolution.type === WorkerAccountCapacityResolutionType.Available) {
    return null;
  }
  if (input.resolution.type === WorkerAccountCapacityResolutionType.Retry) {
    return {
      availability: "cooldown",
      reason: input.resolution.reason,
      cooldownUntil: input.resolution.retryAt,
      lastLimitSignalAt: input.observedAt,
      ...(input.claim.previous.details
        ? { details: input.claim.previous.details }
        : {}),
    };
  }
  return normalizeWorkerAccountCapacitySignal({
    accountId: input.claim.accountId,
    ...(input.claim.demand ? { demand: input.claim.demand } : {}),
    capacity: input.resolution.capacity,
    observedAt: input.observedAt,
  }) ?? invalidLimitedRecheckCapacity(input);
}

function invalidLimitedRecheckCapacity(input: {
  readonly claim: WorkerAccountCapacityRecheckClaim;
  readonly observedAt: Date;
}): WorkerCapacitySnapshot {
  return {
    availability: "cooldown",
    reason: "quota_recheck_invalid_limited",
    cooldownUntil: new Date(input.observedAt.getTime() + 60_000),
    lastLimitSignalAt: input.observedAt,
    ...(input.claim.previous.details
      ? { details: input.claim.previous.details }
      : {}),
  };
}

function accountCapacityKey(
  accountId: string,
  demand: WorkerRuntimeDemand | null,
): string {
  const demandKey = workerRuntimeDemandKey(demand);
  return demandKey ? `${accountId}\u0000${demandKey}` : accountId;
}

function recordTimeToReset(
  observability: ObservabilityPort | undefined,
  capacity: WorkerCapacitySnapshot,
  observedAt: Date,
): void {
  if (!isProviderQuotaCapacity(capacity) || !capacity.cooldownUntil) return;
  observability?.timing(
    WorkerAccountCapacityMetric.TimeToResetMs,
    Math.max(0, capacity.cooldownUntil.getTime() - observedAt.getTime()),
  );
}

function isProviderQuotaCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return capacity.reason === "quota_limited";
}
