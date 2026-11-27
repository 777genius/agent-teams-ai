# Autonomous goal completion: Work Sync on Stage 1 Host

**Status:** proposal, implementation not started. **Parent:** [#982](https://github.com/777genius/agent-teams-ai/pull/982), inspected at `dee94bf14ddbe81143ed2c3c9029a74e66158e1e` (2026-11-27). This is a follow-up, not an amendment to the migration acceptance or authorization to merge/activate it. **Target:** a team with a lead and teammates can finish an explicitly accepted user objective unattended while its supported desktop/Host execution environment is running.

## 1. Decision and scope

Extend the existing Work Sync policy and the Stage 1 Host's current Team/Runtime owners. Do not build a second scheduler, task board, message dispatcher, recovery ledger, workflow engine, external supervisor, or provider framework. The existing [work recovery plan](agent-work-recovery-implementation-plan.md), [D1 admission plan](agent-work-recovery-d1-runtime-admission-plan.md), [control plane](member-work-sync-control-plane-plan.md), and [Stage 1 plan](../plans/provider-migration/stage-1-legacy-host.md) remain relevant. Read the current implementation rather than implementing their historical checklists again.

An explicit run-level opt-in, **Continue until objective is done**, selects this behavior. Off preserves current behavior. Use existing team settings/launch controls and Attention/readback if possible; one compact mode/status surface, not a new page. One active objective per selected execution team/run in the initial release. Scope is that objective, not every unfinished task in the logical team, other projects, or unrelated backlog. The user authorizes the work, tools and optional external actions; autonomous mode never broadens them.

In scope: lead planning, task pickup, task work, assigned review and changes requested, coordination, final acceptance, normal turn continuation, bounded lack-of-progress recovery, supported temporary error recovery, durable expected waits, recovery/reconciliation after supported restart, stop and visible disposition. Existing task/review workflow stays canonical. Keep ordinary user chat, manual retry, existing schedules, native permissions and non-opted-in teams compatible.

Out of scope: closed-app/OS sleep/power-loss execution, new Orchestrator/Runtime v3 or OpenCode V2, multi-goal orchestration, remote agents, arbitrary integrations/webhooks, autonomous model/provider substitution, auto-approval, auto-merge or deployment without original permission, mandatory model-based verifier, semantic analysis of every transcript, generalized checkpoint engine, rewriting old legacy paths, release/default activation. A running but disconnected/failed Host cannot promise progress until it is recovered. No claim that any model always solves any objective.

## 2. Source-grounded baseline and gaps

| Boundary | Existing evidence at the parent SHA | Required follow-up |
| --- | --- | --- |
| Agenda | [ActionableWorkAgenda](../../packages/legacy-agent-host/src/work-sync/policy/core/domain/ActionableWorkAgenda.ts) covers owned work, review cycles, lead clarification and some broken dependencies; empty agenda can be caught_up | Objective and lead coordination obligations must remain visible when the board is empty or work is not assigned |
| Recovery | [RecoveryHealth](../../packages/legacy-agent-host/src/work-sync/policy/core/domain/MemberWorkSyncRecoveryHealth.ts) and [allocator](../../packages/legacy-agent-host/src/work-sync/policy/core/application/MemberWorkSyncRecoveryAllocator.ts) use episode status and a two-attempt automatic continuation limit | Do not mistake successful productive turns for repeated recovery attempts |
| Admission | [EarlyContinuationPlanner](../../packages/legacy-agent-host/src/work-sync/policy/core/application/MemberWorkSyncEarlyContinuationPlanner.ts) has gated settlement identity and runtime tickets | [Host composition](../../packages/legacy-agent-host/src/composition/createHostWorkSyncComposition.ts) does not supply all these dependencies on the inspected path; prove actual end-to-end behavior, not just exported policy |
| Delivery | Host composition, [native delivery](../../packages/legacy-agent-host/src/work-sync/createNativeWorkSyncDelivery.ts), [wake](../../packages/legacy-agent-host/src/composition/createRuntimeWorkSyncWake.ts) and [RuntimeTeamCoordinator](../../packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts) settle existing accepted intents | A trusted new decision from a settled runtime must have canonical admission and durable receipt; no fake native MCP authority |
| Lead | [Controller board completion notification](../../agent-teams-controller/src/internal/tasks.js) already wakes the lead; [StallPolicy](../../src/main/services/team/stallMonitor/TeamTaskStallPolicy.ts) skips lead-owned work | Preserve the notification; ensure lead can plan, assign, integrate and verify without depending on the last teammate's prompt compliance |
| External waits | Work Sync distinguishes some dependency waits; existing runtime recovery handles some transient errors and rate limits | Reconcile durable waits separately from missing progress; no periodic model spam |
| Lifecycle | Stage 1 owns canonical Team receipts, Runtime inputs, current binding/generation and custody | Never replay unknown effects, revive a stopped member or adopt an old source |

The Host admission gap is a source observation, not a proven product regression. First reproduce the legacy behavior and the exact Host composition in a disposable E2E. If an existing promised behavior is missing, file the evidence with #982's owner and fix it there only with that owner's coordination. New semantics belong to this follow-up. A P09/Stage 2 expansion is not authorized. The new branch must not weaken #982's qualification, current source pins, native/OS proofs, or CI checks.

## 3. Ownership and minimal persisted data

| Owner | Responsibility |
| --- | --- |
| Team owner / task and review stores | Authoritative objective acceptance, membership and task state; scope, goal revision and final acceptance |
| Work Sync policy | Derived eligible obligations, wait/progress classification, next action and bounded continuation/recovery policy |
| Existing Work Sync persistence and outbox | CAS, one logical pending continuation, deduplication and durable retry/unknown disposition |
| Runtime owner/provider adapter | Current session/input identity, busy/settled observation, next-input admission, Stop/Resume, custody and terminal proof |
| Existing runtime recovery | Classified provider failure/retry-at-reset; no second ordinary continuation producer |
| Desktop/MCP | Explicit opt-in, bounded commands and read-only status; no separate runtime or goal truth |

Represent the objective as the smallest durable Team-owned record (or existing root task metadata if the existing task contract can express the invariant). Keep original accepted request reference, goal ID, execution scope, objective revision, acceptance criteria/reference, run mode/limits, disposition and final evidence reference. Do not duplicate entire prompt history, task snapshots or transcripts. A stable association relates tasks to the objective; do not infer association by title, recency, assignee or current board membership. Children, reviews and reopened work derive the same association. Existing unrelated tasks retain their ordinary behavior. Avoid new tables until a demonstrated storage/transaction need; use the current canonical owner and compatible schema migration.

At intake, durably admit the authorized objective before acknowledging autonomous start. The lead initially has a planning obligation even if no tasks exist. When the lead creates work for this objective, bind the tasks to its ID under canonical authority. Explicit user edits revise the objective; stale decisions must not act on the newer revision. Ordinary user chat must not silently replace or extend it. An additional objective is deferred or requires an explicit replace/stop, not merged into the existing one by guessing.

## 4. Completion semantics

A turn ending, a model claiming success, an empty per-member agenda or even all board rows reporting completed are not proof of objective completion. Derive the lead's action from the current goal scope:

- Plan/clarify the accepted work and materialize missing required tasks.
- Assign actionable unowned work; resolve broken dependencies, review changes and questions directed to the lead.
- Wait for active delegated work while still doing independent obligations; avoid waking the lead for every child event.
- After required work is finished, run final verification against the current objective criteria and task/review/evidence revisions.
- Persist the final acceptance outcome and publish one final result to the user, using existing message delivery and idempotency.

Require the accepted goal revision, all required tasks successfully resolved, no required outstanding review/rework/approval/wait or unresolved relevant effect, and a current lead final attestation with relevant evidence. Use existing task verification and review if available; do not force a second verifier into every run. Mark completion only after final result is durably recorded and publishable through the existing channel. Cancelled/deleted tasks are not successes; explicit user-authorized scope changes can remove obligations. An unresolved required outcome prevents completion, not unrelated independent work. The lead may propose a new follow-up task within the scope; user authorization is required for expansion. Never invent missing evidence. Where a criterion requires human judgment, ask the user and retain independent work.

## 5. Continuation decision

Use one decision per current objective/member/settled input, with current authority, not chat-text heuristics. Reconcile on authoritative settlement, task/review/dependency changes, recovery result, due wait and bounded fallback observation. Debounce/coalesce repeated events; events are triggers, not proof. Reuse the scheduler and current Team/Runtime feed. No new periodic LLM calls while an agent is busy or idle with no actionable work.

| Fresh snapshot | Action |
| --- | --- |
| Exact current runtime busy or approval pending | No new input; retain obligation |
| Settled current input; eligible work, permitted mode and budget | Plan one next turn through existing admission/outbox |
| Review/clarification now actionable | Wake the authorized owner/reviewer/lead through the same policy |
| Waiting on a verified dependency or registered wait | Record wait; no blind continuation |
| Retryable provider failure | Delegate to existing runtime recovery; no concurrent normal continuation |
| Missing identity, stale/partial snapshot, unknown effect | Reconcile; do not start another effect on that binding |
| Stop, explicit pause, permission revoked, limits exhausted | No automatic turn; keep typed reason and unfinished work |
| Nothing eligible, goal still open | Observe next event; classify unresolved responsibility or waiting; do not infer success |
| Goal accepted as complete | Do not schedule further work; deliver final result once |

Implement a small pure decision helper only if the existing Work Sync policy cannot express these distinctions. Keep deterministic rules and narrow ports; no provider-specific logic in the core. Re-read canonical state under the existing admission guard immediately before dispatch, including goal/task revision, member identity, runtime instance, completed input/generation and control revision. A late event from an old generation is diagnostic only. No direct sends or fabricated agent commands. Normal continuation needs an existing supported Host-side system command authority; verify the actual API and avoid impersonating a native MCP actor. If the boundary cannot currently express it, add the smallest private Host-owned command through existing receipts and Runtime admission. No second ledger.

## 6. Progress, retry and resource budget

Separate productive next turns from failure/no-progress recovery. Keep the existing two-attempt default for no-progress recovery unless evidence justifies a change. Real monotonic progress can permit many productive turns inside the objective's overall resource bounds. Avoid resetting all member budgets because one task moved, clock changed, status was reread, or another agent was active.

Use compact, task-bound evidence: actual task/review transition, dependency resolved, new accepted artifact/check result tied to current revision, or verified operation result. Tool activity alone proves busy, not meaningful progress; model statements and timestamps alone cannot reset a budget. A successful delivery is not proof of a successful turn. Keep unresolved intent and Stop latch across observation. Distinguish progress of independent work from a repeatedly failing item.

Reuse existing per-member rate limits and cooldowns for recovery; separate ordinary progress from recovery and do not globally increase nudge frequency. Apply a finite objective duration and a finite total admitted automatic-turn bound shared by lead and members; reserve capacity before dispatch and recover consumed reservations without double charge. If measured usage is already trustworthy, expose it; do not advertise a hard dollar/token cap with unknown provider usage. Existing permissions and rate limits are always enforced. Exhausted budget becomes visible attention; user explicitly extends/resumes. Defaults and UI should remain simple and be documented.

## 7. Waiting and wakeup

Reuse real task dependencies, review state, clarification state and runtime busy/retry metadata. For an external operation not covered by them, retain a narrow task/goal-bound expected-wait record: kind, exact external reference if available, owner, reason, next check time and bounded horizon. Persist before ending the turn, validate source authority, and clear when the relevant condition changes or the objective is stopped/superseded. A generic message such as “waiting for CI” is not an indefinite suppression permit.

Prefer existing trusted completion signals; otherwise a bounded scheduled recheck using authorized existing tools and backoff. No general webhook service, remote API polling engine or new credentials. A running tool stays busy; do not start another turn just to ask about it. If no reliable observer exists, a due continuation may check once and report the next wait; limit rechecks and expose the uncertainty. A queued/running CI job is expected wait, not failure. Distinguish failed checks, cancelled jobs and actual human approval from a pending job. Continue independent work. Do not restart CI or repeat an external mutation simply because a check is pending. 

## 8. Recovery, cancellation and compatibility

Use the Stage 1 identity and receipt boundaries (Team, project, run, member, runtime instance/generation, input, authority revision). Stop/revoke atomically closes further admission; cancel unsent intents and keep unknown/consumed outcomes held until reconciliation. Already running work follows existing stop/custody contract. Retry original logical commands only when current owner can prove the allowed outcome; no blind restart or replay of an external action. Restart and resume retain objective, limits, receipts and wait state only under supported current owner/explicit user resume; a fresh relaunch is not a continuation of an old objective. Never fall back to an unrelated project or stale provider session.

An unavailable member or failed dependency must not freeze other members/teams. Keep scheduler isolation and bounded per-target work; if a blocked callback or physical writer remains, preserve its fence and advance unrelated owners. Use existing recovery queue and strict read/error semantics. An unknown snapshot is not empty or idle. Observe/repair original debt even when new automatic admission is disabled. No automatic retry for permission denial, invalid configuration, unsupported capability or user Stop; attention must retain specific reason.

Qualify only supported current Stage 1 provider/mode tuples. Check actual Claude, Codex and OpenCode V1 support; do not promise capabilities merely from a version flag. Unsupported tuple: show explicit capability reason and preserve existing manual/legacy behavior, no unsafe fallback. On rollback turn off new admission but preserve state/receipt read and settlement; never remove a durable record while work or effects may be outstanding.

## 9. Delivery sequence, complexity and boundaries

| Slice | Production LOC (changed/new) | Complexity /10 | Reliability target /10 | Confidence /10 |
| --- | ---: | ---: | ---: | ---: |
| A. Baseline/parity and actual Host settlement/admission integration | 350-650 | 8 | 9 | 6 |
| B. Progress and recovery budget separation | 300-500 | 7 | 9 | 7 |
| C. Goal scope, lead obligations and final acceptance | 400-750 | 7 | 9 | 6 |
| D. Durable waits and wake routing | 300-600 | 7 | 9 | 6 |
| E. Isolation and reconciliation gaps | 150-300 | 6 | 9 | 7 |
| F. Shared resource limits, status and compact opt-in | 150-300 | 5 | 9 | 6 |
| Total (provisional; avoid double-counting existing parity repairs) | 1,650-3,100 | 8 | 9 | 6 |

Tests/E2E: 2,250-3,950 LOC, mostly reuse fixtures and existing suites. Docs separate. Estimate is a bounded planning envelope, not a quota. Re-estimate after A and after inspecting canonical goal persistence. If existing state/authority already meets an invariant, write a focused proof rather than another module. If goal association, admission or external observation needs major infrastructure, stop at the supported minimal behavior and record the design decision before expanding. Do not hide a new scheduler or cross-repo protocol migration inside the budget.

One stacked Draft PR based on #982's integration branch; initial commit(s) docs only. New feature implementation remains in that follow-up, not concurrent writes to #982. Use clean architecture and existing shared policy package, no duplicate Main/Host algorithms; preserve the existing <=800 production-file guard. Separate pure rule, application orchestration, existing adapters; add interfaces only at real boundaries. Keep user-visible changes small. Before any production edits, inventory changed paths and coordinate ownership with parent agent. Before retargeting to main, confirm parent is actually merged; compare exact trees (squash ancestry is not enough), restack only the follow-up delta, verify no parent files/commits accidentally included and rerun relevant checks. No merge, release or default-on authorization from this plan.

## 10. Acceptance and verification matrix

Tests should drive actual production composition, real task/receipt stores, injected clock/settlement fixtures, and isolated native provider E2E where required. Assert external effect counts, runtime input starts, canonical identities, durable state and final result; do not accept logs, inbox insertion, simulated UI messages or a single mocked use case as proof of actual wakeup. Existing #982 native evidence is not evidence of the new mode.

| ID | Scenario | Required observation |
| --- | --- | --- |
| G01 | Lead ends turn before creating all tasks; board empty | Lead planning remains actionable and scope preserved |
| G02 | Team has unrelated older backlog and a goal with unassigned tasks | Lead assigns scoped work; unrelated backlog is not swept into the goal |
| G03 | One member requires >2 productive turns | All permitted turns run; no-progress recovery budget is not incorrectly exhausted |
| G04 | Repeated same status or duplicate settlement, no progress | Bounded recovery and attention; one accepted turn per decision, no spam |
| G05 | Mixed lead/member implementation, review rejects, fixes, review passes | Review cycle correct; final integration/acceptance before final report |
| G06 | Lead sleeps while teammate finishes last required task | Existing board notification and new policy coalesce; lead verifies; final report exactly once |
| G07 | CI pending for longer than stall threshold, then success/failure | Wait is retained without rerun; relevant result wakes correct owner; independent task progresses |
| G08 | Rate limit and reset; provider transient failure | One recovery owner; configured backoff respected; no parallel continuation |
| G09 | User clarification or approval blocks one branch | Others continue; no unauthorized decision; correct attention |
| G10 | Duplicate events, foreground user input, task reassigned, stale revision | No stale automatic dispatch; canonical next decision |
| G11 | Stop before reservation / after reservation / after claim / during input | No new work after closed admission; correct custody and original outcome |
| G12 | Host crash/restart before/after accepted delivery, wait or final report | Reconcile original ID, limits and held debt; no duplicate external effect/final report |
| G13 | Stuck member A and healthy member/team B | B completes while A remains isolated; no premature fence release |
| G14 | Budget exhausted; deliberate explicit resume; fresh relaunch | Reason retained; no auto-reset or stale goal adoption |
| G15 | False completed/removed task, stale check, required review still open | No final acceptance; legitimate scope revision or rework |
| G16 | Non-opt-in team, unsupported tuple and ordinary manual input | Existing behavior unchanged, visible capability reason |
| G17 | Real long unattended run with mixed supported providers and lead | No user 'continue'; actual task/verification outcome, bounded costs, final result or typed stop reason |

For G07 use scripted loopback CI evidence initially (no production external effects); also require a supported genuine tool/CI wait path before advertising CI-aware unattended continuation. For G17 use a disposable multi-step coding objective with tests, delegated work and review, delayed check result, transient failure, and explicit cleanup; validate real native input/response (not only simulated settlement). Run provider-specific happy-path and Stop cases for each advertised tuple, mixed-provider full path on supported native environment(s). Accelerated-clock checks prove timing logic; a real extended run proves elapsed-time continuity. Report source SHA, provider/OS tuple, evidence and exclusions; no skipped/queued/old-source pass, no claim of general success rate. Require independent source review and actual E2E before ready-for-review/activation. Do not make additional native runs if an unchanged proof can be narrowly reused under the existing qualification policy.

## 11. Implementation start gates

- [ ] Read #982's current source and parent acceptance/ownership handoff; verify parity, exact Host paths and provider capability before coding.
- [ ] Confirm smallest goal association and atomic owner contract, existing user opt-in/controls, actual settled/next-input admission, existing wait mechanisms; record gap evidence and select minimal extension.
- [ ] Define exact budget defaults and allowed observation/check policy without granting additional tools or credentials.
- [ ] Implement slices in the existing draft, normal focused checks and independent review; push completed bounded changes, then run required E2E on final source.
- [ ] Resolve parent integration and retarget only after approved parent merge; no default activation or release here.

The target is a reliable bounded objective lifecycle, not an agent kept awake at all costs. Safe waiting, explicit human decisions and visible failures are valid outcomes; silence with runnable obligations is not.
