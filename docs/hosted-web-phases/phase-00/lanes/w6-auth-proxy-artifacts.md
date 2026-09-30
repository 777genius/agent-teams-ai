# Phase 0 W6: Authentication, Proxy and Artifact Truth

- Packet revision: `phase-00-r2`
- Evidence owner: W6
- Depends on: completed 0A base record and baseline classification

## Mission

Prove restart-safe single-operator authentication and the exact standalone/bundle boundary before any
remote mutation route is enabled.

## Read set

Read the Phase 0 W6, ownership, schema and stop sections. From the master plan read `ADR-7`, `ADR-14`,
`ADR-17`, `HTTP contract rules`, `Docker and hosting topology`, `Migration and rollback` and current
standalone/build/internal-storage/CORS source and tests.

## Writable paths

- `docs/research/hosted-web/phase-0/auth-artifacts/**`
- `scripts/hosted-web/phase-0/auth-artifacts/**`
- `test/architecture/hosted-web/phase-0/auth-artifacts/**`
- worktree-local `.codex-handoff/phase-00-w6.json`

## Evidence

- `P0.W6.AUTH_TRANSITIONS`
- `P0.W6.PROXY_ORIGIN_THREAT_MATRIX`
- `P0.W6.COOKIE_VERSION_EVIDENCE`
- `P0.W6.ARTIFACT_INVENTORY`
- `P0.W6.ABI_STUB_REPORT`
- `P0.W6.TERMINAL_ABSENCE_REPORT`
- `P0.W6.ESTIMATE`

## Acceptance

Cover pairing, durable device family, session rotation, revoke/reset and response-loss schedules across
restart, expiry, two tabs and keyring failure; reject direct HTTP, forwarded-header spoof, wildcard CORS
and sibling authority before body handling; keep session authority server-side; prove emitted artifact,
worker needs, ABI splits and empty/missing stubs; prove terminal daemon/gateway/routes/migrations absent
from v1.

Do not enable auth/CORS, install dependencies or expose recovery credentials and secret values.

## Handoff

Return transition coverage, rejected proxy cases, artifact gaps, dependency facts with source/version,
checks, proof levels and unresolved deployment assumptions.
