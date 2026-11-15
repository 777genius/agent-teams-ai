# Human-only final approval and AI review handoff

Status: proposed implementation plan. This PR changes documentation only.

## Problem and outcome

Teams need AI review to finish without granting final human acceptance. Today
`review_approve` both closes the review and places the task in Approved; there is
no successful review-completion handoff to Done. Keep the existing workflow as
the default and offer an opt-in team policy.

## Product contract

Add a settings button to the Approved column header. Its shared Radix menu has
one checkbox: **Only users can move tasks to Approved**. It is unchecked by
default. Use the shared Tooltip and an accessible button label. Support both
board layouts and avoid triggering column dragging when using the button.

Persist `humanOnlyApproval: boolean` with the team's kanban configuration, not
in renderer local storage. Missing values mean false. Only the human settings
surface may change this policy; agents can read it in board/review context.

With the policy disabled, existing review_start, review_approve, and
review_request_changes behavior remains unchanged. With it enabled:

1. The owner completes the work: Done.
2. review_request assigns the same task to a reviewer: Review.
3. The reviewer calls review_start, checks the result, then either requests
   changes or calls the new review_complete command.
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

For retries, the same already-completed cycle is a no-op without duplicate
history, intervals, or notifications. A retry must never close a newer review
cycle: carry/validate the expected review request ID for review_complete. A fresh
review_request after review_completed starts a new cycle and invalidates earlier
review evidence. Reopening work resets reviewed state and the human acceptance
indicator. Deleted and unfinished tasks reject review completion.

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

Read policy and validate/write the transition under the existing team board
lock. A concurrent settings change must not allow approval based on a stale
renderer snapshot. Surface validation/persistence failures and restore the
checkbox to the persisted value.

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

## Implementation sequence

1. Add reviewed/review_completed contracts, history derivation, cycle closure,
   command validation/idempotency, dependency notifications, and focused tests.
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
- Test retry after success, retry after a newer review request, wrong reviewer,
  deleted/reopened task, concurrent setting update, and failed persistence.
- Test dependencies release at Done after AI review, not after human approval.
- Restart and backup/restore preserve the policy; old data remains default-off.
- Cover keyboard/menu interaction, both layouts, indicator and error rollback.
- Run focused controller/lifecycle/transport and renderer checks,
  pnpm lint:fast:files -- <changed files>, pnpm typecheck, full pnpm lint for
  the cross-process implementation, and repository-required CI.

Estimated implementation: 600-1,050 changed/added lines including focused tests,
excluding generated translations/types. This estimate is provisional until the
complete review-state consumer and transport trust-boundary audit is finished.

## Separate bugfix

Reviewer clarification suppression is independent: structured waiting on Lead or
user must remove that review item from actionable work until clarification is
cleared, while preserving Lead's obligation to answer. Ship that fix separately;
this plan does not depend on it being bundled into the workflow implementation.
