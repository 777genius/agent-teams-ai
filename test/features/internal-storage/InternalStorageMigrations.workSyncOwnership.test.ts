import {
  INTERNAL_STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  runInternalStorageMigrations,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

// Historical SQL fixtures are independent of the migrator being tested. Indentation only
// is normalized: v5 = e06c8023; main v6/v7 = 9d96267e. Do not build these with current migrations.
const LEGACY_V5_SCHEMA = `
CREATE TABLE IF NOT EXISTS stall_journal_entries (
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
);
CREATE TABLE IF NOT EXISTS store_imports (
  store_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  PRIMARY KEY (store_id, team_name)
);
CREATE TABLE IF NOT EXISTS comment_journal_entries (
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
);
CREATE TABLE IF NOT EXISTS comment_journal_teams (
  team_name TEXT PRIMARY KEY,
  initialized_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_work_sync_status (
  team_name TEXT NOT NULL,
  member_key TEXT NOT NULL,
  member_name TEXT NOT NULL,
  state TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  provider_id TEXT,
  status_json TEXT NOT NULL,
  PRIMARY KEY (team_name, member_key)
);
CREATE TABLE IF NOT EXISTS member_work_sync_report_intents (
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
);
CREATE INDEX IF NOT EXISTS idx_mws_report_intents_pending
  ON member_work_sync_report_intents (team_name, status, recorded_at);
CREATE TABLE IF NOT EXISTS member_work_sync_outbox (
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
);
CREATE INDEX IF NOT EXISTS idx_mws_outbox_due
  ON member_work_sync_outbox (team_name, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_mws_outbox_member
  ON member_work_sync_outbox (team_name, member_key, status);
CREATE TABLE IF NOT EXISTS member_work_sync_metric_events (
  team_name TEXT NOT NULL,
  id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  member_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (team_name, id)
);
CREATE INDEX IF NOT EXISTS idx_mws_metric_events_recent
  ON member_work_sync_metric_events (team_name, recorded_at);
CREATE TABLE IF NOT EXISTS application_command_ledger (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_cmd_ledger_idempotency
  ON application_command_ledger (namespace, scope_key, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_app_cmd_ledger_status
  ON application_command_ledger (namespace, scope_key, status);
CREATE INDEX IF NOT EXISTS idx_app_cmd_ledger_operation
  ON application_command_ledger (namespace, scope_key, operation);
ALTER TABLE member_work_sync_report_intents ADD COLUMN journal_json TEXT;
`;
const LEGACY_V6_V7_SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_team_templates (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  description TEXT,
  schema_version INTEGER NOT NULL,
  team_prompt TEXT NOT NULL,
  members_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_team_templates_name_normalized
  ON custom_team_templates (name_normalized);
ALTER TABLE custom_team_templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
UPDATE custom_team_templates SET revision = 1 WHERE revision IS NULL;
`;

const databases: InstanceType<typeof Database>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function legacyDatabase(version: 5 | 7): InstanceType<typeof Database> {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(LEGACY_V5_SCHEMA);
  if (version === 7) database.exec(LEGACY_V6_V7_SCHEMA);
  database.pragma('user_version = ' + version);
  database.exec(
    `INSERT INTO member_work_sync_status
       (team_name, member_key, member_name, state, evaluated_at, provider_id, status_json)
     VALUES ('sandbox', 'alice', 'Alice', 'caught_up', '2026-11-22T10:00:00Z', 'opencode',
       ' { "teamName": "sandbox", "memberName": "Alice", "legacy": "данные" } ');
     INSERT INTO member_work_sync_report_intents
       (team_name, id, member_key, member_name, status, reason, recorded_at, request_json, journal_json)
     VALUES ('sandbox', 'report-1', 'alice', 'Alice', 'accepted', 'legacy',
       '2026-11-22T10:00:00Z', ' { "message": "keep request bytes" } ',
       ' { "receipt": "keep journal bytes" } ');
     INSERT INTO member_work_sync_outbox
       (team_name, id, member_key, member_name, agenda_fingerprint, payload_hash,
        status, attempt_generation, claimed_by, claimed_at, created_at, updated_at,
        work_sync_intent, payload_json)
     VALUES ('sandbox', 'outbox-1', 'alice', 'Alice', 'agenda-1', 'payload-1',
       'claimed', 4, 'original-worker', '2026-11-22T10:00:00Z',
       '2026-11-22T09:00:00Z', '2026-11-22T10:00:00Z', 'agenda_sync',
       ' { "text": "do not replay claimed delivery" } ');
     INSERT INTO member_work_sync_metric_events
       (team_name, id, member_key, member_name, kind, recorded_at, event_json)
     VALUES ('sandbox', 'event-1', 'alice', 'Alice', 'report_accepted',
       '2026-11-22T10:00:00Z', ' { "text": "keep metric bytes" } ');
     INSERT INTO store_imports (store_id, team_name, imported_at, entry_count)
     VALUES ('member-work-sync', 'sandbox', '2026-11-22T10:00:00Z', 3);`
  );
  return database;
}

function workSyncRows(database: InstanceType<typeof Database>) {
  const tables = [
    'member_work_sync_status',
    'member_work_sync_report_intents',
    'member_work_sync_outbox',
    'member_work_sync_metric_events',
    'store_imports',
  ] as const;
  return Object.fromEntries(
    tables.map((table) => [table, database.prepare('SELECT * FROM ' + table).all()])
  );
}

function insertTemplate(database: InstanceType<typeof Database>, id = 'saved-template'): void {
  database.prepare(
    `INSERT INTO custom_team_templates
       (id, name, name_normalized, description, schema_version, team_prompt,
        members_json, content_hash, created_at)
     VALUES (?, 'Saved template', 'saved template', 'Preserve this template', 1,
       'Keep prompt bytes', ' [{"name":"Alice","role":"reviewer"}] ',
       'legacy-content-hash', '2026-11-22T10:00:00Z')`
  ).run(id);
}

describe('WorkSync ownership migration compatibility', () => {
  it.each([5, 7] as const)(
    'upgrades the historical v%i database without skipping template DDL or losing rows',
    (version) => {
      const database = legacyDatabase(version);
      expect(readSchemaVersion(database)).toBe(version);
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_work_sync_primary_incarnations'"
      ).all()).toEqual([]);
      const originalWorkSync = workSyncRows(database);
      let originalTemplate: unknown;
      if (version === 7) {
        insertTemplate(database);
        database.exec("UPDATE custom_team_templates SET revision = 7 WHERE id = 'saved-template'");
        originalTemplate = database.prepare('SELECT * FROM custom_team_templates').get();
        expect(originalTemplate).toMatchObject({ id: 'saved-template', revision: 7 });
      } else {
        expect(database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_team_templates'"
        ).all()).toEqual([]);
      }

      runInternalStorageMigrations(database);

      expect(readSchemaVersion(database)).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
      expect(readSchemaVersion(database)).toBeGreaterThanOrEqual(8);
      expect(workSyncRows(database)).toEqual(originalWorkSync);
      expect(database.prepare('SELECT * FROM member_work_sync_primary_incarnations').all())
        .toEqual([]);
      expect(database.prepare('PRAGMA table_info(custom_team_templates)').all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: 'revision', type: 'INTEGER', notnull: 1, dflt_value: '1',
          }),
        ]));
      if (version === 5) {
        // The backported v6 CREATE and v7 ALTER must actually run, not just advance user_version.
        insertTemplate(database);
        originalTemplate = database.prepare('SELECT * FROM custom_team_templates').get();
        expect(originalTemplate).toMatchObject({
          id: 'saved-template',
          team_prompt: 'Keep prompt bytes',
          members_json: ' [{"name":"Alice","role":"reviewer"}] ',
          revision: 1,
        });
      } else {
        expect(database.prepare('SELECT * FROM custom_team_templates').get())
          .toEqual(originalTemplate);
      }
      expect(() => insertTemplate(database, 'duplicate-template'))
        .toThrow(/UNIQUE constraint failed/);

      database.prepare(
        'INSERT INTO member_work_sync_primary_incarnations (team_key, incarnation) VALUES (?, ?)'
      ).run('sandbox', 'inc-1');
      runInternalStorageMigrations(database);

      expect(readSchemaVersion(database)).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
      expect(workSyncRows(database)).toEqual(originalWorkSync);
      expect(database.prepare('SELECT * FROM custom_team_templates').all())
        .toEqual([originalTemplate]);
      expect(database.prepare('SELECT * FROM member_work_sync_primary_incarnations').all())
        .toEqual([{ team_key: 'sandbox', incarnation: 'inc-1' }]);
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    }
  );
});
