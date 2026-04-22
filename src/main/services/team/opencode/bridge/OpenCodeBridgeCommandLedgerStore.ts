import {
  createOpenCodeBridgeIdempotencyKey,
  isOpenCodeBridgeCommandName,
  stableHash,
  type OpenCodeBridgeCommandName,
} from './OpenCodeBridgeCommandContract';
import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

export const OPEN_CODE_BRIDGE_COMMAND_LEDGER_SCHEMA_VERSION = 1;
export const OPEN_CODE_BRIDGE_COMMAND_LEASE_SCHEMA_VERSION = 1;

export type OpenCodeBridgeCommandLedgerStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'unknown_after_timeout';

export interface OpenCodeBridgeCommandLedgerEntry {
  idempotencyKey: string;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  teamName: string;
  laneId: string | null;
  runId: string | null;
  requestHash: string;
  responseHash: string | null;
  status: OpenCodeBridgeCommandLedgerStatus;
  retryable: boolean;
  startedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface OpenCodeBridgeCommandLease {
  leaseId: string;
  teamName: string;
  laneId: string | null;
  runId: string | null;
  command: OpenCodeBridgeCommandName;
  holderPeer: 'claude_team';
  acquiredAt: string;
  expiresAt: string;
  state: 'active' | 'released' | 'expired';
}

export type OpenCodeBridgeLedgerBeginResult = 'started' | 'duplicate_same_payload_completed';

export class OpenCodeBridgeCommandLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeBridgeCommandLedgerError';
  }
}

export class OpenCodeBridgeCommandLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeBridgeCommandLeaseError';
  }
}

export class OpenCodeBridgeCommandLedger {
  constructor(
    private readonly store: VersionedJsonStore<OpenCodeBridgeCommandLedgerEntry[]>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async begin(input: {
    idempotencyKey: string;
    requestId: string;
    command: OpenCodeBridgeCommandName;
    teamName: string;
    laneId?: string | null;
    runId: string | null;
    requestHash: string;
  }): Promise<OpenCodeBridgeLedgerBeginResult> {
    let outcome: OpenCodeBridgeLedgerBeginResult = 'started';

    await this.store.updateLocked((entries) => {
      const existing = entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new OpenCodeBridgeCommandLedgerError(
            'OpenCode bridge idempotency key reused with different payload'
          );
        }

        if (existing.status === 'unknown_after_timeout') {
          throw new OpenCodeBridgeCommandLedgerError(
            'OpenCode bridge command outcome must be reconciled before retry'
          );
        }

        if (existing.status === 'started') {
          throw new OpenCodeBridgeCommandLedgerError('OpenCode bridge command already started');
        }

        if (existing.status === 'completed') {
          outcome = 'duplicate_same_payload_completed';
          return entries;
        }

        throw new OpenCodeBridgeCommandLedgerError(
          `OpenCode bridge command cannot be retried from status ${existing.status}`
        );
      }

      const now = this.clock().toISOString();
      return [
        ...entries,
        {
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
          command: input.command,
          teamName: input.teamName,
          laneId: input.laneId ?? null,
          runId: input.runId,
          requestHash: input.requestHash,
          responseHash: null,
          status: 'started',
          retryable: false,
          startedAt: now,
          completedAt: null,
          lastError: null,
        },
      ];
    });

    return outcome;
  }

  async markCompleted(input: {
    idempotencyKey: string;
    response: unknown;
    completedAt?: Date;
  }): Promise<void> {
    await this.updateExisting(input.idempotencyKey, (entry) => ({
      ...entry,
      responseHash: stableHash(input.response),
      status: 'completed',
      retryable: false,
      completedAt: (input.completedAt ?? this.clock()).toISOString(),
      lastError: null,
    }));
  }

  async markFailed(input: {
    idempotencyKey: string;
    error: string;
    retryable: boolean;
    completedAt?: Date;
  }): Promise<void> {
    await this.updateExisting(input.idempotencyKey, (entry) => ({
      ...entry,
      status: 'failed',
      retryable: input.retryable,
      completedAt: (input.completedAt ?? this.clock()).toISOString(),
      lastError: input.error,
    }));
  }

  async markUnknownAfterTimeout(input: { idempotencyKey: string; error: string }): Promise<void> {
    await this.updateExisting(input.idempotencyKey, (entry) => ({
      ...entry,
      status: 'unknown_after_timeout',
      retryable: false,
      completedAt: null,
      lastError: input.error,
    }));
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OpenCodeBridgeCommandLedgerEntry | null> {
    const entries = await this.readRequired();
    return entries.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
  }

  async list(): Promise<OpenCodeBridgeCommandLedgerEntry[]> {
    return this.readRequired();
  }

  private async updateExisting(
    idempotencyKey: string,
    updater: (entry: OpenCodeBridgeCommandLedgerEntry) => OpenCodeBridgeCommandLedgerEntry
  ): Promise<void> {
    let found = false;
    await this.store.updateLocked((entries) =>
      entries.map((entry) => {
        if (entry.idempotencyKey !== idempotencyKey) {
          return entry;
        }
        found = true;
        return updater(entry);
      })
    );

    if (!found) {
      throw new OpenCodeBridgeCommandLedgerError(
        `OpenCode bridge command ledger entry not found: ${idempotencyKey}`
      );
    }
  }

  private async readRequired(): Promise<OpenCodeBridgeCommandLedgerEntry[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data;
  }
}

export class OpenCodeBridgeCommandLeaseStore {
  constructor(
    private readonly store: VersionedJsonStore<OpenCodeBridgeCommandLease[]>,
    private readonly idFactory: () => string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async acquire(input: {
    teamName: string;
    laneId?: string | null;
    runId: string | null;
    command: OpenCodeBridgeCommandName;
    ttlMs: number;
  }): Promise<OpenCodeBridgeCommandLease> {
    let created: OpenCodeBridgeCommandLease | null = null;

    await this.store.updateLocked((leases) => {
      const now = this.clock();
      const nowMs = now.getTime();
      const normalized = leases.map((lease) =>
        lease.state === 'active' && Date.parse(lease.expiresAt) <= nowMs
          ? { ...lease, state: 'expired' as const }
          : lease
      );
      const active = normalized.find(
        (lease) =>
          lease.teamName === input.teamName &&
          lease.laneId === (input.laneId ?? null) &&
          lease.state === 'active' &&
          Date.parse(lease.expiresAt) > nowMs
      );

      if (active) {
        throw new OpenCodeBridgeCommandLeaseError(
          `OpenCode bridge command lease already active: ${active.leaseId}`
        );
      }

      created = {
        leaseId: this.idFactory(),
        teamName: input.teamName,
        laneId: input.laneId ?? null,
        runId: input.runId,
        command: input.command,
        holderPeer: 'claude_team',
        acquiredAt: now.toISOString(),
        expiresAt: new Date(nowMs + input.ttlMs).toISOString(),
        state: 'active',
      };

      return [...normalized, created];
    });

    if (!created) {
      throw new OpenCodeBridgeCommandLeaseError('OpenCode bridge command lease was not created');
    }

    return created;
  }

  async release(leaseId: string): Promise<void> {
    let found = false;
    await this.store.updateLocked((leases) =>
      leases.map((lease) => {
        if (lease.leaseId !== leaseId) {
          return lease;
        }
        found = true;
        return { ...lease, state: 'released' as const };
      })
    );

    if (!found) {
      throw new OpenCodeBridgeCommandLeaseError(
        `OpenCode bridge command lease not found: ${leaseId}`
      );
    }
  }

  async getActive(teamName: string): Promise<OpenCodeBridgeCommandLease | null> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }

    const nowMs = this.clock().getTime();
    return (
      result.data.find(
        (lease) =>
          lease.teamName === teamName &&
          lease.state === 'active' &&
          Date.parse(lease.expiresAt) > nowMs
      ) ?? null
    );
  }
}

export function createOpenCodeBridgeCommandLedgerStore(options: {
  filePath: string;
  clock?: () => Date;
}): OpenCodeBridgeCommandLedger {
  const clock = options.clock ?? (() => new Date());
  return new OpenCodeBridgeCommandLedger(
    new VersionedJsonStore<OpenCodeBridgeCommandLedgerEntry[]>({
      filePath: options.filePath,
      schemaVersion: OPEN_CODE_BRIDGE_COMMAND_LEDGER_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateLedgerEntries,
      clock,
    }),
    clock
  );
}

export function createOpenCodeBridgeCommandLeaseStore(options: {
  filePath: string;
  idFactory?: () => string;
  clock?: () => Date;
}): OpenCodeBridgeCommandLeaseStore {
  const clock = options.clock ?? (() => new Date());
  return new OpenCodeBridgeCommandLeaseStore(
    new VersionedJsonStore<OpenCodeBridgeCommandLease[]>({
      filePath: options.filePath,
      schemaVersion: OPEN_CODE_BRIDGE_COMMAND_LEASE_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateLeases,
      clock,
    }),
    options.idFactory ??
      (() =>
        createOpenCodeBridgeIdempotencyKey({
          command: 'opencode.commandStatus',
          teamName: 'lease',
          runId: null,
          body: { now: clock().toISOString(), random: Math.random() },
        })),
    clock
  );
}

export function validateLedgerEntries(value: unknown): OpenCodeBridgeCommandLedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenCode bridge command ledger must be an array');
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isLedgerEntry(entry)) {
      throw new Error(`Invalid OpenCode bridge command ledger entry at index ${index}`);
    }
    if (seen.has(entry.idempotencyKey)) {
      throw new Error(`Duplicate OpenCode bridge ledger idempotencyKey at index ${index}`);
    }
    seen.add(entry.idempotencyKey);
    return entry;
  });
}

export function validateLeases(value: unknown): OpenCodeBridgeCommandLease[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenCode bridge command leases must be an array');
  }

  const seen = new Set<string>();
  return value.map((lease, index) => {
    if (!isLease(lease)) {
      throw new Error(`Invalid OpenCode bridge command lease at index ${index}`);
    }
    if (seen.has(lease.leaseId)) {
      throw new Error(`Duplicate OpenCode bridge leaseId at index ${index}`);
    }
    seen.add(lease.leaseId);
    return lease;
  });
}

function isLedgerEntry(value: unknown): value is OpenCodeBridgeCommandLedgerEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value.idempotencyKey) &&
    isNonEmptyString(value.requestId) &&
    isOpenCodeBridgeCommandName(value.command) &&
    isNonEmptyString(value.teamName) &&
    isNullableString(value.runId) &&
    isNonEmptyString(value.requestHash) &&
    isNullableString(value.responseHash) &&
    isLedgerStatus(value.status) &&
    typeof value.retryable === 'boolean' &&
    isNonEmptyString(value.startedAt) &&
    isNullableString(value.completedAt) &&
    isNullableString(value.lastError) &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    (value.completedAt === null || Number.isFinite(Date.parse(value.completedAt)))
  );
}

function isLease(value: unknown): value is OpenCodeBridgeCommandLease {
  return (
    isRecord(value) &&
    isNonEmptyString(value.leaseId) &&
    isNonEmptyString(value.teamName) &&
    isNullableString(value.runId) &&
    isOpenCodeBridgeCommandName(value.command) &&
    value.holderPeer === 'claude_team' &&
    isNonEmptyString(value.acquiredAt) &&
    isNonEmptyString(value.expiresAt) &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    (value.state === 'active' || value.state === 'released' || value.state === 'expired')
  );
}

function isLedgerStatus(value: unknown): value is OpenCodeBridgeCommandLedgerStatus {
  return (
    value === 'started' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'unknown_after_timeout'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
