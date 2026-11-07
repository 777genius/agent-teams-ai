# Teams: creation screen, unchanged launch/relaunch dialogs

Status: **draft plan; feature not implemented; independent critics 0/4**.
PR: [#1125](https://github.com/777genius/agent-teams-ai/pull/1125).
Inspected production baseline: `9959d667ae348356f4402bfa5d5d185a7388c8d6`.
First plan was published before production changes in `6d2c8f2a90fb42c1801d58153fbba56930a0a5b7`.
Execution evidence and actual review blockers are recorded in section 12.

Owner requirements: a creation screen inside Teams, launch/relaunch kept modal,
DRY, bounded scope, four sequential independent critic rounds on the strongest
available models with `xhigh`, immediate push after every commit, reviewed E2E delivery.
This document does not claim the requested delivery or review rounds are complete.

## 1. Outcome and hard scope boundary

Ordinary creation, copying a team and creating within an organization open one
creation editor inside an existing `Tab.type === 'teams'`. No new global tab type,
router or second implementation of the form. Reuse current roster, template,
model, project, validation, trust and status components. A draft survives leaving
and reopening the editor. Accepted creation retires only the submitted draft.

**Launch/relaunch remain separate modal workflows.** Preserve launch from both
the list and team screen, member/settings relaunch, schedules, launch preferences,
preflight, permission checks and request construction.

### In scope

- Creation-only screen shell, entry/navigation ownership and accessibility.
- Complete creation draft, safe hydration/migration, ordered saves and save status.
- Ordinary/copy/template/organization entries into the same creation editor.
- Duplicate-editor, stale-callback and unresolved-submission guards.
- Targeted regressions, creation-selector updates in existing desktop E2E and i18n.
- A narrowly scoped creation-owned gateway draft lifetime within the same renderer;
  the shared launch/add-member cleanup policy remains the default and retains its tests.
- Explicit reconnect state when existing main-process recovery has reclaimed an
  unsaved gateway binding after renderer replacement or application restart.

### Out of scope

- No rewrite of LaunchTeamDialog, launch storage, runtime or preflight semantics.
- No main/preload/IPC/request-contract, provider routing, authentication, Git,
  worktree implementation, installer, organization domain or template-library changes.
- No backend/database migration, new cloud/SSH write support or paid runtime tests.
- No form framework, generic draft manager, event bus, state-machine library,
  global router, application-wide keep-alive refactor or new jobs infrastructure.
- No draft catalogue, cross-window collaborative editing, cloud sync or credentials
  in renderer draft storage. Never claim a renderer-local guard is a cross-window lock.
- No dependency upgrades, broad formatting, unrelated fixes or raised source-size caps.
- No authorization bypasses, fabricated checks, forced merge or release.
- No disabling main-process provisional-binding recovery or promoting unsaved
  bindings to saved team credentials merely to preserve a form across restart.

LaunchTeamDialog and launch-only helpers should remain byte-identical to the
baseline as a result of this PR. Necessary shared-control changes require explicit
launch/relaunch regression evidence. Do not discard unrelated upstream fixes to
preserve an old checksum when rebasing.

## 2. Source facts and concrete risks

| Source | Observed behavior | Required protection |
| --- | --- | --- |
| `src/renderer/components/layout/PaneContent.tsx` | Inactive Teams content unmounts | Route and draft must outlive the component; no global keep-alive change |
| `src/renderer/store/slices/teamSlice.ts` | `openTeamsTab` deduplicates within the focused pane | Prevent independent writable creation editors across panes |
| `src/renderer/hooks/useCreateTeamDraft.ts` | One snapshot key, 400ms debounce, unmount flush | Order save/clear; capture draft identity; handle persistence failure |
| `src/renderer/services/createTeamDraftStorage.ts` | Version-1 snapshot, memory fallback, not all visible fields | Explicit migration and honest durability status |
| `CreateTeamDialog.tsx` | Text/chips use separate 24-hour storage; other values use preferences | Coherent creation snapshot without changing other draft TTLs |
| `dialogs/projectPathOptions.ts` | Default project can override restored selection on a remount | Separate fresh entry from resume; saved selection wins on resume |
| `CreateTeamDialog.tsx` | Copy/organization initialization depends on open/load | Consume seed once, never replay on return |
| `useGatewayMemberBindings.ts:71-77` | Unmount calls `session.discard()` | Back/tab switch must not discard creation-owned bindings |
| `GatewayBindingDraft.ts:99-114` | Discard retires receipt generation and removes uncommitted bindings | Keep receipt ownership; preserve launch cancellation safety |
| `src/features/gateway-provider/main/application/GatewayProviderService.ts:350+` | Recovery reclaims abandoned unsaved document-owned receipts | Restart restores form intent, not guaranteed gateway credentials; preserve backend recovery |

Paths abbreviated above are under `src/renderer/components/team/` unless otherwise
specified. Gateway hook files are under `src/features/gateway-provider/renderer/hooks/`.

The gateway cleanup consequence was confirmed with a pure-source probe using a
mock unbind callback: a newly acquired receipt is removed by `discard()`. This is
not an Electron UI reproduction or a claim that current dialog cancellation is a bug.
Main-process recovery has existing tests in
`src/features/gateway-provider/__tests__/GatewayDraftRecovery.test.ts` and is wired
for document loss in `main/adapters/input/registerGatewayProviderIpc.ts` within that
feature. A renderer-only change cannot promise to retain every provisional binding
across process restart without changing this separate protective contract.

Other source-level risks requiring tests: auto-description can race text hydration;
late copy/catalog responses can overwrite newer selections; a late creation result
can clear a replacement draft; renaming can switch name-keyed worktree/argument
preferences. Do not report these as reproduced UI bugs until tested.

Creation remains Electron/local-only. Keep config-only and create-with-launch
paths separate. `createTeam` accepting a run does not mean all agents are ready.
Respect the overlapping loading/provider presentation work in PR #1122. Templates
must preserve explicit unresolved provider intent and must not launch on application.

## 3. User-visible contract

| Action | Required result |
| --- | --- |
| Create without a draft | Existing safe defaults on the creation screen |
| Create with unfinished work | Resume; no silent replacement |
| Back | Save pending edits, return to list, retain draft |
| Switch tab and return | Same creation screen and edits; no initialization replay |
| Close Teams and reopen | List with visible Continue creation action |
| Restart and resume | Restore committed fields, revalidate project/providers; explicitly reconnect any reclaimed provisional gateway binding |
| Start over / copy over existing work | Explicit replace or continue decision |
| Apply template | Preserve documented field ownership; confirm destructive replacement |
| Create from Organizations | Same editor with explicit placement context |
| Return from organization entry | Original tab if still present, otherwise Teams |
| Change sidebar project | Do not silently replace draft working directory |
| Open creation in another pane | Focus existing owner rather than another writer |
| Rejection before creation is accepted | Keep values, display actionable error |
| Accepted creation / saved config | Retire submitted draft, open existing team/progress UI |
| Runtime later fails | Existing team/provisioning recovery; do not resurrect another form |
| Launch / relaunch | Existing dialogs and behavior |

Automatically suggested names/descriptions are not meaningful user edits. Do not
add confirmation on every ordinary navigation. Escape closes nested menus/dialogs
first and never silently discards the page. A persistence error offers retry or an
explicit informed leave; it must not masquerade as a successful durable save.

Last-used preferences are defaults for a new draft, not a copy of the last team.
Successful creation does not turn the finished team's form into the next draft.

## 4. Navigation and ownership

Use existing tab/layout state and helpers. Store only a small Teams route marker
and editor/session identity outside the unmounted list component; do not duplicate
form values in Tab. Draft identity is independent of mutable team name and tab ID.
The tab owns presentation; the draft survives closing it.

A creation-specific entry action checks all panes, activates the owner, or selects
an existing-type Teams tab and opens its creation route. All creation entry points
use this action. Async copy/organization inputs are consumed once, with a request
identity check after await. Resume must never reapply those inputs.

Handle moving/closing a pane, close-other-tabs and context switching. Do not retain
a dead owner. Reuse existing context/request epochs where appropriate. One writer
per renderer/local workspace is the scope; verify the supported Electron window
lifecycle rather than introducing a distributed lock or assuming cross-window safety.

Preserve list search/filter/visible-count/scroll for the create/back round trip
through its host or small existing tab UI state. Do not keep all list subscriptions
or all application tabs alive merely to retain this state.

## 5. Creation draft: inventory, migration and lifetime

### Inventory and field ownership

Before extraction, map every visible field to reader, writer and persistence scope:
name; members/roles/workflows and workflow chips; explicit/inherited provider,
backend/model/effort/fast intent; sync; solo; launch toggle; project/custom cwd;
prompt/chips; description/color; lead/teammate worktree options; extra CLI arguments;
permission/context settings; organization placement; non-secret gateway selection
intent sufficient to distinguish a missing binding from an intentional direct provider.

Separate durable user-authored draft, last-used defaults and transient UI/runtime
state. Catalogs, checks, errors, loading and authentication/readiness are transient.
Never restore readiness as launch authority. Do not persist API keys, tokens or
credential material. Audit free-form arguments for the existing secret-handling
contract; this task must not expand secret persistence accidentally.

### Minimal persistence extension

Extend the existing creation storage boundary, not generic `draftStorage` or launch
preferences. Use a coherent creation snapshot for fields that must restore together.
Schema changes require an explicit compatible reader/migration, not rejection and
delete of the existing version.

Migrate the old main snapshot, still-valid legacy text/chip keys and applicable
preference defaults once. Migrated explicit values, including empty strings, win.
Commit the new snapshot before deleting any legacy entries; retain old data on
failure. Do not change unrelated TTLs or promise recovery of already expired text.

Expose loading/saving/saved/error or memory-only truthfully. A resolved memory
fallback is not proof of durable storage. Debounce typing, flush on deliberate
leave, and preserve failures for retry. An async unmount flush cannot guarantee
recovery after an OS kill; document that limit rather than promising it.

Serialize draft writes/clear operations. Bind accepted submission and clearing to
its draft/session identity and revision so old writes cannot resurrect a discarded
draft and old completions cannot clear a new one. No generic persistence framework.

### Hydration and defaults

Hydrate before default generation, copy or template seeding. Do not expose editable
defaults that later overwrite input. Fresh edits win over late reads. Preserve the
difference between undefined model intent, empty Default and an explicit model.
Resume priority: saved field > explicit fresh-entry seed > preference > built-in
value. Sidebar navigation is not a command to change the saved working directory.

Deleted/inaccessible projects, unavailable models and removed organization units
remain visible invalid selections with an action; no silent replacement. Fresh
existing preflight continues to govern actual submission.

### Gateway binding ownership: creation-only adaptation

The shared hook currently owns a dialog-local `GatewayBindingDraft` and discards
on unmount. Do not remove this cleanup globally or replace it with `markSaved` on
Back: either change would weaken existing launch/add-member cancellation semantics.

Prefer a small opt-in creation-owned draft/session passed through the existing
boundary; launch callers retain their default local ownership. Preserve exact
binding receipt identity for cleanup (`teamName`, `memberName`, `gatewayUsageRef`,
`boundAt`), not just a member name. Never infer ownership from all bindings returned
by `listGatewayBindings`, and never delete a replacement/pre-existing receipt.

Within the same live renderer document, Back/tab switch/closing a Teams tab retains
the creation session; explicit discard reconciles only that draft's owned receipts;
accepted create transfers ownership to the team. A failed/late binding operation
cannot attach to a replacement draft. Do not use a saved flag to bypass cleanup.

Renderer reload, crash and application restart are different: the existing main
recovery may reclaim provisional receipts. Restore the non-secret form and gateway
selection intent, refresh binding facts, and show a reconnect action for affected
members. A missing intended gateway binding must not silently switch that member
to a direct provider or submit a different runtime/model. Keep submission blocked
for that unresolved selection until the user reconnects or explicitly changes it.
Persisting an old receipt does not restore its authorization or prove it survived.

No new durable gateway ownership protocol, credential copying, IPC method or
main-process recovery change is in scope. Transparent survival of provisional
credentials across process restart would require a separate explicitly approved
backend design. This page move must preserve the current protective cleanup.

## 6. UI extraction and DRY

Reuse existing creation orchestration and shared controls. Extract only the shell
and coherent creation-only sections required for ownership/size. Do not copy the
3k-line form into a second implementation or rename it to evade the size guard.
New production files must stay at or below 800 lines; frozen files must not grow.

Do not force Create and Launch into one mega-controller: shared controls are DRY,
while creation/resume and launch/relaunch have genuinely different lifecycles.
The page has a heading, Back, save status, bounded width, content scrolling and a
reachable submit action. No top-level modal portal/focus trap/dialog role. Existing
nested provider settings keep the shared Radix dialogs.

Use panel-width responsive layout, not only viewport `md:` rules. Test narrow split
panes, long translations, zoom and both themes. Use unique control IDs where needed,
focus heading on entry and the originating action on Back; async results must not
steal focus. Preserve launch dialog keyboard behavior, nested settings and focus trap.

## 7. Async effects, submission and acceptance

Mounted, visible, editable and submitting are distinct. Keep existing signatures,
cancellation guards and StrictMode handling. An inactive or retired editor cannot
publish stale catalog/preflight/organization results into a new session. Do not use
`open = isActive` to drive copy initialization or reset placement on tab changes.

Capture immutable submitted values and draft identity. Disable duplicate submit
and destructive draft replacement until acceptance is resolved. Ordinary navigation
must not imply backend cancellation. Pending operation ownership must outlive the
component when navigation remains possible; use existing store ownership, not a
new jobs system. Late completion must not clear another draft or steal focus.

Differentiate known rejection from an indeterminate transport outcome after send.
For the latter, reconcile existing team/provisioning state before offering another
create attempt; do not blindly retry a possibly accepted creation. Preserve existing
backend contracts and report any unavoidable broader requirement as separate scope.

Organization placement is post-create. A placement failure warns about an already
created team and retries placement only; it must not cause a second team creation.
The user should see the warning rather than only a console message.

## 8. Bounded implementation sequence

1. Publish plan immediately, then four independent plan critiques on exact commits.
   Apply and push corrections after each round; record actual model/effort evidence.
   Test-only characterization of existing behavior may prepare that review; it is
   not the feature implementation or a substitute for the four independent rounds.
2. Harden creation-only draft/storage lifetime with UI unchanged. Keep existing
   creation/launch/gateway regression suites green.
3. Add Teams page owner/shell and wire fresh/copy/organization entries. Remove the
   second writable creation modal path; keep launch/relaunch modal paths.
4. Add deterministic regressions, adapt only creation E2E selectors, run isolated
   desktop verification and independent code reviews. Fix confirmed findings.
5. Reconcile main and PR #1122, qualify the exact final head, mark ready/merge only
   with required checks and resolved actionable findings. Verify post-merge checks.
   No release and no merge of this plan as though the feature were delivered.

Push every commit immediately; never collect an unpublished stack of agent commits.
No broad prerequisite refactor. If an essential contract cannot be met in a slice,
keep the PR Draft and record the remaining work instead of weakening the contract.

## 9. Four independent plan-critic rounds

Each reviewer reads current plan plus source. Use the strongest model available to
that authorized environment with `xhigh`, recording actual configuration/run/commit.
A model request, CLI startup, self-review or failed provider call is not a completed
critic. No silent lower-model fallback. Author checks are explicitly separate.

| Round | Focus | Exit evidence |
| --- | --- | --- |
| 1 | Scope, DRY, launch/relaunch compatibility, smallest design | Source-backed findings and amended plan |
| 2 | Complete draft/migration, save/read races, gateway receipt lifetime | Failure sequences and required tests |
| 3 | Panes, copy/template/organization, submission/context races | State transitions and fixes |
| 4 | Testability, accessibility, remaining launch regressions, simplification | Finding dispositions and final plan verdict |

After implementation, independent code reviews inspect the final diff. Address
confirmed issues, add tests where practical and re-review risky fixes. Do not resolve
threads merely because a reply was posted. Unknown model settings and unavailable
providers stay visible in the ledger, not converted to approvals.

## 10. Verification and acceptance

### Deterministic regression cases

- Round-trip every persistent field, including workflow chips and empty model intent.
- Delayed hydration versus typing, auto-description, copy seed and template apply.
- Back before debounce; queued save versus clear; migration failure; memory-only save.
- Newly unified text/chips survive >24h; unrelated draft TTLs stay unchanged.
- Rename preserves worktree/arguments; fresh defaults do not overwrite resume.
- Two Teams panes, moving/closing owner, reopening under a different tab ID.
- Copy/template/organization replacement canceled without losing existing work.
- Slow seed/catalog/organization response after a newer entry or context switch.
- Project A draft after sidebar B navigation; deleted/inaccessible directory.
- Double submit, rejection, unknown acceptance, accepted run and late success.
- Placement failure leaves one created team and an actionable warning.
- Same-document gateway Back/resume retains ownership; discard removes only the
  exact owned receipt; late binding and replacement races remain protected.
- Restart preserves non-secret gateway intent, respects main recovery and asks for
  reconnect when the binding is absent; no silent direct-provider fallback.
- Existing launch/relaunch/add-member cleanup and payload/preferences/schedules
  remain unchanged. Creation and launch operate in the same app session safely.

The hook-level characterization file
`src/features/gateway-provider/renderer/hooks/__tests__/useGatewayMemberBindings.lifecycle.test.tsx`
exercises the real hook under React StrictMode for both roster and addition mode:
exact receipt cleanup, pre-existing binding preservation, accepted save, unresolved
save across unmount (success/rejection), late binding after unmount, and saved
members surviving a later launch failure. These default dialog cases must remain
green when introducing creation-specific ownership. Mocked gateway calls do not
prove Electron IPC, main-process recovery or the new page's retention behavior.

### Electron proof using only disposable fixtures

Use existing `pnpm dev:mcp`/CDP harness, isolated userData/Claude roots and sandbox
projects. No real user repositories, credentials or paid agents. Exercise actual
inputs/buttons; store/API calls are fixture staging/readback, not a UI substitute.

Cover create/back/resume, tab switch, close/reopen, actual process restart using the
same isolated profile, copy/templates/organizations, real IPC config-only save,
controlled error, launch/relaunch still modal from both list and team screen,
nested-dialog Escape/focus, narrow panes, light/dark, 200% zoom, save-error and
loading presentation, duplicate-editor and background-request regressions.
Capture and inspect screenshots. Catalog fixtures/config-only IPC do not prove live
authentication or runtime success; live runtime proof is a separate sandbox layer.

Existing affected drivers include `scripts/e2e/gateway-provider-ui-desktop.mts`,
`scripts/e2e/anthropic-model-selection-desktop.mts` and
`scripts/e2e/anthropic-compatible-status/default-model-packaged.ts`. Replace only
creation `role=dialog` selectors with an accessible page locator; settings/launch
selectors and assertions remain meaningful. Do not weaken tests to make them pass.

### Required gates

Pinned TS 7 `pnpm typecheck`, focused Vitest, changed-file fast lint, production
build, `pnpm guard:source-file-size`, `pnpm guard:team-provisioning-architecture`
and exact-head required CI. Full lint for broad boundary changes. No TS 5.9, new
.mts files, broad lint --fix or dependency changes to bypass failures.
Baseline tests are preparation, never proof of the unimplemented screen.

## 11. Estimates and limits

Estimate: 600–1,100 new/substantively changed production lines plus 450–850 test/E2E
lines, excluding mechanically moved JSX. Complexity about 5/10, pre-verification
regression risk about 5/10, target residual risk about 3/10 only with the specified
evidence. These are planning judgments, not probabilities or a zero-bug guarantee.

Highest risks: shared launch control regression, incomplete migration, gateway
cleanup, duplicate writers, late completion clearing new work and incorrect cwd.
Add only mechanisms closing these concrete risks. Backend/auth/runtime remediation
and repair of independent review infrastructure are separate scope, not hidden
prerequisites to be implemented in this feature PR.

## 12. Actual execution evidence — 2026-11-07

### Verified preparation

- Initial plan immediately pushed and draft PR #1125 opened before product changes.
- Full tracked source obtained from Actions artifact after local GitHub DNS failed;
  source inspection is no longer blocked by cloning. No local dependency build or
  Electron run is claimed.
- Source-level gateway discard probe confirmed removal of a new uncommitted receipt
  with a mock unbind callback. No user credentials, IPC or live providers were used.
- [Baseline test run 42375357246](https://github.com/777genius/agent-teams-ai/actions/runs/42375357246)
  at `fba7c0817df7b69b1cb544898ad5ff401cecf382`: **374/374 tests, six files**, both
  architecture guards passed. Artifact `13575168130` includes JSON, log and SHA.
- Earlier [Fast feedback run 42374107354](https://github.com/777genius/agent-teams-ai/actions/runs/42374107354)
  at `42a692e9865338beeaa5b68870b29d2b1a440c35` passed workspace typecheck, fast lint
  and architecture guards. Full qualification was not attained; overall CI was not
  green. This is not evidence for a future implementation commit.

| Existing test file | Passed tests in original baseline |
| --- | ---: |
| `src/renderer/hooks/useCreateTeamDraft.test.tsx` | 6 |
| `test/renderer/store/teamSlice.test.ts` | 246 |
| `test/renderer/components/team/dialogs/LaunchTeamDialog.test.ts` | 100 |
| `test/renderer/components/team/dialogs/ProjectPathSelectorDeleted.test.tsx` | 5 |
| `src/features/gateway-provider/renderer/hooks/__tests__/GatewayBindingDraft.test.ts` | 13 |
| `src/features/gateway-provider/renderer/hooks/__tests__/useGatewayMemberBindings.test.tsx` | 4 |

The 100-test dialog file covers mixed creation/launch cases; it is not 100 isolated
launch-only tests. The first temporary task workflow was removed after capturing
evidence; task-specific verification workflows must not ship as a reviewer subsystem.

### Follow-up characterization, not feature implementation

- `48caad5802399ae9df209f7b7aebfec6fab3757e` adds 14 hook lifecycle cases without
  changing production behavior. This is additional protection for current dialogs.
- [Follow-up run 42377246207](https://github.com/777genius/agent-teams-ai/actions/runs/42377246207)
  tests exact head `17f97ccf897d45d5606f3f4ded5f5379ffab7101`, including the new hook
  cases, the six original suites and existing main-process recovery tests. Read
  its actual terminal result/artifact; triggering it alone is not a pass.
- Main-process recovery inspection corrected the earlier ambiguous restart promise:
  form restoration and same-document binding retention are in scope; transparent
  provisional credential survival across a new renderer/process is not.
- Local execution still has no authenticated critic launcher; installed integration
  discovery did not expose one. The configured ReviewRouter interaction runtime
  remains the legacy pin previously rejected below. No unchanged-auth retry is counted.

### Independent review attempts — neither produced a model review

1. [Direct Codex run 42374103853](https://github.com/777genius/agent-teams-ai/actions/runs/42374103853),
   job `128408054276`: CLI 0.167.0 requested `gpt-6-astra` / `xhigh` in read-only
   sandbox. The existing `REVIEWROUTER_CODEX_AUTH_JSON` credential failed refresh
   with **401 invalid_jwt** before inference. Configuration appeared in CLI output,
   but successful model availability/execution was not established. Job-owned auth
   was deleted; credentials were not exported. Do not retry unchanged invalid auth.
2. Standard `/rr review` comment `6707268698` triggered
   [ReviewRouter Interaction 42375007774](https://github.com/777genius/agent-teams-ai/actions/runs/42375007774).
   The configured legacy runtime was rejected by **403 legacy_review_mutation_blocked**;
   fallback then failed with `github_permission_denied`. No model review ran.
   Do not bypass this rejection by widening permissions or fabricating request IDs.

The four-round requirement remains **0/4**. Recovery needs a valid authorized
reviewer login/configuration or the supported ReviewRouter integration. Merely
posting another review request, using a bot with unknown model/effort or performing
author self-review does not satisfy it. No unrelated auth/infrastructure fix is
included here.

| Delivery gate | Current status |
| --- | --- |
| Detailed plan published and source-informed refinements | Done, awaiting independent critique |
| Independent critic rounds 1–4 | 0/4; authorization failures above |
| Original regression baseline | 374 passed; scoped evidence only |
| Additional hook characterization | Added; terminal evidence is in the linked follow-up run |
| Feature implementation | Not started |
| New-screen tests / Electron visual E2E | Not run |
| Independent implementation review | Not started |
| Exact implementation-head qualification / merge / post-merge | Not performed |

The PR stays Draft. Production behavior, including launch/relaunch dialogs, has
not been changed by this branch. Completion of the requested feature is not claimed.
