import { EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION, type FileObservationStateCheckpoint } from '@features/external-writer-coordination';

import { checkpointTeamIds, type ExternalWriterStoredCheckpointRow } from './externalWriterObservationCheckpointSupport';

import type { ExternalWriterObservationCheckpointIdentity, ExternalWriterObservationCheckpointRecord, ExternalWriterObservationCheckpointSaveRequest, ExternalWriterObservationRetirementProof } from '../../../contracts/externalWriterObservationStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export function assertNoRetiredTeamReappears(db: SqliteDatabase, identity: ExternalWriterObservationCheckpointIdentity, checkpoint: FileObservationStateCheckpoint): void {
  const ids = [...checkpointTeamIds(checkpoint)];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    if (db.prepare(`SELECT 1 FROM external_writer_observation_retired_team_floors WHERE deployment_id = ? AND observer_id = ? AND team_id IN (${batch.map(() => '?').join(', ')}) LIMIT 1`).get(identity.deploymentId, identity.observerId, ...batch)) throw new Error('external-writer-observation-retired-team-reappeared');
  }
}

export function verifyTombstoneProof(db: SqliteDatabase, proof: ExternalWriterObservationRetirementProof): void {
  const row = db.prepare(`SELECT identity.state, identity.identity_checksum, identity.tombstoned_at,
      reservation.team_id reservation_team_id, reservation.state reservation_state,
      reservation.tombstoned_at reservation_tombstoned_at, adoption.state adoption_state,
      adoption.expected_identity_checksum, adoption.published_identity_checksum,
      adoption.committed_identity_checksum
    FROM team_identity_records identity JOIN legacy_team_key_reservations reservation ON reservation.legacy_key = identity.legacy_key
    JOIN team_adoption_intents adoption ON adoption.intent_id = identity.adoption_intent_id AND adoption.team_id = identity.team_id WHERE identity.team_id = ?`).get(proof.teamId) as Record<string, unknown> | undefined;
  if (!row || row.state !== 'tombstoned' || row.identity_checksum !== proof.identityChecksum || row.tombstoned_at !== proof.tombstonedAt || row.reservation_team_id !== proof.teamId || row.reservation_state !== 'tombstoned' || row.reservation_tombstoned_at !== proof.tombstonedAt || row.adoption_state !== 'committed' || row.expected_identity_checksum !== proof.identityChecksum || row.published_identity_checksum !== proof.identityChecksum || row.committed_identity_checksum !== proof.identityChecksum) throw new Error('external-writer-observation-retirement-proof-mismatch');
}

export function insertRetiredFloor(db: SqliteDatabase, identity: ExternalWriterObservationCheckpointIdentity, proof: ExternalWriterObservationRetirementProof, previous: FileObservationStateCheckpoint): void {
  const epoch = previous.fileWriterEpochs.find((entry) => entry.teamId === proof.teamId)?.epoch ?? null;
  const watermark = previous.teamObservationWatermarks.find((entry) => entry.teamId === proof.teamId);
  db.prepare(`INSERT INTO external_writer_observation_retired_team_floors (deployment_id, observer_id, team_id, identity_checksum, tombstoned_at, writer_epoch, last_observation_sequence, observation_watermark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(identity.deploymentId, identity.observerId, proof.teamId, proof.identityChecksum, proof.tombstonedAt, epoch, watermark?.lastObservationSequence ?? 0, watermark?.observationWatermark ?? 0);
}

export function writeCheckpoint(db: SqliteDatabase, request: ExternalWriterObservationCheckpointSaveRequest, previous: ExternalWriterStoredCheckpointRow | undefined): ExternalWriterObservationCheckpointRecord {
  const revision = (previous?.revision ?? 0) + 1;
  db.prepare(`INSERT INTO external_writer_observation_checkpoints (deployment_id, observer_id, revision, schema_version, checkpoint_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(deployment_id, observer_id) DO UPDATE SET revision = excluded.revision, schema_version = excluded.schema_version, checkpoint_json = excluded.checkpoint_json`).run(request.deploymentId, request.observerId, revision, EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION, JSON.stringify(request.checkpoint));
  return { revision, checkpoint: request.checkpoint };
}

export function hasHandoffEligibility(db: SqliteDatabase, identity: ExternalWriterObservationCheckpointIdentity): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM external_writer_observation_handoff_eligibility WHERE deployment_id = ? AND observer_id = ?`).get(identity.deploymentId, identity.observerId));
}

export function readCheckpoint(db: SqliteDatabase, identity: ExternalWriterObservationCheckpointIdentity): ExternalWriterStoredCheckpointRow | undefined {
  return db.prepare(`SELECT revision, checkpoint_json FROM external_writer_observation_checkpoints WHERE deployment_id = ? AND observer_id = ?`).get(identity.deploymentId, identity.observerId) as ExternalWriterStoredCheckpointRow | undefined;
}
