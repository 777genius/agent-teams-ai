import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './teamIdentityStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface InternalStorageMigration {
  version: number;
  statements: string[];
}

/**
 * Versioned via PRAGMA user_version. Statements must stay append-only and
 * idempotent (IF NOT EXISTS) — released versions are never edited, new schema
 * changes get a new version entry. Keep in sync with internalStorageSchema.ts.
 */
const MIGRATIONS: InternalStorageMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS stall_journal_entries (
        team_name TEXT NOT NULL,
        epoch_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        member_name TEXT,
        branch TEXT NOT NULL,
        signal TEXT NOT NULL,
        state TEXT NOT NULL,
        consecutive_scans INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        alerted_at TEXT,
        PRIMARY KEY (team_name, epoch_key)
      )`,
      `CREATE TABLE IF NOT EXISTS store_imports (
        store_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        PRIMARY KEY (store_id, team_name)
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS comment_journal_entries (
        team_name TEXT NOT NULL,
        key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        author TEXT NOT NULL,
        comment_created_at TEXT,
        message_id TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY (team_name, key)
      )`,
      // exists() is an initialization marker with zero-entry semantics, so it
      // needs its own table instead of counting journal rows.
      `CREATE TABLE IF NOT EXISTS comment_journal_teams (
        team_name TEXT PRIMARY KEY,
        initialized_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS member_work_sync_status (
        team_name TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        state TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        provider_id TEXT,
        status_json TEXT NOT NULL,
        PRIMARY KEY (team_name, member_key)
      )`,
      `CREATE TABLE IF NOT EXISTS member_work_sync_report_intents (
        team_name TEXT NOT NULL,
        id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        processed_at TEXT,
        result_code TEXT,
        request_json TEXT NOT NULL,
        PRIMARY KEY (team_name, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mws_report_intents_pending
        ON member_work_sync_report_intents (team_name, status, recorded_at)`,
      `CREATE TABLE IF NOT EXISTS member_work_sync_outbox (
        team_name TEXT NOT NULL,
        id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        agenda_fingerprint TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_generation INTEGER NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        delivered_message_id TEXT,
        delivery_state TEXT,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        work_sync_intent TEXT NOT NULL,
        work_sync_intent_key TEXT,
        review_request_event_ids_json TEXT,
        delivery_diagnostics_json TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (team_name, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mws_outbox_due
        ON member_work_sync_outbox (team_name, status, next_attempt_at)`,
      `CREATE INDEX IF NOT EXISTS idx_mws_outbox_member
        ON member_work_sync_outbox (team_name, member_key, status)`,
      `CREATE TABLE IF NOT EXISTS member_work_sync_metric_events (
        team_name TEXT NOT NULL,
        id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (team_name, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mws_metric_events_recent
        ON member_work_sync_metric_events (team_name, recorded_at)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS application_command_ledger (
        namespace TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_kind TEXT,
        retryable INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        result_hash TEXT,
        result_json TEXT,
        metadata_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT,
        PRIMARY KEY (namespace, scope_key, command_id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_app_cmd_ledger_idempotency
        ON application_command_ledger (namespace, scope_key, idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_app_cmd_ledger_status
        ON application_command_ledger (namespace, scope_key, status)`,
      `CREATE INDEX IF NOT EXISTS idx_app_cmd_ledger_operation
        ON application_command_ledger (namespace, scope_key, operation)`,
    ],
  },
  {
    version: 5,
    statements: [...TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS durable_application_commands (
        command_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        stable_actor_id TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        descriptor_id TEXT NOT NULL,
        descriptor_version INTEGER NOT NULL,
        input_schema_version INTEGER NOT NULL,
        fingerprint_version TEXT NOT NULL,
        effect_plan_version INTEGER NOT NULL,
        fingerprint_key_version TEXT NOT NULL,
        fingerprint_digest TEXT NOT NULL,
        attempt_generation INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_owner_id TEXT NOT NULL,
        attempt_lease_token TEXT NOT NULL,
        attempt_claimed_at TEXT NOT NULL,
        attempt_lease_expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        retention_class TEXT NOT NULL,
        audit_session_id TEXT,
        outcome_json TEXT,
        error_code TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        committed_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_app_cmd_claim
        ON durable_application_commands (
          deployment_id, stable_actor_id, command_kind, idempotency_key
        )`,
      `CREATE INDEX IF NOT EXISTS idx_durable_app_cmd_state
        ON durable_application_commands (deployment_id, state, updated_at)`,
      `CREATE TABLE IF NOT EXISTS durable_application_command_effects (
        command_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        effect_id TEXT NOT NULL,
        effect_version INTEGER NOT NULL,
        recovery_class TEXT NOT NULL,
        evidence_schema_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (command_id, ordinal),
        FOREIGN KEY (command_id) REFERENCES durable_application_commands(command_id)
          ON DELETE RESTRICT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_app_cmd_effect_id
        ON durable_application_command_effects (command_id, effect_id)`,
      `CREATE TABLE IF NOT EXISTS durable_application_command_effect_evidence (
        command_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        evidence_schema_version INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (command_id, ordinal, sequence),
        FOREIGN KEY (command_id, ordinal)
          REFERENCES durable_application_command_effects(command_id, ordinal)
          ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_durable_app_cmd_evidence_order
        ON durable_application_command_effect_evidence (command_id, ordinal, sequence)`,
      `CREATE TABLE IF NOT EXISTS durable_application_command_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        -- Version 6 used publication terminology for delivery bookkeeping.
        -- Version 7 renames these physical columns without changing behavior.
        publication_generation INTEGER NOT NULL,
        publication_publisher_id TEXT,
        publication_lease_token TEXT,
        publication_claimed_at TEXT,
        publication_lease_expires_at TEXT,
        published_at TEXT,
        FOREIGN KEY (command_id) REFERENCES durable_application_commands(command_id)
          ON DELETE RESTRICT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_app_cmd_outbox_event
        ON durable_application_command_outbox (event_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_app_cmd_outbox_command
        ON durable_application_command_outbox (command_id)`,
      `CREATE INDEX IF NOT EXISTS idx_durable_app_cmd_outbox_sequence
        ON durable_application_command_outbox (sequence)`,
    ],
  },
  {
    version: 7,
    statements: [
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN publication_generation TO delivery_generation`,
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN publication_publisher_id TO delivery_owner_id`,
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN publication_lease_token TO delivery_lease_token`,
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN publication_claimed_at TO delivery_claimed_at`,
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN publication_lease_expires_at TO delivery_lease_expires_at`,
      `ALTER TABLE durable_application_command_outbox
        RENAME COLUMN published_at TO delivery_acknowledged_at`,
      // Version 6 events had no typed revision. Start with a valid value so
      // ALTER TABLE remains legal for populated databases, then deterministically
      // rank every legacy projection's events in durable replay order. The
      // projection key is (deployment_id, scope_kind, scope_id); sequence is
      // canonical replay order and event_id is its deterministic tie-breaker.
      `ALTER TABLE durable_application_command_outbox
        ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 1`,
      `WITH ranked_legacy_events AS (
        SELECT
          sequence,
          event_id,
          ROW_NUMBER() OVER (
            PARTITION BY deployment_id, scope_kind, scope_id
            ORDER BY sequence ASC, event_id ASC
          ) AS semantic_revision
        FROM durable_application_command_outbox
      )
      UPDATE durable_application_command_outbox
      SET semantic_revision = (
        SELECT ranked_legacy_events.semantic_revision
        FROM ranked_legacy_events
        WHERE ranked_legacy_events.sequence = durable_application_command_outbox.sequence
          AND ranked_legacy_events.event_id = durable_application_command_outbox.event_id
      )`,
      `CREATE TABLE IF NOT EXISTS durable_application_command_consumer_applications (
        consumer_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        semantic_revision INTEGER NOT NULL,
        projection_key TEXT NOT NULL,
        state_json TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (consumer_id, event_id),
        FOREIGN KEY (event_id) REFERENCES durable_application_command_outbox(event_id)
          ON DELETE RESTRICT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_app_cmd_consumer_revision
        ON durable_application_command_consumer_applications (
          consumer_id, projection_key, semantic_revision
        )`,
      `CREATE TABLE IF NOT EXISTS durable_application_command_consumer_projections (
        consumer_id TEXT NOT NULL,
        projection_key TEXT NOT NULL,
        semantic_revision INTEGER NOT NULL,
        last_event_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        application_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (consumer_id, projection_key),
        FOREIGN KEY (consumer_id, last_event_id)
          REFERENCES durable_application_command_consumer_applications(consumer_id, event_id)
          ON DELETE RESTRICT
      )`,
    ],
  },
];

export const INTERNAL_STORAGE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function readSchemaVersion(db: SqliteDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

export function runInternalStorageMigrations(db: SqliteDatabase): void {
  const current = readSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    const apply = db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}
