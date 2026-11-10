import { hasGroupChatEnvelopeMarker } from './contracts.js';

import { effectiveGroupMembers, GroupChatError, isGroupUuid } from './model.js';

import type { AgentGroupChatCreateRequest } from './contracts.js';
import type { GroupChat } from './model.js';

export function admitGroupCreationOriginal(
  row: Record<string, unknown>,
  request: AgentGroupChatCreateRequest,
  groups: GroupChat[],
  roster: string[],
  leadName: string | null
): string[] {
  if (
    row.source !== 'user_sent' ||
    row.from !== 'user' ||
    typeof row.text !== 'string' ||
    !row.text.trim() ||
    typeof row.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(row.timestamp)) ||
    typeof row.read !== 'boolean' ||
    row.relayOfMessageId !== undefined ||
    row.conversationId !== undefined ||
    row.replyToConversationId !== undefined ||
    (row.teamName !== undefined && row.teamName !== request.teamName) ||
    (row.messageKind !== undefined && row.messageKind !== 'default') ||
    row.slashCommand !== undefined ||
    row.commandOutput !== undefined ||
    row.runtimeRecovery !== undefined ||
    row.workSyncIntent !== undefined ||
    /^\s*\//.test(row.text)
  )
    throw new GroupChatError(
      'invalid-user-request',
      'Source must be an original ordinary human request'
    );
  if (hasGroupChatEnvelopeMarker(row)) {
    if (
      row.groupChatProtocolVersion !== 1 ||
      row.messageId !== row.groupMessageId ||
      row.to !== 'user' ||
      !isGroupUuid(row.groupChatId) ||
      !Array.isArray(row.groupRecipientNames)
    )
      throw new GroupChatError(
        'invalid-user-request',
        'Source must be the canonical group original'
      );
    const recipients = row.groupRecipientNames as string[];
    const group = groups.find((entry) => entry.id === row.groupChatId);
    if (
      !recipients.includes(request.from) ||
      !group ||
      group.archivedAt ||
      !effectiveGroupMembers(group, roster).includes(request.from)
    )
      throw new GroupChatError(
        'request-not-addressed',
        'Source group no longer addresses this actor'
      );
    return [...recipients];
  }
  if (row.to !== request.from)
    throw new GroupChatError('request-not-addressed', 'Original request addresses another actor');
  if (row.actionMode !== 'do' && !(row.actionMode === 'delegate' && request.from === leadName))
    throw new GroupChatError(
      'invalid-user-request',
      'A fresh DO or lead DELEGATE request is required'
    );
  return [request.from];
}
