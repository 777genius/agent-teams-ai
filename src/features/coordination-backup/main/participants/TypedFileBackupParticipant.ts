import {
  type BackupExclusion,
  type BackupManifestEntry,
  type BackupParticipantDescriptor,
  type BackupRunId,
  type FlushedBackupParticipant,
  type PreparedBackupParticipant,
} from '../../contracts';
import {
  type BackupParticipantVerification,
  type CoordinationBackupParticipant,
  type FlushBackupParticipantRequest,
  type PrepareBackupParticipantRequest,
  type StageBackupParticipantRequest,
  type StagedBackupParticipant,
  type VerifyBackupParticipantRequest,
} from '../../core/application';
import {
  type BackupPublicationArtifactWriter,
  sha256Bytes,
  validateArtifactEntryId,
} from '../infrastructure';

const EXCLUSION_REASONS = new Set<BackupExclusion['reason']>([
  'credential',
  'session_or_ticket',
  'ephemeral_runtime',
  'rebuildable_cache',
  'secret_diagnostic',
  'outside_coordination_scope',
]);

export interface TypedFileSourceExclusion {
  readonly logicalType: string;
  readonly reason: BackupExclusion['reason'];
}

export interface TypedFileBackupSourceSnapshot<TGeneration extends string> {
  readonly bytes: Uint8Array;
  readonly generation: TGeneration;
  readonly durableBarrier: string;
  readonly exclusions: readonly TypedFileSourceExclusion[];
}

/**
 * A feature-owned capability. The source returns typed bytes and evidence only; storage-location
 * capabilities are intentionally absent from both the request and response contracts.
 */
export interface TypedFileBackupSource<TGeneration extends string> {
  readSnapshot(request: {
    readonly backupRunId: BackupRunId;
    readonly fenceGeneration: number;
  }): Promise<TypedFileBackupSourceSnapshot<TGeneration>>;
}

export interface TypedFileBackupParticipantOptions<
  TParticipantId extends string,
  TKind extends string,
  TGeneration extends string,
> {
  readonly descriptor: BackupParticipantDescriptor<TParticipantId, TKind>;
  readonly entry: {
    readonly entryId: string;
    readonly kind: Extract<BackupManifestEntry['kind'], 'participant_file' | 'identity_anchor'>;
    readonly logicalOwner: string;
    readonly logicalType: string;
    readonly schemaVersion: number;
    readonly mode: number;
  };
  readonly source: TypedFileBackupSource<TGeneration>;
  readonly artifactWriter: BackupPublicationArtifactWriter;
  readonly maximumBytes?: number;
}

export class TypedFileBackupParticipantError extends Error {
  constructor(readonly code: string) {
    super(`coordination-backup-typed-file-participant-${code}`);
    this.name = 'TypedFileBackupParticipantError';
  }
}

export class TypedFileBackupParticipant<
  TParticipantId extends string,
  TKind extends string,
  TGeneration extends string,
> implements CoordinationBackupParticipant<TParticipantId, TKind> {
  readonly descriptor: BackupParticipantDescriptor<TParticipantId, TKind>;
  private readonly maximumBytes: number;

  constructor(
    private readonly options: TypedFileBackupParticipantOptions<TParticipantId, TKind, TGeneration>
  ) {
    this.descriptor = Object.freeze({ ...options.descriptor });
    this.maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
    validateOptions(options, this.maximumBytes);
  }

  async prepare(
    request: PrepareBackupParticipantRequest
  ): Promise<PreparedBackupParticipant<TParticipantId, TKind>> {
    const snapshot = await this.readSnapshot(request.backupRunId, request.fence.generation);
    return Object.freeze({
      descriptor: this.descriptor,
      sourceGeneration: snapshot.generation,
    });
  }

  async flush(
    request: FlushBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<FlushedBackupParticipant<TParticipantId, TKind>> {
    this.requirePrepared(request.prepared);
    const snapshot = await this.readSnapshot(request.backupRunId, request.fence.generation);
    if (snapshot.generation !== request.prepared.sourceGeneration) {
      throw participantError('source-generation-changed-before-flush');
    }
    return Object.freeze({
      descriptor: this.descriptor,
      sourceGeneration: snapshot.generation,
      durableBarrier: snapshot.durableBarrier,
    });
  }

  async stage(
    request: StageBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<StagedBackupParticipant> {
    this.requireFlushed(request.flushed);
    const snapshot = await this.readSnapshot(request.backupRunId, request.fence.generation);
    this.requireSnapshotMatchesFlush(snapshot, request.flushed);
    const entry = await this.options.artifactWriter.writeArtifact({
      backupRunId: request.backupRunId,
      entryId: this.options.entry.entryId,
      participantId: this.descriptor.participantId,
      kind: this.options.entry.kind,
      logicalOwner: this.options.entry.logicalOwner,
      logicalType: this.options.entry.logicalType,
      schemaVersion: this.options.entry.schemaVersion,
      sourceGeneration: request.flushed.sourceGeneration,
      bytes: snapshot.bytes,
      mode: this.options.entry.mode,
    });
    return Object.freeze({
      participantId: this.descriptor.participantId,
      entries: Object.freeze([entry]),
      exclusions: Object.freeze(
        snapshot.exclusions.map((exclusion) =>
          Object.freeze({
            participantId: this.descriptor.participantId,
            logicalType: exclusion.logicalType,
            reason: exclusion.reason,
          })
        )
      ),
    });
  }

  async verify(
    request: VerifyBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<BackupParticipantVerification> {
    try {
      this.requireFlushed(request.flushed);
      if (request.stagedEntries.length !== 1) return invalid('entry-count-mismatch');
      const entry = request.stagedEntries[0];
      if (!this.entryMatchesConfiguration(entry, request.flushed.sourceGeneration)) {
        return invalid('entry-contract-mismatch');
      }
      const snapshot = await this.readSnapshot(request.backupRunId, request.fence.generation);
      this.requireSnapshotMatchesFlush(snapshot, request.flushed);
      if (
        snapshot.bytes.byteLength !== entry.byteLength ||
        sha256Bytes(snapshot.bytes) !== entry.sha256
      ) {
        return invalid('source-bytes-changed');
      }
      const measured = await this.options.artifactWriter.measureStagedArtifact({
        backupRunId: request.backupRunId,
        entryId: entry.entryId,
      });
      if (
        measured.entryId !== entry.entryId ||
        measured.byteLength !== entry.byteLength ||
        measured.mode !== entry.mode ||
        measured.sha256 !== entry.sha256
      ) {
        return invalid('staged-artifact-mismatch');
      }
      return { status: 'verified' };
    } catch (error) {
      return invalid(
        error instanceof TypedFileBackupParticipantError
          ? error.code
          : 'verification-boundary-failed'
      );
    }
  }

  private async readSnapshot(
    backupRunId: BackupRunId,
    fenceGeneration: number
  ): Promise<TypedFileBackupSourceSnapshot<TGeneration>> {
    const snapshot = await this.options.source.readSnapshot({ backupRunId, fenceGeneration });
    validateSnapshot(snapshot, this.maximumBytes);
    return Object.freeze({
      bytes: Uint8Array.from(snapshot.bytes),
      generation: snapshot.generation,
      durableBarrier: snapshot.durableBarrier,
      exclusions: Object.freeze(
        snapshot.exclusions.map((exclusion) => Object.freeze({ ...exclusion }))
      ),
    });
  }

  private requirePrepared(prepared: PreparedBackupParticipant<TParticipantId, TKind>): void {
    if (
      prepared.descriptor.participantId !== this.descriptor.participantId ||
      prepared.descriptor.kind !== this.descriptor.kind ||
      prepared.descriptor.contractVersion !== this.descriptor.contractVersion ||
      prepared.descriptor.schemaVersion !== this.descriptor.schemaVersion ||
      prepared.sourceGeneration.length === 0
    ) {
      throw participantError('prepared-evidence-mismatch');
    }
  }

  private requireFlushed(flushed: FlushedBackupParticipant<TParticipantId, TKind>): void {
    this.requirePrepared(flushed);
    if (flushed.durableBarrier.length === 0) throw participantError('flush-barrier-invalid');
  }

  private requireSnapshotMatchesFlush(
    snapshot: TypedFileBackupSourceSnapshot<TGeneration>,
    flushed: FlushedBackupParticipant<TParticipantId, TKind>
  ): void {
    if (
      snapshot.generation !== flushed.sourceGeneration ||
      snapshot.durableBarrier !== flushed.durableBarrier
    ) {
      throw participantError('source-evidence-changed-after-flush');
    }
  }

  private entryMatchesConfiguration(entry: BackupManifestEntry, sourceGeneration: string): boolean {
    return (
      entry.entryId === this.options.entry.entryId &&
      entry.participantId === this.descriptor.participantId &&
      entry.kind === this.options.entry.kind &&
      entry.logicalOwner === this.options.entry.logicalOwner &&
      entry.logicalType === this.options.entry.logicalType &&
      entry.schemaVersion === this.options.entry.schemaVersion &&
      entry.mode === this.options.entry.mode &&
      entry.sourceGeneration === sourceGeneration
    );
  }
}

function validateOptions<
  TParticipantId extends string,
  TKind extends string,
  TGeneration extends string,
>(
  options: TypedFileBackupParticipantOptions<TParticipantId, TKind, TGeneration>,
  maximumBytes: number
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw participantError('maximum-bytes-invalid');
  }
  validateArtifactEntryId(options.entry.entryId);
  if (
    options.descriptor.participantId.length === 0 ||
    options.descriptor.kind.length === 0 ||
    options.descriptor.contractVersion !== 1 ||
    options.descriptor.schemaVersion !== 1 ||
    typeof options.descriptor.required !== 'boolean' ||
    options.entry.logicalOwner.length === 0 ||
    options.entry.logicalType.length === 0 ||
    !Number.isSafeInteger(options.entry.schemaVersion) ||
    options.entry.schemaVersion < 0 ||
    !Number.isInteger(options.entry.mode) ||
    options.entry.mode < 0 ||
    options.entry.mode > 0o777 ||
    (options.entry.mode & 0o400) === 0 ||
    typeof options.source.readSnapshot !== 'function' ||
    typeof options.artifactWriter.writeArtifact !== 'function' ||
    typeof options.artifactWriter.measureStagedArtifact !== 'function'
  ) {
    throw participantError('entry-configuration-invalid');
  }
}

function validateSnapshot<TGeneration extends string>(
  snapshot: TypedFileBackupSourceSnapshot<TGeneration>,
  maximumBytes: number
): void {
  if (!snapshot || typeof snapshot !== 'object') throw participantError('source-snapshot-invalid');
  const snapshotValues = readExactOwnDataProperties(snapshot, [
    'bytes',
    'durableBarrier',
    'exclusions',
    'generation',
  ]);
  if (!snapshotValues) {
    throw participantError('source-snapshot-surface-invalid');
  }
  if (
    !(snapshotValues.bytes instanceof Uint8Array) ||
    snapshotValues.bytes.byteLength > maximumBytes
  ) {
    throw participantError('source-bytes-invalid');
  }
  if (typeof snapshotValues.generation !== 'string' || snapshotValues.generation.length === 0) {
    throw participantError('source-generation-invalid');
  }
  if (
    typeof snapshotValues.durableBarrier !== 'string' ||
    snapshotValues.durableBarrier.length === 0
  ) {
    throw participantError('source-barrier-invalid');
  }
  if (!Array.isArray(snapshotValues.exclusions)) {
    throw participantError('source-exclusions-invalid');
  }
  for (const exclusion of snapshotValues.exclusions) {
    const exclusionValues = readExactOwnDataProperties(exclusion, ['logicalType', 'reason']);
    if (
      !exclusionValues ||
      typeof exclusionValues.logicalType !== 'string' ||
      exclusionValues.logicalType.length === 0 ||
      !EXCLUSION_REASONS.has(exclusionValues.reason as BackupExclusion['reason'])
    ) {
      throw participantError('source-exclusion-invalid');
    }
  }
}

function readExactOwnDataProperties(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object') return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return null;
  }
  const values: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    values[key] = descriptor.value;
  }
  return values;
}

function invalid(reason: string): BackupParticipantVerification {
  return { status: 'invalid', reason };
}

function participantError(code: string): TypedFileBackupParticipantError {
  return new TypedFileBackupParticipantError(code);
}
