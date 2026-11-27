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
8. Add scheduler isolation only if a controlled test reproduces starvation of another Team or independent work in the same Team; fix that existing path without releasing a physical writer fence on a timeout.

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

| Push / gate | Source and actual verification | Status |
| --- | --- | --- |
| P0 | Published detailed plan and push checklist at `0b682879656e6b07d1ed896b086fd259cbfc9f6d`, based on parent `f3bbca99f4e1ed07009f60338c3ffdf6f15a91ad`. Independent Host, UI/scope and E2E audits informed it. | Published |
| P1-P5 WIP | Published 88 source/test files at `5bb406aaf0cfaf5eacff86b952b024a227454efa`. This was a recovery checkpoint, with verification and review still open. | Published; superseded locally |
| P1-P5 integrated recovery | Recreated the exact published checkout and merged parent through `9b80b2fb5958c35f4c5ef7233ed21e6bd5179342` without conflicts. Its additional credential/provisioning changes received independent interaction review; the affected seven-file UI cohort passes 145 tests. Restored reviewed fixes and their regression tests. Fresh ledger and Host builds pass on Node 24.21.0 / TypeScript 7.0.2; the complete Host test graph type-checks, including the live canary. | Integrated; final Host qualification in progress |
| P5 UI | Fresh seven-file cohort: 171 tests pass (composer 47, paged Team reads 76, mutations 23, draft 5, controls 5, goal transport 12, readiness reads 3). Original request recovery, upfront upload eligibility, strict status parsing and uncertain-control recovery are covered. | PASS on recovered source |
| P6 | Actual Host cohort, regular Host regression suite, root checks, physical Desktop goal opt-in/Stop, bounded genuine model canary, final independent review, exact-head CI and integration merge. | In progress; no aggregate PASS yet |

### Scope count and implementation decisions

At the integrated review checkpoint, the existing production-file classifier counts 98 affected production source files, 3,727 added lines and 355 removed lines against parent `9b80b2f`. The original estimate was 2,000-3,700; the narrowly revised ceiling is 3,750 for the reproduced original-notification evidence gap described below. Most additions are the Team goal owner, bounded Work Sync policy/composition, original evidence readers and the compact Composer controls. Tests, documentation and workflow assertions are counted separately. New files remain below 800 lines; existing frozen caps and guard baselines are unchanged.

The extra Runtime commit helper exists to enclose both claim and delayed cancellation in the original synchronous Team authority fence. The current-continuation helper reuses canonical agenda keys and wait-observer policy at admission/claim, so a newly reported wait, reassignment or completed task can invalidate an already queued turn. Lead obligation validity checks membership instead of choosing the first obligation again: exhaustion of one lead task must not strand independent coordination. These are reproduced correctness gaps in the existing path, not new scheduling subsystems. The first restored cohort exposed a missing task-notification branch in workspace corroboration: primary task identity must come from the original notification plan, including dependency fan-out. The narrow original-plan/notification corroboration branch and explicit evidence-only authority purpose account for the revised ceiling; the actual excess over the original estimate is 27 added production lines. This bounded increase closes the original evidence invariant without granting TaskStart/native-helper authority or introducing another owner.

The production scope remains one explicit objective on an already ready Team; one atomic attempt/debit record; existing Runtime, outbox, controller tasks, evidence journal and Work Sync wake. No new daemon, queue, registry, orchestration framework, external credential, global quota service or default-on rollout was added. OpenCode V2 remains unavailable for this option.

Fresh script typing passes for the complete legacy Host/Desktop tooling graph and all seven canonical root tooling projects. The controller regression suite passes 516 tests in 26 files. Source size (5,568 production files, 139 unchanged frozen exceptions), provisioning architecture and runtime-artifact guards pass. Focused Prettier and fast lint pass; the separate ordinary typed ESLint attempt exhausted its 1,536 MiB heap before source diagnostics and is not a pass. Canonical root application typing remains a CI gate: local full-scope attempts were killed without TypeScript diagnostics; the measured single-checker attempt reached 2,112,748 KiB RSS before SIGKILL. No compiler scope or strict option was changed.

The intake-loss fixture stops further writes after each injected durable boundary. At the outbox boundary, the old owner must explicitly refuse backup of exactly `inboxes/lead.json` while both original sessions close/release. The replacement real Host then recovers the original receipt and final cleanup completes. This is an asserted crash-state backup refusal, never an ignored cleanup failure.

## 8. Current qualification and delivery procedure

1. Freeze the integrated production snapshot. Run `packages/legacy-agent-host/tests/autonomous-goal-*.test.ts` and `runtime-goal-claim.test.ts` with the pinned Node and fresh Host output. Fix concrete failures and repeat only the affected cases; require a final complete goal cohort after those fixes. Include actual interrupted writes, Stop/Resume ordering, canonical task-notification provenance, required human approval, changed evidence, original checkpoint/restore and missed-progress timer recovery.
2. Run the regular Host suite once, plus affected ordinary task-notification, native-control, evidence/restore and Work Sync boundaries. Run canonical root/script type checks, focused formatting/lint and unchanged source-size/provisioning/runtime-artifact guards. Resolve diagnostics before publication; a killed compiler is not a passing check.
3. Use the existing Desktop emulated-runtime UI harness for physical Composer Do opt-in and Stop while its original stream is active. It reads the exact original message/goal/control receipts and captures the visible active/stopped state. The existing stream then completes normally. Existing Claude, Codex and OpenCode V1 finite-peer CI lanes execute this shared journey; it does not qualify real vendor inference.
4. Qualify actual CLI wiring separately from Desktop finite peers. Reuse the existing captured mixed-provider native fixture, its original Claude/Codex/OpenCode V1 binaries and scripted localhost model transports. Use six fresh disposable profiles (three lead providers × Do/Delegate), each with a productive goal followed by a separate Stop goal. Exercise actual teammate continuation, original goal acceptance/publication and Stop; share the existing profiles and oracles instead of multiplying the G01-G17 fault suite by provider/OS. Preserve the existing Darwin/native pins and baseline mixed-history assertions; add explicit goal proof assertions in the same existing CI lane. Do not relabel a Linux or finite-peer result as that native proof.
5. Run the existing real-vendor runner with `--scenario autonomous-goal --vendor codex --strict --no-build` against a freshly built Host and the verified official 0.169.0 binary. Its original separate productive multi-agent and Stop scenarios were bounded by 24 automatic attempts and a 16-minute outer limit. Conservatively reserve up to 12 attempts for the failed original first goal; any subsequent real productive/Stop attempt is limited to 8/4 respectively, keeping the total upper bound at 24. An open/read/stop-only diagnostic probe creates no message or goal and performs no inference. The productive oracle checks actual artifact bytes, original task/inputs and one canonical result publication. A preflight-only result, a safe hold or a scripted model cannot satisfy productive G17. Do not claim overnight reliability without an actual 6-8 hour run.
6. Review the exact diff independently, publish the P1-P5 integration checkpoint to the existing draft, and update review threads only after the associated fix and regression are published. When ready, mark #1315 ready and wait for required CI plus the relevant actual Host/Desktop/native jobs at its current head. Fix current-source failures without weakening their assertions or changing guard baselines. Inspect any new parent delta before merging #1315 into `feat/provider-migration-stage-1`. Leave #982, main, release and default activation to their own authorization/gates.

### Recovery history and evidence limits

An earlier executor outage preceded the published WIP. A second executor replacement later removed its temporary checkout and logs while preserving the published branch and a source checkpoint. The current checkout was restored from the exact Git history; subsequent fixes were recovered from retained full source/patches or reimplemented from the documented invariants and independently reviewed. Recovered source is being rebuilt and tested afresh. Historical 30/30 and 52/55 Host results are not current-source acceptance evidence.

The verified official Codex 0.169.0 package has archive SHA256 `89801b4b97faba562eb80fe0a833159ac79399be674022f4b1a0ccab1d153faa` and binary SHA256 `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`; registry SHA512 was independently checked. The fresh account-only preflight is explicitly INCONCLUSIVE/preflight-only and performed no inference. The first authorized real goal attempt then failed at startup with no observed Runtime input; cleanup also failed, and the original authentication file remained unchanged. That FAIL is retained. Bounded primary-failure diagnostics and exact original-process facts must identify the startup cause before a retry; no productive or Stop PASS is inferred from that attempt. Existing isolated credential handling is reused; no login or provider substitution is part of this feature.
