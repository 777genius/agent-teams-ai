# Human-only final approval and AI review handoff

Status: reviewed implementation contract. Implementation must meet the acceptance checks below before the PR is ready.

## Problem and outcome

Teams need AI review to finish without granting final human acceptance. Today
`review_approve` both closes the review and places the task in Approved; there is
no successful review-completion handoff to Done. Keep the existing workflow as
the default and offer an opt-in team policy.

## Product contract

Add a settings button to the Approved column header. It opens a popover ("Review
flow") with a radio choice of **who gives final approval** and an optional
free-text **instructions for agents** field, saved together with one Save button
(Cancel and closing discard the draft; the popover always opens from the
persisted values). Use the shared Tooltip and an accessible button label.
Support both board layouts and avoid triggering column dragging when using the
button.

Persist `reviewFlow: 'agent_approval' | 'human_approval' | 'lead_then_human'` and optional
`reviewFlowPrompt: string` (trimmed, at most 1000 characters, empty clears it)
with the team's kanban configuration, not in renderer local storage. Missing
`reviewFlow` means `agent_approval` (the existing behavior, the default). The flow
is an enum rather than a boolean so further presets (for example a Lead
sign-off step) can be added without a data migration. Only the human settings
surface may change these values; agents read them through board/review context
(`kanban_get`), and the prompt is also appended to each review request sent to
the reviewer. The prompt is advisory text for agents: it never changes which
tools or actors are permitted, enforcement stays in the controller.

With `agent_approval`, existing review_start, review_approve, and
review_request_changes behavior remains unchanged. With `human_approval`:

1. The owner completes the work: Done.
2. review_request assigns the same task to a reviewer: Review.
3. review_request appends a durable review_requested event with a unique ID and
   puts that ID in the assigned reviewer's notification. review_start also returns
   `reviewRequestId` **in addition to** its existing `ok`, `taskId`, `displayId`,
   and `column` fields, so resumed reviewers can obtain the same ID. The
   reviewer must preserve that ID from the cycle being reviewed (never fetch
   the latest ID only at completion), then either calls
   review_request_changes or review_complete with `expectedReviewRequestId`.
   In `human_approval` mode both agent decisions require that same cycle ID.
4. review_complete closes AI review and returns the task to Done, recording its
   outcome and notifying Lead. The human can inspect the review note/history.
5. Only a human action moves the task to Approved. Human rejection can request
   changes from Done after AI review as well as from Review.

Do not create a second review task, a new board column, or a new work status.
Done includes completed work that has not been reviewed and work whose AI review
has finished; show a reviewed/awaiting-human-acceptance indicator for the latter.

## State and command design

Introduce an explicit review state `reviewed` and terminal review event
`review_completed` (`review` -> `reviewed`). It maps to Done with work status
`completed` and no Review/Approved overlay. Keep reviewState, history-derived
state, kanban placement, and current-cycle resolution consistent. Close open
review intervals and remove the reviewer obligation from work-sync and stall
monitoring. Preserve reviewer identity, review cycle, note, and timestamp.

Expose review_complete through the shared controller taskBoard boundary and
MCP/CLI surfaces. Require an active completed task under review and the assigned
reviewer (or the existing legitimate Lead override), with the same self-review
rules as other review decisions. The command is available independently of the
policy; prompts select review_approve in the default workflow and review_complete
in human-only mode. Return the actual resulting workflow state to callers.

For retries, completing the same already-completed cycle with its original
`expectedReviewRequestId` returns `alreadyCompleted: true` and the **actual**
current state (Done/reviewed, or Approved if a human has subsequently accepted),
without duplicate history, intervals, or notifications. A missing,
unknown, or stale ID (including one from a cycle superseded by review_request,
reopening, or deletion) fails explicitly **without any mutation**; it must never
close a newer cycle. Under `human_approval`, review_request_changes must also
reject missing/stale IDs without changing task status. A fresh review_request after review_completed starts a new
cycle and invalidates earlier review evidence. Reopening work resets reviewed
state and the human acceptance indicator. Deleted and unfinished tasks reject
review completion. Preserve the request ID in event history and the review
completion result; do not add a second persistent cycle-ID field.

## Enforcement and trust boundary

Enforce the policy in the common task-board mutation boundary, not just by
hiding a tool or UI button. When enabled, agent review_approve fails with an
explicit human-approval-required result and guidance to use review_complete.
Do not silently rename AI approval to human acceptance.

The current desktop manual approval path calls approveReview with `from:
leadName`; actor text is not proof of a human action. Add a trusted internal
human-action path/capability wired by the desktop main-process adapter. Agent
MCP/CLI arguments must not be able to manufacture that capability with
`from: user`, an omitted actor, or a public `human: true` flag. Review equivalent
HTTP adapters and only enable manual approval/policy updates for a trusted
interactive user request; if an existing route has no distinguishable trust
context, reject rather than treating every loopback caller as human.

Audit all sanctioned paths to Approved: review_approve, kanban repair,
manual_approve, generic status/field updates, and IPC/HTTP calls. Repair must not
mint an approval; it may only restore placement already authorized by history.
This is an application workflow policy, not filesystem security against agents
that have arbitrary write access to the user's files.

Use the existing controller team-board lock for policy writes, review_request,
review_complete, review_request_changes, and work reopening; each must validate
its cycle ID and commit its state changes while holding that same lock. The main-process UI command calls that controller
mutation; it must not update kanban-state.json through an independent read/write
or renderer snapshot. A concurrent settings change must not allow approval
based on stale state. Surface validation/persistence failures, reload the
persisted policy, and reload the persisted values on error. Keep unrelated kanban
writes from dropping the new property.

## Dependencies and compatibility

Done remains sufficient to satisfy task dependencies, including after AI review.
Human approval is final acceptance, not an additional dependency execution gate.
Do not change dependency semantics or introduce dependency approval settings.
Preserve the current behavior that an open Review blocks dependent tasks.
Notify newly unblocked owners once when review_complete releases them.

Toggling the policy changes future commands only. Do not move existing Approved
cards, replay old review events, or automatically approve waiting Done cards
when the policy is disabled. Existing active reviews use the policy at mutation
time. Existing teams and backups lacking the field keep current behavior.

Update controller and main-process kanban sanitizers/readers/writers, strict
validation, shared contracts, preload/IPC and HTTP adapter parity, and backup
round-trip handling so unrelated board writes do not drop the setting.
Update all review history parsers, task readers/workers, projections, activity
interval consumers, logs and i18n that exhaustively recognize review states or
events. Keep terminal AI review distinct from human approval in user-facing text.

## Three design-review passes and decisions

- **Workflow/state:** no extra task, column, status, or approval dependency
  gate. `reviewed` is a review state on a completed Done task; only a new
  review request or reopening invalidates it.
- **Identity/concurrency:** the review-request event ID is the cycle token;
  deliver it at assignment and via review_start; require it unchanged on
  completion, and reject stale decisions under the same board lock.
- **Integration/security:** treat desktop UI approval/settings as privileged
  commands, not caller-provided `from`/boolean claims. Protect every mutation
  and repair path; keep the default policy false and preserve unknown-free
  backwards-compatible reads and backup round trips.

## Implementation sequence

1. Add reviewed/review_completed contracts, history derivation, cycle closure,
   request-ID delivery/validation, command idempotency, dependency notifications,
   and focused tests, including stale-event rejection.
2. Add persisted policy and trusted human approval/settings commands; cover
   controller, MCP/CLI rejection, repair paths, and transport trust boundaries.
3. Wire the Approved header menu through the app API abstraction. Reuse
   KanbanColumn.headerAccessory in both layouts; keep business policy out of UI.
4. Update review request/bootstrap/briefing instructions so existing and running
   agents can choose the appropriate terminal action from current policy.
5. Verify the complete desktop workflow in a new sandbox via pnpm dev:mcp/CDP,
   then run the repository gates before making the implementation PR ready.

## Acceptance and verification

- Default-off teams retain today's successful AI approval path.
- Enabled teams: owner completes -> reviewer starts -> review_complete -> Done;
  Lead receives the review result and Reviewer has no outstanding obligation.
- Agent review_approve and alternative mutation paths cannot create Approved;
  a genuine human action can approve reviewed Done and request changes from it.
- Test duplicate completion for the same ID (including after human Approved),
  missing/stale ID for completion and request-changes after a newer request,
  wrong reviewer, deleted/reopened task, concurrent policy change,
  and failed persistence. Confirm failure paths do not change task or board.
- Test dependencies release at Done after AI review, not after human approval.
- Restart and backup/restore preserve the policy; old data remains default-off.
- Cover keyboard/menu interaction, both layouts, indicator and error rollback.
- Run focused controller/lifecycle/transport and renderer checks,
  pnpm lint:fast:files -- <changed files>, pnpm typecheck, full pnpm lint for
  the cross-process implementation, and repository-required CI.

Implementation budget: prefer reuse of the existing controller, board lock,
review events, IPC and UI primitives over new services or persistence tables.
Reassess changed-line estimates after auditing all review-state readers; no
arbitrary line target should justify omitting a trust-boundary or regression test.

## Lead sign-off before the human (`lead_then_human`)

Some teams run Developer -> Reviewer -> Lead -> user. The `lead_then_human` flow
keeps everything above (agents never approve; only the desktop user does) and adds
one controller-enforced step between the reviewer and Done.

- When the stage-1 reviewer calls `review_complete`, the controller does not move the
  task to Done. Inside the same board lock it appends one `review_requested` history
  event with `stage: 'lead_signoff'`, `reviewer: <lead>` and
  `afterReviewRequestId: <stage-1 request id>`. The task stays in Review with the Lead
  as the assigned reviewer. No new event type or state: all readers that already
  understand a review cycle keep working.
- The Lead finishes the sign-off with the same tools: `review_complete` (task goes to
  Done, awaiting the user) or `review_request_changes` (task returns to the owner, and
  the next review request starts a full cycle again from the reviewer).
- Decisions are bound to a named actor. `review_complete`, `review_request_changes` (and
  `review_approve` while a sign-off cycle is open) require an explicit `from` (no inference, no `team-lead` default) in `lead_then_human`,
  and also for any open sign-off cycle after the team switched to another flow. The
  explicit `from` must resolve to the assigned reviewer of the open cycle (the Lead, for
  the sign-off); the Lead may also act as any reviewer (existing rule), and a cycle with
  no assigned reviewer can be decided by any named member. This is the app's normal
  trust model for named actors, not an authentication boundary: an agent that names
  itself as the Lead is not distinguished from the Lead. The stage-1 reviewer's old
  request id is rejected as stale.
- A retry of the stage-1 `review_complete` is idempotent only for the reviewer who
  handed off and only while the sign-off is still the latest request; the answer keeps
  `reviewRequestId` (the stage-1 id the caller passed) and returns the new id as
  `leadSignoffRequestId`. Anyone else, or a later cycle, gets the stale-request error.
- Stage 2 is skipped when the explicit deciding actor is the Lead (`actor_is_lead`), when
  the Lead submitted the work (`work_by_lead`: the actor of the latest completion before
  the stage-1 review request; an unknown submitter never skips, and reassigning the owner
  changes nothing), or when no Lead can be resolved (`no_lead`). The cycle then closes as
  in `human_approval`; the `review_complete` payload and the `review_completed` history
  event carry `leadSignoffSkipped` with that reason.
- The Lead may sign off tasks that others submitted, even if they are assigned to it
  later; the lead briefing always files an open sign-off under `Awaiting your sign-off:`.
- The user can approve or reject at any time, including while the Lead has not yet
  signed off. If the Lead is away the task simply waits; the user confirms manually.
- The Lead always sees its pending sign-offs: the lead briefing has an
  `Awaiting your sign-off:` section (with each `expectedReviewRequestId`) and a
  `leadSignoff=N` counter, derived from board state on every call, so it survives
  context compaction.

## Separate bugfix

Reviewer clarification suppression is independent: structured waiting on Lead or
user must remove that review item from actionable work until clarification is
cleared, while preserving Lead's obligation to answer. Ship that fix separately;
this plan does not depend on it being bundled into the workflow implementation.
