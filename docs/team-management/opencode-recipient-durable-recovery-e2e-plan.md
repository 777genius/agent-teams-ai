# OpenCode recipient identity — delivery E2E hardening

## Observed failure
A teammate present in `members.meta.json` but absent from `config.json` is rejected before user-message relay. PR #1115 repairs an app-owned tracked run, but fails closed when the app has restarted and only durable active runtime evidence remains. A config read failure can also mimic missing identity.

## Narrow plan
1. Preserve underlying read failures and distinguish an unavailable config from a metadata-only recipient in an existing config.
2. Retain fail-closed semantics for stale, stopped, foreign-profile, removed, duplicate or mismatched identity.
3. For an explicit human send only, allow a durable recovery when **all** of the following agree: owner marker, non-stopped current launch-state, unique OpenCode member with explicit model, confirmed runtime session, matching active lane manifest, and live runtime; verify again immediately before atomic config commit.
4. Avoid config writes during incomplete launch and status/background queries. Re-resolve recipient from the committed config before inbox persistence or relay.
5. Preserve offline inbox semantics: if Stop wins after identity repair, the human message may be queued but must not be reported as delivered to OpenCode. Test the Stop-after-resolution path and its runtime-delivery status explicitly.
6. Cover degraded/unsafe paths, concurrency, restart recovery, successful normal relay, and existing regression tests. Merge only after full CI/review and post-merge checks.

No new feature flags, schema changes, service orchestration or provider-auth requirements. Live-account/macOS acceptance remains separate from deterministic sandbox E2E.