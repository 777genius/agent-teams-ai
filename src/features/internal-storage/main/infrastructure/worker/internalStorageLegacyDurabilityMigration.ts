import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export function ensureHistoricalV6DurabilityTables(
  db: SqliteDatabase,
  statements: readonly string[]
): void {
  for (const statement of statements) db.exec(statement);
  const crossDeployment = db
    .prepare(
      `SELECT command_id FROM durable_application_command_outbox
       GROUP BY command_id HAVING COUNT(DISTINCT deployment_id) <> 1 LIMIT 1`
    )
    .get();
  if (crossDeployment) throw new Error('internal-storage-legacy-command-deployment-ambiguous');
  db.exec(`INSERT INTO durable_application_commands (
      command_id, deployment_id, stable_actor_id, command_kind, idempotency_key,
      descriptor_id, descriptor_version, input_schema_version, fingerprint_version,
      effect_plan_version, fingerprint_key_version, fingerprint_digest,
      attempt_generation, attempt_id, attempt_owner_id, attempt_lease_token,
      attempt_claimed_at, attempt_lease_expires_at, state, retention_class,
      audit_session_id, outcome_json, error_code, error_json,
      created_at, updated_at, committed_at)
    SELECT outbox.command_id, MIN(outbox.deployment_id),
      'legacy-unattributed:' || outbox.command_id, 'legacy_recovery',
      'legacy-event:' || outbox.command_id, 'legacy-recovery-v1', 1, 1,
      'hmac-sha256-ld-v1', 1, 'legacy-unavailable',
      '0000000000000000000000000000000000000000000000000000000000000000',
      1, 'legacy-attempt:' || outbox.command_id, 'legacy-recovery',
      'legacy-lease:' || outbox.command_id, MIN(outbox.created_at),
      '9999-12-31T23:59:59.999Z', 'committed', 'legacy_recovery', NULL,
      json_object('provenance', 'legacy_recovery_v1'), NULL, NULL,
      MIN(outbox.created_at), MAX(outbox.created_at), MAX(outbox.created_at)
    FROM durable_application_command_outbox AS outbox
    WHERE NOT EXISTS (SELECT 1 FROM durable_application_commands AS commands
      WHERE commands.command_id = outbox.command_id)
    GROUP BY outbox.command_id`);
  db.exec(`INSERT INTO durable_application_command_effects (
      command_id, ordinal, effect_id, effect_version, recovery_class,
      evidence_schema_version, state, updated_at)
    SELECT commands.command_id, 0, 'legacy-recovery:' || commands.command_id,
      1, 'transactional_local', 1, 'observed_succeeded', commands.updated_at
    FROM durable_application_commands AS commands
    WHERE commands.descriptor_id = 'legacy-recovery-v1'
      AND commands.stable_actor_id = 'legacy-unattributed:' || commands.command_id
      AND NOT EXISTS (SELECT 1 FROM durable_application_command_effects AS effects
        WHERE effects.command_id = commands.command_id)`);
  db.exec(`INSERT INTO durable_application_command_effect_evidence (
      command_id, ordinal, sequence, outcome, evidence_schema_version,
      evidence_json, recorded_at)
    SELECT commands.command_id, 0, 1, 'observed_succeeded', 1,
      json_object('provenance', 'legacy_recovery_v1'), commands.updated_at
    FROM durable_application_commands AS commands
    WHERE commands.descriptor_id = 'legacy-recovery-v1'
      AND commands.stable_actor_id = 'legacy-unattributed:' || commands.command_id
      AND NOT EXISTS (SELECT 1 FROM durable_application_command_effect_evidence AS evidence
        WHERE evidence.command_id = commands.command_id AND evidence.ordinal = 0)`);
}
