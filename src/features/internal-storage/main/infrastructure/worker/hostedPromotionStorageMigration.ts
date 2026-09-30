/** Append-only v30. No historical SQL, identity graph or roster envelope changes. */
export const HOSTED_PROMOTION_STORAGE_MIGRATION = {
  version: 30,
  statements: [
    `CREATE TABLE hosted_team_configuration_promotions (
      operation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      team_id TEXT NOT NULL UNIQUE,
      actor_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK (json_valid(record_json) AND length(CAST(record_json AS BLOB)) <= 2097152),
      UNIQUE (workspace_id, actor_id, deployment_id, idempotency_key),
      FOREIGN KEY (workspace_id, team_id)
        REFERENCES hosted_team_configuration_drafts(workspace_id, team_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    // BEFORE INSERT runs for REPLACE even when recursive_triggers is OFF. Match
    // every unique identity (including explicit rowid/oid/_rowid_), even when
    // the replacement moves the old row elsewhere.
    `CREATE TRIGGER hosted_promotions_no_replace BEFORE INSERT ON hosted_team_configuration_promotions
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.rowid = NEW.rowid OR p.operation_id = NEW.operation_id OR p.team_id = NEW.team_id
          OR (p.workspace_id = NEW.workspace_id AND p.actor_id = NEW.actor_id
            AND p.deployment_id = NEW.deployment_id AND p.idempotency_key = NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT, 'promotion journal is immutable'); END`,
    `CREATE TRIGGER hosted_promotions_freeze_replace BEFORE INSERT ON hosted_team_configuration_drafts
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_drafts d
        JOIN hosted_team_configuration_promotions p
          ON p.workspace_id = d.workspace_id AND p.team_id = d.team_id
        WHERE d.rowid = NEW.rowid OR d.team_id = NEW.team_id OR d.revision_token = NEW.revision_token)
      BEGIN SELECT RAISE(ABORT, 'promotion configuration is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_publication_no_replace BEFORE INSERT ON hosted_team_configuration_publications
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_publications p
        WHERE p.rowid = NEW.rowid OR p.operation_id = NEW.operation_id OR p.team_id = NEW.team_id OR p.legacy_key = NEW.legacy_key)
      BEGIN SELECT RAISE(ABORT, 'draft publication binding is immutable'); END`,
    `CREATE TRIGGER hosted_promotions_create_key_no_replace BEFORE INSERT ON hosted_team_configuration_create_keys
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_create_keys k
        JOIN hosted_team_configuration_promotions p ON p.workspace_id = k.workspace_id AND p.team_id = k.team_id
        WHERE k.rowid = NEW.rowid OR (k.workspace_id = NEW.workspace_id AND k.idempotency_key = NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT, 'promotion create association is frozen'); END`,
    // UPDATE OR REPLACE does not run INSERT guards or (with recursive triggers
    // disabled) the implicit victim's DELETE guards. Inspect the destination as
    // well as OLD below. NEW.rowid also observes assignments to oid and _rowid_.
    // Exclude the source row so non-conflicting updates retain their old policy.
    // The globally unique team_id also covers the draft's (workspace_id, team_id) PK.
    `CREATE TRIGGER hosted_promotions_freeze_update_collision BEFORE UPDATE ON hosted_team_configuration_drafts
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_drafts d
        JOIN hosted_team_configuration_promotions p
          ON p.workspace_id = d.workspace_id AND p.team_id = d.team_id
        WHERE d.rowid != OLD.rowid
          AND (d.rowid = NEW.rowid OR d.team_id = NEW.team_id OR d.revision_token = NEW.revision_token))
      BEGIN SELECT RAISE(ABORT, 'promotion configuration is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_publication_update_collision BEFORE UPDATE ON hosted_team_configuration_publications
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_publications p
        WHERE p.rowid != OLD.rowid
          AND (p.rowid = NEW.rowid OR p.operation_id = NEW.operation_id
            OR p.team_id = NEW.team_id OR p.legacy_key = NEW.legacy_key))
      BEGIN SELECT RAISE(ABORT, 'draft publication binding is immutable'); END`,
    `CREATE TRIGGER hosted_promotions_create_key_update_collision BEFORE UPDATE ON hosted_team_configuration_create_keys
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_create_keys k
        JOIN hosted_team_configuration_promotions p ON p.workspace_id = k.workspace_id AND p.team_id = k.team_id
        WHERE k.rowid != OLD.rowid
          AND (k.rowid = NEW.rowid OR (k.workspace_id = NEW.workspace_id AND k.idempotency_key = NEW.idempotency_key)))
      BEGIN SELECT RAISE(ABORT, 'promotion create association is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_create_key_no_update BEFORE UPDATE ON hosted_team_configuration_create_keys
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.workspace_id = OLD.workspace_id AND p.team_id = OLD.team_id)
      BEGIN SELECT RAISE(ABORT, 'promotion create association is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_create_key_no_delete BEFORE DELETE ON hosted_team_configuration_create_keys
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.workspace_id = OLD.workspace_id AND p.team_id = OLD.team_id)
      BEGIN SELECT RAISE(ABORT, 'promotion create association is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_no_update BEFORE UPDATE ON hosted_team_configuration_promotions
      BEGIN SELECT RAISE(ABORT, 'promotion journal is immutable'); END`,
    `CREATE TRIGGER hosted_promotions_no_delete BEFORE DELETE ON hosted_team_configuration_promotions
      BEGIN SELECT RAISE(ABORT, 'promotion journal is retained'); END`,
    `CREATE TRIGGER hosted_promotions_freeze_update BEFORE UPDATE ON hosted_team_configuration_drafts
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.workspace_id = OLD.workspace_id AND p.team_id = OLD.team_id)
      BEGIN SELECT RAISE(ABORT, 'promotion configuration is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_freeze_delete BEFORE DELETE ON hosted_team_configuration_drafts
      WHEN EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.workspace_id = OLD.workspace_id AND p.team_id = OLD.team_id)
      BEGIN SELECT RAISE(ABORT, 'promotion configuration is frozen'); END`,
    `CREATE TRIGGER hosted_promotions_publication_tombstone BEFORE UPDATE ON hosted_team_configuration_publications
      WHEN NEW.state = 'tombstoned' AND EXISTS (SELECT 1 FROM hosted_team_configuration_promotions p
        WHERE p.workspace_id = OLD.workspace_id AND p.team_id = OLD.team_id)
      BEGIN SELECT RAISE(ABORT, 'promotion publication is frozen'); END`,
  ],
} as const;
