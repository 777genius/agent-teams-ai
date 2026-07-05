import { stableHash, stableJsonStringify } from '../bridge/OpenCodeBridgeCommandContract';
import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

export const RUNTIME_DELIVERY_JOURNAL_SCHEMA_VERSION = 1;

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
  runId: string;
  teamName: string;
  fromMemberName: string;
  providerId: 'opencode';
  runtimeSessionId: string;
  destination: RuntimeDeliveryDestinationRef;
  destinationMessageId: string;
  now: string;
}

export type RuntimeDeliveryJournalBeginResult =
  | { state: 'new'; record: RuntimeDeliveryJournalRecord }
  | { state: 'already_committed'; record: RuntimeDeliveryJournalRecord }
  | { state: 'resume_pending'; record: RuntimeDeliveryJournalRecord }
  | { state: 'payload_conflict'; record: RuntimeDeliveryJournalRecord };

export class RuntimeDeliveryJournalStore {
  constructor(private readonly store: VersionedJsonStore<RuntimeDeliveryJournalRecord[]>) {}

  async begin(input: RuntimeDeliveryJournalBeginInput): Promise<RuntimeDeliveryJournalBeginResult> {
    let result: RuntimeDeliveryJournalBeginResult | null = null;
    await this.store.updateLocked((records) => {
      const existing = records.find((record) => record.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          result = { state: 'payload_conflict', record: existing };
          return records;
        }

        if (existing.status === 'committed') {
          result = { state: 'already_committed', record: existing };
          return records;
        }

        const resumed = {
          ...existing,
          attempts: existing.attempts + 1,
          status: existing.status === 'failed_terminal' ? existing.status : 'pending',
          updatedAt: input.now,
        } satisfies RuntimeDeliveryJournalRecord;
        result = { state: 'resume_pending', record: resumed };
        return records.map((record) =>
          record.idempotencyKey === input.idempotencyKey ? resumed : record
        );
      }

      const created: RuntimeDeliveryJournalRecord = {
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        teamName: input.teamName,
        fromMemberName: input.fromMemberName,
        providerId: input.providerId,
        runtimeSessionId: input.runtimeSessionId,
        payloadHash: input.payloadHash,
        destination: input.destination,
        destinationMessageId: input.destinationMessageId,
        committedLocation: null,
        status: 'pending',
        attempts: 1,
        createdAt: input.now,
        updatedAt: input.now,
        committedAt: null,
        lastError: null,
      };
      result = { state: 'new', record: created };
      return [...records, created];
    });

    if (!result) {
      throw new Error('Runtime delivery journal begin failed');
    }
    return result;
  }

  async markCommitted(input: {
    idempotencyKey: string;
    location: RuntimeDeliveryLocation;
    committedAt: string;
  }): Promise<void> {
    await this.updateExisting(input.idempotencyKey, (record) => ({
      ...record,
      committedLocation: input.location,
      status: 'committed',
      updatedAt: input.committedAt,
      committedAt: input.committedAt,
      lastError: null,
    }));
  }

  async markFailed(input: {
    idempotencyKey: string;
    status: 'failed_retryable' | 'failed_terminal';
    error: string;
    updatedAt: string;
  }): Promise<void> {
    await this.updateExisting(input.idempotencyKey, (record) => ({
      ...record,
      status: input.status,
      updatedAt: input.updatedAt,
      lastError: input.error,
    }));
  }

  async get(idempotencyKey: string): Promise<RuntimeDeliveryJournalRecord | null> {
    const records = await this.readRequired();
    return records.find((record) => record.idempotencyKey === idempotencyKey) ?? null;
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
    idempotencyKey: string,
    updater: (record: RuntimeDeliveryJournalRecord) => RuntimeDeliveryJournalRecord
  ): Promise<void> {
    let found = false;
    await this.store.updateLocked((records) =>
      records.map((record) => {
        if (record.idempotencyKey !== idempotencyKey) {
          return record;
        }
        found = true;
        return updater(record);
      })
    );

    if (!found) {
      throw new Error(`Runtime delivery journal record not found: ${idempotencyKey}`);
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

export function createRuntimeDeliveryJournalStore(options: {
  filePath: string;
  clock?: () => Date;
}): RuntimeDeliveryJournalStore {
  const clock = options.clock ?? (() => new Date());
  return new RuntimeDeliveryJournalStore(
    new VersionedJsonStore<RuntimeDeliveryJournalRecord[]>({
      filePath: options.filePath,
      schemaVersion: RUNTIME_DELIVERY_JOURNAL_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimeDeliveryJournalRecords,
      clock,
    })
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
    if (seen.has(record.idempotencyKey)) {
      throw new Error(`Duplicate runtime delivery idempotency key: ${record.idempotencyKey}`);
    }
    seen.add(record.idempotencyKey);
    return record;
  });
}

export function hashRuntimeDeliveryEnvelope(envelope: RuntimeDeliveryEnvelope): string {
  return `sha256:${stableHash({
    providerId: envelope.providerId,
    runId: envelope.runId,
    teamName: envelope.teamName,
    fromMemberName: envelope.fromMemberName,
    runtimeSessionId: envelope.runtimeSessionId,
    to: envelope.to,
    text: envelope.text,
    summary: envelope.summary ?? null,
    taskRefs: envelope.taskRefs ?? [],
    createdAt: envelope.createdAt,
  })}`;
}

export function buildRuntimeDestinationMessageId(envelope: RuntimeDeliveryEnvelope): string {
  return `runtime-delivery-${stableHash({
    idempotencyKey: envelope.idempotencyKey,
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
  taskRefs?: string[];
}

export function normalizeRuntimeDeliveryEnvelope(value: unknown): RuntimeDeliveryEnvelope {
  if (!isRecord(value)) {
    throw new Error('Runtime delivery envelope must be an object');
  }

  const envelope: RuntimeDeliveryEnvelope = {
    idempotencyKey: requireNonEmptyString(value.idempotencyKey, 'idempotencyKey'),
    runId: requireNonEmptyString(value.runId, 'runId'),
    teamName: requireNonEmptyString(value.teamName, 'teamName'),
    fromMemberName: requireNonEmptyString(value.fromMemberName, 'fromMemberName'),
    providerId: value.providerId === 'opencode' ? 'opencode' : fail('providerId must be opencode'),
    runtimeSessionId: requireNonEmptyString(value.runtimeSessionId, 'runtimeSessionId'),
    to: normalizeRuntimeDeliveryTarget(value.to),
    text: requireNonEmptyString(value.text, 'text'),
    createdAt: requireNonEmptyString(value.createdAt, 'createdAt'),
    summary: value.summary === undefined || value.summary === null ? null : String(value.summary),
    taskRefs: Array.isArray(value.taskRefs)
      ? value.taskRefs.filter((item): item is string => typeof item === 'string')
      : [],
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

function fail(message: string): never {
  throw new Error(message);
}
