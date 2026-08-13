import { HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './hostedTeamApprovalCanonicalIdentityStorageMigration';

/**
 * Ordered approval identity migrations. Keep these entries append-only so the
 * parent storage registry can preserve its forward-only transaction semantics.
 */
export const HOSTED_TEAM_APPROVAL_IDENTITY_STORAGE_MIGRATIONS = [
  {
    version: 21,
    statements: [...HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS],
  },
  {
    version: 22,
    statements: [
      `ALTER TABLE hosted_team_approval_delivery_outbox ADD COLUMN principal_id TEXT`,
      `UPDATE hosted_team_approval_delivery_outbox
       SET principal_id = COALESCE((
         SELECT actor_id FROM hosted_team_approval_audit AS audit
         WHERE audit.approval_id = hosted_team_approval_delivery_outbox.approval_id
           AND audit.approval_generation = hosted_team_approval_delivery_outbox.approval_generation
           AND audit.team_id = hosted_team_approval_delivery_outbox.team_id
           AND audit.run_id = hosted_team_approval_delivery_outbox.run_id
         ORDER BY audit.occurred_at_ms DESC LIMIT 1
       ), 'actor_approval-timeout-system')
       WHERE principal_id IS NULL`,
    ],
  },
  {
    version: 23,
    statements: [
      `UPDATE hosted_team_approval_delivery_outbox
       SET principal_id = CASE
         WHEN decision = 'timeout' THEN '{"kind":"system_timeout"}'
         ELSE json_object('kind', 'operator', 'actorId', principal_id)
       END`,
    ],
  },
];
