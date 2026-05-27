# Phase 10 - Hosted GitHub App Operations Plan

## Purpose

Phase 10 makes the official hosted GitHub App path deployable and operable for
real users.

The earlier phases build the code path. This phase makes it safe to run:

```text
official GitHub App
  -> hosted control-plane API
  -> worker/outbox
  -> Postgres
  -> observability and runbooks
```

Without this phase, GitHub integration can work in development but is not ready
for public installation.

## Summary

Implement the minimal hosted operations foundation:

- production configuration profile
- GitHub App registration checklist
- secret custody and rotation runbook
- database migration/deploy flow
- worker deployment and outbox health checks
- readiness/liveness probes
- structured logs and metrics for critical paths
- safe admin/operator runbooks
- backup and recovery expectations
- hosted environment smoke tests

This phase should not add product features beyond operational readiness.

## Architecture Decision

Recommended direction:

```text
single hosted control-plane deployment
+ separate api and worker processes
+ managed Postgres
+ managed secret store
+ no microservice split yet
```

Options:

- Modular monolith deployed as API plus worker
  `🎯 10   🛡️ 9   🧠 6`
  Approx changes: `1000-2200` lines.
  Recommended. Matches current architecture and keeps operations simple.

- Split GitHub integration into separate microservice now
  `🎯 5   🛡️ 7   🧠 9`
  Approx changes: `3000-6000` lines.
  Too early. Adds network contracts, deployment coupling, and more failure
  modes before load proves the need.

- Keep only local/dev deployment docs
  `🎯 3   🛡️ 4   🧠 3`
  Approx changes: `400-900` lines.
  Not enough. Users cannot safely install the official shared GitHub App without
  a reliable hosted backend.

## Critical Scope

Phase 10 should implement:

- production env schema review
- hosted GitHub App required settings doc
- secret inventory and ownership model
- secret rotation procedure
- deployment runbook for API and worker
- migration runbook with rollback expectations
- health/readiness endpoint hardening for hosted mode
- worker outbox lag and dead-letter visibility
- release artifact build checks
- hosted smoke script against a configured non-production deployment
- minimal dashboards/alerts spec
- safe operator commands for retry/cancel/dead-letter inspection if not already
  present

Phase 10 should not implement:

- billing
- multi-region active-active
- generic integration marketplace
- BYO GitHub App
- messenger connectors
- new queue service unless DB-backed outbox is proven insufficient
- Kubernetes-specific assumptions unless that is the chosen deployment target

## Plan-Improve Findings

Scope preserved:

- Phase 10 remains an operations hardening phase for the hosted GitHub App path.
- It should not add new GitHub action types, desktop UX, billing, or messenger
  connectors.
- It can add operational scripts/docs/checks only when they reduce deployment,
  secret, migration, or recovery risk.

Weak spots studied in current code:

- Hosted mode already has strict config gates for public URL, GitHub App
  metadata, OAuth secret, database URL, encryption key, persistence, outbox,
  integration targets, token broker, and GitHub actions.
- The code exposes feature flags for desktop bootstrap/pairing, GitHub setup,
  claim OAuth, integration targets, token broker, actions, and unclaimed
  callback recording. Operations docs must define valid hosted combinations.
- The API and worker are separate entrypoints in one workspace. Phase 10 should
  deploy them from the same release revision, not split services yet.
- Current route surface is desktop-token authenticated for app workflows and
  public only for GitHub setup/OAuth callbacks. Hosted CORS and public callback
  rules need explicit review.
- `verify:phase1` is a full local gate, but production readiness also needs DB
  migration, DB smoke, hosted config, and staging live smoke gates.
- Some backend feature combinations are intentionally invalid. Operations
  should document a startup matrix instead of letting deployers discover invalid
  combinations through runtime failures.
- API/worker revision skew is a real risk because the worker processes durable
  outbox event versions. Deployment must make this skew visible and reversible.
- Public setup/OAuth callback URLs are externally reachable by design. Hosted
  operations must treat callback abuse, replay, and noisy scanners as normal
  production traffic, not exceptional incidents.
- Repository owner/name can change while immutable GitHub repository ids remain
  stable. Operations and runbooks must avoid diagnosing target issues by display
  name alone.
- Current GitHub action dispatch has an explicit unknown-result path for
  comment/review writes when transport outcome is ambiguous. Operations must
  treat this as a duplicate-write risk, not as a normal retryable outage.
- Backend target policy rejects unprefixed subject ids. Hosted diagnostics must
  make `CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID` distinguishable from
  normal policy denial so desktop/runtime mapping bugs are visible.
- Backend raw payload validation and final rendered-body validation are separate
  gates. Operations must classify raw size failures, rendered attribution/footer
  failures, and reserved marker collisions separately.
- Token broker must request one-repository installation tokens and verify that
  GitHub did not return broader repository or permission scope. Scope mismatch
  is a security failure, not a retryable provider outage.

## Deployment Topology

V1 topology:

```text
load balancer / platform router
  -> control-plane api process

worker process
  -> same codebase, worker entrypoint

managed Postgres
  -> metadata, outbox, locks, encrypted action content

managed secret store
  -> GitHub App private key
  -> GitHub App webhook secret
  -> GitHub OAuth client secret
  -> envelope encryption root key or key reference
```

Operational rules:

- API and worker use the same release revision
- worker count can scale horizontally only if DB lock/outbox claim semantics are
  verified
- migrations run before new code starts processing new event versions
- old workers must not process new unsupported event versions
- hosted mode fails startup if required secrets are absent
- API can deploy without worker only for read/setup maintenance windows
- worker must not run with actions enabled if API has not applied the matching
  migrations
- worker scale-out requires proving DB-backed claims and locks in staging

## Hosted Startup Matrix

Document and test these valid hosted combinations:

```text
setup-only staging:
  desktopBootstrap=true
  desktopPairing=true
  githubSetup=true
  githubClaimOAuth=true
  integrationTargets=false
  githubTokenBroker=false
  githubActions=false
  outboxWorker=false

target-management staging:
  desktopBootstrap=true
  desktopPairing=true
  githubSetup=true
  githubClaimOAuth=true
  integrationTargets=true
  githubTokenBroker=false
  githubActions=false
  outboxWorker=false

actions staging or beta:
  desktopBootstrap=true
  desktopPairing=true
  githubSetup=true
  githubClaimOAuth=true
  integrationTargets=true
  githubTokenBroker=true
  githubActions=true
  persistence=true
  outboxWorker=true
```

Invalid combinations must fail fast:

- GitHub actions without persistence
- GitHub actions without outbox worker
- GitHub actions without token broker
- token broker without integration targets
- claim OAuth without GitHub setup
- hosted mode without HTTPS public base URL
- hosted mode without encryption master key
- GitHub actions without default avatar URL and allowed origins

Mode ownership:

- `local-disabled` remains the default for local desktop development
- `hosted-official-app` is the only V1 public shared GitHub App mode
- `self-hosted-byo-app` must stay disabled or clearly documented as unsupported
  until BYO key custody and registration docs exist
- examples must never include a fake-looking private key that users might copy
  into Electron or client config

## GitHub App Registration Checklist

Document and verify:

- App name and public description
- homepage URL
- setup URL
- callback URL
- webhook URL
- webhook secret
- private key custody
- requested repository permissions
- requested account permissions
- subscribed webhook events
- installation target account policy
- whether app is public or private during rollout
- organization ownership and recovery contacts

Required V1 permissions should remain minimal and map to implemented action
types only.

Permission mapping must document:

- issue comments
- pull request conversation comments
- pull request reviews if enabled
- check runs if enabled
- metadata/read permissions needed for repository validation

Forbidden in V1 unless accepted by a separate plan:

- contents write
- administration write
- secrets write
- actions write
- merge/write capabilities

Registration drift checks:

- documented callback/setup/webhook URLs match deployed public base URL
- documented permissions match enabled backend action types
- disabled action types do not require their write permissions
- staging and production GitHub Apps use different secrets and callback URLs
- app visibility/public listing state is recorded before each rollout stage
- organization ownership and emergency transfer contacts are current
- setup URL and OAuth callback URL are tested from outside the private network
- old callback URLs are removed or redirected only after pending setup sessions
  expire

## Secret Custody

Secret classes:

- GitHub App private key
- GitHub webhook secret
- GitHub OAuth client secret
- control-plane signing/encryption keys
- database URL
- session token signing keys
- hosted environment provider tokens

Rules:

- no secret in repository
- no secret in Electron
- no secret in Docker image layers
- no secret in build logs
- no full env dump in health or diagnostics
- no GitHub private key in local examples
- rotation procedure is tested before public beta

Rotation runbooks:

- GitHub App private key rotation
- webhook secret rotation
- OAuth client secret rotation
- desktop session signing key rotation
- envelope encryption key rotation/rewrap or crypto-shred policy
- database credential rotation

Secret rotation guardrails:

- rotate one secret class at a time in staging first
- never rotate encryption master key and deploy code rollback in the same
  maintenance window
- private key rotation verifies both token broker readiness and one live action
- webhook secret rotation keeps old/new validation overlap only if implemented
  and documented
- OAuth client secret rotation invalidates pending claim sessions unless a safe
  overlap strategy exists
- leaked desktop tokens are handled by revoking affected desktop clients, not by
  rotating GitHub App private key
- leaked GitHub App private key requires generating a new key, revoking old key,
  and proving token broker uses only the new key

## Hosted Configuration

Hosted startup must validate:

- public base URL
- GitHub App id
- GitHub App private key source
- webhook secret source
- OAuth client id and secret
- database URL
- encryption key configuration
- action feature flags
- allowed avatar URL policy
- CORS/origin policy for hosted callback pages
- log level
- build revision and creation timestamp

Validation output:

- safe missing-key error code
- no raw secret values
- operator-friendly key names
- fail fast in hosted mode
- allow disabled/local mode for normal desktop development
- safe summary shows whether values are configured, not the values themselves
- operator docs map every required env var to owner, source, rotation cadence,
  and blast radius

## Database And Migration Operations

Required docs/scripts:

- migration apply command
- migration status command
- rollback stance
- backup before destructive migration
- seed data policy
- test database policy
- operator access policy

Migration rules:

- additive migrations preferred
- deploy code that can read old and new schema when possible
- outbox event version changes must be backward compatible or gated
- destructive migration requires explicit release gate
- encrypted action content retention must survive deploy rollback safely

Deployment ordering:

1. build release artifact
2. run local `verify:phase1`
3. run DB migration in staging
4. start API with actions disabled
5. start worker with outbox worker disabled
6. run setup/target smoke
7. enable token broker
8. enable GitHub actions and outbox worker together
9. run live action smoke
10. promote the same revision to production

Revision skew controls:

- API and worker expose the same build revision in health/startup logs
- worker refuses or alerts on unknown event versions before burning retries
- deploy tooling records which revision applied migrations
- rollback notes include whether old code can read the current schema
- outbox dispatch can be paused independently before rollback
- `/health` and `/ready` expose build metadata consistently for API and worker
  logs without exposing env values
- deploy tooling refuses production promotion if staging API/worker revisions do
  not match

Rollback rules:

- disabling `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED` stops new action requests
- disabling `CONTROL_PLANE_OUTBOX_WORKER_ENABLED` pauses dispatch without
  deleting queued events
- rolling back code must not downgrade schema unless a tested rollback exists
- if a new outbox event version was introduced, keep old worker stopped until
  unsupported events are drained, cancelled, or dead-lettered by policy
- never rotate encryption keys as part of emergency app rollback
- if setup callbacks fail after rollback, stop public setup links before users
  enter OAuth
- if token broker fails after rollback, pause action dispatch before retries
  consume max attempts
- if public callback abuse spikes, rate-limit or temporarily disable setup
  starts before disabling already connected workspaces
- if desktop auth failures spike after deploy, prefer pausing mutating hosted
  integration calls over deleting local desktop sessions

## Worker Operations

Worker readiness should verify:

- database reachable
- outbox claim path can initialize
- lock adapter configured
- event handler registry loaded
- GitHub token broker config parseable
- hosted feature flags consistent

Worker metrics:

- pending outbox events by type
- processing outbox events by age
- retry count by type
- dead-letter count by type
- dispatch success/failure counts
- GitHub provider response class
- token broker request count
- rate-limit/backoff count
- encrypted content cleanup lag

Failure behavior:

- worker shutdown releases or times out claims safely
- unknown event versions go dead-letter
- provider retry-after updates next attempt time
- disabled feature flag pauses dispatch without losing queued events
- decryption failure fails closed
- private key parse failure fails readiness before dispatch
- GitHub token broker repeated failures trigger alert before outbox max attempts
  burn down
- dead-letter inspection never decrypts action body by default
- cleanup of completed encrypted content is observable and bounded
- provider 401/403 after token issuance marks installation/target for refresh
  or suspension by policy, not blind retry forever
- provider 404 for repository/PR/issue is classified separately from network
  failure
- unknown provider write outcome for comments/reviews goes to safe dead-letter
  or manual recovery until marker lookup recovery is implemented
- check-run create retry is allowed only after stored `githubCheckRunId` or
  `external_id` recovery proves the previous create can be updated
- rendered-body-too-large is treated as client/content validation, not provider
  outage, and must not enter retry loops
- reserved Agent Teams marker collision is a safety validation failure because
  cleanup and recovery depend on system-owned markers
- GitHub token scope mismatch fails closed, emits a safe security event, and
  does not expose the installation token to logs, operators, desktop, or worker
  diagnostics
- stale repository availability or suspended connection blocks token issuance
  until target refresh/connection recovery succeeds

## API Operations

API health/readiness:

- liveness stays shallow
- readiness checks critical dependencies only
- hosted mode readiness fails when DB or required config is missing
- health includes service name/version/build metadata only
- no secrets or full env values
- readiness for public callbacks must not depend on GitHub provider success for
  every installation
- readiness for actions must fail when DB/outbox/encryption prerequisites are
  missing

API metrics/logs:

- request count/status/duration
- safe request/correlation ids
- safe error code/category
- desktop contract version
- GitHub setup state transitions
- action enqueue outcomes
- no raw comments, prompts, tokens, OAuth codes, or webhook payloads
- public callback result class, not raw query values
- desktop contract version and safe client build metadata when present
- hosted feature gate state in startup logs only as booleans
- callback duplicate/replay counts
- desktop auth rejected count by safe reason class
- request body size rejection count

## Admin And Recovery

Minimal operator workflows:

- inspect workspace connection by safe public id
- inspect GitHub installation binding by safe public id
- inspect outbox event by id
- inspect dead-letter reason without raw secret/content leakage
- retry safe dead-letter event if policy allows
- cancel queued action if feature gate is disabled
- revoke desktop client
- revoke workspace GitHub connection
- force refresh repository availability snapshot

Admin access rules:

- no broad unauthenticated admin endpoints
- prefer CLI or protected internal endpoint
- every admin mutation writes audit event
- admin output redacts action content and secrets
- admin retry requires current target policy re-evaluation unless explicitly
  documented otherwise
- admin cancel keeps encrypted content retention/shred policy explicit
- admin force-refresh repository availability must not silently enable targets

Runbook edge cases:

- lost GitHub App private key
- leaked webhook secret
- leaked OAuth client secret
- database connection string rotation during worker processing
- stuck processing event older than lease
- dead-letter caused by decryption failure
- connected installation deleted from GitHub side
- public base URL changed while setup sessions are pending
- staging/prod secret accidentally swapped
- worker deployed without API deploy
- API deployed without worker deploy
- migration partially applied
- encrypted content cleanup job disabled or failing
- rate-limit retry-after longer than normal alert window
- public setup callback replayed after session expiry
- OAuth provider returns error with user-facing description
- desktop client compromised but GitHub installation still valid
- target policy accidentally too broad and needs emergency deny
- repository renamed, transferred, archived, or made private after target was
  enabled
- two installations expose repositories with the same display full name over
  time because of rename/transfer history
- worker crashes after GitHub accepts a write but before local status
  persistence completes
- operator sees unknown-result dead-letter and must decide between marker lookup,
  manual GitHub inspection, or explicit new action
- desktop sends raw local agent/team ids instead of normalized policy subject
  ids, causing validation failure before content should be accepted

## Observability And Alerts

Critical alerts:

- API readiness failing
- worker readiness failing
- outbox lag above threshold
- dead-letter count increasing
- GitHub token broker failures
- OAuth claim failure spike
- setup callback failure spike
- database connection failures
- encrypted content cleanup lag above retention
- webhook signature verification failures spike
- rate-limit backoff sustained above threshold
- public callback error spike
- desktop auth failures spike after deploy
- setup sessions stuck in pending claim
- worker processing events older than lease plus recovery window
- callback abuse/replay spike
- request body size rejection spike
- rendered-body validation failure spike after desktop release
- unknown-result dead-letter count above zero for public comment/review actions
- target policy subject id validation failures spike after desktop release
- token broker scope mismatch or unsupported repository id count above zero
- provider 401/403 spike after token broker success
- production app registration drift detected

Dashboards:

- setup funnel
- connected installations
- enabled repository targets
- action requests by type
- action success/failure/dead-letter
- outbox latency
- GitHub provider error classes
- API p95 latency

Minimum metric dimensions:

- environment
- build revision
- event type/action type
- safe error code
- provider response class
- feature gate state

Do not use high-cardinality labels for raw action ids, repository names, user
names, prompts, comment bodies, or GitHub tokens.

Alert severity:

- page immediately: API/worker readiness down, token broker total failure,
  encryption/decryption failure spike, outbox lag threatening retention,
  public callback abuse affecting setup
- ticket soon: isolated provider 404/422 growth, setup funnel regression,
  stale repository snapshots, cleanup lag below retention threshold
- dashboard only: expected policy denials, user-cancelled setup, expired setup
  sessions

## Security And Privacy Review

Review checklist:

- no GitHub private key in built artifacts
- no session tokens in logs
- no OAuth codes in logs
- no raw action content in logs
- no raw webhook payloads persisted by default
- encrypted content retention enforced
- dead-letter content retention bounded
- setup `installation_id` remains untrusted until claim verification
- desktop tokens are revocable
- repository target policy fails closed
- GitHub installation tokens never leave server process
- setup and OAuth callbacks log only result class plus safe ids
- desktop API rejects browser-origin credentialed calls unless explicitly
  allowed by the deployment model
- support bundles and failure artifacts run a redaction scan before upload or
  sharing
- backups include enough key material references for restore, but not plaintext
  secrets in exported dumps
- desktop bearer tokens are treated as revocable app credentials and never
  reused as user identity proof
- public setup/OAuth callback handlers are safe under duplicate delivery and
  parameter pollution
- request size limits exist before payloads reach expensive parsing or logging
- operator and support workflows identify repositories by immutable GitHub
  repository id plus connection id, not display name only
- unknown-result recovery runbook is explicit that blind retry can duplicate
  public GitHub comments or reviews
- support runbooks distinguish invalid subject id validation from target policy
  no-match or explicit-deny outcomes

Backup and restore gate:

- restore staging database backup into an isolated environment
- verify encrypted action content can be read only with expected key material
- verify shredded/deleted content does not reappear after restore
- verify restored outbox does not dispatch old public comments unless dispatch
  is explicitly enabled
- document how to freeze worker dispatch during restore
- restore drill starts with outbox worker disabled and actions gate disabled
- restore drill verifies no expired encrypted content is resurrected into
  dispatchable state

## Test Plan

Automated tests:

- hosted config fail-fast tests
- secret redaction tests
- readiness tests for missing DB/config
- worker startup hosted-mode tests
- outbox lag/dead-letter metric tests where practical
- smoke script using mocked GitHub provider
- migration status command test where practical
- startup matrix tests for valid and invalid feature-flag combinations
- safe summary tests for no raw env values
- admin/runbook command tests where commands are introduced
- build revision parity test for API/worker smoke where practical
- backup/restore dry-run checklist before beta
- public callback duplicate/replay tests
- request size limit tests for setup/action endpoints
- rendered body boundary tests for attribution/footer overhead and reserved
  marker collision
- token broker scope mismatch tests for broader repository ids and broader
  permissions
- stale repository availability blocks token issuance in staging/mocked smoke
- provider 401/403/404 classification tests in GitHub action dispatcher
- repository rename/transfer/archived-state runbook rehearsal in staging
- ambiguous provider outcome runbook rehearsal using mocked post-write crash
- desktop subject-id mapping regression test covers raw ids rejected by backend

Manual hosted smoke:

- deploy API and worker to staging
- apply migrations
- register staging GitHub App settings
- install app into sandbox organization
- pair desktop
- bind installation to workspace
- enable target repository
- submit issue comment
- submit PR conversation comment
- submit check run if enabled
- remove installation and verify failure state
- rotate a non-production secret and verify recovery
- pause worker, enqueue action, resume worker, verify delayed dispatch
- disable actions gate, verify new requests fail safely and queued events remain
  recoverable
- deploy API-only maintenance state and verify worker remains paused
- deploy worker-only rollback rehearsal in staging with dispatch disabled
- replay setup/OAuth callback URLs after success/expiry and verify safe result
- simulate installation removal and verify target refresh/suspension path

## Acceptance Criteria

- hosted API and worker can deploy from documented commands
- hosted mode fails fast without required secrets
- GitHub App registration settings are documented and reviewed
- staging GitHub App can complete install/claim/setup
- worker dispatches through outbox in staging
- required metrics and alerts are defined
- secret rotation runbooks exist for all critical secrets
- migration and rollback stance is documented
- no raw secret/content appears in health, logs, or diagnostics
- operational smoke passes before public beta
- documented startup matrix matches config validation behavior
- rollback procedure can pause new requests and worker dispatch independently
- staging proves API and worker run the same release revision
- staging proves one restore drill or documents an accepted pre-beta blocker
- metrics avoid high-cardinality/secrets-bearing labels
- registration drift checklist is complete for staging and production apps
- public callback replay and parameter pollution are tested
- provider auth/not-found errors have distinct safe operational classification
- request size limits are documented and verified before public beta
- rendered-body validation and reserved marker validation have safe diagnostics
  without raw content leakage
- token broker proves one-repository scope and minimum permission mapping for
  every enabled action type
- repository identity runbooks use immutable ids and cover rename/transfer
  cases
- unknown-result comment/review dead-letter cannot be retried by an operator
  without an explicit recovery decision
- hosted diagnostics show safe validation code when desktop sends an invalid
  subject id and do not log raw action content

## Rollout

Recommended rollout:

1. staging hosted deployment
2. staging GitHub App private installation
3. internal desktop dogfood
4. limited trusted external testers
5. public GitHub App listing only after Phase 11 release gate

## Open Questions

Blockers before implementation:

- chosen hosting platform and secret manager
- production database provider
- operator access mechanism for admin/recovery workflows
- whether V1 needs webhook ingress in public beta or only setup/action flows

Non-blocking:

- multi-region topology
- separate GitHub integration service
- customer-managed keys
- enterprise BYO GitHub App
