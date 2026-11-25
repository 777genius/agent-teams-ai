# 60. Pause passive provider catalog readers while their management dialog is open

## Status and original failure boundary

This plan selects the exact four-path correction below, based on the retained original failure on primary `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b`. Root independently reviewed the actual caller, disable/cleanup and dialog boundaries before selecting it. No source afterimage, test execution or CI replay precedes publication and full readback of this plan. The proposed repair remains inside the existing Settings/Models journey; it does not change its physical actions, original 30-second default-inheritance wait, any native/readiness deadline, Host ownership or policy rules.

The retained original artifact is `desktop-v2-management-3be/archive-manifest.json`: 855266 bytes, SHA256 `5bd9ee234c46e5dd72a1df49d260c95775d40bccad6059a365254364697bac67`. Its original receipt is `desktop-v2-management-3be/extracted/TEST-desktop-backend-BXjMQv/desktop-backend-receipt.json`, SHA256 `08b1c038bbba05e93c9225208c2b287c85fac36b83d203dcbc97620bf3e5943d`, with exact head3be, clean source and 1788 before/after source pins. The receipt remains INCOMPLETE: Models is active, its refresh spinner remains visible, and the original inheritance card is absent at the deadline. The subsequent live-membership journey is not reached.

Plan50's durable Main observations enter capture at 19:38:13.164 and catalog at 13.174; preferences is never entered. The UI times out at 43.642. Main rejects at 43.935 after failure Quit has begun. Thus the terminal rejection is not evidence of the source of the preceding wait. One renderer view request remains current and its original finally clears loading; the previously fixed view-finally/currentness logic is not implicated by this receipt.

During that pending interval the Host observes directory, provider and directory metadata children. Those events do not contain request correlation. This proposal does not assign any particular child/PID to the view, status or background reader, and does not claim a measured performance improvement or a guaranteed new E2E PASS. It addresses a source-proven, avoidable source of queue pressure behind an open dialog.

## Exact actual owner and competing reads

`SettingsContent.tsx` blob `095ef27abf80bd1a1275f4a266aa3a74acdca9b5`, lines195–210, renders `CliStatusBanner` with `mode="settings"` and `isDashboardActive={isActive && activeSection === 'providers'}`. Opening its management dialog does not deactivate the underlying Providers page. The Advanced `CliStatusSection` has a different refresh owner and is not the actual path of this failure.

The actual Banner blob `e91be4b22d835f585e561902e3680e831e11c47e` owns `manageDialogOpen`. At lines1688–1695 it enables the connected-model catalog whenever the page's OpenCode status is enabled. At lines2065–2068 it passes `isDashboardActive` unchanged into `InstalledBanner`. Both remain active while the same Banner renders `ProviderRuntimeSettingsDialog` at lines2178–2200.

The dialog's `onProviderChanged` calls its original `refreshProviderStatus`, which delegates to the Banner's `useDashboardProviderRefresh`. That callback, in blob `8e6e603a9ace5cdf536f91f47a2503ca70336d50`, awaits the real `fetchCliProviderStatus('opencode', ...)` and then increments `providerQuickConnectRefreshKey` in its existing finally. This single key drives both the connected-model hook's `refreshRevision` and the Providers grid's `refreshKey`. The foreground status finishes before those background refreshes are requested, so the existing `statusChecking` gate does not prevent the subsequent overlap with the now-enabled Models tab.

The connected-model hook first reads directory summaries, then connected-source model catalogs sequentially. The Providers grid reads summary metadata; its optional connection-count probe may also read a connected summary. Main's existing captured client maps directory summaries to `catalog {}` and model/status reads to provider-mode catalog requests. The Host coordinator serializes catalog calls for one profile; a requested mode change can close the old metadata child before creating the new one. These are legitimate independent callers, not three recursive requests from one view.

The dialog's existing post-connect helper also performs its own original summary, external status and view/directory follow-ups. None of those foreground calls is removed, reordered or disabled by this proposal. The proposal introduces no cache oracle, request retry, extra polling, relaxed freshness predicate or change to Host currentness/close guards.

## Proposed production cut: two existing caller expressions

Only `src/renderer/components/dashboard/CliStatusBanner.tsx` changes behavior:

1. Change the existing connected-model hook argument from `enabled: openCodeDashboardStatus.enabled` to `enabled: openCodeDashboardStatus.enabled && !manageDialogOpen`.
2. Change the existing `InstalledBanner` argument from `isActive={isDashboardActive}` to `isActive={isDashboardActive && !manageDialogOpen}`.

No helper, public API, ref, effect, timer or state is added. Keep the existing status hook enabled expression unchanged. Keep `handleProviderRefresh`, the dialog's props, foreground status calls, the refresh-key owner and `handleManageDialogOpenChange` unchanged. The gate applies to the actual dialog-open state, not just its initial provider: the existing dialog can switch providers. The underlying page stays rendered and keeps its cached presentation. The same behavior applies when this Banner is used on Dashboard; it suspends the same obscured passive readers.

On OpenCode dialog close, the existing handler increments the refresh key once. Re-enabling the existing hooks then resumes their original read path. An inactive underlying page remains inactive after close. The original periodic status refresh remains unchanged; this proposal does not claim to remove every concurrent read. If it fires while the catalog is disabled, its existing catalog revision remains pending until re-enable.

The two pre-existing files are large: Banner has 2708 lines and the test below has 5510. This proposal adds no production lines and does not introduce an unrelated extraction to change that inherited baseline.

## Why the existing disable contract preserves authority

| Existing owner | Behavior when this input becomes false | Resume and limits |
| --- | --- | --- |
| `useOpenCodeConnectedModelCatalog` (`fc668050dda8061db170b4a030bdf9aa37850aff`) | Its existing effect cleanup marks only that subscriber cancelled, releases its status waiter and cancels its own `dashboard-connected-catalog:*` model groups. No next page/source read starts after the continuation check fails. | Same-scope models are retained. A disabled effect does not consume refresh revisions, so the original re-enable read observes the deferred refresh. Already-dispatched directory/Host operations can still finish. |
| Main `cancelModelLoad` in captured client (`bd7ed1336cdfba524f37c39dbe4e3f5c3ac48418`) | Aborts only controllers stored under the exact request-group key. Its signal is checked before/after the original model request and is not passed into the Host catalog request. | It neither closes the metadata Host nor aborts a foreign reader, credential operation, Runtime or prompt. This is subscriber delivery cancellation, not new native authority. |
| `useRuntimeProviderQuickConnect` (`ac1eaec22b5f91e48860e6de62ca15fef751fb57`) | Sets local loading false, invalidates its local continuation, releases its own count-check subscription and clears its existing start timer. No native cancellation is sent. | Entries remain cached. Refresh keys are consumed only when a read actually starts, so disabling before the original timer fires retains the request. Existing sequence/read-token checks reject obsolete results. |
| `useProviderConnectionSummary` (`b4b719097a3c12f18fe21107f476402019d201ee`) and count probe (`1b0204357c63ad15d2006b8533b417d19a7fc35e`) | `InstalledBanner.isActive` controls only the optional read opt-in. Store/cache projection and expiry presentation remain. Disabling the count probe prevents a new read/cooldown wake; an already-started shared read intentionally remains alive. | Existing generation tokens and display-only evidence policy remain; no readiness is promoted from cached inventory. |
| QuickConnect's Kiro/Cursor companions (`fbde17a9ae4288b26a5565a2038e6c91fe722328`) | Existing `enabled=false` stops warm status refresh and unsubscribes that component's progress listener. The mounted ref remains true; install/connect/action promises are not cancelled or disposed. | Existing re-enable effect resubscribes and refreshes status. This also pauses the obscured grid's companion warming; it does not change the foreground dialog or companion action API. |

`InstalledBanner` uses `isActive` only at the summary hook and `RuntimeProviderQuickConnect.enabled`; it does not pass this input into the management dialog. The exact companion behavior is disclosed because QuickConnect already shares its enabled input between directory reads and passive companion warming. No newly introduced authority or ownership boundary is hidden behind that prop.

## One meaningful regression in the existing actual-caller suite

Use `test/renderer/components/cli/CliStatusVisibility.test.ts`, original blob `f708343155d84f0abf1225b5f5f89ebfb784232f`. It already renders the real Banner, captures the real dialog callback, records connected-catalog hook inputs and QuickConnect refresh keys, and mocks the display-only count probe. Extend its existing QuickConnect mock capture with the boolean `enabled`; reuse the existing count-probe mock to observe its final argument. Preserve all original cases and mocks' existing behavior.

Add one focused test using the existing installed captured-Host fixture and the actual `runtime-manage-opencode` button:

1. Render the active Providers Banner and establish catalog, grid and count opt-in are enabled, revision0.
2. Click Manage through the existing DOM button and flush the existing lazy imports. Assert the dialog is open and usable while those three passive inputs become false; the original visible/cached provider data is still passed to the page/dialog.
3. Invoke the captured original `onRefreshProvider('opencode')` with a deferred `fetchCliProviderStatus` result. Assert the real status callback is called exactly once with its original options and no revision is consumed before settlement. Settle it true and assert the returned true and original one refresh-key increment, while all three passive readers remain disabled.
4. Invoke the original `onOpenChange(false)`. Assert the original close increment is retained and all three readers resume when the page is active. No explicit connected-catalog `refresh()` call, global status invalidation, install or native-login action is introduced by opening/closing.
5. Rerender the same page inactive and verify those inputs remain false; close/open state must not override the original page-visibility gate. Unmount using the existing cleanup.

This is direct caller wiring coverage, not a duplicate hook implementation. Existing hook suites already cover disabled waiting, subscriber cancellation, cached models retained while disabled, deferred grid refresh and stale-response refusal. Read-only review found those exact cases in `useOpenCodeConnectedModelCatalog.test.tsx` blob `5125c41e5a2132a060091c978335fdcb4108d404` and `useRuntimeProviderQuickConnect.test.ts` blob `129e512e33ae0494e92381f3d2667f2407fa3678`. They were not executed in this R1. No new test utility or framework is needed.

## Narrow validation closure and selection inventory

Prospective source inventory is four existing paths: the Banner, its existing test, `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts`, and `.github/workflows/host-emulated-acceptance.yml`. The latter two are validation-only: add the changed existing test to the common proof roster and append that one test path to the existing fast-lint command. The Banner is already present in both original receipt pin arrays, and the current full typed `src/renderer` lint already covers it. The existing test is absent from those original pins and from the explicit fast-lint operands. Preserve the Windows Retry subset, every previous roster entry and every existing command/operand order; rebind the workflow against the latest parent (known Plan55 source blob `3774658a0ab266686930fbe7e28ecb9e26711ebf`, 131 old explicit fast-lint operands). No new CI job, selector, dispatch, deadline or validation substitute is proposed.

`source-manifest.json` records every saved immutable read and independently checked Git blob, including whether the original runtime receipt individually pinned it. Several unchanged helper dependencies above are exact3be official source evidence but were not individual rows in the original receipt; no complete transitive pin closure or runtime execution of those branches is claimed. The proposed change adds no import or new dependency. If a later selection expands proof pinning, it must name that finite extra validation-only list before implementation, rather than silently broadening this four-path proposal.

The source-proven result of the proposed change is fewer newly admitted passive readers while a modal owns the user's provider task, with existing after-close recovery. Acceptance still requires the unchanged original Settings/Models and subsequent C8 journey to pass on the combined selected head. Prior partial receipts, cleanup-triggered response errors or source review do not satisfy that requirement.


## Current source binding and publication sequence

Preparation parent is `4900dcd71399b118b9dcc0a2e525280da9a06be0`; recheck the shared branch and preserve all incoming history at publication. These are the complete selected preimages:

| Path | Git blob |
| --- | --- |
| `src/renderer/components/dashboard/CliStatusBanner.tsx` | `e91be4b22d835f585e561902e3680e831e11c47e` |
| `test/renderer/components/cli/CliStatusVisibility.test.ts` | `f708343155d84f0abf1225b5f5f89ebfb784232f` |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `dba3426375f7bbd3db5f594f2fe68d58e3cc3e25` |
| `.github/workflows/host-emulated-acceptance.yml` | `3774658a0ab266686930fbe7e28ecb9e26711ebf` |

The original prospective R1 SHA256 is `dbc786484d24a12637639c875c6f0375f3e82fac125ad2f68713fcd9cc39584f`. Publish this selected document and its independent root R2 before creating source afterimages. Then inspect the exact four-path source diff independently, including full inverse preservation of all original tests, roster entries and workflow operands. The Banner must remain2708 physical lines; no size exception, extraction or unrelated cleanup is selected.

The selected regression exercises the real Banner caller and original callback ordering; mocked subscriber inputs do not qualify actual Host queue latency. Existing disabled-hook cases and the unchanged original Settings/Models plus C8 workflow remain necessary. A connected-catalog subscriber may retain its last loading projection while disabled; the original OpenCode management panel is disabled only by the dialog input or provider-status loading, not that display-only catalog flag. Foreground management remains independent.

After exact source readback, deliver only through the existing Draft PR1192 and original base. Root alone observes ordinary resulting-source CI at the agreed cadence. No local compiler/test/provider/GUI execution, manual rerun/dispatch/cancel, genuine Claude/Codex, main merge, release, default activation or Stage2 is selected. Preserve original30-second UI waits, native deadlines, freshness, custody and all cleanup/no-replay oracles. Incomplete or cancelled checks remain unqualified.
