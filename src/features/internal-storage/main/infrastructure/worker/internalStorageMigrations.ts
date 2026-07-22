import { normalizeMemberWorkSyncTeamKey } from '../../../contracts/memberWorkSyncTeamIdentity';

import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './teamIdentityStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

/** "ATAI" in big-endian ASCII. Backups reject databases owned by another application. */
export const INTERNAL_STORAGE_APPLICATION_ID = 0x41544149;
export const INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES = Object.freeze([
  'coordination_backup_runs',
  'coordination_backup_writer_fences',
  'coordination_event_journal',
  'coordination_event_journal_metadata',
  'durable_application_command_outbox',
  'durable_application_commands',
  'snapshot_retention_leases',
  'team_identity_records',
  'team_identity_storage_metadata',
] as const);

interface InternalStorageMigration {
  version: number;
  statements: string[];
}

/**
 * Versioned via PRAGMA user_version. Released versions are append-only: new
 * schema changes get a new version entry and existing entries are never edited.
 * CREATE statements stay idempotent where recovery replays them; ALTER
 * statements intentionally require the true historical source schema selected
 * by user_version. Keep the latest result in sync with internalStorageSchema.ts.
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
  {
    version: 8,
    statements: [
      `PRAGMA application_id = ${INTERNAL_STORAGE_APPLICATION_ID}`,
      `CREATE TABLE IF NOT EXISTS coordination_event_journal_metadata (
        deployment_id TEXT PRIMARY KEY,
        event_epoch TEXT NOT NULL,
        retention_floor_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (retention_floor_sequence >= 0),
        high_watermark_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (high_watermark_sequence >= retention_floor_sequence),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (deployment_id, event_epoch)
      )`,
      `CREATE TABLE IF NOT EXISTS coordination_event_journal (
        deployment_id TEXT NOT NULL,
        event_epoch TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
        event_id TEXT NOT NULL UNIQUE,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        emitted_at TEXT NOT NULL,
        origin_command_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, event_epoch, event_sequence),
        FOREIGN KEY (deployment_id, event_epoch)
          REFERENCES coordination_event_journal_metadata(deployment_id, event_epoch)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        FOREIGN KEY (origin_command_id)
          REFERENCES durable_application_commands(command_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_coordination_event_journal_replay
        ON coordination_event_journal (deployment_id, event_epoch, event_sequence)`,
      `CREATE TABLE IF NOT EXISTS snapshot_retention_leases (
        lease_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        event_epoch TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        retention_floor_sequence INTEGER NOT NULL CHECK (retention_floor_sequence >= 0),
        high_watermark_sequence INTEGER NOT NULL
          CHECK (high_watermark_sequence >= retention_floor_sequence),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
        use_token TEXT,
        use_deadline_at_ms INTEGER,
        release_requested INTEGER NOT NULL DEFAULT 0 CHECK (release_requested IN (0, 1)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
        FOREIGN KEY (deployment_id, event_epoch)
          REFERENCES coordination_event_journal_metadata(deployment_id, event_epoch)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CHECK ((use_token IS NULL AND use_deadline_at_ms IS NULL)
          OR (use_token IS NOT NULL AND use_deadline_at_ms IS NOT NULL))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_retention_lease_floor
        ON snapshot_retention_leases (
          deployment_id, event_epoch, release_requested, expires_at_ms, high_watermark_sequence
        )`,
      `CREATE TABLE IF NOT EXISTS coordination_backup_runs (
        backup_run_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        fence_completion_status TEXT,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_coordination_backup_runs_recoverable
        ON coordination_backup_runs (state, fence_completion_status, updated_at)`,
      `CREATE TABLE IF NOT EXISTS coordination_backup_writer_fences (
        deployment_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation > 0),
        admitted_run_id TEXT NOT NULL,
        lease_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'released', 'operator_required')),
        disposition TEXT CHECK (disposition IN ('committed', 'aborted', 'operator_required')),
        acquired_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (admitted_run_id) REFERENCES coordination_backup_runs(backup_run_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CHECK ((status = 'active' AND disposition IS NULL AND completed_at IS NULL)
          OR (status <> 'active' AND disposition IS NOT NULL AND completed_at IS NOT NULL))
      )`,
    ],
  },
  {
    version: 9,
    statements: [
      `ALTER TABLE member_work_sync_status
        ADD COLUMN team_key TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE member_work_sync_report_intents
        ADD COLUMN team_key TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE member_work_sync_outbox
        ADD COLUMN team_key TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE member_work_sync_metric_events
        ADD COLUMN team_key TEXT NOT NULL DEFAULT ''`,
      `CREATE INDEX IF NOT EXISTS idx_mws_status_team_key
        ON member_work_sync_status (team_key)`,
      `CREATE INDEX IF NOT EXISTS idx_mws_report_intents_team_key
        ON member_work_sync_report_intents (team_key)`,
      `CREATE INDEX IF NOT EXISTS idx_mws_outbox_team_key
        ON member_work_sync_outbox (team_key)`,
      `CREATE INDEX IF NOT EXISTS idx_mws_metric_events_team_key
        ON member_work_sync_metric_events (team_key)`,
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
      if (migration.version === 7) ensureHistoricalV6DurabilityTables(db);
      if (migration.version === 8) {
        ensureHistoricalV6DurabilityTables(db);
        ensureCommandCoordinationAttribution(db);
      }
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      if (migration.version === 8) backfillCoordinationEventJournal(db);
      if (migration.version === 9) backfillMemberWorkSyncTeamKeys(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
  if (current >= 9) {
    db.transaction(() => ensureMemberWorkSyncTeamKeyIndexes(db))();
  }
}

const MEMBER_WORK_SYNC_TEAM_KEY_TABLES = [
  'member_work_sync_status',
  'member_work_sync_report_intents',
  'member_work_sync_outbox',
  'member_work_sync_metric_events',
] as const;

/** Runs inside the v9 migration transaction and deliberately uses the shared JS contract. */
function backfillMemberWorkSyncTeamKeys(db: SqliteDatabase): void {
  for (const tableName of MEMBER_WORK_SYNC_TEAM_KEY_TABLES) {
    const rows = db.prepare(`SELECT rowid, team_name FROM ${tableName}`).all() as Array<{
      readonly rowid: number;
      readonly team_name: string;
    }>;
    const update = db.prepare(`UPDATE ${tableName} SET team_key = ? WHERE rowid = ?`);
    for (const row of rows) {
      update.run(normalizeMemberWorkSyncTeamKey(row.team_name), row.rowid);
    }
  }
}

function ensureMemberWorkSyncTeamKeyIndexes(db: SqliteDatabase): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_status_team_key
    ON member_work_sync_status (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_report_intents_team_key
    ON member_work_sync_report_intents (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_outbox_team_key
    ON member_work_sync_outbox (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_metric_events_team_key
    ON member_work_sync_metric_events (team_key)`);
}

function ensureHistoricalV6DurabilityTables(db: SqliteDatabase): void {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 6);
  if (!migration) throw new Error('internal-storage-v6-migration-missing');
  for (const statement of migration.statements) db.exec(statement);
  const crossDeployment = db
    .prepare(
      `SELECT command_id
       FROM durable_application_command_outbox
       GROUP BY command_id
       HAVING COUNT(DISTINCT deployment_id) <> 1
       LIMIT 1`
    )
    .get() as { readonly command_id: string } | undefined;
  if (crossDeployment) throw new Error('internal-storage-legacy-command-deployment-ambiguous');
  // One historical v6 fixture shipped the outbox without its command parent
  // table. Preserve those events under explicit recovery provenance instead of
  // inventing an operator or silently dropping rows during the v8 journal import.
  db.exec(
    `INSERT INTO durable_application_commands (
       command_id, deployment_id, stable_actor_id, command_kind, idempotency_key,
       descriptor_id, descriptor_version, input_schema_version, fingerprint_version,
       effect_plan_version, fingerprint_key_version, fingerprint_digest,
       attempt_generation, attempt_id, attempt_owner_id, attempt_lease_token,
       attempt_claimed_at, attempt_lease_expires_at, state, retention_class,
       audit_session_id, outcome_json, error_code, error_json,
       created_at, updated_at, committed_at
     )
     SELECT
       outbox.command_id,
       MIN(outbox.deployment_id),
       'legacy-unattributed:' || outbox.command_id,
       'legacy_recovery',
       'legacy-event:' || outbox.command_id,
       'legacy-recovery-v1', 1, 1, 'hmac-sha256-ld-v1', 1,
       'legacy-unavailable',
       '0000000000000000000000000000000000000000000000000000000000000000',
       1,
       'legacy-attempt:' || outbox.command_id,
       'legacy-recovery',
       'legacy-lease:' || outbox.command_id,
       MIN(outbox.created_at),
       '9999-12-31T23:59:59.999Z',
       'committed',
       'legacy_recovery',
       NULL,
       json_object('provenance', 'legacy_recovery_v1'),
       NULL,
       NULL,
       MIN(outbox.created_at),
       MAX(outbox.created_at),
       MAX(outbox.created_at)
     FROM durable_application_command_outbox AS outbox
     WHERE NOT EXISTS (
       SELECT 1 FROM durable_application_commands AS commands
       WHERE commands.command_id = outbox.command_id
     )
     GROUP BY outbox.command_id`
  );
  db.exec(
    `INSERT INTO durable_application_command_effects (
       command_id, ordinal, effect_id, effect_version, recovery_class,
       evidence_schema_version, state, updated_at
     )
     SELECT
       commands.command_id,
       0,
       'legacy-recovery:' || commands.command_id,
       1,
       'transactional_local',
       1,
       'observed_succeeded',
       commands.updated_at
     FROM durable_application_commands AS commands
     WHERE commands.descriptor_id = 'legacy-recovery-v1'
       AND commands.stable_actor_id = 'legacy-unattributed:' || commands.command_id
       AND NOT EXISTS (
         SELECT 1 FROM durable_application_command_effects AS effects
         WHERE effects.command_id = commands.command_id
       )`
  );
  db.exec(
    `INSERT INTO durable_application_command_effect_evidence (
       command_id, ordinal, sequence, outcome, evidence_schema_version,
       evidence_json, recorded_at
     )
     SELECT
       commands.command_id,
       0,
       1,
       'observed_succeeded',
       1,
       json_object('provenance', 'legacy_recovery_v1'),
       commands.updated_at
     FROM durable_application_commands AS commands
     WHERE commands.descriptor_id = 'legacy-recovery-v1'
       AND commands.stable_actor_id = 'legacy-unattributed:' || commands.command_id
       AND NOT EXISTS (
         SELECT 1 FROM durable_application_command_effect_evidence AS evidence
         WHERE evidence.command_id = commands.command_id AND evidence.ordinal = 0
       )`
  );
}

function ensureCommandCoordinationAttribution(db: SqliteDatabase): void {
  const columns = db.pragma('table_info(durable_application_commands)') as {
    readonly name: string;
  }[];
  if (!columns.some((column) => column.name === 'coordination_attribution_json')) {
    db.exec(
      `ALTER TABLE durable_application_commands
       ADD COLUMN coordination_attribution_json TEXT NOT NULL
       DEFAULT '{"actor":{"actorRef":"legacy-command:unknown","kind":"recovery"},"provenance":"legacy_recovery_v1"}'
       CHECK (json_valid(coordination_attribution_json))`
    );
  }
  db.exec(
    `UPDATE durable_application_commands
     SET coordination_attribution_json = json_object(
       'actor', json_object(
         'actorRef', 'legacy-command:' || stable_actor_id,
         'kind', 'recovery'
       ),
       'provenance', 'legacy_recovery_v1'
     )
     WHERE json_extract(coordination_attribution_json, '$.provenance') = 'legacy_recovery_v1'`
  );
}

interface LegacyOutboxEventRow {
  readonly deployment_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly command_id: string;
  readonly event_type: string;
  readonly scope_kind: string;
  readonly scope_id: string;
  readonly schema_version: number;
  readonly payload_json: string;
  readonly created_at: string;
  readonly coordination_attribution_json: string;
}

const LEGACY_EVENT_SCOPE_KINDS = new Set([
  'instance',
  'catalog',
  'workspace',
  'team',
  'run',
  'session',
]);

/** Imports the v6/v7 outbox into the one journal using runtime-identical canonical JSON. */
function backfillCoordinationEventJournal(db: SqliteDatabase): void {
  const mismatchedCommand = db
    .prepare(
      `SELECT outbox.command_id
       FROM durable_application_command_outbox AS outbox
       JOIN durable_application_commands AS commands ON commands.command_id = outbox.command_id
       WHERE commands.deployment_id <> outbox.deployment_id
       LIMIT 1`
    )
    .get() as { readonly command_id: string } | undefined;
  if (mismatchedCommand) throw new Error('internal-storage-command-outbox-deployment-mismatch');

  const rows = db
    .prepare(
      `SELECT
         outbox.deployment_id,
         outbox.sequence,
         outbox.event_id,
         outbox.command_id,
         outbox.event_type,
         outbox.scope_kind,
         outbox.scope_id,
         outbox.schema_version,
         outbox.payload_json,
         outbox.created_at,
         commands.coordination_attribution_json
       FROM durable_application_command_outbox AS outbox
       JOIN durable_application_commands AS commands ON commands.command_id = outbox.command_id
       ORDER BY outbox.deployment_id ASC, outbox.sequence ASC, outbox.event_id ASC`
    )
    .all() as LegacyOutboxEventRow[];

  const deployments = db
    .prepare(
      `SELECT
         deployment_id,
         COUNT(*) AS event_count,
         MIN(created_at) AS created_at,
         MAX(created_at) AS updated_at
       FROM durable_application_command_outbox
       GROUP BY deployment_id
       ORDER BY deployment_id ASC`
    )
    .all() as {
    readonly deployment_id: string;
    readonly event_count: number;
    readonly created_at: string;
    readonly updated_at: string;
  }[];
  for (const deployment of deployments) {
    const result = db
      .prepare(
        `INSERT INTO coordination_event_journal_metadata (
           deployment_id, event_epoch, retention_floor_sequence,
           high_watermark_sequence, created_at, updated_at
         ) VALUES (?, 'epoch-initial-v1', 0, ?, ?, ?)
         ON CONFLICT(deployment_id) DO NOTHING`
      )
      .run(
        deployment.deployment_id,
        deployment.event_count,
        deployment.created_at,
        deployment.updated_at
      );
    if (result.changes === 0) {
      const existing = db
        .prepare(
          `SELECT event_epoch, retention_floor_sequence, high_watermark_sequence
           FROM coordination_event_journal_metadata WHERE deployment_id = ?`
        )
        .get(deployment.deployment_id) as {
        readonly event_epoch: string;
        readonly retention_floor_sequence: number;
        readonly high_watermark_sequence: number;
      };
      if (
        existing.event_epoch !== 'epoch-initial-v1' ||
        existing.retention_floor_sequence !== 0 ||
        existing.high_watermark_sequence !== deployment.event_count
      ) {
        throw new Error('internal-storage-event-journal-metadata-backfill-conflict');
      }
    }
  }

  let deploymentId: string | null = null;
  let eventSequence = 0;
  for (const row of rows) {
    if (row.deployment_id !== deploymentId) {
      deploymentId = row.deployment_id;
      eventSequence = 0;
    }
    eventSequence += 1;
    const bodyJson = legacyOutboxEventBodyJson(row);
    const existing = db
      .prepare(
        `SELECT deployment_id, event_epoch, event_sequence, body_json
         FROM coordination_event_journal
         WHERE event_id = ?`
      )
      .get(row.event_id) as
      | {
          readonly deployment_id: string;
          readonly event_epoch: string;
          readonly event_sequence: number;
          readonly body_json: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.deployment_id !== row.deployment_id ||
        existing.event_epoch !== 'epoch-initial-v1' ||
        existing.event_sequence !== eventSequence ||
        existing.body_json !== bodyJson
      ) {
        throw new Error('internal-storage-event-journal-backfill-conflict');
      }
      continue;
    }
    db.prepare(
      `INSERT INTO coordination_event_journal (
         deployment_id, event_epoch, event_sequence, event_id, body_json,
         emitted_at, origin_command_id, created_at
       ) VALUES (?, 'epoch-initial-v1', ?, ?, ?, ?, ?, ?)`
    ).run(
      row.deployment_id,
      eventSequence,
      row.event_id,
      bodyJson,
      row.created_at,
      row.command_id,
      row.created_at
    );
  }
}

function legacyOutboxEventBodyJson(row: LegacyOutboxEventRow): string {
  if (row.schema_version !== 1 || !LEGACY_EVENT_SCOPE_KINDS.has(row.scope_kind)) {
    throw new Error('internal-storage-legacy-outbox-event-contract-invalid');
  }
  const attribution = parseMigrationJsonObject(row.coordination_attribution_json);
  const actor = attribution.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new Error('internal-storage-legacy-outbox-attribution-invalid');
  }
  const runId = row.scope_kind === 'run' ? row.scope_id : attribution.runId;
  if (runId !== undefined && typeof runId !== 'string') {
    throw new Error('internal-storage-legacy-outbox-run-id-invalid');
  }
  return canonicalMigrationJson({
    actor,
    eventId: row.event_id,
    emittedAt: row.created_at,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as unknown,
    ...(runId === undefined ? {} : { runId }),
    schemaVersion: row.schema_version,
    scope: { kind: row.scope_kind, scopeId: row.scope_id },
    ...(row.scope_kind === 'team' ? { teamId: row.scope_id } : {}),
    ...(row.scope_kind === 'workspace' ? { workspaceId: row.scope_id } : {}),
  });
}

function parseMigrationJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('internal-storage-migration-json-object-invalid');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function canonicalMigrationJson(value: unknown): string {
  return JSON.stringify(normalizeMigrationJson(value));
}

function normalizeMigrationJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('internal-storage-migration-json-number-invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeMigrationJson);
  if (typeof value !== 'object') throw new Error('internal-storage-migration-json-value-invalid');
  const record = value as Readonly<Record<string, unknown>>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    if (record[key] !== undefined) normalized[key] = normalizeMigrationJson(record[key]);
  }
  return normalized;
}
