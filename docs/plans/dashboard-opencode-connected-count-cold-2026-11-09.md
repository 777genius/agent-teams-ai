# Cold Dashboard OpenCode connected count — bounded read-only E2E (2026-11-09)

## Decision and actual gap

PRs #1124, #1144, #1149 and #1150 separated passive Dashboard display from full Settings management, and qualified the shipped `claude-multimodel` v0.0.158 + real OpenCode V1 1.18.31 on Linux/Windows using disposable synthetic DeepInfra credentials. **The positive desktop check in #1150 navigated to Settings → Providers before observing the count.** It does not prove a cold Dashboard displays an exact OpenCode count without visiting Settings.

The Dashboard selector uses *published* two-minute scoped connected-count evidence or complete authoritative directory caches, and intentionally starts no IPC. The global deferred runtime status is not an authoritative OpenCode connected-source inventory. A fresh cold launch can therefore remain Unknown.

The genuine CLI `runtime providers directory --summary --filter connected` already returns precise filtered identities without `models`. Earlier runner evidence shows a CLI startup cost of seconds even for a compact response; **small JSON does not guarantee a cheap subprocess**. Optimize for one bounded request, not a promise of zero CPU or instant status.

## Scope: smallest safe change

1. On **active Electron Dashboard** only, and only after a supported installed OpenCode runtime has a *settled ready identity*, ask for connected-source **summary** when the existing selector cannot produce a fresh exact count. Do not start any Dashboard catalog/model/status/account request.
2. Reuse existing `countCompleteDirectoryConnections`, scoped generation read tokens, runtime revision, `publishRuntimeProviderConnectedCount`, and `beginRuntimeProviderConnectedCountCheck`. Never infer zero from timeouts, partial pages, duplicate/error entries, stale data, or unsupported runtimes.
3. Reuse the main-process directory response cache / in-flight coalescing. One attempt per runtime+scope+generation until the two-minute evidence window expires; no retry loops, no recurring background poll, and no new IPC contract or credential handling. A running request may finish after tab switch but must never publish across runtime/scope/credential changes.
4. Leave `Settings → Providers`, QuickConnect, full models inventory, Add/Create/Launch/Resume preflight, saved auth, and permissions untouched. **Connected is display-only; never grants model or launch authority.**
5. On active page, respect the same selected project and inherited credentials as current scope count. Suppress requests for disabled multimodel, browser, missing/unqualified runtime or inactive Dashboard panes.

## Alternatives rejected

- `opencode auth list` alone: does not establish effective env/API-key/project/inherited connections and differs from Agent Teams runtime directory semantics.
- Reusing global `runtime status --summary --provider opencode`: status intentionally omits source connection inventory and model catalog.
- Moving full Settings hook to Dashboard or loading `models`: costly and high regression risk, violates the read-only Dashboard boundary.
- New persistent database, scheduler, service, IPC channel, feature flag, or auth cache: unnecessary.

## E2E contract (red before change, green after)

- Extend existing **real pinned runtime + real OpenCode V1** `--real-runtime` Electron scenario to assert exact connected count **before any click to Settings**; then navigate and reverify existing Settings count and Anthropic/Codex/OpenCode Manage panels. Never use live credentials or model inference.
- Native `clean`, `ambient`, `configured` real-runtime summary contracts and immutable connected-identity evidence from #1149/#1150 remain.
- Focused hook tests: cold count 0/1, source completeness, timeout/diagnostic failure, duplicate/partial >100, initial runtime unknown, unsupported version, in-flight reuse, no models, no retries, project switch, stale invalidation, runtime replacement, hidden pane and late responses.
- Existing Dashboard passive selector tests continue to prove *rendering* does not trigger model/full-directory/CLI status work; only the bounded count producer may use directory summary.
- Verify clean CI, CodeQL, Linux/Windows Electron, Windows packaged + Anthropic compatible E2E, and review before merge. Check actual receipts and images. Recheck merge commit on main.

## Risk and estimates

- Bounded count producer + presentation gate: ~65–150 production LOC.
- Regression/Electron evidence: ~140–280 test LOC.
- Estimated risk **3/10** if the scope/runtime/credential fencing stays unchanged; **7–8/10** if launch authority, status readiness or model discovery is modified. No such changes authorized.
- Meaningful performance claim only after real elapsed times and spawned command count are measured. The new single read may take seconds; no claim of instantaneous count.

## Review passes before implementation

1. Scope: no change to startup hydration and no full model/catalog request from Dashboard.
2. Correctness: no wrong-project, stale-credential or changed-runtime evidence can be published.
3. UX: unknown on failed/partial, checking only while actual request pending; full Settings remains accessible.
4. E2E: test the cold page *before* Settings navigation, not a later cached view.