CREATE TABLE "integration_targets" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "integration_connection_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "target_kind" text NOT NULL,
  "provider_target_id" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text NOT NULL,
  "policy_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  "stale_at" timestamptz(6),
  "disabled_at" timestamptz(6),
  "deleted_at" timestamptz(6),
  CONSTRAINT "integration_targets_provider_check" CHECK ("provider" IN ('github')),
  CONSTRAINT "integration_targets_target_kind_check" CHECK ("target_kind" IN ('github_repository')),
  CONSTRAINT "integration_targets_status_check" CHECK ("status" IN ('enabled', 'disabled', 'stale', 'revoked', 'deleted')),
  CONSTRAINT "integration_targets_policy_version_check" CHECK ("policy_version" >= 1),
  CONSTRAINT "integration_targets_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "integration_targets_integration_connection_id_fkey"
    FOREIGN KEY ("integration_connection_id") REFERENCES "integration_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "github_repository_target_bindings" (
  "id" uuid PRIMARY KEY,
  "integration_target_id" uuid NOT NULL,
  "github_installation_id" text NOT NULL,
  "github_repository_id" text NOT NULL,
  "github_node_id" text,
  "display_owner" text NOT NULL,
  "display_name" text NOT NULL,
  "display_full_name" text NOT NULL,
  "private" boolean NOT NULL,
  "archived" boolean NOT NULL,
  "last_verified_at" timestamptz(6) NOT NULL,
  "repository_availability_snapshot_id" uuid,
  CONSTRAINT "github_repository_target_bindings_target_id_key" UNIQUE ("integration_target_id"),
  CONSTRAINT "github_repository_target_bindings_integration_target_id_fkey"
    FOREIGN KEY ("integration_target_id") REFERENCES "integration_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "github_repository_target_bindings_repository_availability_snapshot_id_fkey"
    FOREIGN KEY ("repository_availability_snapshot_id") REFERENCES "provider_repository_availability"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "target_policy_rules" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "integration_target_id" uuid NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "capability" text NOT NULL,
  "effect" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "created_by_desktop_client_id" uuid NOT NULL,
  CONSTRAINT "target_policy_rules_subject_kind_check" CHECK ("subject_kind" IN ('workspace', 'team', 'agent', 'desktop_client')),
  CONSTRAINT "target_policy_rules_capability_check" CHECK ("capability" IN ('github.issue_comment.request', 'github.pr_comment.request', 'github.pr_review.request', 'github.check_run.request')),
  CONSTRAINT "target_policy_rules_effect_check" CHECK ("effect" IN ('allow', 'deny')),
  CONSTRAINT "target_policy_rules_subject_id_shape_check" CHECK (
    char_length("subject_id") <= 256
    AND "subject_id" !~ '[[:space:]]'
    AND "subject_id" ~ '^[A-Za-z0-9._:-]+$'
    AND (
      ("subject_kind" = 'workspace' AND "subject_id" LIKE 'workspace:%' AND char_length("subject_id") > char_length('workspace:'))
      OR ("subject_kind" = 'team' AND "subject_id" LIKE 'team:%' AND char_length("subject_id") > char_length('team:'))
      OR ("subject_kind" = 'agent' AND "subject_id" LIKE 'agent:%' AND char_length("subject_id") > char_length('agent:'))
      OR ("subject_kind" = 'desktop_client' AND "subject_id" LIKE 'desktop-client:%' AND char_length("subject_id") > char_length('desktop-client:'))
    )
  ),
  CONSTRAINT "target_policy_rules_integration_target_id_fkey"
    FOREIGN KEY ("integration_target_id") REFERENCES "integration_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "target_policy_rules_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "target_policy_rules_created_by_desktop_client_id_fkey"
    FOREIGN KEY ("created_by_desktop_client_id") REFERENCES "desktop_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "integration_targets_workspace_status_idx"
  ON "integration_targets" ("workspace_id", "status");

CREATE INDEX "integration_targets_workspace_connection_kind_provider_idx"
  ON "integration_targets" ("workspace_id", "integration_connection_id", "target_kind", "provider_target_id");

CREATE INDEX "integration_targets_policy_version_idx"
  ON "integration_targets" ("id", "workspace_id", "policy_version");

CREATE INDEX "github_repository_target_bindings_installation_repo_idx"
  ON "github_repository_target_bindings" ("github_installation_id", "github_repository_id");

CREATE INDEX "target_policy_rules_lookup_idx"
  ON "target_policy_rules" ("workspace_id", "integration_target_id", "subject_kind", "subject_id", "capability");

CREATE UNIQUE INDEX "integration_targets_active_target_key"
  ON "integration_targets" ("workspace_id", "integration_connection_id", "target_kind", "provider_target_id")
  WHERE "status" <> 'deleted';

CREATE INDEX "integration_targets_enabled_idx"
  ON "integration_targets" ("workspace_id", "integration_connection_id", "target_kind")
  WHERE "status" = 'enabled';
