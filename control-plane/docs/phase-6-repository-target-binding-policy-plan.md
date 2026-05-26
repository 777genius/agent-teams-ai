# Phase 6 - Repository Target Binding And Policy Plan

## Purpose

Phase 6 turns Phase 5 repository availability snapshots into explicit workspace
targets that agents may later act on.

The key product model becomes:

```text
Workspace
  -> IntegrationConnection
  -> ProviderRepositoryAvailability snapshot
  -> RepositoryTarget binding
  -> TargetPolicy
  -> Agent/Team grants
```

Phase 6 must not post to GitHub, mint installation tokens, or execute agent
actions. Its job is authorization groundwork: decide which repositories are
enabled for the workspace and which trusted local/runtime actors may request
future GitHub actions against those repositories.

## Summary

Phase 5 proved that a workspace can claim a GitHub App installation. Phase 6
answers a different question:

```text
Given this verified installation, which repositories are intentionally enabled
as action targets for this workspace?
```

Repository availability is not authorization. It is only provider-side evidence
that a repository can be seen by the app/user at verification time. A target
binding is the explicit product permission boundary.

## Decision

Create repository target bindings as a separate bounded context, not as extra
columns on `integration_connections` or provider snapshot rows.

```text
🎯 10   🛡️ 9   🧠 6
~1500-2500 implementation lines
```

Why this is the right shape:

- `integration_connections` remains the provider ownership boundary.
- Provider snapshots remain display/cache data, not authorization.
- Later GitHub, Telegram, Slack, and custom integrations can share target policy
  concepts.
- Phase 8 GitHub write actions can depend on target authorization without
  knowing setup/claim internals.

Options:

- Dedicated `integration-targets` feature  
  `🎯 10   🛡️ 9   🧠 6`  
  Approx changes: `1500-2500` lines.  
  Recommended. Cleanly separates connection ownership from action target policy.

- Add target fields directly to repository availability rows  
  `🎯 4   🛡️ 5   🧠 3`  
  Approx changes: `500-900` lines.  
  Easier but unsafe long-term because snapshot rows become authorization state.

- Wait until Phase 8 and add policy inside GitHub actions  
  `🎯 3   🛡️ 4   🧠 5`  
  Approx changes now: `0` lines, later `2500-4500` lines.  
  Defers the hardest security boundary until side effects exist.

## Scope

Phase 6 should implement:

- provider-neutral `integration-targets` bounded context
- GitHub repository target bindings for Phase 5 connections
- target state machine: `enabled`, `disabled`, `stale`, `revoked`, `deleted`
- repository target creation/update/list APIs for authenticated desktop clients
- target policy model for future agent/team authorization
- minimal agent/team identity references as opaque external ids
- policy evaluator port that answers "may this actor request action X on target Y"
- safe audit events for target enablement, disablement, policy changes, stale
  snapshot handling, and revocation
- target sync safety when Phase 5 repository availability is partial or stale
- feature gate `CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED`
- architecture rules that keep policy/application independent of GitHub SDKs

Phase 6 must not implement:

- GitHub installation access token issuance
- GitHub comments, reviews, checks, statuses, labels, branch writes, or messages
- generic agent action dispatch
- outbox side effects for GitHub writes
- webhook-driven target policy changes
- billing/entitlement enforcement beyond placeholder ports
- storing repository code, diffs, raw prompts, or raw agent output
- giving provider tokens to desktop, agents, or local runtimes

## Current Inputs

Phase 6 consumes:

- `WorkspaceId`
- `DesktopClientActor`
- `IntegrationConnection`
- `ProviderRepositoryAvailability`
- `RepositorySyncStatus`
- GitHub installation/repository immutable ids

Phase 6 produces:

- explicit workspace target bindings
- policy rules that Phase 8 can enforce
- safe read models for desktop UI
- audit events

## Plan-Improve Hardening Decisions

These decisions preserve Phase 6 scope and remove risky ambiguity before
implementation:

- V1 does not call GitHub for revalidation. If repository availability is
  partial, stale, or missing, `EnableRepositoryTargetUseCase` fails closed with
  `CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED`. A future phase can add a
  provider revalidation adapter once token brokering exists.
- Repository availability older than the configured max age is treated as stale
  even when sync status is `complete`. V1 default should be conservative
  (`24h`) because Phase 6 has no safe live revalidation path.
- Subject ids are accepted as opaque ids in V1, but only after strict namespace,
  length, and character validation. There is no dependency on a future agent
  registry yet.
- Policy writes use replace-whole-document semantics with
  `expectedPolicyVersion`. Patch-based updates are deferred because they make
  deny/allow precedence and audit explanations harder to reason about.
- Target enablement uses resource-level idempotency through unique constraints.
  Re-enabling the same repository is safe; attempting to change initial policy
  through a duplicate enable returns a safe conflict and must use
  `UpdateTargetPolicyUseCase`.
- `integration-targets` owns its application ports. Any adapter that reads
  Phase 5 connection/snapshot data uses public `integration-connections`
  exports or direct Prisma tables inside its own infrastructure adapter, never
  another feature's infrastructure files.
- The feature gate must be checked before writes and in list APIs. Disabled
  gate returns a safe not-enabled error without leaking target data.

Snapshot staleness decision:

- Max age gate, default `24h`  
  `🎯 8   🛡️ 9   🧠 4`  
  Approx changes: `80-160` lines.  
  Recommended. It may block old snapshots, but it avoids silently authorizing
  writes from stale provider evidence.

- No age gate until webhook/sync exists  
  `🎯 6   🛡️ 5   🧠 2`  
  Approx changes: `20-60` lines.  
  Simpler UX, weaker authorization proof.

- Live GitHub revalidation in Phase 6  
  `🎯 4   🛡️ 8   🧠 7`  
  Approx changes: `500-900` lines.  
  Too early because Phase 6 intentionally has no token broker or GitHub HTTP.

## GitHub Contract Facts

These facts should be re-checked during implementation against official GitHub
docs:

- GitHub App installation tokens can be narrowed to selected repository ids and
  permissions.
- GitHub repository ids are stable provider ids and should be preferred for
  authority over display names.
- GitHub repository list APIs are paginated.
- GitHub App permissions are capability-specific; write actions should request
  the narrowest permission set needed.

References:

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- https://docs.github.com/en/rest/apps/apps
- https://docs.github.com/en/rest/apps/installations

## Bounded Context

### `integration-targets`

Owns explicit action targets for provider integrations.

Entities:

- `IntegrationTarget`
- `RepositoryTargetBinding`
- `TargetPolicyRule`
- `TargetActorGrant`

Responsibilities:

- bind a provider repository to a workspace target
- keep target identity provider-neutral
- enforce workspace/connection ownership
- separate provider availability from product authorization
- provide policy queries for later action dispatch
- mark targets stale when provider snapshot is incomplete or stale

Does not:

- call GitHub
- mint provider tokens
- post comments
- know about GitHub setup sessions
- parse agent-authored text as authority

## Package Shape

```text
control-plane/
  packages/features/
    integration-targets/
      src/domain/
      src/application/
        ports/
        use-cases/
      src/infrastructure/prisma/
      src/interface/nest/
```

Suggested exports:

```text
@agent-teams-control-plane/features-integration-targets
@agent-teams-control-plane/features-integration-targets/interface/nest
```

Architecture rules:

- domain/application use only shared primitives and feature ports
- Nest lives only in `interface/nest`
- Prisma lives only in infrastructure adapters
- no GitHub SDK imports in Phase 6
- cross-feature access uses ports, not infrastructure imports
- package root exports only public application/domain contracts needed by later
  phases; it must not expose `infrastructure/*`

Suggested application ports:

```text
IntegrationConnectionReader
RepositoryAvailabilityReader
IntegrationTargetRepository
TargetPolicyRepository
IntegrationTargetAuditLog
IntegrationTargetsFeatureGatePolicy
Clock
TransactionRunner
```

Adapter guidance:

- `IntegrationConnectionReader` can wrap the existing
  `IntegrationConnectionRepository` for connection ownership/status.
- `RepositoryAvailabilityReader` can read Phase 5 repository availability rows
  through a Prisma adapter because the existing public repository port does not
  expose individual repository snapshots yet.
- Application code should not know whether repository availability came from the
  existing `integration-connections` repository or a direct Prisma read model.

## Domain Model

### `IntegrationTarget`

Represents a target that future agent actions may address.

Fields:

- `id`
- `workspaceId`
- `integrationConnectionId`
- `provider`
- `targetKind`
- `providerTargetId`
- `displayName`
- `status`
- `createdAtMs`
- `updatedAtMs`
- `staleAtMs?`
- `disabledAtMs?`
- `deletedAtMs?`

Allowed `targetKind` for Phase 6:

- `github_repository`

Allowed `status`:

- `enabled`
- `disabled`
- `stale`
- `revoked`
- `deleted`

Invariants:

- target belongs to exactly one workspace
- target belongs to exactly one active integration connection
- target provider matches connection provider
- provider target id is immutable after creation
- deleted targets are never used for authorization
- stale targets cannot be used for write actions until revalidated or explicitly
  allowed by a future policy

### `RepositoryTargetBinding`

GitHub-specific repository metadata linked to a provider-neutral target.

Fields:

- `id`
- `integrationTargetId`
- `githubInstallationId`
- `githubRepositoryId`
- `githubNodeId?`
- `displayOwner`
- `displayName`
- `displayFullName`
- `private`
- `archived`
- `lastVerifiedAtMs`
- `repositoryAvailabilitySnapshotId?`

Invariants:

- `githubRepositoryId` is authority
- display fields are non-authoritative snapshots
- archived repositories default to disabled unless the user explicitly enables a
  read-only future mode
- if Phase 5 sync is incomplete, target creation must trigger safe revalidation
  or return a safe "snapshot incomplete" error

### `TargetPolicyRule`

Defines what a trusted actor can request for a target.

Fields:

- `id`
- `workspaceId`
- `integrationTargetId`
- `subjectKind`
- `subjectId`
- `capability`
- `effect`
- `createdAtMs`
- `createdByDesktopClientId`

Suggested `subjectKind`:

- `workspace`
- `team`
- `agent`
- `desktop_client`

Suggested `capability`:

- `github.issue_comment.request`
- `github.pr_comment.request`
- `github.pr_review.request`
- `github.check_run.request`

Phase 6 only stores/evaluates these capabilities. It does not execute them.

Suggested `effect`:

- `allow`
- `deny`

Rules:

- explicit deny wins over allow
- target disabled/revoked/deleted denies everything
- stale target denies write-oriented capabilities
- workspace-level allow may be overridden by team/agent deny
- unknown capabilities deny by default

## Data Model

Suggested tables:

```text
integration_targets
  id uuid pk
  workspace_id uuid not null
  integration_connection_id uuid not null
  provider text not null
  target_kind text not null
  provider_target_id text not null
  display_name text not null
  status text not null
  policy_version integer not null default 1
  created_at timestamptz not null
  updated_at timestamptz not null
  stale_at timestamptz null
  disabled_at timestamptz null
  deleted_at timestamptz null

github_repository_target_bindings
  id uuid pk
  integration_target_id uuid not null unique
  github_installation_id text not null
  github_repository_id text not null
  github_node_id text null
  display_owner text not null
  display_name text not null
  display_full_name text not null
  private boolean not null
  archived boolean not null
  last_verified_at timestamptz not null
  repository_availability_snapshot_id uuid null

target_policy_rules
  id uuid pk
  workspace_id uuid not null
  integration_target_id uuid not null
  subject_kind text not null
  subject_id text not null
  capability text not null
  effect text not null
  created_at timestamptz not null
  created_by_desktop_client_id uuid not null
```

Indexes:

- unique active target by `(workspace_id, integration_connection_id,
target_kind, provider_target_id)` where status is not `deleted`
- unique GitHub repo target by `(integration_target_id)`
- index target lookup by `(workspace_id, status)`
- index policy lookup by `(workspace_id, integration_target_id, subject_kind,
subject_id, capability)`
- optional partial index for enabled targets only
- optimistic policy update check by `(id, workspace_id, policy_version)`

Prisma/Postgres note:

- partial unique indexes are a required authorization guard, but they are not a
  good fit for Prisma schema-only modeling
- create partial unique indexes in the SQL migration explicitly
- keep matching non-unique Prisma-visible indexes only when they help query plans
- repository adapter must catch unique-constraint conflicts and map them to
  deterministic safe errors instead of leaking Prisma error details
- do not replace the partial unique index with an application-only check

Migration ordering:

1. Create `integration_targets`.
2. Create `github_repository_target_bindings` with a foreign key to
   `integration_targets`.
3. Create `target_policy_rules` with a foreign key to `integration_targets`.
4. Add partial unique indexes last so failed backfills cannot leave a half-valid
   authorization surface.

The migration should not backfill targets automatically from repository
availability snapshots. Explicit enablement is the security boundary.

## Config

New config keys:

- `CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED`
- `CONTROL_PLANE_REPOSITORY_AVAILABILITY_MAX_AGE_HOURS`

Rules:

- target list APIs can work when the gate is disabled only if they return safe
  empty/not-enabled responses; writes must be blocked
- max age default should be `24`, with sane bounds such as `1..720`
- config summaries expose only gate state and max age, not repository names or
  policy documents
- hosted modes should fail readiness if Phase 8 is enabled while Phase 6 targets
  are disabled

## Use Cases

### `ListAvailableRepositoryTargetsUseCase`

Input:

- authenticated `DesktopClientActor`
- `integrationConnectionId`
- pagination
- optional filters: `available`, `archived`, `targetStatus`

Output:

- available repositories
- current target binding status
- repository sync status

Rules:

- feature gate must be enabled
- desktop client must belong to workspace
- connection must be active and owned by workspace
- deleted/suspended connections are hidden or returned as safe errors
- repository display names are safe snapshots
- if repository sync is partial, response exposes safe incomplete status
- no GitHub HTTP is performed while listing available targets

### `EnableRepositoryTargetUseCase`

Input:

- authenticated `DesktopClientActor`
- `integrationConnectionId`
- `githubRepositoryId`
- optional initial policy grants
- idempotency key

Output:

- target id
- target status
- effective policy summary

Rules:

- feature gate must be enabled
- connection must be active
- repository must be present in availability snapshot and `available=true`
- if snapshot is partial/stale, return safe
  `CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED`
- if snapshot `lastVerifiedAt` is older than configured max age, return the same
  safe revalidation-required error
- archived repo is disabled by default
- same repository enable is idempotent by
  `(workspaceId, connectionId, providerRepositoryId)`
- enabling an already enabled target returns existing target
- enabling an existing target with different initial policy returns
  `CONTROL_PLANE_TARGET_ALREADY_ENABLED_WITH_DIFFERENT_POLICY`
- enabling a disabled target re-enables it and writes audit
- enabling a revoked/deleted target requires explicit recreate path or safe error

### `DisableRepositoryTargetUseCase`

Input:

- authenticated `DesktopClientActor`
- `targetId`
- optional reason code

Rules:

- target must belong to actor workspace
- disabled target remains idempotently disabled
- disable does not delete audit history or policy rows
- Phase 8 action requests against disabled target must be denied

### `UpdateTargetPolicyUseCase`

Input:

- authenticated `DesktopClientActor`
- `targetId`
- complete desired policy document
- `expectedPolicyVersion`

Rules:

- feature gate must be enabled
- actor workspace must own target
- policy capabilities must be known
- subject ids are opaque, not trusted names
- invalid capabilities fail safely
- policy updates are transactional
- policy update increments `policyVersion`
- stale `expectedPolicyVersion` returns safe conflict
- audit stores safe summary only

### `EvaluateTargetPolicyUseCase`

Input:

- `workspaceId`
- `targetId`
- `subjectKind`
- `subjectId`
- `capability`

Output:

- `allowed: boolean`
- safe reason code
- policy version or timestamp

Rules:

- no side effects
- deny by default
- target status gates before policy rules
- unknown capabilities deny
- deleted/stale/revoked targets deny write capabilities
- evaluate matching rules in deterministic order:
  1. workspace-level rules for the target
  2. desktop-client rules for the asserting desktop client
  3. team rules when `teamId` is present
  4. agent rules when `agentId` is present
- explicit deny wins across all matching rules, regardless of specificity
- if there is no deny and at least one matching allow, return allowed
- include safe denial reason and policy version/timestamp in the result

## API Shape

Desktop API:

```text
GET  /api/desktop/v1/integrations/:connectionId/repository-targets/available
POST /api/desktop/v1/integrations/:connectionId/repository-targets
GET  /api/desktop/v1/repository-targets
GET  /api/desktop/v1/repository-targets/:targetId
POST /api/desktop/v1/repository-targets/:targetId/disable
POST /api/desktop/v1/repository-targets/:targetId/enable
PUT  /api/desktop/v1/repository-targets/:targetId/policy
POST /api/desktop/v1/repository-targets/:targetId/policy/evaluate
```

No public API should be added in Phase 6.

## Policy Capability Mapping

Phase 6 stores product capabilities, not GitHub permissions.

Initial capabilities:

```text
github.issue_comment.request
github.pr_comment.request
github.pr_review.request
github.check_run.request
```

Phase 7 maps capabilities to GitHub App permissions. Phase 8 maps capabilities
to actual action types.

## Agent Identity And Subject Model

Phase 6 should not authenticate agents directly. It should store policy against
opaque ids that the desktop/runtime will later present through a trusted action
request envelope.

Suggested subject ids:

- `workspace:<workspaceId>`
- `team:<teamId>`
- `agent:<agentId>`
- `desktop-client:<desktopClientId>`

Rules:

- never trust agent-provided display names for policy
- store display labels only as optional safe UI metadata
- policy authority is ids, not text labels
- reject subject ids over 256 chars or without one of the allowed prefixes
- Phase 8 must render agent display name/avatar separately from authorization

## State Machines

### Repository target

```text
enabled <-> disabled
enabled -> stale -> enabled
enabled|disabled|stale -> revoked
enabled|disabled|stale|revoked -> deleted
```

Rules:

- `enabled`: action requests may pass policy evaluation
- `disabled`: action requests denied until re-enabled
- `stale`: provider snapshot is incomplete/stale; write actions denied
- `revoked`: connection no longer authorizes target; action requests denied
- `deleted`: hidden from normal lists; never authorized

### Policy rule

```text
created
  -> replaced
  -> removed
```

Policy writes should be versioned or auditable enough to explain future action
denials.

## Transactions

Target enablement must be one transaction:

```text
lock integration connection
check connection ownership/status
check repository availability snapshot
upsert target
upsert github repository binding
replace/insert initial policy rules
increment policy version if policy changes
write audit event
```

No GitHub HTTP should run inside or before the transaction in Phase 6. If
revalidation is needed, Phase 6 returns a safe error and leaves target state
unchanged.

Locking guidance:

- if connection/target locking needs `SELECT ... FOR UPDATE`, use parameterized
  Prisma raw queries only inside `infrastructure/prisma`
- never use Prisma unsafe raw SQL helpers
- application use cases depend on a `RepositoryTargetLockPort` or repository
  method, not on raw SQL details

## Idempotency

Required behavior:

- enabling the same repository twice returns the same target
- disabling an already disabled target returns success
- policy update with the same `expectedPolicyVersion` and identical policy
  fingerprint returns the same policy result
- policy update with stale `expectedPolicyVersion` fails with safe conflict
- policy fingerprint is computed from canonical JSON: sorted rules, normalized
  subject ids, normalized capabilities, and no display labels
- concurrent target enables for the same repo produce one target
- deleted target recreate requires explicit future design

## Failure Modes

- Connection deleted between list and enable: safe conflict or not-found.
- Repository snapshot missing: safe validation error.
- Repository snapshot partial: safe revalidation-required error.
- Repository archived: safe validation error unless product allows read-only
  target.
- Concurrent enable: one target, idempotent response.
- Policy references unknown agent id: accepted only as a valid opaque subject id;
  future registry lookup can tighten this without changing stored policy shape.
- Connection suspended: target enable/update denied.
- Target stale: Phase 8 action authorization denied.

## Security And Privacy

- Do not store repository code, patches, diffs, raw prompts, or model output.
- Store only provider ids and display metadata already available from GitHub
  repository listings.
- Audit policy changes with safe summaries only.
- Do not log full request bodies for policy updates if they may include future
  sensitive descriptions.
- No provider tokens in Phase 6.

## Observability

Metrics:

- target enable attempts
- target enable failures by safe code
- target policy evaluations allowed/denied by capability
- stale target count
- partial repository sync blocks

Logs:

- safe workspace/connection/target ids
- safe reason codes
- no repository code
- no raw agent messages

## Tests

Unit tests:

- target enable happy path
- enabling missing repository fails
- enabling partial/stale snapshot fails closed
- enabling expired repository snapshot fails closed
- enabling archived repository fails safely
- same repo enable is idempotent
- concurrent enable behavior at repository adapter level
- partial unique index exists in SQL migration and duplicate active target maps
  to safe conflict
- disabled target denies policy evaluation
- stale target denies write capability
- explicit deny wins over allow
- unknown capability denies
- policy replacement is transactional
- policy update stale version conflict
- canonical policy fingerprint makes duplicate policy writes idempotent
- duplicate enable with different initial policy fails safely
- feature gate disabled blocks writes
- opaque subject id validation

Architecture tests:

- domain/application do not import Nest, Prisma, GitHub SDK, platform adapters
- GitHub-specific repository binding code stays in infrastructure or
  GitHub-target adapter

Integration tests with DB when env exists:

- unique active target constraints
- concurrent enable attempts
- policy lookup indexes
- soft delete behavior

Verification:

```text
pnpm --dir control-plane format:check
pnpm --dir control-plane architecture:check
pnpm --dir control-plane lint
pnpm --dir control-plane typecheck
pnpm --dir control-plane test
pnpm --dir control-plane build
pnpm --dir control-plane verify:phase1
```

## Acceptance Criteria

- repository target bindings are explicit and separate from availability
  snapshots
- no GitHub writes or installation token issuance exist
- target policy can deny/allow future action requests
- Phase 8 can ask one use case whether an action request is authorized
- partial/stale repository snapshots do not accidentally authorize writes
- all public APIs remain authenticated desktop APIs only
- verification commands pass

## Rollout Plan

1. Add `integration-targets` package scaffold.
2. Add domain entities and policy evaluator.
3. Add Prisma schema/migration for targets and policies.
4. Add repository adapter.
5. Add desktop APIs.
6. Add tests and architecture guardrails.
7. Update docs and run verification.

## Open Questions

- Should unknown `agentId` policy subjects be allowed as opaque ids before a
  formal agent registry exists? V1 answer: yes, with strict subject-id shape and
  length validation.
- Should archived repositories be completely blocked or allow future read-only
  actions?
- Should target policy be replace-whole-document or patch-based in V1? V1
  answer: replace-whole-document with optimistic `expectedPolicyVersion`.
- How long before repository availability snapshots become stale? V1 answer:
  configurable max age with `24h` default.

## What Comes Next

Phase 7 should use enabled targets and policy capabilities to mint narrowly
scoped installation tokens server-side. It should not accept raw repository ids
from action requests without resolving them through Phase 6 target bindings.
