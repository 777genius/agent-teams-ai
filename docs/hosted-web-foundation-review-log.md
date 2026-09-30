# PR #252 foundation plan: two three-round review cycles

Plan under review: [hosted-web-foundation-delivery-plan.md](hosted-web-foundation-delivery-plan.md). Source baseline: PR #252 `e5f7d5890a2de3ed03b0ef43119081fbae1c33fd` on 2026-09-28. This log records review findings and the plan edits made between rounds. It is not implementation or runtime evidence.

## Round 1 - domain, authority, package

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact PR #252 source. No P0, four P1 and one P2.

1. Hosted create's transparent stale-revision rebase retained original -> rebased only in process memory. A committed rebased create with lost ACK could return idempotency mismatch on exact replay. Plan now removes transparent rebase in F2, asks for explicit refresh/reconfirm after proven no-effect conflict, and tests lost ACK/restart.
2. Desktop move-back-to-done used two renderer commands with refresh between placement clear and status write. F1 now includes a bounded authoritative Desktop move facade under existing board lock, prevalidates before first write, and explicitly avoids claiming crash atomicity. Added 500-900 changed LOC reserve, additive Desktop API/IPC, regression for rejected move preserving placement.
3. Globally enabling direct-facet public classification would expose older adapter reexports across roughly twenty facets. F0 now inventories first and cleans the actual browser-consumed index/facet; all-facets ratchet F0b requires an explicit measured inventory and budget. No new baseline exceptions are presumed.
4. A rejected replay after an uncertain prior commit does not prove original non-application. Plan separates original outcome from recovery-attempt result, preserves uncertain state on stale generation/mismatch, and adds the relevant regression.
5. Session owner inside keyed HostedTeamWorkspace would be destroyed on workspace switch. Registry now lives in HostedApplicationShell above the keyed workspace; A -> B -> A unresolved-command scenario is required.

Estimates were recalculated without double counting: foundation 4,250-7,300 changed LOC; foundation + D1/N1 + integration 7,350-12,600; full Dashboard/Chooser package including provisional main-conflict reserve 9,150-17,000. All-facets F0b remains unestimated until read-only inventory.

## Round 2 - behavior, UX, tests, estimates

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact source. No P0, one P1 and three P2.

1. After lost ACK and generation change, existing Hosted `getPage` cannot correlate a task with the original create. F2 now specifies a scoped read-only lookup of deterministic task ID plus persisted creation metadata. Exact match confirms task write only. Absence/mismatch/read failure remains unresolved. The UI provides a visible `operator_required` resolution path; it does not infer safe retry from page absence. Round 3 narrowed this to Product's existing descriptor-bound read source, avoiding a new Owner wire operation.
2. Late mutation error for team A could disable team B's capability inside one workspace. Availability updates now require captured scope/authority; added same-workspace A/B composition regression.
3. Desktop TeamDetail and graph form still had separate submit owners. Plan now places one Desktop feature-session registry above both view lifetimes, keyed by active context/team/authority. Post-confirm output is once per intent, not once per session; added detail-to-graph and sequential-intent tests.
4. D2/N2 had no independent behavior or acceptance and overlapped D1/N1. Removed them from chosen milestone/budget. Future Dashboard/Chooser work must first name a distinct observable flow and test.

New selected estimate: foundation 4,890-8,540 changed LOC; foundation + D1/N1 + integration 7,990-13,840; with provisional main-conflict reserve 8,290-15,040. Confidence in prospective LOC 5/10 for foundation, 5-6/10 for D/N. Full-screen historical estimates remain low-confidence context, not additive selected work.

## Round 3 - delivery, enforcement, final consistency

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact source. No P0; one P1 and one P2 in the version read, both fixed during review and acknowledged by reviewer.

1. Existing Owner socket protocol accepts only message_send/task_mutate, so an Owner observation operation would add unbudgeted cross-process protocol/runtime work. The plan now uses Product's existing descriptor-bound read source under current `HostedAuthorizedTaskBoardAuthority` grant, derives task ID server-side, validates exact creation metadata and revalidates mount/team/snapshot. Historical submitted generation is evidence for the old intent, while current read authorization is checked separately. Mutation stale-generation gate is untouched.
2. An exact match on a soft-deleted task confirms a past write but says the task is currently deleted. The plan and regression table now distinguish this from absent/mismatched/unreadable results, which remain unresolved. No automatic restore or fresh create follows.

Reviewer confirmed estimate arithmetic, scope boundaries, actual test commands, one final PR #252, final exact-SHA gates and sandbox-only E2E. No runtime or tests were executed during planning/review.

## New review cycle, round 1 - exact execution semantics

Reviewer: independent `gpt-6-astra`, `xhigh`, read-only source at plan draft `0a7f1f76f06b603cd3902bba2d57d7ea06fd63b3`. Hosted `serviceTier: fast` reviewer admission failed before model start with `checkpoint_publisher_required`; this round used a local subagent whose fast tier cannot be set or claimed.

One P1: the proposed Desktop `moveBackToDone` referred to a nonexistent persisted `status_reset` history intent. Controller `kanban.clearKanban` accepts that string only as a transition permission; `kanbanStore.clearKanban` writes placement and `reviewState` but no history. Same-status `setTaskStatus(completed)` also adds no event. Existing history-first readers would resurrect Review/Approved after a successful move. Skipping status effects would also omit completion follow-ups when an open review becomes finished. The main agent corrected the plan with an explicit additive `review_reset` event, connected reader/worker/timeline inventory, completion follow-up condition, persisted fixture and rollback compatibility restriction. F1 budget increased by 400-900 changed LOC and 4-9 human hours; selected package including I0 is now 9,590-18,240 changed LOC and 102-198 human hours. No implementation or runtime proof was claimed.

## New review cycle, round 2 - UI behavior and lifetime

Reviewer: independent local `gpt-6-astra`, `xhigh`, read-only at `cd970a5d18a7dff2e059bbf0e76faf855509ff0b`. Three P2 findings; no P0/P1.

1. A complete lifecycle read started before a team create receipt could finish afterward and clear the newly selected team. The plan now requires a selection/invalidation watermark. Superseded results cannot reconcile absence; a newly created target remains pending until current bootstrap/grant or causal list evidence resolves it.
2. The Desktop directory source clears `teamsError` and `globalTasksError` after noninitial failure; `globalTasksInitialized` is true even after first failure. The plan now adds source-owned last-success/last-attempt metadata, so retained rows are stale and unproven counts unknown without duplicating the loader.
3. `HostedAuthGate` only reads auth on mount and the shell's optional `runtimeIdentity` does not monitor grants. The plan now names a bounded 401/403-triggered auth/workspace revalidation callback and disposes sensitive sessions only on verified authority loss. Network/503 and capability-specific rejection retain uncertain intent.

Added focused composition/source tests for these behaviors. Estimate delta: 360-760 changed LOC and 6-13 human hours. Selected package including I0 is now 9,950-19,000 changed LOC and 108-211 human hours, excluding unresolved Core gates. Review did not execute runtime tests.

## New review cycle, round 3 - exact delivery and residual effects

Reviewer: independent local `gpt-6-astra`, `xhigh`, read-only at `143b01b9d04f41d5191e1d9337f942af46983a18`. One P1 and two P2; estimate table arithmetic passed.

1. Hosted `move_task` had the same clear-placement/same-status gap as Desktop, but the reset writer was specified only for Desktop. The plan now routes both through one bounded controller helper under the existing board lock and tests both persisted command paths/readers.
2. Reset history without closing `reviewIntervals` could overcount/reopen review duration after resume. The plan now closes interval with the reset event timestamp and explicitly includes `TeamTaskActivityIntervalService` in the consumer inventory and pause/resume fixture.
3. A process stop after reset write but before notifications would leave completion follow-ups missing if repeat only checks open -> finished. The plan now permits idempotent post-commit reconciliation on exact replay, including Hosted's early `isNoop` path, using existing stable comment/message IDs. No new WAL or guarantee of background delivery is claimed.

The reviewer also found F2c patch sizing had not allocated the 160-350 changed LOC from round 2 auth revalidation. Its row now includes AuthGate/shell work without changing the F2 subtotal. F1 gained 500-1,000 changed LOC and 6-12 human hours for the Hosted reset/interval/follow-up path. Selected package including I0 is now 10,450-20,000 changed LOC and 114-223 human hours, excluding unresolved Core gates. No runtime implementation or tests were performed in these planning rounds.

## Astra xhigh execution-plan cycle, round 1 - identity, auth lifetime, follow-up scope

An independent local `gpt-6-astra`, `xhigh` reviewer read the new detailed execution draft against PR #252 source after main integration. No P0; two P1 and one P2. The author corrected the canonical plan before round 2.

1. A stable logical session identity is distinct from the captured authority/generation fence for an individual command. The plan now names both and forbids an old command from silently adopting a newer fence.
2. Transient auth revalidation failure previously would unmount `HostedAuthGate`'s shell and destroy the pending registry. The plan now retains the mounted shell in a visible revalidating/error state until verified authority loss.
3. Existing stable dependency comment IDs prove deduplication, not notification delivery: the comment is inserted before the send, and replay of an existing comment skips notification. The plan guarantees follow-up reconciliation only for a stop after reset write and before the helper starts. A stop inside the helper remains best effort; a stronger delivery guarantee would need a separately accepted 120-250 changed LOC slice.

## Astra xhigh execution-plan cycle, round 2 - runtime evidence and list integrity

An independent local `gpt-6-astra`, `xhigh` reviewer found two P1 and one P2, all corrected before round 3.

1. Production `LegacyTeamLifecycleReadSource.listLifecycle()` emits static `deleted/draft/degraded/ready`, not `running/stopped`; `ready` cannot drive the running Dashboard or an offline filter. Existing authenticated `team-lifecycle/control-state` supplies positive runtime evidence: exact `['stop']` with runId means running, exact `['launch']` with null runId means idle, other shapes mean unknown. The plan now uses one bounded wave (concurrency four, common deadline, scope fence), marks incomplete results, and tests queued and late replies. This adds 450-850 changed LOC and 6-12 human hours to D1; no new Owner endpoint is planned.
2. `HostedAuthHttpController.projectWorkspaceId()` collapses storage failure to null; the lifecycle list route can silently drop the affected team and return successful empty. The plan requires a typed/strict projection outcome and retryable list failure while retaining stale rows and selection. This adds 100-220 changed LOC and 2-4 human hours to N1.
3. `HostedApplicationShell.loadWorkspaces()` clears `selectedTeamId` on any successful workspace list, including same-scope refresh. The plan removes that unconditional reset and preserves the F2 session across valid refresh.

## Astra xhigh execution-plan cycle, round 3 - negative evidence and race cases

An independent local `gpt-6-astra`, `xhigh` reviewer found no P0/P1 and one P2. The author corrected it in the canonical plan and compact draft.

1. The previous selection rule demanded a negative selected-team bootstrap/admission check even after a complete, current directory snapshot. Current bootstrap transport maps different non-200 causes to unavailable, so `403/503` cannot provide trustworthy negative proof. Once grant-projection failure is surfaced as a list error, a later complete scope/watermark-current snapshot may reconcile a previously confirmed team disappearance. A newly created target stays pending until first confirmed presence; failed/partial/stale reads cannot clear it. UI selection and F2 unresolved intent have separate lifetimes.
2. The D1 conformance and race tests now include the current `['stop','recover']` fixture as unknown, more than four teams, queued work past the deadline, and a late result from an old wave. The shared directory read owner remains above the workspace SSE loading/error branch.

The final prospective estimate after completed I0 is **9,800-17,570 changed LOC and 110-207 human engineering hours** for F0/F1/F2, D1/N1 and I1. The historical total with I0 is **11,000-21,070 changed LOC and 122-239 hours**. It includes the corrections from these three rounds and excludes remaining Core release proof, unrelated PR defects, infrastructure recovery and deferred capabilities. Confidence is 8/10 for source boundaries, 4/10 for D1 LOC and human hours, 5/10 for N1 LOC. These reviews were read-only: they did not execute implementation, tests, live providers or final CI. Hosted fast-tier reviewer admission had previously failed with `checkpoint_publisher_required`; this local reviewer work must not be reported as fast-tier hosted execution.
