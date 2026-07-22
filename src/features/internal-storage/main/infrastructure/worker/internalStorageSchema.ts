import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export {
  legacyTeamKeyReservations,
  teamAdoptionIntents,
  teamIdentityRecords,
  teamIdentityStorageMetadata,
} from './teamIdentityStorageSchema';

export const stallJournalEntries = sqliteTable(
  'stall_journal_entries',
  {
    teamName: text('team_name').notNull(),
    epochKey: text('epoch_key').notNull(),
    taskId: text('task_id').notNull(),
    memberName: text('member_name'),
    branch: text('branch').notNull(),
    signal: text('signal').notNull(),
    state: text('state').notNull(),
    consecutiveScans: integer('consecutive_scans').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    alertedAt: text('alerted_at'),
  },
  (table) => [primaryKey({ columns: [table.teamName, table.epochKey] })]
);

export const storeImports = sqliteTable(
  'store_imports',
  {
    storeId: text('store_id').notNull(),
    teamName: text('team_name').notNull(),
    importedAt: text('imported_at').notNull(),
    entryCount: integer('entry_count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.storeId, table.teamName] })]
);

export const commentJournalEntries = sqliteTable(
  'comment_journal_entries',
  {
    teamName: text('team_name').notNull(),
    key: text('key').notNull(),
    taskId: text('task_id').notNull(),
    commentId: text('comment_id').notNull(),
    author: text('author').notNull(),
    commentCreatedAt: text('comment_created_at'),
    messageId: text('message_id'),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    sentAt: text('sent_at'),
  },
  (table) => [primaryKey({ columns: [table.teamName, table.key] })]
);

export const commentJournalTeams = sqliteTable('comment_journal_teams', {
  teamName: text('team_name').primaryKey(),
  initializedAt: text('initialized_at').notNull(),
});

export const memberWorkSyncStatus = sqliteTable(
  'member_work_sync_status',
  {
    teamKey: text('team_key').notNull(),
    teamName: text('team_name').notNull(),
    memberKey: text('member_key').notNull(),
    memberName: text('member_name').notNull(),
    state: text('state').notNull(),
    evaluatedAt: text('evaluated_at').notNull(),
    providerId: text('provider_id'),
    statusJson: text('status_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamName, table.memberKey] }),
    index('idx_mws_status_team_key').on(table.teamKey),
  ]
);

export const memberWorkSyncReportIntents = sqliteTable(
  'member_work_sync_report_intents',
  {
    teamKey: text('team_key').notNull(),
    teamName: text('team_name').notNull(),
    id: text('id').notNull(),
    memberKey: text('member_key').notNull(),
    memberName: text('member_name').notNull(),
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    recordedAt: text('recorded_at').notNull(),
    processedAt: text('processed_at'),
    resultCode: text('result_code'),
    requestJson: text('request_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamName, table.id] }),
    index('idx_mws_report_intents_team_key').on(table.teamKey),
    index('idx_mws_report_intents_pending').on(table.teamName, table.status, table.recordedAt),
  ]
);

export const memberWorkSyncOutbox = sqliteTable(
  'member_work_sync_outbox',
  {
    teamKey: text('team_key').notNull(),
    teamName: text('team_name').notNull(),
    id: text('id').notNull(),
    memberKey: text('member_key').notNull(),
    memberName: text('member_name').notNull(),
    agendaFingerprint: text('agenda_fingerprint').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull(),
    attemptGeneration: integer('attempt_generation').notNull(),
    claimedBy: text('claimed_by'),
    claimedAt: text('claimed_at'),
    deliveredMessageId: text('delivered_message_id'),
    deliveryState: text('delivery_state'),
    lastError: text('last_error'),
    nextAttemptAt: text('next_attempt_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    workSyncIntent: text('work_sync_intent').notNull(),
    workSyncIntentKey: text('work_sync_intent_key'),
    reviewRequestEventIdsJson: text('review_request_event_ids_json'),
    deliveryDiagnosticsJson: text('delivery_diagnostics_json'),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamName, table.id] }),
    index('idx_mws_outbox_team_key').on(table.teamKey),
    index('idx_mws_outbox_due').on(table.teamName, table.status, table.nextAttemptAt),
    index('idx_mws_outbox_member').on(table.teamName, table.memberKey, table.status),
  ]
);

export const memberWorkSyncMetricEvents = sqliteTable(
  'member_work_sync_metric_events',
  {
    teamKey: text('team_key').notNull(),
    teamName: text('team_name').notNull(),
    id: text('id').notNull(),
    memberKey: text('member_key').notNull(),
    memberName: text('member_name').notNull(),
    kind: text('kind').notNull(),
    recordedAt: text('recorded_at').notNull(),
    eventJson: text('event_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamName, table.id] }),
    index('idx_mws_metric_events_team_key').on(table.teamKey),
    index('idx_mws_metric_events_recent').on(table.teamName, table.recordedAt),
  ]
);

export const applicationCommandLedger = sqliteTable(
  'application_command_ledger',
  {
    namespace: text('namespace').notNull(),
    scopeKey: text('scope_key').notNull(),
    commandId: text('command_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull(),
    failureKind: text('failure_kind'),
    retryable: integer('retryable', { mode: 'boolean' }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    resultHash: text('result_hash'),
    resultJson: text('result_json'),
    metadataJson: text('metadata_json'),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.scopeKey, table.commandId] }),
    uniqueIndex('idx_app_cmd_ledger_idempotency').on(
      table.namespace,
      table.scopeKey,
      table.idempotencyKey
    ),
    index('idx_app_cmd_ledger_status').on(table.namespace, table.scopeKey, table.status),
    index('idx_app_cmd_ledger_operation').on(table.namespace, table.scopeKey, table.operation),
  ]
);

export const durableApplicationCommands = sqliteTable(
  'durable_application_commands',
  {
    commandId: text('command_id').primaryKey(),
    deploymentId: text('deployment_id').notNull(),
    stableActorId: text('stable_actor_id').notNull(),
    commandKind: text('command_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    descriptorId: text('descriptor_id').notNull(),
    descriptorVersion: integer('descriptor_version').notNull(),
    inputSchemaVersion: integer('input_schema_version').notNull(),
    fingerprintVersion: text('fingerprint_version').notNull(),
    effectPlanVersion: integer('effect_plan_version').notNull(),
    fingerprintKeyVersion: text('fingerprint_key_version').notNull(),
    fingerprintDigest: text('fingerprint_digest').notNull(),
    attemptGeneration: integer('attempt_generation').notNull(),
    attemptId: text('attempt_id').notNull(),
    attemptOwnerId: text('attempt_owner_id').notNull(),
    attemptLeaseToken: text('attempt_lease_token').notNull(),
    attemptClaimedAt: text('attempt_claimed_at').notNull(),
    attemptLeaseExpiresAt: text('attempt_lease_expires_at').notNull(),
    state: text('state').notNull(),
    retentionClass: text('retention_class').notNull(),
    auditSessionId: text('audit_session_id'),
    coordinationAttributionJson: text('coordination_attribution_json').notNull(),
    outcomeJson: text('outcome_json'),
    errorCode: text('error_code'),
    errorJson: text('error_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    committedAt: text('committed_at'),
  },
  (table) => [
    uniqueIndex('idx_durable_app_cmd_claim').on(
      table.deploymentId,
      table.stableActorId,
      table.commandKind,
      table.idempotencyKey
    ),
    index('idx_durable_app_cmd_state').on(table.deploymentId, table.state, table.updatedAt),
  ]
);

export const durableApplicationCommandEffects = sqliteTable(
  'durable_application_command_effects',
  {
    commandId: text('command_id')
      .notNull()
      .references(() => durableApplicationCommands.commandId, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    effectId: text('effect_id').notNull(),
    effectVersion: integer('effect_version').notNull(),
    recoveryClass: text('recovery_class').notNull(),
    evidenceSchemaVersion: integer('evidence_schema_version').notNull(),
    state: text('state').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commandId, table.ordinal] }),
    uniqueIndex('idx_durable_app_cmd_effect_id').on(table.commandId, table.effectId),
  ]
);

export const durableApplicationCommandEffectEvidence = sqliteTable(
  'durable_application_command_effect_evidence',
  {
    commandId: text('command_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    sequence: integer('sequence').notNull(),
    outcome: text('outcome').notNull(),
    evidenceSchemaVersion: integer('evidence_schema_version').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commandId, table.ordinal, table.sequence] }),
    foreignKey({
      columns: [table.commandId, table.ordinal],
      foreignColumns: [
        durableApplicationCommandEffects.commandId,
        durableApplicationCommandEffects.ordinal,
      ],
    }).onDelete('restrict'),
    index('idx_durable_app_cmd_evidence_order').on(table.commandId, table.ordinal, table.sequence),
  ]
);

export const durableApplicationCommandOutbox = sqliteTable(
  'durable_application_command_outbox',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    eventId: text('event_id').notNull(),
    commandId: text('command_id')
      .notNull()
      .references(() => durableApplicationCommands.commandId, { onDelete: 'restrict' }),
    deploymentId: text('deployment_id').notNull(),
    eventType: text('event_type').notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    semanticRevision: integer('semantic_revision').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
    deliveryGeneration: integer('delivery_generation').notNull(),
    deliveryOwnerId: text('delivery_owner_id'),
    deliveryLeaseToken: text('delivery_lease_token'),
    deliveryClaimedAt: text('delivery_claimed_at'),
    deliveryLeaseExpiresAt: text('delivery_lease_expires_at'),
    deliveryAcknowledgedAt: text('delivery_acknowledged_at'),
  },
  (table) => [
    uniqueIndex('idx_durable_app_cmd_outbox_event').on(table.eventId),
    uniqueIndex('idx_durable_app_cmd_outbox_command').on(table.commandId),
    index('idx_durable_app_cmd_outbox_sequence').on(table.sequence),
  ]
);

export const coordinationEventJournalMetadata = sqliteTable(
  'coordination_event_journal_metadata',
  {
    deploymentId: text('deployment_id').primaryKey(),
    eventEpoch: text('event_epoch').notNull(),
    retentionFloorSequence: integer('retention_floor_sequence').notNull(),
    highWatermarkSequence: integer('high_watermark_sequence').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_coordination_event_metadata_identity').on(
      table.deploymentId,
      table.eventEpoch
    ),
    check(
      'ck_coordination_event_metadata_watermark',
      sql`${table.retentionFloorSequence} >= 0
        AND ${table.highWatermarkSequence} >= ${table.retentionFloorSequence}`
    ),
  ]
);

export const coordinationEventJournal = sqliteTable(
  'coordination_event_journal',
  {
    deploymentId: text('deployment_id').notNull(),
    eventEpoch: text('event_epoch').notNull(),
    eventSequence: integer('event_sequence').notNull(),
    eventId: text('event_id').notNull(),
    bodyJson: text('body_json').notNull(),
    emittedAt: text('emitted_at').notNull(),
    originCommandId: text('origin_command_id').references(
      () => durableApplicationCommands.commandId,
      { onDelete: 'restrict', onUpdate: 'restrict' }
    ),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.eventEpoch, table.eventSequence] }),
    uniqueIndex('idx_coordination_event_journal_event_id').on(table.eventId),
    index('idx_coordination_event_journal_replay').on(
      table.deploymentId,
      table.eventEpoch,
      table.eventSequence
    ),
    foreignKey({
      columns: [table.deploymentId, table.eventEpoch],
      foreignColumns: [
        coordinationEventJournalMetadata.deploymentId,
        coordinationEventJournalMetadata.eventEpoch,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ]
);

export const snapshotRetentionLeases = sqliteTable(
  'snapshot_retention_leases',
  {
    leaseId: text('lease_id').primaryKey(),
    deploymentId: text('deployment_id').notNull(),
    eventEpoch: text('event_epoch').notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id').notNull(),
    retentionFloorSequence: integer('retention_floor_sequence').notNull(),
    highWatermarkSequence: integer('high_watermark_sequence').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    useToken: text('use_token'),
    useDeadlineAtMs: integer('use_deadline_at_ms'),
    releaseRequested: integer('release_requested').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    index('idx_snapshot_retention_lease_floor').on(
      table.deploymentId,
      table.eventEpoch,
      table.releaseRequested,
      table.expiresAtMs,
      table.highWatermarkSequence
    ),
    foreignKey({
      columns: [table.deploymentId, table.eventEpoch],
      foreignColumns: [
        coordinationEventJournalMetadata.deploymentId,
        coordinationEventJournalMetadata.eventEpoch,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ]
);

export const coordinationBackupRuns = sqliteTable(
  'coordination_backup_runs',
  {
    backupRunId: text('backup_run_id').primaryKey(),
    deploymentId: text('deployment_id').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    fenceCompletionStatus: text('fence_completion_status'),
    recordJson: text('record_json').notNull(),
    requestedAt: text('requested_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_coordination_backup_runs_recoverable').on(
      table.state,
      table.fenceCompletionStatus,
      table.updatedAt
    ),
  ]
);

export const coordinationBackupWriterFences = sqliteTable(
  'coordination_backup_writer_fences',
  {
    deploymentId: text('deployment_id').primaryKey(),
    generation: integer('generation').notNull(),
    admittedRunId: text('admitted_run_id')
      .notNull()
      .references(() => coordinationBackupRuns.backupRunId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    leaseId: text('lease_id').notNull(),
    status: text('status').notNull(),
    disposition: text('disposition'),
    acquiredAt: text('acquired_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [uniqueIndex('idx_coordination_backup_writer_fence_lease').on(table.leaseId)]
);

export const durableApplicationCommandConsumerApplications = sqliteTable(
  'durable_application_command_consumer_applications',
  {
    consumerId: text('consumer_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => durableApplicationCommandOutbox.eventId, { onDelete: 'restrict' }),
    semanticRevision: integer('semantic_revision').notNull(),
    projectionKey: text('projection_key').notNull(),
    stateJson: text('state_json').notNull(),
    appliedAt: text('applied_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.consumerId, table.eventId] }),
    uniqueIndex('idx_durable_app_cmd_consumer_revision').on(
      table.consumerId,
      table.projectionKey,
      table.semanticRevision
    ),
  ]
);

export const durableApplicationCommandConsumerProjections = sqliteTable(
  'durable_application_command_consumer_projections',
  {
    consumerId: text('consumer_id').notNull(),
    projectionKey: text('projection_key').notNull(),
    semanticRevision: integer('semantic_revision').notNull(),
    lastEventId: text('last_event_id').notNull(),
    stateJson: text('state_json').notNull(),
    applicationCount: integer('application_count').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.consumerId, table.projectionKey] }),
    foreignKey({
      columns: [table.consumerId, table.lastEventId],
      foreignColumns: [
        durableApplicationCommandConsumerApplications.consumerId,
        durableApplicationCommandConsumerApplications.eventId,
      ],
    }).onDelete('restrict'),
  ]
);
