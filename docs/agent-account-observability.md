# Agent Account Observability

`packages/agent-account-observability` is the bounded context for provider
account facts. It exists because detailed limit observation is not the same
responsibility as scheduling workers or running agent tasks.

## Responsibility

The package owns:

- auth state without secrets;
- quota snapshots and quota windows;
- observation evidence and confidence;
- normalized availability decisions such as `available`, `limited` and
  `relogin_required`;
- safe cache and serial per-account observation locks.

The package does not own:

- worker selection;
- account rotation policy;
- relogin automation;
- tmux, job launch, registry writes or task execution.

`subscription-runtime` consumes these facts and decides what to do with them.

## DDD Model

Bounded context: `Agent Account Observability`.

Core language:

- `AccountSlot` - stable local slot such as `account-a`.
- `AuthSession` - provider auth status without credential material.
- `QuotaSnapshot` - observed quota facts for one provider account.
- `QuotaWindow` - one limit bucket, for example five-hour or seven-day.
- `ObservationEvidence` - source and confidence for a fact.
- `AvailabilityDecision` - normalized scheduler-facing status.

The package uses strict enums for provider, availability, auth status, quota
window kind and evidence source. Provider-specific raw ids may stay strings,
but they are not discriminators.

## Codex Adapter

Codex uses app-server first:

1. start `codex app-server --listen stdio://` for one `CODEX_HOME`;
2. send `initialize`;
3. call `account/read` with `refreshToken: false`;
4. call `account/rateLimits/read`;
5. close the process;
6. if app-server cannot provide a clear result, optionally use `codex exec`
   as the stronger live fallback.

The official Codex app-server docs describe `account/rateLimits/read` fields
such as `rateLimitsByLimitId`, `usedPercent`, `windowDurationMins`, `resetsAt`,
`credits`, `rateLimitReachedType` and `rateLimitResetCredits`:

<https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt>

The adapter does not attach to arbitrary already-running app-server processes
by default. A caller may provide an explicit client/transport if it owns that
process.

App-server launches are throttled in-process. The first launch is immediate,
then subsequent `codex app-server` starts are serialized with a 10s minimum
interval by default. This reduces bursty account-pool diagnostics without
changing scheduler policy. Override it with
`AGENT_ACCOUNT_OBSERVABILITY_CODEX_APP_SERVER_MIN_INTERVAL_MS`; legacy runtime
integrations may also use `SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_MIN_INTERVAL_MS`.
Set the value to `0` only in tests or explicitly controlled environments.

The same anti-burst rule applies to interactive relogin. Do not launch multiple
`codex login --device-auth` processes at once for different slots; this can hit
provider `429 Too Many Requests`. Relogin one slot at a time, then verify that
slot's main `codex` 5h and 7d quota windows before moving on.

## Claude Code Adapter

Claude Code support is intentionally thinner for now. The domain can represent
Claude limits, and the package includes a statusline quota mapper, but it does
not pretend Claude exposes the same strength of evidence as Codex app-server.

Official Claude Code docs say the statusline JSON can include
`rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and
`resets_at`, and that the field appears for Claude.ai subscribers after the
first API response:

<https://docs.anthropic.com/en/docs/claude-code/statusline>

The `/usage` breakdown for Pro/Max is approximate and computed from local
session history, so it is not a complete account-wide quota source:

<https://docs.anthropic.com/en/docs/claude-code/costs>

## Integration Path

Current state:

- `src/account-diagnostics` remains the existing subscription-runtime
  diagnostic read model and CLI surface.
- `packages/agent-account-observability` is the new package boundary for
  deeper provider auth/quota observation.
- `codex_accounts_status` and the Codex goal account status path use the package
  during live checks to read Codex app-server quota buckets before falling back
  to a controlled exec probe.
- A live Codex limit with an exact future reset is persisted into the shared
  worker account capacity store as account-wide `quota_exhausted`. Selectors
  therefore skip the account until the provider reset instead of rediscovering
  the same limit through repeated worker runs.
- If both the five-hour and seven-day windows are limited, the durable cooldown
  ends at the later reset. If any blocking window lacks a future reset, the
  observer does not claim an exact recovery time or create a permanent record.
- The capacity store is scoped by the canonical auth-pool root rather than a
  job state directory, so separate jobs using the same pool share quota facts.
- Slot aliases are resolved to a full provider-account hash before capacity is
  persisted. Different slot names for the same physical Codex account therefore
  share one quota record and one recheck claim. Raw provider ids and credentials
  are never used as persisted capacity keys.
- Worker quota failures trigger one automatic app-server observation. After a
  stored reset, a durable single-flight claim performs one lazy recheck before
  provider work: `available` CAS-removes only the claimed record,
  `still_limited` extends it, and inconclusive checks get a bounded retry.
- Rechecks are identity-bound. If `auth.json` changes to another provider
  account while a claim is in flight, the result becomes a bounded retry and
  cannot clear the previous account's quota record.
- Capacity instrumentation uses the existing observability port with
  `subscription_runtime.worker_account_capacity_recheck_due`,
  `..._recheck_busy`, `..._recheck_failed`, `..._lock_recovery` and
  `..._time_to_reset_ms`. Metrics contain no account ids or auth material.
  The default Codex goal runner writes them as `runtime_metric` JSONL events;
  embedded hosts can inject their own `ObservabilityPort` exporter instead.

Next integration step:

- map `AccountObservation` into the generic
  `subscription-runtime-account-status` CLI path;
- keep scheduler decisions in `subscription-runtime`, not in the package.

## Edge Cases

- `codex login status` can be stale. A successful app-server quota read or live
  exec probe is stronger evidence.
- App-server quota failure without fallback must not be reported as available.
- App-server launch throttling is a provider-friendly safety control, not a
  guarantee against provider enforcement or account policy decisions.
- Reset timestamps from Codex are Unix seconds. Consumers should format them in
  the operator timezone.
- Two slots can point at the same provider account. Consumers should dedupe by
  stable account hash, not slot id.
- Claude statusline rate limits can be absent before the first response.
- `/usage` may miss Claude usage from other devices or claude.ai.
- Never persist or print raw auth JSON, access tokens, refresh tokens, cookies
  or id tokens.
