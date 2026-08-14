import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '../../application/internalStorageBackupContract';

import { EXTERNAL_WRITER_OBSERVATION_CONSUME_RECEIPT_MIGRATION } from './externalWriterObservationConsumeReceiptMigration';
import { EXTERNAL_WRITER_RECONCILIATION_MIGRATION } from './externalWriterReconciliationMigration';
import { HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS } from './hostedTeamApprovalAuthorityStorageMigration';
import { HOSTED_TEAM_APPROVAL_IDENTITY_STORAGE_MIGRATIONS } from './hostedTeamApprovalIdentityStorageMigrations';
import { runHostedTeamApprovalMigrationRepair } from './hostedTeamApprovalMigrationRepair';
import { HOSTED_WORKSPACE_GRANT_REVISION_STORAGE_MIGRATION_STATEMENTS } from './hostedWorkspaceGrantRevisionStorageMigration';
import {
  ensureHostedAuthResetColumns,
  migrateHostedWorkspaceAccess,
} from './internalStorageBackupTables';
import { ensureHistoricalV6DurabilityTables } from './internalStorageLegacyDurabilityMigration';
import {
  backfillCoordinationEventJournal,
  backfillMemberWorkSyncTeamKeys,
  ensureCommandCoordinationAttribution,
  ensureMemberWorkSyncTeamKeyIndexes,
} from './internalStorageMigrationBackfills';
import { assertNoActiveBackupFenceForMigration } from './internalStorageMigrationGuards';
import { PROCESS_OWNERSHIP_STORAGE_MIGRATION_STATEMENTS } from './processOwnershipStorageOps';
import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './teamIdentityStorageSchema';
import {
  TEAM_ROSTER_STORAGE_MIGRATION_STATEMENTS,
  verifyTeamRosterStorageMigration,
} from './teamRosterStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

export {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '../../application/internalStorageBackupContract';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
interface InternalStorageMigration {
  version: number;
  statements: string[];
}
/**
 * Versioned via PRAGMA user_version. Released versions are append-only and never edited.
 * CREATE statements stay idempotent where recovery replays them; ALTER statements require the
 * historical source schema selected by user_version. Keep the latest result in sync with internalStorageSchema.ts.
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
  {
    version: 10,
    statements: [...TEAM_ROSTER_STORAGE_MIGRATION_STATEMENTS],
  },
  { version: 11, statements: [...PROCESS_OWNERSHIP_STORAGE_MIGRATION_STATEMENTS] },
  {
    version: 12,
    statements: ['DROP TABLE IF EXISTS snapshot_retention_leases'],
  },
  {
    version: 13,
    statements: [
      `CREATE TABLE IF NOT EXISTS hosted_auth_configuration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('personal', 'oidc')),
        configured_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hosted_access_authority (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        rollback_fence_revision INTEGER NOT NULL CHECK (rollback_fence_revision >= revision)
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS external_identities (
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_authenticated_at INTEGER NOT NULL,
        PRIMARY KEY (issuer, subject),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_external_identities_user
        ON external_identities (user_id)`,
      `CREATE TABLE IF NOT EXISTS personal_owners (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        operator_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS operator_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        authentication_method TEXT NOT NULL CHECK (authentication_method = 'oidc'),
        provider_id TEXT NOT NULL,
        provider_issuer TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        provider_session_id TEXT,
        issued_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        revoked_at INTEGER,
        revocation_reason TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_operator_sessions_provider
        ON operator_sessions (provider_id, provider_issuer, provider_subject, provider_session_id)`,
      `CREATE TABLE IF NOT EXISTS role_snapshots (
        session_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        source TEXT NOT NULL CHECK (source IN ('personal-owner', 'oidc-claim', 'local-cli')),
        captured_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES operator_sessions(session_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS oidc_login_attempts (
        attempt_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        nonce TEXT NOT NULL,
        pkce_verifier_ciphertext TEXT NOT NULL,
        return_to TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oidc_login_attempts_expiry
        ON oidc_login_attempts (expires_at, consumed_at)`,
      `CREATE TABLE IF NOT EXISTS oidc_logout_replay (
        provider_id TEXT NOT NULL,
        issuer TEXT NOT NULL,
        jti TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, issuer, jti)
      )`,
      `CREATE TABLE IF NOT EXISTS hosted_workspaces (
        workspace_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        registered_at INTEGER NOT NULL,
        registered_by TEXT,
        FOREIGN KEY (registered_by) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS auth_audit_events (
        event_id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        user_id TEXT,
        session_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
        source_ip_hash TEXT,
        details_json TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_audit_occurred
        ON auth_audit_events (occurred_at, event_id)`,
    ],
  },
  {
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS local_role_assignments (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        assigned_at INTEGER NOT NULL,
        assigned_by TEXT NOT NULL CHECK (assigned_by = 'local-cli'),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
      )`,
    ],
  },
  {
    version: 15,
    // Recovery tolerates user_version restored behind already-durable additive columns.
    statements: [],
  },
  {
    version: 16,
    // Recovery may restore current table shapes with a historical user_version.
    statements: [],
  },
  {
    version: 17,
    statements: [
      `CREATE TABLE IF NOT EXISTS hosted_authority_projections (
        deployment_id TEXT NOT NULL,
        projection_kind TEXT NOT NULL,
        projection_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        last_command_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, projection_kind, projection_key),
        FOREIGN KEY (last_command_id) REFERENCES durable_application_commands(command_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT
      )`,
    ],
  },
  {
    version: 18,
    statements: [...HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS],
  },
  {
    version: 19,
    statements: [
      `CREATE TABLE IF NOT EXISTS hosted_team_configuration_drafts (workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'deleted')), revision_ordinal INTEGER NOT NULL CHECK (revision_ordinal > 0), revision_token TEXT NOT NULL, metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)), members_json TEXT NOT NULL CHECK (json_valid(members_json)), created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (workspace_id, team_id))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_team_configuration_team_id
        ON hosted_team_configuration_drafts (team_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_team_configuration_revision_token ON hosted_team_configuration_drafts (revision_token)`,
      `CREATE TABLE IF NOT EXISTS hosted_team_configuration_create_keys (workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, team_id TEXT NOT NULL, initial_revision TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (workspace_id, idempotency_key), FOREIGN KEY (workspace_id, team_id) REFERENCES hosted_team_configuration_drafts(workspace_id, team_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    ],
  },
  {
    version: 20,
    statements: [...HOSTED_WORKSPACE_GRANT_REVISION_STORAGE_MIGRATION_STATEMENTS],
  },
  ...HOSTED_TEAM_APPROVAL_IDENTITY_STORAGE_MIGRATIONS,
  {
    version: 25,
    statements: [
      `CREATE TABLE IF NOT EXISTS external_writer_observation_checkpoints (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
        PRIMARY KEY (deployment_id, observer_id)
      )`,
      `CREATE TABLE IF NOT EXISTS external_writer_observation_retired_team_floors (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        identity_checksum TEXT NOT NULL,
        tombstoned_at TEXT NOT NULL,
        writer_epoch INTEGER CHECK (writer_epoch IS NULL OR writer_epoch >= 1),
        last_observation_sequence INTEGER NOT NULL CHECK (last_observation_sequence >= 0),
        observation_watermark INTEGER NOT NULL CHECK (
          observation_watermark >= 0 AND observation_watermark <= last_observation_sequence
        ),
        PRIMARY KEY (deployment_id, observer_id, team_id),
        FOREIGN KEY (team_id) REFERENCES team_identity_records(team_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT
      )`,
      `CREATE TRIGGER IF NOT EXISTS external_writer_retired_floor_no_update
       BEFORE UPDATE ON external_writer_observation_retired_team_floors
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-retired-floor-immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS external_writer_retired_floor_no_delete
       BEFORE DELETE ON external_writer_observation_retired_team_floors
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-retired-floor-immutable'); END`,
      `CREATE TABLE IF NOT EXISTS external_writer_observation_handoff_eligibility (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        expected_checkpoint_revision INTEGER NOT NULL CHECK (expected_checkpoint_revision > 0),
        handoff_id TEXT NOT NULL CHECK (
          length(handoff_id) BETWEEN 1 AND 128
          AND handoff_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
        checkpoint_sha256 TEXT NOT NULL CHECK (
          length(checkpoint_sha256) = 64
          AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        captured_sequence INTEGER NOT NULL CHECK (captured_sequence >= 0),
        persisted_watermark INTEGER NOT NULL CHECK (persisted_watermark >= 0),
        old_catalog_token TEXT NOT NULL CHECK (
          length(old_catalog_token) = 64
          AND old_catalog_token NOT GLOB '*[^0-9a-f]*'
        ),
        target_catalog_token TEXT NOT NULL CHECK (
          length(target_catalog_token) = 64
          AND target_catalog_token NOT GLOB '*[^0-9a-f]*'
        ),
        next_registration_digest TEXT NOT NULL CHECK (
          length(next_registration_digest) = 64
          AND next_registration_digest NOT GLOB '*[^0-9a-f]*'
        ),
        candidate_digest TEXT NOT NULL CHECK (
          length(candidate_digest) = 64
          AND candidate_digest NOT GLOB '*[^0-9a-f]*'
        ),
        candidates_json TEXT NOT NULL CHECK (
          json_valid(candidates_json)
          AND json_type(candidates_json) = 'array'
          AND json_array_length(candidates_json) <= 1024
          AND length(CAST(candidates_json AS BLOB)) <= 67108864
        ),
        retained_registrations_json TEXT NOT NULL CHECK (
          json_valid(retained_registrations_json)
          AND json_type(retained_registrations_json) = 'array'
          AND json_array_length(retained_registrations_json) <= 100000
          AND length(CAST(retained_registrations_json AS BLOB)) <= 67108864
        ),
        removed_registrations_json TEXT NOT NULL CHECK (
          json_valid(removed_registrations_json)
          AND json_type(removed_registrations_json) = 'array'
          AND json_array_length(removed_registrations_json) <= 100000
          AND length(CAST(removed_registrations_json AS BLOB)) <= 67108864
        ),
        created_at TEXT NOT NULL,
        CHECK (captured_sequence = persisted_watermark),
        PRIMARY KEY (deployment_id, observer_id),
        FOREIGN KEY (deployment_id, observer_id)
          REFERENCES external_writer_observation_checkpoints(deployment_id, observer_id)
          ON DELETE CASCADE ON UPDATE RESTRICT
      )`,
      `CREATE TRIGGER IF NOT EXISTS external_writer_handoff_no_update
       BEFORE UPDATE ON external_writer_observation_handoff_eligibility
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-handoff-immutable'); END`,
    ],
  },
  EXTERNAL_WRITER_OBSERVATION_CONSUME_RECEIPT_MIGRATION,
  EXTERNAL_WRITER_RECONCILIATION_MIGRATION,
];
export function readSchemaVersion(db: SqliteDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}
export function runInternalStorageMigrations(db: SqliteDatabase): void {
  if (MIGRATIONS.at(-1)?.version !== INTERNAL_STORAGE_SCHEMA_VERSION) {
    throw new Error('internal-storage-schema-contract-mismatch');
  }
  const current = readSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    const apply = db.transaction(() => {
      if (migration.version >= 11 && migration.version <= INTERNAL_STORAGE_SCHEMA_VERSION) {
        assertNoActiveBackupFenceForMigration(db, migration.version);
      }
      if (migration.version === 7) ensureHistoricalV6DurabilityTables(db, v6Statements());
      if (migration.version === 8) {
        ensureHistoricalV6DurabilityTables(db, v6Statements());
        ensureCommandCoordinationAttribution(db);
      }
      if (migration.version === 15) ensureHostedAuthResetColumns(db);
      if (migration.version === 16) migrateHostedWorkspaceAccess(db);
      const approvalMigrationHandled = runHostedTeamApprovalMigrationRepair(db, migration.version);
      if (!approvalMigrationHandled) {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
      }
      if (migration.version === 8) backfillCoordinationEventJournal(db);
      if (migration.version === 9) backfillMemberWorkSyncTeamKeys(db);
      if (migration.version === 10) verifyTeamRosterStorageMigration(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
  if (current >= 9) {
    db.transaction(() => ensureMemberWorkSyncTeamKeyIndexes(db))();
  }
}
function v6Statements(): readonly string[] {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 6);
  if (!migration) throw new Error('internal-storage-v6-migration-missing');
  return migration.statements;
}
