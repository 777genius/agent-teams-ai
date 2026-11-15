# 31. Partial-owner availability in the existing Teams and global Tasks UI

Status: bounded implementation plan for independent source review. Root publication and explicit SOURCE GO precede source edits. No implementation, test PASS or acceptance result is asserted.

Proposed path: `docs/plans/provider-migration/frontend-parity-2026-11-12/31-partial-owner-aggregate-availability-2026-11-15.md`.

## 1. Source, authority and the concrete remaining gap

The source context is `25d3755eea7a318bba09217bc3f89fb3f96b4fa2`, tree `a672758397e1e3c8db8f04d1c21cb2ae21ce34de`, direct child of `ce7d65af958e197bafa7ac9ffc1842a6e56ea31a`. Preserve both incoming author commits and their complete history. The 34 existing implementation/TEST preimages below were checked against the complete ce7 GitHub tree (10,752 entries, not truncated); the two source/doc changes in 25d do not touch them. The existing teamSliceContextRace correction `45ae8e14a8c91c6b383610665e88ca26162c92c0` is now published and must remain.

The earlier scratch proposal was read and reviewed before the executor became unavailable. This is a fresh drafting of that same bounded contract, with the agreed four smaller helper bounds, exact source inventory, and one original B task mutation. It does not claim byte identity with the unavailable scratch Markdown. No local read/write, build or test was used to create this review blob.

The existing `30-windows-same-main-retry-integration-2026-11-15.md` (blob `60a7a6dc5de9e6de0a9c9d5c08d303064b4ce3a6`) remains unchanged. This proposal does not replace its P08 recovery authority.

Stage 1 P5 steps 1–2 in `stage-1-legacy-host.md` require retaining existing forms/boards and visibly identifying missing/offline targets without fork fallback. The feature README at lines 176–180 and 245–248 explicitly leaves partial-owner merged-list availability open; migration README at 1226–1227 records the same limitation. P10 sections 1, 3 and 4 require the original controls, a representative positive/failure path, preserved source/receipt/screenshot evidence, and correct qualification boundaries. That is the authority for this work; it does not authorize a new global state manager or replacement frontend.

Current `createHostTeamsApi.list()` and `getAllTasks()` serially read each captured handle. A failed snapshot rejects the combined read. This protects unknown counts and authority, but withholds healthy resources. The frozen ordinary frontend tolerates a failed Team task directory while returning healthy data (`TeamTaskReader` 843–865) and uses per-Team nullable config results (`TeamConfigReader` 466–488). The Host migration must retain healthy availability while making incompleteness explicit, not turn an error into an empty collection.

The Main prerequisite is real: `DesktopBackendFeature.discoverBindings` first reads the original creation registry and then every original owner's retirements. A single failure currently rejects discovery. `listBindings` also obtains display references through `ownerBinding`, which refuses a sealed owner. A renderer-only catch cannot repair that path. This plan therefore includes the smallest closed Main discovery change before exposing partial aggregate DTOs.

## 2. Deliverable and exclusions

The deliverable is one coherent cut: original Main discovery can describe a narrowly proven unavailable owner; original Teams and global Tasks lists retain healthy rows; incomplete/stale states and unknown counters are visible through the original views. A failed known Team remains an explicit unavailable resource and an owner whose registry could not be enumerated remains an explicit owner-level unknown. No fabricated TeamSummary or zero-valued replacement row is created.

There is no new manager, cache, registry, polling loop, retry coordinator, event stream, IPC channel, HTTP route, provider adapter, runtime profile, credential source, native helper or workflow/matrix. Existing legacy arrays remain valid. A selected Team read and all mutations continue to use their exact existing handle, authority and errors.

This closes only the named operational outage gap after meaningful original-path checks pass. It is not full P5/P10/Stage1 acceptance, a new liveness contract, native/provider execution proof, vendor authentication proof, backup of an incomplete owner, or another P08 recovery implementation.

## 3. Exact scope and preimages

There are 34 existing paths, including 11 existing TEST files, plus four new bounded files: 38 total. The 23 existing non-TEST paths are 21 application/shared/localization files and two existing proof scripts. No additional production entrypoint or source file is implicit in this table.

All physical line limits include imports, types, comments and blank lines. Preserve every existing source cap. Particularly tight unchanged caps are Team types 1839, shared API 1158, DesktopBackendFeature 800, teamSlice 5020 and TeamListView 1568. No baseline or architecture-rule increase is authorized. Existing code may be locally factored into the four specified helpers only where it belongs to this change.

| # | Existing path | Required preimage | Current lines / frozen bound | Minimal responsibility |
| --- | --- | --- | --- | --- |
| 1 | `src/shared/types/team.ts` | `20356fa1fc09393ba24b15ee399ab9aab31430e7` | 1816; cap 1839 | Shared aggregate envelope/unavailable-resource union; optional existing opaque owner reference on healthy Host Team/Task rows. |
| 2 | `src/shared/types/api.ts` | `2755fe3b7adf82cbb4da2f3172d2ec3c670b5e57` | 1097; cap 1158 | Only list/getAllTasks may return the explicit aggregate envelope or the existing legacy array. |
| 3 | `src/features/agent-backend/contracts/connections.ts` | `edd0cba7255617eb894c9d9529b45ffb34523179` | 22; existing cap unchanged | Optional closed unavailable-owner metadata on the existing connection snapshot. |
| 4 | `src/features/agent-backend/main/application/BackendOwnerRouter.ts` | `383f54cbca077b20c8746068732de6c7e054d854` | 575; existing cap unchanged | Read-only opaque display-reference projection for an already registered owner; dispatch/recovery guards remain unchanged. |
| 5 | `src/features/agent-backend/main/composition/DesktopBackendFeature.ts` | `0dc6aa5c1d998b5d07f3603f38852a4916e5938a` | 780; cap 800 | Original registry/retirement discovery and atomic publication; complete-only backup; use the bounded stateless helper. |
| 6 | `src/features/agent-backend/main/application/captureHostScheduleTarget.ts` | `c6ce98492db1bf73ccf7300a3dd0503cca32122a` | 67; existing cap unchanged | Refuse capture/restore of the exact unavailable scheduled target without rebinding or fallback. |
| 7 | `src/features/agent-backend/renderer/createHostTeamsApi.ts` | `c69c98f1ab47b5a118225fb30fa23e7df3d653f6` | 737; existing cap unchanged | Serial per-handle partial reads, complete publication fences, unchanged selected-Team errors. |
| 8 | `src/features/agent-backend/renderer/readHostPagedSnapshot.ts` | `c9f8edb5ed1f5b40d9f4f9d2ad89b27973224850` | 289; existing cap unchanged | Typed finite refusal that retains the original scope and mutation-fence assertion. |
| 9 | `src/renderer/store/slices/teamSlice.ts` | `21b56a1d6b767c420a03c5e02a6c6bf22055c171` | 4998; cap 5020 | Two availability arrays; atomic normalization/read publication under existing context/request guards. |
| 10 | `src/renderer/store/utils/stateResetHelpers.ts` | `e1eb36b7a59983b10be57fc7749254b5ac94eb52` | 150; existing cap unchanged | Reset the two availability arrays with the existing context reset. |
| 11 | `src/renderer/store/team/teamManagementNotices.ts` | `15daa2b024a06148decf9339ae3183c48b1fb369` | 118; existing cap unchanged | Do not erase retained Team-management notices merely because a resource was unavailable. |
| 12 | `src/renderer/store/team/teamGlobalTaskNotifications.ts` | `5767d885282cfd18e8dabf8a3f5d44d6fff21a8e` | 570; existing cap unchanged | Per-resource recovery seeding; preserve existing healthy notification and comment-cutoff behavior. |
| 13 | `src/renderer/components/team/TeamListView.tsx` | `12b47d7e2ca39e07e7101fb809e1a0d81c790a0c` | 1532; cap 1568 | Original Team list notice, qualified counts and explicit unknown liveness; reuse ordinary navigation/refresh. |
| 14 | `src/renderer/components/sidebar/GlobalTaskList.tsx` | `c671f720a7259ee04fc29f4fdd494b031209bf58` | 1278; cap 1719 | Original global Tasks notice, qualified counters and incomplete empty/filter states. |
| 15 | `src/renderer/components/team/TeamTaskStatusSummary.tsx` | `581d4297315c1f3f7bd2c330560cd07a444f9fcb` | 93; existing cap unchanged | Unknown task breakdown for affected resources rather than invented 0/0. |
| 16 | `src/renderer/utils/teamListStatus.ts` | `ca30f01316a29b9cf512f63bb889b118a0d4e7c9` | 90; existing cap unchanged | Opt-in unknown presentation for the aggregate Team list, preserving existing callers' default behavior. |
| 17 | `src/renderer/components/team/TeamStatusBadge.tsx` | `e8696562ab1b985e2ac5fdc10d8964bcb51c1184` | 67; existing cap unchanged | Render the explicit unknown status without calling it offline/running. |
| 18 | `src/renderer/components/team/TeamListHeader.tsx` | `11680dec43cd0050f24a2abc868eae0575e03f66` | 149; existing cap unchanged | Forward aggregate/liveness incompleteness to the existing count/filter presentation. |
| 19 | `src/renderer/components/team/TeamListFilterPopover.tsx` | `5994a693e72986f2bf63416651952132b4bab41f` | 205; existing cap unchanged | Qualify Running/Offline and other list counts without hiding the notice under filters. |
| 20 | `src/features/localization/renderer/locales/en/team.json` | `bd98bca54fc90236435cc3f1903ca1c0a16526eb` | 3415; existing cap unchanged | Only the English strings needed by the existing localization fallback for the new states. |
| 21 | `src/features/localization/renderer/resources.d.ts` | `361171dd90a00be5d4cc14bd4a570566cfd2cdf3` | 7053; existing cap unchanged | Regenerate the corresponding existing localization type declaration only. |
| 22 | `scripts/legacy-agent-host/desktop-owner-routing-ui-smoke.ts` | `f5ef718906a9181ebe1d9c518b145cb5e8d6165d` | 758; existing cap unchanged | One additional original B task in default-b and bounded original list/task availability checks in unavailable-a. |
| 23 | `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `edeb9f023df12e8b1c4afe486b80ac5c711770f0` | 230; existing cap unchanged | Append the exact missing proof inputs; preserve existing arrays, order and qualification. |
| 24 | `test/features/agent-backend/desktopBackendFeature.test.ts` | `beb9c42b55107dbb6370cdc0fdda9780af5a0f59` | Existing TEST file; no gate/cap change | Actual original two-owner Main/Host discovery after one original transport loss; backup and context negatives. |
| 25 | `test/features/agent-backend/backendOwnerRouter.test.ts` | `7b6d21c159a20f803f2f961fae7ea2f0705f9327` | Existing TEST file; no gate/cap change | Opaque display metadata cannot become dispatch authority; original owner/shutdown/recovery refusals. |
| 26 | `test/features/agent-backend/hostTeamsAggregateCapacity.test.ts` | `58dbe32fa8dc2704a3ee355cf02ff78e7bbf9014` | Existing TEST file; no gate/cap change | Healthy aggregate rows plus exact unavailable resource; retain sequential finite control capacity. |
| 27 | `test/features/agent-backend/hostTeamsRead.test.ts` | `11064732e0828d56ff3d385fd983492f31cec62a` | Existing TEST file; no gate/cap change | Typed negative-result fences, selected read behavior, fatal malformed/HOLD/context cases. |
| 28 | `test/features/agent-backend/hostDeletedTasks.test.ts` | `f9d5b9d361c141ff3ed3267f40eb84dcb382201a` | Existing TEST file; no gate/cap change | Deleted-task compatibility and original feed/schema/error behavior. |
| 29 | `test/renderer/store/teamSlice.test.ts` | `444f5ff672a0f5d6dfa8a72b968e46d54e862009` | Existing TEST file; no gate/cap change | Array/envelope normalization, atomic availability publication and reset. |
| 30 | `test/renderer/store/teamSliceContextRace.test.ts` | `45ae8e14a8c91c6b383610665e88ca26162c92c0` | Existing TEST file; no gate/cap change | Existing context/request/selection race guards apply equally to availability; preserve the published isElectronMode fixture correction. |
| 31 | `test/renderer/store/teamGlobalTaskNotifications.test.ts` | `572980ec3cfc3d944d24d82833c85f98cda29743` | Existing TEST file; no gate/cap change | Healthy notifications continue; unavailable/recovered resources do not become false new tasks. |
| 32 | `test/renderer/store/teamGlobalTaskNotifications.startup.test.ts` | `ad3f81d85c94b7b2da5d7b8063c2fe65ba0adcda` | Existing TEST file; no gate/cap change | Existing first-success and comment-cutoff recovery behavior remains resource-local. |
| 33 | `test/renderer/components/sidebar/GlobalTaskList.test.ts` | `f93a6c7f95f1b887b98b02012c236951832f4e87` | Existing TEST file; no gate/cap change | Visible incomplete states and qualified counters survive filters; healthy row still usable. |
| 34 | `test/renderer/utils/teamListStatus.test.ts` | `91d5bfa2422bd9b9a85dc515b990bd7803594502` | Existing TEST file; no gate/cap change | Opt-in unknown status is neither running nor offline; ordinary call sites retain old semantics. |

### Four new files and realistic bounds

| New file | Expected lines | Maximum inserted and total physical lines | Why it exists |
| --- | --- | --- | --- |
| `src/features/agent-backend/main/infrastructure/readCapturedConnectionAvailability.ts` | 100–130 | 150 | Extract the existing per-owner retirement read and its exact closed transport classification. It is stateless and takes original captured clients/guards; DesktopBackendFeature retains all existing maps, coalescing and retirement state. This keeps that 780-line owner below its frozen 800 cap without introducing a second owner. |
| `src/shared/utils/normalizeTeamAggregateRead.ts` | 30–50 | 60 | One pure normalizer for the legacy-array/explicit-envelope union plus one reused unavailable-resource membership predicate. Store, notices, notifications and views share that predicate instead of duplicating identity logic. It imports shared DTO types only and owns no state or API. |
| `src/renderer/components/team/TeamAggregateReadNotice.tsx` | 80–105 | 120 | One controlled, localized notice used by the existing Team list and global Tasks list. It receives finite metadata and existing Refresh/Open-Team callbacks; it creates no request/store/API ownership. |
| `scripts/legacy-agent-host/desktop-owner-routing-availability-ui.ts` | 110–145 | 160 | Bounded reads/screenshots through the existing original UI controls in the existing owner-routing epoch. It receives the already captured driver/identity/deadline; it cannot own an epoch, launch, retry, provider or cleanup. |

The path count is necessary to avoid presenting incomplete data as complete: the store and its reset/notices/notifications have different existing responsibilities; the two views share the new notice but retain their own filtering; the status summary, badge, header and filter popover each display derived facts. Removing their explicit unknown path would leave a visible false counter or Offline state. The new normalizer supplies the small shared membership logic; no fifth helper or general failure framework is planned.

## 4. Main discovery: closed operational failures only

### 4.1 Original captures and publication stay authoritative

Keep the existing descriptor, clients, router, dynamicHandles, registryReads coalescing and retiredHandles owners. Capture the current context, router and original client mapping before a read. Recheck the same request guard and captured mapping before classifying a refusal and immediately before publishing either healthy data or unavailable metadata.

Separate reading the creation registry from publishing its returned bindings. A transport failure from the original registry read may produce owner-level unavailable metadata; a failure while validating or registering returned records cannot be reclassified as an outage. Existing record parsing, context equality, immutable binding comparison, store collision protection and registerDynamic publication remain fatal.

Retirement reads remain one original read per relevant owner with the same original bounds. Reuse the same helper path; do not read a second snapshot to prove failure. Successfully read owners replace only their own retirement information. A failed owner's prior retired handles remain retained. Do not clear another owner's tombstone because this owner was unavailable, and do not silently resurrect a retired Team.

A discovery result may be ready with healthy bindings plus a finite `unavailableOwners` list. It must not assert that unknown owner enumeration contained zero Teams. The optional list is omitted for the complete case so existing complete connection snapshots retain their shape.

Within one original discovery call, retain the first typed refusal for each original owner, including its original code and outcome, and deduplicate publication by the exact captured opaque ownerResourceRef. A later registry/retirement refusal for that same owner must not overwrite the retained first refusal; in particular it cannot replace an unknown outcome with not-dispatched. This is local accumulation for that one discovery, not a persistent availability cache, a retry or a new owner. Recheck the original context/router/client guards before retaining the refusal and before publishing the deduplicated result.

### 4.2 Allowed partial versus fatal outcomes

| Seam | May become explicit partial metadata | Must remain fatal |
| --- | --- | --- |
| Original captured Main registry/retirement transport | Actual captured-client `transport-closed` or `shutting-down`; original router `unavailable` only when tied to this proven registered/sealed original owner and the enclosing Main/context remains current | Generic exception, timeout, capacity failure, indistinguishable HOLD, missing client registration, changed client/router/context, unknown owner, invalid descriptor/profile/protocol, malformed registry, binding conflict, authority or validation failure |
| Per-Team renderer snapshot | Closed original result code `busy`, `unavailable` or `shutting-down`, with the captured handle and original read-fence assertion | HOLD, invalid/forbidden/conflict, malformed/partial pages, invalid feed/revision, cross-context result, stale read order, mutation crossing the read, unknown thrown transport error |
| Legacy list/global-task read or entire connection discovery | None without exact finite affected-resource evidence | Reject the original aggregate; retain any prior rows visibly stale through existing error state. Never turn it into a partial empty legacy result or invent owner identities. |

Classify by the original typed result/error, not a message substring or raw error text. Global Main sealing/shutdown must not masquerade as one unavailable owner. A transport timeout alone does not prove owner loss. If the error cannot be distinguished under these rules, the old refusal remains.

### 4.3 Display metadata does not grant dispatch authority

Use the existing opaque `ownerResourceRef` and existing handle-based selection identity for display and membership. Add only a narrow Router metadata projection that can identify an already registered owner even if that owner is sealed, while still enforcing the original global admission guard. It returns the opaque display reference, not the private binding, profile, storage root, client or native custody.

Do not relax `requireOwner`, `ownerBinding`, `resolveOwner`, `startOwner`, `authorizeHandle`, generation checks, recover() or dispatch. An unavailable owner's original handle remains unavailable; another owner, including the current default, cannot serve it.

Complete-only consumers must stay complete. `captureBackup` refuses an incomplete discovered set. Schedule capture/restore refuses the exact unavailable target, with its retained context/owner/team references, and never rebinds it. A healthy schedule target can remain independently available only when its original binding and all existing guards are still proven. Existing current-source P08 capture/start/retry and shutdown state machines are unchanged.

## 5. DTO, adapter and read-fence contract

### 5.1 Minimal explicit result envelope

In the existing shared Team type owner, define one aggregate result with `items` and `unavailable`. Preserve this exact closed unavailable-resource DTO:

```ts
export type TeamReadUnavailable = {
  code: 'busy' | 'unavailable' | 'shutting-down';
  outcome: 'not-dispatched' | 'rejected' | 'unknown';
} & (
  | { kind: 'team'; teamName: string; displayName: string }
  | { kind: 'owner'; ownerResourceRef: string }
);

export interface TeamAggregateRead<T> {
  items: T[];
  unavailable: TeamReadUnavailable[];
}
export type TeamAggregateReadResult<T> = T[] | TeamAggregateRead<T>;
```

The Team arm uses the existing owner-qualified selection key and public label. It has no optional ownerResourceRef. The owner arm uses the existing opaque reference; Team count and membership beyond retained known bindings remain unknown. Carry the original typed outcome rather than synthesizing a more favorable one. The common DTO does not enlarge the per-seam partial-code allowances in section 4: Main discovery still accepts only its separately proven owner transport refusals.

The discriminant is explicit, not inferred from optional fields. There is one type owner and one normalization implementation. There is no raw exception, stack, environment, path, provider session or new authority token in the public result.

Only `TeamsAPI.list` and `TeamsAPI.getAllTasks` widen to the union of the existing array and the explicit envelope. Preserve the existing complete Host array result; return the explicit envelope only when the Host result has unavailable resources. Legacy Main/HTTP implementations continue returning arrays; normalize either complete array or explicit partial envelope at the two ordinary store read call sites. The Host adapter's existing legacy delegation must explicitly reject an unexpected legacy envelope rather than discard its unavailable metadata. Do not change unrelated IPC/HTTP implementations or attach metadata to arrays.

Healthy Host TeamSummary and GlobalTask rows may carry the already public optional ownerResourceRef so owner-level incompleteness can be matched exactly for counts and recovery seeding. It is not a dispatch selector and must not be accepted in place of the original handle. An affected Team receives no fake healthy summary row.

### 5.2 Partial publication retains both success and refusal fences

The existing `readHostPagedSnapshot` captures the handle's mutation fence before the first await. Today it throws on a negative result before calling that fence. Introduce a local typed finite refusal carrying the same captured assertion: check the scope and that original mutation fence before classifying the code, and retain that assertion for the aggregate's final publication.

The adapter collects both healthy read assertions and classified refusal assertions. Recheck all of them and the original current-context guard after all original serial handle reads and immediately before returning the complete array or partial envelope. A mutation or context/read-order change during a failed read remains fatal. No failure may bypass the fence just because no pages were returned.

Keep all original success page assembly, MAX_PAGES bounds, feed/revision equality, read-order publication checks, duplicate-part rejection and task/message completeness checks. Same-owner handles are attempted independently in the existing serial loop; one failed Team does not suppress its healthy sibling. No parallel fanout, mutation retry, second owner lookup or additional default budget is introduced.

Selected-Team reads still reject the original error and keep the exact messages relied on by existing recovery UI, including `Host team read unavailable` and `Host teams unavailable`. The new typed refusal extends the existing read error boundary; it must not swallow arbitrary exceptions.

## 6. Store, notices and notifications

Add only `teamsUnavailable` and `globalTasksUnavailable` to the existing store slice, with their initial/reset values in the existing reset helper. Publish rows and matching availability atomically under the current request ID, context epoch, selection/read guards and structural-sharing rules. A late response cannot replace either side of that pair. Preserve the incoming race fixture's explicit Electron mode.

On a fatal refresh, the existing error remains visible and prior retained rows are explicitly stale. A stale last result is not complete merely because its prior unavailable list was empty. A later complete read clears the matching availability state under the same original guards.

Team-management notice reconciliation must not interpret non-arrival from an unavailable resource as deletion. Use the shared exact membership predicate and retained prior Team owner metadata where necessary; preserve the existing newer-notice identity check, bounded notice count and actual trash tombstones.

Global task notifications remain healthy-resource local. A recovered resource's first accepted rows seed existing notification baselines rather than emitting all historical Tasks as newly created. Preserve the existing first-success behavior and comment context/cutoff rules for that resource, while healthy resources continue to emit their original new/completed/comment notifications. Do not globally suppress healthy notifications during another owner's outage or reset the whole notification history.

The existing maps/notification sets remain their owners; no recovery cache, per-owner scheduler or new persistent state is introduced. The shared membership predicate handles exact Team or opaque owner matching consistently across store, notices, notifications and presentation.

## 7. Original UI semantics and every derived count

The shared controlled notice is placed outside project/search/status/trash/pinned/time filters in the existing Teams and global Tasks views. Unknown membership can belong outside the selected filter, so filtering visible healthy rows cannot make the incompleteness notice disappear. A known failed Team remains named/navigable through its original selection when possible. An owner-level failure is shown as an unavailable owner with unknown Team count; do not invent Team names or render its opaque identity as a filesystem path.

Reuse the original Refresh action. An Open-Team action only performs existing navigation to the retained Team; the original selected-Team read and P08 Retry action decide whether recovery is available. Do not place a second recovery implementation in this notice.

Audit these exact existing presentations as one atomic part of the change:

| Presentation | Required honest state |
| --- | --- |
| Team list total, project/group/trash/pinned counts and empty groups | Qualify as loaded/available counts when the Team collection is incomplete; do not imply the hidden owner contains zero Teams. |
| Healthy Team member count and summary fields | Keep facts from the successful original Team snapshot. Do not replace them with global zeros or an owner-wide failure guess. |
| Per-Team task breakdown in TeamTaskStatusSummary | If its task resource/owner is unavailable or the task aggregate is stale, show unknown/incomplete breakdown; never show an invented 0/0. A separate successful Team snapshot's taskCount remains a fact from that snapshot. |
| Global Tasks total, status/count tabs, project/Team groups, time and pinned/trash filters | Qualify counts from loaded rows; display incompleteness even when no affected identity can be placed in the chosen filter. |
| No Tasks / No matches / empty list | These cannot be the only state while results are partial or stale. Retain an explicit incomplete/stale message and original Refresh. |
| Team runtime status, Running/Offline counters and quick actions | A failed or not-yet-known alive-list read is unknown, not an inferred Offline/Running result. Do not enable quick Launch/Stop on an absence guess. |

Keep the liveness change bounded to aggregate Team-list presentation. The existing aliveList API and its other original direct callers are not rewritten. TeamListView retains a current-scope success/known flag for its original alive-list read; the status helper accepts an opt-in unknown input and preserves existing behavior for callers that do not pass it. Known independent provisioning/activity evidence keeps its existing meaning; no missing observation is converted into a running fact. `isTeamListStatusRunning` excludes the new unknown state. TeamStatusBadge, TeamListHeader and TeamListFilterPopover receive enough state to keep their own labels and popover counters honest.

The independent deleted-task feed retains its original error policy; this plan does not introduce a second partial-outage contract for that feed. The Team/task incompleteness notice remains visible when the original deleted filter is active.

Add only the required localized English strings and regenerate the existing resource declaration with the repository's original `pnpm i18n:types` command (`i18next-cli types --quiet`). The current keys do not fully express partial-owner and loaded-count states; retain these two scoped paths. Generation remains a required real execution step when the executor is available: do not hand-edit its output, assume a prebuild/typecheck hook generates it, or report generation complete now. Preserve current fallback behavior; no translation-system rewrite, workflow change or mass locale churn.

## 8. Meaningful existing regressions

Use the eleven existing TEST files in the table. No new suite, fake production response adapter, provider execution or native process gate is needed.

1. **Actual Main prerequisite:** in desktopBackendFeature.test.ts use the original finite two-owner subprocess fixture and actual DesktopBackendFeature/getConnections path. Cause one original captured transport to close, keep the other original owner healthy, and prove healthy discovery plus explicit unavailable-owner metadata. Exercise actual registry/retirement discovery, not only a stubbed renderer result. Check that a lost registry enumeration remains owner-level unknown, unrelated retained bindings/retirements are preserved, and no default-owner dispatch occurs. Also reject stale context, malformed registry/binding data and incomplete backup. The new case name is `keeps healthy owner discovery available after original transport loss`.
2. **Original Router authority:** extend backendOwnerRouter's existing owner/sealed/shutdown cases to prove the display reference can be read without opening dispatch or P08 recovery. Missing/foreign owners, global seal and binding mismatch keep their old refusals.
3. **Aggregate finite capacity:** preserve every existing 40-Team serial/capacity assertion and the existing HOLD-negative body byte-for-byte. The widened public result union permits only added `Array.isArray` narrowing guards before existing complete-array assertions; each guard must reject an unexpected envelope, with no cast or replacement response adapter. Removing those guards must restore the original complete-array test bodies. HOLD remains fatal; that negative is not converted into a partial-success assertion. Add separate cases for the allowed unavailable and busy results, checking healthy aggregate rows, the exact closed unavailable-resource DTO with original outcome, and independently attempted healthy siblings on the same original owner. Retain the original serial request/capacity bounds and no-fallback assertions; the added cases must not replace or weaken either original case.
4. **Read fences and fatal schema:** make a failed snapshot overlap a mutation/read-order/context change; it must still reject at original publication. Cover only the allowed negative codes as partial. HOLD/malformed pages/feed conflict and legacy or unqualified discovery errors remain fatal. Existing selected-Team and deleted-task expectations remain.
5. **Store atomicity:** verify array compatibility, partial envelope publication and reset, late context/request refusal for both rows and metadata, unchanged retained selection, and recovery clear. No stale unavailable state may cross a context switch.
6. **Notices/notifications:** prove an unavailable resource does not erase a pending original notice, recovery does not replay historical task creation, healthy-resource notifications still work, and the original comment startup/cutoff behavior survives.
7. **Presentation:** existing GlobalTaskList and teamListStatus cases cover visible filtered incompleteness, healthy row navigation, qualified counters/empty states, unknown liveness and unchanged ordinary status defaults. The original Electron journey below covers the composed Team-list UI.

Do not alter global test setup, timeout, exclusions, retry count or compiler strictness to make these pass. A fixture refusal may not be asserted as healthy completion. If implementation exposes another required path outside the table or cannot stay within its cap, return to source review and amend the plan before editing it.

## 9. Existing original Electron owner-routing proof

Extend the existing default-b → unavailable-a → rollback-a journey in desktop-owner-routing-ui-smoke.ts. Keep its actual original A/B bindings, captured app/process ownership, source leases, profile withholding/restoration fault, no-fallback checks and original nonrenewable scenario deadline. No new mode, job, runner or matrix is added.

The current default-b phase creates B but does not create a B Task; its first B Task is later in rollback-a. To prove a healthy B Task during unavailable-a, this plan explicitly adds exactly one original UI mutation: after B's original publication and the existing no-A-effect comparison, invoke the existing `createTask` helper once for the returned original B handle. Retain the returned Task and exactly one completed command receipt. Do not repeat B Create or substitute a file edit/direct mutation for this task.

During unavailable-a, use the new bounded helper to open the original Teams list and global Tasks UI, assert that B's exact original Team and that exact Task remain visible/navigable, and assert the explicit A/owner unavailability notice and honest counts. Apply a nonmatching existing filter and require the notice to remain. Capture the meaningful actual frames and read back their exact current source/identity facts. This helper must reuse the epoch's original assertCurrent and remaining deadline; it cannot reset a phase clock or retry a mutation.

Preserve the original unavailable-A task mutation refusal and its exact no-A/no-B effect comparisons; preserve all original receipt bytes and rollback checks. The added successful B Task has its own Task/receipt evidence and does not replace an old action/count. Keep the original one live Host in unavailable-a, two in other epochs, no native/provider children, 12-minute overall limit, existing 45-minute job limit, strict one-CDP listener, original Quit and process/profile/source cleanup. An unknown cleanup remains INCOMPLETE.

The withheld profile is the existing TEST failure input. Partial acceptance depends on the original captured transport's typed outcome under section 4, never on matching its file-error text or allowing arbitrary HOLD. If that original failure does not reach an allowed typed transport state, stop and report the exact boundary rather than reclassifying it speculatively.

No vendor Claude/Codex/OpenCode binary or version command is executed by this proof. The original offline finite Host composition remains. This is an original UI availability proof only, not native execution or P08 replacement qualification.

## 10. Closed source roster

Append missing paths only in desktop-proof-supplementary-sources.ts; preserve every prior array, entry order and the existing final union. Do not add filesystem discovery or infer a proof from a source pin.

A fresh exact GitHub union of desktop-proof-sources, supplementary, integrated and management rosters confirms the original 22 planned manual source-pin additions below. The generated localization declaration is deliberately excluded from this explicit manual roster, as in the prior proposal; it is not a twenty-third manual pin. It must be regenerated by the original command and reviewed as generated output, not hand-written while execution is unavailable.

- `src/features/agent-backend/renderer/readHostPagedSnapshot.ts`
- `src/renderer/store/utils/stateResetHelpers.ts`
- `src/renderer/store/team/teamManagementNotices.ts`
- `src/renderer/store/team/teamGlobalTaskNotifications.ts`
- `src/renderer/components/sidebar/GlobalTaskList.tsx`
- `src/renderer/components/team/TeamTaskStatusSummary.tsx`
- `src/renderer/utils/teamListStatus.ts`
- `src/renderer/components/team/TeamStatusBadge.tsx`
- `src/renderer/components/team/TeamListHeader.tsx`
- `src/renderer/components/team/TeamListFilterPopover.tsx`
- `src/features/localization/renderer/locales/en/team.json`
- `test/features/agent-backend/hostTeamsAggregateCapacity.test.ts`
- `test/features/agent-backend/hostTeamsRead.test.ts`
- `test/renderer/store/teamSliceContextRace.test.ts`
- `test/renderer/store/teamGlobalTaskNotifications.test.ts`
- `test/renderer/store/teamGlobalTaskNotifications.startup.test.ts`
- `test/renderer/components/sidebar/GlobalTaskList.test.ts`
- `test/renderer/utils/teamListStatus.test.ts`
- `src/features/agent-backend/main/infrastructure/readCapturedConnectionAvailability.ts`
- `src/shared/utils/normalizeTeamAggregateRead.ts`
- `src/renderer/components/team/TeamAggregateReadNotice.tsx`
- `scripts/legacy-agent-host/desktop-owner-routing-availability-ui.ts`

All other manually pinned touched paths are already present in the existing source closure; the generated declaration keeps the explicit exception above. Actual before/after source/artifact hashes, receipt completion and cleanup still decide acceptance. This proposal does not label any downloaded artifact verified; no new artifact was downloaded for it.

## 11. Minimal validation and runtime distinction

The repository/CI declaration in .node-version is Node26.12.1. The last observed available local system runtime was Node24.22.1, not 26.12.1. Prior bounded local checks used the separate captured Node24.21.0 and retain that limited qualification. The existing safe CI arrangement uses its declared Node26.12 worker and captured Node24.21 Host fixture. A declaration is not evidence that a runtime is installed in the unavailable workspace.

The concrete new Main regression can be selected through the existing unmodified root Vitest configuration. It requires the matching declared worker runtime already available (or the existing CI worker), the repository's normal dependencies and its original current MCP/Host build prerequisites. Do not install a new runtime or repeatedly launch broad gates merely to make this draft appear tested.

```sh
AGENT_BACKEND_TEST_NODE=/workspace/scratch/5c17297e690d/agent-teams-ai/resources/legacy-agent-host/node/v24.21.0/linux-x64/node \
  pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 \
  test/features/agent-backend/desktopBackendFeature.test.ts \
  -t 'keeps healthy owner discovery available after original transport loss'
```

The environment variable selects the already captured finite Host runtime, not the Vitest worker. On the existing CI worker use its original corresponding verified staged path; do not invent a local installation. The existing file uses the Node test environment, the root setup and the original 15-second test timeout; its finite fixture retains startup 3000 ms/request 1000 ms/shutdown 300 ms. No provider executable is part of this case.

After the coherent source cut, run the eleven affected existing files with the same original Vitest config and finite fixture prerequisites; schedule execution serially as necessary for the actual environment. Use the existing relevant compiler projects, targeted fast/typed lint and unchanged source-size/provisioning guards. Concrete existing commands include `pnpm typecheck`, `pnpm typecheck:legacy-host-scripts`, `pnpm lint:fast:files -- <changed-files>`, `pnpm guard:source-file-size`, and `pnpm guard:team-provisioning-architecture`; their current scripts/configurations are the authority. Generate localization declarations via existing `pnpm i18n:types` and inspect the bounded diff.

The original affected Electron owner-routing lane must run on the final source and pass with screenshots, receipts and cleanup independently reviewed. Existing required exact-source repository gates remain required. Reuse valid unchanged checks; broaden a rerun only for a concrete remaining risk or required gate. OOM, cancellation, missing execution and source-only review are not PASS.

## 12. Review, sequencing and acceptance boundary

Root publishes the reviewed plan before source work. Assign separate writers only where ownership is disjoint; Main discovery/DTO/renderer consumption must form one coherent reviewed contract. Do not publish a halfway state that reports healthy rows as complete while unknown resources/counts are hidden.

R1 reviews the exact scope, closed partial/fatal mapping, Main prerequisite and no-authority metadata. R2 inspects source preimages, preservation of all original guards/fences/notifications and unchanged cleanup/assertions. The four helper bounds and all 38 path boundaries are checked against actual diffs. A source-only GO authorizes implementation/review; it does not close the operational UI gap.

Accept the named gap only when the original finite Main two-owner path, the relevant store/renderer regressions and the original Electron outage journey prove healthy availability with visible incompleteness on the same final composition. Keep full Stage1, provider/OS/native, vendor-auth and P08 recovery claims separate. Historical README limitations may be updated only with that actual evidence, in a separately reviewed documentation follow-up; this source cut does not silently delete them.
