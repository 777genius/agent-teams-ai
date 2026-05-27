# Phase 11 - Live E2E Release Gate Plan

## Purpose

Phase 11 proves that the complete GitHub App integration works end to end
before public rollout.

The target is not more architecture. The target is evidence:

```text
fresh desktop
  -> hosted control-plane
  -> official or staging GitHub App
  -> sandbox GitHub organization
  -> visible agent-attributed GitHub output
  -> auditable success and recovery path
```

This phase is the release gate for telling users that the GitHub integration is
ready.

## Summary

Build and run a repeatable live E2E suite plus release checklist covering:

- install/setup/claim
- desktop pairing and reconnect
- repository target enablement
- issue comment
- PR conversation comment
- PR review/check run if enabled
- retry and idempotency
- revocation and disabled target failures
- worker crash recovery
- secret/config failure safety
- privacy/security evidence
- runbook execution

Only flows required to safely release GitHub App V1 belong here.

## Architecture Decision

Recommended direction:

```text
staging live E2E harness
+ sandbox GitHub organization
+ real hosted control-plane
+ real GitHub App credentials
+ mocked destructive edges only where GitHub cannot safely simulate them
```

Options:

- Real staging E2E with sandbox GitHub org
  `🎯 10   🛡️ 9   🧠 7`
  Approx changes: `1200-2500` lines.
  Recommended. This is the only reliable proof of GitHub App behavior, setup
  callbacks, permissions, and rate-limit handling.

- Mock-only integration suite
  `🎯 4   🛡️ 5   🧠 4`
  Approx changes: `700-1600` lines.
  Useful but not enough. It cannot prove GitHub App registration, permissions,
  callbacks, or real provider semantics.

- Manual checklist only
  `🎯 3   🛡️ 4   🧠 2`
  Approx changes: `200-500` lines.
  Too fragile. It will drift and miss retry/idempotency regressions.

## Critical Scope

Phase 11 should implement:

- live E2E test plan and harness
- sandbox GitHub organization/repository fixtures
- staging environment prerequisites
- repeatable desktop pairing/setup script or guided checklist
- real GitHub action assertions
- audit/outbox verification
- failure injection where safe
- privacy/security verification script/checklist
- release readiness checklist
- incident recovery drills

Phase 11 should not implement:

- new GitHub action types
- messenger connectors
- billing/entitlements
- generic load testing platform
- marketplace launch copy
- broad analytics
- enterprise self-hosting

## Plan-Improve Findings

Scope preserved:

- Phase 11 remains a release gate and evidence phase.
- It should not add product behavior beyond test harnesses, fixtures, runbooks,
  and release gating.
- It proves the path already built by Phases 5-10.

Weak spots studied in current code:

- The backend already uses request ids and idempotency for GitHub actions.
  Live E2E must intentionally retry the same `requestId` and prove no duplicate
  public GitHub output appears.
- The public setup callback can return `restart_required` for untrusted
  callbacks. E2E must cover this as a safe failure, not treat every callback as
  success.
- Action status is queried through `GET api/desktop/v1/github-actions/:id`.
  E2E must assert status through backend as well as GitHub UI/API.
- Target policy is enforced before enqueue and before dispatch. Live tests must
  disable/revoke a target between enqueue and dispatch to prove the second gate.
- Worker/outbox behavior is central. A release gate that only verifies API
  responses is insufficient.
- The live harness can cause public GitHub writes. It must have sandbox
  allowlists, unique run ids, and cleanup rules before the first mutation.
- Manual verification is still needed for browser/OAuth UX, but it cannot be the
  only release evidence.
- Provider reads may be eventually consistent for a short period after writes.
  E2E should retry reads with bounded polling, but never hide duplicate writes
  behind retries.
- The most likely real-world target confusion is same-name repositories across
  forks, renamed repositories, transferred repositories, and multiple
  installations. E2E must prove target identity with immutable ids where
  possible.
- Current backend dispatch does not implement marker lookup recovery for
  unknown comment/review write outcomes. The release gate must not claim
  duplicate-safe retry unless marker recovery is implemented and proven.
- Backend policy subjects require normalized prefixes such as `agent:` and
  `team:`. E2E must prove the desktop bridge maps runtime identities into these
  subjects instead of sending raw local ids.
- Backend renders attribution, avatar fallback, footer, and hidden marker after
  raw payload validation. E2E must prove near-limit content and reserved marker
  input fail safely instead of producing ambiguous public markers.
- Token broker requests installation tokens narrowed to the selected repository
  id and minimum capability permissions. E2E must prove broader returned scope
  and stale target authorization fail closed.

## E2E Environment

Required accounts/resources:

- staging control-plane deployment
- staging GitHub App
- sandbox GitHub organization
- sandbox repository with issues enabled
- sandbox repository with pull requests enabled
- test GitHub user authorized to install/claim the app
- test desktop workspace
- staging Postgres
- staging secret store
- log/metric access for operator

Repository fixtures:

- issue for comment tests
- pull request for PR conversation comment tests
- branch for check run tests
- protected case for permission-denied tests if needed
- repository target disabled case
- optional same-name fork/rename fixture when staging organization policy allows
  it

Secrets:

- stored only in the hosted secret manager or local secure CI secret store
- never committed
- never printed by the harness
- redacted in failure artifacts

Run isolation:

- every live run uses a unique run id prefix
- every GitHub comment/check marker includes the run id through existing
  backend idempotency/marker behavior where safe
- cleanup touches only resources with the current run id or a known sandbox
  fixture allowlist
- parallel runs either use separate sandbox repositories or acquire a run lock
- failed cleanup must leave a visible artifact summary, not silently delete
  evidence
- cleanup never runs against repositories outside the explicit sandbox allowlist
- every mutation writes a local manifest entry before calling GitHub or
  control-plane
- sandbox fixtures are namespaced by environment so staging and production beta
  tests cannot share the same mutable issue/PR unless explicitly locked

Manifest shape:

```json
{
  "runId": "github-app-e2e-...",
  "environment": "staging",
  "controlPlaneBaseUrl": "https://...",
  "githubOwner": "sandbox-org",
  "githubRepo": "sandbox-repo",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "steps": []
}
```

The manifest example is illustrative. Real artifacts must redact or omit
secrets and raw action bodies.

Dry-run checks before mutation:

- control-plane base URL is staging or approved beta URL
- GitHub owner/repo match sandbox allowlist
- GitHub App slug/id match expected environment
- desktop contract version is supported
- API and worker build revisions match expected release
- actions gate and outbox worker are in expected state
- cleanup permissions are available
- artifact output directory is writable

## Golden Path Scenarios

### Setup And Pairing

Flow:

1. start with fresh desktop state
2. pair desktop with hosted control-plane
3. start GitHub setup session
4. install staging GitHub App into sandbox org
5. complete claim flow
6. return to desktop
7. verify connected state
8. verify repository availability snapshot
9. enable repository target

Assertions:

- setup status transitions are correct
- `installation_id` alone is never accepted as trusted
- untrusted setup callback returns restart-required or equivalent safe state
- desktop token is created and scoped
- repository targets use immutable GitHub repository ids
- token broker dry-run or mocked scope evidence shows one selected repository id
  and capability-specific permissions
- audit events exist
- no token or OAuth code appears in logs
- target list distinguishes connection id, target id, GitHub repository id, and
  display full name

### Agent Issue Comment

Flow:

1. submit trusted action envelope for sandbox issue
2. wait for outbox dispatch
3. fetch GitHub issue comments
4. find hidden marker
5. verify visible agent/team attribution
6. verify avatar fallback or allowed avatar rendering
7. verify action status is succeeded

Assertions:

- GitHub actor is the App bot
- body shows agent name and team name
- hidden marker does not leak internal ids or raw prompts
- result metadata stores content hash/external ids, not raw body
- encrypted content is deleted or crypto-shredded after success
- backend action status reaches terminal success
- audit record links action id, target id, and safe correlation id
- backend audit/policy evidence uses normalized `agent:` or `team:` subject ids
  for agent/team requests
- rendered GitHub body contains exactly one system-owned marker for the action
- comment body is not asserted by raw full-body snapshot; assertions target
  marker, attribution, and safe expected snippets to avoid leaking content into
  artifacts

### Agent PR Conversation Comment

Flow:

1. submit trusted PR conversation comment action
2. wait for worker dispatch
3. fetch PR issue comments
4. verify marker and attribution
5. retry same idempotency key
6. verify no duplicate comment

Assertions:

- PR belongs to bound base repository
- issue comment action does not cross repository boundary
- duplicate idempotency key returns existing status
- unknown outcome either uses implemented marker recovery or remains
  terminal/ambiguous without a second write
- retry after pre-write IPC/network failure reuses the same request id
- second GitHub API read sees one matching marker, not two
- backend audit/status and GitHub-visible comment agree on terminal outcome
- cleanup can identify the comment from marker/run id without raw body matching

Provider mutation ambiguity scenario:

1. force a mocked post-write crash after GitHub accepts a comment/review action
2. resume outbox processing for the same action
3. verify the system either binds to the existing marker through implemented
   recovery or dead-letters/blocks retry safely
4. verify no second public marker appears

This scenario is required because a backend idempotency key alone does not prove
external idempotency after GitHub has accepted a write.

### PR Review And Check Run

Run only if enabled by backend flags.

Assertions:

- PR review uses explicit `COMMENT` semantics
- no approve/request-changes action is available unless separately accepted
- check run has stable low-cardinality name
- check run stores GitHub `check_run_id` for updates
- `external_id` is correlation metadata, not a uniqueness guarantee

## Failure And Recovery Scenarios

Critical failures:

- desktop token revoked before setup status poll
- setup session expired before callback
- GitHub App installation removed after target enabled
- repository target disabled before action dispatch
- worker crashes after claiming event
- GitHub returns retry-after/secondary rate-limit response
- GitHub returns permission denied
- DB update fails after GitHub success
- hidden marker is manually deleted
- encrypted content decryption fails
- webhook signature invalid if webhooks are enabled
- duplicate setup callback delivery
- duplicate OAuth callback delivery
- stale setup session resumed by desktop after a successful connection already
  exists
- GitHub API returns success but response body parsing fails in adapter
- GitHub comment exists but marker is malformed or from another run
- cleanup fails after public comment creation
- provider read-after-write initially misses the created comment
- E2E process crashes after external mutation but before manifest finalization
- stale run lock blocks a new run
- repository display name changes after target enablement
- same-name repository exists in another installation or fork
- local project binding points at a different repository than selected target
- comment/review unknown outcome is retried without marker recovery
- check-run create is retried after ambiguous success without stored
  `githubCheckRunId` or `external_id` recovery
- desktop submits raw runtime agent/team id where backend expects normalized
  policy subject id
- raw body fits payload cap but rendered body exceeds attribution/footer cap
- user or agent body includes reserved `agent-teams-action` marker text
- GitHub token response includes broader repository ids or broader permissions
  than requested
- repository availability becomes stale between target enablement and token
  issuance

Expected behavior:

- failures map to safe error codes
- policy failures do not retry forever
- retry-after controls next attempt time
- worker crash recovers stale processing events
- duplicate public comments are avoided
- decryption failure fails closed
- dead-letter is auditable and bounded by retention policy
- target policy is rechecked during worker dispatch
- action content remains encrypted until dispatch and is shredded/deleted after
  success
- dead-letter does not expose raw body in operator output
- duplicate callbacks are idempotent or rejected safely
- malformed marker never causes update/delete of unrelated GitHub content
- cleanup failure is reported as cleanup-failed, not test success
- bounded read retries eventually prove the write or report inconclusive with
  safe ids
- crash recovery resumes from manifest and does not repeat non-idempotent writes
- stale run locks expire only after proving no active run owns them
- immutable repository id mismatch blocks action submission
- rename/fork confusion does not redirect action to a different target
- evidence artifact records target id and GitHub repository id, not display name
  only
- ambiguous provider write outcome never creates a duplicate public marker in
  the release gate
- if marker/check-run recovery is not implemented, the gate records a safe
  dead-letter/blocked state rather than green retry evidence
- raw local identity ids are rejected before content upload or converted to safe
  policy subject ids before submission
- rendered-body-too-large and reserved marker collision fail before public
  GitHub mutation and without logging raw content
- token scope mismatch, unsupported repository id, stale repository
  authorization, or suspended connection blocks dispatch before provider action
  mutation

Failure injection guardrails:

- simulate worker crash by stopping only the staging worker process owned by the
  test, not shared developer processes
- simulate rate limit with adapter/test fixture when real GitHub rate limiting
  would harm the sandbox account
- simulate DB update-after-GitHub-success only in controlled staging or mocked
  provider path
- manual marker deletion is allowed only on sandbox comments created by the run
- never run destructive installation removal against a non-sandbox account
- do not intentionally exhaust real GitHub rate limits
- prefer controlled adapter failures for rare provider edge cases
- keep destructive cleanup behind a confirmation or protected CI environment
  variable
- every failure injection states whether it uses real GitHub behavior, backend
  test adapter behavior, or manual sandbox mutation
- skip real-provider destructive scenarios in production beta validation unless
  the sandbox account is isolated

## Privacy And Security Gate

The release cannot pass unless evidence shows:

- no GitHub installation token in desktop process logs
- no GitHub installation token in renderer state
- no GitHub App private key in desktop artifacts
- no OAuth code or PKCE verifier in logs
- no raw action content in general logs
- no raw webhook payload persisted by default
- no repository code or diffs stored by default
- encrypted external action content retention works
- dead-letter content retention is bounded
- avatar URL policy blocks local file paths and unsafe schemes
- setup session ids are correlation ids, not authentication
- GitHub `installation_id` from callback is verified through claim flow

## Observability Gate

E2E run must capture:

- request id
- correlation id
- workspace id
- setup session id
- action id
- outbox event id
- GitHub external ids where safe
- safe error code/category for failures
- worker attempt count
- retry/dead-letter status

Required dashboards or query snippets:

- setup success/failure
- action request success/failure
- outbox lag
- dead-letter count
- token broker failures
- GitHub provider error classes
- encrypted content cleanup lag

Evidence artifact requirements:

- artifact contains safe ids and timestamps
- artifact contains GitHub URLs for sandbox outputs
- artifact contains backend terminal statuses
- artifact contains redaction scan result
- artifact does not contain desktop token, OAuth code, PKCE verifier, GitHub
  installation token, private key, raw webhook body, raw prompt, or raw action
  body
- artifact survives failed test runs for debugging
- artifact records which redaction rules ran
- artifact records whether cleanup completed, partially completed, or was
  skipped
- artifact stores hashes for action content only when needed, not the content
  itself

Redaction scan inputs:

- harness stdout/stderr
- generated manifest
- app/control-plane log excerpts collected for the run
- failure screenshots if any
- support bundles if generated

Forbidden artifact patterns:

- `agtcp_` desktop token prefix
- `Bearer `
- OAuth `code=`
- PKCE verifier/challenge values
- GitHub installation token-like values
- PEM private key headers
- raw action body outside an explicitly redacted placeholder

## Release Checklist

Before public beta:

- Phase 9 desktop bridge merged and verified
- Phase 10 hosted operations merged and verified
- staging deployment active
- staging GitHub App installed in sandbox org
- golden path E2E suite passes
- failure/recovery E2E suite passes or explicitly deferred with accepted risk
- security/privacy gate passes
- secret rotation drill completed at least once in staging
- operator runbooks reviewed
- rollback procedure documented
- public error messages reviewed
- support/debug artifact redaction verified
- no open critical or high severity release gate findings
- skipped scenarios have explicit accepted risk owner and expiry date
- staging GitHub App settings were reviewed after the final deploy
- E2E dry-run output was reviewed before mutation run
- stale sandbox resources from previous runs were either cleaned or accepted as
  harmless before release evidence was collected

## Harness Design

Recommended harness shape:

```text
control-plane/scripts/live-e2e/
  github-app-setup-smoke.mjs
  github-agent-action-smoke.mjs
  github-failure-recovery-smoke.mjs
  lib/
```

Rules:

- scripts fail closed on missing staging env
- scripts print safe ids, not secrets
- scripts clean up only sandbox-owned resources
- scripts do not delete user resources
- scripts are explicit about which GitHub org/repo they target
- scripts can run locally by maintainers and in protected CI
- scripts refuse to run when repository owner/name does not match configured
  sandbox allowlist
- scripts create a run manifest before first external mutation
- scripts write final status even when a scenario fails
- scripts have a dry-run mode for environment validation
- scripts use bounded polling with explicit timeout reasons
- scripts classify failures as setup, desktop, target-policy, outbox, provider,
  cleanup, or redaction
- scripts avoid test flakes by retrying reads, not mutating writes, unless the
  scenario is explicitly an idempotency test
- scripts persist manifest after every successful external mutation
- scripts support `resume --run-id` for crash recovery
- scripts distinguish cleanup failure from scenario failure
- scripts never use full GitHub comment body as the cleanup selector

## Execution Ordering

Recommended live gate order:

1. environment validation dry-run
2. desktop/control-plane contract version check
3. setup and pairing golden path
4. repository target enablement
5. issue comment golden path
6. PR conversation comment golden path
7. idempotent retry scenario
8. policy disabled-before-dispatch scenario
9. worker crash recovery scenario
10. privacy/redaction artifact scan
11. operator runbook spot checks

Ordering guards:

- do not run action scenarios until setup and target enablement are green
- do not run destructive failure scenarios before golden path evidence is saved
- do not mark release green if any failure scenario was skipped without an
  accepted risk note
- reruns must use a new run id unless the script is explicitly resuming a failed
  run
- destructive cleanup runs only after evidence artifact has been written
- cleanup must not delete comments/checks from previous runs unless an explicit
  stale-sandbox cleanup mode is used
- stale-sandbox cleanup mode must be separate from release evidence mode
- if dry-run fails, no external mutation is attempted

Timeout guidance:

- setup/OAuth waits need human/browser-aware timeout messages
- outbox dispatch polling should report last backend status and attempt count
- GitHub read-after-write checks should allow short provider consistency delay
- timeout does not imply cleanup success
- polling logs last safe status summary only, not payload or token-bearing URLs
- timeout budgets are documented per scenario so a slow provider does not look
  like a product regression without evidence

## Test Plan

Automated:

- live smoke script against staging
- mocked failure injection tests for retry/dead-letter
- redaction tests for generated artifacts
- contract tests for desktop/control-plane version compatibility
- architecture checks after harness additions
- run-id cleanup tests against mocked GitHub adapter
- sandbox allowlist tests
- manifest redaction tests
- retry/idempotency live assertion for one public comment marker
- provider mutation ambiguity test proves no duplicate marker after mocked
  post-write crash
- desktop identity mapping test proves raw agent/team ids never reach backend
  action DTOs as policy subjects
- near-limit rendered body test covers attribution/footer overhead
- reserved marker collision test proves agent-authored marker text is not used
  as cleanup/recovery evidence
- token broker scope mismatch test proves broader returned repository or
  permission scope fails closed
- stale repository authorization test proves dispatch blocks before GitHub write
- bounded polling timeout tests
- duplicate callback tests through mocked public callback route
- cleanup classification tests
- dry-run refuses non-sandbox repo test
- resume-from-manifest test after simulated crash
- forbidden artifact pattern scan test
- target identity confusion test using mocked same-name/renamed repository data

Manual:

- fresh install and setup through real browser
- desktop restart during pending setup
- revoke desktop client from hosted admin path
- remove GitHub App installation
- rotate staging webhook secret or private key
- inspect runbook steps from a clean operator shell
- delete a sandbox marker and verify duplicate policy behavior
- review evidence artifact before marking release gate green
- run browser setup with a second already-connected desktop open
- simulate app restart after setup start and before claim completion
- kill the E2E harness after comment creation and verify resume does not create
  a duplicate
- rename sandbox repository or use mocked rename fixture and verify target
  identity remains immutable-id based

## Acceptance Criteria

- fresh desktop can connect to hosted control-plane
- user can install and claim GitHub App into sandbox org
- repository target can be enabled and shown in desktop
- trusted agent action creates visible GitHub App comment with agent/team
  attribution
- duplicate/retry path does not create duplicate public comments
- disabled/revoked/expired states fail closed with safe errors
- worker crash recovery is proven
- critical secrets never appear in logs, desktop, renderer, or artifacts
- live E2E scripts and release checklist are documented
- public beta is blocked until this gate is green
- sandbox allowlist prevents accidental execution against real user repos
- E2E artifact proves both GitHub-visible output and backend audit/status
- one forced retry proves no duplicate public comment
- one worker recovery test proves outbox lease recovery
- bounded polling and cleanup behavior are tested
- duplicate callback behavior is proven safe
- release gate output classifies failures clearly enough for triage
- dry-run prevents accidental non-sandbox mutation
- crash/resume path does not duplicate public GitHub writes
- artifact redaction scan includes explicit forbidden-pattern checks
- target identity evidence includes target id and immutable GitHub repository id
- release evidence distinguishes duplicate-safe retry from safe dead-letter on
  unknown provider outcome
- release evidence includes one agent/team policy subject mapping assertion
- release evidence includes one rendered-body boundary assertion and one
  reserved marker collision assertion
- release evidence includes one token-scope narrowing assertion for repository
  id and permissions

## Rollout

Recommended rollout:

1. maintainers only
2. internal dogfood org
3. trusted external sandbox users
4. beta public GitHub App listing
5. wider release after support and incident data are stable

## Deferred After Release Gate

These are important but not critical for the GitHub App V1 release gate:

- messenger connector foundation
- billing and entitlements
- BYO GitHub App
- enterprise self-hosting
- multi-region active-active deployment
- broad product analytics
- additional GitHub write actions
