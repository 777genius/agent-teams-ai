/**
 * Forward-only v21 migration from the released v18 approval schema.
 *
 * v18 did not retain a provider request id or run id. A temporary mapping gives
 * every historical approval row a stable, collision-free legacy run partition;
 * child rows join through the complete released v18 foreign-key identity.
 */
export const HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TEMP TABLE hosted_team_approval_v21_identity_map AS
    SELECT principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation, printf('run_%032x', rowid) AS run_id,
      approval_id AS request_id
    FROM hosted_team_approval_records`,
  `CREATE TABLE hosted_team_approval_records_v21 (
    workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
    approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    category TEXT NOT NULL, summary TEXT NOT NULL, requested_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER, preview_ref TEXT, preview_content TEXT,
    preview_byte_length INTEGER, preview_truncated INTEGER, preview_is_binary INTEGER,
    delivery_ref TEXT NOT NULL, state TEXT NOT NULL, decision TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0), observed_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER, last_idempotency_key TEXT, payload_hash TEXT,
    PRIMARY KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id),
    CHECK (requested_at_ms >= 0 AND observed_at_ms >= requested_at_ms
      AND (expires_at_ms IS NULL OR expires_at_ms > requested_at_ms)),
    CHECK (state IN ('pending', 'superseded', 'resolved')
      AND (state = 'resolved') = (decision IS NOT NULL)
      AND (state = 'pending') = (resolved_at_ms IS NULL)),
    CHECK ((preview_ref IS NULL AND preview_content IS NULL AND preview_byte_length IS NULL
      AND preview_truncated IS NULL AND preview_is_binary IS NULL)
      OR (preview_ref IS NOT NULL AND preview_content IS NOT NULL
      AND preview_byte_length IS NOT NULL AND preview_truncated IS NOT NULL
      AND preview_is_binary IS NOT NULL))
  )`,
  `INSERT INTO hosted_team_approval_records_v21
    SELECT legacy.workspace_id, legacy.team_id, legacy.authority_generation,
      legacy.restore_generation, identity_map.run_id, identity_map.request_id,
      legacy.approval_id, legacy.approval_generation, legacy.category, legacy.summary,
      legacy.requested_at_ms, legacy.expires_at_ms, legacy.preview_ref, legacy.preview_content,
      legacy.preview_byte_length, legacy.preview_truncated, legacy.preview_is_binary,
      legacy.delivery_ref, legacy.state, legacy.decision, legacy.revision,
      legacy.observed_at_ms, legacy.resolved_at_ms, legacy.last_idempotency_key,
      legacy.payload_hash
    FROM hosted_team_approval_records AS legacy
    JOIN hosted_team_approval_v21_identity_map AS identity_map
      USING (principal_id, workspace_id, team_id, authority_generation, restore_generation,
             approval_id, approval_generation)`,
  `CREATE TABLE hosted_team_approval_idempotency_v21 (
    workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL, run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    audit_id TEXT NOT NULL UNIQUE, delivery_id TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, idempotency_key),
    FOREIGN KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  )`,
  `INSERT INTO hosted_team_approval_idempotency_v21
    SELECT legacy.workspace_id, legacy.team_id, legacy.authority_generation,
      legacy.restore_generation, identity_map.run_id, legacy.idempotency_key,
      identity_map.request_id, legacy.approval_id, legacy.approval_generation,
      legacy.decision, legacy.payload_hash, legacy.revision, legacy.audit_id,
      legacy.delivery_id, legacy.created_at_ms
    FROM hosted_team_approval_idempotency AS legacy
    JOIN hosted_team_approval_v21_identity_map AS identity_map
      USING (principal_id, workspace_id, team_id, authority_generation, restore_generation,
             approval_id, approval_generation)`,
  `CREATE TABLE hosted_team_approval_audit_v21 (
    audit_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL, restore_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    FOREIGN KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  )`,
  `INSERT INTO hosted_team_approval_audit_v21
    SELECT legacy.audit_id, legacy.workspace_id, legacy.team_id, legacy.authority_generation,
      legacy.restore_generation, identity_map.run_id, identity_map.request_id,
      legacy.approval_id, legacy.approval_generation, legacy.decision, legacy.payload_hash,
      legacy.actor_id, legacy.session_id, legacy.occurred_at_ms
    FROM hosted_team_approval_audit AS legacy
    JOIN hosted_team_approval_v21_identity_map AS identity_map
      USING (principal_id, workspace_id, team_id, authority_generation, restore_generation,
             approval_id, approval_generation)`,
  `CREATE TABLE hosted_team_approval_delivery_outbox_v21 (
    delivery_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL, restore_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery_ref TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)), state TEXT NOT NULL,
    delivery_generation INTEGER NOT NULL CHECK (delivery_generation >= 0),
    delivery_owner_id TEXT, delivery_lease_token TEXT, delivery_claimed_at_ms INTEGER,
    delivery_lease_expires_at_ms INTEGER, delivered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id),
    FOREIGN KEY (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (state IN ('pending', 'delivered') AND (state = 'delivered') = (delivered_at_ms IS NOT NULL)),
    CHECK ((delivery_owner_id IS NULL AND delivery_lease_token IS NULL
      AND delivery_claimed_at_ms IS NULL AND delivery_lease_expires_at_ms IS NULL)
      OR (delivery_owner_id IS NOT NULL AND delivery_lease_token IS NOT NULL
      AND delivery_claimed_at_ms IS NOT NULL AND delivery_lease_expires_at_ms > delivery_claimed_at_ms))
  )`,
  `INSERT INTO hosted_team_approval_delivery_outbox_v21
    SELECT legacy.delivery_id, legacy.workspace_id, legacy.team_id, legacy.authority_generation,
      legacy.restore_generation, identity_map.run_id, identity_map.request_id,
      legacy.approval_id, legacy.approval_generation, legacy.decision, legacy.payload_hash,
      legacy.delivery_ref, legacy.intent_json, legacy.state, legacy.delivery_generation,
      legacy.delivery_owner_id, legacy.delivery_lease_token, legacy.delivery_claimed_at_ms,
      legacy.delivery_lease_expires_at_ms, legacy.delivered_at_ms, legacy.created_at_ms
    FROM hosted_team_approval_delivery_outbox AS legacy
    JOIN hosted_team_approval_v21_identity_map AS identity_map
      USING (principal_id, workspace_id, team_id, authority_generation, restore_generation,
             approval_id, approval_generation)`,
  `DROP TABLE hosted_team_approval_delivery_outbox`,
  `DROP TABLE hosted_team_approval_audit`,
  `DROP TABLE hosted_team_approval_idempotency`,
  `DROP TABLE hosted_team_approval_records`,
  `ALTER TABLE hosted_team_approval_records_v21 RENAME TO hosted_team_approval_records`,
  `ALTER TABLE hosted_team_approval_idempotency_v21 RENAME TO hosted_team_approval_idempotency`,
  `ALTER TABLE hosted_team_approval_audit_v21 RENAME TO hosted_team_approval_audit`,
  `ALTER TABLE hosted_team_approval_delivery_outbox_v21 RENAME TO hosted_team_approval_delivery_outbox`,
  `DROP TABLE hosted_team_approval_v21_identity_map`,
  `CREATE UNIQUE INDEX idx_hosted_team_approval_identity
    ON hosted_team_approval_records
      (workspace_id, team_id, authority_generation, restore_generation, run_id, approval_id)`,
  `CREATE INDEX idx_hosted_team_approval_pending_page
    ON hosted_team_approval_records (team_id, state, approval_id)`,
  `CREATE INDEX idx_hosted_team_approval_pending_partition
    ON hosted_team_approval_records (team_id, run_id, state, approval_id)`,
  `CREATE INDEX idx_hosted_team_approval_audit_partition
    ON hosted_team_approval_audit (team_id, run_id, occurred_at_ms)`,
  `CREATE INDEX idx_hosted_team_approval_delivery_pending
    ON hosted_team_approval_delivery_outbox
      (state, delivery_owner_id, delivery_lease_expires_at_ms, created_at_ms, delivery_id)`,
] as const;
