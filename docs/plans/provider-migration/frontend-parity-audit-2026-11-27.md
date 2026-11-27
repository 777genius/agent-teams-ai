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
