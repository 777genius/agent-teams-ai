# Goal composer preparation refusal — R1

## Status and placement

Proposed repository path: `docs/team-management/autonomous-goal-preparation-refusal-plan.md`.

This is an unapplied, source-reviewed candidate. It has not been formatted, compiled, linted or executed. The reviewed source is Goal 21259a92de9d19445671a6ac62dc3edabfaddac7. Official reads independently confirm that all three edited files are byte-identical on current Goal 185292238137130c9439774f26f6d51f7a63205b. That head merges 21259 with Stage 1 target 56746412a0bec3b38baa6fb43e4977545ef6c5b1.

Prepare this as an isolated Goal follow-up based on 185292, preserving parallel branch ownership. Do not apply it directly to #982 without Goal. Source publication requires the normal checked repository workflow and hooks. This document authorizes no CI control or native rerun. The historical d4b Task Board/Cross-Team failure predates Goal and is a separate investigation.

## Problem proved by source

An enabled composer can have a pending same-address working-draft synchronization: useComposerDraft.canSubmit requires loaded, not restoring, hydrated and the same address, but does not exclude the pending synchronization. useComposerDraftAttempt waits for that synchronization and then invokes the request builder against the new snapshot, before its attemptAddressKey, timer cancellation or repository.beginAttempt.

Two explicit builder policy refusals can arise there:

1. An unknown restored Goal R remains pinned in restoredOrigin.autonomousGoalRequest, but synchronized text/mode/options no longer match R. The builder refuses to replace the original.
2. An UNSENT Goal draft is stashed as displaced-draft. The real stash producer retains Goal in snapshot.content while its placeholder preparedRequest has no Goal. buildRestoredWorking therefore permits restoring this ordinary draft to an empty cross-team address, preserving options and leaving restoredOrigin undefined. restoreRecovery publishes a working event. A pending cross-team preparation can observe these valid restored fields and refuse Goal in a cross-team route. The separate rule prohibiting movement of an UNKNOWN original Goal remains unchanged.

Both refusals currently throw Error before the post-builder eligibility check. The existing submission owner awaits prepare in a finally-only block. MessageComposer chains then(feedback)/finally without a rejection handler. Thus these expected refusals reject the void promise and skip ordinary feedback, while transport never begins. Feedback currently displays not-sent/unconfirmed detail; blocked does not display a detail.

## Exact production change: two existing paths

1. src/renderer/components/team/messages/composerSendUtils.ts:
   - Add the nominal GoalRequestPreparationRefusal Error subclass.
   - Use it at only the two explicit policy throws above.
   - Preserve both messages, every original equality predicate, the full structuredClone(R), ordinary request bytes, message IDs, reply metadata and action-mode semantics.

2. src/renderer/components/team/messages/composerSubmission.ts:
   - Import the issuer's nominal class.
   - Add a typed catch around ONLY await prepare().
   - Only that class returns { kind: 'not-sent', attemptId, detail: error.message }.
   - Every other error, including ordinary Error with the same text, is rethrown.
   - Leave transport handling, durable settlement and the outer finally unchanged.

The prepublication guarantee comes from the CLOSED TWO ISSUERS before repository.beginAttempt, not merely from a null prepared variable or from the error's message. Do not use this class for storage, transport, owner or cleanup failures. The new return does not invent a messageId or durable attempt and must not call settleAttempt. The existing finally removes the repository's transient active flag and the same context latch. The preserved original remains available for a later explicit authorized retry. There is no automatic retry, Goal downgrade, current-profile substitution or weakened validation.

Class placement in composerSendUtils also preserves the existing MessageComposer test module mock, which replaces composerSubmission exports. No new production module, owner, queue or cache is introduced. MessageComposer and its feedback hook need no production change.

## Exact regression file and finite cases

Edit only src/renderer/hooks/useComposerDraftAttempt.sync.test.tsx.

This suite imports the REAL draft hook and REAL runComposerSubmission. Add the REAL builder, buildRestoredWorking and feedback hook. Do not claim that the separate MessageComposer.pendingSend suite covers the new catch: it mocks runComposerSubmission.

The finite repository port keeps its existing behavior by default but accepts a supplied initial record/address. All pending load/event operations follow that actual address, without mutating shared alice. Replace only its no-op active tracking with a Set-backed port and observable settleAttempt. Existing test cases/assertions remain.

Add five cases through two boolean parameterizations and one separate case:

- Restored R, unchanged after pending sync: transport receives a separate structuredClone of the ENTIRE R, retaining old messageId, summary and taskRefs. The UI attempt ID remains distinct.
- Restored R, changed text after pending sync: retain R in the synchronized content and change only text. Return exact not-sent/detail; the real feedback hook exposes that detail. No repository.beginAttempt, settleAttempt, currentness callback or transport occurs. The actual working record and original R remain intact.
- Ordinary cross-team draft after pending sync: exact previous cross-team request fields and UI attempt messageId, no Goal field, accepted once.
- The real displaced-draft restoration adds Goal content to that same cross-team address: call buildRestoredWorking on the actual stash-shaped record, including its empty-member/text placeholder request; validate the record. Return the direct-lead refusal, retaining working data, with no begin/settle/transport.
- An ordinary Error with the same restored-original message still rejects as the SAME error object; it must not become a user policy refusal.

Before releasing each pending gate, assert no durable begin, settlement, currentness callback or transport and both transient active states present. Afterwards assert the repository flag and module latch are released, and independently reacquire/release the actual same-context gate without dispatching another request. Assert expected refusals never settle a nonexistent durable record. No global unhandled-rejection suppression or changed timeout is added.

The first four cases also exercise the existing feedback hook from the actual submission result. These are controlled hook/submission tests with a finite repository port, not real native, IndexedDB, Host authority or Desktop E2E qualification.

## Source and count metadata

All source files use their exact retained LF text:

- composerSendUtils.ts: base Git blob 872e8d12120d4ab7c5867331983de5965ffd59c3; candidate 8593 UTF-8 bytes, 267 physical lines; SHA256 bfd8d349a9688e8008a8009ec5f2f80750bbfbbda352cb43ffb72088dbbfbe46.
- composerSubmission.ts: base Git blob c8bda2ae32ef519a8e92acaa35a7abf5dc29534e; candidate 5265 bytes, 139 lines; SHA256 9209dbf44281f9da67f1fc107596800f4db878b7acd9f34437ec8e5f1b9ac24d.
- useComposerDraftAttempt.sync.test.tsx: base Git blob f75545a0810a5444eb1727a303fbf39b924656f0; candidate 29286 bytes, 823 lines; SHA256 008c8c776f11f39aa0a2b55b08eddecfe27fdd1228a4c74f89b2d1cd480bab47.

The reported existing Goal production predicate is 101 paths, +3916/-372 relative to current Stage 1 target 567464. The new submission path makes 102. Exact text LCS of the two affected production paths gives prospective +3929/-373: 13 more gross additions and 21 lines of remaining allowance under the unchanged 3950 ceiling. This accounts for replacement of already-added Goal builder lines, rather than adding all patch insertions to the feature total. Both edited production files remain below 800 lines. The 823-line file is an existing test.

These are source-text counts, not an executed git/formatter/source-size result. Recompute the complete prescribed production predicate after formatting and integration. No cap or frozen-file exception changes are proposed.

## Qualification order

1. Re-read current Goal head, working-tree instructions and the three base blobs; preserve intervening work. Reconcile only a concrete overlap. Keep this as the isolated Goal follow-up.
2. Publish this reviewed plan at the proposed path through a normal checked docs-only commit on the isolated Goal follow-up, after independent R2/R3 source reviews. Complete normal hooks; include no implementation changes in that plan publication. Publish the plan before adding or applying the test or production candidate.
3. Add the test candidate against UNCHANGED production first. Its imports already exist in the baseline. Record meaningful RED for the two expected-policy pending-sync branches and the exact source/toolchain. The unchanged-original, ordinary cross-team and unrelated-error cases are positive/negative controls; they do not constitute native evidence.
4. Apply the two production hunks only after that baseline evidence. Run the real sync suite and the existing composer submission, pending-send, draft recovery/repository and continuation-control tests under their ordinary frontend test configuration and prescribed repository runtime. Do not run these against stale output or substitute Host Node for the frontend toolchain.
5. Run the affected canonical typing, formatting/lint and unchanged production-size predicate. Inspect final diff, SHA and counts; preserve all original assertions and bounds. If a test harness/type issue appears, correct that exact issue without relaxing the behavioral assertions.
6. Obtain independent final-source review. Then use normal checked publication/hooks for the Goal follow-up. Current integrated CI/Desktop/Host/native requirements remain attached to the exact resulting source. This source review itself supplies no runtime PASS.

At the source-review checkpoint, no compiler, test, native launch or external publication had been performed for this candidate. The executor was restored on 2026-11-28; the plan is now prepared for its normal docs-only publication before the regression or production edits.
