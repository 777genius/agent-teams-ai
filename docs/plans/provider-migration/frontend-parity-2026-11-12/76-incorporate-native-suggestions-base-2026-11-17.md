# Plan 76 — incorporate the accepted native-suggestions base without losing parity fixes

Date: 2026-11-17. Status: prospective selection; no source afterimages, execution or runtime qualification authorized by this document alone.

## Purpose and exact anchors

Restore the existing PR1192 integration path after its target branch accepted PR1197. Preserve the accepted next-message suggestion feature and the already reviewed frontend-parity work together. This is ordinary base incorporation into the current delivery branch, not a new feature, PR merge, release or Stage2 activation.

- Current primary/delivery: `3fc8054864c320c0489782cf1ab829b06dceea73`, tree `49b5f8337248f272fcdc98b17885130e242ad339`.
- Actual live target: `301d00f46db3389ff6e3042afd04c5b064a26270`, tree `038c5405acb894fe5272df611f1e9b979f1b6745`.
- Common parent: `def734338f13bcc3209e78079a0cedbc48f05a5b`, tree `845f7a051367d7413412e3d7b83013590acd29a6`.
- Target branch: `feat/provider-host-frontend-parity-20261112`; primary: `fix/frontend-parity-completion-20261113`; delivery: `fix/frontend-parity-e2e-bounds-20261116`.

The direct target ref differs from PR1192's advertised historical `base.sha`. The exact live comparison is ahead737/behind1 with common parent def734. Complete recursive trees and the complete one-commit target delta establish 102 incoming paths: 44 additions, 58 modifications, no deletion or mode/type change; 67 base-only and 35 changed on both sides. The 250-commit/300-file head compare is capped and is not the scope inventory. Three complete observations of current3fc found zero Actions runs; this is not a queued run, execution result or proved event-delivery cause.

## Selected paths and preservation

The prospective R1 records every incoming path and its old/base/head Git identity. Incorporate all 102 incoming paths with the explicit resolutions below. Two paths retain the current head body exactly: `pnpm-lock.yaml` and `scripts/legacy-agent-host/desktop-proof-sources.ts`. The latter receives the incoming source closure through its existing supplementary import. The source commit therefore changes 100 incoming paths and the following eight necessary integration paths, for 108 selected paths in total:

1. New `packages/legacy-agent-host/src/composition/teamHostProfile.ts`.
2. New `src/features/agent-backend/main/infrastructure/CapturedHostNotificationBuffer.ts`.
3. New `src/features/agent-backend/main/composition/captureHostPromptSuggestions.ts`.
4. Existing `src/features/agent-backend/main/composition/recoverCapturedHost.ts`.
5. Existing `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts`.
6. Existing `test/features/agent-backend/capturedHostClient.test.ts`.
7. Existing `test/features/agent-backend/desktopBackendFeature.test.ts`.
8. New `test/features/agent-backend/recoverCapturedHost.test.ts`.

Preserve the other 66 base-only bodies exactly, including the two existing repository binary blobs by their original tree IDs. The sole base-only exception is the explicitly bounded workflow condition below. Preserve unrelated head leaves exactly. No path from the 64-path closed75cf-to-3fc change set occurs in the incoming102; this does not eliminate the cross-file integration obligations or authorize changes to those earlier fixes. The selected supplementary-roster addition is the only extra overlap with that earlier cut.

## Provider pins and native scope

Retain the current `v2-settled-fetch-c930d3c8` implementations and `host-logs-thinking-9423f600` session contracts, their exact archive bytes and current lock. Producer18a is the exact ancestor of c930 (complete8-commit/20-file comparison); packed APIs retain the prompt binding and the newer contracts add thinking events. Do not downgrade to18a/9ede, repack either dependency, adopt a new producer or transfer prior native qualifications. Add only the incoming `tests/team/*.test.ts` package-test operand; preserve all current exports and other script operands.

In `native-codex-team.native.ts`, preserve incoming `nativeSuggestions=true` archive SHA256 `26f8fc7083dbc470dd9d3a656e24873b73c78af3da3ffeea802a09a98f253e3c` and current false-branch SHA256 `24040cc82613d8472bbead0643bd6eb1a8132227019a825bf0815af396c56267`. Both branches remain genuine native candidates requiring their original explicit admissions. Do not substitute c930's digest into these historical candidate expectations. Keep the18a adopted-pin verifier and dedicated vendor workflow unchanged.

The incoming `native-prompt-suggestions-host.yml` would select the retained factory path and run genuine Claude CLI even with localhost inference. Select a job-level exclusion only for the conjunction: pull_request event, canonical repository, PR1192, both head/base repositories canonical, head ref `fix/frontend-parity-completion-20261113`, base ref `feat/provider-host-frontend-parity-20261112`. Do not test the stale base SHA or generalize the exclusion to Draft PRs. All other PR/manual conditions, steps, oracles and budgets remain byte-identical. This job and its preliminary binding-test step are SKIPPED for this exact PR, never PASS. Its regular binding test also remains in the normal Host test glob; that does not imply native qualification. Existing required finite/OpenCode gates remain unchanged. No genuine Claude/Codex discovery, version probe, installation or execution is selected.

The newer c930 deliberately refuses ambiguous/late Claude suggestion ownership. The incoming native test permits a suppressed warm-up suggestion and then expects a later one. Source API compatibility does not prove that behavioral case; neither its oracle nor the stronger ownership guard may be weakened. Its native qualification remains unselected.

## Concrete merge obligations

- Preserve current authority, readiness, original process origin, Windows custody and output wiring while adding the optional observational suggestion binding. Keep both `providerAuthorized` and `isOriginalHumanDirect` capabilities, strict original human-DM provenance, generation/operation matching and Boolean-only authorized runtime-read proof.
- Keep all current finite/emulated Desktop mode, fixture, observed Host/child ownership, failure projection and cleanup branches. Add incoming suggestion modes only behind their original explicit mode. Do not broaden ordinary finite/OpenCode admission or change any original deadline/oracle.
- Preserve unconditional mention-key handling, its guarded defaultPrevented return, current read-only/background behavior, and incoming last-priority native Tab/Escape handling with empty-editor/menu/chip/IME/modifier guards. No auto-send.
- Union the incoming verifier tsconfig operand with all four current Linux operands; no missing or duplicate path.
- Preserve settings default-off behavior, captured startup enablement, selected owner, original roster, unique matching handle, current feature state, scoped IPC/HTTP behavior and no automatic session restart.

## Bounded composition and 800-line rule

Six additive unions exceed the existing800-line rule. Resolve only the affected responsibility; do not change the baseline, pack lines, drop assertions or extract unrelated code.

- RuntimeTeamCoordinator: reuse the existing factory parameter type with a canonical multiline `Pick` of `createProvider`, `promptSuggestionsEnabled`, `onPromptSuggestion`; remove the now-unused provider-type import and place its controlled-provider comment on the existing factory property. Keep the factory forwarding and all current custody/authority fields.
- TeamHost: move its private profile schema/type into `teamHostProfile.ts`, including the accepted optional prompt flag; retain stable schema/type exports from TeamHost and identical validation. Other command schemas and lifecycle remain in place.
- CapturedHostClient: retain the first three constructor arguments `(profile, nativeOwner?, startupRemainingMs?)`; add a bounded fourth captured-prompt options argument. Capture the strict enabled Boolean and callback reference during construction, without retaining mutable caller options. Its internal callback receives `(raw, source: CapturedHostClient)` through a fresh raw-only wrapper bound to that instance; source is identity for the Main current-client check and never enters IPC. Extract only the existing bounded notification buffer/gap/take behavior together with the incoming synchronous auxiliary prompt branch into `CapturedHostNotificationBuffer.ts`. Preserve negotiated count/byte limits, original frame length, gap precedence, overflow/reset/dropped-frame semantics, callback exception isolation, ordinary buffering when no callback is configured, and prompt exclusion from the pull buffer when one is configured. Add no extra clear on failure/shutdown. Leave native ownership, request processing, deadlines, lifecycle and shutdown in the client.
- DesktopBackendFeature: put original owner/roster/handle validation and shared initial/recovery prompt composition in `captureHostPromptSuggestions.ts`. Capture enablement and output publisher once; bind each callback to the actual client being created. Old-client callbacks must fail the current-client check after replacement. Preserve the explicit recovery's Win32/descriptor/router/current guards, original custody/storageRoot, definition/source revalidation, remaining startup budget and guarded install. Do not add automatic initialization, recovery, retry, queue or new authority API.
- Desktop source roster: keep the800-line main file byte-identical to current. Append the incoming22-row native source array through the existing common supplementary roster; also pin the three new production helpers, the feature's public main entrypoint and the new recovery test. Preserve old common266 rows in relative order, all original1788 main entries in relative order, process27 and WindowsRetry46 bodies exactly; expected new common293/main1815 after deduplication. Keep the existing fast-lint141 scope and workflow unchanged; existing whole-workspace types/lint/test gates cover the new files.
- Desktop runtime pin helper: let the incoming `assertDesktopRuntimePins` own `fileDigest(pnpm)` before the existing realpath check and return the same digest for the receipt. Preserve all five format/equality assertions and await order. This removes one duplicate caller responsibility without line packing.

## Focused verification and delivery gates

Extend the current real-stdio client tests for captured enablement overriding profile environment, synchronous prompt delivery, exception isolation, no pull-buffer accumulation and unchanged bounded ordinary notifications. Extend the current Desktop feature tests for original owner/roster/handle matching and stale-client refusal. Add focused explicit-recovery tests proving the same captured preference/publisher reaches a newly bound callback while custody and the original remaining-budget function survive; rejected/stale recovery does not create or start a client. These tests may use the existing TEST subprocesses or small mocked ports in CI; no genuine provider is required. Keep all current assertions.

Before any source afterimages: root R1 and independent R2 select this complete prospective plan; publish exactly the plan and prospective R1/R2 as three new documents; independently verify their actual parent/tree/blob bodies. Then author the selected108 source paths, review the complete incoming and resolution diff, reconstruct the full tree, verify exact preserved leaves, package/lock identities, finite rosters and physical line caps, and close independent source R2. Local execution remains inert stdlib text/JSON/hash/patch work only; compilation, lint, tests, app and providers execute only in the selected CI.

Publish the source integration with the actual document head as first parent and exact301d as second parent, then immediately ordinary-CAS push the same delivery ref in the same operation sequence. This records base ancestry without merging a PR or rewriting history. Re-read the actual source commit, both parents, full tree, complete changed-path diff and changed bodies; close actual-source R2. Require fresh base/delivery/primary leases and the sole observer's useful-job guard before ordinary fast-forwarding primary. Resume original resulting-head CI observation at the existing minimum five-minute cadence. No manual dispatch, rerun, cancellation, PR toggle, Ready transition, force push, synthetic trigger commit or main write.

Plan40's source-writer A/B choice, other unselected genuine native scopes and all unresolved original runtime outcomes remain separate and unqualified. No source review, import of accepted base code or skipped job constitutes end-to-end PASS.
