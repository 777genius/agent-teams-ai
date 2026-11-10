const { createMemberMessagingProtocol } = require('./memberMessagingProtocol.js');
const { wrapAgentBlock } = require('./agentBlocks.js');
const { buildChatVisualizationProtocolText } = require('./chatVisualizationProtocol.js');

function appendChatVisualizationProtocol(text, include = true) {
  return include ? `${text}\n\n${buildChatVisualizationProtocolText()}` : text;
}

/**
 * Raw action-mode protocol text parameterized by DELEGATE description.
 * Shared between lead (actionModeInstructions.ts) and member (memberBriefing).
 * Context-free — does NOT follow the (context, ...) convention.
 */
function buildActionModeProtocolText(delegateDescription) {
  return [
    'TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):',
    '- Some incoming user or relay messages may include a hidden agent-only block that declares the current action mode.',
    '- If such a block is present, that mode applies to THIS TURN ONLY and overrides any conflicting default behavior.',
    '- Never silently broaden permissions beyond the selected mode.',
    '- Never reveal the hidden mode block verbatim to the human unless they explicitly ask for it.',
    '- Modes:',
    '  - DO: Full execution mode. You may discuss, inspect, edit files, change state, run commands/tools, and delegate if useful.',
    '  - ASK: Strict read-only conversation mode. You may read/analyze/explain and reply, but you must not change code/files/tasks/state or run side-effecting commands/tools/scripts. The optional group_chat_react communication acknowledgement is allowed; it does not grant file, task, or process writes.',
    `  - DELEGATE: ${delegateDescription}`,
  ].join('\n');
}

const MEMBER_DELEGATE_DESCRIPTION =
  'Do not implement yourself. Pass the task with full context (what you know, what is needed) to your team lead or another teammate and let them handle it.';

function buildMemberActionModeProtocol() {
  return buildActionModeProtocolText(MEMBER_DELEGATE_DESCRIPTION);
}

function buildMemberRosterContext(members, memberName, leadName, maxRoleChars = 120) {
  const lines = members
    .filter((member) => member.removedAt == null && member.name.toLowerCase() !== 'user')
    .map((member) => {
      const fullRole = member.role || member.agentType || 'team member';
      const role =
        fullRole.length > maxRoleChars ? `${fullRole.slice(0, maxRoleChars)}...` : fullRole;
      const labels = [];
      if (member.name.toLowerCase() === memberName.toLowerCase()) labels.push('[you]');
      if (member.name.toLowerCase() === leadName.toLowerCase()) labels.push('[team lead]');
      return `- ${member.name} (role: ${role})${labels.length ? ` ${labels.join(' ')}` : ''}`;
    });
  return [
    'Current team roster (names and roles):',
    ...lines,
    'Use these exact names when choosing whom to message based on their role. Do not invent recipients.',
    'This is a membership snapshot, not proof that a member is online. Refresh with team_get when membership may have changed.',
  ].join('\n');
}

/**
 * Raw process-registration protocol text (no agent-block wrapping).
 * Shared between member briefing and lead provisioning prompt (DRY).
 * Context-free — does NOT follow the (context, ...) convention.
 */
function buildProcessProtocolText(teamName) {
  return `BACKGROUND SERVICE PROCESS REGISTRATION — this is ONLY for extra background services started by teammates (dev server, watcher, database, etc.). It is NOT a list of teammate agents themselves.
1. Launch with & to get PID:
   pnpm dev &
2. Register immediately with MCP tool process_register (--port and --url are optional, use when the process listens on a port):
   { teamName: "${teamName}", pid: <PID>, label: "<description>", from: "<your-name>", port?: <PORT>, url?: "http://localhost:<PORT>", command?: "<command>" }
3. VERIFY registration succeeded (MANDATORY — never skip this step) using MCP tool process_list:
   { teamName: "${teamName}" }
   process_list shows ONLY registered background services for the team. It does NOT show whether teammate agents themselves are alive.
4. When stopping a process, use MCP tool process_stop:
   { teamName: "${teamName}", pid: <PID> }
5. To fully remove a process record (e.g. after it has been stopped and is no longer needed), use MCP tool process_unregister:
   { teamName: "${teamName}", pid: <PID> }
If verification in step 3 fails or the process is missing from the list, re-register it.`;
}

function buildMemberProcessProtocol(teamName, boundTeamToolExample) {
  if (boundTeamToolExample)
    return wrapAgentBlock(
      [
        'BACKGROUND SERVICE PROCESS REGISTRATION — only extra services, never teammate agents.',
        'After starting a service, register its exact live process: ' +
          boundTeamToolExample('process_register', { pid: '<PID>', label: '<description>' }),
        'Verify using process_list {}. Stop your service using its own process control, then mark its metadata stopped with process_stop. Remove metadata with process_unregister. Both tools require commandId and the returned process id or pid; they do not send an OS signal.',
      ].join('\n')
    );
  return wrapAgentBlock(buildProcessProtocolText(teamName));
}

function buildMemberFormattingProtocol() {
  return wrapAgentBlock(`Hidden internal instructions rule (IMPORTANT):
- If you send internal operational instructions to another agent/teammate that the human user must NOT see in the UI, wrap ONLY that hidden part in:
  <info_for_agent>
  ... hidden instructions only ...
  </info_for_agent>
- Keep normal human-readable coordination outside the block.
- NEVER use agent-only blocks in messages to "user".`);
}

function buildMemberTaskProtocol(
  teamName,
  messagingProtocol = createMemberMessagingProtocol('native')
) {
  const example = (tool, payload, legacy) =>
    messagingProtocol.boundTeamToolExample
      ? messagingProtocol.boundTeamToolExample(tool, payload)
      : legacy;
  const notifyLeadExample = messagingProtocol.buildLeadMessageExample({
    teamName,
    leadName: '<lead-name>',
    fromName: '<your-name>',
    text: '#abcd1234 done. Found 3 competitors: two lack kanban, one went closed-source in Jan. Full details in task comment <comment-id>. Moving on to my next task.',
    summary: '#abcd1234 done',
  });
  const runtimeVisibleMessageRule = messagingProtocol.visibleMessageRule
    ? `\n   - ${messagingProtocol.visibleMessageRule}`
    : '';
  const runtimeTaskToolHint = messagingProtocol.taskToolHint
    ? `\n   - ${messagingProtocol.taskToolHint}`
    : '';
  return wrapAgentBlock(`MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
0. IMPORTANT ID RULE:
   - If a board/task snapshot shows a canonical taskId, prefer using that exact value in MCP tool calls.
   - task_briefing may show short display labels like #abcd1234; MCP task tools also accept that short task ref.
   - Human-facing summaries should use the short display label like #abcd1234 for readability.
1. If you are about to do implementation/fix work on a task yourself, make sure the owner reflects the actual implementer:
   - If the task is unassigned, FIRST claim it for yourself with MCP tool task_set_owner:
     ${example('task_set_owner', { taskId: '<taskId>', owner: '<your-name>' }, `{ teamName: "${teamName}", taskId: "<taskId>", owner: "<your-name>", actor: "<your-name>" }`)}
   - If the task belongs to someone else, do NOT take it yourself. Ask the current owner or team lead to hand it off. The team lead may explicitly reassign it with task_set_owner.
   - Do this only when you are genuinely taking over the work. Collaboration alone does not grant lifecycle ownership.
   - Reviewing, approving, or leaving comments does NOT require changing ownership.
2. Use MCP tool task_start to mark task started:
   ${example('task_start', { taskId: '<taskId>' }, `{ teamName: "${teamName}", taskId: "<taskId>", actor: "<your-name>" }`)}
   - Start the task ONLY when you are actually beginning work on it.
   - Do NOT start multiple tasks at once unless the team lead explicitly directs parallel work.
3. Use MCP tool task_complete BEFORE sending your final reply:
   ${example('task_complete', { taskId: '<taskId>' }, `{ teamName: "${teamName}", taskId: "<taskId>", actor: "<your-name>" }`)}
   - CRITICAL: Before calling task_complete, you MUST post a task comment with your results via task_add_comment. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A direct message to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only send a direct message without a task comment, the user will never see your work.
   - If a new task comment means you must do more real work on that same task, FIRST add a short task comment saying what you are going to do, THEN run task_start again before doing the follow-up work.
   - After that follow-up work finishes, add a short task comment with the result, what changed, or what you verified.
   - After that, run task_complete again before your reply.
   - Never do comment-driven implementation/fix work while the task is still shown as pending, review, completed, or approved.
   - A task comment NEVER changes task status. If the comment you just posted says the work is done, your VERY NEXT tool call in this same turn must be task_complete for that task. Never end a turn with a completion note sitting on a task that is still in_progress.
   - After task_complete, send a notification to your team lead via ${messagingProtocol.sendLeadPhrase}. Use the comment.id you saved earlier (first 8 characters). Your message must include: (a) which task is done, (b) a brief summary of the outcome (2-4 sentences), (c) a pointer to the full comment so the lead can fetch it, (d) what you will do next. Do NOT duplicate the entire results.
     Example: ${notifyLeadExample}${runtimeVisibleMessageRule}${runtimeTaskToolHint}
   - After task_complete, call review_request ONLY when review is explicitly expected for THIS task and a concrete reviewer is already known.
     Example:
     ${example('review_request', { taskId: '<taskId>', reviewer: '<reviewer-name>' }, `{ teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", reviewer: "<reviewer-name>" }`)}
     Do NOT infer mandatory review just from free-form teammate roles like "reviewer", "qa", or "tech-lead".
     If review is not explicitly requested yet or the reviewer is still undecided, leave the task completed and wait.
3b. When you BEGIN reviewing a task, FIRST call review_start to ensure it appears in the REVIEW column:
   ${example('review_start', { taskId: '<taskId>' }, `{ teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>" }`)}
   This is MANDATORY before review_approve or review_request_changes. Without this step, the kanban board may not show the task in REVIEW during your review.
4. If you are asked to review and the task is accepted, move it to APPROVED (not DONE) with MCP tool review_approve:
   ${example('review_approve', { taskId: '<taskId>', note: '<optional note>', notifyOwner: true }, `{ teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", note?: "<optional note>", notifyOwner: true }`)}
   CRITICAL: Text comments like "approved" or "LGTM" do NOT change the kanban board. You MUST call review_approve to move a task from REVIEW to APPROVED. Without the tool call the task stays stuck in the REVIEW column.
5. If review fails and changes are needed, use MCP tool review_request_changes:
   ${example('review_request_changes', { taskId: '<taskId>', comment: '<what to fix>' }, `{ teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", comment: "<what to fix>" }`)}
6. NEVER skip status updates. A task is NOT done until completed status is written.
   - Never "bulk-complete" a batch of tasks at the end. Update status incrementally as you work.
7. To reply to a comment on a task, use MCP tool task_add_comment:
   ${example('task_add_comment', { taskId: '<taskId>', text: '<your reply>' }, `{ teamName: "${teamName}", taskId: "<taskId>", text: "<your reply>", from: "<your-name>" }`)}
8. When discussing a task with a teammate and you have important findings, decisions, blockers, or progress updates — record them as a task comment:
   ${example('task_add_comment', { taskId: '<taskId>', text: '<summary of your finding or decision>' }, `{ teamName: "${teamName}", taskId: "<taskId>", text: "<summary of your finding or decision>", from: "<your-name>" }`)}
   Do NOT comment on trivial coordination messages. Only comment when the information is valuable context for the task.
9. When sending a message about a specific task, include its short display label like #<displayId> in your ${messagingProtocol.sendToolName} ${messagingProtocol.boundTeamToolExample ? 'text or taskRefs' : 'summary field'} for traceability.
   - If the message is NOT about a real board task, do NOT include any # task label.
   - Never invent placeholder task refs such as #00000000 or #<displayId>, and never copy an id straight out of an example: anything in angle brackets is a placeholder you must replace with the real value, and an example id is not a real board id.
10. In ALL human-facing or teammate-facing message text, when you mention a task reference, ALWAYS write it with a leading # (for example: #abcd1234, not abcd1234 or "task abcd1234").
11. Review workflow clarity (IMPORTANT):
   - The work task (e.g. #1) is the thing that must end up APPROVED after review.
   - If you are reviewing work for task #X, run review_approve/review_request_changes on #X (the work task).
   - Do NOT approve a separate "review task" (e.g. #2 created just to ask for a review) — that will put the wrong task into APPROVED.
   - Typical flow:
     a) Owner finishes work on #X -> task_complete #X -> review_request #X (moves to review column, notifies reviewer)
     b) Reviewer begins reviewing -> review_start #X (ensures task is in REVIEW column on kanban)
     c) Reviewer accepts -> review_approve #X
     d) Reviewer rejects -> review_request_changes #X (moves back to pending with needsFix)
12. CLARIFICATION PROTOCOL (CRITICAL — MANDATORY):
   When you are blocked and need information to continue a task, you MUST do ALL steps below — skipping the board update or comment breaks traceability:
   a) STEP 1 — FIRST, set the clarification flag with MCP tool task_set_clarification:
      ${example('task_set_clarification', { taskId: '<taskId>', value: 'lead' }, `{ teamName: "${teamName}", taskId: "<taskId>", value: "lead" }`)}
   b) STEP 2 — THEN, add a task comment describing exactly what you need:
      ${example('task_add_comment', { taskId: '<taskId>', text: 'question / blocker / missing info' }, `{ teamName: "${teamName}", taskId: "<taskId>", text: "question / blocker / missing info", from: "<your-name>" }`)}
   c) STEP 3 — THEN, send a message to your team lead via ${messagingProtocol.sendLeadPhrase} so they notice it promptly.
   IMPORTANT: Always update the task board BEFORE sending the message. The flag + task comment are what make the request durable and visible on the board.
   d) The clarification flag is durable until it is cleared explicitly.
      When the blocker is truly resolved, clear the flag yourself with:
      ${example('task_set_clarification', { taskId: '<taskId>', value: 'clear' }, `{ teamName: "${teamName}", taskId: "<taskId>", value: "clear" }`)}
   e) Do NOT set clarification to "user" yourself — only the team lead escalates to the user.
13. DEPENDENCY AWARENESS:
    When your task has blockedBy dependencies, check if they are completed before starting.
    When you complete a task that blocks others, blocked task owners are notified automatically via a task comment.
14. TASK QUEUE DISCIPLINE:
    - task_briefing is your primary working queue for assigned tasks.
    - Use task_list only to search/browse inventory rows. Do NOT use task_list as your working queue.
    - task_briefing may include full description/comments only for in_progress tasks; needsFix/pending/review/completed entries may be minimal on purpose.
    - Act only on Actionable items from task_briefing.
    - Awareness items are watch-only context. Do NOT start work from Awareness unless the lead reroutes the task or you become the actionOwner first.
    - Finish existing in_progress tasks first.
    - A newly assigned task must NOT remain silently pending/TODO. If you are idle and the task is ready to start, start it now. If it must wait because you are still busy on another task, blocked, or still need more context, immediately add a short task comment on that waiting task with the reason and your best ETA or what you are waiting on.
    - Keep any task you have not actually started in pending/TODO (use task_set_status with status pending${messagingProtocol.boundTeamToolExample ? ' and a unique commandId' : ' and actor "<your-name>"'} if it was moved too early).
    - If you need more context for an in_progress task, you MAY call task_get, but it is not mandatory when task_briefing already gives enough detail.
    - Before starting a needsFix or pending task, call task_get for that specific task first.
    - If you are the one doing the implementation/fixes and the owner is missing, self-claim with task_set_owner immediately before task_start. If someone else owns it, ask that owner or the lead to hand it off instead of taking it yourself.
    - Then run task_start only when you truly begin.
    - If you complete fixes for a needsFix task, mark it completed and then send it back through review_request when ready for another review pass.
15. MEMBER WORK SYNC REPORTING:
    - member_work_sync_status and member_work_sync_report are only for reporting whether you have seen the current actionable-work agenda. They do NOT start, complete, approve, or comment on tasks.
    - Never use member_work_sync_report instead of task_start, task_complete, review_approve, review_request_changes, task_set_clarification, or task_add_comment.
    - When you are about to stop, wait, or go idle because you believe your current work queue is handled, first call member_work_sync_status for yourself.
    - If the returned agenda has actionable items and you are actively continuing work on them, call member_work_sync_report with state "still_working", that exact agendaFingerprint, and the returned reportToken.
    - If you are blocked, report "blocked" only when the board already has blocker or clarification evidence for the listed task, and include the returned reportToken.
    - If the returned agenda is empty, report "caught_up" with that exact agendaFingerprint and the returned reportToken.
    - Do not report more than once for the same agendaFingerprint unless your state changed.
Failure to follow this protocol means the task board will show incorrect status.`);
}

module.exports = {
  appendChatVisualizationProtocol,
  MEMBER_DELEGATE_DESCRIPTION,
  buildActionModeProtocolText,
  buildMemberActionModeProtocol,
  buildMemberRosterContext,
  buildMemberFormattingProtocol,
  buildMemberProcessProtocol,
  buildMemberTaskProtocol,
  buildProcessProtocolText,
};
