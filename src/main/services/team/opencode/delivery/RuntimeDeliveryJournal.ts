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

export interface RuntimeDeliveryJournalBeginInput {
  idempotencyKey: string;
  payloadHash: string;
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
) & { recoveryRecords?: RuntimeDeliveryJournalRecord[] };

export class RuntimeDeliveryJournalStore {
  constructor(
    private readonly store: VersionedJsonStore<RuntimeDeliveryJournalRecord[]>,
    private readonly maxTerminalRecords = RUNTIME_DELIVERY_JOURNAL_MAX_TERMINAL_RECORDS
  ) {}

  async begin(input: RuntimeDeliveryJournalBeginInput): Promise<RuntimeDeliveryJournalBeginResult> {
    const canonicalInput = canonicalizeRuntimeDeliveryJournalInput(input);
    let result: RuntimeDeliveryJournalBeginResult | null = null;
    await this.store.updateLocked((records) => {
      // A committed record closes its delivery generation. Only uncommitted local generations
      // carry destination proof into a new run, so a key may still identify a later message.
      const recoveryRecords = records.filter((record) =>
        canCarryRuntimeDeliveryAcrossRuns(record, canonicalInput)
      );
      const existing = records.find((record) =>
        matchesRuntimeDeliveryJournalKey(record, canonicalInput)
      );
      if (existing) {
        const hasCompatiblePayloadHash =
          existing.payloadHash === canonicalInput.payloadHash ||
          canonicalInput.compatiblePayloadHashes?.includes(existing.payloadHash) === true;
        if (!hasCompatiblePayloadHash) {
          result = { state: 'payload_conflict', record: existing };
          return pruneRuntimeDeliveryJournalRecords(records, this.maxTerminalRecords);
        }

        if (existing.status === 'committed') {
          result = { state: 'already_committed', record: existing };
          return pruneRuntimeDeliveryJournalRecords(records, this.maxTerminalRecords);
        }

        const resumed = {
          ...existing,
          payloadHash: canonicalInput.payloadHash,
          attempts: existing.attempts + 1,
          status: existing.status === 'failed_terminal' ? existing.status : 'pending',
          updatedAt: canonicalInput.now,
        } satisfies RuntimeDeliveryJournalRecord;
        result = {
          state: 'resume_pending',
          record: resumed,
          ...(recoveryRecords.length > 0 ? { recoveryRecords } : {}),
        };
        return pruneRuntimeDeliveryJournalRecords(
          records.map((record) =>
            matchesRuntimeDeliveryJournalKey(record, canonicalInput) ? resumed : record
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
      };
      return pruneRuntimeDeliveryJournalRecords([...records, created], this.maxTerminalRecords);
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
  }): Promise<void> {
    const canonicalInput = canonicalizeRuntimeDeliveryJournalInput(input);
    let found = false;
    await this.store.updateLocked((records) => {
      const current = records.find((record) =>
        matchesRuntimeDeliveryJournalKey(record, canonicalInput)
      );
      if (!current) {
        return records;
      }
      found = true;
      const committed = records.map((record) =>
        matchesRuntimeDeliveryJournalKey(record, canonicalInput) ||
        belongsToRuntimeDeliveryRecoveryLineage(record, current)
          ? {
              ...record,
              committedLocation: canonicalInput.location,
              status: 'committed' as const,
              updatedAt: canonicalInput.committedAt,
              committedAt: canonicalInput.committedAt,
              lastError: null,
            }
          : record
      );
      return pruneRuntimeDeliveryJournalRecords(committed, this.maxTerminalRecords);
    });

    if (!found) {
      throwRuntimeDeliveryJournalRecordNotFound(canonicalInput);
    }
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
    await this.store.updateLocked((records) => {
      const updated = records.map((record) => {
        if (!matchesRuntimeDeliveryJournalKey(record, input)) {
          return record;
        }
        found = true;
        return updater(record);
      });
      return pruneRuntimeDeliveryJournalRecords(updated, this.maxTerminalRecords);
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
    return result.data;
  }
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
    matchesLocalRuntimeDeliveryDestination(record.destination, input.destination)
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
    matchesLocalRuntimeDeliveryDestination(record.destination, current.destination)
  );
}

function matchesLocalRuntimeDeliveryDestination(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  // Cross-team sends retain run-scoped message ids and use conversationId for duplicate proof.
  return false;
}

function pruneRuntimeDeliveryJournalRecords(
  records: RuntimeDeliveryJournalRecord[],
  maxTerminalRecords: number
): RuntimeDeliveryJournalRecord[] {
  const terminalRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => isPrunableRuntimeDeliveryJournalRecord(record));
  if (terminalRecords.length <= maxTerminalRecords) {
    return records;
  }

  const newestTerminal = terminalRecords
    .sort(compareRuntimeDeliveryJournalRecency)
    .slice(0, maxTerminalRecords);
  const retainedIndexes = new Set(newestTerminal.map(({ index }) => index));

  return records.filter(
    (record, index) => !isPrunableRuntimeDeliveryJournalRecord(record) || retainedIndexes.has(index)
  );
}

function isPrunableRuntimeDeliveryJournalRecord(record: RuntimeDeliveryJournalRecord): boolean {
  // Pending and retryable records are the durable proof source for process-relaunch recovery.
  return record.status === 'committed' || record.status === 'failed_terminal';
}

function compareRuntimeDeliveryJournalRecency(
  left: { record: RuntimeDeliveryJournalRecord; index: number },
  right: { record: RuntimeDeliveryJournalRecord; index: number }
): number {
  const timestampDifference =
    getRuntimeDeliveryJournalTimestamp(right.record) -
    getRuntimeDeliveryJournalTimestamp(left.record);
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
    new VersionedJsonStore<RuntimeDeliveryJournalRecord[]>({
      filePath: options.filePath,
      schemaVersion: RUNTIME_DELIVERY_JOURNAL_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimeDeliveryJournalRecords,
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
    if (!isRuntimeDeliveryJournalRecord(record)) {
      throw new Error(`Invalid runtime delivery journal record at index ${index}`);
    }
    const normalizedRecord = {
      ...record,
      idempotencyKey: canonicalizeRuntimeIdempotencyKey(record.idempotencyKey, {
        errorPrefix: 'Runtime delivery journal record',
      }),
    };
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

function buildRuntimeDeliveryJournalKey(record: RuntimeDeliveryJournalRecord): string {
  return `${record.teamName}\u0000${record.runId}\u0000${record.idempotencyKey}`;
}

export function hashRuntimeDeliveryEnvelope(envelope: RuntimeDeliveryEnvelope): string {
  return hashRuntimeDeliveryEnvelopeWithTaskRefs(envelope, envelope.taskRefs ?? []);
}

export function hashRuntimeDeliveryEnvelopeLegacyTaskRefs(
  envelope: RuntimeDeliveryEnvelope
): string | null {
  if (!envelope.taskRefs?.length) {
    return null;
  }
  return hashRuntimeDeliveryEnvelopeWithTaskRefs(
    envelope,
    envelope.taskRefs.map((taskRef) => taskRef.taskId)
  );
}

function hashRuntimeDeliveryEnvelopeWithTaskRefs(
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
    runId: envelope.runId,
    teamName: envelope.teamName,
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
    runId: requireNonEmptyString(value.runId, 'runId'),
    teamName: requireNonEmptyString(value.teamName, 'teamName'),
    fromMemberName: requireNonEmptyString(value.fromMemberName, 'fromMemberName'),
    providerId: value.providerId === 'opencode' ? 'opencode' : fail('providerId must be opencode'),
    runtimeSessionId: requireNonEmptyString(value.runtimeSessionId, 'runtimeSessionId'),
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
  const memberName = requireNonEmptyString(value.memberName, 'to.memberName');
  if (typeof value.teamName === 'string' && value.teamName.trim()) {
    return { teamName: value.teamName, memberName };
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

function isRuntimeDeliveryJournalRecord(value: unknown): value is RuntimeDeliveryJournalRecord {
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

function canonicalizeRuntimeDeliveryJournalInput<T extends RuntimeDeliveryJournalKeyInput>(
  input: T
): Omit<T, 'idempotencyKey'> & RuntimeDeliveryJournalKeyInput {
  return {
    ...input,
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
