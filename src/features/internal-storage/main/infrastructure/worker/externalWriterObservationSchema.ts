import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { teamIdentityRecords } from './teamIdentityStorageSchema';

export const externalWriterObservationCheckpoints = sqliteTable(
  'external_writer_observation_checkpoints',
  {
    deploymentId: text('deployment_id').notNull(),
    observerId: text('observer_id').notNull(),
    revision: integer('revision').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    checkpointJson: text('checkpoint_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.observerId] }),
    check('ck_external_writer_observation_revision', sql`${table.revision} > 0`),
    check('ck_external_writer_observation_schema', sql`${table.schemaVersion} = 2`),
    check('ck_external_writer_observation_json', sql`json_valid(${table.checkpointJson})`),
  ]
);

export const externalWriterObservationConsumeReceipts = sqliteTable(
  'external_writer_observation_consume_receipts',
  {
    deploymentId: text('deployment_id').notNull(),
    observerId: text('observer_id').notNull(),
    consumeAttemptId: text('consume_attempt_id').notNull(),
    resultRevision: integer('result_revision').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    checkpointJson: text('checkpoint_json').notNull(),
    checkpointSha256: text('checkpoint_sha256').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.observerId] }),
    check(
      'ck_external_writer_consume_attempt_id',
      sql`length(${table.consumeAttemptId}) BETWEEN 1 AND 128 AND ${table.consumeAttemptId} NOT GLOB '*[^A-Za-z0-9._:-]*'`
    ),
    check('ck_external_writer_consume_result_revision', sql`${table.resultRevision} > 0`),
    check('ck_external_writer_consume_schema', sql`${table.schemaVersion} = 2`),
    check('ck_external_writer_consume_checkpoint_json', sql`json_valid(${table.checkpointJson})`),
    check(
      'ck_external_writer_consume_checkpoint_hash',
      sql`length(${table.checkpointSha256}) = 64 AND ${table.checkpointSha256} NOT GLOB '*[^0-9a-f]*'`
    ),
  ]
);

export const externalWriterObservationRetiredTeamFloors = sqliteTable(
  'external_writer_observation_retired_team_floors',
  {
    deploymentId: text('deployment_id').notNull(),
    observerId: text('observer_id').notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teamIdentityRecords.teamId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    identityChecksum: text('identity_checksum').notNull(),
    tombstonedAt: text('tombstoned_at').notNull(),
    writerEpoch: integer('writer_epoch'),
    lastObservationSequence: integer('last_observation_sequence').notNull(),
    observationWatermark: integer('observation_watermark').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.observerId, table.teamId] }),
    check(
      'ck_external_writer_retired_epoch',
      sql`${table.writerEpoch} IS NULL OR ${table.writerEpoch} >= 1`
    ),
    check('ck_external_writer_retired_sequence', sql`${table.lastObservationSequence} >= 0`),
    check('ck_external_writer_retired_watermark', sql`${table.observationWatermark} >= 0`),
    check(
      'ck_external_writer_retired_watermark_sequence',
      sql`${table.observationWatermark} <= ${table.lastObservationSequence}`
    ),
  ]
);

export const externalWriterObservationHandoffEligibility = sqliteTable(
  'external_writer_observation_handoff_eligibility',
  {
    deploymentId: text('deployment_id').notNull(),
    observerId: text('observer_id').notNull(),
    expectedCheckpointRevision: integer('expected_checkpoint_revision').notNull(),
    handoffId: text('handoff_id').notNull(),
    protocolVersion: integer('protocol_version').notNull(),
    checkpointSha256: text('checkpoint_sha256').notNull(),
    capturedSequence: integer('captured_sequence').notNull(),
    persistedWatermark: integer('persisted_watermark').notNull(),
    oldCatalogToken: text('old_catalog_token').notNull(),
    targetCatalogToken: text('target_catalog_token').notNull(),
    nextRegistrationDigest: text('next_registration_digest').notNull(),
    candidateDigest: text('candidate_digest').notNull(),
    candidatesJson: text('candidates_json').notNull(),
    retainedRegistrationsJson: text('retained_registrations_json').notNull(),
    removedRegistrationsJson: text('removed_registrations_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.observerId] }),
    foreignKey({
      columns: [table.deploymentId, table.observerId],
      foreignColumns: [
        externalWriterObservationCheckpoints.deploymentId,
        externalWriterObservationCheckpoints.observerId,
      ],
    })
      .onDelete('cascade')
      .onUpdate('restrict'),
    check('ck_external_writer_handoff_revision', sql`${table.expectedCheckpointRevision} > 0`),
    check('ck_external_writer_handoff_protocol', sql`${table.protocolVersion} = 1`),
    check(
      'ck_external_writer_handoff_id',
      sql`length(${table.handoffId}) BETWEEN 1 AND 128 AND ${table.handoffId} NOT GLOB '*[^A-Za-z0-9._:-]*'`
    ),
    check(
      'ck_external_writer_handoff_checkpoint_hash',
      sql`length(${table.checkpointSha256}) = 64 AND ${table.checkpointSha256} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_external_writer_handoff_captured_watermark',
      sql`${table.capturedSequence} >= 0 AND ${table.capturedSequence} = ${table.persistedWatermark}`
    ),
    check(
      'ck_external_writer_handoff_old_token',
      sql`length(${table.oldCatalogToken}) = 64 AND ${table.oldCatalogToken} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_external_writer_handoff_target_token',
      sql`length(${table.targetCatalogToken}) = 64 AND ${table.targetCatalogToken} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_external_writer_handoff_registration_digest',
      sql`length(${table.nextRegistrationDigest}) = 64 AND ${table.nextRegistrationDigest} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_external_writer_handoff_candidate_digest',
      sql`length(${table.candidateDigest}) = 64 AND ${table.candidateDigest} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_external_writer_handoff_candidates_json',
      sql`json_valid(${table.candidatesJson}) AND json_type(${table.candidatesJson}) = 'array' AND json_array_length(${table.candidatesJson}) <= 1024 AND length(CAST(${table.candidatesJson} AS BLOB)) <= 67108864`
    ),
    check(
      'ck_external_writer_handoff_retained_json',
      sql`json_valid(${table.retainedRegistrationsJson}) AND json_type(${table.retainedRegistrationsJson}) = 'array' AND json_array_length(${table.retainedRegistrationsJson}) <= 100000 AND length(CAST(${table.retainedRegistrationsJson} AS BLOB)) <= 67108864`
    ),
    check(
      'ck_external_writer_handoff_removed_json',
      sql`json_valid(${table.removedRegistrationsJson}) AND json_type(${table.removedRegistrationsJson}) = 'array' AND json_array_length(${table.removedRegistrationsJson}) <= 100000 AND length(CAST(${table.removedRegistrationsJson} AS BLOB)) <= 67108864`
    ),
  ]
);
