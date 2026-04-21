import { randomUUID } from 'crypto';

import { VersionedJsonStore, VersionedJsonStoreError } from './VersionedJsonStore';

export const OPENCODE_RUNTIME_RUN_TOMBSTONE_SCHEMA_VERSION = 1;

export type RuntimeEvidenceKind =
  | 'sse_event'
  | 'permission_reply'
  | 'delivery_call'
  | 'prompt_error'
  | 'bootstrap_checkin'
  | 'launch_checkpoint'
  | 'heartbeat'
  | 'bridge_result'
  | 'recovery_result';

export type RuntimeRunTombstoneReason =
  | 'stop_requested'
  | 'relaunch_started'
  | 'run_replaced'
  | 'provider_session_aborted'
  | 'recovery_rejected';

export interface RuntimeRunTombstone {
  tombstoneId: string;
  teamName: string;
  runId: string;
  reason: RuntimeRunTombstoneReason;
  evidenceKinds: RuntimeEvidenceKind[];
  createdAt: string;
  expiresAt: string | null;
  diagnostic: string | null;
}

export interface RuntimeEvidenceAcceptanceInput {
  teamName: string;
  runId: string | null;
  currentRunId: string | null;
  evidenceKind: RuntimeEvidenceKind;
}

export class RuntimeStaleEvidenceError extends Error {
  constructor(
    message: string,
    readonly reason: 'missing_run_id' | 'current_run_missing' | 'run_mismatch' | 'run_tombstoned',
    readonly evidenceKind: RuntimeEvidenceKind,
    readonly runId: string | null
  ) {
    super(message);
    this.name = 'RuntimeStaleEvidenceError';
  }
}

export class RuntimeRunTombstoneStore {
  constructor(
    private readonly store: VersionedJsonStore<RuntimeRunTombstone[]>,
    private readonly options: {
      idFactory?: () => string;
      clock?: () => Date;
    } = {}
  ) {}

  async add(input: {
    teamName: string;
    runId: string;
    reason: RuntimeRunTombstoneReason;
    evidenceKinds?: RuntimeEvidenceKind[];
    ttlMs?: number;
    diagnostic?: string | null;
  }): Promise<RuntimeRunTombstone> {
    const clock = this.options.clock ?? (() => new Date());
    const now = clock();
    let created: RuntimeRunTombstone | null = null;

    await this.store.updateLocked((records) => {
      const compacted = compactRuntimeRunTombstones(records, now);
      const existing = compacted.find(
        (record) =>
          record.teamName === input.teamName &&
          record.runId === input.runId &&
          record.reason === input.reason
      );
      if (existing) {
        created = existing;
        return compacted;
      }

      created = {
        tombstoneId: this.options.idFactory?.() ?? `opencode-run-tombstone-${randomUUID()}`,
        teamName: input.teamName,
        runId: input.runId,
        reason: input.reason,
        evidenceKinds: normalizeEvidenceKinds(input.evidenceKinds),
        createdAt: now.toISOString(),
        expiresAt:
          typeof input.ttlMs === 'number'
            ? new Date(now.getTime() + input.ttlMs).toISOString()
            : null,
        diagnostic: input.diagnostic ?? null,
      };
      return [...compacted, created];
    });

    if (!created) {
      throw new Error('Runtime run tombstone was not created');
    }
    return created;
  }

  async list(teamName: string): Promise<RuntimeRunTombstone[]> {
    const records = await this.readRequired();
    const now = (this.options.clock ?? (() => new Date()))();
    return compactRuntimeRunTombstones(records, now).filter(
      (record) => record.teamName === teamName
    );
  }

  async find(input: {
    teamName: string;
    runId: string;
    evidenceKind?: RuntimeEvidenceKind;
  }): Promise<RuntimeRunTombstone | null> {
    const records = await this.list(input.teamName);
    return (
      records.find(
        (record) =>
          record.runId === input.runId &&
          (!input.evidenceKind || record.evidenceKinds.includes(input.evidenceKind))
      ) ?? null
    );
  }

  async assertEvidenceAccepted(input: RuntimeEvidenceAcceptanceInput): Promise<void> {
    assertRuntimeEvidenceRunMatches(input);
    const tombstone = input.runId
      ? await this.find({
          teamName: input.teamName,
          runId: input.runId,
          evidenceKind: input.evidenceKind,
        })
      : null;

    if (tombstone) {
      throw new RuntimeStaleEvidenceError(
        `Rejected stale runtime evidence: ${input.evidenceKind}`,
        'run_tombstoned',
        input.evidenceKind,
        input.runId
      );
    }
  }

  async compact(): Promise<number> {
    const now = (this.options.clock ?? (() => new Date()))();
    let removed = 0;
    await this.store.updateLocked((records) => {
      const compacted = compactRuntimeRunTombstones(records, now);
      removed = records.length - compacted.length;
      return compacted;
    });
    return removed;
  }

  private async readRequired(): Promise<RuntimeRunTombstone[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data;
  }
}

export function assertRuntimeEvidenceRunMatches(input: RuntimeEvidenceAcceptanceInput): void {
  if (!input.runId) {
    throw new RuntimeStaleEvidenceError(
      `Rejected runtime evidence without run id: ${input.evidenceKind}`,
      'missing_run_id',
      input.evidenceKind,
      input.runId
    );
  }

  if (!input.currentRunId) {
    throw new RuntimeStaleEvidenceError(
      `Rejected runtime evidence without current run: ${input.evidenceKind}`,
      'current_run_missing',
      input.evidenceKind,
      input.runId
    );
  }

  if (input.runId !== input.currentRunId) {
    throw new RuntimeStaleEvidenceError(
      `Rejected stale runtime evidence: ${input.evidenceKind}`,
      'run_mismatch',
      input.evidenceKind,
      input.runId
    );
  }
}

export function createRuntimeRunTombstoneStore(options: {
  filePath: string;
  idFactory?: () => string;
  clock?: () => Date;
}): RuntimeRunTombstoneStore {
  const clock = options.clock ?? (() => new Date());
  return new RuntimeRunTombstoneStore(
    new VersionedJsonStore<RuntimeRunTombstone[]>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_RUNTIME_RUN_TOMBSTONE_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimeRunTombstones,
      clock,
    }),
    {
      idFactory: options.idFactory,
      clock,
    }
  );
}

export function validateRuntimeRunTombstones(value: unknown): RuntimeRunTombstone[] {
  if (!Array.isArray(value)) {
    throw new Error('Runtime run tombstones must be an array');
  }
  const seen = new Set<string>();
  return value.map((record, index) => {
    if (!isRuntimeRunTombstone(record)) {
      throw new Error(`Invalid runtime run tombstone at index ${index}`);
    }
    if (seen.has(record.tombstoneId)) {
      throw new Error(`Duplicate runtime run tombstone id: ${record.tombstoneId}`);
    }
    seen.add(record.tombstoneId);
    return record;
  });
}

export function compactRuntimeRunTombstones(
  records: RuntimeRunTombstone[],
  now: Date
): RuntimeRunTombstone[] {
  const nowMs = now.getTime();
  return records.filter(
    (record) => record.expiresAt === null || Date.parse(record.expiresAt) > nowMs
  );
}

function normalizeEvidenceKinds(input: RuntimeEvidenceKind[] | undefined): RuntimeEvidenceKind[] {
  const all: RuntimeEvidenceKind[] = [
    'sse_event',
    'permission_reply',
    'delivery_call',
    'prompt_error',
    'bootstrap_checkin',
    'launch_checkpoint',
    'heartbeat',
    'bridge_result',
    'recovery_result',
  ];
  const source = input && input.length > 0 ? input : all;
  return [...new Set(source)].sort();
}

function isRuntimeRunTombstone(value: unknown): value is RuntimeRunTombstone {
  return (
    isRecord(value) &&
    isNonEmptyString(value.tombstoneId) &&
    isNonEmptyString(value.teamName) &&
    isNonEmptyString(value.runId) &&
    isRuntimeRunTombstoneReason(value.reason) &&
    Array.isArray(value.evidenceKinds) &&
    value.evidenceKinds.length > 0 &&
    value.evidenceKinds.every(isRuntimeEvidenceKind) &&
    isNonEmptyString(value.createdAt) &&
    (value.expiresAt === null || isNonEmptyString(value.expiresAt)) &&
    (value.diagnostic === null || typeof value.diagnostic === 'string')
  );
}

function isRuntimeRunTombstoneReason(value: unknown): value is RuntimeRunTombstoneReason {
  return (
    value === 'stop_requested' ||
    value === 'relaunch_started' ||
    value === 'run_replaced' ||
    value === 'provider_session_aborted' ||
    value === 'recovery_rejected'
  );
}

function isRuntimeEvidenceKind(value: unknown): value is RuntimeEvidenceKind {
  return (
    value === 'sse_event' ||
    value === 'permission_reply' ||
    value === 'delivery_call' ||
    value === 'prompt_error' ||
    value === 'bootstrap_checkin' ||
    value === 'launch_checkpoint' ||
    value === 'heartbeat' ||
    value === 'bridge_result' ||
    value === 'recovery_result'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
