# Provider startup status lifetime — 2026-11-10

## Goal and boundary

Prevent abandoned renderer initialization from scheduling new CLI provider status checks after its listener cleanup. This closes a lifecycle race during rapid remount/reload and avoids redundant native status work without changing what any provider means by **connected**, **ready**, or **authorized**.

**In scope:** `initializeNotificationListeners` asynchronous continuation after `fetchConfig` and after deferred CLI bootstrap, plus the already scheduled idle callback. Existing cancellation functions and store requests are reused.

**Out of scope:** New provider polling architecture, timeouts, provider auth semantics, model catalogs, OpenCode V2 Host (#1110), migrations, or a claim that process RSS/CPU improves without matched measurements.

## Existing behavior

The initializer disposes its timers and idle callback on cleanup. However, it awaits `fetchConfig` before creating its initial CLI timer; and, later, awaits `bootstrapCliStatus(... providerStatusMode: 'defer')` before registering its idle provider refresh. If cleanup happens during either await, its already-run cancellation has nothing to cancel and stale work can be registered afterwards.

## Minimal implementation

1. After `fetchConfig` resolves, abandon all further initialization if disposed.
2. After deferred `bootstrapCliStatus` resolves, abandon idle scheduling if disposed.
3. Recheck disposal in the idle callback before starting provider requests (covers queued callbacks and cleanup races).
4. Preserve the same startup delay, provider list, summary-only status paths, loading semantics, and original normal-start behavior. No additional state or API.

## Qualification

- [ ] Controlled fake-timer regression: dispose while config remains pending, resolve config, advance past the CLI timer; zero post-cleanup CLI bootstrap.
- [ ] Controlled fake-timer regression: dispose while CLI bootstrap remains pending, resolve bootstrap, advance past idle timeout; zero provider reads and OpenCode/Codex runtime checks.
- [ ] Positive check: ordinary active startup still schedules its intended status calls.
- [ ] TypeScript, lint, affected Vitest and full CI.
- [ ] Existing Linux/Windows real-runtime OpenCode V1, Anthropic packaged, and Windows V2 tests remain the independent desktop/runtime evidence; this change does not replace those checks.
- [ ] Review, merge if all relevant CI is green; confirm no regression on merge commit.

## Review passes

1. **Scope:** The fix uses existing `disposed` and cleanup; do not add state machine/feature flags.
2. **Safety:** Do not cancel an in-flight IPC request that belongs to another consumer; only prevent late scheduling by this disposed initializer.
3. **Tests:** Negative cases must fail against original implementation and exercise elapsed timers, not just a resolved promise.
4. **Architecture:** Store initialization remains the owner; provider slices, main IPC, and V1/V2 authority contracts stay untouched.

Related baseline instrumentation: #1161. Correct cold Dashboard OpenCode counts: #1159 and #1162.
