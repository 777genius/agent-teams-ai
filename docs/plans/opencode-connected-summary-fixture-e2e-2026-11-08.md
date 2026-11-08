# OpenCode connected-summary fixture E2E — 2026-11-08

## Goal

Correct the disposable OpenCode CLI fixture: `--filter connected` currently reports unfiltered `filter: all` and never exercises the >100-provider fallback in the actual Electron app. Keep the fix **test-only**: no production provider polling, no credential changes, no dependency additions.

## Narrow implementation

1. Make the fixture honor `all` and `connected`, validate safe bounded `--limit`/`--cursor` and return exact `filter`, `totalCount`, `returnedCount`, `cursor`, `nextCursor`; reject unsupported flags.
2. Add one disposable `connected-summary` scenario with more than 100 provider records, four real connected fixture sources (including the OpenCode host), and available-only synthetic records. The all-directory is paginated; the connected-only summary completes in one page.
3. Run source subprocess assertions plus the existing Windows/Linux real Electron desktop E2E. Assert that the active Providers page actually issues the filtered subprocess, the result is complete, the displayed OpenCode count is correct, and only connected sources load model catalogs.
4. Preserve isolation/ownership/CDP protections and unchanged behavior for existing diagnostics scenarios.

## Performance assessment

* Passive Dashboard header mounts only a read-only selector and timers; it performs **zero provider directory/model IPC** itself.
* Startup still bootstraps CLI and schedules idle provider status/runtime checks globally.
* Previously visited Settings → Providers remains mounted while hidden, but passive directory/model/account polling is gated by active state; in-flight auth workflows remain alive.
* Real-world performance, cold startup and command execution time are separate questions: no claim of end-user speedup from fixture timings.

## Qualification

* Fixture subprocess tests, catalog invariants and full project CI.
* Linux/Windows OpenCode desktop E2E and saved screenshots/logs with no secrets.
* Required reviews, merge and post-merge CI when green.
