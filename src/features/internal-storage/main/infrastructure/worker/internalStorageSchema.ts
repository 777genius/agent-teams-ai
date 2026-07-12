import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    teamName: text('team_name').notNull(),
    memberKey: text('member_key').notNull(),
    memberName: text('member_name').notNull(),
    state: text('state').notNull(),
    evaluatedAt: text('evaluated_at').notNull(),
    providerId: text('provider_id'),
    statusJson: text('status_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamName, table.memberKey] })]
);

export const memberWorkSyncReportIntents = sqliteTable(
  'member_work_sync_report_intents',
  {
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
    index('idx_mws_report_intents_pending').on(table.teamName, table.status, table.recordedAt),
  ]
);

export const memberWorkSyncOutbox = sqliteTable(
  'member_work_sync_outbox',
  {
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
    index('idx_mws_outbox_due').on(table.teamName, table.status, table.nextAttemptAt),
    index('idx_mws_outbox_member').on(table.teamName, table.memberKey, table.status),
  ]
);

export const memberWorkSyncMetricEvents = sqliteTable(
  'member_work_sync_metric_events',
  {
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
