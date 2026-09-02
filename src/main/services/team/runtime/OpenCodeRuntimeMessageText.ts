import type { OpenCodeTeamRuntimeMessageInput } from './OpenCodeTeamRuntimeAdapter';

export function buildOpenCodeRuntimeMessageText(input: OpenCodeTeamRuntimeMessageInput): string {
  if (input.bootstrapCheckinRetry) {
    const runtimeSessionId = input.bootstrapCheckinRetry.runtimeSessionId.trim();
    return [
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
      .join('\n');
  }

  const replyRecipient = input.replyRecipient?.trim() || 'user';
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
        ? 'Action mode DELEGATE is orchestration-only for this delivered message: pass the task with context instead of implementing or editing files yourself.'
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
