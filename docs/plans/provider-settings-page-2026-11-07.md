# Provider settings page + passive dashboard summary

Status: **plan-first Draft PR**. Base inspected: `9959d667ae348356f4402bfa5d5d185a7388c8d6` (2026-11-07).
Owner: Agent Teams Desktop/renderer. **Do not merge until exact-head CI, reviews, and focused E2E pass.**

## Goal / user contract

1. Dashboard shows one short, inexpensive **read-only** summary of known provider connections and a **Configure providers** action.
2. Full provider experience, including existing cards, OpenCode plans, installation, authentication, models, rate limits and diagnostics, moves to **Settings → Providers** with its current layout and behavior.
3. Switching tabs never silently cancels a running login, credential save, model test, or provider installation.
4. No new provider scan exists solely to render the dashboard count. Preserve team launch authority and project isolation.

## Evidence in current code (do not assume this is a greenfield project)

- `src/renderer/components/dashboard/DashboardView.tsx` mounts `CliStatusBanner`.
- `CliStatusBanner.tsx` (2,835 lines): `InstalledBanner` renders `RuntimeProviderQuickConnect enabled` under `hidden` CSS when collapsed; hidden != disabled. It also starts OpenCode connected-model catalog, Codex snapshot, Anthropic subscription 60s polling, and 10min refresh; some work is independent of `isDashboardActive`.
- `src/renderer/store/index.ts`: initial bootstrap uses `providerStatusMode: 'defer'`, then schedules idle provider status hydration **globally**. This must remain; it is not solely dashboard work.
- `CliInstallerService.ts`: `defer` does a light binary resolution; it **does not** prove any provider connected. Full checks may still be needed later for real readiness.
- `src/renderer/store/slices/cliInstallerSlice.ts`: global `cliStatus.providers` and project-keyed `cliProviderStatusByScope`; preflight and launch authority depend on separate authoritative status + catalog freshness.
- `RuntimeProviderQuickConnect.tsx`: current `observedConnectedCount` is a count of curated cards, not necessarily the complete OpenCode directory.
- `useOpenCodeConnectedModelCatalog.ts`: potentially paginates directory (up to 20 pages) and fetches each connected source's models. **Never run to obtain dashboard count.**
- `runtimeProviderDirectoryCache.ts`: already provides `useRuntimeProviderDirectoryCache` / `useRuntimeProviderDirectoryCacheWithGlobalFallback` using `useSyncExternalStore`, grouped by project. Cached summary can be incomplete; `authoritative`, `totalCount`, `nextCursor` must be respected.
- `PaneContent.tsx`: opened tabs intentionally remain mounted; `PaneContent.test.tsx` tests preservation.
- `useRuntimeProviderManagement.ts`: disabling the entire provider manager resets form data and triggers best-effort OAuth cancellation. Do **not** set `enabled=false` just because user switched tabs.
- `SettingsView.tsx` and `SettingsTabs.tsx`: existing Settings tab structure; `openSettingsTab(section)` supports deep navigation. `Settings → Gateway providers` is distinct and stays.
- `Settings → Advanced → CliStatusSection` exposes a legacy secondary provider surface. Preserve until parity is proven; avoid simultaneous mounting.
- Open provider-preflight/Host PRs (#982, #1109, #1119) are **out of scope**; recheck for merge conflicts.

## Connected count: explicit semantics and truthfulness

**Never claim a single exact total based on `cliStatus.providers.length`, `authLoggedIn`, or the curated quick cards.** These mean different things.

- Main CLI credentials: count each distinct `anthropic`, `codex`, `gemini` entry only when authoritative enough for **connected** display (exclude pending, transient failures, and `isProviderInventoryOnlyFallback`). `authenticated` is connection evidence, **not** launch readiness. Don't count the aggregate `opencode` runtime as another external connection.
- OpenCode external sources: use only already cached, matching-scope directory entries (`state==='connected'`), distinct by provider ID; never use model inventory or `configuredAuthless` as proof of login. Do not double-count a source represented by an equivalent top-level provider unless identity resolution is grounded; when ambiguous, show separate labeled counts, not a made-up grand total.
- When no matching complete directory is cached (including cold start, pending, error, stale revision, partial pages, changed project), show **known main count** explicitly labeled, and OpenCode count as **not checked**. Never show `0 connected` as a verified global total in these states. No persistent count-only cache or new IPC in V1.
- If both sources are available and complete, the UI may show two labeled counts (`CLI connected` / `OpenCode connected`), avoiding risky cross-family deduplication. No giant list/keys/model data in the summary. If UX absolutely demands one number, that is a *separate design decision* after correctness tests.
- After a successful connection/disconnection, rely on existing provider refresh + cache publish/invalidation; exact dashboard count is derived from the snapshots. A change of project must switch scope atomically; no previous project's status flash.
- An error/unknown/partial status must remain visibly unknown. Cached data is last-known, **not** permission to launch. Never relax `hasEffectiveProviderLaunchAuthority`.

## Planned edits (minimum safe slice)

### A. Navigation and page (renderer only)
1. Add a `providers` Settings section (not new `Tab.type`, URL router or global tab lifecycle). `DashboardProviderSummary` calls `openSettingsTab('providers')`.
2. For Settings → Providers mount the existing `CliStatusBanner` full provider UI (or narrowly extract the existing installed banner if that is safer after tests); preserve existing `ProviderRuntimeSettingsDialog`, `RuntimeProviderQuickConnect`, terminal, installation and onboarding components. Keep width close to dashboard (max-w-5xl).
3. Leave `Settings → Gateway providers`, team creation/launch provider links, and the Advanced section unchanged in the first slice. Remove duplicates only in a **separate** verified PR if actually required.
4. Add all UI strings in existing localization model (translations or safe existing localized keys); don't introduce English-only copy into 29-language UI. Don't show credential values in summary.

### B. Dashboard summary / counting
1. Replace full `<CliStatusBanner>` on Dashboard with a small component subscribing to `cliStatus`, pending flags, selected project and **existing in-memory provider directory cache**. No standalone IPC calls/effects for count.
2. Share a small, pure count/label selector and focused tests. Separate main CLI and OpenCode counts; distinguish unknown/partial, project and global. Avoid over-generalized provider registry/aggregator.
3. Preserve actionable critical errors and update/install entry point via the dedicated page. No new polling in summary.

### C. Provider page passive work
1. Thread `isActive` from `PaneTabSlot` → `SettingsView` → Providers view. Settings tabs stay mounted as designed; retain Providers pane state across section changes where needed, but do not keep passive polling alive.
2. Gate **only passive effects**: OpenCode connected-model catalog, quick directory/companion warmup, 10min full status refresh, Anthropic/Codex rate-limit polling/initial rate-limit reads. Keep global bootstrap unchanged.
3. Distinguish `pageVisible` from `operationInProgress`; do not turn off OAuth/credential-write hooks when hidden or awaiting completion. Avoid new global scheduler or event bus.
4. Preserve project-keyed cache, runtime revision invalidation, request generation safety, installed/failed/offline states and mid-flight cancellation semantics.

## Exact non-goals / guardrails

- No new DB, IPC channels, provider runtime changes, network API, auth changes, secrets handling changes, global store schema changes or migration; no changes to `PaneContent` keep-mounted behavior; no changes to readiness gates or running teams.
- No redesign of provider cards, no new settings system, no global polling manager, no automatic provider login / refresh solely to update number.
- No new extra layer for a simple count selector. No rewriting `CliStatusBanner` or `ProviderRuntimeSettingsDialog` for cleanliness.
- No forced model enumeration from dashboard. No reliance on live paid OAuth for automated tests.

## High-risk edge cases and mitigations

| Case | Required invariant / test |
| --- | --- |
| Cold launch: provider discovery deferred | Display 'checking/unknown' without false zero; no dashboard-triggered heavy directory/models |
| OpenCode not installed, V1/V2 mismatch, upgrade in progress | Preserve existing prompts and gates in full provider page |
| Partial OpenCode directory or 100-entry summary | No exact OpenCode count until completeness proven; never hide a partial behind exact total |
| Global vs project-only credentials | Scope lookup matches selected project; fallback only via already vetted cache helper; no cross-project leakage |
| Project changes during fetch | No stale previous-project count, credential, model, or authoritative evidence |
| Authentication succeeds/fails during tab switch | Operation persists; no hidden-tab cancellation or lost success/error |
| Close settings tab during active auth/credential write | Preserve existing explicit cancellation semantics and UI safety; add test; don't silently persist secrets |
| Runtime restarts / CLI version changes | Cache revision invalidated; no stale verified number |
| Offline, permission denied, timeout, auth revoked | Unknown/error state; no false connected claim |
| Multiple panes with dashboard/settings; repeated navigation | No duplicate polling or duplicate connections; re-use Settings tab per pane |
| Desktop vs web | Page respects Electron-only availability |
| Missing CLI and install/update actions | Existing full UI still accessible via Providers; essential warning on dashboard |
| Lang / narrow windows | Settings tab label and summary localized; no clipping |

## Verification / definition of done (merge gate)

- Focused pure selector tests: 0/auth/partial/transient/CLI duplicate/OpenCode duplicate/incomplete directory/project switching/revision invalidation.
- React tests: Dashboard summary makes **zero** directory/model/companion calls; configure deep-link works; Settings page same essential providers and controls; hidden page pauses polling but does not cancel active operations.
- Regression tests: existing `CliStatusVisibility`, `ProviderRuntimeSettingsDialog`, `RuntimeProviderManagementPanel`, `useOpenCodeDashboardStatus`, `useOpenCodeConnectedModelCatalog`, `PaneContent`.
- CI: workspace typecheck, lint, relevant renderer tests and any changed-file workflow; review threads resolved. Desktop packaged E2E on available Linux/Windows/macOS runners with connection and tab-switch mocks; visual screenshots and no real credentials.
- Compare before/after: startup time to first meaningful Dashboard UI, renderer CPU, IPC calls from passive page, mounted-hidden traffic. No made-up perf percentages.
- Draft stays unmerged until all relevant gates are green and OpenCode/Host overlap is reviewed.

## Review process

Four review rounds before implementation: (1) scope and reuse / unnecessary layers, (2) state machine + OAuth cancellation + keep-mounted, (3) data correctness + project isolation + verification authority, (4) frontend UX/a11y/i18n + CI/E2E risk. Repeat review on implementation. Record actual external agent/bot reviews separately from self-review; do not claim independent agents ran if unavailable.

## Size/risk envelope

Plan-only commit first. Expected renderer implementation approximately 500–900 changed/new LOC plus 200–400 LOC tests and localized keys; mechanical relocation may inflate diff. If implementation requires moving authentication/state machine, expanding provider runtime, or changing tab lifecycle, **stop scope expansion and revise plan**. Initial regression probability estimate: low-to-moderate only with focused E2E; not verified until tested.
