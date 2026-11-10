import { canonicalizeRuntimeIdempotencyKey } from '../../runtime-control/domain/RuntimeIdempotencyKey';
import { stableHash, stableJsonStringify } from '../bridge/OpenCodeBridgeCommandContract';
import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

import type { TaskRef } from '@shared/types/team';

export const RUNTIME_DELIVERY_JOURNAL_SCHEMA_VERSION = 1;
export const RUNTIME_DELIVERY_JOURNAL_MAX_TERMINAL_RECORDS = 512;

export type RuntimeDeliveryJournalStatus =
  | 'pending'
  | 'committed'
  | 'failed_retryable'
  | 'failed_terminal';

export type RuntimeDeliveryDestinationRef =
  | { kind: 'user_sent_messages'; teamName: string }
  | { kind: 'member_inbox'; teamName: string; memberName: string }
  | {
      kind: 'cross_team_outbox';
      fromTeamName: string;
      toTeamName: string;
      toMemberName: string;
    };

export type RuntimeDeliveryLocation =
  | { kind: 'user_sent_messages'; teamName: string; messageId: string }
  | { kind: 'member_inbox'; teamName: string; memberName: string; messageId: string }
  | {
      kind: 'cross_team_outbox';
      fromTeamName: string;
      toTeamName: string;
      toMemberName: string;
      messageId: string;
    };

export interface RuntimeDeliveryJournalRecord {
  idempotencyKey: string;
  runId: string;
  teamName: string;
  fromMemberName: string;
  providerId: 'opencode';
  runtimeSessionId: string;
  payloadHash: string;
  logicalPayloadHash: string | null;
  destination: RuntimeDeliveryDestinationRef;
  destinationMessageId: string;
  committedLocation: RuntimeDeliveryLocation | null;
  status: RuntimeDeliveryJournalStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  lastError: string | null;
}

export interface RuntimeDeliveryCommittedReceipt {
  kind: 'committed_receipt';
  idempotencyKey: string;
  teamName: string;
  logicalPayloadHash: string | null;
  committedLocation: RuntimeDeliveryLocation;
  committedAt: string;
}

type RuntimeDeliveryJournalEntry = RuntimeDeliveryJournalRecord | RuntimeDeliveryCommittedReceipt;

export interface RuntimeDeliveryJournalBeginInput {
  idempotencyKey: string;
  payloadHash: string;
  /** Exact logical hash from before recipient canonicalization; never a legacy transport hash. */
  preCanonicalPayloadHash?: string;
  /** Exact destination represented by preCanonicalPayloadHash. */
  preCanonicalDestination?: RuntimeDeliveryDestinationRef;
  compatiblePayloadHashes?: string[];
  runId: string;
  teamName: string;
  fromMemberName: string;
  providerId: 'opencode';
  runtimeSessionId: string;
  destination: RuntimeDeliveryDestinationRef;
  destinationMessageId: string;
  now: string;
}

export interface RuntimeDeliveryJournalKeyInput {
  idempotencyKey: string;
  runId: string;
  teamName: string;
}

export type RuntimeDeliveryJournalBeginResult = (
  | { state: 'new'; record: RuntimeDeliveryJournalRecord }
  | { state: 'already_committed'; record: RuntimeDeliveryJournalRecord }
  | { state: 'resume_pending'; record: RuntimeDeliveryJournalRecord }
  | { state: 'payload_conflict'; record: RuntimeDeliveryJournalRecord }
) & {
  recoveryRecords?: RuntimeDeliveryJournalRecord[];
  /** Old rows that must be proven at their persisted destination before canonical migration. */
  preCanonicalRecoveryRecords?: RuntimeDeliveryJournalRecord[];
};

export interface RuntimeDeliveryCanonicalRecoveryMigration {
  recoveryRecords: RuntimeDeliveryJournalRecord[];
  fromMemberName: string;
  payloadHash: string;
  destination: RuntimeDeliveryDestinationRef;
  destinationMessageId: string;
}

export class RuntimeDeliveryJournalCommitRevalidationError extends Error {
  constructor() {
    super('Runtime delivery destination changed during journal commit; journal is not committed');
    this.name = 'RuntimeDeliveryJournalCommitRevalidationError';
  }
}

export interface RuntimeDeliveryJournalCommit {
  /**
   * Compare-and-restore only the exact entries changed by this commit. Callers use this only when a
   * destination postcheck invalidates the proof that authorized the commit.
   */
  rollback(): Promise<void>;
}

interface RuntimeDeliveryJournalRollbackEntry {
  identity: string;
  previous: RuntimeDeliveryJournalEntry | null;
  committed: RuntimeDeliveryJournalEntry | null;
  previousIndex: number;
}

export class RuntimeDeliveryJournalStore {
  constructor(
    private readonly store: VersionedJsonStore<RuntimeDeliveryJournalEntry[]>,
    private readonly maxTerminalRecords = RUNTIME_DELIVERY_JOURNAL_MAX_TERMINAL_RECORDS
  ) {}

  async begin(input: RuntimeDeliveryJournalBeginInput): Promise<RuntimeDeliveryJournalBeginResult> {
    const canonicalInput: RuntimeDeliveryJournalBeginInput = {
      ...canonicalizeRuntimeDeliveryJournalInput(input),
      fromMemberName: input.fromMemberName.trim(),
      runtimeSessionId: input.runtimeSessionId.trim(),
      destination: normalizeRuntimeDeliveryDestinationRef(input.destination),
      ...(input.preCanonicalDestination
        ? {
            preCanonicalDestination: normalizeRuntimeDeliveryDestinationRef(
              input.preCanonicalDestination
            ),
          }
        : {}),
    };
    let result: RuntimeDeliveryJournalBeginResult | null = null;
    await this.store.updateLocked((entries) => {
      const records = entries.filter(isRuntimeDeliveryJournalRecord);
      const committedReceipt = entries.find(
        (entry): entry is RuntimeDeliveryCommittedReceipt =>
          isRuntimeDeliveryCommittedReceipt(entry) &&
          matchesRuntimeDeliveryLogicalKey(entry, canonicalInput)
      );
      if (
        committedReceipt &&
        committedReceipt.logicalPayloadHash !== null &&
        matchesRuntimeDeliveryLogicalPayloadHash(
          committedReceipt.logicalPayloadHash,
          canonicalInput
        )
      ) {
        const committedRecord = buildRuntimeDeliveryRecordFromReceipt(
          canonicalInput,
          committedReceipt
        );
        result = { state: 'already_committed', record: committedRecord };
        return pruneRuntimeDeliveryJournalEntries(entries, this.maxTerminalRecords);
      }

      const logicalKeyRecords = records.filter((record) =>
        matchesRuntimeDeliveryLogicalKey(record, canonicalInput)
      );
      const preCanonicalRecoveryRecords = logicalKeyRecords.filter(
        (record) =>
          classifyRuntimeDeliveryPayload(record, canonicalInput) === 'pre_canonical' &&
          canRecoverPreCanonicalRuntimeDelivery(record, canonicalInput)
      );
      if (
        committedReceipt &&
        !preCanonicalRecoveryRecords.some((record) => record.status === 'committed')
      ) {
        result = {
          state: 'payload_conflict',
          record: buildRuntimeDeliveryRecordFromReceipt(canonicalInput, committedReceipt),
        };
        return pruneRuntimeDeliveryJournalEntries(entries, this.maxTerminalRecords);
      }
      const conflictingRecord = logicalKeyRecords.find(
        (record) => classifyRuntimeDeliveryPayload(record, canonicalInput) === 'conflict'
      );
      if (conflictingRecord) {
        result = { state: 'payload_conflict', record: conflictingRecord };
        return pruneRuntimeDeliveryJournalEntries(entries, this.maxTerminalRecords);
      }

      const recoveryRecords = logicalKeyRecords.filter(
        (record) =>
          classifyRuntimeDeliveryPayload(record, canonicalInput) === 'canonical' &&
          canCarryRuntimeDeliveryAcrossRuns(record, canonicalInput)
      );
      const existing = records.find((record) =>
        matchesRuntimeDeliveryJournalKey(record, canonicalInput)
      );
      if (existing) {
        if (existing.status === 'committed') {
          if (preCanonicalRecoveryRecords.includes(existing)) {
            result = {
              state: 'resume_pending',
              record: existing,
              preCanonicalRecoveryRecords,
            };
            return pruneRuntimeDeliveryJournalEntries(entries, this.maxTerminalRecords);
          }
          result = { state: 'already_committed', record: existing };
          return pruneRuntimeDeliveryJournalEntries(entries, this.maxTerminalRecords);
        }

        const isPreCanonicalExisting = preCanonicalRecoveryRecords.includes(existing);
        const resumed = {
          ...existing,
          ...(!isPreCanonicalExisting
            ? {
                payloadHash: canonicalInput.payloadHash,
                logicalPayloadHash: canonicalInput.payloadHash,
              }
            : {}),
          attempts: existing.attempts + 1,
          status: existing.status === 'failed_terminal' ? existing.status : 'pending',
          updatedAt: canonicalInput.now,
        } satisfies RuntimeDeliveryJournalRecord;
        const resumedPreCanonicalRecoveryRecords = preCanonicalRecoveryRecords.map((record) =>
          record === existing ? resumed : record
        );
        result = {
          state: 'resume_pending',
          record: resumed,
          ...(recoveryRecords.length > 0 ? { recoveryRecords } : {}),
          ...(resumedPreCanonicalRecoveryRecords.length > 0
            ? { preCanonicalRecoveryRecords: resumedPreCanonicalRecoveryRecords }
            : {}),
        };
        return pruneRuntimeDeliveryJournalEntries(
          entries.map((entry) =>
            isRuntimeDeliveryJournalRecord(entry) &&
            matchesRuntimeDeliveryJournalKey(entry, canonicalInput)
              ? resumed
              : entry
          ),
          this.maxTerminalRecords
        );
      }

      const created: RuntimeDeliveryJournalRecord = {
        idempotencyKey: canonicalInput.idempotencyKey,
        runId: canonicalInput.runId,
        teamName: canonicalInput.teamName,
        fromMemberName: canonicalInput.fromMemberName,
        providerId: canonicalInput.providerId,
        runtimeSessionId: canonicalInput.runtimeSessionId,
        payloadHash: canonicalInput.payloadHash,
        logicalPayloadHash: canonicalInput.payloadHash,
        destination: canonicalInput.destination,
        destinationMessageId:
          recoveryRecords[0]?.destinationMessageId ?? canonicalInput.destinationMessageId,
        committedLocation: null,
        status: 'pending',
        attempts: 1,
        createdAt: canonicalInput.now,
        updatedAt: canonicalInput.now,
        committedAt: null,
        lastError: null,
      };
      result = {
        state: 'new',
        record: created,
        ...(recoveryRecords.length > 0 ? { recoveryRecords } : {}),
        ...(preCanonicalRecoveryRecords.length > 0 ? { preCanonicalRecoveryRecords } : {}),
      };
      return pruneRuntimeDeliveryJournalEntries([...entries, created], this.maxTerminalRecords);
    });

    if (!result) {
      throw new Error('Runtime delivery journal begin failed');
    }
    return result;
  }

  async markCommitted(input: {
    idempotencyKey: string;
    runId: string;
    teamName: string;
    location: RuntimeDeliveryLocation;
    committedAt: string;
    canonicalRecoveryMigration?: RuntimeDeliveryCanonicalRecoveryMigration;
  }): Promise<RuntimeDeliveryJournalCommit> {
    const canonicalInput = canonicalizeRuntimeDeliveryJournalInput(input);
    let found = false;
    let migrationFound = !canonicalInput.canonicalRecoveryMigration;
    let rollbackEntries: RuntimeDeliveryJournalRollbackEntry[] | null = null;
    await this.store.updateLocked((entries) => {
      const records = entries.filter(isRuntimeDeliveryJournalRecord);
      const current = records.find((record) =>
        matchesRuntimeDeliveryJournalKey(record, canonicalInput)
      );
      if (!current) {
        return entries;
      }
      found = true;
      const migration = canonicalInput.canonicalRecoveryMigration;
      const persistedMigrationRecords = migration
        ? migration.recoveryRecords.map((candidate) =>
            records.find((record) => matchesExactRuntimeDeliveryRecoveryRecord(record, candidate))
          )
        : [];
      if (migration && persistedMigrationRecords.some((record) => !record)) {
        return entries;
      }
      migrationFound = true;
      const canonicalCurrent = migration
        ? ({
            ...current,
            fromMemberName: migration.fromMemberName.trim(),
            payloadHash: migration.payloadHash,
            logicalPayloadHash: migration.payloadHash,
            destination: normalizeRuntimeDeliveryDestinationRef(migration.destination),
            destinationMessageId: migration.destinationMessageId.trim(),
          } satisfies RuntimeDeliveryJournalRecord)
        : current;
      const migrationRecords = new Set(
        persistedMigrationRecords.filter(
          (record): record is RuntimeDeliveryJournalRecord => record !== undefined
        )
      );
      const committed = entries.flatMap((entry): RuntimeDeliveryJournalEntry[] => {
        if (!isRuntimeDeliveryJournalRecord(entry)) {
          return [entry];
        }
        if (migration && migrationRecords.has(entry) && entry !== current) {
          return [];
        }
        if (
          matchesRuntimeDeliveryJournalKey(entry, canonicalInput) ||
          (!migration && belongsToRuntimeDeliveryRecoveryLineage(entry, current))
        ) {
          return [
            {
              ...(entry === current ? canonicalCurrent : entry),
              committedLocation: canonicalInput.location,
              status: 'committed' as const,
              updatedAt: canonicalInput.committedAt,
              committedAt: canonicalInput.committedAt,
              lastError: null,
            } satisfies RuntimeDeliveryJournalRecord,
          ];
        }
        return [entry];
      });
      const entriesForReceipt = migration
        ? committed.filter(
            (entry) =>
              !isRuntimeDeliveryCommittedReceipt(entry) ||
              !matchesRuntimeDeliveryLogicalKey(entry, canonicalCurrent)
          )
        : committed;
      const withReceipt = upsertRuntimeDeliveryCommittedReceipt(
        entriesForReceipt,
        createRuntimeDeliveryCommittedReceipt(
          canonicalCurrent,
          canonicalInput.location,
          canonicalInput.committedAt
        )
      );
      const nextEntries = pruneRuntimeDeliveryJournalEntries(withReceipt, this.maxTerminalRecords);
      rollbackEntries = buildRuntimeDeliveryJournalRollbackEntries(
        entries,
        nextEntries,
        canonicalInput
      );
      return nextEntries;
    });

    if (!found) {
      throwRuntimeDeliveryJournalRecordNotFound(canonicalInput);
    }
    if (!migrationFound) {
      throw new Error('Runtime delivery canonical recovery record changed before commit');
    }
    if (!rollbackEntries) {
      throw new Error('Runtime delivery journal commit snapshot missing');
    }

    const commitRollbackEntries = rollbackEntries;
    let rolledBack = false;
    return {
      rollback: async () => {
        if (rolledBack) {
          return;
        }
        await this.store.updateLocked((entries) => {
          rolledBack = true;
          return rollbackRuntimeDeliveryJournalEntries(entries, commitRollbackEntries);
        });
      },
    };
  }

  async markFailed(input: {
    idempotencyKey: string;
    runId: string;
    teamName: string;
    status: 'failed_retryable' | 'failed_terminal';
    error: string;
    updatedAt: string;
  }): Promise<void> {
    const canonicalInput = canonicalizeRuntimeDeliveryJournalInput(input);
    await this.updateExisting(canonicalInput, (record) =>
      record.status === 'committed'
        ? record
        : {
            ...record,
            status: canonicalInput.status,
            updatedAt: canonicalInput.updatedAt,
            lastError: canonicalInput.error,
          }
    );
  }

  async get(input: RuntimeDeliveryJournalKeyInput): Promise<RuntimeDeliveryJournalRecord | null> {
    const canonicalInput = canonicalizeRuntimeDeliveryJournalInput(input);
    const records = await this.readRequired();
    return (
      records.find((record) => matchesRuntimeDeliveryJournalKey(record, canonicalInput)) ?? null
    );
  }

  async listRecoverable(teamName: string): Promise<RuntimeDeliveryJournalRecord[]> {
    const records = await this.readRequired();
    return records.filter(
      (record) =>
        record.teamName === teamName &&
        (record.status === 'pending' || record.status === 'failed_retryable')
    );
  }

  async findCommittedByRuntimeSession(input: {
    teamName: string;
    runId: string;
    runtimeSessionId: string;
  }): Promise<Map<string, RuntimeDeliveryJournalRecord>> {
    const records = await this.readRequired();
    return new Map(
      records
        .filter(
          (record) =>
            record.teamName === input.teamName &&
            record.runId === input.runId &&
            record.runtimeSessionId === input.runtimeSessionId &&
            record.status === 'committed'
        )
        .map((record) => [record.idempotencyKey, record])
    );
  }

  async list(): Promise<RuntimeDeliveryJournalRecord[]> {
    return this.readRequired();
  }

  private async updateExisting(
    input: RuntimeDeliveryJournalKeyInput,
    updater: (record: RuntimeDeliveryJournalRecord) => RuntimeDeliveryJournalRecord
  ): Promise<void> {
    let found = false;
    await this.store.updateLocked((entries) => {
      const updated = entries.map((entry) => {
        if (
          !isRuntimeDeliveryJournalRecord(entry) ||
          !matchesRuntimeDeliveryJournalKey(entry, input)
        ) {
          return entry;
        }
        found = true;
        return updater(entry);
      });
      return pruneRuntimeDeliveryJournalEntries(updated, this.maxTerminalRecords);
    });

    if (!found) {
      throwRuntimeDeliveryJournalRecordNotFound(input);
    }
  }

  private async readRequired(): Promise<RuntimeDeliveryJournalRecord[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data.filter(isRuntimeDeliveryJournalRecord);
  }
}

function matchesRuntimeDeliveryLogicalKey(
  record: Pick<RuntimeDeliveryJournalRecord, 'idempotencyKey' | 'teamName'>,
  input: Pick<RuntimeDeliveryJournalKeyInput, 'idempotencyKey' | 'teamName'>
): boolean {
  return record.idempotencyKey === input.idempotencyKey && record.teamName === input.teamName;
}

function buildRuntimeDeliveryJournalRollbackEntries(
  previousEntries: RuntimeDeliveryJournalEntry[],
  committedEntries: RuntimeDeliveryJournalEntry[],
  input: RuntimeDeliveryJournalKeyInput
): RuntimeDeliveryJournalRollbackEntry[] {
  const previousByIdentity = new Map(
    previousEntries.map((entry, index) => [
      buildRuntimeDeliveryJournalEntryIdentity(entry),
      { entry, index },
    ])
  );
  const committedByIdentity = new Map(
    committedEntries.map((entry) => [buildRuntimeDeliveryJournalEntryIdentity(entry), entry])
  );
  const lineageIdentities = new Set(
    [...previousEntries, ...committedEntries]
      .filter((entry) => matchesRuntimeDeliveryLogicalKey(entry, input))
      .map(buildRuntimeDeliveryJournalEntryIdentity)
  );

  return [...lineageIdentities]
    .map((identity): RuntimeDeliveryJournalRollbackEntry | null => {
      const previous = previousByIdentity.get(identity);
      const committed = committedByIdentity.get(identity) ?? null;
      if (hasSameRuntimeDeliveryJournalEntry(previous?.entry ?? null, committed)) {
        return null;
      }
      return {
        identity,
        previous: previous?.entry ?? null,
        committed,
        previousIndex: previous?.index ?? previousEntries.length,
      };
    })
    .filter((entry): entry is RuntimeDeliveryJournalRollbackEntry => entry !== null);
}

function rollbackRuntimeDeliveryJournalEntries(
  entries: RuntimeDeliveryJournalEntry[],
  rollbackEntries: RuntimeDeliveryJournalRollbackEntry[]
): RuntimeDeliveryJournalEntry[] {
  const rollbackByIdentity = new Map(rollbackEntries.map((entry) => [entry.identity, entry]));
  const restoredIdentities = new Set<string>();
  const restored = entries.flatMap((entry): RuntimeDeliveryJournalEntry[] => {
    const identity = buildRuntimeDeliveryJournalEntryIdentity(entry);
    const rollback = rollbackByIdentity.get(identity);
    if (!rollback || !hasSameRuntimeDeliveryJournalEntry(entry, rollback.committed)) {
      return [entry];
    }
    restoredIdentities.add(identity);
    return rollback.previous ? [rollback.previous] : [];
  });

  const missingPreviousEntries = rollbackEntries
    .filter(
      (rollback) =>
        rollback.previous !== null &&
        rollback.committed === null &&
        !restoredIdentities.has(rollback.identity) &&
        !restored.some(
          (entry) => buildRuntimeDeliveryJournalEntryIdentity(entry) === rollback.identity
        )
    )
    .toSorted((left, right) => left.previousIndex - right.previousIndex);
  for (const rollback of missingPreviousEntries) {
    restored.splice(Math.min(rollback.previousIndex, restored.length), 0, rollback.previous!);
  }
  return restored;
}

function buildRuntimeDeliveryJournalEntryIdentity(entry: RuntimeDeliveryJournalEntry): string {
  return isRuntimeDeliveryCommittedReceipt(entry)
    ? stableJsonStringify(['receipt', entry.teamName, entry.idempotencyKey])
    : stableJsonStringify(['record', entry.teamName, entry.runId, entry.idempotencyKey]);
}

function hasSameRuntimeDeliveryJournalEntry(
  left: RuntimeDeliveryJournalEntry | null,
  right: RuntimeDeliveryJournalEntry | null
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

type RuntimeDeliveryPayloadCompatibility = 'canonical' | 'pre_canonical' | 'conflict';

function classifyRuntimeDeliveryPayload(
  record: RuntimeDeliveryJournalRecord,
  input: RuntimeDeliveryJournalBeginInput
): RuntimeDeliveryPayloadCompatibility {
  if (record.logicalPayloadHash !== null) {
    if (record.logicalPayloadHash === input.payloadHash) {
      if (matchesRuntimeDeliveryDestination(record.destination, input.destination)) {
        return 'canonical';
      }
      if (
        input.preCanonicalDestination !== undefined &&
        matchesRuntimeDeliveryDestination(record.destination, input.preCanonicalDestination)
      ) {
        return 'pre_canonical';
      }
      return 'conflict';
    }
    if (
      record.logicalPayloadHash === input.preCanonicalPayloadHash &&
      input.preCanonicalDestination !== undefined &&
      matchesRuntimeDeliveryDestination(record.destination, input.preCanonicalDestination)
    ) {
      return 'pre_canonical';
    }
    if (isRecoverableRuntimeDeliverySenderAlias(record, input)) {
      return 'pre_canonical';
    }
    return 'conflict';
  }
  if (record.status === 'committed') {
    return 'conflict';
  }
  return (record.payloadHash === input.payloadHash ||
    input.compatiblePayloadHashes?.includes(record.payloadHash) === true) &&
    matchesRuntimeDeliveryDestination(record.destination, input.destination)
    ? 'canonical'
    : 'conflict';
}

function canRecoverPreCanonicalRuntimeDelivery(
  record: RuntimeDeliveryJournalRecord,
  input: RuntimeDeliveryJournalBeginInput
): boolean {
  if (isRecoverableRuntimeDeliverySenderAlias(record, input)) {
    return true;
  }
  return (
    record.teamName === input.teamName &&
    record.idempotencyKey === input.idempotencyKey &&
    input.preCanonicalDestination !== undefined &&
    matchesRuntimeDeliveryDestination(record.destination, input.preCanonicalDestination)
  );
}

function isRecoverableRuntimeDeliverySenderAlias(
  record: RuntimeDeliveryJournalRecord,
  input: RuntimeDeliveryJournalBeginInput
): boolean {
  const persistedSender = record.fromMemberName.trim();
  const canonicalSender = input.fromMemberName.trim();
  const persistedDestination = record.destination;
  if (
    record.logicalPayloadHash === null ||
    !persistedSender ||
    persistedSender === canonicalSender ||
    persistedSender.toLowerCase() !== canonicalSender.toLowerCase()
  ) {
    return false;
  }

  return (
    matchesRuntimeDeliveryDestination(persistedDestination, input.destination) ||
    (input.preCanonicalDestination !== undefined &&
      matchesRuntimeDeliveryDestination(persistedDestination, input.preCanonicalDestination))
  );
}

function matchesExactRuntimeDeliveryRecoveryRecord(
  record: RuntimeDeliveryJournalRecord,
  candidate: RuntimeDeliveryJournalRecord
): boolean {
  return (
    matchesRuntimeDeliveryJournalKey(record, candidate) &&
    record.fromMemberName === candidate.fromMemberName &&
    record.payloadHash === candidate.payloadHash &&
    record.logicalPayloadHash === candidate.logicalPayloadHash &&
    record.destinationMessageId === candidate.destinationMessageId &&
    matchesRuntimeDeliveryDestination(record.destination, candidate.destination)
  );
}

function matchesRuntimeDeliveryLogicalPayloadHash(
  logicalPayloadHash: string,
  input: RuntimeDeliveryJournalBeginInput
): boolean {
  return (
    logicalPayloadHash === input.payloadHash || logicalPayloadHash === input.preCanonicalPayloadHash
  );
}

function matchesRuntimeDeliveryJournalKey(
  record: RuntimeDeliveryJournalRecord,
  input: RuntimeDeliveryJournalKeyInput
): boolean {
  return (
    record.idempotencyKey === input.idempotencyKey &&
    record.runId === input.runId &&
    record.teamName === input.teamName
  );
}

function canCarryRuntimeDeliveryAcrossRuns(
  record: RuntimeDeliveryJournalRecord,
  input: RuntimeDeliveryJournalBeginInput
): boolean {
  return (
    record.teamName === input.teamName &&
    record.runId !== input.runId &&
    record.idempotencyKey === input.idempotencyKey &&
    (record.status === 'pending' ||
      record.status === 'failed_retryable' ||
      record.status === 'failed_terminal') &&
    matchesRuntimeDeliveryDestination(record.destination, input.destination)
  );
}

function belongsToRuntimeDeliveryRecoveryLineage(
  record: RuntimeDeliveryJournalRecord,
  current: RuntimeDeliveryJournalRecord
): boolean {
  return (
    record.teamName === current.teamName &&
    record.runId !== current.runId &&
    record.idempotencyKey === current.idempotencyKey &&
    (record.status === 'pending' ||
      record.status === 'failed_retryable' ||
      record.status === 'failed_terminal') &&
    matchesRuntimeDeliveryDestination(record.destination, current.destination)
  );
}

function matchesRuntimeDeliveryDestination(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName &&
    left.toMemberName === right.toMemberName
  );
}

function pruneRuntimeDeliveryJournalEntries(
  entries: RuntimeDeliveryJournalEntry[],
  maxTerminalRecords: number
): RuntimeDeliveryJournalEntry[] {
  const terminalRecords = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      (candidate): candidate is { entry: RuntimeDeliveryJournalRecord; index: number } =>
        isRuntimeDeliveryJournalRecord(candidate.entry) &&
        isPrunableRuntimeDeliveryJournalRecord(candidate.entry)
    );
  if (terminalRecords.length <= maxTerminalRecords) {
    return entries;
  }

  const newestTerminal = terminalRecords
    .toSorted(compareRuntimeDeliveryJournalRecency)
    .slice(0, maxTerminalRecords);
  const retainedIndexes = new Set(newestTerminal.map(({ index }) => index));

  return entries.filter(
    (entry, index) =>
      !isRuntimeDeliveryJournalRecord(entry) ||
      !isPrunableRuntimeDeliveryJournalRecord(entry) ||
      retainedIndexes.has(index)
  );
}

function isPrunableRuntimeDeliveryJournalRecord(record: RuntimeDeliveryJournalRecord): boolean {
  // Pending and retryable records are the durable proof source for process-relaunch recovery.
  return record.status === 'committed' || record.status === 'failed_terminal';
}

function compareRuntimeDeliveryJournalRecency(
  left: { entry: RuntimeDeliveryJournalRecord; index: number },
  right: { entry: RuntimeDeliveryJournalRecord; index: number }
): number {
  const timestampDifference =
    getRuntimeDeliveryJournalTimestamp(right.entry) -
    getRuntimeDeliveryJournalTimestamp(left.entry);
  return timestampDifference || right.index - left.index;
}

function getRuntimeDeliveryJournalTimestamp(record: RuntimeDeliveryJournalRecord): number {
  const updatedAt = Date.parse(record.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function createRuntimeDeliveryCommittedReceipt(
  record: RuntimeDeliveryJournalRecord,
  committedLocation: RuntimeDeliveryLocation,
  committedAt: string
): RuntimeDeliveryCommittedReceipt {
  return {
    kind: 'committed_receipt',
    idempotencyKey: record.idempotencyKey,
    teamName: record.teamName,
    logicalPayloadHash: record.logicalPayloadHash,
    committedLocation,
    committedAt,
  };
}

function upsertRuntimeDeliveryCommittedReceipt(
  entries: RuntimeDeliveryJournalEntry[],
  receipt: RuntimeDeliveryCommittedReceipt
): RuntimeDeliveryJournalEntry[] {
  const existingIndex = entries.findIndex(
    (entry) =>
      isRuntimeDeliveryCommittedReceipt(entry) && matchesRuntimeDeliveryLogicalKey(entry, receipt)
  );
  if (existingIndex < 0) {
    return [...entries, receipt];
  }

  const existing = entries[existingIndex] as RuntimeDeliveryCommittedReceipt;
  const merged = mergeRuntimeDeliveryCommittedReceipts(existing, receipt);
  return entries.map((entry, index) => (index === existingIndex ? merged : entry));
}

function mergeRuntimeDeliveryCommittedReceipts(
  existing: RuntimeDeliveryCommittedReceipt,
  candidate: RuntimeDeliveryCommittedReceipt
): RuntimeDeliveryCommittedReceipt {
  const existingCommittedAt = Date.parse(existing.committedAt);
  const candidateCommittedAt = Date.parse(candidate.committedAt);
  const original =
    Number.isFinite(candidateCommittedAt) &&
    (!Number.isFinite(existingCommittedAt) || candidateCommittedAt < existingCommittedAt)
      ? candidate
      : existing;
  return {
    ...original,
    logicalPayloadHash:
      existing.logicalPayloadHash !== null &&
      existing.logicalPayloadHash === candidate.logicalPayloadHash
        ? existing.logicalPayloadHash
        : null,
  };
}

function buildRuntimeDeliveryRecordFromReceipt(
  input: RuntimeDeliveryJournalBeginInput,
  receipt: RuntimeDeliveryCommittedReceipt
): RuntimeDeliveryJournalRecord {
  return {
    idempotencyKey: receipt.idempotencyKey,
    runId: input.runId,
    teamName: receipt.teamName,
    fromMemberName: input.fromMemberName,
    providerId: input.providerId,
    runtimeSessionId: input.runtimeSessionId,
    payloadHash: receipt.logicalPayloadHash ?? 'untrusted:legacy-committed-payload',
    logicalPayloadHash: receipt.logicalPayloadHash,
    destination: input.destination,
    destinationMessageId: receipt.committedLocation.messageId,
    committedLocation: receipt.committedLocation,
    status: 'committed',
    attempts: 1,
    createdAt: receipt.committedAt,
    updatedAt: receipt.committedAt,
    committedAt: receipt.committedAt,
    lastError: null,
  };
}

function throwRuntimeDeliveryJournalRecordNotFound(input: RuntimeDeliveryJournalKeyInput): never {
  throw new Error(
    `Runtime delivery journal record not found: ${input.teamName}/${input.runId}/${input.idempotencyKey}`
  );
}

export function createRuntimeDeliveryJournalStore(options: {
  filePath: string;
  clock?: () => Date;
  maxTerminalRecords?: number;
}): RuntimeDeliveryJournalStore {
  const clock = options.clock ?? (() => new Date());
  const maxTerminalRecords =
    options.maxTerminalRecords ?? RUNTIME_DELIVERY_JOURNAL_MAX_TERMINAL_RECORDS;
  if (!Number.isInteger(maxTerminalRecords) || maxTerminalRecords < 1) {
    throw new Error('Runtime delivery journal maxTerminalRecords must be a positive integer');
  }
  return new RuntimeDeliveryJournalStore(
    new VersionedJsonStore<RuntimeDeliveryJournalEntry[]>({
      filePath: options.filePath,
      schemaVersion: RUNTIME_DELIVERY_JOURNAL_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimeDeliveryJournalEntries,
      clock,
    }),
    maxTerminalRecords
  );
}

export function validateRuntimeDeliveryJournalRecords(
  value: unknown
): RuntimeDeliveryJournalRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('Runtime delivery journal must be an array');
  }
  const seen = new Set<string>();
  return value.map((record, index) => {
    const normalizedRecord = normalizeRuntimeDeliveryJournalRecord(record);
    if (!normalizedRecord) {
      throw new Error(`Invalid runtime delivery journal record at index ${index}`);
    }
    const key = buildRuntimeDeliveryJournalKey(normalizedRecord);
    if (seen.has(key)) {
      throw new Error(
        `Duplicate runtime delivery idempotency key for run: ${normalizedRecord.teamName}/${normalizedRecord.runId}/${normalizedRecord.idempotencyKey}`
      );
    }
    seen.add(key);
    return normalizedRecord;
  });
}

function validateRuntimeDeliveryJournalEntries(value: unknown): RuntimeDeliveryJournalEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Runtime delivery journal must be an array');
  }

  const records: RuntimeDeliveryJournalRecord[] = [];
  const receipts: RuntimeDeliveryCommittedReceipt[] = [];
  for (const [index, entry] of value.entries()) {
    const record = normalizeRuntimeDeliveryJournalRecord(entry);
    if (record) {
      records.push(record);
      continue;
    }
    const receipt = normalizeRuntimeDeliveryCommittedReceipt(entry);
    if (receipt) {
      receipts.push(receipt);
      continue;
    }
    throw new Error(`Invalid runtime delivery journal entry at index ${index}`);
  }

  validateRuntimeDeliveryJournalRecords(records);
  let entries: RuntimeDeliveryJournalEntry[] = [...records];
  for (const receipt of receipts) {
    entries = upsertRuntimeDeliveryCommittedReceipt(entries, receipt);
  }
  for (const record of records) {
    if (record.status !== 'committed') {
      continue;
    }
    entries = upsertRuntimeDeliveryCommittedReceipt(
      entries,
      createRuntimeDeliveryCommittedReceipt(
        record,
        buildLocationFromJournal(record),
        record.committedAt ?? record.updatedAt
      )
    );
  }
  return entries;
}

function buildRuntimeDeliveryJournalKey(record: RuntimeDeliveryJournalRecord): string {
  return `${record.teamName}\u0000${record.runId}\u0000${record.idempotencyKey}`;
}

export function hashRuntimeDeliveryEnvelope(envelope: RuntimeDeliveryEnvelope): string {
  return `sha256:${stableHash({
    destination: resolveRuntimeDeliveryDestinationForHash(envelope),
    sender: envelope.fromMemberName.trim(),
    content: envelope.text,
    summary: envelope.summary ?? null,
    taskRefs: normalizeRuntimeDeliveryTaskRefs(envelope.taskRefs) ?? [],
    createdAt: requireRuntimeDeliveryIso(envelope.createdAt, 'createdAt'),
  })}`;
}

function resolveRuntimeDeliveryDestinationForHash(
  envelope: RuntimeDeliveryEnvelope
): RuntimeDeliveryDestinationRef {
  return resolveRuntimeDeliveryDestination({
    ...envelope,
    teamName: envelope.teamName.trim(),
    to: normalizeRuntimeDeliveryTarget(envelope.to),
  });
}

export function hashRuntimeDeliveryEnvelopeLegacyTransport(
  envelope: RuntimeDeliveryEnvelope
): string {
  return hashRuntimeDeliveryTransportEnvelopeWithTaskRefs(envelope, envelope.taskRefs ?? []);
}

export function hashRuntimeDeliveryEnvelopeLegacyTaskRefs(
  envelope: RuntimeDeliveryEnvelope
): string | null {
  if (!envelope.taskRefs?.length) {
    return null;
  }
  return hashRuntimeDeliveryTransportEnvelopeWithTaskRefs(
    envelope,
    envelope.taskRefs.map((taskRef) => taskRef.taskId)
  );
}

function hashRuntimeDeliveryTransportEnvelopeWithTaskRefs(
  envelope: RuntimeDeliveryEnvelope,
  taskRefs: unknown[]
): string {
  return `sha256:${stableHash({
    providerId: envelope.providerId,
    runId: envelope.runId,
    teamName: envelope.teamName,
    fromMemberName: envelope.fromMemberName,
    runtimeSessionId: envelope.runtimeSessionId,
    to: envelope.to,
    text: envelope.text,
    summary: envelope.summary ?? null,
    taskRefs,
    createdAt: envelope.createdAt,
  })}`;
}

export function buildRuntimeDestinationMessageId(envelope: RuntimeDeliveryEnvelope): string {
  return `runtime-delivery-${stableHash({
    idempotencyKey: canonicalizeRuntimeIdempotencyKey(envelope.idempotencyKey, {
      errorPrefix: 'Runtime delivery envelope',
    }),
    runId: envelope.runId.trim(),
    teamName: envelope.teamName.trim(),
  }).slice(0, 32)}`;
}

export type RuntimeDeliveryTarget =
  | 'user'
  | { memberName: string }
  | { teamName: string; memberName: string };

export interface RuntimeDeliveryEnvelope {
  idempotencyKey: string;
  runId: string;
  teamName: string;
  fromMemberName: string;
  providerId: 'opencode';
  runtimeSessionId: string;
  to: RuntimeDeliveryTarget;
  text: string;
  createdAt: string;
  summary?: string | null;
  taskRefs?: TaskRef[];
}

export function normalizeRuntimeDeliveryEnvelope(value: unknown): RuntimeDeliveryEnvelope {
  if (!isRecord(value)) {
    throw new Error('Runtime delivery envelope must be an object');
  }

  const taskRefs = normalizeRuntimeDeliveryTaskRefs(value.taskRefs);
  const envelope: RuntimeDeliveryEnvelope = {
    idempotencyKey: canonicalizeRuntimeIdempotencyKey(value.idempotencyKey, {
      errorPrefix: 'Runtime delivery envelope',
    }),
    runId: requireTrimmedNonEmptyString(value.runId, 'runId'),
    teamName: requireTrimmedNonEmptyString(value.teamName, 'teamName'),
    fromMemberName: requireTrimmedNonEmptyString(value.fromMemberName, 'fromMemberName'),
    providerId: value.providerId === 'opencode' ? 'opencode' : fail('providerId must be opencode'),
    runtimeSessionId: requireTrimmedNonEmptyString(value.runtimeSessionId, 'runtimeSessionId'),
    to: normalizeRuntimeDeliveryTarget(value.to),
    text: requireNonEmptyString(value.text, 'text'),
    createdAt: requireRuntimeDeliveryIso(value.createdAt, 'createdAt'),
    summary: value.summary === undefined || value.summary === null ? null : String(value.summary),
    ...(taskRefs ? { taskRefs } : {}),
  };
  return envelope;
}

export function resolveRuntimeDeliveryDestination(
  envelope: RuntimeDeliveryEnvelope
): RuntimeDeliveryDestinationRef {
  if (envelope.to === 'user') {
    return { kind: 'user_sent_messages', teamName: envelope.teamName };
  }

  if ('memberName' in envelope.to && !('teamName' in envelope.to)) {
    return {
      kind: 'member_inbox',
      teamName: envelope.teamName,
      memberName: envelope.to.memberName,
    };
  }

  return {
    kind: 'cross_team_outbox',
    fromTeamName: envelope.teamName,
    toTeamName: envelope.to.teamName,
    toMemberName: envelope.to.memberName,
  };
}

export function buildLocationFromJournal(
  record: RuntimeDeliveryJournalRecord
): RuntimeDeliveryLocation {
  if (record.committedLocation) {
    return record.committedLocation;
  }

  switch (record.destination.kind) {
    case 'user_sent_messages':
      return {
        kind: 'user_sent_messages',
        teamName: record.destination.teamName,
        messageId: record.destinationMessageId,
      };
    case 'member_inbox':
      return {
        kind: 'member_inbox',
        teamName: record.destination.teamName,
        memberName: record.destination.memberName,
        messageId: record.destinationMessageId,
      };
    case 'cross_team_outbox':
      return {
        kind: 'cross_team_outbox',
        fromTeamName: record.destination.fromTeamName,
        toTeamName: record.destination.toTeamName,
        toMemberName: record.destination.toMemberName,
        messageId: record.destinationMessageId,
      };
  }
}

export function runtimeDeliveryEnvelopeStableJson(envelope: RuntimeDeliveryEnvelope): string {
  return stableJsonStringify(envelope);
}

function normalizeRuntimeDeliveryTarget(value: unknown): RuntimeDeliveryTarget {
  if (value === 'user') {
    return 'user';
  }
  if (!isRecord(value)) {
    throw new Error('Runtime delivery target must be user or object');
  }
  const memberName = requireTrimmedNonEmptyString(value.memberName, 'to.memberName');
  if (typeof value.teamName === 'string' && value.teamName.trim()) {
    return { teamName: value.teamName.trim(), memberName };
  }
  return { memberName };
}

function normalizeRuntimeDeliveryTaskRefs(value: unknown): TaskRef[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Runtime delivery envelope taskRefs must be an array');
  }
  if (value.length === 0) {
    return undefined;
  }
  return value.map((item, index) => normalizeRuntimeDeliveryTaskRef(item, index));
}

function normalizeRuntimeDeliveryTaskRef(value: unknown, index: number): TaskRef {
  if (!isRecord(value)) {
    throw new Error(`Runtime delivery envelope taskRefs[${index}] must be a TaskRef`);
  }
  return {
    taskId: requireRuntimeDeliveryTaskRefString(value.taskId, `taskRefs[${index}].taskId`),
    displayId: requireRuntimeDeliveryTaskRefString(value.displayId, `taskRefs[${index}].displayId`),
    teamName: requireRuntimeDeliveryTaskRefString(value.teamName, `taskRefs[${index}].teamName`),
  };
}

function requireRuntimeDeliveryTaskRefString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Runtime delivery envelope missing ${fieldName}`);
  }
  return value.trim();
}

function normalizeRuntimeDeliveryJournalRecord(
  value: unknown
): RuntimeDeliveryJournalRecord | null {
  if (!isRuntimeDeliveryJournalRecordShape(value)) {
    return null;
  }
  if (
    value.logicalPayloadHash !== undefined &&
    value.logicalPayloadHash !== null &&
    !isNonEmptyString(value.logicalPayloadHash)
  ) {
    return null;
  }
  return {
    ...value,
    idempotencyKey: canonicalizeRuntimeIdempotencyKey(value.idempotencyKey, {
      errorPrefix: 'Runtime delivery journal record',
    }),
    runId: value.runId.trim(),
    teamName: value.teamName.trim(),
    fromMemberName: value.fromMemberName.trim(),
    runtimeSessionId: value.runtimeSessionId.trim(),
    logicalPayloadHash: value.logicalPayloadHash ?? null,
    destination: normalizeRuntimeDeliveryDestinationRef(value.destination),
    committedLocation:
      value.committedLocation === null
        ? null
        : normalizeRuntimeDeliveryLocation(value.committedLocation),
  };
}

function normalizeRuntimeDeliveryCommittedReceipt(
  value: unknown
): RuntimeDeliveryCommittedReceipt | null {
  if (!isRuntimeDeliveryCommittedReceiptShape(value)) {
    return null;
  }
  return {
    kind: 'committed_receipt',
    idempotencyKey: canonicalizeRuntimeIdempotencyKey(value.idempotencyKey, {
      errorPrefix: 'Runtime delivery committed receipt',
    }),
    teamName: value.teamName.trim(),
    logicalPayloadHash: value.logicalPayloadHash,
    committedLocation: normalizeRuntimeDeliveryLocation(value.committedLocation),
    committedAt: value.committedAt,
  };
}

function isRuntimeDeliveryJournalRecord(value: unknown): value is RuntimeDeliveryJournalRecord {
  return (
    isRuntimeDeliveryJournalRecordShape(value) &&
    (value.logicalPayloadHash === null || isNonEmptyString(value.logicalPayloadHash))
  );
}

function isRuntimeDeliveryJournalRecordShape(value: unknown): value is Omit<
  RuntimeDeliveryJournalRecord,
  'logicalPayloadHash'
> & {
  logicalPayloadHash?: unknown;
} {
  return (
    isRecord(value) &&
    isNonEmptyString(value.idempotencyKey) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.teamName) &&
    isNonEmptyString(value.fromMemberName) &&
    value.providerId === 'opencode' &&
    isNonEmptyString(value.runtimeSessionId) &&
    isNonEmptyString(value.payloadHash) &&
    isRuntimeDeliveryDestinationRef(value.destination) &&
    isNonEmptyString(value.destinationMessageId) &&
    (value.committedLocation === null || isRuntimeDeliveryLocation(value.committedLocation)) &&
    isRuntimeDeliveryJournalStatus(value.status) &&
    Number.isInteger(value.attempts) &&
    (value.attempts as number) >= 1 &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt) &&
    (value.committedAt === null || isNonEmptyString(value.committedAt)) &&
    (value.lastError === null || typeof value.lastError === 'string')
  );
}

function isRuntimeDeliveryCommittedReceipt(
  value: unknown
): value is RuntimeDeliveryCommittedReceipt {
  return isRuntimeDeliveryCommittedReceiptShape(value);
}

function isRuntimeDeliveryCommittedReceiptShape(
  value: unknown
): value is RuntimeDeliveryCommittedReceipt {
  return (
    isRecord(value) &&
    value.kind === 'committed_receipt' &&
    isNonEmptyString(value.idempotencyKey) &&
    isNonEmptyString(value.teamName) &&
    (value.logicalPayloadHash === null || isNonEmptyString(value.logicalPayloadHash)) &&
    isRuntimeDeliveryLocation(value.committedLocation) &&
    isNonEmptyString(value.committedAt)
  );
}

function isRuntimeDeliveryJournalStatus(value: unknown): value is RuntimeDeliveryJournalStatus {
  return (
    value === 'pending' ||
    value === 'committed' ||
    value === 'failed_retryable' ||
    value === 'failed_terminal'
  );
}

function isRuntimeDeliveryDestinationRef(value: unknown): value is RuntimeDeliveryDestinationRef {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'user_sent_messages') {
    return isNonEmptyString(value.teamName);
  }
  if (value.kind === 'member_inbox') {
    return isNonEmptyString(value.teamName) && isNonEmptyString(value.memberName);
  }
  return (
    value.kind === 'cross_team_outbox' &&
    isNonEmptyString(value.fromTeamName) &&
    isNonEmptyString(value.toTeamName) &&
    isNonEmptyString(value.toMemberName)
  );
}

function normalizeRuntimeDeliveryDestinationRef(
  value: RuntimeDeliveryDestinationRef
): RuntimeDeliveryDestinationRef {
  switch (value.kind) {
    case 'user_sent_messages':
      return { kind: value.kind, teamName: value.teamName.trim() };
    case 'member_inbox':
      return {
        kind: value.kind,
        teamName: value.teamName.trim(),
        memberName: value.memberName.trim(),
      };
    case 'cross_team_outbox':
      return {
        kind: value.kind,
        fromTeamName: value.fromTeamName.trim(),
        toTeamName: value.toTeamName.trim(),
        toMemberName: value.toMemberName.trim(),
      };
  }
}

function isRuntimeDeliveryLocation(value: unknown): value is RuntimeDeliveryLocation {
  if (!isRecord(value) || !isNonEmptyString(value.messageId)) {
    return false;
  }
  if (value.kind === 'user_sent_messages') {
    return isNonEmptyString(value.teamName);
  }
  if (value.kind === 'member_inbox') {
    return isNonEmptyString(value.teamName) && isNonEmptyString(value.memberName);
  }
  return (
    value.kind === 'cross_team_outbox' &&
    isNonEmptyString(value.fromTeamName) &&
    isNonEmptyString(value.toTeamName) &&
    isNonEmptyString(value.toMemberName)
  );
}

function normalizeRuntimeDeliveryLocation(value: RuntimeDeliveryLocation): RuntimeDeliveryLocation {
  switch (value.kind) {
    case 'user_sent_messages':
      return {
        kind: value.kind,
        teamName: value.teamName.trim(),
        messageId: value.messageId.trim(),
      };
    case 'member_inbox':
      return {
        kind: value.kind,
        teamName: value.teamName.trim(),
        memberName: value.memberName.trim(),
        messageId: value.messageId.trim(),
      };
    case 'cross_team_outbox':
      return {
        kind: value.kind,
        fromTeamName: value.fromTeamName.trim(),
        toTeamName: value.toTeamName.trim(),
        toMemberName: value.toMemberName.trim(),
        messageId: value.messageId.trim(),
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`Runtime delivery envelope missing ${field}`);
  }
  return value;
}

function requireTrimmedNonEmptyString(value: unknown, field: string): string {
  return requireNonEmptyString(value, field).trim();
}

function canonicalizeRuntimeDeliveryJournalInput<T extends RuntimeDeliveryJournalKeyInput>(
  input: T
): Omit<T, 'idempotencyKey'> & RuntimeDeliveryJournalKeyInput {
  return {
    ...input,
    runId: input.runId.trim(),
    teamName: input.teamName.trim(),
    idempotencyKey: canonicalizeRuntimeIdempotencyKey(input.idempotencyKey, {
      errorPrefix: 'Runtime delivery envelope',
    }),
  };
}

function requireRuntimeDeliveryIso(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field).trim();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Runtime delivery envelope invalid ${field}`);
  }
  return new Date(parsed).toISOString();
}

function fail(message: string): never {
  throw new Error(message);
}
