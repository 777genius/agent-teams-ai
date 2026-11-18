# Real OpenCode V2 cold Dashboard source count E2E (2026-11-09)

Main base: `99a4a3c0ab7f97850d1b81beeab1aa76e5b63fe4`. Scope is **current shipped OpenCode V2 2.1.4** via actual app-managed install and V2 support archive under runtime 0.0.158, **not** Draft Host V2 #1110/#1106.

## Existing evidence and missing proof
- #1159 verified real native OpenCode V1 1.18.31, synthetic DeepInfra connected=1, on Linux/Windows *before* Settings. V2 was **not** part of that positive E2E.
- Product runtime V2 2.1.4 has qualified descriptor on Windows x64, real support installer and five-start Windows packaged flow `app-install-v2-repair` (cold, two warm, support repair/restart).
- Runtime V2's source inventory marks only **completed per-project/per-version private connection receipts** as connected. A fake V1 `auth.json` is not V2 evidence. Read-only V2 catalog carries `capabilities_pending` and does not establish model/team launch.
- Existing V2 packaged E2E qualifies native/support/cold-warm/cat logs, **but does not assert the cold Dashboard count before Settings**.

## Smallest safe implementation
1. Reuse the existing `run-packaged.mjs --runtime-setup app-install-v2-repair` recipe; no test-generated native manifests, keys or arbitrary custom binary.
2. Add a 120-second bounded positive UI assertion for **zero connected V2 sources** on a fresh, genuinely installed V2 2.1.4 + support, **before the first Settings navigation**. Confirm the displayed zero matches an independently checked `runtimeProviderManagement.loadProviderDirectory({ summary:true, filter:'connected' })` through actual Electron IPC. Check that directory is complete and no model invocation occurred. Save sanitized JSON/screenshot per phase.
3. Check warm-1, warm-2 and support repair/restart keep the expected count and never show stale V1 evidence; run without real accounts or inference. A clean profile has no completed V2 connection receipts, so the expected exact source connection count is **0**, not 1. Never fabricate completed credential receipts to make a positive test.
4. Keep a separate positive V2 connected count **unqualified** until an actual disposable V2 native connect produces an owner-written completed receipt, or a clearly labelled fixture-only contract test is added. Do not claim native V2 authentication or team launch from a zero count.
5. Add pure DOM/count guard tests (unknown, spinner, 1, duplicates, stale, nonnumeric). Do not change production/IPC/runtime contracts. V1 tests stay as-is.
6. Use a small reusable workflow wrapper to invoke the existing Windows packaged flow with `v2_support_repair=true` on this PR and future E2E changes, instead of copying 300 lines of packaging. Existing manually-dispatched V1/V2 choices remain unchanged.

## Risk and review gates
- No changes to Host Stage 1/2, login credentials, config migration, team readiness, models, permissions, or default V1 selection.
- Exact-head CI, CodeQL, unit and Windows x64 **packaged real V2 2.1.4 + support**; inspect true files in the receipts. V2 Linux/macOS positive installed-app counting is not proven by Windows E2E and must not be claimed.
- Source review 1: V1 fixture cannot be V2 auth proof; reject any faked V2 source.
- Source review 2: Dashboard UI must be asserted before any Settings/explicit directory probe populates cache.
- Source review 3: Retain per-version, per-project generation boundaries; an unknown or incomplete response cannot be called zero.
- Source review 4: No new package/service abstraction; reuse official pinned runtime and existing packaged harness.
- If the real V2 E2E fails to show an honest zero, fix only the proven regression; never relax readiness/permission checks.


## Scoped implementation

Reuse the existing app-installed, signed V2 support-repair packaged E2E. Prove visible zero on the active Dashboard before a direct provider-directory IPC read or the Settings panel, then compare independently with a strict complete `filter=connected` summary. The V2 catalog's `capabilities_pending` diagnostic is not authentication proof. Preserve V1-default workflow behavior and invoke the same packaged workflow through a dedicated V2 caller. Never seed V1 `auth.json` as V2 proof or infer launch readiness.
