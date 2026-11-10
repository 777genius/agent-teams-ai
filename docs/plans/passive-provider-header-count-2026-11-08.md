# Passive provider header / status consistency — scoped implementation plan (2026-11-08)

## Goal and boundaries

* Keep a compact Dashboard header reading already published connection observations. **No new Dashboard IPC, model, directory, companion or account polling**.
* Settings → Providers remains the sole detailed provider UI. Reuse one pure connection-status selector and compact count text on both surfaces.
* Remove the frozen Gemini from expected CLI status completeness. Do not alter launch readiness, provider authentication, credential storage or runtime behavior.
* Count OpenCode separately from CLI; never present a curated QuickConnect count as an exact all-provider total. If a valid current-scope count is absent, say unknown/last checked rather than guessing.
* On the **active Providers page only**, spike an existing `runtime providers directory --summary --filter connected` request. Validate its filter, pagination metadata, entry state, diagnostics, runtime revision and project scope. Reuse existing `--summary --filter all` as fallback. Do not replace the model/catalog path with filtered data: local authless providers and OpenCode-host sources are required there.
* Gate passive Codex polling when Settings is inactive, while keeping pending OAuth login, credential writes and account change listeners alive.

## Explicit correctness guards

1. No regression in project/global credential inheritance; no cross-project cached counts. On changed credentials/runtime, invalidate stale count evidence.
2. Scoped directory entries never overwrite full catalog; ignore out-of-order responses; no stale status becomes launch authority.
3. Filtered count probes are bounded to one active-page request per settled scope/refresh; failures retain only a **labelled** legacy/known observation, not an invented exact total.
4. A successful connector sign-in followed by hiding Settings remains observable; no implicit OAuth cancellation.
5. Preserve Usage/update/install actions; use same compact status count view in Dashboard and Settings.

## Verification

* Pure tests: frozen Gemini, CLI partials, connected-only filtered count, fallback, scope/revision/expiry, invalidation/logout, incomplete pagination.
* Component tests: zero added Dashboard IPC and shared text; hidden Settings preserves auth while stopping passive polling.
* Spike: fixture-backed filtered directory behavior, compare `summary connected` vs `summary all` and capture elapsed wall time without secrets. Real-user latency/performance cannot be claimed from fixtures.
* Full current-HEAD CI, CodeQL, real desktop and packaged Electron E2E on supported runners, screenshots and review. No merge until these are green; describe unavailable macOS/live-credential checks honestly.

## Change budget

Target ~450–950 production/test lines; avoid store schema migrations, new IPC, global schedulers and new backend services. If the connected-filter probe proves expensive on packaged runners, keep it inside active Settings only and report the measured result.
