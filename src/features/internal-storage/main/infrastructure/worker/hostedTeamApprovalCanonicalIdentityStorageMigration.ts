/**
 * Forward-only v21 migration from the released v18 approval schema.
 *
 * The legacy authority generation is retained as a deterministic, valid run
 * partition. Legacy request ids were not persisted, so their immutable
 * approval id is the only lossless request identity available during upgrade.
 */
const LEGACY_RUN_ID =
  "'run_' || substr(lower(hex(authority_generation || ':' || restore_generation)) || '00000000000000000000000000000000', 1, 32)";

export const HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE hosted_team_approval_records_v21 (
    team_id TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
    approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    category TEXT NOT NULL, summary TEXT NOT NULL, requested_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER, preview_ref TEXT, preview_content TEXT,
    preview_byte_length INTEGER, preview_truncated INTEGER, preview_is_binary INTEGER,
    delivery_ref TEXT NOT NULL, state TEXT NOT NULL, decision TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0), observed_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER, last_idempotency_key TEXT, payload_hash TEXT,
    PRIMARY KEY (team_id, run_id, request_id), UNIQUE (approval_id),
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
    SELECT team_id, ${LEGACY_RUN_ID}, approval_id, approval_id, approval_generation,
      category, summary, requested_at_ms, expires_at_ms, preview_ref, preview_content,
      preview_byte_length, preview_truncated, preview_is_binary, delivery_ref, state,
      decision, revision, observed_at_ms, resolved_at_ms, last_idempotency_key, payload_hash
    FROM hosted_team_approval_records`,
  `CREATE TABLE hosted_team_approval_idempotency_v21 (
    team_id TEXT NOT NULL, run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    audit_id TEXT NOT NULL UNIQUE, delivery_id TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (team_id, run_id, idempotency_key),
    FOREIGN KEY (team_id, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (team_id, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  )`,
  `INSERT INTO hosted_team_approval_idempotency_v21
    SELECT team_id, ${LEGACY_RUN_ID}, idempotency_key, approval_id, approval_id,
      approval_generation, decision, payload_hash, revision, audit_id, delivery_id, created_at_ms
    FROM hosted_team_approval_idempotency`,
  `CREATE TABLE hosted_team_approval_audit_v21 (
    audit_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, run_id TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    FOREIGN KEY (team_id, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (team_id, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  )`,
  `INSERT INTO hosted_team_approval_audit_v21
    SELECT audit_id, team_id, ${LEGACY_RUN_ID}, approval_id, approval_id,
      approval_generation, decision, payload_hash, actor_id, session_id, occurred_at_ms
    FROM hosted_team_approval_audit`,
  `CREATE TABLE hosted_team_approval_delivery_outbox_v21 (
    delivery_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, run_id TEXT NOT NULL,
    request_id TEXT NOT NULL, approval_id TEXT NOT NULL, approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery_ref TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)), state TEXT NOT NULL,
    delivery_generation INTEGER NOT NULL CHECK (delivery_generation >= 0),
    delivery_owner_id TEXT, delivery_lease_token TEXT, delivery_claimed_at_ms INTEGER,
    delivery_lease_expires_at_ms INTEGER, delivered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (team_id, run_id, request_id),
    FOREIGN KEY (team_id, run_id, request_id)
      REFERENCES hosted_team_approval_records_v21 (team_id, run_id, request_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (state IN ('pending', 'delivered') AND (state = 'delivered') = (delivered_at_ms IS NOT NULL)),
    CHECK ((delivery_owner_id IS NULL AND delivery_lease_token IS NULL
      AND delivery_claimed_at_ms IS NULL AND delivery_lease_expires_at_ms IS NULL)
      OR (delivery_owner_id IS NOT NULL AND delivery_lease_token IS NOT NULL
      AND delivery_claimed_at_ms IS NOT NULL AND delivery_lease_expires_at_ms > delivery_claimed_at_ms))
  )`,
  `INSERT INTO hosted_team_approval_delivery_outbox_v21
    SELECT delivery_id, team_id, ${LEGACY_RUN_ID}, approval_id, approval_id,
      approval_generation, decision, payload_hash, delivery_ref, intent_json, state,
      delivery_generation, delivery_owner_id, delivery_lease_token, delivery_claimed_at_ms,
      delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms
    FROM hosted_team_approval_delivery_outbox`,
  `DROP TABLE hosted_team_approval_delivery_outbox`,
  `DROP TABLE hosted_team_approval_audit`,
  `DROP TABLE hosted_team_approval_idempotency`,
  `DROP TABLE hosted_team_approval_records`,
  `ALTER TABLE hosted_team_approval_records_v21 RENAME TO hosted_team_approval_records`,
  `ALTER TABLE hosted_team_approval_idempotency_v21 RENAME TO hosted_team_approval_idempotency`,
  `ALTER TABLE hosted_team_approval_audit_v21 RENAME TO hosted_team_approval_audit`,
  `ALTER TABLE hosted_team_approval_delivery_outbox_v21 RENAME TO hosted_team_approval_delivery_outbox`,
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
