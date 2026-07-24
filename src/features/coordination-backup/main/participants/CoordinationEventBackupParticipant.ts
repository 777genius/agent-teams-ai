import {
  assertCoordinationEventRecoveryPoint,
  createCoordinationEventRecoveryPoint,
} from '@features/coordination-events';

import {
  COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION,
} from '../../contracts';
import { canonicalBackupJson } from '../infrastructure';

import type {
  BackupParticipantDescriptor,
  FlushedBackupParticipant,
  PreparedBackupParticipant,
} from '../../contracts';
import type {
  BackupParticipantVerification,
  CoordinationBackupParticipant,
  FlushBackupParticipantRequest,
  PrepareBackupParticipantRequest,
  StageBackupParticipantRequest,
  StagedBackupParticipant,
  VerifyBackupParticipantRequest,
} from '../../core/application';
import type { BackupPublicationArtifactWriter } from '../infrastructure';
import type {
  CoordinationEventJournal,
  CoordinationEventRecoveryPoint,
} from '@features/coordination-events';

const PARTICIPANT_ID = 'coordination-events' as const;
const PARTICIPANT_KIND = 'event-journal-recovery-point' as const;
const ENTRY_ID = 'events/recovery-point.json' as const;
const BARRIER_PREFIX = 'coordination-event-recovery-point-v1.';

export class CoordinationEventBackupParticipant implements CoordinationBackupParticipant<
  typeof PARTICIPANT_ID,
  typeof PARTICIPANT_KIND
> {
  readonly descriptor: BackupParticipantDescriptor<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND> =
    Object.freeze({
      participantId: PARTICIPANT_ID,
      kind: PARTICIPANT_KIND,
      contractVersion: COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION,
      schemaVersion: COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION,
      required: true,
    });

  constructor(
    private readonly options: {
      readonly deploymentId: string;
      readonly journal: CoordinationEventJournal;
      readonly artifactWriter: BackupPublicationArtifactWriter;
    }
  ) {
    if (!options.deploymentId || !options.journal || !options.artifactWriter) {
      throw new TypeError('coordination-event-backup-participant-options-invalid');
    }
  }

  async prepare(
    request: PrepareBackupParticipantRequest
  ): Promise<PreparedBackupParticipant<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND>> {
    requireFence(request.backupRunId, request.fence);
    const watermark = await this.options.journal.getWatermark();
    requireDeployment(watermark.deploymentId, this.options.deploymentId);
    return Object.freeze({
      descriptor: this.descriptor,
      sourceGeneration: sourceGeneration(watermark.deploymentId, watermark.eventEpoch),
    });
  }

  async flush(
    request: FlushBackupParticipantRequest<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND>
  ): Promise<FlushedBackupParticipant<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND>> {
    requireFence(request.backupRunId, request.fence);
    requirePrepared(request.prepared, this.descriptor);
    const recoveryPoint = createCoordinationEventRecoveryPoint({
      participantId: PARTICIPANT_ID,
      watermark: await this.options.journal.getWatermark(),
    });
    if (
      recoveryPoint.deploymentId !== this.options.deploymentId ||
      sourceGeneration(recoveryPoint.deploymentId, recoveryPoint.eventEpoch) !==
        request.prepared.sourceGeneration
    ) {
      throw new Error('coordination-event-backup-source-generation-changed');
    }
    return Object.freeze({
      ...request.prepared,
      durableBarrier: encodeRecoveryPoint(recoveryPoint),
    });
  }

  async stage(
    request: StageBackupParticipantRequest<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND>
  ): Promise<StagedBackupParticipant> {
    requireFence(request.backupRunId, request.fence);
    requireFlushed(request.flushed, this.descriptor);
    const recoveryPoint = decodeRecoveryPoint(request.flushed.durableBarrier);
    requireRecoveryPointMatchesFlush(recoveryPoint, request.flushed, this.options.deploymentId);
    const entry = await this.options.artifactWriter.writeArtifact({
      backupRunId: request.backupRunId,
      entryId: ENTRY_ID,
      participantId: PARTICIPANT_ID,
      kind: 'participant_file',
      logicalOwner: 'coordination-events',
      logicalType: 'event-journal-recovery-point',
      schemaVersion: recoveryPoint.schemaVersion,
      sourceGeneration: request.flushed.sourceGeneration,
      bytes: Buffer.from(canonicalBackupJson(recoveryPoint), 'utf8'),
      mode: 0o600,
    });
    return Object.freeze({
      participantId: PARTICIPANT_ID,
      entries: Object.freeze([entry]),
      exclusions: Object.freeze([]),
    });
  }

  async verify(
    request: VerifyBackupParticipantRequest<typeof PARTICIPANT_ID, typeof PARTICIPANT_KIND>
  ): Promise<BackupParticipantVerification> {
    try {
      requireFence(request.backupRunId, request.fence);
      requireFlushed(request.flushed, this.descriptor);
      if (request.stagedEntries.length !== 1) return invalid('entry-count-mismatch');
      const recoveryPoint = decodeRecoveryPoint(request.flushed.durableBarrier);
      requireRecoveryPointMatchesFlush(recoveryPoint, request.flushed, this.options.deploymentId);
      const current = createCoordinationEventRecoveryPoint({
        participantId: PARTICIPANT_ID,
        watermark: await this.options.journal.getWatermark(),
      });
      if (canonicalBackupJson(current) !== canonicalBackupJson(recoveryPoint)) {
        return invalid('journal-advanced-after-barrier');
      }
      const entry = request.stagedEntries[0];
      if (
        entry.entryId !== ENTRY_ID ||
        entry.participantId !== PARTICIPANT_ID ||
        entry.kind !== 'participant_file' ||
        entry.logicalOwner !== 'coordination-events' ||
        entry.logicalType !== 'event-journal-recovery-point' ||
        entry.schemaVersion !== recoveryPoint.schemaVersion ||
        entry.sourceGeneration !== request.flushed.sourceGeneration ||
        entry.mode !== 0o600
      ) {
        return invalid('entry-contract-mismatch');
      }
      const measured = await this.options.artifactWriter.measureStagedArtifact({
        backupRunId: request.backupRunId,
        entryId: entry.entryId,
      });
      if (
        measured.byteLength !== entry.byteLength ||
        measured.mode !== entry.mode ||
        measured.sha256 !== entry.sha256
      ) {
        return invalid('staged-artifact-mismatch');
      }
      return { status: 'verified' };
    } catch {
      return invalid('verification-boundary-failed');
    }
  }
}

function encodeRecoveryPoint(recoveryPoint: CoordinationEventRecoveryPoint): string {
  return `${BARRIER_PREFIX}${Buffer.from(canonicalBackupJson(recoveryPoint), 'utf8').toString(
    'base64url'
  )}`;
}

function decodeRecoveryPoint(value: string): CoordinationEventRecoveryPoint {
  if (typeof value !== 'string' || !value.startsWith(BARRIER_PREFIX)) {
    throw new Error('coordination-event-backup-barrier-invalid');
  }
  let recoveryPoint: unknown;
  try {
    recoveryPoint = JSON.parse(
      Buffer.from(value.slice(BARRIER_PREFIX.length), 'base64url').toString('utf8')
    ) as unknown;
  } catch {
    throw new Error('coordination-event-backup-barrier-invalid');
  }
  assertCoordinationEventRecoveryPoint(recoveryPoint as CoordinationEventRecoveryPoint);
  return recoveryPoint as CoordinationEventRecoveryPoint;
}

function requirePrepared(
  prepared: PreparedBackupParticipant,
  descriptor: BackupParticipantDescriptor
): void {
  if (
    prepared.descriptor.participantId !== descriptor.participantId ||
    prepared.descriptor.kind !== descriptor.kind ||
    prepared.descriptor.contractVersion !== descriptor.contractVersion ||
    prepared.descriptor.schemaVersion !== descriptor.schemaVersion ||
    prepared.sourceGeneration.length === 0
  ) {
    throw new Error('coordination-event-backup-prepared-invalid');
  }
}

function requireFlushed(
  flushed: FlushedBackupParticipant,
  descriptor: BackupParticipantDescriptor
): void {
  requirePrepared(flushed, descriptor);
  if (!flushed.durableBarrier) throw new Error('coordination-event-backup-flush-invalid');
}

function requireRecoveryPointMatchesFlush(
  recoveryPoint: CoordinationEventRecoveryPoint,
  flushed: FlushedBackupParticipant,
  deploymentId: string
): void {
  if (
    recoveryPoint.participantId !== PARTICIPANT_ID ||
    recoveryPoint.deploymentId !== deploymentId ||
    sourceGeneration(recoveryPoint.deploymentId, recoveryPoint.eventEpoch) !==
      flushed.sourceGeneration
  ) {
    throw new Error('coordination-event-backup-recovery-point-mismatch');
  }
}

function requireFence(
  backupRunId: string,
  fence: { readonly admittedRunId: string; readonly generation: number }
): void {
  if (fence.admittedRunId !== backupRunId || fence.generation <= 0) {
    throw new Error('coordination-event-backup-fence-invalid');
  }
}

function requireDeployment(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('coordination-event-backup-deployment-mismatch');
}

function sourceGeneration(deploymentId: string, eventEpoch: string): string {
  return `${deploymentId}:${eventEpoch}`;
}

function invalid(reason: string): BackupParticipantVerification {
  return { status: 'invalid', reason };
}
