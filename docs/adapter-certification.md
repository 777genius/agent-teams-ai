# Subscription Runtime Adapter Certification

This checklist is the minimum gate before a provider, store, or runner adapter
is recommended outside internal ReviewRouter usage.

## Required Local Gate

Run from the repository root:

```bash
pnpm subscription-runtime:check
pnpm action:artifact:check
pnpm architecture:check
pnpm typecheck
git diff --check
```

For Codex compatibility changes, also run:

```bash
pnpm exec vitest run packages/features/codex-oauth-rotating/src/tests/codex-oauth-rotating.test.ts packages/features/codex-oauth-rotating/src/tests/github-action.test.ts
```

## Provider Adapter Gate

- Exports a manifest with protocol version, package name, package version,
  minimum core version, and capability metadata.
- Implements `ProviderSessionDriver` without importing host app code.
- Implements `AgentDriver` only if the adapter owns task execution.
- Validates session format before refresh or task execution.
- Classifies reconnect, quota, permission, invalid output, and unknown failures.
- Registers session bytes and provider-specific token material with the redactor.
- Does not write durable storage directly.
- Does not require interactive auth during runtime.
- Has contract tests for validate, refresh success, refresh no-op, reconnect,
  quota or permission failure, and redaction.

## Store Adapter Gate

- Exports a manifest with explicit custody mode.
- Implements read/write/delete only through `SessionStorePort`.
- Supports compare-and-swap when sessions may rotate.
- Supports idempotency for writeback retries.
- Rejects stale generation writes.
- Rejects conflicting idempotency keys.
- Has tests proving plaintext handling matches custody mode.
- For no-custody stores, backend requests must never contain raw session bytes,
  `refresh_token`, `access_token`, `id_token`, provider API keys, or auth JSON.

## Runner Adapter Gate

- Exports a manifest with platform and sandbox capabilities.
- Uses explicit env construction, not inherited process env.
- Blocks dangerous env keys such as GitHub tokens, OIDC request tokens, auth JSON,
  provider API keys, `NODE_OPTIONS`, `BASH_ENV`, and GitHub env file paths.
- Supports timeout and abort.
- Redacts stdout, stderr, thrown errors, and captured failure output.
- Does not receive a GitHub token with `Secrets: write` in no-custody mode.

## Host App Gate

- Host app owns policy, setup UX, workflow shape, OIDC validation, and comment
  lifecycle.
- Runtime config contains adapter ids and policy only, never session bytes.
- Manifests are validated before any session read.
- Production rollout keeps a rollback switch for one release.
- Live GitHub-hosted public and private E2E must pass before enabling a new
  adapter for all repositories.
- Live E2E is launched through `pnpm subscription-runtime:live-e2e`, not the raw
  spike file. The wrapper must pass `pnpm subscription-runtime:live-e2e:prereq`
  first and requires `REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1`.
- Live E2E target repositories must be disposable by name unless a canary owner
  explicitly sets `REVIEW_ROUTER_LIVE_E2E_ALLOW_NON_DISPOSABLE=1`.
- Codex live E2E default review mode is `finding`, so the gate proves refreshed
  secret writeback and the existing ReviewRouter inline finding format.

## ReviewRouter Codex V1 Status

- Default production custody mode: `no-plaintext-backend`.
- Production store: `store.github-actions-secret`.
- Development store: `store.local-encrypted-file`.
- Provider adapter: `provider.codex-cli`.
- Production Codex task agent: `codex-json`, backed by the packaged Codex JSON
  execution engine.
- Runner: `runner.github-action`.
- Rollback switch: set `REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX=0` or omit
  it to use the legacy refresh path for the compatibility release.

## Release Blockers

Do not release an adapter if any of these are true:

- A secret appears in test logs, thrown errors, runtime config, or API payloads.
- A provider can rotate sessions but the selected store lacks CAS or idempotency.
- A quota, reconnect, or permission state can fall through to task execution.
- A runner inherits broad environment variables from the host process.
- A no-custody writeback requires exposing plaintext to the SaaS backend.
- Live E2E cannot prove second-run reuse of refreshed session state.
- Live E2E only proves a clean run with no inline finding, or only proves a
  private repo. Public and private hosted runs must both be covered before broad
  enablement.
