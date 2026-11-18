# Real runtime → Electron IPC → provider header E2E (2026-11-08)

## Evidence gap
PR #1144's real desktop E2E used a CLI fixture. Merged PR #1149 proves the published, SHA256-pinned runtime v0.0.158 honors `--summary --filter connected` on Linux/Windows with a disposable saved test credential, but explicitly **does not prove Electron IPC**. Its independent full directory was incomplete/unavailable; do not claim full catalog or live OAuth passed.

## Minimal implementation
1. Reuse the existing process-owned `opencode-diagnostics-desktop.mjs` E2E harness and CDP ownership checks. Add an opt-in `seed-real` / `real-connected` read-only path. Do not modify the existing fixture scenarios or weaken process/profile isolation.
2. Use the **same staged pinned runtime and genuine native OpenCode V1 executable** already qualified in `.github/workflows/provider-real-runtime-e2e.yml`, with an isolated disposable HOME, private Windows ACL, synthetic non-production auth.json and local-only test provider. Never import real environment credentials.
3. Through actual Electron `window.electronAPI.runtimeProviderManagement.loadProviderDirectory`, verify `summary=true`, `filter=connected`, complete metadata and exactly one normalized connected provider; compare the visible compact header from `Settings → Providers`.
4. No model inference, credential mutations or launch actions. Sanitize evidence: platform, count, completion, bounded timing and screenshot with test-only data.
5. Extend only the existing real-runtime workflow to execute this new E2E on Linux/Windows. Retain its direct CLI contract and no-credentials proof.

## Acceptance
* Linux and Windows pinned-runtime **positive** real Electron IPC E2E SUCCESS, plus existing direct CLI tests.
* Existing fixture E2E, CI, CodeQL and review green, then merge and verify post-merge main.
* No additional Dashboard IPC or extra production fetch; no changes in provider auth or launch code.
* Do not claim real-user OAuth, live inference, full-catalog reconciliation or a genuinely >100-entry runtime were qualified. Those require separate credentials/runtime support. Keep these limitations visible.

## Change budget
About 200–450 test/workflow lines; Clean Architecture boundaries preserved, no new app services, IPC endpoints, feature flags or schedulers.
