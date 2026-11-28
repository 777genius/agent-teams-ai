# Frontend parity audit and corrections - 27 November 2026

## Goal and source

Preserve the existing Desktop workflows while using the isolated Host with
Claude, Codex, OpenCode V1 and OpenCode V2. This extends the existing
[P01-P11 parity plan](frontend-parity-2026-11-12/README.md) and
[integration plan](final-integration-2026-11-26.md); it does not create another
migration or redefine an unsupported UI control as finished work.

Audit baseline: PR #982 `f3bbca99f4e1ed07009f60338c3ffdf6f15a91ad`, tree
`2d9805a6495638387f46552d05b2776a57c11ada`. Current main is
`2dbc3e27b9c2ae66b15bdaf81c87bee108f02f2f`. Main's scheduler corrections are
relevant to the existing Pause/Edit/Delete/Resume controls and need semantic
reconciliation with the stronger Host-aware repository updates in #982.

Keep work in #982, open and unmerged into main. Publish this reviewed plan before
changing implementation, then publish each reviewed correction batch promptly.
No release, default activation, provider pin update or new product feature.

## Confirmed corrections and estimates

Estimates count changed production and regression lines, not whole files.
Complexity, confidence and reliability target are out of 10. Targets are not
claims of completed verification.

| ID | Existing mismatch | Minimal correction | Production / tests | Complexity | Confidence | Reliability target |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| A | An inherited provider/model is absent from Host member presentation; the existing composer can reject supported attachments | Project the original captured runtime selection separately from authored settings, retaining exact launch/member/generation identity | 140-230 / 220-330 | 6 | 8 | 9 |
| B | Member memoization ignores native media limits and Host identity fields; composer/settings retain stale information | Compare the semantic media declaration and the existing Host member/settings identity fields | 30-50 / 80-130 | 3 | 9 | 9 |
| C | Host task/group instructions contain legacy tool arguments; edits of task title/description do not notify the lead as the existing frontend does | Use the existing bound-tool formatter mode and prepare the existing user-edit notification in the canonical task effect plan | 120-220 / 220-360 | 6 | 8 | 9 |
| D | Current-main scheduler concurrency fixes are missing from the Host branch | Reuse its file lock and per-schedule mutation serialization while preserving Host atomic updates and committed-delete behavior | 100-170 / 180-300 | 5 | 9 | 9 |
| E | Three root strict-typing defects prevent CI from reaching its original journeys | Correct the defensive action check and complete two test fixtures without weakening the contracts | 5-15 / existing suites | 2 | 10 | 9 |

## Implementation boundaries

### A. Authored settings and effective runtime selection

Reuse `team.launch.configuration.read` and the already captured lifecycle state.
A focused renderer projection should match launchId, rosterRevision, memberId,
generation and attempt before combining their results. Keep the original read
fence and UI scope across the additional await. Do not read unrelated global
defaults, a different project history or a new member with a reused name.
Compare the two launch observations with each other, not their roster revision
against the saved definition revision: editing next-run defaults must not erase
a still-current launch selection. Match the product member by ID, label and role.

Expose effective provider, model presentation, effort, fast mode and workspace
to the existing member view. Preserve `configuredRuntimeSettings`, the saved
request and definition settings verbatim, including intentional inheritance.
Save-only display can resolve authored inheritance only for an explicitly
never-launched snapshot with no pending cleanup, without claiming readiness.
Keep `selectedFastMode` authored and put the captured boolean in
`resolvedFastMode`. Removed members and an unavailable/mismatched active capture
cannot acquire attachment capabilities or effective provider/model fields from
a newer definition; clear those effective fields while retaining the authored
settings and product records.

OpenCode's existing `selected.model` is a private native model ID consumed by
launch/probe paths. Keep it unchanged. If the UI needs a qualified model name,
add only an optional `qualifiedModel` display field produced from the original structured
provider/model pair and validated by Main. Always preserve the whole model ID,
including nested or repeated prefixes. A display name does not prove a public
catalog entry or additional supported media. Existing native attachment guards
remain authoritative; an unavailable projection retains product rows and an
explicit warning. An unlisted or ambiguous pair remains metadata-unknown; this
change does not rewrite public catalog alias semantics.

Expected files: `executeTeamLaunch.ts`, the existing launch contracts and Main
projection, `createHostTeamsApi.ts`, and one focused renderer helper. Extract
only the relevant projection to keep the existing 800-line limit.

### B. Refresh the existing composer and member controls

Update `useStableActiveMembers.ts` to include `hostMemberId`,
`configuredSettingsFingerprint` and every semantic `nativeMediaTransport`
field, including revision, MIME lists, byte limits and count limits. Equivalent
cloned values must retain stable references; changed or removed capabilities
must refresh the existing controls. Test a real React rerender through the
existing composer/capability path, not merely a comparator returning true.

### C. Preserve task coordination through the bound Host tools

`ControllerAdapter` already requests `boundTaskTools`; task assignment, comment,
dependency-unblocked and group-briefing text must respect that mode just as the
existing review/start formatters do. Host
examples use the bound team/member and valid write command IDs, without legacy
`teamName`, `actor` or `from` parameters. Retain the legacy formatter verbatim
when that mode is absent. Reuse the existing bound member-messaging protocol.
Validate example payloads against the actual bound tool schemas, including the
existing `task_start`/`task_complete` aliases and group list/send operations.
The original isolated filesystem/MCP reproduction rejected assignment, comment
and dependency examples as invalid and the native SendMessage example as
unsupported; group briefing also supplied forbidden team/from fields.
The existing bound `task_create` schema must forward its optional `groupChatId`
to the already implemented owner validation. Cover same-team membership and
archived/foreign group rejection. This restores the advertised create path;
it does not add the separate group-association edit surface.

Task title/description edits from the human UI must notify the canonical lead
through the existing task effect plan, following the legacy frontend behavior.
Prepare product writes and the notification together, capture the recipient
and stable message identity with the original command, and preserve replay and
partial-publication recovery. Do not send again from the renderer or add a
second outbox. Do not notify for agent-originated edits or duplicate the
existing clarification-answer notification. A missing lead must not prevent a
valid task edit. Capture only an existing live lead delivery, reuse the original
receipt message ID and timestamp, and never wake a stopped Team. Test task-before-
inbox partial publication and lost acknowledgement. No new group-chat editing
UI is included.

### D. Reconcile the existing scheduler controls

Port the relevant behavior from main's #1312/#1313 to
`JsonScheduleRepository.ts`, `SchedulerService.ts` and its small existing-main
mutation queue. Protect all metadata read/modify/write operations across
repository instances with the existing file-lock utility. Pin each operation's
file and cleanup paths before it awaits another writer so a profile switch
cannot redirect cleanup. Include the existing atomic `updateSchedule` in that
same lock and retain strict reads: corrupt metadata must not become an empty
writable schedule list.

Serialize schedule state transitions with completion/failure updates and reject
late cron activation after service stop. Preserve #982's atomic
`updateSchedule`, `mustExist`, Host owner/project routing, and committed-delete
native cancellation. Never hold a metadata lock or the per-schedule queue while
waiting for potentially slow native cancellation. Existing race fixtures must
start competing operations before releasing their deterministic writer barrier,
then await both; do not wait for a now-serialized writer while retaining its
predecessor's barrier. Keep the original durable-state assertions. Avoid a second
failure-count helper or scheduler implementation. Unrelated main screenshots/updater work is
outside this correction batch.

### E. Restore the original strict validation path

- `useTeamProvisioningPresentation.ts`: use an explicit function check for the
  existing defensive missing-action fallback.
- `hostCrossTeamOutboxPages.test.ts`: replace a self-referential mock initializer
  with an independent call index, keeping all cursor/payload/count assertions.
- `hostWorkSyncMessageKinds.test.ts`: supply the required nullable runtime config
  in the synthetic record, without changing its production type.

The two Host fixture files from the earlier CI report were already corrected by
`f3bbca9`; do not reapply stale suggestions.

## Concurrent ownership

The separate macOS continuation owns `savedTeamModelProbe.ts`, `teamRoster.ts`,
`team-launch/TeamLaunchOwner.ts`, original Resume/Review/cold Quit, and has a
pending request for the OpenCode readiness/config/probe adapters. This batch
does not edit those files or their native harnesses.

The active context/usage continuation owns `TeamContextReminders`, runtime
context preparation, Codex usage, bootstrap clipping, queued-message paging,
`createTeamLifecycleMethods`, the product-lifecycle contracts/projections and
renderer adapter, and `src/shared/types/team.ts`. Its dirty work is preserved.
In particular, the queue overflow review finding is not duplicated here.

One coordinator publishes the combined changes with an expected-head lease.
Before every publication, read the current PR head and incorporate unrelated
commits without overwriting another agent's changes. No force push, duplicate
PR, manual workflow rerun or cancellation is needed.

## Review and validation

1. R1: trace each mismatch from an existing UI/API action to its actual effect;
   remove speculative feature expansion and identify active file owners.
2. R2: independent criticism of the exact plan, especially stale runtime views,
   native/public model identities, notification replay and scheduler races.
3. R3: reconcile that criticism and check implementation/test feasibility before
   publishing the plan. Then independently review each actual source diff.
4. Add focused regressions for inherited/mixed providers, stale generation,
   media changes, task assignment/edits/replay, and the real scheduler races.
   Prefer existing React, filesystem Host and HTTP/MCP harnesses. Tests use only
   isolated TEST data and never launch vendors on real user projects.
5. Run the pinned Node 24.21.0/native TypeScript 7.0.2 Host build, affected
   strict projects, relevant suites, touched-file lint/format and existing
   source-size/provisioning/runtime-artifact guards. Keep compiler options,
   assertion deadlines and provider/runtime pins unchanged.
6. Report exact-source finite evidence separately from ordinary CI and native
   desktop E2E. The existing native acceptance matrix remains required; an
   unexecuted, queued, skipped, timed-out or killed check is not a pass.

Baseline local Host build passed. The baseline complete root typecheck was
terminated with exit 137 before producing a compiler diagnostic; it remains
unqualified. The three root corrections have exact-source CI diagnostics and
must still be validated on the corrected source.

## Review record

- R1 completed: root plus the frontend, provider and coordination audits traced
  the five correction groups against current source and existing UI contracts.
  Discarded a group-chat field API-only expansion without an existing edit
  control; preserved the existing context/queue and macOS ownership boundaries.
- R2 completed by the frontend, provider and coordination reviewers. Corrected
  four instruction paths rather than assignment alone; added the already
  implemented group-linked task-create path; specified live-lead capture,
  original notification identities and partial-publication replay. Distinguished
  launch revision from saved-definition revision, authored from resolved fast
  mode, and qualified native model names from public catalog assertions.
- R3 completed by root against those reviews and current source. Restricted
  save-only fallback, retained removed/unknown member behavior, covered every
  repository metadata writer under the same file lock, and separated native
  cancellation from serialized metadata. Existing race-test barriers must be
  adapted to serialization while keeping their durable-state assertions.
  Current-main unrelated updates and other agents' files remain outside this
  batch. The plan is approved for implementation; native qualification is open.

## Implementation review and integration

The reviewed plan was published first as `899b058f`, before production edits.
Implementation then used separate provider/presentation, task-coordination and
scheduler owners. Each source group received an independent review from another
owner in addition to the coordinator's review.

The parallel context/queue continuation subsequently published `ea4377f1` and
merged current main as `28b95aa0`. This batch is reconciled on that exact source
tree (`0b344cee69452ae7bc6c01f8e6822ac10a8f17ae`), preserving the context/queue
fixes, updater changes, screenshots and both sets of scheduler tests. The
incoming mutation queue is retained unchanged. No reserved macOS/provider
readiness files were edited.

Review found and corrected these additional cases within the planned paths:

- Attachment declarations use the current captured workspace, even after the
  saved workspace changes. An unknown captured workspace remains unknown.
- Runtime and spawn presentation use OpenCode's qualified display model while
  keeping its native selection unchanged. Runtime reads match the member
  generation and attempt across the additional observation.
- Captured member summaries use the provider/model/effort projected together;
  a separate poll keyed by a reused name or a new launch draft cannot replace
  them. Legacy summary behavior is retained.
- Human task edits preserve short display references and use the canonical task
  returned by the existing resolver. The notification retains the original
  message identity, timestamp and live lead delivery, including crash recovery.
- Scheduler Create/Edit/Resume/Pause/Delete and startup cannot continue against
  a newer lifecycle after Stop or a profile change. Startup recovery checks the
  same lifecycle; `saveRun` pins its original file before its internal await.
  The race tests proved that an old recovery could otherwise replace another
  profile's completed run. No native timeout or cancellation rule was weakened.

The incoming queued-Resume test now expects the stale operation to be rejected
with `Scheduler context changed`, while retaining the durable paused record,
failure count and absence of a cron timer. This is the same behavior required
by the reproduced profile-switch case. Both scheduler admission orderings remain
tested: a user edit committed before background admission, and an edit queued
behind an already admitted background write.

## Verification record

These are scoped results, not a declaration of complete PR qualification.

| Check | Result |
| --- | --- |
| Provider/presentation affected suites | 206/206 passed across eight files; includes 11 built Host emission/Main/catalog cases and real React rerenders |
| Final task/group/recovery cohort after the short-reference correction | 59/59 passed, no skips |
| Existing controller coordination suites | 222/222 passed; ten unbound formatter comparisons remained byte-identical |
| Reconciled scheduler unit/regression cohort | 108/108 passed; the other 33 Host/Smart-schedule and fixture cases passed in the preceding integrated run |
| Integrated Host source build | Passed with pinned Node 24.21.0 and TypeScript 7.0.2 |
| Strict Host task-test project using unchanged canonical compiler options | Passed after explicit fixture narrowing |
| Strict scheduler/fixture project using unchanged root compiler options | Passed |
| Source-size, provisioning architecture and runtime-artifact guards | Passed; SchedulerService is 798 lines and no limits were raised |
| Touched TypeScript fast lint | Passed; scheduler retains two existing no-unsafe-finally warnings |

The broad pre-integration Host run completed 1,893 passing tests, two skips and
one failing newly added short-reference regression against the previous build.
That defect was corrected and the final rebuilt 59-case task cohort passed.
This does not convert the earlier broad run into an all-suite pass.

Complete root typecheck, the broad backend test run and an attempted smaller
backend batch were terminated by SIGKILL/exit 137; no successful full result is
claimed. A separate unchanged preparation suite passed 51/51, and read-only
inspection found no persistent polling loop; the cause of the larger process
termination is not established by that isolated success. Full strict/CI and
native Desktop qualification remain open. Original macOS Resume/Review and
intermittent Quit investigations continue with their existing owner and original
assertions. This batch does not merge #982, change provider pins, release or
enable Host by default.

## Continuation F: original project-launch attempt observation

Source baseline: published `116a85de003f8588eed4c0b247edcf4eb677646d`.
The original installer receipt (run `46031687475`, job `140616834073`,
artifact `15224217747`) rejected pending attempt
`d14ac75f-f381-4c97-acec-462e6f47f74a`. The current renderer creates an attempt
with `crypto.randomUUID()` and uses it in
`pending:<logical selection key>:<attempt>`. The Desktop project observer
instead requires a positive integer, while its three positive test fixtures
also use an integer. This is a confirmed observer-contract defect; that
receipt does not establish a native provider launch failure.

Publish this reviewed continuation before changing its implementation. The
frontend owner edits only `scripts/legacy-agent-host/desktop-created-project-selection.ts`
and its existing test file. Keep the existing production generator and all
launch, roster, owner, project, publication and capture identity assertions.
Do not alter polling, deadlines, cleanup or the native scenario.

1. Replace the numeric suffix check with the canonical lowercase UUIDv4
   shape produced by `crypto.randomUUID()`, including version and variant.
2. Use generated UUIDs for the three positive pending fixtures and cover the
   exact rejected original receipt value. No production imports or new loader
   are needed in the plain Node test.
3. Replace a pending attempt with a different valid UUID and require the
   original-attempt identity error, so malformed-input rejection cannot hide
   loss of the identity fence.
4. Reject numeric, malformed, wrong-version, wrong-variant, noncanonical and
   trailing-data/whitespace suffixes, the separate legacy startup-sweep value,
   a foreign logical selection prefix, and a pending
   ID presented as a published runtime ID. Preserve disappearance, rollback,
   foreign execution/launch/roster and immutable-capture cases.
5. Run the existing observer suite against a checked current Host build, the
   canonical scripts typecheck and affected formatting checks. Independently
   inspect the exact diff before publishing. The original installer journey
   remains a separate required native result; the observer suite cannot stand
   in for it.

Estimate: 1-4 changed observer lines and 45-80 regression lines; complexity
2/10, confidence 10/10, reliability target 9/10. No new abstraction, durable
format, dependency or product API is introduced.

Review: R1 traced the production attempt generator, both pending assignments,
the observer and the original retained receipt. R2 independently checked the
same source contract and required a different valid UUID in the replacement
case. R3 independently confirmed that no production caller supplies a legitimate
numeric attempt to this Host observer and that the separate legacy startup-sweep
producer is filtered from its Host key. It required explicit whitespace
negatives and retention of the identity and publication fences. All three
reviews are reconciled; the plan is approved for implementation after publication.

F was published before implementation as `f9aa8ef1`. The new regressions failed
against the original numeric validator, then all 30 observer cases passed after
the one-line correction. The canonical `typecheck:legacy-host-scripts` passed
with the pinned Node/compiler and unchanged options. Root reviewed the exact
diff, including the assertion that a different valid UUID fails on original
attempt identity. This is scoped evidence, not native installer acceptance.

### F.1. Reopen the original Team card while project tabs remain mounted

The existing `desktop-emulated-selection-ui.ts` `openTeam` lookup uses only
`data-team-name=<captured logical key>`. A per-project detail wrapper has the
same attribute, and `PaneContent` deliberately retains inactive Team tabs in
the DOM. The original `scrollTo` helper requires exactly one match before its
visibility check. Therefore a visible Team card and retained hidden detail
wrapper make that lookup ambiguous. A diagnostic using the existing DOM
implementation returned two original-selector matches and one card-role match.
All six relevant source files match the original Selection receipt's recorded
digests. This supports the source defect; the historical timeout's exact cause
remains an inference because its artifact did not retain the relevant DOM
attributes.

After this plan is published, change only the existing selector to
`[role="button"][data-team-name=<captured logical key>]`, as already used by
the membership journey. `ActiveTeamCard` supplies that semantic role; detail
wrappers do not. Keep the exact captured key, uniqueness requirement, owner
and project fences, focused-tab assertion, physical click and original
deadline. Do not add a first-match, display-name or visibility fallback, alter
the shared controls, or change production UI. Reuse the existing controls
regressions and canonical scripts typecheck; a new helper or a test that only
duplicates this selector is unnecessary. The original native Selection journey
must still pass separately.

Estimate: one changed script line, no production UI or test additions;
complexity 1/10, confidence 9/10, reliability target 9/10. R1 traced the retained
tab, card and unique-target lookup. R2 independently confirmed those source
contracts and that duplicate genuine cards must still be refused. R3 confirmed
the semantic card role and the two-to-one DOM diagnostic while retaining the
native-evidence limitation. Reviews are reconciled; implementation is approved
after this plan is published.

## Continuation G1: protect new credential-command fingerprints

The existing credential command journal retains a fast SHA-256 fingerprint
of the canonical command, including `credential.set.key`. The accepted key
can be one character. Disclosure of that private receipt therefore provides
a cheap offline guess check for a weak key even though the plaintext key is
omitted. This is a confirmed source-level issue. The unresolved CodeQL #628
discussion also covers other derived credential witnesses; G1 does not claim
to close all its flows or erase historical records.

Keep generic `managementDigest` and all existing identity bytes unchanged.
Reuse its canonical serializer by exporting that existing function. Add one
narrow `management/secretFingerprint.ts` helper for asynchronous scrypt and a
strict, fixed-version salt descriptor. New `credential.set` records receive
`fingerprintKdf: { version: 1, salt: <32 lowercase hex characters> }` alongside
their existing 32-byte hexadecimal fingerprint. The salt is 16 random bytes.
Use `N=32768`, `r=8`, `p=3`, `maxmem=64 MiB` and 32 output bytes. These are an
[OWASP-listed scrypt tradeoff](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)
supported by the pinned [Node crypto API](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
No dependency or runtime pin changes are needed.

The helper permits one active derivation, at most eight waiting requests and
at most 8 MiB of retained canonical input buffers. Reject saturation before
claim or native effect. Do not derive in polling, lookup, pending reads or
readiness currentness checks, retain a synchronous fallback, or persist a
parallel fast fingerprint of the secret. Compare derived digests with the
existing fixed-size input validated before constant-time equality.
Keep this helper a leaf: it may use crypto, the descriptor schema and existing
canonical serializer, but must not import `commandRecords` back. The owner
maps helper saturation/validation errors to its existing command errors.

### Preserve original command and namespace ownership

1. For a new set, parse and validate the command, check current owner/target,
   and read the original command ID. Reserve the existing native namespace
   fence before asynchronous derivation.
2. After derivation, check current owner and exact target again, then reread
   the command ID before writing. Another resource may have claimed the same
   ID during the await. Refuse that conflict without replacing its record or
   dispatching a second native effect. Reread, claim and write have no await
   between them. The durable claim still precedes `perform`.
3. Failures strictly before the first claim-write attempt release only this
   operation's transient reservation as settled. A revoked context or
   saturated queue must not leave an invented durable hold. Once the claim
   write is attempted, an exception may follow an already committed rename:
   retain the namespace hold, do not perform, and do not rewrite that unknown
   receipt. This also fixes the existing initial-write catch that could admit
   another command in the live owner despite a durable held claim. Preserve
   the subsequent native settlement behavior.
4. Replay and retained resume select the algorithm and salt only from the
   original validated record. After awaiting the derivation, recheck current
   owner/target and reread the record. Its immutable fields, salt and
   fingerprint must match; phase and native progress may have advanced.
   Return that latest original receipt without writing or performing again.
5. A record without the descriptor uses its exact existing legacy algorithm
   for comparison only. Do not migrate, rewrite, downgrade or retry an
   ambiguous receipt. Unknown/malformed descriptors fail closed. The optional
   descriptor is valid only on `credential.set` and stays private.
6. `resume` becomes asynchronous internally; the existing transport handler
   already accepts its Promise. Update direct tests/call sites accordingly.
   Forget, refresh, OAuth and the generic identity algorithm retain their
   current behavior in this slice.

Expected source files: `management/identity.ts`,
`management/secretFingerprint.ts`, `management/commandRecords.ts`, and
`management/CredentialCommandOwner.ts`. Reuse the existing credential,
identity and command-store suites; add focused helper regressions. Cover a
one-character synthetic key, absence of the old fast fingerprint in a new
receipt, salt stability through cold replay, changed-secret conflicts,
cross-resource same-ID races, context revocation during derivation, queue
saturation, corrupt/unknown descriptors, read-only lookup and byte-preserving
legacy replay. Simulate a claim write that commits then throws: no native
effect, the next same-resource command is held, and cold recovery retains the
original bytes. No real provider credential or native provider process is
needed. Run checked Host build, affected strict tests and existing suites.

Estimate: 220-320 changed production lines and 240-360 regression lines;
complexity 6/10, confidence 9/10, reliability target 9/10. R1 traced the
durable command and native-effect order. R2 identified the new asynchronous
same-command-ID race and required the second read and exact retained-record
comparison above. R3 additionally reproduced the existing write-then-throw
fence defect and required the publication boundary and regression above.
R3 approved the revised exact plan, leaf-module boundary, fixed schema and
active-plus-queued resource accounting. All reviews are reconciled;
implementation is approved after publication.
Remaining auth/config/file witnesses and OAuth completion
are separate follow-up slices; private storage alone is not their remediation.

## Continuation I: show and recover the exact project execution

`ProjectScopedTeamDetailView` already passes the selected physical execution
and its logical Team separately into `TeamDetailView`. All three provisioning
banners discard the physical identity. The hook then reads activity from the
logical definition, which correctly has no running agents, and hides ready
progress. A finite reproduction using the actual hook and data selectors
confirmed that logical-offline plus exact-child-online yields no presentation.
The original membership receipt stopped at its unchanged ready-banner wait;
the source defect is confirmed, while historical causality and native
acceptance require the original journey.

Pass an optional `runtimeTeamName` through the existing Banner, Panel and hook.
The three `TeamDetailView` call sites supply it only for the Host logical and
physical pair already checked by the parent project context. Default it to
`teamName`, preserving existing shared and legacy behavior. Do not discover a
child from the selected global Team, its name, liveness or registry order.

### Keep progress ownership distinct from runtime evidence

- Logical `teamName` continues to own progress, errors, error clearing,
  dismissal and the original same-run spawn snapshot.
- In the split Host path, require the progress Team to be that logical owner,
  parse its published run safely, and match its execution handle to the
  explicit physical key. Foreign, malformed and synthetic pending progress
  must not throw in React or become another project's success. Logical-only
  pending presentation remains unchanged.
- Physical activity and product members require the physical current-runtime
  pointer to equal this run. Runtime entries additionally require their own
  snapshot Team and run to match. A newer pointer does not validate an old
  snapshot. Accept logical spawn statuses only with the same-run snapshot.
- Hide ready progress when the physical run is not current or that execution
  is explicitly offline. Keep matching assembling and failed/no-allocation
  progress visible before physical hydration, without borrowing old runtime
  data. Member diagnostic payloads identify the same physical Team and run.
  The progress block's Team key also invokes `getLaunchFailureDiagnostics`;
  it is not merely a label. Return a resolved diagnostic Team from the hook
  and pass that validated physical key with the exact run to the block.
  Existing backend family/run validation remains authoritative.
- Preserve the captured run used by Cancel. Include both Team identities and
  local epochs, the context epoch and original run/start identity in the
  presentation instance key, so a new project does not inherit old dismiss or
  retry-completion state.

The transient `hostProjectProgressOwners` request proof is not a persistent
render authority: a later poll can invalidate its read token while duplicate
progress keeps the old object. Use the verified parent identity and exact
current run boundaries above, without adding another registry/read layer.

### Adapt the existing failed-member retry

Extend `createHostFailedMemberRetry` with an optional logical
`provisioningTeamName`, defaulting to its existing `teamName`. Keep the latter
as the fixed physical dispatch target. Require the logical provisioning and
runtime pointers plus the physical runtime pointer to equal the captured run.
A physical provisioning pointer may be absent or equal; a different nonempty
pointer refuses the action. Check both Team epochs and ignored-run sets, the
context identity/epoch, and the copied failed member generation/attempt before
the first operation, between members and after every await. Dispatch the
existing `restartMember` for the captured physical Team, never another child.

A new project launch invalidates the old logical run pointers and must stop
an old retry. Ordinary navigation alone does not select a new dispatch target;
an already admitted batch remains bound to its original run, and its completion
must not appear in the new presentation. Do not use a global selected-Team
check that breaks an independently open background pane.

### Scope and verification

Source scope is the three existing components, `useTeamProvisioningPresentation`
and `createHostFailedMemberRetry`. Expected changes: 104-176 production lines
and 180-300 regression lines. `TeamDetailView` has 3,640 lines with an existing
3,688-line cap; keep within it without changing the baseline. Complexity 4/10,
confidence 9.5/10, reliability target 9/10.

Use actual React rerenders and the existing retry harness. Cover logical
offline/physical live, absent child provisioning pointer, stop and recovery on
the same mount, project B progress while viewing A, a matching pointer with a
stale runtime snapshot, wrong-run spawn status, failed/no-allocation before
hydration, malformed pending input, legacy/shared behavior and stale callback
state. Retry cases must include both owners' pins/epochs/ignored sets, context
changes and a new launch between member actions, while keeping the original
generation/attempt and physical target. Verify that Copy diagnostics requests
the physical Team/run, navigation alone never retargets the old batch, and
an old completion cannot appear after the Panel moves to another execution.
Run affected strict typing, lint and
the source-size guard. Keep the native membership deadline and its following
session/process assertions unchanged.

R1 traced the actual component/store chain and reproduced the missing banner.
R2 independently required the runtime snapshot's own identity and preservation
of early failure diagnostics. R3 additionally traced the diagnostic action
and confirmed the navigation/retry distinction above. The independent final
review approved this exact written plan. Implementation is approved after
publication.

## Continuation J: retain exact password-hash flow locations

The existing CodeQL review reports eight `apiKey` paths into
`managementDigest`, but its current connector interface exposes neither the
scan analysis nor annotation details. The previous successful analysis has
no downloadable result artifact. Its original log confirms generated SARIF.
Use the next ordinary analysis's existing output to retain just the source
locations needed to review this known finding. Do not change queries,
permissions, analysis arguments, runtime versions, concurrency or deadlines,
and do not dispatch or rerun a workflow.

Add an ID to the existing analyze step. In its JavaScript/TypeScript lane,
project `sarif-output` into one explicitly named diagnostic JSON file using a
small `scripts/ci` helper. Upload only that file with the existing repository
`actions/upload-artifact@v4` convention and a short retention period. Never
upload raw SARIF, source snippets, messages, properties, database directories
or unrelated findings. This diagnostic does not replace the CodeQL result or
decide that the security issue is fixed.

Keep only `js/insufficient-password-hash` results, resolving a rule index
against that run's rules and rejecting a conflicting explicit ID. Resolve
location references, then accept only relative paths present in `git ls-files`;
exclude absolute paths, URLs, traversal and untracked files.
Decode URI escapes before checking traversal, reject query/fragment and drive
paths, and require every index/base reference to resolve unambiguously within
the checked-out repository. Unresolved selected-rule locations make the report
partial. Keep bounded
positive integer line/column values and result/code-flow/thread-flow/location
indices. Include actual checked-out Git commit/tree and workflow run/job/
matrix provenance; a PR head, when available, is separate from the analyzed
merge checkout.

Bound input bytes, files, result/flow/location counts and output bytes. Missing,
malformed, truncated or rejected required metadata must be explicitly
unavailable or partial, with structural counters. It must never look like a
complete empty result or successful security review. Do not print parser
exceptions containing input text. The optional diagnostic leaves existing
analysis success/failure semantics intact; inspect its completeness separately.

Scope: the existing CodeQL workflow, one focused JavaScript helper and its
Node tests. Estimate 80-140 helper lines, 20-30 workflow lines and 80-140 test
lines; complexity 3/10, confidence 9/10, reliability target 9/10. Test an actual
nested SARIF flow shape, rule-index resolution and conflicts, unrelated rules,
unsafe/untracked paths, malformed/truncated input, size/count bounds and
omission of planted secret text. No new dependency or generic SARIF framework.

R1 checked the official analyze output contract and the unavailable existing
artifact paths. R2 approved the metadata-only boundary and required explicit
partial status, source provenance and rule/reference validation. R3 approved
the exact plan with the decoded-path/reference guards and explicit partial
status above. Reviews are reconciled; implementation is approved after
publication.

### G1, I and J implementation verification

The G1 and I plans were published in `208353d1c084ad3ef87d7e342f76b9b4746fd2a3`
and the J plan in `fe4a80669d1f5976f5396b0805458f57823bfefe`, before their
respective implementations. Root source review and independent final review
approved the resulting changes. J review additionally found and corrected
explicit null indexed URI/base handling, malformed optional related locations
and invalid shared indices bypassing the visited-location count.

- G1: the checked Host production build and a strict scoped compile inheriting
  the Host test compiler options passed. Seven relevant suites passed **72/72**
  tests with no skips, covering real scrypt, bounded admission, original command
  replay, cross-resource claims, cancellation/currentness and an uncertain
  journal write. The original canonical digest remains unchanged for legacy
  records. The helper is 94 lines; production changes add 180 and remove 36
  lines across four files. Other credential/configuration witnesses and OAuth
  completion remain separate work; this is not closure of the full CodeQL
  finding.
- I: **118/118** tests passed across seven suites using real React/Zustand
  rerenders and the retry harness. These include the physical diagnostic API
  request, logical-offline/physical-live banner, early failure, stale project
  and runtime data, stop/recovery, navigation and both retry owners' fences.
  Fast lint passed with three existing `TeamDetailView` hook warnings, and
  formatting, source-size and provisioning architecture checks passed. The
  five production files add 127 and remove 34 lines, within the planned
  104-176 changed-line range; `TeamDetailView` remains 3,653 lines under its
  frozen 3,688-line cap. Regression coverage is larger than estimated because
  the diagnostic action and same-mount retry completion needed actual component
  tests. Native membership acceptance still requires its original run.
- J: **24/24** Node tests passed with no skips. Planted private text is excluded;
  unsafe or ambiguous references, failed analysis, bounds and missing input
  cannot become complete evidence. The CLI tests use an isolated TEST Git
  repository to verify source identity, dirty-source refusal and exclusive
  output creation. A parsed YAML comparison confirmed that removing the two
  diagnostic steps and the analyze step ID reproduces the original workflow
  exactly. The helper is 208 lines and tests 199 lines, above the initial
  estimate to keep bounded file reads, indexed references and provenance
  explicit; no framework or dependency was added. Actual analysis findings
  await the next ordinary CodeQL result and artifact.

The pinned Node 24.21.0 and existing TypeScript 7 compiler were used. Full root
type checking, the full Host test type check and the renderer scoped strict
check were terminated with exit 137 by local memory pressure; they are **not
passes**. The checked Host build used resource settings only
(`GOMAXPROCS=2`, `GOMEMLIMIT=600MiB`, `GOGC=50`), without changing compiler
options or dependencies. Current GitHub checks are still pending/queued.
F/F.1 additionally have 30 observer tests, 78 existing selection controls and
the canonical scripts type check passing; none replaces the original native
selection or membership E2E evidence. The existing PR remains open and the
remaining provider and recovery review continues.

After an execution-environment restart removed the temporary checkout, the
exact published `fe4a806` commit/tree was fetched again. All five I production
blob hashes matched the prior review. The restored Host build, G1 **72/72**,
I **118/118**, J **24/24**, the three architecture/artifact guards and the
CodeQL workflow semantic comparison passed again. Full canonical root type
checking was retried with the pinned compiler and still exited **137** without
type diagnostics; it remains unverified and is not replaced by these passes.

## Continuation G1b: OAuth completion identity and uncertain claims

The original OAuth completion stores a fast digest of the parsed
`{commandId, code: input.code ?? null}`. Pasted codes can be low entropy.
The existing transport already awaits the action, so the owner can prepare a
strong fingerprint asynchronously without a public protocol change. Limit
production changes to `OAuthOperationOwner.ts` and `commandRecords.ts`,
reusing the G1 helper unchanged.

Add a private optional `completionFingerprintKdf` using G1's strict version-1
schema. Require an original completion ID/fingerprint and
`completionMethod === 'code'` when present. New explicit pasted-code claims
derive with a fresh descriptor. Keep the exact canonical input and trimming.
Native/browser `code: null` completions remain secret-free SHA. Marker-less
legacy records retain their original comparison and bytes. On replay choose
the algorithm from the stored descriptor, never from completionMethod: a
code-capable native browser flow can legitimately have a marker-less null-code
completion.

### Admission and cancellation ordering

Before the first KDF await, reserve one pending preparation on the same
`ActiveOAuth` entry: exact parsed command ID/code, a shared result promise and
an always-settled signal. Identical private input joins the original result;
different input conflicts. Do not persist the pending object or create another
fast digest of the code. On every outcome clear only that pending token before
resolving its always-settled signal. This does not add a namespace fence or
release the running OAuth reservation on KDF busy/failure.

The browser observer waits for preparation settlement, without letting a
preclaim rejection enter its existing catch-to-stop path. After each settlement
it checks the *current* pending token again. If A fails and B starts before the
observer continues, it must wait for B. Recheck the same entry and original
deadline at each boundary; there is no await between the final no-pending/
currentness/deadline checks and a native completion claim. An explicitly
published completion keeps its original ID even if the browser result is
already available.

For a new live completion, after KDF recheck the current writer, seal, same
active entry and original target, and the original expiresAt even if the timer
has not executed. Reread the same operation, checking captured immutable
identity and its original waiting state with no completion claim. Missing,
replaced or already-claimed data refuses without overwrite or native effect.
Publish synchronously, then finish on the same native conversation. Do not
extend the deadline or reselect a native owner.

Cancel, expiry and close fence and close the original native conversation;
seal fences and aborts immediately as before. None waits for KDF. A late result
cannot publish, dispatch or affect the next operation in that namespace.

### Retained replay and uncertain publication

Before replay derivation, copy immutable operation/completion identity:
schema/kind, operation ID, profile/config/provider, start fingerprint,
selection/resource, method, original expiry, completion method, original
completion ID/fingerprint and descriptor. After derivation assert the current
writer and reread using the supplied original operation/profile/config.
Compare that immutable identity; allow phase, sequence, reason and held status
to advance and return the latest original snapshot. Preserve cold/terminal
replay after expiry and after a change to the currently selected profile:
replay must not call select/assertBound. It performs no native action,
migration or journal write.

A real isolated FileManagementCommandStore reproduction already confirmed that
completion write can rename successfully and then throw. Existing cleanup
rewrites the old entry.saved, removing the just-durable completion ID.
Add a narrow uncertain-completion-publication flag only when that completion
write was attempted and threw. Fence, abort and close the original native
conversation, but skip all later journal writes for that uncertain entry and
retain its namespace hold even if native close succeeds. Preserve the exact
original durable bytes. Prewrite KDF/currentness failures do not set this flag.
Do not change generic publish ordering or unrelated authorization transitions.

The initial start claim has the same source-confirmed release boundary:
its catch currently releases the live namespace even when the initial write
may have committed. Add a local claimWriteAttempted flag, set immediately
before the initial store.write. Failures before the attempt release the
transient reservation; an attempted-write exception retains the hold and
rethrows the original error. Never authorize or rewrite an uncertain initial
receipt. Before implementing this part, reproduce it with the actual isolated
file store, then retain a failing live/cold regression. This initial-claim
case has source evidence so far, not a completed runtime reproduction.

### Verification and scope

Use the existing OAuth/store suites and update the two direct complete callers
in opencode-management tests to await preparation. Cover real scrypt with a
one-character TEST code; trimming; fresh/stable descriptor; no fast parallel
digest; cold byte-preserving replay; changed ID/code; invalid descriptor; and
legacy/native null-code receipts, including completionMethod code.

Hold crypto deterministically to check identical joins, conflicting inputs,
browser success/failure, busy/failed preparation, the A-failure/B-admission
race, cancellation, expiry before the timer callback, seal/close, writer and
target changes, missing/replaced receipts and latest progress on replay.
Cleanup must precede crypto settlement and late callbacks must have no effect.
For completion write-then-throw verify actual native close, zero native
complete, unchanged disk bytes/ID/descriptor, and live/cold namespace holds.
For initial write-then-throw verify zero authorize, unchanged bytes and both
holds; a prepare failure before writing must remain retryable. Run existing
authorization, namespace serialization, rejection, expiry and shutdown tests.

Estimate 120-180 changed production lines in two files and 210-310 regression
lines. Complexity 6/10, design confidence 8.5/10, reliability target 9/10 pending
implementation, independent source review and tests. Start fields and other
credential-derived witnesses remain separate review work.

R1 approved the narrow owner/schema scope and required cold replay without
current-profile reselection. R2 reviewed the written plan and uncertain-write
rules independently. R3 required the repeated current-token check and its
A-to-B regression; R2 approved that refinement and the initial-claim addendum.
The reviews are reconciled; implement only after this plan is published.

### G1b original-receipt conflict refinement

Independent implementation review found that merely refusing a changed original
receipt does not prevent later cleanup from writing the old in-memory snapshot.
Keep a separate private `receiptConflict` fence; it is not an uncertain-write
flag. If fresh completion preparation observes a missing or replaced original,
fence that entry, close its original native conversation, skip subsequent journal
writes and retain custody. An immutable-identity mismatch observed by retained
replay fences only the non-retired original live entry, without native action
from replay itself. Later native completion or cleanup must not overwrite the
observed bytes. Validate the caller's original completion ID first; an incorrect
ID or code against a coherent receipt must not fence a legitimate operation.
A retired entry with uncertain publication keeps its existing handling.

After asynchronous preparation, check the original writer/entry without side
effects, then reread and compare the original receipt, then check the original
deadline, and only then publish, with no await in this sequence. This order
prevents deadline cleanup from replacing a receipt that changed while crypto was
pending. Regressions must inspect bytes after native completion, close and
cleanup, including missing/replaced receipts combined with expiry before the
timer callback. The initially source-confirmed start write-then-throw and live
replay mismatch now also have real failing filesystem regressions before their
fixes. Final passing evidence is recorded after the implementation checks.

## Continuation P1: bounded Runtime input admission before product publication

Status: reviewed before implementation. R1d reconciles the author review, root R2 and independent frontend R3. Source audit: fe4a80669d1f5976f5396b0805458f57823bfefe; the integration base is now 3e78bf6f332f66975fc39305fcc44d898cc25efd, preserving concurrent G1/I/J, task-inventory paging and CodeQL diagnostic validation. The incoming seven files do not overlap this production manifest. No P1 production changes or P1 tests have run; this publication records the implementation contract, not a readiness claim.

### 1. Confirmed defect and existing bounds

The current Team accepts message text by JavaScript string length (up to 1,000,000 units), formats it, writes an inbox row and a pending outbox, then marks the Team command completed. Runtime lookup/admission later rejects UTF-8 content above its default 64 KiB. Thus 30,000 CJK characters (90,000 UTF-8 bytes) can become a permanently held delivery after product effects.

Sources: team/validateTeamCommand.ts:13–15; team/executeTeamCommand.ts:94–217,219–267; team/commitTeamMessage.ts:30–37,75–95,105–123; runtime/RuntimeOwner.ts:58–59,276–303; runtime/runtimeDelivery.ts; team/DeliveryRecovery.ts.

| Boundary | Current evidence | Decision |
|---|---|---|
| Frontend message/comment length | src/shared/constants/teamLimits.ts: MAX_TEXT_LENGTH=50,000 JS units; MessageComposer uses trimmed .length | Keep this contract, including Unicode. |
| Common captured Runtime profile | composition/runtimeProfile.ts:37–54 permits inputBytes up to 8 MiB | Reuse this existing upper bound for the generic Host envelope; do not invent 512 KiB. |
| OpenCode | runtimeProfile.ts:165–173 caps inputBytes at 256 KiB; pinned old-provider-implementations@56afd245.../v2-input-validation.ts:28 enforces final UTF-8 text <=256 KiB | Preserve exact captured bound and pinned transport. |
| Runtime queue | 128 admitted/active inputs by default; old 64 KiB each implies at most 8 MiB original text | Preserve count128 and explicitly enforce aggregate8MiB when Host raises its per-input envelope. |
| Runtime state | FileRuntimeStore.ts:206–215,284–286:16 MiB serialized state with512KiB settlement reserve | Do not increase either limit. |
| Public command receipt | boundProductCommandReceipt.ts:10:768KiB projection | Keep; this is not a native-delivery budget. |
| Attachments | Existing refs/count, message batch20MiB, and provider-specific media budgets remain separate | Do not count binary/base64 media as text or increase media budgets. |
| Cross-team frontend parity | Five Host/Main input/output/MCP checks currently use48,000 units although the shared composer allows50,000; private intent JSON is capped96KiB | Align all five with one50,000 contract constant and use the existing240KiB envelope as the private intent cap, plus an independent exact public-row fit check before publication. |
| Cross-team readback | Existing page240KiB; MCP result256KiB; whole rows only | Preserve both output caps and cursor protocol; use the same paged wrapper and +256 continuation reserve to prove a new row fits. |

There is no production app literal default inputBytes to raise. readTeamHostProfile parses the pinned private profile; resolveRuntimeRecipe clones its exact seed/template, and all provider adapters forward profile.limits unchanged. The8192/65536 literals found by local rg are finite TEST fixture/profile writers. A new parity regression supplies an explicit capable profile; retained profiles and original qualification fixture limits must not be rewritten.

### 2. Small shared policy and original identity

Reuse existing contracts rather than introduce another owner or facade:

- Add a private synchronous TeamInputPreflight function type in existing team/ports.ts. Its argument is Pick<ImmutableDelivery, 'binding' | 'content' | 'attachments'>. Return true/false for the known content-byte fit only; stale identity, missing original material, or authority errors retain their existing exceptions. This distinction lets fresh task size failure become TaskPolicyRejected without converting an uncertain failure into a false rejection.
- TeamOwner retains this one readonly callback; createFilesystemTeamOwner forwards it; TeamHost injects its existing runtime closure. A standalone composition without the Host callback retains the existing64KiB technical default.
- RuntimeTeamCoordinator resolves the exact captured MemberEntry by binding/run/member/generation, asserts the original writer/current capture, and calls one focused input projection helper. No display-name lookup, selected-team fallback, native open, Runtime mutation, await, new persistence, queue, or cache.
- Keep the generic RuntimeOwner default compatible. The Team Host composition explicitly uses the shared common8MiB envelope and8MiB aggregate queued-text cap. Honor min(common maximum, entry.profile.limits.inputBytes) for each captured receiver. The OpenCode schema remains256KiB.
- RuntimeOwner uses the SAME readonly predicate through a small optional fresh-input hook in its existing options. Invoke it only AFTER findRuntimeInput confirms there is no existing input and BEFORE queue/state writes. Do not put content validation inside authorize('admit'), which runs before identity lookup and would incorrectly re-resolve attachments for an already-admitted replay. Current authority checks still run as today. Read/lookup/fingerprint/cancellation of retained intent must not acquire a new current-profile content restriction; original receipts remain inspectable and cancellable.
- Extract the coordinator's existing deliveryPort boilerplate into one small function so its799-line source can shrink before adding this delegation. TeamOwner is797lines; the readonly callback/type/assignment wiring must fit <=800. Do not raise any size baseline or add exceptions.

The callback validates the immutable original intent, not a reformatted replacement. It never changes a fingerprint, receipt identifier, generation, native session selector, or captured profile.

### 3. Publication boundaries

#### Ordinary, rich and native messages

For a genuinely new command, derive exactly the same actor, recipient role, effect messageId and cross/group context as commitTeamMessage, call formatTeamMessage, and validate the projected native content before executeTeamCommand's first receipt write at217. Skip native-budget validation for a human inbox-only recipient or Host-owned /cost response.

Keep the completed/rejected replay branch before new preflight. commitTeamMessage also validates an original continuation before its inbox write, but a retained uncertain receipt stays held on failure; it is never retroactively labeled not applied. A retained90kB intent may recover unchanged if its original captured provider supports it after the generic64KiB bottleneck is removed.

#### Tasks, mentions, edits and clarification

TaskEffectPlan already runs canonical Task policy in a detached snapshot. This is the right source of exact notification bytes, including task starts, edits, comments/mentions and clarification answers.

Extend the existing TaskMutationPort.prepare with a synchronous notification-validation callback. After target snapshot creation at230, derive all notifications currently calculated at269 and validate every recipient with a captured native binding before any stage-file write at247 or durable plan write at285. Validate the whole batch first; an overflowing later recipient must not leave earlier notifications applied.

TaskRecovery supplies the captured taskRecipients bindings. A fresh known size failure raises existing TaskPolicyRejected, so the existing product-preimage check produces a rejected command with unchanged board, inboxes and outboxes. Other exceptions retain hold semantics. Loaded original plans get a hold-only validation before task obligations, retraction proof/outbox changes and mutations.publish. Do not reconstruct or rewrite original plan bytes.

Offline members without a native target still receive the existing product-only behavior; arbitrary long non-notifying task fields are not reduced to a message byte limit.

#### Cross-team

The new intent must pass exact crossTeamInboundText and captured target policy before TeamCrossTeamCommands writes the source receipt, before cascade.record, target.receive, sender copy or source outbox append.

The existing96KiB serialized-intent cap also blocks plain50k CJK; changing character checks alone is insufficient. Reuse a shared240KiB byte budget, derived from the existing unchanged page envelope, for the private intent. Separately extract the exact public outbox-row projector from createHostCrossTeamComposition into existing crossTeamRecords, preserving field values/order and bytes. Before first source write, measure both JSON.stringify(intent) and the projected row within the SAME empty paged wrapper plus the existing +256 continuation reserve. The row must remain readable as a one-row page after history grows. Do not infer public row size from raw text or private intent size.

Keep page240KiB, MCP256KiB, row-count bound, cursor signing/protocol and revision/fingerprint serialization unchanged. Plain50k CJK plus ordinary metadata fits; a combined payload with maximal refs/summary or pathological JSON escaping in the body (for example, 50k non-NUL control or unpaired-surrogate units) may still refuse before any effect. No truncation or split-row protocol is introduced.

The new row-fit gate applies only when creating a fresh original source intent. Completed lookup/replay does not rebuild or recapture it. The larger structural read bound accepts prior96KiB records without altering their bytes; existing incomplete96KiB originals retain their authoritative continuation. Existing cursors for unchanged rows must still work byte-for-byte. Do not run a new current-profile or per-command content policy merely to read old history.

Important authority constraint: existing target.assertOriginal calls CrossTeamPairAuthority.assertTarget -> assertSource, which REQUIRES the source receipt. It cannot run before source publication. Add a narrowly separate readonly target preflight which compares authority.target(...) with the captured target and checks content. Call it inside createOriginalIntent. Do not weaken assertSource/assertOriginal or treat a successful preflight as delivery authority. The existing authoritative continuation checks remain.

#### Group fanout

Group envelopes currently serialize the complete physical message (including text) and then append the raw text. A50k-unit CJK body is therefore about300kB. Preserve those exact bytes/fingerprints: capable Claude/Codex profiles can accept this; OpenCode256KiB must refuse the whole send before publication.

Reuse existing private GroupChatRun/HostGroupRun with a readonly captured inputBytes bound, supplied for Host runs by readGroupRuntime. For provider='host', absence, a non-safe-integer, non-positive value or value above the common bound must refuse with no fallback. Capture the full original entry.profile digest privately and compare it in isCurrent; today's runKey covers binding/config/sessionRef but would miss an in-place limits change. Keep runKey and all persisted fingerprints byte-identical. Inside createTeamGroupChatsFeature, build the canonical row and every exact physical row with one reused constructor (same timestamp, physical ID, recipient name, runKey and metadata). Validate EVERY Host receiver's groupInboundText before default registry save and canonical human inbox save, and before any fanout. Recheck existing currentness as today.

Change groupInboundText's parameter to Pick<CapturedGroupIntent,'message'> if necessary; formatting stays byte-identical. This route needs no new GroupCommands/createGroupCommandAccess/createTeamCommandAccess plumbing. Do not add a new wire rejected phase: existing private prepared/held source receipt behavior remains, while the caller gets the original failure and no canonical row, default group creation or partial fanout is published.

### 4. Exact attachment and context order

Existing order is:

Team format -> immutable Runtime original -> optional Runtime context prefix -> claimed-input attachment decoration -> provider submit.

createMemberAttachmentPort.ts:95–125 performs a second text transformation: unsupported/native-ineligible file attachments become an agent block containing exact filename, saved artifact path, size and digest. Measuring only raw message text, attachment metadata length, or the number of refs is insufficient.

Extract only this existing side-effect-free batch route/projection into composition/projectMemberInput.ts. Reuse the existing getMessageAttachmentRoute, strict UTF-8 decision, owned artifact metadata and bytes, decorateFileReferences and wrapAgentBlock. Validate the complete original owner/purpose batch. The actual claimed-input wrapper retains all existing phase, binding, inputId, operationRef, attached-session and Team delivery-authority checks.

Use the same projection for fresh Team preflight and for context budgeting. Add original attachment refs to the private transient InputPreparationRequest; do not persist another representation.

createTeamContextPreparation must compute:

maxPrefixBytes = min(64KiB, min(common8MiB, captured inputBytes) - byteLength(projected original content)).

It must validate projected original content even when there is no pending epoch. Existing TeamContextReminders already honors the offered budget: it may omit advisory board/roster snapshots according to its current policy, then refuses if mandatory instructions do not fit, before writing preparation/claim or submitting to native.

No fixed192KiB original-content cap and no unconditional64KiB reservation are needed. A fixed reservation would unnecessarily reduce capable-provider parity and break small explicit profiles. Do not invent a future prefix at command admission. New context epochs/instructions can arrive after a command is queued; they are checked at the existing pre-claim preparation boundary. That existing safety hold is distinct from knowingly accepting an input that cannot fit its selected provider. Do not claim this patch guarantees that every future context condition can be anticipated.

Keep the current prefix+raw nativePayloadHash/preparation proof semantics. Attachment projection remains later and separately tied to original refs. Native slash commands retain byte zero and skip the context prefix as today. No original text, standing instruction, task reference or attachment content is truncated.

### 5. Queue and recovery semantics

Add a validated optional maxQueuedInputBytes to RuntimeOwnerOptions. The Team Host sets8MiB explicitly. Count only admitted/active original text under the same member fence as the existing128-count check. Reject additional admission with existing busy before tx.put when either budget would be exceeded. Existing input identity lookup precedes these capacity checks so a full queue cannot break replay. Terminal/rejected inputs release this active-text budget; persisted history remains governed by the unchanged FileRuntimeStore ceiling/reserve.

Update the private prepared-input read validator's current256KiB ceiling to the same existing common8MiB bound, or newly valid capable-provider proofs would fail on cold read. Per-captured-provider checks still enforce smaller limits; this does not change OpenCode's transport.

Transient queue saturation continues through existing delivery recovery. A permanently too-large NEW command refuses before product effects. Existing partial/unknown records remain held; no automatic rewriting, truncation, resend with a new ID, or fabricated not-admitted result.

### 6. Minimum production manifest

All paths below are relative to packages/legacy-agent-host/src unless shown as src/features.

| Files | Purpose |
|---|---|
| runtime/contracts.ts; runtime/runtimeDelivery.ts | Shared technical bounds, optional queued-byte setting, pure fallback byte predicate. |
| runtime/RuntimeOwner.ts; runtime/inputPreparation.ts | Aggregate admission; transient attachment refs; cold prepared-input bound. |
| composition/runtimeProfile.ts | Reuse common8MiB constant; preserve OpenCode256KiB. |
| composition/RuntimeTeamCoordinator.ts; new composition/runtimeDeliveryPort.ts | Captured-entry delegation and small extraction of unchanged existing delivery-port behavior. |
| composition/TeamHost.ts; team/ports.ts; team/TeamOwner.ts; adapters/team/createFilesystemTeamOwner.ts | One clean synchronous preflight callback and task preparation callback. |
| team/executeTeamCommand.ts; team/commitTeamMessage.ts | Exact new-message preflight and conservative original continuation guard. |
| team/TaskRecovery.ts; adapters/team/TaskEffectPlan.ts | Validate whole notification batch before staged/durable/product effects. |
| new composition/projectMemberInput.ts; composition/createMemberAttachmentPort.ts; composition/createTeamContextPreparation.ts | Reuse exact file-reference projection and correct prefix remaining bytes. |
| cross-team/HostCrossTeamCoordinator.ts; composition/createHostCrossTeamComposition.ts; cross-team/crossTeamRecords.ts; cross-team/pageCrossTeamOutbox.ts | Pre-source readonly target check, byte-identical shared public-row projection and exact admission/readback fit proof without weakening durable source authority. |
| composition/readGroupRuntime.ts; group-chats/createTeamGroupChatsFeature.ts; group-chats/groupDelivery.ts | Captured group receiver budget and pre-publication whole-fanout validation, unchanged formatting. |
| cross-team/contracts.ts; cross-team/validateCrossTeamIntent.ts; mcp/crossTeamTools.ts | Single cross-team50k contract constant for Host/MCP. |
| src/features/agent-backend/contracts/crossTeam.ts; src/features/agent-backend/main/adapters/input/crossTeamValues.ts; src/features/agent-backend/main/adapters/output/projectCrossTeamResult.ts | Public contract re-export; Main accepts and reads back complete50k messages. |

Total:31production files, two new focused helper files. Most existing files need1–15lines of wiring or checks. Estimate360–520added/changed production lines, including100–140moved lines; no new state owner/framework/schema migration. The four publication owners explain the file spread. If an implementation needs additional production paths or changes any public identity/receipt semantics, stop for another plan review.

Tests: approximately650–900lines across6–9focused files using existing real filesystem/Host fixtures, not a second fake policy implementation. Complexity7.5/10; source-design confidence8/10 before finite reproduction.

### 7. Verification gates

First reproduce the reported30k CJK failure against the original built code using a new TEST-only capable profile and controlled provider. Then make focused regressions fail before production edits and pass after the change.

- Direct messages: ASCII, Cyrillic, CJK and emoji;30k CJK and50k JS-unit edges; exact byte-for-byte provider content once, not merely a completed Team receipt.
- Final formatted boundary±1 with action mode, summary, task refs and reply context. A fitting raw body with oversized envelope must refuse before initial receipt/inbox/outbox.
- Explicit smaller profile, changed generation and changed captured profile must refuse without choosing another receiver. Human inbox and Host /cost controls remain unchanged.
- Real TaskEffectPlan update title, task start, mention/comment and clarification-answer overflow: unchanged task/version/order/inboxes; zero task plan/stage, outbox or retraction effect. Test a later overflowing recipient to exclude partial batch publication; loaded partial originals retain hold.
- Attachment native vs saved-file routes; Unicode/escaped filename/path; strict UTF-8 route; exact decorated boundary; same refs after reopen. Binary budgets remain unchanged.
- Pending context plus file-reference overhead: the offered prefix budget uses actual projected bytes, no native submit occurs if mandatory context cannot fit, proof/hash bytes remain unchanged, slash command byte zero is preserved.
- Cross-team: source receipt/outbox, cascade, target receipt/inbox and sender copy unchanged on overflow;50,000units accepted/read back on a capable profile,50,001refused; exact private-intent and public-row paged-wrapper boundary±1; maximal combined metadata and a pathological JSON-escaped body refuse before effects. A near-limit new row remains whole and readable after another row forces pagination; original replay never duplicates. An original cursor over unchanged old rows must yield the same page, with identical old revision/fingerprint/cursor bytes.
- Group:50k CJK accepted unchanged on a capable Claude/Codex profile; same payload refuses before canonical/default-group/fanout effects on OpenCode256KiB; one insufficient receiver means zero partial publication. Missing/invalid Host bound and changed profile with unchanged binding/config/runKey also publish nothing.
- Queue:128 count and8MiB aggregate independently enforced; exact replay at full capacity succeeds; settled input frees active bytes. No state/reserve increase.
- Legacy completed replay bytes unchanged; original90k intent can recover unchanged when the original provider supports it; genuinely oversized/partial originals stay held and remain inspectable/cancellable. Cold read accepts legitimate new >256KiB capable-provider preparation.
- Existing message/Task/cross/group/attachment/context suites, canonical Host build/typecheck, source-size guard and relevant lint. No native CI dispatch/rerun or new deadline relaxation is authorized by this plan.

Potential test homes: new tests/team-input-admission.test.ts; existing runtime-owner.test.ts, task-notification-parity.test.ts, member-attachment-delivery.test.ts, runtime-cross-team-binding.test.ts, group-chats.test.ts, context-reminders.test.ts; existing Main cross-team projection tests for50k round trip. Extend shared fixtures narrowly instead of duplicating large setup.

Ownership: G1b management files remain provider-owned; I renderer files and external Mac's savedTeamModelProbe.ts/teamRoster.ts/TeamLaunchOwner.ts are excluded. Context preparation is touched only to correct this byte calculation. No currently active external owner of createTeamContextPreparation.ts has been confirmed; perform a fresh source/branch collision check before editing rather than inventing an additional approval dependency. No merge to main, release, default activation, native acceptance claim or immutable receipt rewriting.

### P1 read-only namespace refinement

Independent source review found that the reused TeamOwnerStore constructor
creates missing namespace ancestors, even though attachment metadata/resolve
only read completed original artifacts. A preflight must not recreate an
original namespace that disappeared after capture.

Add only a backward-compatible optional third constructor argument,
{ createNamespace?: boolean }, to adapters/team/TeamOwnerStore.ts.
When createNamespace is false, its existing ENOENT branch throws the existing
TeamOwnerError('hold') before mkdirSync. Existing constructors keep their
current default creation and symlink/directory checks. The extracted
projectMemberInput passes false; no alternate filesystem reader, cache,
MemberEntry state or new storage owner is introduced.

This adds one production path to P1: 32 total, approximately three lines beyond
the reviewed scope. Both independent R2 and R3 source reviews approved the
change. Before editing that source, reproduce the missing-namespace creation
through the actual existing constructor/projection boundary. Keep regressions
for a removed .host-owner directory and a removed Team ancestor, checking that
neither is recreated, plus an ordinary-constructor creation control and exact
existing attachment resolution. Test roots remain isolated TEST fixtures.

Fresh cross-team byte overflows use the existing invalid/rejected result before
source publication. The shared retained-intent validator keeps its conservative
hold behavior; no arbitrary identity/authority exception is relabeled. An exact
public-row boundary regression may exercise the pure fit helper when the
stricter private-intent envelope makes that particular public-only overflow
unreachable through the real Host.

### G1b retained replay projection refinement

Retained completion replay projects the latest validated durable original.
A private snapshot option preserves the existing live read/cancel presentation;
only replay bypasses that in-memory preference. A retired pending operation has
the existing held/unknown presentation, even while live read still reports its
ongoing cancellation. Replay performs no native operation or journal write.
Initial missing/corrupt receipt reads fence only a known active entry with the
same supplied operation/profile/configuration identity; a wrong caller selector
cannot retire an unrelated operation. The common completion-currentness guard
rereads the original receipt before deadline cleanup for explicit completion,
post-KDF publication and the browser observer. These narrow refinements passed
independent R2/R3 source reviews; final execution evidence follows below.

### G1b implementation verification

The final OAuth change preserves one native conversation and the original
operation/namespace throughout asynchronous code fingerprint preparation,
browser completion, cancellation and cold replay. New explicit-code claims use
the already reviewed bounded scrypt implementation and a retained versioned
salt; legacy and native null-code claims keep their original comparison rules.
The new regressions reproduced uncertain initial/completion writes and receipt
replacement before cleanup, including the combined deadline cases, before the
corresponding fixes.

An execution-environment restart removed the temporary checkout. The five files
were reconstructed over exact published base
`1e64ea3221a6a943baebf329662ffc04fd7f7a00`, independently reread in full, and tested
again. The canonical checked Host build passed. Strict checking of the eight
focused test files passed. All eight related runtime suites passed: **98 tests,
zero failures or skips**, including real bounded scrypt, original filesystem
journals and the late-cleanup regressions. The source-size and whitespace guards
passed. No earlier result was substituted for these reconstructed bytes.

Actual scope is two production files, 169 added and 39 removed lines, and three
test files, 358 added and 20 removed lines. The extra receipt-conflict/deadline
and replay-projection checks account for growth beyond the first estimate.
Independent R2 and R3 approved the final full source. This qualifies the OAuth
correction; current-commit CI, native application qualification and the separate
credential-derived witness/CodeQL investigation remain required. No generic
journal migration, alert suppression, main merge or default activation occurred.

## Continuation P1b: configured launch Restart retains its original preparation

Status: R1a approved by root R2 and provider R3; read-only design. No production edits. Root must publish this independently reviewed continuation before implementation.

### Confirmed failure and source chain

The first integrated P1 checked Host build passed. The new real Host fixture then passed initial configured Unicode delivery and profile refusal controls, but the configured Restart control failed: the 10-test cohort is 9 PASS / 1 FAIL, not fully green.

The finite diagnostic uses the existing `runtime-team-host.test.ts` fixture and controlled Session boundary. A fresh launch prepares model `TEST-P1-selected`, dispatches and settles the original CJK and emoji inputs, then issues the same authorized member Restart prepare/execute command. Prepare succeeds. Execute closes the original Session and writes the selected successor. It then returns `hold/unknown` before allocating the successor.

The actual journal has `memberActions[-1].phase = selected`, generation 2, and the new attempt `not-started`. Re-running the unchanged `validateLaunchPreparation` against those exact retained bytes yields `TeamLaunchError(hold, launch-preparation-corrupt)`. Original configured digest and successor digest differ because generation is part of the captured profile.

Evidence:

- `/tmp/TEST-pr982-P1-core-green.log`: first combined 9/10 cohort.
- `/tmp/TEST-pr982-P1-rekey-diagnostic.log`: exact failing operation and TEST journal.
- `/workspace/scratch/4f1e38400727/TEST-pr982-P1b-configured-restart-red.json`: durable local checkpoint of the journal, log, and exact relevant source/test files.
- Temporary journal-dump lines have been removed from the test; the strict failing assertion remains.

The relevant original path is:

1. `composition/executeMemberAction.ts` clones the captured profile, increments its generation, derives the successor binding, and records its new configuration digest. The original base digest, selected options, config revision, and context stay tied to the source.
2. `composition/transitionRuntimeMember.ts` proves original closure, publishes the selected action, installs the exact successor, and calls `launch.startMember`.
3. `team-launch/TeamLaunchOwner.ts` loads and validates the record before claiming the successor attempt.
4. `team-launch/validateLaunchRecord.ts` validates restore/action history, then the original preparation.
5. `team-launch/launchPreparation.ts` currently requires the current non-restore selected configuration digest to equal the original prepared digest. That equality is valid for the original generation; it is false after an authorized Restart.

These production files were unchanged by P1 except the unrelated Runtime/composition input admission wiring. The defect is independent of the new byte predicate.

### Required invariant

The original preparation remains immutable. Its command ID, option payload, source roster revision, fingerprint, configuration digest, base digest, and config revision are never rewritten to describe a later generation.

A current member may use that original preparation only when its own descriptor is either the original prepared member or an exact successor reachable through the retained, validated action/restore history. A later unrelated member, pending action, merely equal name, fabricated restore property, or changed source digest cannot authorize it.

The existing whole-journal validators continue to own action shape, action fingerprints, actor identities, source/selected binding scope, unique edges, cycle rejection, generation progression, checkpoint-specific proof, current selection, and publication phase. This change adds only the missing preparation-origin projection. It does not create a new journal or weaken those existing validators.

### Minimal implementation

Change only the private validation logic in `team-launch/launchPreparation.ts`. Retain the original option schema checks, preparation fingerprint, start-command identity, current selected base digest/config revision checks, and the exact selected Skip descriptor proof. The one redundant complete-chain call inside the preparation-only Skip branch is removed for the confirmed historical-segment case below; complete graph validation remains with the unchanged owning validators.

Replace only the failing current-generation digest comparison with a small bounded private helper:

- Begin with the exact current `ExpectedLaunchMember` descriptor already selected for this prepared member. Every inspected member must retain this original prepared member ID, base digest, and config revision.
- Before accepting an apparent original digest, follow any exact retained `phase === selected` action for this member whose **entire selected descriptor digest** equals the descriptor currently being inspected. Require exactly one such edge and use its entire original source descriptor as the next value. Both Restart and Skip edges are covered.
- Walk at most the existing action count; track consumed records. Refuse ambiguous/cyclic predecessors. Never select by name or accept the mere presence of an action.
- If no exact action matches, allow an existing qualified Restore boundary only when the **entire descriptor** equals an original `record.restorations[].member`, including its complete restore proof. A source merely containing `restore` is insufficient. Existing full restore validation remains mandatory.
- If an unconsumed selected action or retained restoration ends at the same binding but has a different descriptor, refuse. This prevents a forged intermediate source from borrowing the original prepared digest and terminating the walk early. Consumed Skip edges at the same binding are excluded from this mismatch check; a repeated exact descriptor still refuses as a cycle.
- Only at the actual original root, with no incoming retained selection to skip, accept the original prepared configuration digest. Otherwise refuse.

This preserves the current behavior for ordinary preparations and existing direct Restore while allowing the configuration-preserving generation transition that Restart already publishes. No native effect, allocation ordering, custody rule, deadline, retry policy, or action byte is changed.

#### Full validation and live history

Do not add a recursive call to the full chain validator from the new origin projection. The production owning load already calls `validateRestoreJournal` before preparation, and that validator calls `validateMemberSelectionChain` for retained actions/live history.

This matters for the existing live-membership path: `liveRosterValidationRecord` validates the complete live history, then `validateLiveLaunchPreparation` projects the **historical prepared segment** into a temporary definition before calling `validateLaunchPreparation`. Revalidating the entire final selection chain against that historical temporary definition would incorrectly refuse legitimate history. The pure exact-descriptor backwards projection can operate on that segment; the unchanged complete record still passes the owning full journal validators before any effect.

The reachable historical Skip case is also confirmed: a configured non-lead can Restart, Skip, be removed, and be restored through live membership while another lead remains active. `executeMemberAction` preserves the original descriptor with skipped=true; the live writer copies it into the original Remove/Restore source and later publishes a fresh descriptor. The original complete live/action/restore validators accept that graph, but the preparation-only Skip branch re-runs the final graph against the projected historical definition and refuses it. Keep its exact selected Skip atom proof and remove only that redundant whole-chain call. The owning complete validator still validates the actual final graph before effects.

A finite diagnostic built this graph through the real `createLaunchMemberActions` and `createLiveRosterLaunch` writers, starting from the exact saved Restart journal: both `validateLiveRosterLaunch` and `validateRestoreJournal` PASS, original preparation stays unchanged, and `validateLiveLaunchPreparation` returns `hold/launch-preparation-corrupt`. Artifact: `/workspace/scratch/4f1e38400727/TEST-pr982-P1b-live-skip-red.json`; reproduction script: `/tmp/TEST-pr982-P1b-live-skip-diagnostic.mjs`. This is source-contract evidence with controlled journals, not native qualification.

The helper itself is not a replacement for complete record validation. Tests asserting malformed history refusal must use the actual owning load wrapper `liveRosterValidationRecord(record)` -> `validateLaunchRecord(validatedRecord, fingerprint, memberCount)` as well as the focused helpers, not treat the preparation-only helper as an authority boundary.

### Scope and ownership

| File | Change |
| --- | --- |
| `packages/legacy-agent-host/src/team-launch/launchPreparation.ts` | One private preparation-origin helper and one comparison call |
| `packages/legacy-agent-host/tests/runtime-team-host.test.ts` | Keep the existing failing configured Restart assertion; extend exact successor/read/replay controls as needed |
| `packages/legacy-agent-host/tests/launch-preparation.test.ts` (new) | Focused full-journal valid/invalid lineage fixtures and immutable-byte controls |

Estimated additional production: 25–50 lines, one file currently 129 lines; no source cap relaxation. Estimated tests: 140–220 lines including reusable finite full-record fixtures and the Host continuation controls. If exact source proof requires another production path, stop and obtain a reviewed/published amendment before editing it.

Reserved external files remain read-only: `TeamLaunchOwner.ts`, `teamRoster.ts`, and `savedTeamModelProbe.ts`. No main merge, release, default activation, native acceptance rerun, or historical receipt rewrite.

### Meaningful regression gates

Before production change, add finite failing tests against the current checked dist:

1. The existing real configured Host Restart failure remains strict: original closes once, selected generation is exact, successor opens once and accepts the next original 50k CJK input. Keep completed original input replay effect-free and reject old-generation control.
2. A valid two-Restart chain retains the original preparation unchanged and remains readable through the full journal validator. A Skip at the end must preserve its own action proof.
3. Valid configured Restore -> Restart and Restart -> Restore history remains readable; the restore endpoint must be the exact original retained restoration descriptor. Include the reachable historical prepared segment ending in Skip and followed by live Remove/Restore as a compatibility control, using the complete owning validation path.
4. Missing selected edge, pending/refused edge used as a substitute, wrong-member/foreign-binding predecessor, changed original configuration/base/revision, duplicate/branch/cycle history, an intermediate source forged to equal the original digest despite a different incoming descriptor, and fabricated unmatched `restore` metadata remain held. Tests must preserve otherwise-valid fingerprints when appropriate so the missing origin join, rather than a trivial corrupted checksum, is what refuses the forged path.
5. The original preparation object and its fingerprint are byte-identical before/after validation, successful Restart, replay, and cold read. Cold reads/replays allocate nothing and never resend the old Unicode inputs.

After the narrow fix:

- Root-owned checked Host build.
- New focused full-journal suite plus existing `team-launch.test.ts` and `native-member-actions.test.ts` controls.
- All ten P1 Runtime/cold/Host tests; then the existing full `runtime-team-host.test.ts` cohort once root grants that test gate.
- Scoped strict compilation, changed-file lint, and existing source-size guard under root's sequential memory slot.
- Record exact results and distinguish controlled Session evidence from original native Desktop qualification.

### Review questions

R2/root and R3/provider should challenge:

- Can the helper accidentally accept a fabricated source.restore without an exact retained restoration atom?
- Does full descriptor equality preserve current field order and identity across selected action and cold JSON reads?
- Is validation of the historical live segment kept separate from validation of the complete final graph without skipping either?
- Can any existing direct prepare/read caller reach effects without the complete journal validation that the helper relies on?
- Are ordinary original preparation, repeated Restart, Restore composition, final Skip, cold replay, and malformed foreign chains all represented without changing deadlines or assertions?

## Integrated P1/P1b and OAuth continuation

The reviewed P1 implementation, canonical concurrent P1b implementation, G1c fixes, exact execution evidence and remaining gates are recorded in [the integration checkpoint](parity-integration-checkpoint.md). The G1c supplement was published before production in `d3db042`; the next reviewed source plan is [G1d OAuth start identity and cancellation](oauth-start-fingerprint-plan.md). These records preserve concurrent work and do not claim native qualification, a release or a merge to main.
