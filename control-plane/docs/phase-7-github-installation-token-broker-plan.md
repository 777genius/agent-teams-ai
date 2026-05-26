# Phase 7 - GitHub Installation Token Broker Plan

## Purpose

Phase 7 adds a server-side token broker for the official GitHub App. It mints
short-lived GitHub installation access tokens only inside the hosted control
plane and only for already enabled Phase 6 targets.

The important boundary:

```text
Agent/runtime request
  -> trusted action envelope
  -> target policy check
  -> token broker
  -> GitHub connector adapter
```

Desktop clients, local agents, and local runtime subprocesses must never receive
GitHub installation access tokens.

## Summary

Phase 7 should make GitHub side effects possible from the server's perspective,
but should not actually post comments/reviews/checks yet. It creates the
capability-scoped token broker that Phase 8 will call.

The implementation must answer:

1. Which workspace/target/capability is being requested?
2. Is the target enabled and authorized by Phase 6 policy?
3. Which GitHub installation owns the target?
4. What minimum GitHub App permissions and repository ids are needed?
5. Can the hosted control plane mint a short-lived token without exposing it?

## Decision

Build a `github-token-broker` feature with application ports and infrastructure
adapters. Do not hide token minting inside the future GitHub action dispatcher.

```text
🎯 9   🛡️ 10   🧠 7
~1200-2200 implementation lines
```

Why:

- token issuance is a security boundary, not a helper function
- it needs audit, idempotency, rate limits, permission mapping, and kill switches
- Phase 8 action dispatch can remain focused on action semantics
- future connectors can copy the broker pattern

Options:

- Dedicated broker feature  
  `🎯 9   🛡️ 10   🧠 7`  
  Approx changes: `1200-2200` lines.  
  Recommended. Makes token issuance visible, testable, and auditable.

- Broker inside `github-runtime` action adapter  
  `🎯 6   🛡️ 7   🧠 5`  
  Approx changes: `800-1600` lines.  
  Fewer files but mixes credential custody with side-effect execution.

- Mint token per action with no broker abstraction  
  `🎯 3   🛡️ 4   🧠 3`  
  Approx changes: `300-700` lines.  
  Fast but creates hidden token sprawl and weak auditability.

## Scope

Phase 7 should implement:

- `github-token-broker` bounded context
- GitHub App JWT creation using hosted private key custody
- installation access token minting adapter
- minimal permission mapping per product capability
- repository id narrowing for enabled targets
- token response kept inside server-side application boundary
- no shared or persistent token cache in V1
- optional exact-scope in-memory cache seam, disabled unless explicitly enabled
- safe audit events for token mint attempts/failures
- kill switches and readiness checks for hosted GitHub App credentials
- feature gate `CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED`
- test doubles for GitHub App auth
- architecture guardrails that prevent token broker imports in desktop-facing
  application code

Phase 7 must not implement:

- posting comments, reviews, checks, statuses, labels, or branch writes
- storing installation tokens in DB
- returning installation tokens to desktop, agents, or local runtime
- storing GitHub App private key outside hosted secret config
- accepting arbitrary repository ids without Phase 6 target resolution
- broad `contents: write` unless a later phase explicitly requires it
- webhook side effects

## Official GitHub Facts

These facts should be re-checked during implementation against GitHub docs:

- GitHub App installation access tokens are generated server-side from a GitHub
  App JWT and installation id.
- Installation tokens expire one hour after creation.
- By default, an installation token can access every repository available to the
  installation, so Phase 7 must always pass `repository_ids`.
- Token creation can be narrowed by repository ids and permissions; GitHub
  documents a limit of up to 500 repositories in that request.
- Requested permissions cannot exceed the permissions granted to the GitHub App.
- The installation token endpoint must be called with a GitHub App JWT, not with
  a user token or an existing installation token.
- GitHub App JWTs must use `RS256`; GitHub recommends `iat` about 60 seconds in
  the past for clock drift and requires `exp` no more than 10 minutes in the
  future.
- Fine-grained permissions must match the endpoint that will be called later.

References:

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
- https://docs.github.com/en/rest/apps/apps

## Plan-Improve Hardening Decisions

These decisions keep Phase 7 focused on token issuance while closing the highest
risk gaps:

- V1 starts with no token cache. If action volume later proves a need, add an
  exact-scope in-memory cache behind `GitHubInstallationTokenCache`, never a DB
  cache.
- `GitHubRepositoryScope` stores GitHub repository ids as strings from Phase 6,
  but the GitHub adapter must convert to safe JSON integers before calling
  `repository_ids`. Non-decimal or unsafe integer ids fail closed with
  `CONTROL_PLANE_GITHUB_REPOSITORY_ID_UNSUPPORTED`.
- JWT signing uses Node crypto and the hosted private key from config. No JWT
  library is required in V1; if one is added later, verify the latest stable
  version first and keep it inside `infrastructure/github`.
- Private key parsing is a fail-fast readiness concern. The config adapter must
  support normal PEM content and escaped-newline env values, but readiness and
  summaries expose only booleans and safe error codes.
- The broker use case is internal-only. Controllers may expose readiness and
  dry-run scope summaries, but no DTO can include `token`, `jwt`,
  `authorization`, or `privateKey` fields.
- A disabled feature gate denies token issuance before policy lookup and before
  GitHub HTTP, returning a safe not-enabled error.
- Readiness proves local config/key parseability only. It must not claim a
  workspace installation has the required repository permissions unless a dry-run
  or real token mint has checked that specific target.
- No token cache in V1 means action bursts can mint many installation tokens.
  Keep `TokenBrokerAbuseControlPolicy` active per workspace/installation to
  avoid token-endpoint secondary limits without adding a persistent token cache.

## Bounded Contexts

### `github-token-broker`

Owns server-side GitHub App token issuance.

Entities/value objects:

- `GitHubInstallationTokenRequest`
- `GitHubInstallationTokenLease`
- `GitHubPermissionSet`
- `GitHubRepositoryScope`
- `GitHubAppJwt`

Responsibilities:

- validate token request against workspace target policy
- map product capability to GitHub permission set
- mint GitHub App JWT
- call GitHub installation token endpoint
- return token only to server-side caller
- audit safe token issuance metadata

Does not:

- expose tokens over HTTP
- store tokens in persistence
- post comments
- evaluate agent-authored text
- own target bindings

### Existing Contexts Used

- `workspace-identity`: authenticates desktop only for admin/status APIs
- `integration-connections`: provides canonical installation binding
- `integration-targets`: resolves enabled repository targets and policy
- `platform/config`: hosted credential config
- `platform/crypto`: optional signing/private-key parsing helpers
- `audit`: records safe issuance attempts

## Package Shape

```text
control-plane/
  packages/features/
    github-token-broker/
      src/domain/
      src/application/
        ports/
        use-cases/
      src/infrastructure/github/
      src/infrastructure/cache/
      src/interface/nest/
```

Suggested ports:

```text
GitHubAppJwtSigner
GitHubInstallationTokenIssuer
GitHubInstallationTokenCache (optional, disabled in V1)
TargetAuthorizationPort
IntegrationConnectionLookupPort
TokenBrokerAuditLog
TokenBrokerAbuseControlPolicy
TokenBrokerFeatureGatePolicy
Clock
```

## Domain Model

### `GitHubInstallationTokenRequest`

Fields:

- `workspaceId`
- `integrationTargetId`
- `capability`
- `requestedByKind`
- `requestedById`
- `idempotencyKey?`
- `nowMs`

Rules:

- token broker feature gate must be enabled
- target must be enabled
- capability must be known
- actor must be allowed by Phase 6 policy
- target must resolve to one GitHub installation id and repository id
- request cannot specify raw provider token scope directly

### `GitHubPermissionSet`

Suggested V1 product-to-GitHub mapping:

```text
github.issue_comment.request -> issues: write
github.pr_comment.request    -> pull_requests: write
github.pr_review.request     -> pull_requests: write
github.check_run.request     -> checks: write
```

Notes:

- A GitHub pull request is also an issue for issue comments, but top-level PR
  discussion strategy should be explicit in Phase 8.
- If an endpoint requires additional permissions, add them through a reviewed
  mapping change, not ad hoc per adapter.
- Unknown capability denies.

### `GitHubInstallationTokenLease`

Fields:

- `token`
- `expiresAtMs`
- `githubInstallationId`
- `repositoryIds`
- `permissions`

Rules:

- only returned inside server process
- never serialized to public API
- never written to DB or logs
- cache key excludes raw token
- cache TTL must subtract safety margin
- `repositoryIds` are exact target repository ids, never display names

## Data Model

Phase 7 should avoid storing tokens. Optional tables:

```text
github_token_broker_audit_events
  id uuid pk
  workspace_id uuid not null
  integration_target_id uuid not null
  github_installation_id text not null
  capability text not null
  repository_count integer not null
  permission_summary_json jsonb not null
  status text not null
  safe_error_json jsonb null
  created_at timestamptz not null
```

If normal `audit_events` already covers this safely, do not add a separate
table. Prefer reuse unless query patterns need a dedicated table.

Do not add:

- token ciphertext column
- refresh token column
- GitHub App JWT storage
- private key storage table

## Use Cases

### `IssueGitHubInstallationTokenUseCase`

Input:

- trusted internal caller
- `workspaceId`
- `integrationTargetId`
- `capability`
- actor identity from trusted envelope
- optional idempotency/correlation id

Output:

- server-only `GitHubInstallationTokenLease`

Rules:

- feature gate must be enabled
- abuse/rate policy must allow the request before GitHub HTTP
- call Phase 6 policy evaluator before token minting
- resolve target to active integration connection
- deny disabled/stale/revoked/deleted target
- deny suspended/deleted integration connection
- deny when Phase 6 policy version changes between scope resolution and audit
  recording only if the implementation can detect it cheaply; otherwise Phase 8
  re-check remains the hard safety boundary before the GitHub write
- map capability to minimal permissions
- narrow token to repository id
- do not run GitHub HTTP inside DB transaction
- record safe audit summary
- do not log raw token

### `CheckGitHubTokenBrokerReadinessUseCase`

Input:

- none or deployment mode

Output:

- readiness report

Checks:

- hosted mode enabled
- GitHub App id configured
- GitHub App client id configured if production policy requires it
- private key configured and parseable
- app slug/config coherent
- REST API version configured
- token issuer adapter can be constructed

No live token minting should happen during normal readiness unless explicitly
configured as an admin smoke.

### `DryRunGitHubTokenScopeUseCase`

Input:

- authenticated desktop admin
- target id
- capability

Output:

- safe permission summary
- repository id count
- allowed/denied reason

Rules:

- no token is minted
- useful for UI/debugging
- no GitHub HTTP side effects
- returns safe reason when repository id cannot be converted to a supported
  GitHub `repository_ids` integer

## Token Cache Policy

Default recommendation:

```text
No shared DB token cache in V1.
No in-memory token cache in the first implementation unless tests prove repeated
action bursts need it.
```

If cache is added:

- key by `installationId + sortedRepositoryIds + sortedPermissions`
- never persist token
- TTL = GitHub expiry minus at least 60 seconds
- cache entry invalidated on connection suspended/deleted
- cache entry invalidated on target disabled/revoked/deleted
- do not reuse broader token for narrower capability unless exact permission set
  and repository scope match
- cache lookup must happen after target/policy validation, not before it

Options:

- No token cache  
  `🎯 8   🛡️ 10   🧠 3`  
  Approx changes: `700-1200` lines.  
  Recommended first. Simpler and safer; can optimize after action volume exists.

- In-memory exact-scope cache  
  `🎯 8   🛡️ 8   🧠 5`  
  Approx changes: `1000-1600` lines.  
  Useful for bursty check/comment flows, but needs invalidation discipline.

- Persistent encrypted token cache  
  `🎯 4   🛡️ 5   🧠 8`  
  Approx changes: `1500-2500` lines.  
  Not V1. Storing tokens increases breach blast radius.

## GitHub Adapter

Suggested adapter:

```text
GitHubRestInstallationTokenIssuer
```

Responsibilities:

- create app JWT through signer port
- call GitHub REST endpoint for installation token
- send pinned `X-GitHub-Api-Version`
- request `repository_ids` and permission map on every token request
- reject non-decimal or unsafe repository id conversion before HTTP
- parse expiry
- normalize GitHub errors into `SafeError`
- never include token/body in logs

Avoid adding Octokit unless there is a clear benefit. Native `fetch` keeps the
surface small for token issuance.

If Octokit is added later, verify latest stable version and keep it inside
`infrastructure/github`.

## Permission Mapping

Phase 7 should centralize the map:

```text
Product capability -> GitHub permission request -> allowed action kinds
```

Initial map:

```text
github.issue_comment.request:
  issues: write

github.pr_comment.request:
  pull_requests: write

github.pr_review.request:
  pull_requests: write

github.check_run.request:
  checks: write
```

Rules:

- default deny
- permission expansion requires tests and docs update
- action adapters must not override permissions ad hoc
- PR top-level comments still use the issue comments endpoint in Phase 8, but
  the token broker maps the product capability to `pull_requests: write` so PR
  conversation comments do not require broad issues access
- repository scope must be exactly target repo unless action explicitly supports
  multi-repo with policy proof for each repo

## Config

Required hosted config:

- `CONTROL_PLANE_GITHUB_APP_ID`
- `CONTROL_PLANE_GITHUB_APP_CLIENT_ID` (optional but preferred as JWT issuer)
- `CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY`
- `CONTROL_PLANE_GITHUB_REST_API_VERSION`
- `CONTROL_PLANE_PUBLIC_BASE_URL`
- `CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED`
- Phase 5 OAuth/setup config remains required for onboarding flows

Safe summary may expose:

- app id configured: boolean
- app client id configured: boolean
- private key configured: boolean
- rest api version string
- hosted mode readiness status
- token broker feature gate: boolean

Safe summary must not expose:

- private key
- installation tokens
- app JWTs
- full GitHub error bodies

## API Shape

Phase 7 should expose only admin/status APIs:

```text
GET  /api/desktop/v1/integrations/github/token-broker/readiness
POST /api/desktop/v1/repository-targets/:targetId/github-token-scope/dry-run
```

No API returns a token.

Internal API/port:

```text
IssueGitHubInstallationTokenUseCase.execute(input) -> GitHubInstallationTokenLease
```

The use case is injectable for Phase 8 but not exposed through public
controllers.

## Transactions

Token issuance should use two short sections:

```text
read target/connection/policy in a transaction or consistent repository method
release transaction
validate repository id conversion and permission map
call GitHub token endpoint
write safe audit result
```

No GitHub HTTP inside DB transactions.

## Idempotency

Token issuance itself does not need user-visible idempotency because tokens are
short-lived credentials, but request evaluation must be deterministic:

- same target/capability/actor either allowed or denied consistently
- cache hit returns equivalent lease scope
- audit can record repeated mint attempts without treating them as duplicates
- token broker must never broaden scope to satisfy a request

## Failure Modes

- Missing private key: readiness fail, token request safe validation error.
- Invalid private key: readiness fail, safe internal/config error.
- Private key with escaped newlines: normalized before parse.
- GitHub API 401/403: safe authorization/external error, no token logged.
- GitHub API 422: safe non-retryable scope/config error.
- GitHub API 429/5xx: retryable external error.
- GitHub token endpoint secondary rate limit: retryable external error with
  provider backoff metadata for Phase 8/outbox scheduling.
- GitHub token endpoint returns a token with broader repository/permission scope
  than requested: treat as internal/external invariant failure and do not return
  the lease.
- Target disabled after policy check before token use: Phase 8 must re-check
  before action dispatch; Phase 7 should make token lease short-lived.
- Connection suspended: deny before token mint.
- Repository removed from installation: GitHub token mint or later action fails;
  mark target stale in Phase 8 or a future sync phase.
- Cache entry exists but target disabled: exact-scope cache must consult target
  status or be invalidated.
- Repository id cannot be represented safely as a JSON integer: deny with
  `CONTROL_PLANE_GITHUB_REPOSITORY_ID_UNSUPPORTED`; do not fall back to mutable
  repository names.

## Security And Privacy

- GitHub App private key stays in hosted secret config only.
- App JWTs and installation tokens are never persisted.
- Tokens are never returned to desktop/agents/runtime.
- Logs and audit store only ids, permission names, repository count, safe error
  codes.
- Permission map is minimum necessary.
- Token TTL is short and never extended by the broker.
- Self-hosted BYO mode must use customer-owned app credentials, not official app
  private key.

## Observability

Metrics:

- token requests allowed/denied
- token mints by capability
- GitHub token API latency
- GitHub token API failures by safe code
- cache hit/miss if cache exists

Logs:

- correlation id
- workspace id
- target id
- installation id
- capability
- safe result code

Never log:

- token
- JWT
- private key
- raw GitHub response body

## Tests

Unit tests:

- capability maps to exact permission set
- unknown capability denies
- disabled target denies
- stale target denies write capability
- policy deny blocks token mint
- abuse/rate policy blocks token mint before GitHub HTTP
- token issuer called only after policy allow
- token issuer response scope is validated against requested repositories and
  permissions when GitHub returns scope metadata
- token response is not serializable through controller API
- GitHub API retryable statuses map to retryable safe errors
- private key missing fails readiness
- escaped-newline private key parses or fails safely
- JWT signer sets `iat`/`exp` within GitHub limits and uses `RS256`
- repository id conversion rejects non-decimal and unsafe integers
- cache does not broaden scope
- feature gate disabled blocks token issuance before GitHub HTTP

Architecture tests:

- domain/application do not import GitHub SDK, Nest, Prisma, platform adapters
- token broker use case not exposed by public controller
- desktop APIs cannot return token-shaped fields

Integration tests with DB when env exists:

- connection/target lookup consistency
- suspended connection denies
- target disabled after creation denies

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

Optional live smoke with GitHub sandbox:

```text
CONTROL_PLANE_GITHUB_LIVE_SMOKE=1 pnpm --dir control-plane test:github-live
```

Only add this after a sandbox GitHub App/install exists.

## Acceptance Criteria

- server can mint a GitHub installation token for an enabled target
- token is narrowed to repository id and minimum permissions
- token is never exposed over public/desktop API
- disabled/stale/revoked/deleted targets deny token issuance
- policy deny prevents token mint
- readiness catches missing hosted GitHub App credentials
- verification commands pass

## Rollout Plan

1. Add config/readiness for GitHub App private key and app id.
2. Add `github-token-broker` package scaffold.
3. Add capability-to-permission map.
4. Add target/policy lookup ports.
5. Add JWT signer and token issuer adapters.
6. Add readiness/dry-run desktop APIs.
7. Add tests and architecture rules.
8. Run verification.

## Open Questions

- Should token broker use no cache in V1, or exact-scope in-memory cache?
- V1 answer: no cache. Keep an exact-scope in-memory cache seam only if needed
  after Phase 8 load tests.
- Should Phase 7 include sandbox live smoke now or wait until Phase 8?
- Should private key parsing live in `platform-crypto` or GitHub broker
  infrastructure?
- How should self-hosted BYO app config be separated from hosted official app
  config names?

## What Comes Next

Phase 8 should use the broker only through an internal server-side port. It
should never accept or return provider tokens, and it should re-check target
policy immediately before dispatching each GitHub write action.
