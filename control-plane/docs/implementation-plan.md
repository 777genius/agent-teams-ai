# Control Plane Implementation Plan

## Purpose

This plan describes how to create the Agent Teams Control Plane foundation without rushing into GitHub-specific code too early.

The implementation should happen in phases. Each phase should leave the system coherent, testable, and reviewable.

## Phase 0 - Documentation And Repository Boundary

Status: completed in the scaffold branch.

Goals:

- create `control-plane/`
- document optional nature of the service
- decide architecture direction
- record NestJS modular monolith ADR
- record edge cases and security model

Deliverables:

- `control-plane/README.md`
- `control-plane/docs/architecture.md`
- `control-plane/docs/implementation-plan.md`
- `control-plane/docs/plan-review-and-hardening.md`
- `control-plane/docs/edge-cases.md`
- `control-plane/docs/security-and-privacy.md`
- `control-plane/docs/decisions/001-nestjs-modular-monolith.md`

No dependencies, package manifests, or executable code should be added in this phase.

## Phase 0.5 - Pre-Implementation Decision Gates

Goals:

- make the risky product/architecture decisions explicit before scaffold code exists
- avoid implementing a "generic service" that accidentally depends on hidden GitHub assumptions
- avoid promising self-hosted official-app mode without a token broker design

Required decisions:

- hosted official GitHub App is the V1 deployment target
- self-hosted official-app mode is deferred unless a hosted token broker ADR exists
- BYO GitHub App self-hosted mode is future/enterprise, not V1
- V1 GitHub App registration uses setup URL plus separate claim OAuth flow, not OAuth-during-install
- V1 GitHub comments are issue comments and top-level PR comments
- line-level review comments require a separate ADR
- agent identity comes from trusted desktop/runtime envelope, not agent-authored text
- Postgres is the v1 canonical store for metadata, idempotency, locks, and outbox
- no raw prompts, reusable model-output logs, repository code, diffs, or raw webhook payloads are stored by default
- external action content may be temporarily stored only as encrypted, short-retention dispatch payload
- GitHub REST API version is pinned after checking current official docs
- V1 GitHub App permissions are mapped per capability and kept minimal
- GitHub installation claim requires provider-side authority verification, not setup URL `installation_id` alone
- GitHub user access tokens used for claim verification are not persisted in V1
- GitHub App client secret remains hosted control-plane secret only
- GitHub claim OAuth uses short-lived state and PKCE

Deliverables:

- [Plan Review And Hardening](plan-review-and-hardening.md)
- ADR for deployment modes and GitHub App secret custody
- ADR for agent identity envelope and attribution rendering
- ADR for GitHub comment modes
- ADR for outbox transaction and recovery strategy
- ADR for external action content storage, encryption, and retention
- ADR for content encryption key management and crypto-shredding
- ADR for GitHub API version and permission mapping policy
- ADR for GitHub installation claim authority and user authorization flow
- ADR for GitHub App registration settings and OAuth/device-flow policy

Acceptance criteria:

- all required V1 decisions are accepted or explicitly deferred
- implementation PRs can point to an ADR instead of re-litigating deployment/security basics
- docs clearly distinguish hosted official app mode from self-hosted BYO app mode
- setup URL `installation_id` is documented as untrusted input
- docs clearly state that OAuth-during-install is not enabled in V1 when using setup URL

Approximate change size:

```text
🎯 10   🛡️ 10   🧠 4
~600-1200 lines
```

## Phase 1 - Workspace Scaffold

Status: implemented in the scaffold branch.

Goals:

- add `control-plane/package.json`
- add `control-plane/pnpm-workspace.yaml`
- add TypeScript config
- add ESLint/prettier config
- add `apps/api`
- add `apps/worker`
- add `packages/shared`
- add `packages/platform/config`
- add `packages/platform/logger`
- add architecture boundary checker
- add placeholder config keys for external API versions without real secrets

Dependency policy:

- verify latest stable versions before adding dependencies
- pin versions through lockfile
- verify current official docs before pinning a GitHub REST API version
- avoid adding infrastructure SDKs before their phase

Expected packages:

- NestJS core/platform package
- TypeScript
- Zod or equivalent validation library
- test runner
- lint tooling

Do not add Prisma, Octokit, queue, or billing dependencies yet.

Acceptance criteria:

- `pnpm --dir control-plane install --frozen-lockfile`
- `pnpm --dir control-plane format:check`
- `pnpm --dir control-plane typecheck`
- `pnpm --dir control-plane test`
- `pnpm --dir control-plane architecture:check`
- `pnpm --dir control-plane lint`
- `pnpm --dir control-plane build`
- `pnpm --dir control-plane worker:smoke`
- `pnpm --dir control-plane worker:smoke:dist`
- `pnpm --dir control-plane api:smoke`
- `pnpm --dir control-plane api:smoke:dist`
- `pnpm --dir control-plane config:hosted-failfast`
- API app has `/health`
- worker app boots and exits cleanly in smoke mode
- `domain/application` forbidden import check is active
- forbidden pre-phase SDK dependency check is active
- no request-scoped Nest provider is used in domain/application wiring
- no `forwardRef()` exists
- feature packages expose only explicit entrypoints
- config validation can fail startup on missing required hosted-mode settings without breaking local-disabled mode

Approximate change size:

```text
🎯 9   🛡️ 9   🧠 5
~800-1400 lines
```

## Phase 2 - Shared Kernel And Platform Basics

Goals:

- add shared `Result`
- add shared error primitives
- add typed IDs
- add clock/time helpers
- add config loader and env validation
- add logger abstraction

Packages:

```text
packages/shared/result
packages/shared/errors
packages/shared/ids
packages/shared/time
packages/shared/validation
packages/platform/config
packages/platform/logger
```

Rules:

- shared must not know about Nest
- platform may use Nest where useful
- config must validate env at boot
- errors exposed over public APIs must be safe and stable

Acceptance criteria:

- safe error format documented in [Public Error Contract](error-contract.md)
- unit tests for Result/errors/config
- API health route includes version/build metadata without secrets

Approximate change size:

```text
🎯 9   🛡️ 9   🧠 5
~700-1200 lines
```

## Phase 3 - API/Error/Observability Platform Layer

Goals:

- add `packages/platform/api`
- add framework adapter for public safe error responses
- add request and correlation id propagation
- add request context store for API request scope
- add safe request logging with duration/status/method/path
- add global Nest exception filter and request interceptor
- keep all public errors aligned with [Public Error Contract](error-contract.md)

Important rule:

API adapters normalize errors and observability metadata only. They do not perform
auth decisions, persistence, GitHub calls, queue dispatch, pairing, billing, or
provider-specific error mapping.

Acceptance criteria:

- every API response receives `x-request-id` and `x-correlation-id`
- safe incoming correlation/request ids are preserved
- unsafe incoming ids are ignored and replaced
- `SafeError` values serialize to the public error contract
- unknown exceptions serialize to `CONTROL_PLANE_INTERNAL_ERROR`
- public error responses do not expose stack traces or raw exception messages
- health response keeps version/build metadata and no secrets
- request logs include safe metadata only
- global filter/interceptor are registered once through platform module wiring
- architecture guardrails still pass

Approximate change size:

```text
🎯 9   🛡️ 9   🧠 5
~600-1100 lines
```

## Phase 4 - Database, Transactions, Outbox, Locks

Detailed plan: [Phase 4 Persistence, Transactions, Outbox, Locks Plan](phase-4-persistence-transactions-outbox-locks-plan.md)

Goals:

- add database platform package
- add migration setup
- add transaction port
- add outbox feature
- add encrypted external action content store
- add platform crypto adapter for envelope encryption
- add distributed lock port and initial DB-backed adapter
- add dead-letter state

Important rule:

No external side effects happen inline in request handlers. Requests record intent and outbox events; workers perform side effects.

Recommended v1 storage:

- Postgres as canonical metadata store
- DB-backed outbox and locks
- Postgres-backed encrypted ExternalActionContent for atomic action/outbox/content transaction
- no Redis/Kafka/queue service until DB-backed processing is proven insufficient
- no object storage for ExternalActionContent until atomicity/lifecycle ADR exists

Core tables:

```text
OutboxEvent
DeadLetterEvent
AuditEvent
ExternalActionContent
ExternalActionContentKeyRef
```

Potential later tables:

```text
Workspace
DesktopClient
IntegrationConnection
AgentActionRequest
GitHubInstallation
```

Acceptance criteria:

- outbox event can be appended inside transaction
- worker claims pending event
- retry with backoff exists
- stale processing recovery exists or is explicitly documented as a follow-up gate before GitHub side effects
- unknown event version becomes dead letter
- no in-memory lock is used for correctness
- idempotency has database uniqueness, not only application checks
- worker shutdown does not lose claimed events
- outbox event payload stores content reference/hash, not raw comment body
- encrypted content can be deleted or cryptographically shredded after success
- dead-letter retention policy for encrypted content is explicit
- each ExternalActionContent row uses envelope encryption with per-content data encryption key
- key rotation/rewrap path is documented or implemented before public rollout
- decryption failure fails safe and never posts regenerated/best-effort content

Approximate change size:

```text
🎯 9   🛡️ 10   🧠 7
~1200-2200 lines
```

## Phase 5 - identity-access And desktop-pairing

Goals:

- introduce workspace identity
- introduce desktop client identity
- introduce external account identity link for provider claim flows
- implement short-lived pairing code
- implement revocable desktop client token
- implement resumable hosted setup session model for desktop-started integrations
- implement trusted desktop/runtime action envelope shape
- represent GitHub setup state ownership even before GitHub connector side effects

Feature packages:

```text
packages/features/identity-access
packages/features/desktop-pairing
```

Use cases:

- `StartDesktopPairing`
- `CompleteDesktopPairing`
- `RotateDesktopClientToken`
- `RevokeDesktopClient`
- `ValidateDesktopClientSession`
- `StartHostedIntegrationSetupSession`
- `GetHostedIntegrationSetupSession`
- `CancelHostedIntegrationSetupSession`
- `LinkExternalAccountIdentity` later, when GitHub claim flow is implemented

Security rules:

- pairing code is short-lived
- pairing code is single-use
- desktop token is scoped to workspace/client
- desktop token can be revoked
- desktop token is not a GitHub token
- agent identity snapshot is attribution metadata, not an authorization grant
- paired desktop identity does not prove GitHub organization or repository authority
- setup session id is correlation data, not authentication
- hosted setup sessions expire and can be cancelled

Acceptance criteria:

- unit tests for pairing expiry and single-use
- integration tests for token validation
- route tests for pairing endpoints
- audit events for pairing complete and revoke
- action envelope rejects free-form identity payloads that do not match schema
- old/rotated desktop token cannot submit new external actions
- GitHub installation binding cannot be completed with desktop token alone
- desktop can resume active setup session after app restart
- expired/cancelled setup session cannot become connected later

Approximate change size:

```text
🎯 9   🛡️ 9   🧠 7
~1200-2200 lines
```

## Phase 6 - integration-registry

Goals:

- introduce generic integration model
- define capabilities
- define external targets
- bind workspace targets to integration connections

Feature package:

```text
packages/features/integration-registry
```

Concepts:

```text
IntegrationKind = github | telegram | slack | discord | runtime | billing
ExternalActionKind = github_issue_comment | github_pull_request_top_level_comment | messenger_message | check_run
ExternalTarget = github_repository | github_pull_request | messenger_channel
```

Use cases:

- `RegisterIntegrationConnection`
- `SetIntegrationCapabilityState`
- `BindExternalTarget`
- `ResolveGitHubTargetBinding`
- `ValidateExternalTarget`
- `SyncIntegrationTargetAvailability`
- `ResolveIntegrationCapability`
- `ListWorkspaceIntegrations`

Acceptance criteria:

- GitHub-specific data does not leak into generic registry model
- capability resolver can answer "can this workspace post PR comments?"
- capability states include unclaimed, pending_claim, connected, suspended, permission_missing, target_not_enabled
- installing GitHub App on all repos does not automatically enable all repos for agent actions
- local git remote, branch, `owner/name`, and PR URL are accepted only as target hints
- GitHub repository authorization uses immutable repository id from verified installation repository access
- top-level PR comment target validates that the PR base repository id equals the bound repository id
- issue comment target validates whether the issue is allowed for the requested action kind
- repository rename updates display snapshots without changing authority
- issue/PR body and pull request diff content are not stored during target validation
- tests cover missing integration, disabled capability, unbound target, fork PR, renamed repository, and PR number from another repository

Approximate change size:

```text
🎯 10   🛡️ 9   🧠 7
~1000-1800 lines
```

## Phase 7 - agent-actions

Goals:

- implement generic external action request flow
- include idempotency
- include entitlement checks through port
- include audit through port
- write outbox event instead of direct side effect

Feature package:

```text
packages/features/agent-actions
```

Use cases:

- `RequestExternalAction`
- `GetExternalActionStatus`
- `CancelExternalAction` later

Ports:

- `AgentActionRepository`
- `ExternalActionContentStore`
- `IntegrationCapabilityResolver`
- `ExternalActionDispatcher`
- `EntitlementPort`
- `AuditLogPort`
- `OutboxPort`

Acceptance criteria:

- duplicate idempotency key returns existing action
- unauthorized target is rejected
- disabled integration is rejected
- allowed action creates outbox event
- allowed comment action stores encrypted ExternalActionContent with content hash
- audit/outbox metadata does not contain raw comment body
- use case tests run without Nest

Approximate change size:

```text
🎯 10   🛡️ 9   🧠 8
~1500-2600 lines
```

## Phase 8 - github-app Foundation

Goals:

- implement GitHub App installation setup callback
- implement signed setup state validation
- implement unclaimed installation state for installs started from GitHub without desktop state
- implement pending installation claim state for setup URL redirects
- implement GitHub user authorization verification for claim completion
- implement claim OAuth state and PKCE validation
- implement webhook signature verification
- implement webhook normalization
- implement installation/repository sync
- implement installation token issuer
- implement scoped token request policy by target repository and permission set

Feature package:

```text
packages/features/github-app
```

Platform package:

```text
packages/platform/github-sdk
```

Use cases:

- `HandleGitHubAppSetup`
- `StartGitHubInstallationClaim`
- `CompleteGitHubInstallationClaim`
- `StartGitHubClaimOAuth`
- `HandleGitHubClaimOAuthCallback`
- `NormalizeGitHubWebhook`
- `ProcessGitHubInstallationEvent`
- `SyncGitHubInstallationRepositories`
- `IssueGitHubRepositoryToken`

Security rules:

- private key only read by server-side platform adapter
- raw webhook payload is not persisted
- repository authorization uses immutable GitHub repository id
- app suspended/deleted blocks actions
- webhook verification uses raw request body and `X-Hub-Signature-256`
- installation tokens are not persisted and are scoped to exact target repository where possible
- setup URL `installation_id` is treated as untrusted until verified by GitHub-side authority check
- GitHub user access token used for claim verification is not persisted in V1
- GitHub App client secret is only read by server-side OAuth adapter
- OAuth callback validates `state`, exact redirect URI assumptions, and PKCE verifier

Acceptance criteria:

- webhook duplicate delivery is idempotent
- unsupported signed event returns accepted/ignored
- installation deleted/suspended updates state
- repo rename keeps immutable id authority
- private key never appears in logs
- setup state is single-use and expires
- unclaimed installation cannot post comments
- pending claim cannot bind installation without GitHub user authorization verification
- repository already bound to another workspace fails closed
- missing webhook secret fails readiness/startup for hosted GitHub mode
- missing GitHub OAuth client secret fails readiness/startup for hosted claim mode
- expired installation token retry remints token without duplicating side effect
- OAuth-during-install is rejected by config/docs unless a future ADR switches to callback-only onboarding

Approximate change size:

```text
🎯 9   🛡️ 10   🧠 8
~1800-3200 lines
```

## Phase 9 - GitHub Agent Comments V1

Goals:

- connect `agent-actions` to `github-app`
- implement GitHub issue comment
- implement GitHub PR top-level comment
- render agent attribution card
- support update-or-create by hidden marker

Explicit non-goals:

- no line-level PR review comments in V1
- no multi-comment review submission in V1
- no check runs/statuses in this phase
- no broad GitHub token with all installation repositories when a single repository target is known

Use cases:

- `DispatchGitHubIssueComment`
- `DispatchGitHubPullRequestComment`

Ports:

- `GitHubCommentGateway`
- `GitHubCommentMarkerRepository` if needed

Comment requirements:

- app bot author in GitHub UI
- body shows agent name
- body shows team name
- body shows role if available
- body includes avatar
- body includes hidden marker
- attribution block is rendered by control-plane, not agent-authored markdown
- hidden marker includes schema version, opaque public marker id, and integrity digest
- hidden marker does not include internal workspace names, display names, prompts, code, diffs, tokens, reusable model-output logs, or raw external action content
- GitHub permission mapping is explicit for issue comments vs future review comments
- raw comment body is loaded only from encrypted ExternalActionContent during dispatch
- successful dispatch deletes or cryptographically shreds stored content

Acceptance criteria:

- agent cannot post to unbound repo
- agent cannot post without enabled capability
- PR top-level comment validates the PR exists and belongs to the bound base repository before creating an issue comment
- issue comment action does not accidentally comment on a PR unless that is explicitly allowed by the action kind
- repeat action does not create duplicate comment
- GitHub rate limit retries safely
- result is auditable
- if DB update fails after GitHub success, retry recovers by marker instead of posting duplicate
- hidden marker deleted by a human leads to a safe duplicate-policy decision, not silent corruption
- avatar fallback renders without local file paths
- secondary rate limit or spam response backs off without creating duplicate comments
- comment create/update uses the configured GitHub REST API version
- result metadata keeps content hash and external ids, not raw body
- dead-letter content retention is bounded and visible to authorized operators

Approximate change size:

```text
🎯 10   🛡️ 9   🧠 8
~1600-2800 lines
```

## Phase 10 - Desktop Integration

Goals:

- expose desktop pairing UI hooks in desktop app
- implement hosted GitHub setup session UI state machine
- list connected integrations
- surface GitHub connected repositories
- inject safe control-plane endpoint/token into MCP/runtime when enabled
- fail gracefully when control plane is not configured

Important rule:

Desktop remains fully usable without control-plane.

Agent/runtime rule:

- local agents do not receive GitHub tokens
- local agents do not hand-write attribution metadata
- desktop/runtime adapter sends a structured action request envelope
- control-plane unavailable returns explicit "hosted integration unavailable" instead of queuing silently
- desktop polls authenticated setup-session status instead of running a local callback server
- deep links or completion pages never contain OAuth codes, PKCE verifiers, client tokens, or GitHub tokens

Acceptance criteria:

- app starts without control-plane env
- GitHub actions unavailable state is clear
- connected state is visible
- token rotation/revoke handled
- no GitHub token is exposed to agent
- older desktop client receives stable version-mismatch error if API contract changes
- setup can show pending_installation, pending_claim, connected, failed, expired, and cancelled states
- desktop restart resumes active setup sessions
- stale browser callback for expired setup cannot flip UI to connected

Approximate change size:

```text
🎯 9   🛡️ 8   🧠 7
~1200-2400 lines
```

## Phase 11 - Messenger Connector Foundation

This phase validates that the architecture is not GitHub-centric.

Goals:

- add messenger connector interface
- add Telegram as first messenger candidate
- normalize inbound webhook events
- dispatch outbound agent messages

Acceptance criteria:

- no GitHub types in messenger domain
- agent-actions can route to messenger through same generic flow
- Telegram webhook raw body is not persisted
- duplicate messenger webhook does not duplicate messages

Approximate change size:

```text
🎯 8   🛡️ 8   🧠 8
~1800-3200 lines
```

## Recommended First PRs

1. Documentation-only foundation.
2. Decision-gate ADRs from Phase 0.5.
3. Workspace scaffold with architecture check.
4. Shared kernel and config/logger.
5. Outbox/audit/dead-letter foundation.
6. Desktop pairing.
7. Integration registry.
8. Agent actions.
9. GitHub App foundation.
10. GitHub comments V1.

Do not combine all phases into one PR.
