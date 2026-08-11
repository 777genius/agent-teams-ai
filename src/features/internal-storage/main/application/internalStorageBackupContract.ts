/** "ATAI" in big-endian ASCII. Backups reject databases owned by another application. */
export const INTERNAL_STORAGE_APPLICATION_ID = 0x41544149;

/** Released SQLite user_version owned by the append-only migration ledger. */
export const INTERNAL_STORAGE_SCHEMA_VERSION = 20;

/** Tables that must survive an internal-storage coordination backup. */
export const INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES = Object.freeze([
  'auth_audit_events',
  'coordination_backup_runs',
  'coordination_backup_writer_fences',
  'coordination_event_journal',
  'coordination_event_journal_metadata',
  'durable_application_command_outbox',
  'durable_application_commands',
  'external_identities',
  'hosted_access_authority',
  'hosted_auth_configuration',
  'hosted_authority_projections',
  'hosted_team_approval_audit',
  'hosted_team_approval_delivery_outbox',
  'hosted_team_approval_idempotency',
  'hosted_team_approval_records',
  'hosted_team_configuration_create_keys',
  'hosted_team_configuration_drafts',
  'hosted_workspace_grants',
  'hosted_workspaces',
  'local_role_assignments',
  'oidc_login_attempts',
  'oidc_logout_replay',
  'operator_sessions',
  'personal_owners',
  'role_snapshots',
  'team_identity_records',
  'team_identity_storage_metadata',
  'team_roster_members',
  'team_roster_storage_metadata',
  'team_rosters',
  'users',
] as const);
