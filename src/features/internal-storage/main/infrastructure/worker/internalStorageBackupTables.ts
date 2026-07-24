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
  'team_roster_members',
  'team_roster_storage_metadata',
  'team_rosters',
] as const);
