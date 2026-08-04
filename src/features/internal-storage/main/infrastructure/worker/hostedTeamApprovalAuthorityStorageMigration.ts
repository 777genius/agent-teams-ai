/** Additive v18 schema for provider-neutral hosted approval durability. */
export const HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hosted_team_approval_records (
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
    approval_id TEXT NOT NULL,
    approval_generation TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    preview_ref TEXT,
    preview_content TEXT,
    preview_byte_length INTEGER,
    preview_truncated INTEGER,
    preview_is_binary INTEGER,
    delivery_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    decision TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    observed_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    last_idempotency_key TEXT,
    payload_hash TEXT,
    PRIMARY KEY (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ),
    CHECK (requested_at_ms >= 0 AND observed_at_ms >= requested_at_ms
      AND (expires_at_ms IS NULL OR expires_at_ms > requested_at_ms)),
    CHECK (state IN ('pending', 'superseded', 'resolved')
      AND (state = 'resolved') = (decision IS NOT NULL)
      AND (state = 'pending') = (resolved_at_ms IS NULL)),
    CHECK (
      (preview_ref IS NULL AND preview_content IS NULL AND preview_byte_length IS NULL
          AND preview_truncated IS NULL AND preview_is_binary IS NULL)
      OR (preview_ref IS NOT NULL AND preview_content IS NOT NULL
          AND preview_byte_length IS NOT NULL AND preview_truncated IS NOT NULL
          AND preview_is_binary IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hosted_team_approval_pending_page
    ON hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      state, approval_id
    )`,
  `CREATE INDEX IF NOT EXISTS idx_hosted_team_approval_current_generation
    ON hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, observed_at_ms
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_team_approval_one_pending_generation
    ON hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation, approval_id
    ) WHERE state = 'pending'`,
  `CREATE TABLE IF NOT EXISTS hosted_team_approval_idempotency (
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
    idempotency_key TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    audit_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      idempotency_key
    ),
    UNIQUE (audit_id),
    UNIQUE (delivery_id),
    FOREIGN KEY (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) REFERENCES hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (created_at_ms >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS hosted_team_approval_audit (
    audit_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
    approval_id TEXT NOT NULL,
    approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    FOREIGN KEY (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) REFERENCES hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (occurred_at_ms >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hosted_team_approval_audit_scope
    ON hosted_team_approval_audit (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      occurred_at_ms
    )`,
  `CREATE TABLE IF NOT EXISTS hosted_team_approval_delivery_outbox (
    delivery_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    authority_generation TEXT NOT NULL,
    restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
    approval_id TEXT NOT NULL,
    approval_generation TEXT NOT NULL,
    decision TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    delivery_ref TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    state TEXT NOT NULL,
    delivery_generation INTEGER NOT NULL CHECK (delivery_generation >= 0),
    delivery_owner_id TEXT,
    delivery_lease_token TEXT,
    delivery_claimed_at_ms INTEGER,
    delivery_lease_expires_at_ms INTEGER,
    delivered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ),
    FOREIGN KEY (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) REFERENCES hosted_team_approval_records (
      principal_id, workspace_id, team_id, authority_generation, restore_generation,
      approval_id, approval_generation
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK (created_at_ms >= 0),
    CHECK (state IN ('pending', 'delivered') AND (state = 'delivered') = (delivered_at_ms IS NOT NULL)),
    CHECK (
      (delivery_owner_id IS NULL AND delivery_lease_token IS NULL
        AND delivery_claimed_at_ms IS NULL AND delivery_lease_expires_at_ms IS NULL)
      OR (delivery_owner_id IS NOT NULL AND delivery_lease_token IS NOT NULL
        AND delivery_claimed_at_ms IS NOT NULL AND delivery_lease_expires_at_ms > delivery_claimed_at_ms)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hosted_team_approval_delivery_pending
    ON hosted_team_approval_delivery_outbox (
      state, delivery_lease_expires_at_ms, created_at_ms, delivery_id
    )`,
] as const;
