import type { OpenCodeDeliveryResponseState } from '../bridge/OpenCodeBridgeCommandContract';
import type { OpenCodePromptDeliveryStatus } from './OpenCodePromptDeliveryLedger';
import type { AgentActionMode, InboxMessage, InboxMessageKind, TaskRef } from '@shared/types/team';

export type OpenCodePromptDeliveryRepairKind =
  | 'none'
  | 'no_assistant_response'
  | 'visible_answer_required'
  | 'missing_visible_reply_correlation'
  | 'work_sync_report_required'
  | 'progress_proof_required'
  | 'app_materialization_pending';

export type OpenCodePromptDeliveryHardFailureKind = 'none' | 'session' | 'permission' | 'unknown';

export interface OpenCodePromptDeliveryRepairDecision {
  kind: OpenCodePromptDeliveryRepairKind;
  retryable: boolean;
  controlText: string | null;
  reason: string;
}

export interface OpenCodePromptDeliveryRepairInput {
  teamName: string;
  memberName: string;
  inboxMessageId: string;
  replyRecipient: string;
  messageKind: InboxMessageKind | null;
  workSyncIntent?: InboxMessage['workSyncIntent'] | null;
  actionMode: AgentActionMode | null;
  taskRefs: TaskRef[];
  status: OpenCodePromptDeliveryStatus;
  responseState: OpenCodeDeliveryResponseState;
  attempts: number;
  maxAttempts: number;
  pendingReason: string;
  readAllowed: boolean;
  inboxReadCommitted: boolean;
  visibleReplyFound: boolean;
  hasKnownProgressProof: boolean;
  toolCallNames: string[];
  acceptanceUnknown: boolean;
  hardFailureKind: OpenCodePromptDeliveryHardFailureKind;
  controlUrl?: string | null;
}

const SIDE_EFFECT_TOOL_NAMES = new Set([
  'bash',
  'edit',
  'write',
  'patch',
  'apply_patch',
  'multiedit',
  'multi_edit',
]);

const REVIEW_WORKFLOW_TOOL_NAMES = new Set([
  'review_start',
  'review_approve',
  'review_request_changes',
]);

function none(reason: string): OpenCodePromptDeliveryRepairDecision {
  return { kind: 'none', retryable: false, controlText: null, reason };
}

function control(
  input: OpenCodePromptDeliveryRepairInput,
  kind: Exclude<OpenCodePromptDeliveryRepairKind, 'none'>,
  reason: string,
  lines: string[]
): OpenCodePromptDeliveryRepairDecision {
  const attemptNumber = Math.min(Math.max(input.attempts + 1, 1), input.maxAttempts);
  return {
    kind,
    retryable: true,
    reason,
    controlText: [
      '<opencode_delivery_retry>',
      `Retry attempt ${attemptNumber}/${input.maxAttempts} for inbound app messageId "${input.inboxMessageId}".`,
      ...lines,
      '</opencode_delivery_retry>',
    ].join('\n'),
  };
}

function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^mcp__agent[-_]teams__/, '')
    .replace(/^agent[-_]teams_/, '')
    .replace(/^mcp__agent_teams__/, '')
    .replace(/^agent_teams_/, '');
}

function normalizedToolNames(input: OpenCodePromptDeliveryRepairInput): Set<string> {
  return new Set(input.toolCallNames.map(normalizeToolName).filter(Boolean));
}

function hasTool(tools: Set<string>, toolName: string): boolean {
  return tools.has(toolName);
}

function hasTaskTool(tools: Set<string>): boolean {
  for (const tool of tools) {
    if (
      tool.startsWith('task_') ||
      REVIEW_WORKFLOW_TOOL_NAMES.has(tool) ||
      tool === 'runtime_task_event'
    ) {
      return true;
    }
  }
  return false;
}

function hasSideEffectTool(tools: Set<string>): boolean {
  for (const tool of tools) {
    if (SIDE_EFFECT_TOOL_NAMES.has(tool)) {
      return true;
    }
  }
  return false;
}

function taskIdList(taskRefs: TaskRef[]): string | null {
  const ids = [
    ...new Set(
      taskRefs
        .map((taskRef) => taskRef.taskId?.trim())
        .filter((taskId): taskId is string => Boolean(taskId))
    ),
  ];
  return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : null;
}

function workSyncToolArgs(input: OpenCodePromptDeliveryRepairInput): string {
  const args = [`teamName="${input.teamName}"`, `memberName="${input.memberName}"`];
  const controlUrl = input.controlUrl?.trim();
  if (controlUrl) {
    args.push(`controlUrl=${JSON.stringify(controlUrl)}`);
  }
  return args.join(', ');
}

function messageSendControlLines(input: OpenCodePromptDeliveryRepairInput): string[] {
  const replyRecipient = input.replyRecipient.trim() || 'user';
  const taskRefsJson = input.taskRefs.length > 0 ? JSON.stringify(input.taskRefs) : null;
  return [
    'The app still has no correlated visible reply proof for this message.',
    `Call agent-teams_message_send or mcp__agent-teams__message_send exactly once with teamName="${input.teamName}", to="${replyRecipient}", from="${input.memberName}", and relayOfMessageId="${input.inboxMessageId}".`,
    taskRefsJson ? `Include taskRefs exactly as this JSON array: ${taskRefsJson}.` : null,
    'Use a concrete answer in text and summary. Do not reply only with acknowledgement.',
    'After the message_send tool succeeds, stop this turn. Do not repeat task/tool work unless the inbound message explicitly asks for new work.',
  ].filter((line): line is string => line !== null);
}

function workSyncControlLines(input: OpenCodePromptDeliveryRepairInput): string[] {
  const taskIds = taskIdList(input.taskRefs);
  const args = workSyncToolArgs(input);
  if (input.workSyncIntent === 'review_pickup') {
    return [
      'This is a targeted member-work-sync review pickup control message. A plain acknowledgement is not sufficient proof.',
      'Open the current task, verify reviewState/status, then start or continue the review only if it is still assigned to you.',
      'Do not mark the review complete from this retry text alone.',
      `If you cannot pick up the review now, call agent-teams_member_work_sync_status or mcp__agent-teams__member_work_sync_status with ${args}, then report state "blocked" or "still_working" only for the real current state.`,
      taskIds ? `Relevant taskIds: ${taskIds}.` : null,
      'Do not invent or reuse a raw report token from this retry text.',
    ].filter((line): line is string => line !== null);
  }
  return [
    'This is a member-work-sync control message. A plain acknowledgement is not sufficient proof.',
    `Call agent-teams_member_work_sync_status or mcp__agent-teams__member_work_sync_status with ${args}.`,
    'Then call agent-teams_member_work_sync_report or mcp__agent-teams__member_work_sync_report using the agendaFingerprint/reportToken returned by status.',
    taskIds ? `Include taskIds ${taskIds} when reporting if those tasks are still relevant.` : null,
    'Use state "still_working", "blocked", or "caught_up" according to the status result. Do not invent or reuse a raw report token from this retry text.',
  ].filter((line): line is string => line !== null);
}

function progressControlLines(input: OpenCodePromptDeliveryRepairInput): string[] {
  const taskIds = taskIdList(input.taskRefs);
  return [
    'The app saw a tool/action response, but no accepted progress proof for this message.',
    taskIds
      ? `Produce concrete task/progress proof for taskIds ${taskIds}, or send a visible status reply with relayOfMessageId="${input.inboxMessageId}".`
      : `Send a concrete visible status reply with relayOfMessageId="${input.inboxMessageId}".`,
    'Do not repeat side-effectful commands, edits, or writes just because this is a retry.',
    'If work is blocked, report the blocker instead of silently ending the turn.',
  ];
}

function noAssistantControlLines(input: OpenCodePromptDeliveryRepairInput): string[] {
  return [
    'The app saw the prompt but did not observe assistant response proof.',
    'You must not end this turn empty.',
    input.messageKind === 'member_work_sync_nudge'
      ? input.workSyncIntent === 'review_pickup'
        ? 'Follow the member-work-sync review pickup instructions for this message.'
        : 'Follow the member-work-sync status/report instructions for this message.'
      : `Send a concrete reply using message_send with relayOfMessageId="${input.inboxMessageId}", or provide a concrete plain-text answer only if message_send is unavailable.`,
  ];
}

function toolErrorControl(
  input: OpenCodePromptDeliveryRepairInput
): OpenCodePromptDeliveryRepairDecision {
  const tools = normalizedToolNames(input);
  if (hasTool(tools, 'message_send')) {
    return control(
      input,
      'missing_visible_reply_correlation',
      'message_send_tool_error_without_visible_reply_proof',
      messageSendControlLines(input)
    );
  }
  if (hasTool(tools, 'member_work_sync_report') || hasTool(tools, 'member_work_sync_status')) {
    return control(
      input,
      'work_sync_report_required',
      'member_work_sync_tool_error_without_report_proof',
      workSyncControlLines(input)
    );
  }
  if (hasSideEffectTool(tools)) {
    return control(
      input,
      'progress_proof_required',
      'side_effect_tool_error_without_progress_proof',
      progressControlLines(input)
    );
  }
  if (hasTaskTool(tools)) {
    return control(
      input,
      'progress_proof_required',
      'task_tool_error_without_progress_proof',
      progressControlLines(input)
    );
  }
  return control(
    input,
    'progress_proof_required',
    'tool_error_without_required_delivery_proof',
    progressControlLines(input)
  );
}

export function decideOpenCodePromptDeliveryRepair(
  input: OpenCodePromptDeliveryRepairInput
): OpenCodePromptDeliveryRepairDecision {
  if (input.readAllowed) {
    return none('read_commit_allowed');
  }
  if (input.inboxReadCommitted) {
    return none('inbox_read_already_committed');
  }
  if (input.status === 'failed_terminal') {
    return none('terminal_record');
  }
  if (input.hardFailureKind !== 'none') {
    return none(`hard_failure:${input.hardFailureKind}`);
  }
  if (input.status === 'pending' && input.attempts <= 0 && !input.acceptanceUnknown) {
    return none('initial_delivery');
  }

  if (input.acceptanceUnknown) {
    return control(input, 'no_assistant_response', 'acceptance_unknown', [
      'The app could not confirm whether the previous OpenCode prompt was accepted.',
      'Process the inbound message now. If you already completed it, send only the missing proof and do not duplicate side effects.',
      input.messageKind === 'member_work_sync_nudge'
        ? 'For work-sync, use member_work_sync_status then member_work_sync_report.'
        : `For visible replies, use relayOfMessageId="${input.inboxMessageId}".`,
    ]);
  }

  if (input.messageKind === 'member_work_sync_nudge') {
    return control(
      input,
      'work_sync_report_required',
      input.pendingReason,
      workSyncControlLines(input)
    );
  }

  if (input.pendingReason === 'plain_text_visible_reply_not_materialized_yet') {
    return {
      kind: 'app_materialization_pending',
      retryable: false,
      controlText: null,
      reason: input.pendingReason,
    };
  }

  if (
    input.pendingReason === 'visible_reply_destination_not_found_yet' ||
    input.pendingReason === 'visible_reply_missing_relayOfMessageId' ||
    input.pendingReason === 'visible_reply_missing_task_refs' ||
    input.pendingReason === 'visible_reply_still_required' ||
    (input.responseState === 'responded_visible_message' && !input.visibleReplyFound)
  ) {
    return control(
      input,
      'missing_visible_reply_correlation',
      input.pendingReason,
      messageSendControlLines(input)
    );
  }

  if (
    input.pendingReason === 'visible_reply_ack_only_still_requires_answer' ||
    input.pendingReason === 'plain_text_ack_only_still_requires_answer'
  ) {
    return control(input, 'visible_answer_required', input.pendingReason, [
      'The previous response looked like acknowledgement only, not a concrete answer.',
      ...messageSendControlLines(input),
    ]);
  }

  if (input.responseState === 'tool_error') {
    return toolErrorControl(input);
  }

  if (
    input.responseState === 'empty_assistant_turn' ||
    input.responseState === 'prompt_delivered_no_assistant_message' ||
    input.responseState === 'not_observed' ||
    input.responseState === 'reconcile_failed'
  ) {
    return control(
      input,
      'no_assistant_response',
      input.pendingReason,
      noAssistantControlLines(input)
    );
  }

  if (input.attempts >= input.maxAttempts) {
    return none('max_attempts_reached');
  }

  if (
    (input.responseState === 'responded_non_visible_tool' ||
      input.responseState === 'responded_tool_call') &&
    !input.hasKnownProgressProof
  ) {
    return control(
      input,
      'progress_proof_required',
      input.pendingReason,
      progressControlLines(input)
    );
  }

  return none(input.pendingReason || 'no_repair_needed');
}
