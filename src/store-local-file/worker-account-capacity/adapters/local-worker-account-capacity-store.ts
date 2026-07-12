import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacityResolveStatus,
  WorkerAccountCapacitySignalScope,
  WorkerAccountCapacityMetric,
  defaultRuntimeDemandFromCapacityDetails,
  isPersistableWorkerAccountAvailability,
  normalizeWorkerAccountCapacitySignal,
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  shouldKeepExistingWorkerAccountCapacity,
  workerRuntimeDemandKey,
  type WorkerAccountCapacityRecheckClaim,
  type WorkerAccountCapacityRecheckResolution,
  type WorkerAccountCapacityState,
  type WorkerAccountCapacityStore,
  type WorkerAccountLimitSignal,
  type WorkerCapacitySnapshot,
  type WorkerRuntimeDemand,
} from "@vioxen/subscription-runtime/worker-core";
import {
  localWorkerAccountCapacityDemandAwareStorageVersion as demandAwareStorageVersion,
  localWorkerAccountCapacityRevisionedStorageVersion as revisionedStorageVersion,
  localWorkerAccountCapacityStorageVersion as storageVersion,
} from "../domain/local-worker-account-capacity-record-policy";

export type LocalFileWorkerAccountCapacityStoreOptions = {
  readonly rootDir: string;
  readonly observability?: ObservabilityPort;
};

type PersistedWorkerAccountCapacityRecord = {
  readonly storageVersion:
    | typeof storageVersion
    | typeof demandAwareStorageVersion
    | typeof revisionedStorageVersion;
  readonly revision?: string;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly capacity: PersistedWorkerCapacitySnapshot;
  readonly updatedAt: string;
};

type PersistedWorkerCapacitySnapshot = {
  readonly availability: WorkerCapacitySnapshot["availability"];
  readonly reason?: string;
  readonly cooldownUntil?: string;
  readonly lastLimitSignalAt?: string;
  readonly details?: Readonly<Record<string, string>>;
};

type ResolvedRecord = {
  readonly path: string;
  readonly record: PersistedWorkerAccountCapacityRecord;
  readonly capacity: WorkerCapacitySnapshot;
};

type PersistedClaim = {
  readonly claimId: string;
  readonly recordId: string;
  readonly baseRevision: string;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly ownerId: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly previous: PersistedWorkerCapacitySnapshot;
};

export class LocalFileWorkerAccountCapacityStore
  implements WorkerAccountCapacityStore
{
  constructor(
    private readonly options: LocalFileWorkerAccountCapacityStoreOptions,
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
    const claim = this.readClaim(this.claimPath(state.recordId));
    const now = input.now ?? new Date();
    if (claim && claim.expiresAt.getTime() > now.getTime()) {
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
    const resolved = demand
      ? selectPreferredResolved(
          [
            this.readResolvedRecord(this.recordPath(accountId, demand)),
            this.readResolvedRecord(this.recordPath(accountId, null)),
            this.readResolvedRecord(this.legacyRecordPath(accountId)),
          ],
          input.now,
        )
      : this.readAggregateRecord(accountId, input.now);
    if (!resolved) return null;
    if (resolved.record.accountId !== accountId) {
      rmSync(resolved.path, { force: true });
      return null;
    }
    if (
      demand &&
      resolved.record.demand &&
      workerRuntimeDemandKey(resolved.record.demand) !==
        workerRuntimeDemandKey(demand)
    ) {
      rmSync(resolved.path, { force: true });
      return null;
    }
    return stateFromResolved(resolved, input.now);
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
    const path = this.recordPath(accountId, demand);
    return this.withRecordLock(path, () => {
      const existing = this.readResolvedRecord(path);
      const claim = this.readClaim(this.claimPath(path));
      const activeClaim = Boolean(
        claim && claim.expiresAt.getTime() > input.observedAt.getTime(),
      );
      if (
        existing &&
        stateFromResolved(existing, input.observedAt).phase ===
          WorkerAccountCapacityPhase.Blocking &&
        shouldKeepExistingWorkerAccountCapacity(existing.capacity, capacity)
      ) {
        if (!activeClaim) return stateFromResolved(existing, input.observedAt);
        const refreshed: PersistedWorkerAccountCapacityRecord = {
          ...existing.record,
          storageVersion: revisionedStorageVersion,
          revision: randomUUID(),
          updatedAt: input.observedAt.toISOString(),
        };
        this.writeRecord(refreshed);
        const resolved = this.readResolvedRecord(path);
        return resolved ? stateFromResolved(resolved, input.observedAt) : null;
      }
      const record: PersistedWorkerAccountCapacityRecord = {
        storageVersion: revisionedStorageVersion,
        revision: randomUUID(),
        accountId,
        ...(demand ? { demand } : {}),
        capacity: persistCapacity(capacity),
        updatedAt: input.observedAt.toISOString(),
      };
      this.writeRecord(record);
      recordTimeToReset(
        this.options.observability,
        capacity,
        input.observedAt,
      );
      const resolved = this.readResolvedRecord(path);
      return resolved ? stateFromResolved(resolved, input.observedAt) : null;
    });
  }

  tryClaimRecheck(input: {
    readonly state: WorkerAccountCapacityState;
    readonly ownerId: string;
    readonly now: Date;
    readonly ttlMs: number;
    readonly mode: WorkerAccountCapacityRecheckMode;
  }) {
    if (!this.isManagedRecordPath(input.state.recordId)) {
      return { status: WorkerAccountCapacityClaimStatus.Conflict } as const;
    }
    return this.withRecordLock(input.state.recordId, () => {
      const current = this.readResolvedRecord(input.state.recordId);
      if (!current) {
        return { status: WorkerAccountCapacityClaimStatus.Missing } as const;
      }
      const currentState = stateFromResolved(current, input.now);
      if (currentState.revision !== input.state.revision) {
        return { status: WorkerAccountCapacityClaimStatus.Conflict } as const;
      }
      if (
        input.mode === WorkerAccountCapacityRecheckMode.DueOnly &&
        currentState.phase === WorkerAccountCapacityPhase.RecheckDue
      ) {
        this.options.observability?.count(
          WorkerAccountCapacityMetric.RecheckDue,
        );
      }
      if (
        input.mode === WorkerAccountCapacityRecheckMode.DueOnly &&
        currentState.phase !== WorkerAccountCapacityPhase.RecheckDue
      ) {
        return {
          status: WorkerAccountCapacityClaimStatus.NotDue,
          state: currentState,
        } as const;
      }

      const claimPath = this.claimPath(input.state.recordId);
      const existingClaim = this.readClaim(claimPath);
      if (
        existingClaim &&
        existingClaim.expiresAt.getTime() > input.now.getTime()
      ) {
        this.options.observability?.count(
          WorkerAccountCapacityMetric.RecheckBusy,
        );
        return {
          status: WorkerAccountCapacityClaimStatus.Busy,
          retryAt: existingClaim.expiresAt,
        } as const;
      }
      const claim: WorkerAccountCapacityRecheckClaim = {
        claimId: randomUUID(),
        recordId: input.state.recordId,
        baseRevision: currentState.revision,
        accountId: currentState.accountId,
        demand: currentState.demand,
        ownerId: input.ownerId,
        claimedAt: input.now,
        expiresAt: new Date(input.now.getTime() + Math.max(1, input.ttlMs)),
        previous: currentState.capacity,
      };
      this.writeClaim(claimPath, claim);
      return { status: WorkerAccountCapacityClaimStatus.Claimed, claim } as const;
    });
  }

  resolveRecheck(input: {
    readonly claim: WorkerAccountCapacityRecheckClaim;
    readonly observedAt: Date;
    readonly resolution: WorkerAccountCapacityRecheckResolution;
  }) {
    if (!this.isManagedRecordPath(input.claim.recordId)) {
      return { status: WorkerAccountCapacityResolveStatus.StaleClaim };
    }
    if (
      input.resolution.type === WorkerAccountCapacityResolutionType.Retry &&
      input.resolution.reason === "quota_recheck_failed"
    ) {
      this.options.observability?.count(
        WorkerAccountCapacityMetric.RecheckFailed,
      );
    }
    return this.withRecordLock(input.claim.recordId, () => {
      const claimPath = this.claimPath(input.claim.recordId);
      const storedClaim = this.readClaim(claimPath);
      if (!storedClaim || storedClaim.claimId !== input.claim.claimId) {
        return { status: WorkerAccountCapacityResolveStatus.StaleClaim };
      }
      if (storedClaim.expiresAt.getTime() <= input.observedAt.getTime()) {
        this.releaseClaimUnlocked(input.claim);
        return { status: WorkerAccountCapacityResolveStatus.StaleClaim };
      }
      const current = this.readResolvedRecord(input.claim.recordId);
      if (!current) {
        this.releaseClaimUnlocked(input.claim);
        return { status: WorkerAccountCapacityResolveStatus.Missing };
      }
      if (recordRevision(current.record) !== input.claim.baseRevision) {
        this.releaseClaimUnlocked(input.claim);
        return { status: WorkerAccountCapacityResolveStatus.Conflict };
      }
      const next = resolvedCapacity(input);
      if (next) {
        const record: PersistedWorkerAccountCapacityRecord = {
          storageVersion: revisionedStorageVersion,
          revision: randomUUID(),
          accountId: current.record.accountId,
          ...(current.record.demand ? { demand: current.record.demand } : {}),
          capacity: persistCapacity(next),
          updatedAt: input.observedAt.toISOString(),
        };
        this.writeRecord(record);
        if (input.resolution.type === WorkerAccountCapacityResolutionType.Limited) {
          recordTimeToReset(
            this.options.observability,
            next,
            input.observedAt,
          );
        }
        const targetPath = this.recordPath(
          record.accountId,
          normalizeWorkerRuntimeDemand(record.demand),
        );
        if (current.path !== targetPath) rmSync(current.path, { force: true });
        this.releaseClaimUnlocked(input.claim);
        const resolved = this.readResolvedRecord(targetPath);
        return {
          status: WorkerAccountCapacityResolveStatus.Applied,
          ...(resolved
            ? { state: stateFromResolved(resolved, input.observedAt) }
            : {}),
        };
      }
      rmSync(input.claim.recordId, { force: true });
      this.releaseClaimUnlocked(input.claim);
      return { status: WorkerAccountCapacityResolveStatus.Applied };
    });
  }

  releaseRecheck(input: { readonly claim: WorkerAccountCapacityRecheckClaim }): void {
    if (!this.isManagedRecordPath(input.claim.recordId)) return;
    this.withRecordLock(input.claim.recordId, () => {
      this.releaseClaimUnlocked(input.claim);
    });
  }

  private releaseClaimUnlocked(claim: WorkerAccountCapacityRecheckClaim): void {
    const path = this.claimPath(claim.recordId);
    const stored = this.readClaim(path);
    if (stored?.claimId === claim.claimId) rmSync(path, { force: true });
  }

  clear(input: { readonly accountId: string }): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    rmSync(this.legacyRecordPath(accountId), { force: true });
    rmSync(this.accountRecordDir(accountId), { recursive: true, force: true });
  }

  private readAggregateRecord(accountId: string, now: Date): ResolvedRecord | null {
    return selectPreferredResolved(
      [
        this.readResolvedRecord(this.recordPath(accountId, null)),
        this.readResolvedRecord(this.legacyRecordPath(accountId)),
        ...this.readDemandRecords(accountId),
      ],
      now,
    );
  }

  private readDemandRecords(accountId: string): readonly ResolvedRecord[] {
    const dir = this.accountRecordDir(accountId);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== "account.json" &&
          entry.name.endsWith(".json") &&
          !entry.name.endsWith(".recheck-claim.json"),
      )
      .map((entry) => this.readResolvedRecord(join(dir, entry.name)))
      .filter((entry): entry is ResolvedRecord => entry !== null);
  }

  private readResolvedRecord(path: string): ResolvedRecord | null {
    const record = this.readRecordPath(path);
    if (!record) return null;
    const capacity = parsePersistedCapacity(record.capacity);
    if (!capacity) {
      rmSync(path, { force: true });
      return null;
    }
    return { path, record, capacity };
  }

  private readRecordPath(path: string): PersistedWorkerAccountCapacityRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        rmSync(path, { force: true });
        return null;
      }
      throw error;
    }
    if (
      !isRecord(parsed) ||
      (parsed.storageVersion !== storageVersion &&
        parsed.storageVersion !== demandAwareStorageVersion &&
        parsed.storageVersion !== revisionedStorageVersion) ||
      typeof parsed.accountId !== "string" ||
      !isRecord(parsed.capacity) ||
      typeof parsed.updatedAt !== "string" ||
      (parsed.revision !== undefined && typeof parsed.revision !== "string")
    ) {
      rmSync(path, { force: true });
      return null;
    }
    return parsed as PersistedWorkerAccountCapacityRecord;
  }

  private writeRecord(record: PersistedWorkerAccountCapacityRecord): void {
    const path = this.recordPath(
      record.accountId,
      normalizeWorkerRuntimeDemand(record.demand),
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private readClaim(path: string): WorkerAccountCapacityRecheckClaim | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        rmSync(path, { force: true });
        return null;
      }
      throw error;
    }
    if (!isPersistedClaim(parsed)) {
      rmSync(path, { force: true });
      return null;
    }
    const previous = parsePersistedCapacity(parsed.previous);
    const claimedAt = optionalDate(parsed.claimedAt);
    const expiresAt = optionalDate(parsed.expiresAt);
    if (!previous || !claimedAt || !expiresAt) {
      rmSync(path, { force: true });
      return null;
    }
    return {
      claimId: parsed.claimId,
      recordId: parsed.recordId,
      baseRevision: parsed.baseRevision,
      accountId: parsed.accountId,
      ...(parsed.demand ? { demand: parsed.demand } : { demand: null }),
      ownerId: parsed.ownerId,
      claimedAt,
      expiresAt,
      previous,
    };
  }

  private writeClaim(
    path: string,
    claim: WorkerAccountCapacityRecheckClaim,
  ): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${claim.claimId}.tmp`;
    try {
      writeFileSync(
        tempPath,
        `${JSON.stringify(persistClaim(claim), null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      renameSync(tempPath, path);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  private withRecordLock<T>(recordId: string, action: () => T): T {
    const lockPath = `${recordId}.capacity-lock`;
    const token = randomUUID();
    const deadline = Date.now() + 10_000;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        writeFileSync(
          lockPath,
          `${JSON.stringify({ token, pid: process.pid })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const owner = readRecordLock(lockPath);
        if (owner && !isProcessAlive(owner.pid)) {
          this.recoverRecordLock({
            lockPath,
            identity: `owner:${owner.token}`,
            isCurrent: () => readRecordLock(lockPath)?.token === owner.token,
          });
          continue;
        }
        if (!owner) {
          const invalidIdentity = recoverableInvalidLockIdentity(lockPath);
          if (invalidIdentity) {
            this.recoverRecordLock({
              lockPath,
              identity: `invalid:${invalidIdentity}`,
              isCurrent: () =>
                recoverableInvalidLockIdentity(lockPath) === invalidIdentity,
            });
            continue;
          }
        }
        if (owner && owner.pid === process.pid) {
          throw new Error("worker_account_capacity_record_lock_reentrant");
        }
        if (Date.now() >= deadline) {
          throw new Error("worker_account_capacity_record_lock_timeout");
        }
        sleepSync(5);
      }
    }
    try {
      return action();
    } finally {
      const owner = readRecordLock(lockPath);
      if (owner?.token === token) rmSync(lockPath, { force: true });
    }
  }

  private recoverRecordLock(input: {
    readonly lockPath: string;
    readonly identity: string;
    readonly isCurrent: () => boolean;
  }): void {
    const recoveryPath = `${input.lockPath}.recover-${hashText(input.identity).slice(0, 16)}`;
    const recoveryToken = randomUUID();
    let recoveryOwned = false;
    try {
      writeFileSync(
        recoveryPath,
        `${JSON.stringify({ token: recoveryToken, pid: process.pid })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      recoveryOwned = true;
      if (input.isCurrent()) {
        rmSync(input.lockPath, { force: true });
        this.options.observability?.count(
          WorkerAccountCapacityMetric.LockRecovery,
        );
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const recoveryOwner = readRecordLock(recoveryPath);
      if (recoveryOwner && !isProcessAlive(recoveryOwner.pid)) {
        rmSync(recoveryPath, { force: true });
      }
    } finally {
      if (recoveryOwned) {
        const recoveryOwner = readRecordLock(recoveryPath);
        if (recoveryOwner?.token === recoveryToken) {
          rmSync(recoveryPath, { force: true });
        }
      }
    }
  }

  private recordPath(accountId: string, demand: WorkerRuntimeDemand | null): string {
    const demandKey = workerRuntimeDemandKey(demand);
    const fileName = demandKey ? `${hashText(demandKey)}.json` : "account.json";
    return join(this.accountRecordDir(accountId), fileName);
  }

  private claimPath(recordId: string): string {
    return `${recordId}.recheck-claim.json`;
  }

  private isManagedRecordPath(recordId: string): boolean {
    const rel = relative(resolve(this.options.rootDir), resolve(recordId));
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private accountRecordDir(accountId: string): string {
    return join(this.options.rootDir, "account-capacity-v2", hashText(accountId));
  }

  private legacyRecordPath(accountId: string): string {
    return join(this.options.rootDir, "account-capacity", hashText(accountId));
  }
}

function selectPreferredResolved(
  records: readonly (ResolvedRecord | null)[],
  now: Date,
): ResolvedRecord | null {
  const present = records.filter(
    (record): record is ResolvedRecord => record !== null,
  );
  const active = present.filter(
    (record) =>
      stateFromResolved(record, now).phase ===
      WorkerAccountCapacityPhase.Blocking,
  );
  const candidates = active.length > 0 ? active : present;
  let selected: ResolvedRecord | null = null;
  for (const record of candidates) {
    if (
      !selected ||
      !shouldKeepExistingWorkerAccountCapacity(
        selected.capacity,
        record.capacity,
      )
    ) {
      selected = record;
    }
  }
  return selected;
}

function stateFromResolved(
  resolved: ResolvedRecord,
  now: Date,
): WorkerAccountCapacityState {
  return {
    recordId: resolved.path,
    revision: recordRevision(resolved.record),
    accountId: resolved.record.accountId,
    demand: normalizeWorkerRuntimeDemand(resolved.record.demand),
    capacity: resolved.capacity,
    phase:
      resolved.capacity.cooldownUntil &&
      resolved.capacity.cooldownUntil.getTime() <= now.getTime()
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

function recordRevision(record: PersistedWorkerAccountCapacityRecord): string {
  return record.revision ?? hashText(JSON.stringify(record));
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

function persistClaim(claim: WorkerAccountCapacityRecheckClaim): PersistedClaim {
  return {
    claimId: claim.claimId,
    recordId: claim.recordId,
    baseRevision: claim.baseRevision,
    accountId: claim.accountId,
    ...(claim.demand ? { demand: claim.demand } : {}),
    ownerId: claim.ownerId,
    claimedAt: claim.claimedAt.toISOString(),
    expiresAt: claim.expiresAt.toISOString(),
    previous: persistCapacity(claim.previous),
  };
}

function isPersistedClaim(value: unknown): value is PersistedClaim {
  return isRecord(value) &&
    typeof value.claimId === "string" &&
    typeof value.recordId === "string" &&
    typeof value.baseRevision === "string" &&
    typeof value.accountId === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.claimedAt === "string" &&
    typeof value.expiresAt === "string" &&
    isRecord(value.previous);
}

function persistCapacity(
  capacity: WorkerCapacitySnapshot,
): PersistedWorkerCapacitySnapshot {
  return {
    availability: capacity.availability,
    ...(capacity.reason ? { reason: capacity.reason } : {}),
    ...(capacity.cooldownUntil
      ? { cooldownUntil: capacity.cooldownUntil.toISOString() }
      : {}),
    ...(capacity.lastLimitSignalAt
      ? { lastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
      : {}),
    ...(capacity.details ? { details: capacity.details } : {}),
  };
}

function parsePersistedCapacity(
  value: PersistedWorkerCapacitySnapshot,
): WorkerCapacitySnapshot | null {
  if (!isPersistableWorkerAccountAvailability(value.availability)) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  const cooldownUntil = optionalDate(value.cooldownUntil);
  const lastLimitSignalAt = optionalDate(value.lastLimitSignalAt);
  const details = optionalStringRecord(value.details);
  if (cooldownUntil === false || lastLimitSignalAt === false || details === false) {
    return null;
  }
  return {
    availability: value.availability,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(lastLimitSignalAt ? { lastLimitSignalAt } : {}),
    ...(details ? { details } : {}),
  };
}

function optionalDate(value: string | undefined): Date | false | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : false;
}

function optionalStringRecord(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | false | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string")
    ? value
    : false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readRecordLock(path: string): { readonly token: string; readonly pid: number } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0
    ) {
      return null;
    }
    return { token: value.token, pid: value.pid };
  } catch {
    return null;
  }
}

function recoverableInvalidLockIdentity(path: string): string | null {
  try {
    const stats = statSync(path);
    if (Date.now() - stats.mtimeMs < 1_000) return null;
    const raw = readFileSync(path, "utf8");
    if (readRecordLock(path)) return null;
    return hashText(`${stats.mtimeMs}:${stats.size}:${raw}`);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}
