import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import {
  classifyOpenCodeDeliveryReplyContract,
  OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT,
} from '../opencode/delivery/OpenCodeDeliveryReplyContract';

import type { OpenCodeTeamRuntimeMessageInput } from './OpenCodeTeamRuntimeAdapter';

export function buildOpenCodeRuntimeMessageText(input: OpenCodeTeamRuntimeMessageInput): string {
  if (input.bootstrapCheckinRetry) {
    const runtimeSessionId = input.bootstrapCheckinRetry.runtimeSessionId.trim();
    // The whole retry prompt is app scaffolding, so it is wrapped as agent-only
    // content: unlike <opencode_app_message_delivery>, the retry tag is not a
    // recognized hidden block, and its raw instructions leaked into the member
    // activity preview and message display.
    return wrapAgentBlock(
      [
        '<opencode_runtime_bootstrap_checkin_retry>',
        'The desktop app detected that this OpenCode session exists, but runtime_bootstrap_checkin has not committed durable runtime evidence yet.',
        input.bootstrapCheckinRetry.reason
          ? `Reason: ${input.bootstrapCheckinRetry.reason.trim()}`
          : null,
        'Before any other tool or message, call MCP tool agent-teams_runtime_bootstrap_checkin or mcp__agent-teams__runtime_bootstrap_checkin with exactly:',
        JSON.stringify({
          runId: input.runId,
          teamName: input.teamName,
          memberName: input.memberName,
          runtimeSessionId,
        }),
        'Do not call member_briefing, task tools, message_send, or cross_team_send before runtime_bootstrap_checkin completes.',
        'After runtime_bootstrap_checkin succeeds, stop this turn immediately and wait silently.',
        'If runtime_bootstrap_checkin is unavailable or fails, reply with one short sentence containing the exact error text, then stop.',
        '</opencode_runtime_bootstrap_checkin_retry>',
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
    );
  }

  const requestedReplyRecipient = input.replyRecipient?.trim() ?? '';
  const replyContract = classifyOpenCodeDeliveryReplyContract(requestedReplyRecipient);
  const isInformationalNotice = replyContract === 'informational';
  // A teammate (not the lead, not the user) sent this message: by team
  // contract that is a status report. Replies are optional; mandatory replies
  // produced "received"/"standing by" ping-pong between teammates.
  const isTeammateReport = replyContract === 'teammate_report';
  const replyRecipient =
    requestedReplyRecipient && !isInformationalNotice ? requestedReplyRecipient : 'user';
  const deliveryContext =
    input.messageId && (input.taskRefs?.length || input.messageKind)
      ? JSON.stringify({
          schemaVersion: 1,
          kind: 'opencode-delivery-context',
          teamName: input.teamName,
          laneId: input.laneId,
          memberName: input.memberName,
          inboundMessageId: input.messageId,
          ...(input.messageKind ? { messageKind: input.messageKind } : {}),
          ...(input.workSyncIntent ? { workSyncIntent: input.workSyncIntent } : {}),
          ...(input.workSyncReviewRequestEventIds?.length
            ? { workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds }
            : {}),
          taskRefs: input.taskRefs,
        })
      : null;
  const isWorkSyncNudge = input.messageKind === 'member_work_sync_nudge';
  const isReviewPickupNudge = isWorkSyncNudge && input.workSyncIntent === 'review_pickup';
  const workSyncToolArgs = buildOpenCodeWorkSyncToolArgs(input);
  const taskIds =
    input.taskRefs
      ?.map((ref) => ref.taskId?.trim())
      .filter((taskId): taskId is string => Boolean(taskId)) ?? [];
  const actionModeWorkScopeReminder =
    input.actionMode === 'ask'
      ? 'Action mode ASK is read-only for this delivered message: do not edit files, change task state, or run side-effecting tools for this message.'
      : input.actionMode === 'delegate'
        ? 'Action mode DELEGATE is orchestration-only for this delivered message: pass the task with context instead of implementing or editing files yourself, then END the turn - never wait or poll for teammates inside the turn (their work is dispatched only after your turn ends).'
        : 'If this delivered message assigns implementation, fixes, review follow-up, or concrete investigation, you may inspect, read/search, and edit files in the project working directory as your available tools allow.';
  const requiredMessageEnvelope = JSON.stringify({
    teamName: input.teamName,
    to: replyRecipient,
    from: input.memberName,
    source: 'runtime_delivery',
    ...(input.messageId ? { relayOfMessageId: input.messageId } : {}),
    ...(input.taskRefs?.length ? { taskRefs: input.taskRefs } : {}),
  });
  // Work-sync nudges are health/reporting probes. Requiring a visible
  // message_send reply here causes false delivery failures, so accept the
  // dedicated member_work_sync_report proof path while keeping normal user
  // messages on the visible reply contract.
  const responseInstructions = isReviewPickupNudge
    ? [
        'This delivered app message is a targeted member-work-sync review pickup nudge.',
        'Process the current review request now if it is still assigned to you. Open the task, verify reviewState/status, then use the review workflow tools to start or continue the review.',
        'Do not mark the review complete from this prompt alone.',
        'A visible agent-teams_message_send reply is optional. Review workflow tool usage or agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) is sufficient response proof.',
        `If you cannot pick up the review now, call agent-teams_member_work_sync_status (or mcp__agent-teams__member_work_sync_status) with ${workSyncToolArgs}, then report state "blocked" or "still_working" only for the real current state.`,
        'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
        taskIds.length ? `Relevant taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.` : null,
        `Do not use provider names, runtime names, or team names as memberName; use exactly "${input.memberName}".`,
        'Do not reply only with acknowledgement.',
      ]
    : isWorkSyncNudge
      ? [
          'This delivered app message is a member-work-sync nudge.',
          'A visible agent-teams_message_send reply is optional. For agenda sync, only agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) is sufficient response proof.',
          `Call agent-teams_member_work_sync_status (or mcp__agent-teams__member_work_sync_status) with ${workSyncToolArgs}.`,
          `Then call agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) with ${workSyncToolArgs}, the returned agendaFingerprint/reportToken, and state "still_working" or "blocked".`,
          'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
          taskIds.length
            ? `When reporting, include taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.`
            : null,
          `Do not use provider names, runtime names, or team names as memberName; use exactly "${input.memberName}".`,
          'Do not reply only with acknowledgement.',
        ]
      : isInformationalNotice
        ? [
            'This delivered app message is an informational system notice, not a request from an addressable teammate.',
            'Do NOT send a visible reply for this notice unless it changes your plan or assigns you concrete new work.',
            `The sender is not a team member. Never call agent-teams_message_send with to="${OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT}"; that recipient does not exist and the call will fail.`,
            `Only if the notice changes your plan and a person must know, call agent-teams_message_send once with teamName="${input.teamName}", to="user", from="${input.memberName}", source="runtime_delivery"${
              input.messageId ? `, relayOfMessageId="${input.messageId}"` : ''
            }, plus concrete text and summary.`,
            'Do not send acknowledgement, confirmation, or received-style messages to anyone for this notice.',
            'Dependency-resolved, task-started, task-completed, and task-comment notices are automated: the app has already notified the task owner. Do NOT forward them, do NOT message the owner to start, continue, or confirm, and do NOT re-assign the task because of them.',
            'If the notice concerns board tasks you own, act through the task tools (task_get, task_start, task_add_comment, task_complete) instead of messaging.',
            'Otherwise end the turn after reading with one short plain-text sentence stating what the notice was about and that no reply is needed. Do not end this turn empty.',
          ]
        : isTeammateReport
          ? [
              `This delivered app message is a status report from your teammate "${replyRecipient}" (task done/started/progress, or an acknowledgement). It is informational: no reply is expected.`,
              `Do NOT reply by default. Never send acknowledgement, confirmation, thanks, "received", "noted", "standing by", "no further work", or status-recap messages to "${replyRecipient}" or anyone else for this report: every message you send costs the recipient a full model turn and it will answer back, creating an endless loop.`,
              'The task board already reflects what the report says (task tools update it directly). Do not forward the report, do not re-assign the task, and do not tell the owner or the next owner to start, continue, or confirm: the app notifies task owners automatically when their work is unblocked or assigned.',
              `Reply ONLY if the report asks you a direct question, requests a decision or hand-off, or describes a blocker that only you can clear. In that case call agent-teams_message_send exactly once with the envelope ${requiredMessageEnvelope} plus concrete text and summary, then stop.`,
              `If, after this report, the work the user originally requested is verifiably complete on the board (every task terminal, required deliverables present) and you have not yet told the user, send the user exactly one final message with teamName="${input.teamName}", to="user", from="${input.memberName}", source="runtime_delivery", text, and summary. Never repeat a final message you already sent.`,
              'Otherwise end the turn with one short plain-text sentence stating what the report was about and that no reply is needed. Do not end this turn empty.',
            ]
          : [
              'To make your reply visible in the app Messages UI, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send if that is the exposed name).',
              `Use teamName="${input.teamName}", to="${replyRecipient}", from="${input.memberName}", text, and summary.`,
              `Required message_send argument envelope: ${requiredMessageEnvelope}. Copy every value exactly, then add non-empty text and summary fields.`,
              'Before calling message_send, verify that teamName, to, from, text, and summary are all present and are strings.',
              'Include source="runtime_delivery" in that message_send call.',
              input.messageId
                ? `Include relayOfMessageId="${input.messageId}" in that message_send call.`
                : null,
              input.taskRefs?.length
                ? `If taskRefs are present in <opencode_delivery_context>, include taskRefs exactly as provided in that message_send call: ${JSON.stringify(input.taskRefs)}.`
                : null,
              'If message_send reports parameter validation failure, correct the missing or invalid arguments from the required envelope and retry exactly once. Do not explain the validation error as the final reply.',
              'If message_send returns an unavailable, not connected, or missing-tool error, write the exact concise reply as plain assistant text once, then stop.',
              'After the message_send tool call succeeds, stop immediately. Do not send follow-up confirmations or repeat the same answer.',
              'You must not end this turn empty.',
              'Do not answer only with plain assistant text when agent-teams_message_send is available.',
            ];

  return [
    '<opencode_app_message_delivery>',
    deliveryContext
      ? `<opencode_delivery_context>${deliveryContext}</opencode_delivery_context>`
      : null,
    'You are running in OpenCode, not Claude Code or Codex native.',
    'REPLAY GUARD: this same inbound message may reach you more than once (delivery retries and session rebuilds replay it). Before acting, check the current task board and your recent sent messages for what this message already produced. Do NOT redo an action that is already complete: do not create a task that already exists, and do not re-send a reply you already sent. Work that is only started or partly done is NOT handled: continue it and finish what is missing. Only when everything this message asked for is verifiably complete, end the turn with one short plain-text line noting it was already handled. Never declare overall completion (for example "ALL DONE") unless the required final state verifiably exists right now.',
    actionModeWorkScopeReminder,
    ...responseInstructions,
    'Do not call runtime_bootstrap_checkin or member_briefing just to answer this delivered app message.',
    'Do not use SendMessage or runtime_deliver_message for ordinary visible replies.',
    'Do not invent placeholder task labels. If no explicit taskRefs are provided and the reply is not about a real board task, do not prefix text or summary with a # task label; never use #00000000.',
    'The inbound app message follows. Treat it as the actual instruction to process now, not as background context.',
    'If the inbound message asks for exact reply text, use that exact text. Do not replace concrete instructions with a generic greeting or availability message.',
    input.actionMode ? `Action mode for this message: ${input.actionMode}.` : null,
    '</opencode_app_message_delivery>',
    '',
    '<opencode_inbound_app_message>',
    input.text,
    '</opencode_inbound_app_message>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildOpenCodeWorkSyncToolArgs(input: OpenCodeTeamRuntimeMessageInput): string {
  const args = [`teamName="${input.teamName}"`, `memberName="${input.memberName}"`];
  const controlUrl = input.controlUrl?.trim();
  if (controlUrl) {
    args.push(`controlUrl=${JSON.stringify(controlUrl)}`);
  }
  return args.join(', ');
}
