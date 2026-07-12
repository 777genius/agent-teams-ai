# Agent Account Observability

Bounded context for observing agent provider accounts without scheduling work.

The package answers factual questions:

- is an account authenticated;
- is any quota window limited;
- when does a known window reset;
- what evidence produced the answer.

It does not select workers, launch jobs or perform relogin. Consumers such as
`subscription-runtime` use the normalized `availability` and quota snapshot to
make their own scheduling decisions.

## Provider Notes

Codex uses the official app-server auth endpoints first. The important endpoint
is `account/rateLimits/read`, whose documented response includes
`rateLimitsByLimitId`, `usedPercent`, `windowDurationMins`, `resetsAt`,
`credits`, `rateLimitReachedType` and `rateLimitResetCredits`.

App-server launches are serialized by a process-global throttle: first launch is
immediate, then the default minimum interval is 10s. Override with
`AGENT_ACCOUNT_OBSERVABILITY_CODEX_APP_SERVER_MIN_INTERVAL_MS` when a caller
needs a stricter or test-only interval.

Claude Code is intentionally modeled as a future adapter. Its statusline JSON
can expose `rate_limits.five_hour` and `rate_limits.seven_day` for Claude.ai
subscribers, but that data appears only after an API response and `/usage` is
local-history based. The domain model supports it without pretending it is as
strong as Codex app-server quota evidence.
