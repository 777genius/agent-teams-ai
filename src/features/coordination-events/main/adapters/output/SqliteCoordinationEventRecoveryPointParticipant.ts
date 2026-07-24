import { createHash } from 'node:crypto';

import {
  COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION,
  type CoordinationEventRecoveryPoint,
} from '../../../contracts';
import {
  assertCoordinationEventRecoveryPoint,
  createCoordinationEventRecoveryPoint,
} from '../../../core/domain';

import type {
  CoordinationEventJournal,
  CoordinationEventRecoveryPointParticipant,
  CoordinationEventRecoveryPointPreparation,
  CoordinationEventRecoveryPointStage,
  VerifiedCoordinationEventRecoveryPoint,
} from '../../../core/application';

export interface CoordinationEventRecoveryArtifactStore {
  stage(input: {
    readonly recoveryRunId: string;
    readonly participantId: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly artifactRef: string; readonly contentDigest: string }>;
  verify(input: {
    readonly recoveryRunId: string;
    readonly participantId: string;
    readonly artifactRef: string;
    readonly contentDigest: string;
  }): Promise<boolean>;
}

export class SqliteCoordinationEventRecoveryPointParticipant implements CoordinationEventRecoveryPointParticipant {
  readonly participantId: string;

  constructor(
    private readonly options: {
      readonly participantId?: string;
      readonly deploymentId: string;
      readonly journal: CoordinationEventJournal;
      readonly artifacts: CoordinationEventRecoveryArtifactStore;
    }
  ) {
    if (!options.deploymentId || !options.journal || !options.artifacts) {
      throw new TypeError('sqlite-coordination-event-recovery-options-invalid');
    }
    this.participantId = options.participantId ?? 'coordination-events';
    if (!this.participantId) {
      throw new TypeError('sqlite-coordination-event-recovery-participant-id-invalid');
    }
  }

  async prepare(input: {
    readonly recoveryRunId: string;
    readonly deploymentId: string;
  }): Promise<CoordinationEventRecoveryPointPreparation> {
    requireNonEmpty(input.recoveryRunId, 'recovery-run-id');
    if (input.deploymentId !== this.options.deploymentId) {
      throw new Error('coordination-event-recovery-deployment-mismatch');
    }
    await this.options.journal.getWatermark();
    return Object.freeze({
      schemaVersion: 1 as const,
      participantId: this.participantId,
      recoveryRunId: input.recoveryRunId,
      deploymentId: input.deploymentId,
    });
  }

  async flush(
    preparation: CoordinationEventRecoveryPointPreparation
  ): Promise<CoordinationEventRecoveryPoint> {
    this.requirePreparation(preparation);
    return createCoordinationEventRecoveryPoint({
      participantId: this.participantId,
      watermark: await this.options.journal.getWatermark(),
    });
  }

  async stage(input: {
    readonly preparation: CoordinationEventRecoveryPointPreparation;
    readonly recoveryPoint: Awaited<
      ReturnType<SqliteCoordinationEventRecoveryPointParticipant['flush']>
    >;
  }): Promise<CoordinationEventRecoveryPointStage> {
    this.requirePreparation(input.preparation);
    const bytes = Buffer.from(canonicalJson(input.recoveryPoint), 'utf8');
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    const staged = await this.options.artifacts.stage({
      recoveryRunId: input.preparation.recoveryRunId,
      participantId: this.participantId,
      bytes,
    });
    if (staged.contentDigest !== expectedDigest) {
      throw new Error('coordination-event-recovery-artifact-digest-mismatch');
    }
    requireNonEmpty(staged.artifactRef, 'artifact-ref');
    return Object.freeze({
      schemaVersion: 1 as const,
      participantId: this.participantId,
      recoveryRunId: input.preparation.recoveryRunId,
      stagedArtifactRef: staged.artifactRef,
      contentDigest: staged.contentDigest,
      recoveryPoint: Object.freeze({ ...input.recoveryPoint }),
    });
  }

  async verify(
    stage: CoordinationEventRecoveryPointStage
  ): Promise<VerifiedCoordinationEventRecoveryPoint> {
    requireNonEmpty(stage.recoveryRunId, 'recovery-run-id');
    requireNonEmpty(stage.stagedArtifactRef, 'artifact-ref');
    assertCoordinationEventRecoveryPoint(stage.recoveryPoint);
    const expectedDigest = createHash('sha256')
      .update(canonicalJson(stage.recoveryPoint), 'utf8')
      .digest('hex');
    if (
      stage.schemaVersion !== 1 ||
      stage.participantId !== this.participantId ||
      stage.recoveryPoint.participantId !== this.participantId ||
      stage.recoveryPoint.deploymentId !== this.options.deploymentId ||
      stage.recoveryPoint.schemaVersion !== COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION ||
      stage.contentDigest !== expectedDigest ||
      !(await this.options.artifacts.verify({
        recoveryRunId: stage.recoveryRunId,
        participantId: stage.participantId,
        artifactRef: stage.stagedArtifactRef,
        contentDigest: stage.contentDigest,
      }))
    ) {
      throw new Error('coordination-event-recovery-artifact-invalid');
    }
    return Object.freeze({ ...stage, verified: true as const });
  }

  private requirePreparation(preparation: CoordinationEventRecoveryPointPreparation): void {
    if (
      preparation.schemaVersion !== 1 ||
      preparation.participantId !== this.participantId ||
      preparation.deploymentId !== this.options.deploymentId
    ) {
      throw new Error('coordination-event-recovery-preparation-mismatch');
    }
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`coordination-event-recovery-${field}-invalid`);
  }
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
