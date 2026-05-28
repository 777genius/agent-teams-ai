# Agent Teams Control Plane

Agent Teams Control Plane is the optional hosted integration layer for Agent Teams.

The desktop app remains local-first. This package is not required for normal desktop usage, local teams, local runtimes, or local task management. It is needed only for hosted integrations and future cloud-facing workflows such as:

- GitHub App installation, token brokering, comments, reviews, checks, and webhooks
- Telegram, Slack, Discord, and other messenger connectors
- hosted notification and webhook ingress
- optional runtime-to-frontend relay
- future billing, entitlement, audit, and team synchronization flows

## Architecture Direction

The chosen direction is:

```text
NestJS modular monolith
+ Clean Architecture inside feature packages
+ simple DDD bounded contexts
+ outbox-first side effects
+ service-ready module boundaries
```

NestJS is an outer framework, not the business architecture. Domain and application layers are plain TypeScript.

## Documentation

- [Architecture Plan](docs/architecture.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Plan Review And Hardening](docs/plan-review-and-hardening.md)
- [Phase 4 Persistence, Transactions, Outbox, Locks Plan](docs/phase-4-persistence-transactions-outbox-locks-plan.md)
- [Phase 5 Workspace-Bound GitHub Installation Plan](docs/phase-5-workspace-bound-github-installation-plan.md)
- [Phase 6 Repository Target Binding Policy Plan](docs/phase-6-repository-target-binding-policy-plan.md)
- [Phase 7 GitHub Installation Token Broker Plan](docs/phase-7-github-installation-token-broker-plan.md)
- [Phase 8 Agent GitHub Actions Outbox Plan](docs/phase-8-agent-github-actions-outbox-plan.md)
- [Phase 9 Desktop GitHub Integration Bridge Plan](docs/phase-9-desktop-github-integration-bridge-plan.md)
- [Phase 10 Hosted GitHub App Operations Plan](docs/phase-10-hosted-github-app-operations-plan.md)
- [Phase 11 Live E2E Release Gate Plan](docs/phase-11-live-e2e-release-gate-plan.md)
- [Hosted GitHub App Operations Runbook](docs/hosted-github-app-operations.md)
- [Edge Cases And Failure Modes](docs/edge-cases.md)
- [Security And Privacy Model](docs/security-and-privacy.md)
- [Public Error Contract](docs/error-contract.md)
- [ADR-001: NestJS Modular Monolith](docs/decisions/001-nestjs-modular-monolith.md)
- [ADR-002: Phase 4 Persistence Foundation](docs/decisions/002-phase-4-persistence-foundation.md)
- [Persistence Runbook](docs/persistence-runbook.md)
- [Outbox Worker Runbook](docs/outbox-worker-runbook.md)
- [Encryption And Retention Policy](docs/encryption-retention-policy.md)

## Deployment Modes

V1 targets a hosted official GitHub App flow:

```text
official GitHub App
  -> hosted control-plane
  -> desktop-paired workspace
```

This is the only mode where users can install the shared official GitHub App without creating their own app.

Self-hosting is still possible later, but it has different trust rules:

- self-hosted control-plane with the official GitHub App still needs a hosted token broker owned by us
- fully self-hosted control-plane without our broker requires a user-owned GitHub App and user-owned private key
- the official GitHub App private key must never be shipped in Electron, npm packages, Docker images, or local developer examples

## Non-Goals For V1

- Do not make the desktop app depend on this service.
- Do not store repository code, diffs, raw prompts, reusable model-output logs, or local runtime logs.
- GitHub comment/message bodies may exist only as encrypted short-retention external action content for explicit dispatch.
- Do not start with physically separate microservices.
- Do not expose GitHub App private keys to Electron or local agent runtimes.
- Do not let agents receive GitHub installation tokens directly.

## Target Repository Shape

```text
control-plane/
  apps/
    api/
    worker/

  packages/
    features/
    platform/
    shared/

  docs/
```

Phase 1 provides the workspace scaffold, health feature, config/logger platform packages, and architecture guardrails. Phase 2 adds the dependency-free shared kernel, build metadata plumbing, safe error primitives, typed IDs, time helpers, validation helpers, and stricter shared-kernel guardrails. Phase 3 adds the API safe error boundary, request/correlation ids, request context, and safe request logging. Phase 4 adds optional Postgres persistence, transactions, envelope-encrypted external action content, DB-backed outbox, dead-letter state, and worker claim/retry foundations. Phase 5 adds workspace-bound GitHub App installation setup, desktop client identity, pairing, OAuth claim verification, and repository availability snapshots. Phase 6 adds repository target binding and policy gates. Phase 7 adds the server-side GitHub installation token broker. Phase 8 adds outbox-backed Agent GitHub actions for comments, PR reviews, and check runs without exposing installation tokens to desktop or agents. Phase 9 connects desktop/runtime to the hosted GitHub action path. Phase 10 makes the hosted GitHub App deployment operable. Phase 11 is the live E2E release gate before public beta.

`control-plane/` is a nested pnpm workspace on purpose. The desktop app remains the default root workspace, while the optional backend is developed and verified with `pnpm --dir control-plane ...` commands.

## Control-Plane Commands

Run these commands from the repository root when working only on the control-plane:

```bash
pnpm --dir control-plane install --frozen-lockfile
pnpm --dir control-plane verify:phase1
```

`verify:phase1` runs the repeatable scaffold gate:

```bash
pnpm --dir control-plane format:check
pnpm --dir control-plane architecture:check
pnpm --dir control-plane lint
pnpm --dir control-plane typecheck
pnpm --dir control-plane test
pnpm --dir control-plane build
pnpm --dir control-plane worker:smoke
pnpm --dir control-plane worker:smoke:dist
pnpm --dir control-plane api:smoke
pnpm --dir control-plane api:smoke:dist
pnpm --dir control-plane config:hosted-failfast
```

Hosted staging smoke after deployment:

```bash
CONTROL_PLANE_HOSTED_SMOKE_BASE_URL=https://staging-control-plane.example.test \
CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_MODE=hosted-official-app \
CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_REVISION=<release revision> \
pnpm --dir control-plane hosted:smoke
```

DB-specific commands:

```bash
pnpm --dir control-plane db:generate
pnpm --dir control-plane db:migrate
pnpm --dir control-plane db:test:prepare
pnpm --dir control-plane test:db
pnpm --dir control-plane worker:smoke:db
```

`test:db` and `worker:smoke:db` require `CONTROL_PLANE_TEST_DATABASE_URL`.
Normal local smoke tests run with persistence disabled and do not require
Postgres.

`packages/shared` remains dependency-free. Octokit, queue, messenger, and billing
SDKs are still deferred to later connector phases.
