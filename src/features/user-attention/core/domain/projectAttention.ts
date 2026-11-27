import { isUserAttentionMessage } from '@features/team-direct-chats';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import {
  isMemberWorkSyncNudgeMessage,
  isReviewPickupEscalationMessage,
  isRuntimeRecoveryNudgeMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import { deduplicateVisibleRelayMessages } from '@shared/utils/teamMessageRelayDeduplication';

import type { AttentionTaskCandidate } from '../../contracts';
import type { InboxMessage, TeamTask } from '@shared/types/team';

function messageIdentity(message: InboxMessage): string {
  // Messenger treats a nonblank ID as opaque (including surrounding spaces).
  const id = message.messageId;
  return typeof id === 'string' && id.trim().length > 0
    ? id
    : `${message.timestamp}-${message.from}-${message.text.slice(0, 80)}`;
}

function isAttentionVisibleMessage(message: InboxMessage): boolean {
  return (
    message.messageKind !== 'task_comment_notification' &&
    !isInboxNoiseMessage(message.text) &&
    !isTeamInternalControlMessageEnvelope(message) &&
    !isMemberWorkSyncNudgeMessage(message) &&
    !isRuntimeRecoveryNudgeMessage(message) &&
    !isReviewPickupEscalationMessage(message) &&
    !isTaskStallRemediationMessage(message) &&
    (!message.groupChatId ||
      Boolean(message.groupMessageId && message.groupMessageId === message.messageId))
  );
}

function projectVisibleAttentionMessage(message: InboxMessage): InboxMessage | null {
  // Decide attention from the complete human-visible text, not hidden agent
  // blocks and not the 240-character preview (mentions may occur later).
  const sanitized = stripAgentBlocks(message.text).trim();
  if (!isUserAttentionMessage({ ...message, text: sanitized })) return null;

  // Capture the existing read identity before truncating user-visible preview.
  const messageId = messageIdentity(message);
  const attachmentCount =
    (message.attachments?.length ?? 0) + (message.fileReferences?.length ?? 0);
  // An attachment-only message is still a message addressed to the user.
  const text =
    sanitized.slice(0, 240) || (attachmentCount > 0 ? `Attachment (${attachmentCount})` : '');
  if (!text) return null;
  return {
    from: message.from,
    to: message.to,
    text,
    timestamp: message.timestamp,
    messageId,
    read: message.read,
    source: message.source,
    groupChatId: message.groupChatId,
    groupMessageId: message.groupMessageId,
  };
}

/** Project just the human-facing candidate, never internal agent traffic. */
export function projectAttentionMessage(message: InboxMessage): InboxMessage | null {
  return isAttentionVisibleMessage(message) ? projectVisibleAttentionMessage(message) : null;
}

/** Canonicalize the same visible relay messages as Messenger before projecting previews. */
export function projectAttentionMessages(
  messages: readonly InboxMessage[],
  leadNames: Iterable<string>
): InboxMessage[] {
  const visible = deduplicateVisibleRelayMessages(
    messages.filter(isAttentionVisibleMessage),
    leadNames
  );
  return visible.flatMap((message) => {
    const candidate = projectVisibleAttentionMessage(message);
    return candidate ? [candidate] : [];
  });
}

export function projectAttentionTasks(
  tasks: readonly TeamTask[],
  team: { teamName: string; logicalTeamName?: string; displayName: string; projectPath?: string }
): AttentionTaskCandidate[] {
  return tasks
    .filter(
      (task) => task.needsClarification === 'user' && task.status !== 'deleted' && !task.deletedAt
    )
    .map((task) => ({
      teamName: team.teamName,
      ...(team.logicalTeamName ? { logicalTeamName: team.logicalTeamName } : {}),
      teamDisplayName: team.displayName,
      taskId: task.id,
      displayId: task.displayId,
      subject: task.subject.slice(0, 300),
      ...(task.owner?.trim() ? { owner: task.owner.trim() } : {}),
      requestedAt: task.clarificationRequestedAt ?? null,
      projectPath: team.projectPath,
    }));
}
