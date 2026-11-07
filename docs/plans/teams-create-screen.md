# Teams: in-tab creation screen, unchanged launch/relaunch dialogs

Status: **draft plan — implementation and independent review are not complete**.
Baseline: `9959d667ae348356f4402bfa5d5d185a7388c8d6` (`main`).
Owner request: creation becomes a screen inside Teams; launch/relaunch remain dialogs;
DRY, bounded scope, four sequential independent critic rounds, strongest available
models with `xhigh`, every commit pushed immediately, verified delivery through PR.

## 1. Outcome and non-negotiable boundaries

Create a team, copy a team, and create a team in an organization use one creation
editor inside an existing `Tab.type === 'teams'`. No second global tab type and no
new router. The editor reuses current roster, template, model, project, validation,
trust and provisioning components. An unfinished creation draft survives leaving
and reopening the screen. A successful accepted creation retires only its draft.

**Launch and relaunch are a separate workflow and remain modal.** This includes
launch from TeamListView and TeamDetailView, relaunch from member/settings flows,
launch preference restoration, schedules, and existing launch validation.

### In scope

- Creation-only screen shell, entry/navigation owner and focused accessibility.
- Creation draft completeness, safe hydration, save ordering, and honest save UI.
- Ordinary create, copy, template apply and organization entry into the same editor.
- Guards for duplicate editors, stale completions and in-flight submission.
- Targeted tests and adaptation of creation selectors in existing desktop E2E.
- Required translations through the existing localization infrastructure.

### Out of scope

- No rewrite of LaunchTeamDialog, runtime/preflight semantics or launch storage.
- No changes to main/preload/IPC/request contracts, provider routing or auth.
- No backend/database migration, live-model policy, Git/worktree implementation,
  installer, organizations domain, template library or cloud/SSH write support.
- No general form framework, generic draft manager, event bus, state-machine
  library, application-wide router or application-wide keep-alive refactor.
- No draft catalogue, concurrent editing, cloud sync or autosaved credential data.
- No unrelated cleanup, dependency upgrades, bulk formatting or raised size caps.
- No feature flags, timer-based release bypass, fabricated checks or forced merge.

Production LaunchTeamDialog and its launch-only helpers should remain byte-identical
to the baseline. A shared component change is allowed only when necessary for this
creation surface and backed by explicit launch/relaunch regression evidence.

## 2. Baseline facts to preserve

- `PaneContent.tsx` deliberately unmounts inactive Teams content. Do not remove
  this rule globally just to retain a form. Route state must outlive that component.
- `openTeamsTab` currently deduplicates only in the focused pane. Two panes can
  therefore contain Teams. Creation must not accidentally mount two writable owners.
- `CreateTeamDialog.tsx` owns form/default/hydration/preflight/submit behavior and
  uses existing shared roster/model/project/template components. It is frozen by
  the source-size guard; new production files have an 800-line limit.
- `useCreateTeamDraft` has one IDB snapshot key, 400ms debounce and unmount flush.
  The current snapshot is not the entire form; description, prompt and prompt
  chips use separate 24-hour draft storage. Some preferences use localStorage.
- Default project application can override an existing selection on a remount.
  Copy inputs and organization defaults are applied when a dialog opens.
- Config-only creation and creation-with-launch have different current paths.
  Preserve both. Resolving `createTeam` is not proof that every agent is ready.
- Creation is currently gated to Electron/local mode. Preserve this authority.
- PR #1122 overlaps loading/preflight presentation; template changes must retain
  explicit unresolved-provider selection and must not auto-launch a template.

Source anchors (relative to repository root):
`src/renderer/components/layout/PaneContent.tsx`,
`src/renderer/components/team/TeamListView.tsx`,
`src/renderer/components/team/dialogs/CreateTeamDialog.tsx`,
`src/renderer/components/team/dialogs/LaunchTeamDialog.tsx`,
`src/renderer/hooks/useCreateTeamDraft.ts`,
`src/renderer/services/createTeamDraftStorage.ts`,
`src/renderer/components/team/dialogs/projectPathOptions.ts`,
`src/features/organizations/renderer/ui/OrganizationMapTab.tsx`.

## 3. User-visible behavior

| Action | Required result |
| --- | --- |
| Create with no unfinished draft | Open creation screen with existing safe defaults. |
| Create with an unfinished draft | Resume that draft; do not silently replace it. |
| Back to Teams | Flush pending edits, show list, preserve draft. |
| Switch to another app tab and return | Resume the same screen and edits; no seed replay. |
| Close Teams and reopen it | Show list with a visible Continue creation action. |
| Restart app and open creation | Restore persisted fields; revalidate runtime/project. |
| Start over | Explicit confirmation only when meaningful work would be discarded. |
| Copy with an unfinished draft | Confirm replacing it or continue the current draft. |
| Apply template | Preserve current documented field ownership; confirm destructive overwrite. |
| Create from Organizations | Same editor, explicit organization placement; no second modal editor. |
| Return from Organizations entry | Return to originating tab if it still exists; otherwise Teams. |
| Change sidebar project while editing | Do not silently change the draft working directory. |
| Open creation from a second pane | Focus the existing owner instead of mounting another writer. |
| Creation rejected before acceptance | Keep editable values and show recoverable error. |
| Creation accepted / config saved | Retire only submitted draft, open existing team/progress UI. |
| Runtime later fails | Existing provisioning/team UI owns recovery; do not resurrect a new form. |
| Launch / relaunch existing team | Existing modal and behavior, unchanged. |

Automatic suggested name/description must not alone count as meaningful user work.
Do not add a confirmation on every ordinary navigation away. Page Escape must not
silently discard work; Escape closes a nested menu/dialog first.

## 4. Navigation and ownership (small, creation-specific)

Use the current tab/layout store and helpers. Persist only the minimum route marker
and editor identity needed across Teams unmounts, not a second form copy in Tab.
An editor session identity is independent of mutable team name and tab ID. There is
one writable creation owner per renderer/local workspace context, not one per pane.
The draft identity must survive closing its tab; the tab ID is only a UI owner.

A focused creation-entry action resolves existing owner across all panes, activates
it, or selects/creates an existing-type Teams tab and attaches the creation route.
All three entry points call this action. Copy/organization seed data is consumed
once; returning to a tab or restoring a draft must not reapply it.

Closing/moving a pane, close-other-tabs, context switching and completion must not
leave a dead owner. Recheck ownership after any awaited seed load. A late copy
response for a retired entry must not replace a newer draft. Use the existing
context/request-epoch patterns where applicable, not a second generic coordinator.

The list's search/filter/visible-count/scroll state should survive the create/back
round trip. Preserve this locally in the existing list host or small tab UI state;
do not keep all application tabs mounted or all list polling active for that reason.

## 5. Draft contract and migration

### 5.1 Field inventory before editing

Map each visible creation field to its current reader/writer and intended scope.
Include name; members, role/workflow and workflow chips; explicit/inherited provider,
backend/model/effort/fast intent; sync-models; solo; launch toggle; project/custom
cwd; prompt and its chips; description/color; lead/teammate worktree options;
extra CLI args; permission/context options; organization placement.

Separate three categories:
1. User-authored creation draft: durable, no 24h expiry.
2. Last-used preferences: defaults for a genuinely new draft, never override resume.
3. Transient UI/runtime state: validation, loading, catalog, auth/readiness, errors,
   pending requests and focus. Recompute; never restore as launch authority.

Never put raw API keys, OAuth tokens or gateway credential material in a draft.
Audit existing gateway binding cleanup on editor unmount before changing lifecycle;
Back is not Discard, and accepted bindings must not be rolled back by stale cleanup.
A missing/retired binding must be surfaced for reconnect, not silently claimed valid.

### 5.2 Minimal persistence extension

Extend the existing creation storage boundary rather than modifying generic
`draftStorage` or launch preferences. Use one coherent creation snapshot for the
fields that must restore together. Keep changes additive where safe; any schema
change requires explicit read/migration compatibility, not delete-on-version-change.

Import the current main snapshot, still-valid legacy text/chip entries and applicable
preference defaults once. Prefer already-migrated values, including intentional
empty strings. Write the coherent snapshot successfully before deleting legacy
keys; preserve legacy data on failure. Do not alter TTL for unrelated drafts.
No requirement to recover text already expired before this migration.

Expose loading/saving/saved/error (or memory-only) honestly. IDB fallback memory is
not durable saved state. Debounce normal typing; flush pending saves on deliberate
leave. Do not claim an awaited flush can guarantee recovery after an OS kill.

Serialize create-draft writes/clear operations so delayed writes cannot resurrect
a discarded/submitted draft. Bind completion to the submitted draft identity and
revision/session generation. A late completion cannot clear a replacement draft.

### 5.3 Hydration and defaults

Hydrate the coherent draft before autogenerated defaults or copy/template seeding.
Do not briefly show an editable default form that later overwrites user input.
Fresh user edits win over late reads. Keep explicit empty/default model intent;
`undefined`, empty string and explicit model are not interchangeable.

Resume priority: saved user field > explicit new-entry seed > last-used preference
> built-in default. A deliberate project change is explicit; navigation/sidebar
changes are not an implicit command to replace the draft's project.

Deleted/inaccessible projects, removed organization units and unavailable models
stay visible as invalid selections with a clear action; no silent fallback launch
on another project/model/organization. Existing creation preflight still authorizes
submission using fresh state, never restored readiness.

## 6. UI extraction and DRY

Retain the current creation controller and its shared feature components. Extract
only the page shell and cohesive creation-only sections needed for size/ownership.
Do not copy the 3k-line form into another file or rename it to evade the size guard.
Do not introduce a shared Create/Launch mega-controller: their lifecycles differ.
DRY means reusing the already shared roster/model/project/status controls, not
forcing their orchestration into the same abstraction.

Creation page: accessible heading, Back, save status, bounded readable width,
content scroll and reachable submit action. Nested provider settings remain normal
shared Radix dialogs. No top-level modal portal, focus trap or dialog semantics.
Use unique IDs where multi-pane coexistence matters. Focus heading on entry and
return focus to the originating list action on Back without stealing focus after
an async request. Use panel-width responsive layout; avoid viewport-only two-column
rules that overflow a narrow split pane. Do not add native title tooltips.

Keep launch/relaunch dialogs' focus trap, close policy, nested settings, shortcuts,
validation and request payloads unchanged. Tests must explicitly exercise both
creation page and launch dialog in the same app session.

## 7. Async effects and submission

Do not equate mounted, visible, editable and submitting. A hidden/unmounted editor
must not publish late preflight/catalog/organization responses into another session.
Preserve existing request signatures, cancellation guards and StrictMode behavior.
Do not reinterpret existing `open` initialization as an active-tab signal: toggling
visibility must not reseed copy data or reset placement. Use explicit one-time seed
and activity conditions only where required.

Capture immutable submitted values plus draft/session identity. Disable duplicate
submit and destructive replacement while acceptance is unresolved. If navigation
remains possible, the accepted operation must have a stable owner outside a mounted
component. Do not cancel already accepted backend creation just because UI closes.
A late callback may update the originating operation but cannot steal focus from a
newer context or clear a different draft. Prefer current store ownership; do not
build a new jobs system.

Organization placement is a post-create action, not an all-or-nothing create
transaction. On placement failure show warning/recovery for the already created
team; never retry team creation to retry placement. Do not broaden organization
behavior beyond making this existing distinction visible in the moved workflow.

## 8. Delivery slices (one draft PR, push every commit)

1. Publish this plan immediately. Record four sequential independent critic rounds
   against exact plan commits. Apply and push corrections between rounds.
2. Add high-risk characterization tests and creation-only storage protections.
   Keep UI unchanged in this slice. Run relevant existing creation/launch suites.
3. Introduce Teams screen owner and page shell, reuse existing creation content.
   Wire ordinary/copy/organization entry and remove the second writable modal path.
4. Add complete regression coverage, update only creation E2E selectors, run
   Electron verification and independent implementation reviews; fix findings.
5. Rebase/merge current main carefully if necessary; qualify exact final head.
   Ready/merge only after required checks and actionable findings are resolved.
   Check post-merge CI and smoke evidence. No release is in scope.

Do not proceed with speculative generic infrastructure to solve a small form move.
If a required preservation contract cannot be satisfied in a slice, keep the PR
Draft and document concrete remaining work rather than shipping a weaker contract.

## 9. Four independent plan-critic rounds

Each round must inspect source plus the latest plan, not only the previous review.
Use the strongest model actually available in the authorized execution environment
with `xhigh`; record the actual model/config/run ID. No silent lower-model fallback.
Requesting a bot review is not proof it ran or that its model/effort was honored.
Self-review is recorded separately and never counted as an independent agent round.

| Round | Primary adversarial focus | Exit evidence |
| --- | --- | --- |
| 1 | Scope, DRY, launch/relaunch contract, smallest architecture | File-specific findings and amended plan |
| 2 | Complete draft/migration, read/write races, gateway cleanup | Counterexamples plus required regression cases |
| 3 | Panes, copy/template/organization entry, submission/context races | Explicit state-transition cases and fixes |
| 4 | Testability, UI/accessibility, missed launch regressions, simplification | Final actionable finding disposition and plan verdict |

After implementation, run independent reviews on final code/diff; address each
confirmed issue with a test where practical. Re-review changed risky areas. Do not
resolve review threads merely because a reply was posted. Unavailable review runs,
provider failures and unverified model settings must be reported, not counted.

## 10. Verification matrix

### Characterization and deterministic regressions

- All persistent fields round-trip; explicit empty/inherited model intent retained.
- Delayed hydration vs typing, auto-description and one-time copy seed.
- Back before debounce, clear vs delayed save, failed migration, memory-only storage.
- >24h restoration for newly unified text/chips; unrelated draft TTL unchanged.
- Rename without losing worktree/args; create defaults not confused with resume.
- Two Teams panes, moving/closing owner pane, reopening with a fresh tab ID.
- Existing draft vs copy/template/organization; cancellation leaves draft intact.
- Slow copy/catalog/organization response after newer entry/context switch.
- Project A draft restored after sidebar/project B navigation; deleted directory.
- Submission double click, failure, accepted progress, late success after navigation.
- Organization placement failure does not create a second team.
- Gateway binding validity/cleanup across Back, discard, submit and restart.
- Existing launch and relaunch payload/default/schedule/preflight tests unchanged.

### Electron UI proof (only disposable fixtures)

Use `pnpm dev:mcp` / existing desktop CDP harness, isolated userData/Claude roots
and new sandbox projects. No real user repositories, credentials or paid agents.
Drive real inputs/buttons; API/store writes are permitted for fixture staging and
readback, not as a substitute for testing the changed UI.

Create/back/resume; tab switch; close/reopen; actual process restart with the same
isolated profile; copy/template/organizations; config-only save through real IPC;
controlled creation error; launch and relaunch still modal from list/team screen;
nested provider dialog Escape/focus; narrow split panes; light/dark; 200% zoom;
visible skeleton/save error; no duplicate editor or background request storm.

Capture screenshots and inspect them. Provider-catalog fixtures and config-only
creation prove UI/IPC behavior, not real provider authentication or live runtime.
Any live runtime smoke, if needed, is a separate sandbox-only evidence layer.

Existing affected drivers include `scripts/e2e/gateway-provider-ui-desktop.mts`,
`scripts/e2e/anthropic-model-selection-desktop.mts` and
`scripts/e2e/anthropic-compatible-status/default-model-packaged.ts`.
Replace creation-modal selectors with an accessible creation-screen locator.
Do not rewrite launch selectors to a page or weaken assertions to make tests pass.

### Required gates

`pnpm typecheck` (pinned TS 7), focused Vitest suites, changed-file fast lint,
`pnpm guard:source-file-size`, `pnpm guard:team-provisioning-architecture`, production
build and required exact-head CI. Use full lint for broad boundary changes.
Keep production files <=800 lines, frozen files non-growing. Do not use TS 5.9,
new .mts files, broad lint --fix, or dependency changes to sidestep test failures.

## 11. Risk/effort estimate and stop conditions

Planning estimate, not measured implementation: 600–1,100 new/substantively changed
production lines, 450–850 test/E2E lines; moved JSX counted separately. Expected
complexity 5/10, pre-verification regression risk 5/10, target residual risk 3/10
only with the listed evidence. No numerical claim of probability or zero bugs.

Highest risks: launch-shared control regression; incomplete draft migration;
unmount gateway cleanup; cross-pane writer collision; stale submission clearing
new data; wrong project after resume. Add only mechanisms that close these concrete
risks. If broader backend/auth/runtime work becomes necessary, separate it instead
of expanding this PR silently.

## 12. Evidence ledger

| Gate | Status | Evidence |
| --- | --- | --- |
| Plan published before code | This commit | GitHub commit/PR |
| Independent critic round 1 | Pending | No run claimed |
| Independent critic round 2 | Pending | No run claimed |
| Independent critic round 3 | Pending | No run claimed |
| Independent critic round 4 | Pending | No run claimed |
| Implementation | Not started | — |
| Automated tests/build/typecheck | Not run | — |
| Electron visual/E2E | Not run | — |
| Independent final code review | Pending | — |
| Required exact-head CI / merge / post-merge | Pending | — |

Execution note: the current assistant session has GitHub read/write connectivity.
The initial local clone failed with DNS resolution for github.com; no local build
or desktop result is implied. The available ReviewRouter workflow accepts a
server-issued request ID, not a direct model/effort override. Independent model
availability and xhigh execution must be established before counting critic rounds.
