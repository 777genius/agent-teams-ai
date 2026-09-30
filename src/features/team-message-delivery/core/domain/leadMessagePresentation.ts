import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import type { TeamRosterMember } from './messageDeliveryModels';
import type { AgentActionMode } from '@shared/types';

export function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: TeamRosterMember[]
): string | null {
  if (teammates.length === 0) return null;
  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');
  return [
    'Current durable team context:',
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    '- This team is NOT in solo mode',
    '- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.',
  ].join('\n');
}

export function buildLeadDirectDelegateAckBlock(actionMode?: AgentActionMode): string | null {
  if (actionMode !== 'delegate') return null;
  return wrapAgentBlock(
    [
      'DELEGATE MODE USER ACK CONTRACT:',
      'Before any task creation, delegation, or other tool use, begin your next assistant response with one short human-readable acknowledgement to the user.',
      'That acknowledgement must be visible plain text, not only an agent-only block.',
      'Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.',
      'After that visible acknowledgement, continue with delegation/orchestration in the same turn.',
    ].join('\n')
  );
}

export function buildLiveLeadDeliveryText(input: {
  messageId: string;
  text: string;
  actionModeBlock: string;
  rosterContextBlock: string | null;
  delegateAckBlock: string | null;
}): string {
  return [
    'You received a direct message from the user.',
    'IMPORTANT: Your text response here is shown to the user in the Messages panel. Always include a brief human-readable reply. Do NOT respond with only an agent-only block.',
    ...(input.rosterContextBlock ? [input.rosterContextBlock] : []),
    ...(input.delegateAckBlock ? [input.delegateAckBlock] : []),
    wrapAgentBlock(
      [
        `MessageId: ${input.messageId}`,
        `When creating a task from this user message, prefer task_create_from_message with messageId="${input.messageId}" for reliable provenance. Only use this exact messageId — never guess or fabricate one.`,
      ].join('\n')
    ),
    '',
    'Message from user:',
    buildMessageDeliveryText(input.text, {
      actionModeBlock: input.actionModeBlock,
      isLeadRecipient: true,
    }),
  ].join('\n');
}

export function buildMessageDeliveryText(
  baseText: string,
  options: {
    actionModeBlock?: string;
    isLeadRecipient: boolean;
    memberName?: string;
    messageId?: string;
    protocol?: 'send_message' | 'agent_teams_message_send';
    replyRecipient?: string;
    teamName?: string;
  }
): string {
  const hiddenBlocks: string[] = [];
  if (options.actionModeBlock) hiddenBlocks.push(options.actionModeBlock);
  if (!options.isLeadRecipient) {
    const rawReplyRecipient =
      typeof options.replyRecipient === 'string' && options.replyRecipient.trim().length > 0
        ? options.replyRecipient.trim()
        : 'user';
    const isUserReplyRecipient = rawReplyRecipient.toLowerCase() === 'user';
    const replyRecipient = isUserReplyRecipient ? 'user' : rawReplyRecipient;
    const senderDescriptor = isUserReplyRecipient ? 'the human user' : `"${replyRecipient}"`;
    const canUseAgentTeamsMessageSend =
      options.protocol === 'agent_teams_message_send' &&
      isUserReplyRecipient &&
      typeof options.teamName === 'string' &&
      options.teamName.trim().length > 0 &&
      typeof options.memberName === 'string' &&
      options.memberName.trim().length > 0 &&
      typeof options.messageId === 'string' &&
      options.messageId.trim().length > 0;
    const replyInstructionLines = canUseAgentTeamsMessageSend
      ? [
          'CRITICAL: Reply using the Agent Teams MCP message_send tool, not SendMessage.',
          'Use tool agent-teams_message_send or mcp__agent-teams__message_send, whichever exposed name is available.',
          `CRITICAL: The tool input must include teamName="${options.teamName!.trim()}", to="user", from="${options.memberName!.trim()}", text, summary, source="runtime_delivery", and relayOfMessageId="${options.messageId!.trim()}".`,
          'Do NOT answer only with normal assistant text when the Agent Teams message_send tool is available because that will not appear in the UI message thread.',
        ]
      : [
          'CRITICAL: Reply using the SendMessage tool, not plain assistant text.',
          `CRITICAL: The destination must be exactly to="${replyRecipient}".`,
          'CRITICAL: The SendMessage tool input must use the exact field names `to`, `summary`, and `message`.',
          'Do NOT answer only with normal assistant text because that will not appear in the UI message thread.',
        ];
    hiddenBlocks.push(
      wrapAgentBlock(
        [
          `You received a direct message from ${senderDescriptor} via the UI.`,
          ...replyInstructionLines,
          `Please reply back to recipient "${replyRecipient}" with a short, human-readable answer.`,
          'If you cannot respond now, reply with a brief status (e.g. "Busy, will reply later").',
          ...(canUseAgentTeamsMessageSend
            ? [
                'If neither Agent Teams MCP message_send tool name is available before any visible-message tool attempt, write exactly the concise reply text as normal assistant text so the runtime can relay it.',
              ]
            : []),
          ...(isUserReplyRecipient
            ? [
                'CRITICAL: If the user asks you to check with the lead or another teammate before you can fully answer, FIRST send a short acknowledgement to "user" so the human sees you started (for example: "Принял, сейчас уточню и вернусь с ответом.").',
                'Only after that first acknowledgement may you message the lead or another teammate.',
                'After you get the needed information, send the final answer back to "user".',
                'Do NOT stay silent while you go ask someone else.',
              ]
            : []),
        ].join('\n')
      )
    );
  }
  return hiddenBlocks.length === 0 ? baseText : [...hiddenBlocks, baseText].join('\n\n');
}
