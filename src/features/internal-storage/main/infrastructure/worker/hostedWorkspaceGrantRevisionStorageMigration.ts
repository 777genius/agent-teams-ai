/** Append-only v20 migration: every grant mutation receives an unguessable ABA revision. */
export const HOSTED_WORKSPACE_GRANT_REVISION_STORAGE_MIGRATION_STATEMENTS = Object.freeze([
  `ALTER TABLE hosted_workspace_grants RENAME TO hosted_workspace_grants_v19`,
  `CREATE TABLE hosted_workspace_grants (
    user_id TEXT NOT NULL,
    runtime_workspace_id TEXT NOT NULL,
    grant_generation INTEGER NOT NULL CHECK (grant_generation >= 0),
    grant_revision TEXT NOT NULL CHECK (length(grant_revision) = 64),
    granted_at INTEGER NOT NULL,
    granted_by TEXT NOT NULL CHECK (granted_by = 'local-cli'),
    PRIMARY KEY (user_id, runtime_workspace_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (runtime_workspace_id)
      REFERENCES hosted_workspaces(runtime_workspace_id) ON DELETE CASCADE
  )`,
  `INSERT INTO hosted_workspace_grants
     (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by)
   SELECT user_id, runtime_workspace_id, grant_generation, lower(hex(randomblob(32))),
          granted_at, granted_by
   FROM hosted_workspace_grants_v19`,
  `DROP TABLE hosted_workspace_grants_v19`,
  `CREATE INDEX idx_hosted_workspace_grants_generation
    ON hosted_workspace_grants (user_id, grant_generation, runtime_workspace_id)`,
]);
