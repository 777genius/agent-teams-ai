# Phase 8 - Agent GitHub Actions Outbox Plan

## Purpose

Phase 8 is the first phase that performs GitHub write side effects. It lets
trusted Agent Teams actors request GitHub comments, pull request comments,
pull request reviews, and check runs through the hosted GitHub App.

The core pipeline:

```text
Trusted action request envelope
  -> target policy evaluation
  -> action command validation
  -> encrypted external action content
  -> outbox event
  -> worker dispatch
  -> GitHub token broker
  -> GitHub REST adapter
  -> audit/result status
```

Agent identity must be rendered visibly in GitHub output, but authorization must
come from trusted ids in the request envelope, not from agent-authored text.

## Summary

Phase 8 should create the production action path for GitHub App identity:

- users install the official GitHub App
- workspace enables repository targets
- policy permits a team/agent to request an action
- control plane posts through the GitHub App
- the GitHub-visible body clearly shows which agent/team authored the action

This phase must be conservative. It should start with a small set of action
types and strong idempotency/retry guarantees.

## Decision

Build an `agent-github-actions` feature backed by the existing outbox and
external action content primitives. Do not post to GitHub synchronously from the
HTTP/API request path.

```text
🎯 10   🛡️ 9   🧠 8
~2000-3500 implementation lines
```

Why:

- GitHub writes are external side effects and need retry/dead-letter behavior.
- Action bodies may contain user/model output and should use encrypted,
  short-retention storage.
- Idempotency has to survive process restarts.
- Worker dispatch keeps API latency and failure modes controlled.

Options:

- Outbox-backed GitHub action dispatcher  
  `🎯 10   🛡️ 9   🧠 8`  
  Approx changes: `2000-3500` lines.  
  Recommended. Fits Phase 4 foundations and keeps side effects reliable.

- Synchronous API posts to GitHub  
  `🎯 4   🛡️ 5   🧠 4`  
  Approx changes: `900-1600` lines.  
  Simpler but fragile. API request failures and GitHub retries become messy.

- Let local runtime call GitHub directly  
  `🎯 2   🛡️ 2   🧠 3`  
  Approx changes: `500-1000` lines.  
  Violates the central security model by exposing tokens or credentials locally.

## Scope

Phase 8 should implement:

- `agent-github-actions` bounded context
- trusted action request envelope validation
- action request APIs or internal desktop/runtime bridge endpoint
- GitHub action command model for V1 actions
- agent/team attribution renderer
- encrypted action content storage using existing external action content
- transactional outbox enqueue
- worker handler for GitHub action dispatch
- GitHub REST adapter for selected action types
- idempotency keys per action request
- action status/read model for desktop UI
- safe audit events for request, dispatch, success, failure, retry, dead-letter
- retry policy for retryable GitHub failures
- feature gate `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED`
- strict no-token-to-desktop/agents rule

Phase 8 must not implement:

- arbitrary GitHub API proxy
- branch writes, commits, labels, assignees, merge actions, or status updates
- line-level review comments unless explicitly included by an ADR
- storing repository code or raw diffs
- storing raw prompts or reusable model-output logs beyond encrypted dispatch
  payload with short retention
- unauthenticated public action endpoints
- accepting agent identity from comment body text
- exposing installation tokens

## Official GitHub Facts

These facts should be re-checked during implementation against official GitHub
docs:

- Issue comments can be created through the Issues comments API, and GitHub
  explicitly treats pull requests as issues for that endpoint.
- Creating an issue comment may trigger notifications and secondary rate
  limiting.
- Creating a pull request review supports `COMMENT`, `APPROVE`, and
  `REQUEST_CHANGES`; Phase 8 allows only `COMMENT`.
- Check runs can be created through the Checks API and include `external_id`,
  but update still requires the GitHub `check_run_id`.
- Managing checks requires `checks: write`; GitHub documents that OAuth apps and
  classic personal access tokens cannot use some checks endpoints.
- GitHub App permissions must match each endpoint.
- Pull requests are issues for some comment APIs, but review semantics are
  separate from issue comments.

References:

- https://docs.github.com/en/rest/issues/comments
- https://docs.github.com/en/rest/pulls/reviews
- https://docs.github.com/en/rest/checks/runs
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

## Plan-Improve Hardening Decisions

These decisions keep the first side-effect phase reliable without widening the
product surface:

- Implement action types incrementally inside Phase 8: issue/PR conversation
  comments first, PR reviews second, check runs last. Each action type stays
  behind the same feature gate and must pass its own idempotency tests before it
  is enabled.
- The request path stores the encrypted body and action row before enqueueing,
  but the worker renders the final GitHub body immediately before dispatch. That
  keeps attribution/marker generation deterministic and makes retries use the
  latest safe renderer.
- Comment/review retries after unknown GitHub outcome must either find a recent
  idempotency marker or dead-letter. Blind retry is forbidden for public
  comments.
- Check runs store `github_check_run_id` after create. `external_id` is used as
  correlation metadata, not as a unique lookup guarantee.
- Check run names are stable and low-cardinality. Do not put action ids into the
  check-run `name`; GitHub limits check runs with the same name in a suite and
  deletes older ones after the documented cap.
- Agent avatar is visible only as safe rendered metadata in the comment/review
  footer when `agentAvatarUrl` is HTTPS and allowlisted. The actual GitHub avatar
  remains the single official GitHub App avatar.
- V1 still renders an avatar line for every action. If the specific agent avatar
  is missing or unsafe, the renderer uses a configured public default Agent Teams
  avatar instead of omitting attribution.
- The authenticated desktop client is the V1 assertion boundary for agent/team
  ids. Agent subprocesses must not call the action API directly.
- Phase 8 requires a small outbox retry contract extension for provider
  `Retry-After`/rate-limit backoff. Fixed generic retry delays alone are not
  sufficient for GitHub write actions.
- `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=false` stops new requests and worker
  dispatches. Existing queued events remain pending/retryable until the gate is
  re-enabled or explicitly cancelled by an admin tool in a later phase.

## Action Types

Recommended V1 action types:

```text
github.issue_comment.create
github.pull_request_comment.create_top_level
github.pull_request_review.create
github.check_run.create_or_update
```

Clarification:

- `github.issue_comment.create` may comment on issues or PR conversation using
  the issue comments endpoint.
- `github.pull_request_comment.create_top_level` should initially be a PR
  conversation-level comment, not a line-level diff comment.
- line-level review comments require file path, commit SHA, side, and position
  semantics; defer unless a separate ADR accepts that complexity.
- check runs need a stable external id/name strategy.

Deferred action types:

- line-level PR review comment
- commit status
- branch write/commit push
- labels/assignees/milestones
- review dismissal
- merge actions

## Bounded Contexts

### `agent-github-actions`

Owns GitHub action request lifecycle.

Entities:

- `GitHubActionRequest`
- `GitHubActionAttempt`
- `GitHubActionResult`
- `AgentAttribution`
- `GitHubActionCommand`

Responsibilities:

- validate trusted request envelope
- check target policy
- store encrypted action content
- enqueue outbox event
- dispatch action in worker
- render GitHub-visible agent identity
- record status and audit

Does not:

- mint tokens directly, except through Phase 7 broker port
- own repository target policy
- own GitHub installation setup
- trust agent-authored text for identity

### Existing Contexts Used

- `integration-targets`: target and policy authorization
- `github-token-broker`: scoped server-only token lease
- `external-action-content`: encrypted short-retention payload storage
- `outbox`: transactional side-effect queue
- `audit`: safe action lifecycle events

## Package Shape

```text
control-plane/
  packages/features/
    agent-github-actions/
      src/domain/
      src/application/
        ports/
        use-cases/
      src/infrastructure/github/
      src/infrastructure/prisma/
      src/infrastructure/outbox/
      src/interface/nest/
```

Suggested ports:

```text
TargetPolicyEvaluator
GitHubInstallationTokenBroker
GitHubActionContentStore
GitHubActionOutbox
GitHubActionRepository
GitHubActionDispatcher
GitHubActionAuditLog
Clock
```

## Trusted Action Request Envelope

The request envelope is the authority source for actor identity.

Suggested fields:

```text
requestId
workspaceId
targetId
actionType
requestedBy:
  subjectKind
  subjectId
  teamId?
  agentId?
  desktopClientId?
attribution:
  agentDisplayName
  agentAvatarUrl?
  teamDisplayName?
payloadRef or payload
createdAt
```

Rules:

- `agentDisplayName` is display-only
- authorization uses `subjectKind/subjectId/targetId/actionType`
- V1 trusts `subjectKind/subjectId/teamId/agentId` only because they are
  asserted by an authenticated desktop client/runtime boundary
- store `assertedByDesktopClientId` on the action request/audit trail
- reject requests that come directly from unauthenticated agents, provider
  webhooks, or public internet callbacks
- request id is idempotency key
- payload is validated by action type
- desktop/runtime must authenticate before submitting
- Phase 8 should accept only trusted internal/desktop-runtime paths, not public
  internet callbacks

## Agent Attribution Rendering

GitHub-visible output must make the virtual team effect obvious.

Recommended V1 rendering:

```text
<agent-authored content>

---
Agent Teams
Avatar: <safe agent/default avatar markdown image>
Agent: <agent name>
Team: <team name if available>
Workspace action: <safe action id>
```

Rules:

- user/agent content comes first for readability
- attribution footer is deterministic and non-optional
- action id is safe and does not reveal secrets
- do not include raw workspace token, GitHub token, prompt id, or local file path
- avatar cannot replace the GitHub App actor avatar on normal comments
- if avatar URL is shown in a body, it must be HTTPS, allowlisted, size-bounded
  in rendered markdown, and never a local file path
- if the agent avatar URL is absent or unsafe, use a configured public default
  Agent Teams avatar URL
- the renderer must not fetch/proxy the avatar during dispatch; it only validates
  and renders a safe URL

Options:

- Deterministic footer in every body  
  `🎯 9   🛡️ 9   🧠 3`  
  Approx changes: `100-250` lines.  
  Recommended V1. Works across issue comments, PR comments, and reviews.

- HTML details block with richer metadata  
  `🎯 7   🛡️ 8   🧠 4`  
  Approx changes: `180-350` lines.  
  More polished but can be noisy and harder to test across GitHub renderers.

- Separate bot profile/avatar per agent  
  `🎯 3   🛡️ 4   🧠 9`  
  Approx changes: `large/unknown`.  
  Not compatible with one GitHub App identity in V1.

## Data Model

Suggested tables:

```text
github_action_requests
  id uuid pk
  workspace_id uuid not null
  integration_target_id uuid not null
  action_type text not null
  requested_by_subject_kind text not null
  requested_by_subject_id text not null
  asserted_by_desktop_client_id uuid not null
  agent_id text null
  agent_display_name text not null
  team_id text null
  team_display_name text null
  idempotency_key text not null
  status text not null
  external_content_ref_id uuid not null
  external_content_integrity_hash text not null
  github_delivery_id text null
  github_check_run_id text null
  github_url text null
  content_shredded_at timestamptz null
  safe_error_json jsonb null
  created_at timestamptz not null
  updated_at timestamptz not null

github_action_attempts
  id uuid pk
  github_action_request_id uuid not null
  attempt_number integer not null
  status text not null
  started_at timestamptz not null
  finished_at timestamptz null
  safe_error_json jsonb null
  github_status_code integer null
  github_request_id text null
```

Indexes:

- unique `(workspace_id, idempotency_key)`
- index `(workspace_id, status, created_at)`
- index `(integration_target_id, status)`
- index `(workspace_id, action_type, github_check_run_id)` where
  `github_check_run_id is not null`
- unique attempt number per request

Do not store:

- installation token
- raw GitHub response body
- repository code/diff
- raw prompt

## Action Payloads

### `github.issue_comment.create`

Payload:

- `issueNumber`
- `body`

Validation:

- body non-empty
- body max length bounded below GitHub API max to leave attribution/footer room
- final rendered body includes hidden idempotency marker
- issue number positive integer

Capability:

- `github.issue_comment.request`

### `github.pull_request_comment.create_top_level`

Payload:

- `pullRequestNumber`
- `body`

Implementation:

- use issue comments endpoint for PR conversation-level comment in V1 because
  GitHub treats pull requests as issues for that API
- verify the target number is a pull request if product needs strict PR-only UI
  semantics; otherwise rely on GitHub 404/422 and safe error mapping

Capability:

- `github.pr_comment.request`

### `github.pull_request_review.create`

Payload:

- `pullRequestNumber`
- `body`
- `event`: `COMMENT` only in V1 unless approved otherwise

Validation:

- no approve/request-changes in V1 unless policy explicitly allows it
- no line-level comments in V1 unless ADR exists
- `event` must be exactly `COMMENT` in V1
- `body` is required and includes attribution/footer

Capability:

- `github.pr_review.request`

### `github.check_run.create_or_update`

Payload:

- `name`
- `headSha`
- `status`
- `conclusion?`
- `title?`
- `summary?`
- `text?`

Validation:

- check name deterministic and workspace/agent scoped
- `headSha` validated as SHA-like string
- status/conclusion enums restricted
- include `external_id=<actionRequestId>` on create for correlation
- update path uses stored `github_check_run_id`; do not assume `external_id` is
  unique or directly searchable

Capability:

- `github.check_run.request`

## Use Cases

### `RequestGitHubActionUseCase`

Input:

- trusted action request envelope
- action payload
- optional idempotency key

Output:

- action request id
- status: `queued` or existing terminal status

Rules:

- feature gate must be enabled
- validate envelope
- validate action payload
- evaluate target policy
- render attribution preview for validation, but store canonical attribution
  metadata so worker can render final body before dispatch
- store encrypted external action content
- create action request row
- enqueue outbox event in same transaction
- idempotent by workspace/idempotency key
- no GitHub HTTP in request transaction
- content expiry must be later than the maximum expected retry window; if the
  existing retention config is missing while actions are enabled, fail readiness

### `DispatchGitHubActionUseCase`

Input:

- outbox event
- action request id

Output:

- dispatch result

Rules:

- feature gate must be enabled before claiming new dispatch work
- load action request and encrypted content
- skip if already succeeded
- re-check target status and policy before dispatch
- ask Phase 7 broker for scoped token
- render final body with attribution and idempotency marker
- call GitHub action adapter
- persist GitHub delivery metadata
- mark action succeeded or retryable failed
- shred external action content after terminal success or permanent dead-letter
  because Phase 8 has no replay-from-body feature
- record attempt
- do not log body/token

### `GetGitHubActionStatusUseCase`

Input:

- authenticated desktop actor
- action request id

Output:

- safe status
- action type
- target id
- GitHub URL if available
- safe failure code
- attempt count

Rules:

- workspace ownership check
- no raw payload body unless product explicitly wants it and it is safe
- no token/provider raw response

## Outbox Contract

Outbox event:

```text
eventType: github.action.dispatch
aggregateKind: github_action_request
aggregateId: <actionRequestId>
idempotencyKey: workspaceId + actionRequestId
payload: safe pointer only
```

Rules:

- payload contains ids only
- content body stored in encrypted external action content
- outbox `contentRefId` and `contentIntegrityHash` must both be set when action
  body is externalized
- event creation and action request creation are one DB transaction
- worker handler is idempotent
- retryable GitHub failures requeue through outbox policy
- permanent failures move to failed/dead-letter with safe error

Required outbox retry extension:

```text
OutboxHandlerResult.retry(error, retryAfterMs?)
```

Scope of this required foundation edit:

- update the outbox application handler result type
- update `ProcessOutboxBatchUseCase` to pass the optional provider backoff to
  the repository
- update the Prisma outbox repository so explicit `retryAfterMs` schedules
  `next_attempt_at` directly, while preserving existing generic delays when it is
  absent
- keep `SafeError` unchanged; scheduling metadata is operational, not part of
  the public safe error contract

Options:

- Add explicit `retryAfterMs` to handler retry result  
  `🎯 9   🛡️ 9   🧠 5`  
  Approx changes: `150-300` lines.  
  Recommended. Keeps provider backoff separate from public `SafeError` format
  and lets GitHub `Retry-After` override generic retry delays.

- Encode retry delay in `SafeError.safeDetails` and teach outbox to inspect it  
  `🎯 6   🛡️ 7   🧠 4`  
  Approx changes: `100-220` lines.  
  Works, but mixes operational scheduling with the safe public error contract.

- Ignore provider retry-after and use fixed outbox delays  
  `🎯 3   🛡️ 4   🧠 1`  
  Approx changes: `0` lines.  
  Not acceptable for GitHub write actions because secondary rate limiting can
  require waiting longer than the generic schedule.

## GitHub Adapter

Suggested adapter:

```text
GitHubRestActionDispatcher
```

Responsibilities:

- receive server-only token lease
- call exact REST endpoint for action type
- include pinned API version
- parse safe delivery metadata
- normalize errors into `SafeError`
- return GitHub URL/id if successful

Endpoint mapping:

```text
github.issue_comment.create:
  POST /repos/{owner}/{repo}/issues/{issue_number}/comments

github.pull_request_comment.create_top_level:
  POST /repos/{owner}/{repo}/issues/{issue_number}/comments

github.pull_request_review.create:
  POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews

github.check_run.create_or_update:
  POST /repos/{owner}/{repo}/check-runs
  PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}
```

For check runs, create/update idempotency needs a stable lookup strategy:

- store GitHub check run id after first create
- include `external_id` for correlation, but do not rely on it as a uniqueness
  constraint
- check-run `name` should be deterministic and bounded, for example
  `Agent Teams / <workspace-safe-name> / <action-kind>`, not per-action unique
- for retry after unknown create result, try bounded lookup only if the adapter
  has a tested safe lookup; otherwise dead-letter rather than creating duplicate
  public check runs

## Idempotency

Required behavior:

- duplicate `requestId` returns existing action request
- duplicate outbox delivery does not post duplicate GitHub comment if previous
  success is known
- if GitHub request result is unknown after timeout, retry strategy must be
  explicit per action type
- check runs should be more idempotent than comments by storing check run id
- comments need body fingerprint/client id marker to avoid duplicates after
  unknown result

Recommended comment idempotency marker:

```text
<!-- agent-teams-action:<actionRequestId> -->
```

Rules:

- marker is appended by renderer
- status APIs may hide marker from user
- before retry after unknown result, adapter can search recent comments for marker
  with a strict page/comment cap if permissions/API budget allow
- if search is not implemented, unknown result should dead-letter instead of
  risking duplicate public comments

## Retry Policy

Retryable:

- GitHub 429
- GitHub secondary rate limiting when response indicates retry-after/backoff
- GitHub 5xx
- network timeout before request body accepted if safe
- token broker retryable external error

Non-retryable:

- target disabled/stale/revoked
- policy deny
- GitHub 401/403 due permission mismatch
- GitHub 404 repository/issue/PR not found
- GitHub 410 issues disabled or target gone
- validation failure
- body too large

Unknown:

- timeout after GitHub may have accepted the request
- connection reset after request body was sent and before response was parsed

Unknown policy:

- comments/reviews: prefer marker lookup before retry; otherwise dead-letter
- check runs: retry through stored or discoverable check run id

Backoff rules:

- if GitHub sends `Retry-After`, schedule the next outbox attempt no earlier
  than that delay
- if primary rate limit headers indicate zero remaining requests, schedule after
  the reset timestamp
- if secondary limit is detected without `Retry-After`, wait at least one minute
  and then exponentially increase subsequent delays
- never spin retry public comment creation in a tight loop

## Security And Privacy

- No installation tokens outside server process.
- No raw prompts or reusable model-output logs in DB.
- Action body is encrypted external action content with short retention.
- External action content is shredded after terminal success/dead-letter unless
  a future replay feature explicitly changes that contract.
- Logs contain action id, target id, safe error code, not body/token.
- Attribution is mandatory.
- Agent avatar rendering is mandatory and safety-gated; unsafe agent URLs fall
  back to the configured default avatar and are not proxied blindly.
- Authorization uses trusted ids, not comment text.
- Target policy is re-checked at dispatch time.
- Action requests to stale/disabled targets fail closed.

## Observability

Metrics:

- action requests by type/status
- policy denies by capability
- dispatch latency
- GitHub error rates by safe code
- outbox retries/dead letters
- duplicate/idempotent request hits
- unknown-result dead letters

Logs:

- correlation id
- action request id
- target id
- action type
- safe error code
- GitHub request id if safe

Never log:

- body
- token
- raw provider response
- private repository data
- raw prompt

## API Shape

Potential internal/desktop-runtime API:

```text
POST /api/desktop/v1/github-actions
GET  /api/desktop/v1/github-actions/:actionRequestId
GET  /api/desktop/v1/github-actions?targetId=...
```

Request body should carry trusted envelope fields from desktop/runtime. If the
desktop cannot yet produce trusted agent/team ids, Phase 8 should stop and add a
small "runtime action envelope" plan before implementation.

No public unauthenticated action API.

## Config And Readiness

New config keys:

- `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED`
- `CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL`
- `CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS`

Rules:

- GitHub actions readiness fails if the action gate is enabled while Phase 6
  targets, Phase 7 token broker, outbox worker, persistence, or external content
  encryption are disabled
- default avatar URL is required when GitHub actions are enabled because avatar
  attribution is mandatory in V1
- avatar allowed origins are exact `https://host[:port]` origins, not wildcard
  suffix matches
- encrypted external content retention must be configured and long enough for
  the maximum retry window

## Tests

Unit tests:

- action payload validation per action type
- attribution renderer always appends footer/marker
- avatar renderer accepts only safe HTTPS allowlisted URLs for agent-specific
  avatars
- avatar renderer uses configured default avatar when the agent URL is unsafe or
  missing
- policy deny prevents outbox enqueue
- target disabled prevents outbox enqueue
- feature gate disabled prevents request enqueue and worker dispatch
- unauthenticated or directly agent-originated envelope is rejected
- action audit records `assertedByDesktopClientId`
- request id idempotency returns existing request
- encrypted content store called, raw body not placed in outbox payload
- outbox event includes content ref and integrity hash together
- dispatch re-checks policy
- token broker called with exact capability/target
- GitHub adapter maps success metadata
- retryable errors remain retryable
- non-retryable errors fail action
- unknown comment result dead-letters or marker-searches according to chosen
  strategy
- check run retry uses stored `github_check_run_id` or dead-letters unknown
  create result
- provider `Retry-After` overrides generic outbox retry delay
- outbox retry extension preserves existing generic retry behavior when
  `retryAfterMs` is absent
- check run name does not include unique action id
- GitHub 410 maps to non-retryable safe failure
- terminal success/dead-letter shreds external action content

Architecture tests:

- domain/application do not import Nest, Prisma, GitHub SDK, platform adapters
- GitHub REST calls live only in infrastructure/github
- outbox payload types contain ids only, not body

Integration tests with DB when env exists:

- request and outbox enqueue atomicity
- duplicate request id
- outbox retry idempotency
- action status read model
- encrypted external content retention metadata
- shredded terminal action content cannot be loaded again

Optional live GitHub sandbox tests:

- issue comment create in test repo
- PR conversation comment create
- PR review COMMENT create
- check run create/update

Live tests must use a sandbox GitHub App installation and must be disabled by
default.

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

- action requests enqueue outbox events atomically
- worker dispatch posts through GitHub App using Phase 7 token broker
- target policy is checked before enqueue and before dispatch
- action bodies include mandatory agent/team attribution
- installation token never leaves server process
- raw body is not stored in outbox payload
- duplicate request id does not duplicate public GitHub output
- retry/dead-letter behavior is explicit and tested
- verification commands pass

## Rollout Plan

1. Add `agent-github-actions` package scaffold.
2. Define action command model and trusted envelope.
3. Implement attribution renderer.
4. Implement request use case with policy check, encrypted content, outbox.
5. Implement worker handler and GitHub dispatch adapter.
6. Add action status read API.
7. Add retry/idempotency/dead-letter tests.
8. Run verification.
9. Optionally run sandbox GitHub live smoke.

## Open Questions

- Can the desktop/runtime already produce trusted stable `teamId` and `agentId`?
  V1 answer: yes only through the authenticated desktop/runtime boundary; direct
  agent-originated calls are rejected.
- Should Phase 8 include check runs in V1 or defer them after comments/reviews?
  V1 answer: include only after comment/review action tests pass, behind the
  same feature gate.
- Should PR top-level comments use issue comments endpoint only, or should the
  product distinguish issue comments vs PR reviews more strongly? V1 answer:
  use issue comments endpoint for PR conversation-level comments.
- What retention should encrypted action content use after successful dispatch?
  V1 answer: shred after terminal success/dead-letter; retention is only the
  maximum in-flight retry window.
- Should unknown-result comment retries search for marker before retry, or
  dead-letter immediately to avoid duplicates? V1 answer: marker search only if
  bounded and tested; otherwise dead-letter.

## What Comes Next

After Phase 8, the system can visibly show a team of virtual agents working in
GitHub through the official App. The next likely phases are:

- webhook ingestion for GitHub events
- action result feedback to desktop/runtime
- line-level PR review comments
- messenger connector parity
- billing/entitlement gates
