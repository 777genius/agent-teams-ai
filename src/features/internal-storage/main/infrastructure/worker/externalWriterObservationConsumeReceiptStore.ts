import { createHash } from 'node:crypto';

import { EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION } from '@features/external-writer-coordination';

import { parseExternalWriterObservationCheckpoint } from './externalWriterObservationCheckpointSupport';

import type { FileObservationStateCheckpoint } from '@features/external-writer-coordination';
import type {
  ExternalWriterObservationCheckpointIdentity,
  ExternalWriterObservationCheckpointRecord,
} from '../../../contracts/externalWriterObservationStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
const hash = (checkpoint: FileObservationStateCheckpoint): string =>
  createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');

export function readConsumeReceipt(
  db: SqliteDatabase,
  identity: ExternalWriterObservationCheckpointIdentity,
  attemptId: string
): ExternalWriterObservationCheckpointRecord | null {
  const row = db
    .prepare(
      `SELECT consume_attempt_id, result_revision, checkpoint_json, checkpoint_sha256 FROM external_writer_observation_consume_receipts WHERE deployment_id = ? AND observer_id = ?`
    )
    .get(identity.deploymentId, identity.observerId) as
    | {
        consume_attempt_id: string;
        result_revision: number;
        checkpoint_json: string;
        checkpoint_sha256: string;
      }
    | undefined;
  if (!row || row.consume_attempt_id !== attemptId) return null;
  let checkpoint: FileObservationStateCheckpoint;
  try {
    checkpoint = parseExternalWriterObservationCheckpoint(
      JSON.parse(row.checkpoint_json) as unknown
    );
  } catch {
    throw new Error('external-writer-observation-consume-receipt-invalid');
  }
  if (
    !Number.isSafeInteger(row.result_revision) ||
    row.result_revision <= 0 ||
    hash(checkpoint) !== row.checkpoint_sha256
  )
    throw new Error('external-writer-observation-consume-receipt-invalid');
  return { revision: row.result_revision, checkpoint };
}

export function replaceConsumeReceipt(
  db: SqliteDatabase,
  identity: ExternalWriterObservationCheckpointIdentity,
  attemptId: string,
  result: ExternalWriterObservationCheckpointRecord
): void {
  db.prepare(
    `INSERT INTO external_writer_observation_consume_receipts (deployment_id, observer_id, consume_attempt_id, result_revision, schema_version, checkpoint_json, checkpoint_sha256) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deployment_id, observer_id) DO UPDATE SET consume_attempt_id = excluded.consume_attempt_id, result_revision = excluded.result_revision, schema_version = excluded.schema_version, checkpoint_json = excluded.checkpoint_json, checkpoint_sha256 = excluded.checkpoint_sha256`
  ).run(
    identity.deploymentId,
    identity.observerId,
    attemptId,
    result.revision,
    EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION,
    JSON.stringify(result.checkpoint),
    hash(result.checkpoint)
  );
}
