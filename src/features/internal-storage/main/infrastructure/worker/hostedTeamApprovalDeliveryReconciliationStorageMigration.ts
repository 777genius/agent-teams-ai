/**
 * Durable quarantine for ambiguous provider delivery. The table rebuild is
 * required because SQLite cannot extend the released state CHECK in place.
 */
export const HOSTED_TEAM_APPROVAL_DELIVERY_RECONCILIATION_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE hosted_team_approval_delivery_outbox_v24 (
    delivery_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL, restore_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery_ref TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)), state TEXT NOT NULL,
    delivery_generation INTEGER NOT NULL CHECK (delivery_generation >= 0),
    delivery_owner_id TEXT, delivery_lease_token TEXT, delivery_claimed_at_ms INTEGER,
    delivery_lease_expires_at_ms INTEGER, delivered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), principal_id TEXT,
    reconciliation_ref TEXT, operator_required_at_ms INTEGER,
    UNIQUE (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id),
    FOREIGN KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      REFERENCES hosted_team_approval_records (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (
      (state = 'pending' AND delivered_at_ms IS NULL AND reconciliation_ref IS NULL
        AND operator_required_at_ms IS NULL)
      OR (state = 'operator_required' AND delivered_at_ms IS NULL
        AND reconciliation_ref IS NOT NULL AND operator_required_at_ms IS NOT NULL)
      OR (state = 'delivered' AND delivered_at_ms IS NOT NULL
        AND ((reconciliation_ref IS NULL AND operator_required_at_ms IS NULL)
          OR (reconciliation_ref IS NOT NULL AND operator_required_at_ms IS NOT NULL)))
    ),
    CHECK ((delivery_owner_id IS NULL AND delivery_lease_token IS NULL
      AND delivery_claimed_at_ms IS NULL AND delivery_lease_expires_at_ms IS NULL)
      OR (delivery_owner_id IS NOT NULL AND delivery_lease_token IS NOT NULL
      AND delivery_claimed_at_ms IS NOT NULL AND delivery_lease_expires_at_ms > delivery_claimed_at_ms)),
    CHECK (state <> 'operator_required' OR (delivery_owner_id IS NOT NULL
      AND delivery_lease_token IS NOT NULL AND delivery_claimed_at_ms IS NOT NULL
      AND delivery_lease_expires_at_ms IS NOT NULL))
  )`,
  `INSERT INTO hosted_team_approval_delivery_outbox_v24 (
    delivery_id, workspace_id, team_id, authority_generation, restore_generation, run_id,
    request_id, approval_id, approval_generation, decision, payload_hash, delivery_ref,
    intent_json, state, delivery_generation, delivery_owner_id, delivery_lease_token,
    delivery_claimed_at_ms, delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms,
    principal_id, reconciliation_ref, operator_required_at_ms
  ) SELECT delivery_id, workspace_id, team_id, authority_generation, restore_generation, run_id,
    request_id, approval_id, approval_generation, decision, payload_hash, delivery_ref,
    intent_json, state, delivery_generation, delivery_owner_id, delivery_lease_token,
    delivery_claimed_at_ms, delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms,
    principal_id, NULL, NULL
    FROM hosted_team_approval_delivery_outbox`,
  `DROP TABLE hosted_team_approval_delivery_outbox`,
  `ALTER TABLE hosted_team_approval_delivery_outbox_v24
    RENAME TO hosted_team_approval_delivery_outbox`,
  `CREATE INDEX idx_hosted_team_approval_delivery_pending
    ON hosted_team_approval_delivery_outbox
      (state, delivery_owner_id, delivery_lease_expires_at_ms, created_at_ms, delivery_id)`,
] as const;
