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
