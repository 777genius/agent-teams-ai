import {
  EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION,
  FileObservationState,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';
import { parseDeploymentId } from '@shared/contracts/hosted';

import type {
  ExternalWriterObservationCheckpointIdentity,
  ExternalWriterObservationCheckpointSaveRequest,
} from '../../../contracts/externalWriterObservationStorageContracts';

export interface ExternalWriterStoredCheckpointRow {
  revision: number;
  checkpoint_json: string;
}
export const MAX_CHECKPOINT_JSON_BYTES = 64 * 1024 * 1024;
const OBSERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIMITS = Object.freeze({
  maxPendingObservations: 1_024,
  maxSelfWriteIntents: 1_024,
  maxObservationAttempts: 3,
  maxScopes: 1_024,
  maxObservedFiles: 100_000,
});

export function compareExternalWriterText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(code);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new TypeError(code);
  return record;
}

export function parseExternalWriterObservationIdentity(
  value: unknown
): ExternalWriterObservationCheckpointIdentity {
  const record = exactObject(
    value,
    ['deploymentId', 'observerId'],
    'external-writer-observation-identity-invalid'
  );
  if (typeof record.observerId !== 'string' || !OBSERVER_ID_PATTERN.test(record.observerId))
    throw new TypeError('external-writer-observer-id-invalid');
  return { deploymentId: parseDeploymentId(record.deploymentId), observerId: record.observerId };
}

export function parseExternalWriterObservationCheckpoint(
  value: unknown
): FileObservationStateCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  }
  if (
    Buffer.byteLength(json, 'utf8') > MAX_CHECKPOINT_JSON_BYTES ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION
  )
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  try {
    const checkpoint = FileObservationState.restore(
      value as FileObservationStateCheckpoint,
      LIMITS
    ).snapshot();
    return {
      ...checkpoint,
      fileWriterEpochs: [...checkpoint.fileWriterEpochs].sort((a, b) =>
        compareExternalWriterText(a.teamId, b.teamId)
      ),
      teamObservationWatermarks: [...checkpoint.teamObservationWatermarks].sort((a, b) =>
        compareExternalWriterText(a.teamId, b.teamId)
      ),
      pendingObservations: [...checkpoint.pendingObservations].sort((a, b) =>
        compareExternalWriterText(a.id, b.id)
      ),
      dirtyScopes: [...checkpoint.dirtyScopes].sort(
        (a, b) =>
          compareExternalWriterText(a.scope.teamId, b.scope.teamId) ||
          compareExternalWriterText(a.scope.featureKey, b.scope.featureKey)
      ),
      selfWriteIntents: [...checkpoint.selfWriteIntents].sort((a, b) =>
        compareExternalWriterText(a.intentId, b.intentId)
      ),
      observedFiles: [...checkpoint.observedFiles].sort(
        (a, b) =>
          compareExternalWriterText(a.scope.teamId, b.scope.teamId) ||
          compareExternalWriterText(a.scope.featureKey, b.scope.featureKey) ||
          compareExternalWriterText(a.fileKey, b.fileKey)
      ),
    };
  } catch {
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  }
}

export function parseExternalWriterObservationCheckpointRecord(value: unknown): {
  readonly revision: number;
  readonly checkpoint: FileObservationStateCheckpoint;
} {
  const record = exactObject(
    value,
    ['revision', 'checkpoint'],
    'external-writer-observation-record-invalid'
  );
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    throw new TypeError('external-writer-observation-record-invalid');
  }
  return {
    revision: record.revision as number,
    checkpoint: parseExternalWriterObservationCheckpoint(record.checkpoint),
  };
}

export function parseSaveRequest(value: unknown): ExternalWriterObservationCheckpointSaveRequest {
  const record = exactObject(
    value,
    ['deploymentId', 'observerId', 'expectedRevision', 'checkpoint'],
    'external-writer-observation-save-invalid'
  );
  const identity = parseExternalWriterObservationIdentity({
    deploymentId: record.deploymentId,
    observerId: record.observerId,
  });
  if (
    record.expectedRevision !== null &&
    (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) <= 0)
  )
    throw new TypeError('external-writer-observation-revision-invalid');
  return {
    ...identity,
    expectedRevision: record.expectedRevision as number | null,
    checkpoint: parseExternalWriterObservationCheckpoint(record.checkpoint),
  };
}

export function checkpointTeamIds(checkpoint: FileObservationStateCheckpoint): Set<string> {
  return new Set(
    [
      ...checkpoint.fileWriterEpochs,
      ...checkpoint.teamObservationWatermarks,
      ...checkpoint.pendingObservations,
      ...checkpoint.dirtyScopes,
      ...checkpoint.selfWriteIntents,
      ...checkpoint.observedFiles,
    ].map((entry) => ('teamId' in entry ? entry.teamId : entry.scope.teamId))
  );
}

export function assertNonRegressing(
  previous: FileObservationStateCheckpoint,
  next: FileObservationStateCheckpoint
): void {
  if (
    next.lastObservationSequence < previous.lastObservationSequence ||
    next.observationWatermark < previous.observationWatermark
  )
    throw new Error('external-writer-observation-checkpoint-regression');
  const epochs = new Map(next.fileWriterEpochs.map((entry) => [entry.teamId, entry.epoch]));
  for (const entry of previous.fileWriterEpochs)
    if ((epochs.get(entry.teamId) ?? -1) < entry.epoch)
      throw new Error('external-writer-observation-checkpoint-regression');
  const watermarks = new Map(
    next.teamObservationWatermarks.map((entry) => [entry.teamId, entry] as const)
  );
  for (const entry of previous.teamObservationWatermarks) {
    const nextEntry = watermarks.get(entry.teamId);
    if (
      !nextEntry ||
      nextEntry.lastObservationSequence < entry.lastObservationSequence ||
      nextEntry.observationWatermark < entry.observationWatermark
    )
      throw new Error('external-writer-observation-checkpoint-regression');
  }
}

export function checkpointFromRow(
  row: ExternalWriterStoredCheckpointRow
): FileObservationStateCheckpoint {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision <= 0 ||
    Buffer.byteLength(row.checkpoint_json, 'utf8') > MAX_CHECKPOINT_JSON_BYTES
  )
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  try {
    return parseExternalWriterObservationCheckpoint(JSON.parse(row.checkpoint_json) as unknown);
  } catch {
    throw new TypeError('external-writer-observation-checkpoint-invalid');
  }
}
