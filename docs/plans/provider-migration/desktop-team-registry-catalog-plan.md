# PR 982 — Desktop Team registry catalog pagination

Reviewed plan, 2026-11-28. R1 frontend_parity, R2 root and coordination_audit, R3 provider_team_parity approved the source-derived plan. At plan approval, no production edits or tests had been made. The plan was published in `533d955b28493cf9549a4e6b88684852df835628` before implementation; execution evidence follows below.

## Problem and preserved authority

`createTeamRegistryMethods` currently returns the whole `TeamRegistry.list(contextId)` value. Eighteen accepted Team descriptions of 60,000 characters already exceed the unchanged 1 MiB `team.registry.list` response limit. The resulting `HostOutput.priority_overflow` closes the captured connection, and Desktop discovery cannot receive the complete catalog.

`TeamRegistry.list` already authorizes the original context/writer, validates original journal records and additional catalog entries, preserves ordered `teams` and `held` arrays, and limits their COMBINED length to 256 with unique Team IDs and case-folded names. Preserve that owner/journal implementation. `DesktopBackendFeature.discoverBindings` awaits `CapturedTeamRegistry.list` before registering any dynamic handles; retain this publication boundary.

This is a private Desktop registry response. No MCP registry-list caller exists in current source. Process/group paging supplies the continuation pattern, but its 240 KiB page budget cannot be copied: one accepted registry row can exceed it.

## Bounded wire contract

Keep the exact legacy `{teams,held}` value, including empty arrays, when its compact UTF-8 size is at most 768 KiB and no cursor was supplied. Return the original object rather than reparsing/reordering its keys. On a paged response use:

```ts
{
  kind: 'team-registry-page';
  teams: TeamRegistryRecord[];
  held: TeamRegistryReceipt[];
  totalTeams: number;
  totalHeld: number;
  revision: string; // exact lowercase hex64
  nextCursor: string | null;
}
```

Add strict read-only transport schemas/types beside the existing registry contracts. Do not change the existing list/record/receipt/journal schemas or their limits. Each page has at least one complete row; totals are safe integers 0–256 with combined count 1–256. Both arrays may be empty independently, but not together in a page. The first empty catalog uses the legacy shape.

Use 768 KiB per returned value, with an internal 256-byte reserve for the signed cursor/header growth and a final exact page-byte check. This leaves 256 KiB below the existing ordinary 1 MiB Host frame, including in review-v1. No transport limits or method allowlists change.

The largest strict-schema record built by maximizing all optional fields and JSON-escaped code units is 532,672 compact bytes; a receipt with the longest allowed phase is 534,254 bytes. The earlier canonical-absolute-project-path variant was five bytes smaller. Both exceed 512 KiB and fit 768 KiB. Reproduce the bound using the ACTUAL schemas and demonstrate the actual JSON-RPC envelope through HostOutput in tests. Do not claim the per-record 2 MiB registry-file limit is a total catalog bound.

## Host paging and revision

Add one focused `pageTeamRegistryCatalog` helper. It receives the original typed catalog, captured factory key, context ID and optional cursor; it never reads/writes storage, changes a phase, repairs a record or caches a snapshot.

Flatten the ordering conceptually as all original `teams`, then all original `held`. Do not sort either array or move held entries into teams. A page may finish the Team portion and begin held receipts. Preserve every field, complete description, member, binding and held command/phase.

Calculate small-response size and the ordered revision incrementally over one compact row at a time. A SHA256 stream with an explicit `team-registry-catalog-v1` domain and exact `teams`/`held` array delimiters binds the complete ordered projection. Keep at most per-row byte sizes plus the current row/page strings; do not create an additional `JSON.stringify(catalog)` of the entire large catalog, a full encoded-row cache or a second whole-catalog copy. The owner already materializes its catalog; this change must not multiply that allocation. Row packing can reference the original objects and bounded slices.

Generate one unpredictable key per `createTeamRegistryMethods` factory. Its existing `select` closure already pins the original profile/owner and checks sealed state, the writer lease and exact supplied owner on EVERY page. Sign the continuation with protocol domain, this factory key, exact context ID, full revision and positive flattened offset. A different RPC/command correlation ID does not change the snapshot identity. There is no cached snapshot or lease extension.

Accept only a full-match cursor of the existing signed-offset form (`positive decimal offset`.`64 lowercase hex`). Validate syntax in the strict list payload BEFORE `registry.list` is called. Allow only `{contextId,cursor?}`; null/empty/extra keys remain invalid. After rereading all originals, reject an out-of-range offset, wrong signature, different context, changed content/order/phase or a cursor from another factory with the existing held outcome. Owner authorization still precedes the data read. An unchanged cursor may be retried against the same original catalog. A cold/new factory refuses old cursors; the caller can start a NEW explicit list, never silently resume it.

No `TeamHost.ts` change is required: the factory already belongs to exactly one captured registry/profile. Do not infer ownership from user-supplied data or add a replacement authority.

## Main assembly and publication

Keep the same `CapturedTeamRegistry` class. Capture the original owner scalars with the existing `captureOwnerBinding` before the first suspension, plus context and the original captured client. Compose a list-local guard that checks these original values and the existing availability/request guard before and after every page wait and immediately before returning. Compare the live owner against that snapshot; a caller-owned owner mutation must reject rather than redirect a later page.

The existing private `request` should snapshot its wire owner and client before awaiting `start()` and send through those snapshots, while the list-local guard detects any later owner/client drift. This removes its current read of mutable `this.options.owner` only AFTER start. Keep the existing control lane, diagnostics and Host lifecycle. No new state owner or global page map.

Use one original list correlation command ID, omit cursor on the first request, and send only the returned opaque cursor for each continuation. Retain the exact captured context/client; never reacquire the currently selected owner.

The collector accepts a legacy value only as the first and complete response; apply the same combined 256-row, context, Team ID, handle ID and case-folded-name checks to that response too. The legacy list schema alone limits each array separately. Handle uniqueness is an early refusal of a binding conflict that existing dynamic registration already rejects; TeamRegistry itself currently checks Team IDs and names. For pages it requires the same kind/revision/totals, strict next-cursor format, nonempty progress, no repeated cursor, and `nextOffset === accumulatedTeams + accumulatedHeld`. Reject a premature null cursor, continued cursor after the declared total, count overflow, duplicate Team IDs/handle IDs/case-folded names across both arrays, foreign record context, and invalid teams-before-held ordering. Once held rows start, every declared Team row must already have arrived. Reject a legacy/mixed response after partial pages.

Use a 256-page maximum: every successful page contains at least one original row and the existing combined catalog cap is 256. A 128-page limit would reject a legal catalog of 256 individually large records. This is a new endpoint-local finite bound, not a change to any existing process/group limit.

Return a fully parsed `{teams,held}` only after all totals and final currentness checks pass. On any error, discard the partial local result. Desktop then preserves its existing discovery failure behavior: continuation drift throws `BackendRoutingError('hold')`, while transport/unavailable handling keeps its existing separate mapping. No newly read partial handles are registered. Previously known handles and the existing handling of held entries remain unchanged. Held receipts must all survive assembly even though discovery registers only published Team records.

## Exact source manifest

1. `packages/legacy-agent-host/src/team-registry/contracts.ts` — add strict page/list-response transport schemas/types; existing storage contracts unchanged.
2. `packages/legacy-agent-host/src/team-registry/pageTeamRegistryCatalog.ts` — NEW focused incremental sizing/revision/cursor/packing helper.
3. `packages/legacy-agent-host/src/composition/createTeamCreationMethods.ts` — per-factory key, strict optional list cursor, invoke pager after the same original selector/list call. Create/lookup/launch methods unchanged.
4. `src/features/agent-backend/main/infrastructure/CapturedTeamRegistry.ts` — original wire-owner capture and bounded complete list assembly.

No registry journal, `TeamRegistry` owner, FileTeamRegistryStore, source history, record IDs, creation fingerprints, caps, native providers or renderer DTO changes.

Proposed focused test ownership:

- `packages/legacy-agent-host/tests/host-team-registry-pages.test.ts` — NEW real registry/handler/HostOutput and cursor/row-bound controls.
- `test/features/agent-backend/hostTeamRegistryPages.test.ts` — NEW actual Host pager→CapturedTeamRegistry plus minimal DesktopBackendFeature discovery integration and finite continuation/currentness negatives, each new file below 800 lines.

Retain existing `team-registry.test.ts`, stopped-import RPC, backendConnectionDiagnostics and DesktopBackendFeature controls without weakening assertions. Existing fixtures need no global budget increase or altered native timeout.

## Finite RED → GREEN verification

1. **First behavioral RED on original production:** create 18 accepted real registry Teams with 60,000-character descriptions; read through the existing handler and actual HostOutput. Assert unchanged 1 MiB frame admission and complete roundtrip. Original whole response must fail because of overflow, not a missing future export/test fixture error. Run the same fixture after the fix for default and review-v1, checking every emitted frame, no overflow and exact assembled original rows.
2. **Complete product parity:** mixed published/held/pending entries, project relation/display/color/members and descriptions survive byte-for-byte as values; original array order and phases unchanged. Small/empty catalog retains its original JSON shape. A single maximized legal row/receipt over 512 KiB still fits and round-trips without truncation. Validate the maximal fixture with actual contract parsers.
3. **Continuation authority:** changed description/order/member/held phase between pages, changed context, foreign supplied owner, new factory with same owner, altered signature, malformed/empty/null cursor and out-of-range offset refuse. Malformed cursors perform zero registry-list reads. Fresh re-read remains possible through an explicit new request; there is no auto retry of drift.
4. **Main no-partial boundary:** actual pager responses assemble both arrays before return; reject total/revision/kind/offset drift, duplicate rows/handles/names, repeated cursor, empty page, premature end, extra continuation and legacy-after-partial. A 257th page/declared total is refused. A 256-page lightweight valid control proves the bound without allocating 256 maximal descriptions.
5. **Original Main capture:** block `start()` and mutate the caller-owned owner object; prove zero dispatch under the changed owner. Block a continuation and revoke context/availability or replace the captured client; prove rejection and no partial catalog. Capture before the first await, check after each and before final return.
6. **Actual Desktop discovery:** minimal TEST Host using real registry handler/pager and the real CapturedHostClient/Feature receives the large catalog, registers every published binding once and leaves held records unregistered. A deterministic continuation mutation/revocation must register none of that attempted new catalog. Existing static/prior-owner behavior stays intact. No vendor/native account work.
7. **Routine verification after source freeze:** checked Host build; strict Host test types for affected fixtures; serial Node cohort; focused Main Vitest; canonical formatting/fast lint/source-size guard and strict Main types under the coordinated heavy slot. Do not run native providers or broaden tests without a concrete remaining risk.

## Review notes and estimate

Expected source change approximately 170–240 lines across 4 paths (one new helper), focused tests approximately 400–600 lines across 2 new files. Moderate implementation complexity: two ordered arrays and original-owner fencing are the only endpoint-specific parts. No new durable state, authority, resource cap or row transformation. Source-level confidence is high; actual boundary proof, strict typing and regression results are required before publication.

R1 prepared by frontend_parity. Root independently approved the exact plan after checking the combined 256 bound, publication barrier, legal large-row budget and incremental allocation. Coordination_audit completed R2 and provider_team_parity completed R3 after reading the plan and current source; both approved. Their clarifications are incorporated: validate the first legacy response as well, do not claim handle uniqueness is already a TeamRegistry invariant, and retain no full encoded-row cache. Those were source-level approvals. The execution record below reports the subsequent behavioral and compiler results separately.

## Executed validation — 2026-11-28

Implementation stayed within the four production paths and two new test paths. Source R2 by root and coordination_audit and R3 by provider_team_parity approved the actual candidate before standard formatting. Final production change is 233 net lines; the new tests are 482 and 462 lines. Every changed file remains below the unchanged 800-line limit. No registry journal, storage contract, owner, provider, native deadline or transport cap changed.

The first behavioral RED ran before production edits using the original handler imports and real TeamRegistry/FileTeamRegistryStore/namespace admission. Both ordinary and review-v1 HostOutput checks failed at the intended 1 MiB frame assertion. That baseline used the explicitly source-bound 0ebe runtime emit because earlier canonical build attempts had exited 137; it was not a typecheck or canonical build PASS. The corrected candidate subsequently completed the normal checked Host build successfully.

The final distinct behavioral scope is 16 Host tests and 73 Main tests (30 new + 20 existing create/diagnostics + 23 existing DesktopBackendFeature), all passing with zero skips. The final 8-test Host repeat and earlier 30-test Main repeat are not added to those counts. The actual Test Host process and real CapturedHostClient/DesktopBackendFeature paths prove complete registration and refusal without a partial prefix; they do not qualify Electron UI, vendor runtimes or real provider accounts.

The first Main run passed 28 cases and failed the two new Feature fixtures during setup: their private descriptor file had the default mode instead of required 0600. The fixture now writes 0600 and explicitly asserts ready state before discovery. Those failures are not product regression evidence. Strict fixture checks also required an explicit real HostHandlerContext and typeof-based cursor narrowing; those changes added no casts, suppression or relaxed assertions. Final reruns include those corrections.

| Check | Actual result | Log file (under `/tmp`) | SHA256 |
| --- | --- | --- | --- |
| Original Host RED | 2 failed / 2; both actual HostOutput overflow assertions | `pr982-registry-host-red.log` | `0462bb245507bac4a9f48f865483bf8368e431b1f76b784c9859edd39e689a40` |
| Canonical checked Host build | PASS, exit 0; includes task-change-ledger prebuild | `pr982-registry-host-build.log` | `d6efa218a38b23ad8285a933ae787d9bcd6d542c54df4d1e1c3e04bf0f5e0789` |
| Host registry and existing controls | 16 passed, 0 skipped; 3.49 s | `pr982-registry-host-green.log` | `c222c5bc48faabdbc7a0ac1f67ade07d19eb57ec8cd7289a84e70b1cf353ae3d` |
| Final new Host fixture | 8 passed, 0 skipped; 1.71 s; included in the 16 above | `pr982-registry-host-final.log` | `40f60ccd7e56420505dea40a4333da21a007d1d186da83f8d79319f27fbc35bb` |
| Final new Main fixture | 30 passed, 0 skipped; 7.67 s | `pr982-registry-main-final.log` | `c9fe985a00709e5a5934628f4a536274e1916b6b9142faa395fd0a13bc6a0fb9` |
| Existing Main create and diagnostics | 20 passed, 0 skipped | `pr982-registry-main-controls.log` | `55c5aaf090a1224e8587e9c7cd4c1de1bad2c980392bf94f0634cb775f1dae0b` |
| Existing DesktopBackendFeature | 23 passed, 0 skipped | `pr982-registry-desktop-controls.log` | `7cc9206fb9dc48358fdb4441b80d885bed0458f52f0123c124ed7e7307f237ba` |
| Strict Host tests | PASS, exit 0; 3 fixtures, unchanged inherited tsconfig.test options | `pr982-registry-host-types-v3.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Strict Main source/tests | PASS, exit 0; 5 entry files plus original ambient declarations | `pr982-registry-main-types.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Fast lint, 6 changed code paths | PASS, exit 0 | `pr982-registry-lint.log` | `8ffced8d83629e456197bc8271fa5dfca3595b8f63201e547f465fcb10dc92c8` |
| Final standard Prettier check | PASS, exit 0 | `pr982-registry-format-check.log` | `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20` |
| Source-size guard | PASS; 5,550 production files, 139 frozen exceptions, unchanged 800-line cap | `pr982-registry-size-guard.log` | `2758facd8e2c3d931caa5dd6d8716135b3791293f685f4ea173de5d8e1818c08` |

The exact scoped compiler projects are `/tmp/pr982-registry-host-types.json` and `/tmp/pr982-registry-main-types.json`. They inherit the original strict settings; the only override is explicit dependency type roots for the temporary config location. Standard formatter, fast lint and source-size checks were scoped/run normally; `git diff --check` also passed.

| Final code path | Lines | SHA256 |
| --- | --- | --- |
| `packages/legacy-agent-host/src/team-registry/contracts.ts` | 139 | `8101eed646e147eb5afb7312a03341fca127437584f242729f837787d1b24c0f` |
| `packages/legacy-agent-host/src/team-registry/pageTeamRegistryCatalog.ts` | 77 | `cb2253755545185f536620248370a3a04a7d6632693699539bf76896d322de81` |
| `packages/legacy-agent-host/src/composition/createTeamCreationMethods.ts` | 153 | `b4f12b69e0b440cd1104d7250cfe6b6f865d38fddf804174b104263539f9a280` |
| `src/features/agent-backend/main/infrastructure/CapturedTeamRegistry.ts` | 331 | `587e80708117f9b897e7e2a25086deefc7f4e907b5b4c3916d5dce1d4b00e918` |
| `packages/legacy-agent-host/tests/host-team-registry-pages.test.ts` | 482 | `993a9e88ef345a045bcd97134db797f8e26e1ffca83d078e45d1a18bbbe7fd9a` |
| `test/features/agent-backend/hostTeamRegistryPages.test.ts` | 462 | `b462543a66b46dd372946541d208c9084b4a1f5d03c16376c7cd0da5092de2a8` |

The full six-file recovery checkpoint, exact scoped configs and complete logs (including failed setup/type attempts) are retained in `/workspace/scratch/4f1e38400727/TEST-pr982-registry-catalog-recovery.json`. The execution record intentionally distinguishes the source-only reviews, actual behavioral runs and checked compiler results.
