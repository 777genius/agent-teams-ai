# Autonomous goal completion: implementation and delivery

This is the executable implementation checklist for [the design](autonomous-goal-completion-plan.md), in existing PR [#1315](https://github.com/777genius/agent-teams-ai/pull/1315). The user authorized implementation, end-to-end testing, review fixes and eventual merge on 2026-11-27. That supersedes the earlier documentation-only authorization, without authorizing a release or merging parent #982 into main.

## 1. Fixed scope

- One explicit objective, submitted through the existing direct composer to the lead of an already running, ready Stage 1 team. Preserve Do and Delegate; exclude Ask, native slash commands, message revision, group/cross-team sends, launch, schedules, imports and saved templates.
- One Team-owned goal record, four dispositions, existing command receipts/outbox, existing Runtime input claim, existing Work Sync scheduler and task/review policy.
- Lead and teammates continue eligible work; two no-progress recoveries per obligation; shared conservative attempt cap and elapsed deadline; registered bounded waits; explicit Stop/Resume; settlement before final acceptance.
- Default off. Initial suggestion: 12 hours and 100 automatic input attempts. User changes are explicit. These are input attempts, not a monetary cap or a guarantee of finishing arbitrary work.
- No new daemon, scheduler, execution queue, provider framework, quota database, task board, transcript scorer, filesystem lock service or external CI connector. No hidden permission expansion or automatic retry of unknown external effects.

The normative acceptance cases remain G01-G17 in the design. This checklist explains where and how to implement them; it does not replace them with easier assertions.

## 2. Source and environment baseline

Implementation starts from parent `f3bbca99f4e1ed07009f60338c3ffdf6f15a91ad` and plan head `034f225f15a351e5613175d1863876d41aad8903`. Preserve the parent's context retention, immutable input preparation and usage changes. Bring that parent into this branch once before coding; never edit its branch as an intermediate development step.

The root repository Node version is different from the Host's captured native pin. Host supports Node >=24.21.0 <25; native acceptance pins 24.21.0 and TypeScript 7.0.2. Use existing dependencies, compile this checkout's Host/ledger output, and record the actual executable. Never run tests against another checkout's stale `dist`.

All execution fixtures use newly created `TEST-...` directories. Real user projects, existing user sessions and credentials are not test fixtures. Local controlled Session tests do not require vendor calls. Native Desktop evidence comes from its supported isolated harness; a finite localhost model is not a genuine model competence or overnight proof.

## 3. Concrete audit findings that determine the implementation

1. `NativeMcpAuthority.ts` permits original Do/task-start sources and rejects Delegate. Do not change Delegate to Do or broaden native helper permissions. Goal source capture must prove the original input independently for this narrowly scoped feature.
2. The native MCP connection currently exposes ordinary `owner.connect(principalId).execute`. Principal identity alone does not identify the input that created a task. Capture the exact active Runtime input once in `createRuntimeMemberProviderFactory.ts`, then pass private provenance to the Team owner. No model-supplied goal ID grants authority.
3. `TaskStartCause` only covers human task starts. Assignment/review/board notifications must inherit the goal from their actual originating receipt/task obligation. Charge each distinct delivery, including fan-out, not once per task command.
4. Runtime checks Team authority and then writes its claim after the Team fence returns. Add the smallest synchronous claim continuation that holds the existing Team authority fence around the durable Runtime claim, preserving Runtime -> Team lock order. No await under either fence.
5. Generic `deliveryAuthorized()` is also used to read historical source proof. New goal admission gates belong only on admit/dispatch. Stop, expiry and finalizing must preserve read/control and proposing-tool source proof.
6. A held first admitted input can strand ordinary user messages. Retire obsolete unclaimed automatic inputs by original cancellation/rejection; never solve this with a priority queue or by jumping over an active/unknown input.
7. Ordinary paired lead text is already visible through `team.messages.page`. Goal acceptance adds one authoritative original final publication, without hiding ordinary progress messages.
8. Existing Team Stop is a sequence of captured Runtime stops; it is not yet a goal latch. Close goal admission before those effects. Existing checkpoint Resume must not silently restart an objective or reset its limits.
9. `TeamOwner.ts` is at its 800-line ceiling; `MessageComposer.tsx` is frozen above it. Extract only cohesive touched behavior before adding delegation. Do not raise either baseline.

## 4. Data and ownership decisions

### 4.1 User-facing contract

Extend the original `message.send` with optional `autonomousGoal: { durationHours, maxAttempts }`. Validate finite bounded numbers in the shared backend validator and again at the canonical owner. The authenticated user, original lead recipient, ready current Runtime and allowed action mode are mandatory. The original text is the objective; no extra criteria editor.

Capture this object in `ComposerPreparedRequest` together with the original message ID/text/mode. Unknown transport outcomes replay that exact request. Draft saving does not execute it; successful submission resets the opt-in for the next message. Non-opt-in commands retain their old bytes and fingerprint.

Use one small public goal status: goal ID/revision, disposition, started/deadline times, attempt limit/used, actionable reason, and accepted result message reference. Readiness is Host-derived and advisory until intake revalidation. Never expose private principals, native operation references, raw receipts or owner paths.

Explicit goal control uses the existing captured backend operation facade and Team owner: Stop, Resume when supported, and absolute bound extension. Reuse the current Team Stop and original native Resume/custody rules. A small control in the existing goal status is sufficient; no new page or general transport.

### 4.2 Private record and original proof

Keep the goal in `OwnerState`. Derive its identity from the authenticated intake command, Team incarnation and original run lineage. Keep the current goal's bounded admission/debit witnesses with that record or original command receipts; never invent a separate quota store. Retain acceptance/publication identity until publication is reconciled.

Private receipt metadata records only the original goal/input association and necessary original continuation cause. Task membership derives from canonical task-creation receipts/metadata; deleted task history remains required until explicit authorized removal/replacement. Do not copy task contents into the goal.

Capture Runtime source outside Team's fence: exact binding, input ID, operation reference and immutable delivery fingerprint. Revalidate the original Team receipt/grant inside Team's fence. A goal-specific source proof does not grant unrelated native member creation, subagent or cross-team privileges.

Preserve optional-field absence when hashing historical receipts. Update `teamCommandFingerprint`, receipt validation and delivery authority together; retain current historical replay tests.

### 4.3 Durable attempt authorization

The debit key is the original delivery/input ID. One distinct goal-driven automatic input consumes one attempt before Runtime admission. Store debit witness and counter in one canonical atomic publication when possible; otherwise recover the existing prepared receipt before allowing another debit. A lock alone is not a multi-file transaction.

Replay never charges again; no refund for cancelled or known-not-sent attempts. Zero remaining prevents new authorizations but permits an already charged valid input before its deadline. Deadline, Stop/revocation and finalizing prevent new claims. In-flight work, original reads, cancellation and accepted-result publication retain their existing authority.

All goal-derived task/review/board/peer/recovery producers use this same gate. Inbox publication alone is not an input attempt. Authenticated human input remains the ordinary uncharged path. Unknown handoff does not mint a new identity.

## 5. Commit and push sequence

Each push contains a coherent bounded change with its focused evidence. Do not push every test iteration. Keep the PR draft until the integrated source and independent review are ready. Record actual SHAs/results in the delivery log below; unchecked items are not completed work.

### P0 - Detailed plan and current parent

- [x] Preserve the exact parent changes and existing documentation history in this branch.
- [x] Publish this checklist and update the original plan's authorization/status and discovered source details.
- [x] Update the PR description to implementation scope, with Summary and Test plan. Do not fabricate CLA agreement or passing checks.
- [x] Verify the P0 branch diff against current parent contains only the two intended Markdown documents.

### P1 - First real vertical slice: intake, source association, one continuation

Files to change: `team/ownerState.ts`, focused `team/TeamGoals*.ts` modules, `team/contracts.ts`, `validateTeamCommand.ts`, `executeTeamCommand.ts`, `teamCommandFingerprint.ts`, `commandEntries.ts`, `TeamDeliveryAuthority.ts`; narrow composition in `TeamOwner.ts`/`createTeamCommandAccess.ts`; `composition/createRuntimeMemberProviderFactory.ts`; `mcp` goal tool contract/registration only where needed.

1. Add bounded user intake and canonical goal readback, with original receipt replay and active-goal conflict.
2. Capture private original native source for product task/message commands. Keep ordinary commands unchanged when no goal association exists; do not silently fall back to an ordinary automatic route when goal provenance is invalid.
3. Propagate exact association through canonical task creation and notification receipts. Cover lead Delegate and solo Do without changing native helper authorization.
4. Add the narrow Team-owned continuation command on the existing message/outbox path. No public system sender.
5. Add the shared debit and actual claim gate required for this slice; no temporarily unbounded continuation.
6. Add the minimal final proposal/publication path needed to prove the complete identity chain; later commits extend fault coverage, not a disconnected alternate implementation.
7. Run the real Host walking slice: original human message -> scoped task -> native terminal -> one charged continuation -> lead proposal -> terminal/quiescence -> one final result.

Test home: `packages/legacy-agent-host/tests/autonomous-goal-host.test.ts`, with a focused reusable helper extracted from `runtime-team-host.test.ts` only where needed. Use actual `createTeamHost`, filesystem stores, NDJSON, HTTP MCP and controlled Session. Preserve the fixture's event order: `onProgress` after Runtime persists the event.

Gate before P2: original receipt, input/operation, task association, debit, claim and final result all line up; same-command replay adds no input. Record any real gap and smallest correction. Re-estimate actual scope here rather than introducing speculative adapters.

### P2 - Complete admission, Stop and crash correctness

Files: `runtime/RuntimeOwner.ts` and its contracts, `composition/RuntimeTeamCoordinator.ts`, `team/DeliveryRecovery.ts`, `TaskRecovery.ts`, `TeamDeliveryAuthority.ts`, focused goal module, existing captured control route. Touch only actual insertion points.

1. Guard the synchronous claim with current original Team authority while retaining Runtime -> Team order.
2. Complete charging for task fan-out, review/board/peer notifications and supported recovery input creation. Count native input attempts, not messages or commands.
3. Close goal admission before the existing Stop sequence. Preserve late accepted-result publication and active-input custody.
4. Cancel obsolete unclaimed goal inputs by exact identity. Prove a later ordinary user input runs; unknown/claimed input is never skipped or replayed.
5. Reconcile interrupted intake/debit/receipt/outbox/admission transitions using the existing original receipts. Keep read/control usable after expiry/Stop.
6. Verify same-Team reassignment/roster changes, supported successor Resume, stale generations and fresh launch non-adoption. Explicit bound extension does not reset used attempts.

Focused tests: G04/G10/G11/G13; existing Runtime owner, retained cancellation, queued messages and native authority regressions. Use a small table of original write/claim failure points with real stores.

### P3 - Productive continuation and finite recovery

Files: existing `work-sync/policy/core` rules and focused goal policy beside them; `composition/createHostWorkSyncComposition.ts`, `createRuntimeWorkSyncWake.ts`, `MemberEntry.ts` and coordinator integration only as needed.

1. Read durable paired terminal facts and current task/review agenda; do not infer idle from missing logs or a lease.
2. Select one obligation for the member, or a lead planning/coordination/final-verification obligation. Valid child waiting does not wake the lead.
3. Allow productive turns on relevant new durable task/review/result evidence, even while the task stays in_progress. Keep at most two no-progress recovery attempts in the existing episode state.
4. Replayed evidence, heartbeats, timestamp changes and status churn cannot reset recovery. Invalid final proposals count as no progress.
5. Coalesce triggers on original cause; at most one pending automatic input per current member. Supported provider failure recovery stays with its existing owner.
6. Use the current scheduler for missed-event reconciliation. Do not add another timer or replace ordinary Work Sync policy.

Focused tests: G01/G02/G03/G08/G15, plus `NativeMemberWorkSyncPersistence.test.ts`. Prove >2 productive turns, exactly bounded no-progress recovery, passive reads with zero submits and non-opt-in parity.

### P4 - Bounded waits and completed-result settlement

Files: existing Work Sync status/report schema, persistence and scheduler; focused Team goal finalization module; original task/review/read ports. No external integration registry.

1. Reuse dependencies, review, clarification and provider reset facts. Add only missing wait fields to the existing report contract: exact resource/check and expected revision, observer, last observation, next due time and original finite horizon.
2. Prefer trusted events. If necessary, schedule one authorized read-only observation through the normal input gate with bounded backoff. Reporting the same wait cannot extend its horizon.
3. Choose independent runnable work before a not-due wait. Missing observation stays bounded/unknown; never rerun the external job or invent approval.
4. Preflight final proposals against current scoped work. Return the proposal tool before its own native turn settles.
5. Close new claims, await every relevant original input's actual settlement, require successful proposing lead input, compare exact relevant evidence, and commit acceptance under the Team fence.
6. Retire stale candidates and return automatically to active within the same scope/budget. Preserve explicit Stop/revocation/unknown holds.
7. Publish exactly one immutable original final result through the canonical lead-to-user receipt. Replay after a crash does not regenerate an answer.
8. Add scheduler isolation only if a controlled test reproduces unrelated-team starvation; fix that existing path without releasing a physical writer fence on a timeout.

Focused tests: G05/G06/G07/G09/G12/G14/G16. Combine delayed CI, review/fix, task-complete-before-terminal, late edit, proposing-lead failure and final publication replay into a few scenarios.

### P5 - One practical UI and transport path

Files: `src/shared/types/team.ts`, `renderer/types/composerDraft.ts`, `composerDraftRecovery.ts`, `useComposerDraftAttempt.ts`, `messages/composerSendUtils.ts`, `MessageComposer.types.ts`, `useMessagesPanelSend.ts`, a small `ContinueUntilDoneControl`, and the touched composer section; backend `contracts/operations.ts`, validator/facade, `createHostTeamMutations.ts`, snapshot projection and `createHostTeamsApi.ts`.

1. Add the bounded opt-in only to direct current-lead fresh messages. Preserve Do/Delegate and hide/disable it for unsupported contexts using Host-derived availability.
2. Capture options in the immutable prepared attempt and restore them on unknown send. Successful send resets the next-message option.
3. Carry the exact object through the existing shared backend facade/IPC/HTTP path. Reject extra fields and model-supplied authority.
4. Show compact existing-surface status, used/remaining attempts, deadline and concrete wait/attention. Add explicit bound extension/eligible Resume controls there; preserve existing team Stop.
5. Ensure goal transitions change the existing product revision/feed so acceptance and Stop become visible without a mounted composer or repeated model calls.
6. Extract only the cohesive touched block necessary to keep frozen oversized files from growing.

Focused tests: composer pending-send/thread-aware suites, draft recovery, Host mutations/reads/lifecycle and backend facade validation. Native UI acceptance uses the actual original composer, not direct owner calls alone.

### P6 - Integrated E2E, review fixes and merge

1. Rebuild the current Host and ledger; run focused new suites and affected existing owner/queue/Work Sync/UI regressions.
2. Run canonical type checks, focused lint/format, unchanged source-size/provisioning/runtime-artifact guards. Run the regular Host suite once the integrated slice is stable. Expand testing only for a concrete remaining risk or required CI gate.
3. Review the exact integrated diff independently and by the integration owner. Fix concrete findings, add the smallest regression that proves each fix, and rerun affected tests. Repeat until no unresolved in-scope findings remain; do not count rereading as approval.
4. Push the reviewed implementation and mark the existing PR ready. Observe required CI at the exact current head, including actual Stage 1/native jobs that the aggregate does not include.
5. Exercise native happy path and Stop for every advertised tuple. Record controlled Session, actual native scripted model, genuine model and overnight evidence separately. Run a small genuine productive canary before claiming autonomous competence, and an actual 6-8 hour run before an overnight reliability claim.
6. Re-read review threads and current checks; fix genuine current-source findings. Do not waive required checks, weaken assertions, invent a green result, sign an agreement or bypass protection to merge.
7. Merge **#1315 into its current integration base** only after its gates pass. Do not merge #982 into main, release, enable by default or force-update another branch. If the parent changes, inspect the exact delta and retest affected integration before merging.

## 6. Minimal verification matrix

| Cohort | Design cases | Critical observable result |
| --- | --- | --- |
| Lead-only and delegated walking slice | G01/G02/G15 | Exact authenticated goal lineage; one final result; ordinary mode unchanged |
| Long productive obligation | G03/G08 | More than two useful continuations; no heartbeat/churn reset; context retained |
| Review, CI and finalization race | G05/G06/G07/G14 | Current evidence, own-turn proposal returns, late edit invalidates, no false acceptance |
| Human wait and independent progress | G02/G07/G09/G12 | Exact clarification, one observer, independent work continues |
| Duplicate/Stop/FIFO | G04/G10 | One charge/claim; no later claim after closure; valid user input unblocked |
| Crash and limits | G11/G13/G16 | Original identity, no refund/double debit, last charged input, bounded retention, no passive model calls |
| Real native UI and canary | G17 | Actual source/provider/OS, real productive outcome, explicit native and real-model limits |

Do not create the Cartesian product of providers, operating systems and every fault point. Deterministic owner tests prove ordering; native cases prove the actually advertised integrations. Safe failure alone is not the positive productive-completion case.

## 7. Delivery log

| Push | Source / actual verification | Status |
| --- | --- | --- |
| P0 | Published as `0b682879656e6b07d1ed896b086fd259cbfc9f6d`, incorporating parent `f3bbca99f4e1ed07009f60338c3ffdf6f15a91ad`; remote diff contains the two planned Markdown documents. Three independent source/test/UI audits informed the checklist. | Published |
| P1-P5 | Uncommitted implementation and focused test work was written locally. The walking-slice gate has not passed; no implementation push is claimed. The execution environment became unavailable during integrated compilation. | Blocked; unverified |
| P6 | Integrated tests, independent final-diff review, current-head native/CI qualification and merge have not completed. | Pending |

The original 2,000-3,700 production-line estimate remains provisional. Count the actual integrated diff after P1, including proven provenance/claim changes; explain a concrete invariant before expanding the envelope. A smaller complete implementation is preferable to optional adapters. The release decision rests on working user journeys and original evidence, not line count or a subjective reliability score.

## 8. Execution checkpoint: environment unavailable (2026-11-27)

This is a recovery checkpoint, not implementation evidence or a reduced acceptance gate. The published branch still contains documentation only. Product edits were not committed or pushed before the execution environment failed. Their local survival must be checked after restoration; the inaccessible checkout is not a remote backup.

### Work written locally before the failure

- Team-owned goal contracts, validation, intake/source metadata, one atomic debit-witness map, controls and final candidate/publication logic. Existing receipt fingerprints retain optional-field absence for old commands. A separate narrow goal proof preserves the original Delegate/Do boundary.
- Runtime claim callback under the existing Runtime-to-Team fence, goal reconciliation through the existing Work Sync wake/pump, bounded CI wait reports and progress policy. Exact native ledger references are reused for productive progress and pre/post-settlement artifact fingerprints.
- Async lead proposal captures one original input across the artifact read. Post-proposal artifact changes are intended to invalidate the candidate. An ordinary same-Team input's actual claim invalidates a finalizing candidate before committing the claim. These are written corrections, not yet verified invariants.
- Direct-lead composer opt-in, immutable prepared-request recovery, bounded transport validation, goal status and explicit Stop/Resume/extension controls. Original Team Stop remains a Host-owned lifecycle operation. Successful send resets the next request's opt-in.
- Disposable Host tests using actual Team/Runtime stores, NDJSON and HTTP MCP, with a controlled provider only at the vendor Session boundary. Additional focused claim, wait and isolation tests were authored.

### Actual verification and limits

The task-change-ledger build completed with Node 24.21.0 and TypeScript 7.0.2. An early Host build reported real TypeScript errors while integration was incomplete and emitted output; that output is not a passing current-source build. Corrections were written, including exact optional-field construction, raw MCP tool results and asynchronous proposal registration. Later Host compiler attempts were killed (exit 137 / signal 9); one measured attempt reached approximately 752 MiB maximum resident memory. The last attempt used the compiler's single-threaded/one-checker flags, but its result is unknown because the execution server disconnected. The platform then reported the execution environment unavailable, and its recovery attempt timed out.

Some isolated UI/transport suites passed against the then-emitted Host output; these are partial local results and must be repeated after a clean current-source build. The original composer suite reached assertions and exposed a missing store field in the new test fixture; the fixture was corrected but its final run was not completed. No new Host runtime E2E assertion passed or failed: those suites were not run. Parse-only checks covered the initial fixture/Host/claim versions and the wait/isolation tests, not every final edit. No native provider, full Desktop, real-model or overnight pass is claimed.

### Resume in this order

1. Restore access and inspect the existing checkout before rebuilding or discarding anything: verify local HEAD, worktree diff and untracked files against published P0. Local P0 commit `8108546` had the same tree as remote P0, but different local ancestry. Preserve intended source changes; do not push the local snapshot's origin (it points to another local checkout). Confirm whether the interrupted controls-test file exists and is complete; its write outcome was unknown.
2. Stop concurrent heavy test/build processes. Rebuild this checkout's ledger and Host with the pinned Node 24.21.0 and TypeScript 7.0.2. The compiler exposes `--singleThreaded --checkers 1`; record actual results, not a presumed memory workaround. Run the package's exact compiler command directly if the local pnpm wrapper unexpectedly performs installation. Do not modify shared dependencies or the lockfile to work around this environment failure.
3. Resolve current compiler diagnostics first. Recheck the async `goals.propose` contract, raw MCP result formatting, `GoalProposal` artifact/authority fingerprints, `entries: () => entries.values()` completion-evidence supplier, exact optional fields and the factory's original runtime profile argument.
4. Run the first real Host walking slice before any implementation publication. Then run the productive multi-turn, post-proposal file-change, unknown-submit, budget and claim suites. Validate the native evidence adapter against actual captured tool hooks; empty/partial evidence must not become proof of complete filesystem coverage.
5. Finish the known G10 gap: retire an unclaimed task/review continuation when its exact canonical agenda key is no longer current. The shared `goalTaskObligationKey` was exported; the Team admission/retirement use was still pending. Preserve real task notification obligations and ordinary FIFO.
6. Execute the authored G12 hung-submit scenario before changing the pump. At checkpoint the pump still awaited a hung native submit; bounded per-target isolation was not implemented. Add only the smallest change supported by that reproduction, retaining original physical fences and single-flight ownership. Author the planned initial-action-plus-two-recovery policy assertions.
7. Complete the remaining G11/G13/G16 checks, including original-ID crash windows, elapsed deadline across clock rollback/sleep, Stop/finalization order, retention pressure and supported Resume lineage. A clock-rollback latch was not implemented at checkpoint. Review proposal replay bounds, accepted-result publication after restart, deleted required tasks, stale bindings and current-authority changes before marking these gates complete.
8. Fix the remaining public-status parser issue: require `typeof disposition === 'string'` before checking its allowed values; `String(disposition)` can accept an array such as `['active']`. Add the malformed-status regression. Normalize/truncate `markAttention` reasons before equality comparison to avoid repeated identical writes, and ensure a retained wait reason cannot conceal deadline exhaustion. Re-run UI suites, source/test type checks, focused formatting/lint and unchanged size/architecture/artifact guards. Recount actual production scope, update the estimate from concrete changes and complete independent integrated review. Then resume the P1-P6 push sequence and exact-head CI/native qualification. Merge only #1315 into its integration base after its real gates pass.

The current blocker is an unavailable execution environment and unfinished verification. It is not a request for additional implementation or merge permission; that authorization already exists.
