# Hosted GitHub App Operations

This runbook is the Phase 10 operating contract for the official hosted GitHub
App path.

The desktop app remains local-first. This backend is required only when a user
connects the official hosted GitHub App integration.

## Operating Model

V1 topology:

```text
platform router
  -> control-plane api process

control-plane worker process
  -> DB-backed outbox

managed Postgres
  -> workspace identity
  -> GitHub installation bindings
  -> repository targets and policies
  -> action requests, outbox, locks, encrypted external content

managed secret store
  -> GitHub App private key
  -> GitHub App webhook secret
  -> GitHub OAuth client secret
  -> encryption master key or key reference
  -> database URL
```

Rules:

- API and worker are built from the same release revision.
- API and worker run as separate processes from the same modular monolith.
- Migrations are applied before enabling code paths that depend on them.
- The worker can be paused independently with
  `CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false`.
- New GitHub action requests can be paused independently with
  `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=false`.
- The official GitHub App private key never ships in Electron, local config,
  docs examples, Docker image layers, support bundles, or build logs.

## Startup Matrix

`getSafeConfigSummary(config).hostedProfile` classifies the operational profile.
Use it in startup logs, deploy checks, and incident triage.

### Local Disabled

Default for local development.

```text
CONTROL_PLANE_MODE=local-disabled
CONTROL_PLANE_PERSISTENCE_ENABLED=false
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false
```

No hosted secrets are required.

### Setup-Only Staging

Use for first hosted deployment and GitHub App setup/OAuth callback validation.

```text
CONTROL_PLANE_MODE=hosted-official-app
CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED=true
CONTROL_PLANE_DESKTOP_PAIRING_ENABLED=true
CONTROL_PLANE_GITHUB_SETUP_ENABLED=true
CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED=true
CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED=false
CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED=false
CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=false
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false
```

### Target-Management Staging

Use after setup works and before token broker/action dispatch is enabled.

```text
CONTROL_PLANE_MODE=hosted-official-app
CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED=true
CONTROL_PLANE_DESKTOP_PAIRING_ENABLED=true
CONTROL_PLANE_GITHUB_SETUP_ENABLED=true
CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED=true
CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED=true
CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED=false
CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=false
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false
```

### Actions Staging Or Beta

Use only after setup and target-management staging pass.

```text
CONTROL_PLANE_MODE=hosted-official-app
CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED=true
CONTROL_PLANE_DESKTOP_PAIRING_ENABLED=true
CONTROL_PLANE_GITHUB_SETUP_ENABLED=true
CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED=true
CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED=true
CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED=true
CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=true
CONTROL_PLANE_PERSISTENCE_ENABLED=true
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=true
CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS=<short retention>
CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL=<https URL from allowed origin>
CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS=<comma-separated https origins>
```

Invalid combinations must fail fast:

- GitHub actions without persistence.
- GitHub actions without outbox worker.
- GitHub actions without token broker.
- GitHub actions without integration targets.
- GitHub actions without external content retention.
- GitHub actions without default avatar URL and allowed origins.
- Token broker without integration targets.
- Claim OAuth without setup.
- Hosted production mode without HTTPS public base URL.
- Hosted mode without database URL and encryption master key.

## Required Environment Inventory

Never print full env values in health, logs, smoke output, or failure artifacts.

| Key                                        | Owner            | Source                        | Rotation           | Blast radius                         |
| ------------------------------------------ | ---------------- | ----------------------------- | ------------------ | ------------------------------------ |
| `CONTROL_PLANE_PUBLIC_BASE_URL`            | platform         | deploy config                 | on domain change   | setup, OAuth, desktop API links      |
| `CONTROL_PLANE_DATABASE_URL`               | platform         | secret store                  | provider policy    | all durable state                    |
| `CONTROL_PLANE_ENCRYPTION_MASTER_KEY`      | security         | secret store or KMS reference | planned only       | encrypted action content and secrets |
| `CONTROL_PLANE_GITHUB_APP_ID`              | GitHub app owner | GitHub App settings           | app recreation     | token broker and setup               |
| `CONTROL_PLANE_GITHUB_APP_SLUG`            | GitHub app owner | GitHub App settings           | app rename         | setup links and diagnostics          |
| `CONTROL_PLANE_GITHUB_REST_API_VERSION`    | backend          | release config                | GitHub API upgrade | provider compatibility               |
| `CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY`     | security         | secret store                  | key rotation       | GitHub App token issuance            |
| `CONTROL_PLANE_GITHUB_WEBHOOK_SECRET`      | security         | secret store                  | webhook rotation   | webhook authenticity                 |
| `CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID`     | GitHub app owner | GitHub App settings           | app OAuth change   | setup claim flow                     |
| `CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET` | security         | secret store                  | OAuth rotation     | setup claim flow                     |
| `CONTROL_PLANE_BUILD_REVISION`             | release          | CI/CD                         | every release      | deploy parity                        |
| `CONTROL_PLANE_BUILD_CREATED_AT`           | release          | CI/CD                         | every release      | deploy traceability                  |

Secret examples in docs must use empty placeholders or operator instructions,
not fake private keys or fake tokens that can be copied into client config.

## GitHub App Registration Checklist

Record these for staging and production separately:

- App name.
- App owner organization.
- Recovery admins and emergency transfer contacts.
- Homepage URL.
- Setup URL: `${CONTROL_PLANE_PUBLIC_BASE_URL}/api/public/github/setup/callback`
  or the implemented setup entrypoint for the current release.
- OAuth callback URL:
  `${CONTROL_PLANE_PUBLIC_BASE_URL}/api/public/github/claim/oauth/callback`
  or the implemented claim callback entrypoint for the current release.
- Webhook URL if webhook ingress is enabled.
- Webhook secret stored in the managed secret store.
- Private key stored only in the managed secret store.
- App visibility: private during staging, public only after Phase 11.
- Installation target policy.
- Repository permissions mapped to enabled action types.
- Account permissions mapped to claim/setup requirements.
- Subscribed webhook events, if webhook ingress is enabled.

Minimum V1 permission stance:

- Issue comments require issues metadata/read plus issue comment write scope
  supported by GitHub App permissions.
- PR conversation comments and PR reviews require pull request read/write scope.
- Check runs require checks write scope only when check runs are enabled.
- Repository identity validation requires metadata/read.

Forbidden for V1 unless a separate plan approves it:

- contents write
- administration write
- secrets write
- actions write
- merge/write capabilities

Registration drift checks before each rollout:

- Setup, OAuth callback, and webhook URLs match the deployed public base URL.
- Staging and production GitHub Apps use different secrets and callback URLs.
- Documented permissions match enabled backend action types.
- Disabled action types do not require their write permissions.
- Old callback URLs are removed only after pending setup sessions expire.
- Public callback URLs are reachable from outside the private network.

## Deployment Procedure

1. Build release artifact from a clean revision.
2. Run local control-plane gate:

```bash
pnpm --dir control-plane verify:phase1
```

3. Apply staging migrations:

```bash
pnpm --dir control-plane db:migrate
```

4. Start API in setup-only profile.
5. Start worker with `CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false`.
6. Verify `/health` and `/ready`.
7. Run hosted smoke against staging:

```bash
CONTROL_PLANE_HOSTED_SMOKE_BASE_URL=https://staging-control-plane.example.test \
CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_MODE=hosted-official-app \
CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_REVISION=<release revision> \
pnpm --dir control-plane hosted:smoke
```

8. Complete setup and target-management staging.
9. Enable token broker.
10. Enable GitHub actions and outbox worker together.
11. Run one live action smoke in staging.
12. Promote the same revision to production.

Promotion is blocked if staging API and worker revisions differ.

## Migration And Rollback

Migration rules:

- Prefer additive migrations.
- New code should read both old and new schema where practical.
- Outbox event version changes must be backward compatible or gated.
- Destructive migration requires a separate release gate and backup.
- Encrypted action content retention must survive code rollback.

Rollback rules:

- Disable `CONTROL_PLANE_GITHUB_ACTIONS_ENABLED` to stop new action requests.
- Disable `CONTROL_PLANE_OUTBOX_WORKER_ENABLED` to pause dispatch without
  deleting queued outbox events.
- Do not downgrade schema unless a tested rollback migration exists.
- Do not rotate encryption keys during emergency code rollback.
- If token broker fails after rollback, pause dispatch before retries consume
  max attempts.
- If setup callbacks fail after rollback, stop public setup links before users
  enter OAuth.
- If callback abuse spikes, rate-limit or disable setup starts before touching
  already connected workspaces.

## Worker Operations

Worker readiness must be treated as failed if:

- database is unreachable
- outbox claim path cannot initialize
- lock adapter is missing or misconfigured
- event handler registry is not loaded
- GitHub token broker config cannot parse in actions profile
- hosted feature gates are inconsistent

Track these metrics:

- pending outbox events by type
- processing outbox events by age
- retry count by type
- dead-letter count by type
- dispatch success and failure counts
- GitHub provider response class
- token broker request count
- rate-limit and retry-after count
- encrypted content cleanup lag

Worker safety rules:

- Unknown event versions go dead-letter or alert before retries burn down.
- Provider retry-after updates next attempt time.
- Feature flag disable pauses dispatch without losing queued events.
- Decryption failure fails closed.
- Private key parse failure fails readiness before dispatch.
- Dead-letter inspection does not decrypt action body by default.
- Unknown provider write outcome for comments/reviews is not blindly retried.
- Check-run create retry requires stored `githubCheckRunId` or `external_id`
  recovery proof.
- Token scope mismatch is a security failure and must not log tokens.

## API Operations

Health and readiness:

- Liveness stays shallow.
- Readiness checks critical dependencies only.
- Hosted mode readiness fails when DB or required config is missing.
- Health returns service name, version, build metadata, safe config booleans,
  and readiness summary only.
- Health and readiness never return secrets, full env values, OAuth codes,
  GitHub tokens, private keys, or raw action content.

Logs:

- Include safe request id and correlation id.
- Include safe error code and category.
- Include desktop contract version when present.
- Include setup/action result class, not raw callback query or action body.
- Log hosted feature gate state only as booleans/profile.
- Never log raw prompts, comments, OAuth codes, webhook payloads, GitHub tokens,
  desktop bearer tokens, or private keys.

## Admin And Recovery

V1 operator actions should stay CLI or protected internal tooling only. Do not
add broad unauthenticated admin endpoints.

Minimum workflows:

- inspect workspace connection by safe public id
- inspect GitHub installation binding by safe public id
- inspect outbox event by id
- inspect dead-letter reason without raw secret/content leakage
- retry safe dead-letter event only when policy allows
- cancel queued action when dispatch is disabled
- revoke desktop client
- revoke workspace GitHub connection
- force refresh repository availability without enabling targets

Every admin mutation must write an audit event.

Recovery cases to rehearse:

- lost GitHub App private key
- leaked webhook secret
- leaked OAuth client secret
- stuck processing event older than lease
- dead-letter caused by decryption failure
- connected installation deleted from GitHub
- public base URL changed with pending setup sessions
- staging/prod secret accidentally swapped
- worker deployed without matching API revision
- API deployed without worker revision
- migration partially applied
- cleanup job disabled
- repository renamed, transferred, archived, or made private
- worker crash after GitHub accepted a write but before local status persisted
- unknown-result dead-letter requiring manual recovery decision
- invalid desktop subject ids causing safe validation failures

## Secret Rotation

General rotation rules:

- Rotate one secret class at a time.
- Test in staging before production.
- Keep old/new overlap only when implementation supports it.
- Verify health, readiness, token broker, and one live action after relevant
  rotations.
- Never rotate encryption master key and perform code rollback in the same
  maintenance window.

Secret-specific notes:

- GitHub App private key: create new key, update secret store, redeploy, verify
  token broker, revoke old key, run one live staging action.
- Webhook secret: update GitHub App and secret store according to supported
  overlap strategy, then replay-safe webhook smoke if webhook ingress is
  enabled.
- OAuth client secret: pending claim sessions may need to expire unless overlap
  is implemented.
- Desktop token leak: revoke affected desktop clients. Do not rotate GitHub App
  private key for this case.
- Encryption key: use a planned rewrap or crypto-shred policy. Do not ad hoc
  rotate.

## Observability And Alerts

Page immediately:

- API readiness down
- worker readiness down
- GitHub token broker total failure
- encryption/decryption failure spike
- outbox lag threatening retention
- public callback abuse affecting setup
- token broker scope mismatch count above zero

Create ticket soon:

- isolated provider 404/422 growth
- setup funnel regression
- stale repository availability snapshots
- cleanup lag below retention threshold
- target policy subject id validation spike after desktop release

Dashboard only:

- expected policy denials
- user-cancelled setup
- expired setup sessions

Required dashboard dimensions:

- environment
- build revision
- event type or action type
- safe error code
- provider response class
- feature gate state

Forbidden metric labels:

- raw action ids
- repository names
- user names
- prompts
- comment bodies
- GitHub tokens
- OAuth codes

## Backup And Restore Gate

Before public beta:

1. Restore staging database backup into an isolated environment.
2. Start API and worker with actions disabled and worker disabled.
3. Verify encrypted action content can be read only with expected key material.
4. Verify shredded/deleted content does not reappear as dispatchable content.
5. Verify restored outbox does not dispatch old public comments until dispatch
   is explicitly enabled.
6. Document key material references needed for restore without exporting
   plaintext secrets.

Restore drills start with:

```text
CONTROL_PLANE_GITHUB_ACTIONS_ENABLED=false
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false
```

## Release Readiness Checklist

- Hosted API deploys from documented commands.
- Worker deploys from the same release revision as API.
- Hosted mode fails fast without required secrets.
- GitHub App registration settings are documented and reviewed.
- Staging setup/install/claim succeeds.
- Repository target enablement succeeds.
- Token broker issues one-repository, minimum-permission tokens.
- Worker dispatches through outbox in staging.
- Metrics and alerts are configured.
- Secret rotation runbooks exist for critical secrets.
- Migration and rollback stance is documented.
- No raw secret/content appears in health, logs, smoke output, or diagnostics.
- `pnpm --dir control-plane hosted:smoke` passes against staging.
- Backup/restore drill passes, or accepted pre-beta blocker is documented.
- Unknown-result comment/review recovery cannot be retried blindly by an
  operator.

Phase 11 owns the live E2E release evidence before public beta.
