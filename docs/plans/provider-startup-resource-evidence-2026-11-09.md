# Provider startup resource evidence — measurement-first spike

Status: Draft, measurement only. Baseline: `5471a84624de`.

## Problem / hypotheses
On a normal launch, `initializeNotificationListeners` makes one deferred CLI bootstrap, then after 2–3 seconds starts incomplete Anthropic, Codex, OpenCode status checks and OpenCode/Codex runtime checks independently of the visible page. The new cold-Dashboard connection count must be lightweight and cannot replace launch-readiness verification. We have **not** yet measured a decrease in CPU, RAM or child processes; do not claim one.

## Bounded deliverable (phase A)
Capture an isolated, read-only OS process-resource record from the existing real-runtime Electron E2E, without touching renderer/product behavior:
1. Reuse `opencode-diagnostics`' disposable user profile, manifest launcher, verified birth identity and `ownedTree()`; do not sample unrelated host processes.
2. At the first confirmed visible Dashboard mount and again five seconds after that mount, capture total owned process count, RSS bytes and cumulative CPU time for *currently alive* owned processes. On both Windows and POSIX use OS-native process APIs, not CDP JS heap as a fake proxy for process RAM.
3. Label CLI-looking executable basenames as a **lower-bound** diagnostic, never an exact count of CLI invocations. Avoid process command lines, paths, credentials, stdout and raw environment in artifacts.
4. Save one sanitized JSON artifact per real-runtime Electron run. Include elapsed time between snapshots and a normalized CPU-time delta only for surviving process identities. Fail closed if process ownership or numeric parsing fails; record failure evidence without falsely claiming a successful measurement.
5. Exercise parser/counter pure tests (identity reuse, process churn, invalid values, Unix/Windows formats). Existing desktop Linux and Windows workflows provide genuine samples.

## Explicit non-goals
No production runtime/provider changes; no new general telemetry/daemon, API, dashboard state, or platform migrations. No removal of global status reads until duplicate/expensive work is demonstrated and functional requirements identified. No exact per-CLI subprocess count from generic OS process names. No claimed cold/warm *restart* comparison based on two points within one session; a warm-restart experiment would be separate.

## Interpretation and phase B decision gate
After real Linux/Windows runs, compare the one-session snapshots with recorded provider/runtime status milestones, identify which subprocesses are repeated or unnecessary, and propose at most one minimal scheduling/deduplication change. Assess startup, Settings, Create Team and Launch Team regressions. If evidence is insufficient, retain baseline and do not optimize blindly.

## Review rounds (source-grounded, not independent AI reviews)
1. **Ownership:** `ownedTree` already validates birth and ancestry; never query a PID not belonging to the test profile.
2. **Privacy:** Only numeric totals, phase and counters in JSON. Never serialize executable paths, process commands or auth JSON.
3. **Accuracy:** CPU time from running processes misses exited short-lived CLI children; call it a surviving-process lower-bound. RSS is a momentary sum, not peak RAM; report neither as app-wide lifetime consumption.
4. **Scope:** Keep only a tiny diagnostic script, targeted unit tests, and a hook in the existing real-runtime recipe and artifacts. No production code is justified yet.

## Merge gate
Exact HEAD type/lint/unit checks and real OpenCode Linux/Windows Electron E2E must pass. Review all bot comments and resolve only verified fixes. Merge only after sanitized artifacts and clear measurements exist; otherwise remain Draft.


### Readiness review correction
A successful CDP `inspect` call does not prove React mounted. The real-runtime recipe now requires a visible `dashboard-provider-summary` milestone before sampling. The second phase is deliberately named `post-renderer-delay`; it is a fixed five-second sample, **not** evidence that all deferred status reads started or completed. The one-session measurements cannot justify startup optimization without status/probe timing correlation. This is measurement-only and introduces no production instrumentation.
