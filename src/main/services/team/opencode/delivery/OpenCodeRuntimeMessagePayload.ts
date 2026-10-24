import type { OpenCodeTeamRuntimeMessageInput } from '../../runtime';
import type { OpenCodeMemberMessageDeliveryInput } from './OpenCodeMemberMessageDeliveryPorts';

/** Preserve the same destination envelope in dispatch and observation. */
export function openCodeRuntimeMessagePayload(
  message: OpenCodeMemberMessageDeliveryInput,
  context: Pick<OpenCodeTeamRuntimeMessageInput, 'teamName' | 'laneId' | 'memberName' | 'cwd'> & {
    runId: string | null;
    text: string;
  }
): OpenCodeTeamRuntimeMessageInput {
  return {
    ...context,
    runId: context.runId ?? undefined,
    messageId: message.messageId,
    replyRecipient: message.replyRecipient,
    actionMode: message.actionMode,
    groupChatId: message.groupChatId,
    groupRunKey: message.groupRunKey,
    from: message.from,
    groupChatName: message.groupChatName,
    timestamp: message.inboxTimestamp,
    groupMessageId: message.groupMessageId,
    groupChatProtocolVersion: message.groupChatProtocolVersion,
    relayOfMessageId: message.relayOfMessageId,
    messageKind: message.messageKind,
    workSyncIntent: message.workSyncIntent,
    workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
    taskRefs: message.taskRefs,
  };
}
