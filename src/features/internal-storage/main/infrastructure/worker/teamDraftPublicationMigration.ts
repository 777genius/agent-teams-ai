/** Append-only v29 extension. The released v5/v28 SQL remains byte-for-byte unchanged. */
export const RESERVED_TEAM_IDENTITY_TRANSITION = `CREATE TRIGGER trg_team_identity_transition
    BEFORE UPDATE ON team_identity_records
    WHEN NOT (
      OLD.state = 'reserved' AND NEW.state = 'adoption_prepared'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND OLD.adoption_intent_id IS NULL AND NEW.adoption_intent_id IS NOT NULL
      AND OLD.identity_checksum IS NULL AND NEW.identity_checksum IS NULL
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NULL
      AND NEW.created_at = OLD.created_at AND NEW.tombstoned_at IS NULL
      AND EXISTS (SELECT 1 FROM team_adoption_intents i
        WHERE i.intent_id = NEW.adoption_intent_id AND i.team_id = OLD.team_id
        AND i.state = 'prepared' AND i.legacy_key = OLD.legacy_key
        AND i.directory_fingerprint = OLD.directory_fingerprint
        AND i.workspace_id IS OLD.workspace_id
        AND i.workspace_binding_generation IS OLD.workspace_binding_generation
        AND i.prepared_at = OLD.created_at)
    ) AND NOT (
      OLD.state = 'adoption_prepared' AND NEW.state = 'file_published'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND OLD.identity_checksum IS NULL AND NEW.identity_checksum IS NOT NULL
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NULL
      AND NEW.created_at = OLD.created_at AND NEW.tombstoned_at IS NULL
    ) AND NOT (
      OLD.state = 'file_published' AND NEW.state = 'active'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND NEW.identity_checksum = OLD.identity_checksum
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
      AND NEW.created_at = OLD.created_at AND NEW.tombstoned_at IS NULL
    ) AND NOT (
      OLD.state IN ('reserved', 'adoption_prepared', 'file_published', 'active')
      AND NEW.state = 'tombstoned'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND NEW.identity_checksum IS OLD.identity_checksum
      AND NEW.created_at = OLD.created_at AND NEW.activated_at IS OLD.activated_at
      AND OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'illegal team identity transition'); END`;

export const TEAM_DRAFT_PUBLICATION_MIGRATION = {
  version: 29,
  statements: [
    'DROP TRIGGER trg_team_identity_transition',
    RESERVED_TEAM_IDENTITY_TRANSITION,
    `CREATE TABLE hosted_team_configuration_publications (
      operation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      team_id TEXT NOT NULL UNIQUE,
      actor_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      runtime_workspace_id TEXT NOT NULL,
      binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
      legacy_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      initial_revision TEXT NOT NULL,
      directory_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'recovery_required', 'tombstoned')),
      FOREIGN KEY (workspace_id, team_id)
        REFERENCES hosted_team_configuration_drafts(workspace_id, team_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CHECK (directory_fingerprint IS NULL OR (length(directory_fingerprint) = 64
        AND directory_fingerprint NOT GLOB '*[^0-9a-f]*')),
      CHECK (state != 'published' OR directory_fingerprint IS NOT NULL)
    )`,
    `CREATE TRIGGER hosted_team_configuration_publications_immutable
      BEFORE UPDATE ON hosted_team_configuration_publications
      WHEN NEW.operation_id != OLD.operation_id OR NEW.workspace_id != OLD.workspace_id
        OR NEW.team_id != OLD.team_id OR NEW.actor_id != OLD.actor_id
        OR NEW.deployment_id != OLD.deployment_id
        OR NEW.runtime_workspace_id != OLD.runtime_workspace_id
        OR NEW.binding_generation != OLD.binding_generation OR NEW.legacy_key != OLD.legacy_key
        OR NEW.created_at != OLD.created_at OR NEW.initial_revision != OLD.initial_revision
        OR (OLD.directory_fingerprint IS NOT NULL
          AND NEW.directory_fingerprint IS NOT OLD.directory_fingerprint)
        OR (OLD.state = 'tombstoned' AND NEW.state != 'tombstoned')
        OR (OLD.state = 'published' AND NEW.state NOT IN ('published', 'tombstoned'))
      BEGIN SELECT RAISE(ABORT, 'draft publication binding is immutable'); END`,
    `CREATE TRIGGER hosted_team_configuration_publications_no_delete
      BEFORE DELETE ON hosted_team_configuration_publications
      BEGIN SELECT RAISE(ABORT, 'draft publication intent is retained'); END`,
  ],
} as const;
