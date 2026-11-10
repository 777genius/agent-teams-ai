import { stableHash } from '../bridge/OpenCodeBridgeCommandContract';

import type { AgentActionMode, TaskRef } from '@shared/types/team';

export function hashOpenCodePromptDeliveryPayload(input: {
  text: string;
  replyRecipient: string;
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  attachments?: { id?: string; filename?: string; mimeType?: string; size?: number }[];
  source?: string;
  groupChatId?: string;
  groupMessageId?: string;
  groupRunKey?: string;
  groupChatProtocolVersion?: number;
  relayOfMessageId?: string;
}): string {
  return `sha256:${stableHash({
    text: input.text,
    replyRecipient: input.replyRecipient,
    actionMode: input.actionMode ?? null,
    taskRefs: input.taskRefs ?? [],
    attachments:
      input.attachments?.map((attachment) => ({
        id: attachment.id ?? null,
        filename: attachment.filename ?? null,
        mimeType: attachment.mimeType ?? null,
        size: attachment.size ?? null,
      })) ?? [],
    source: input.source ?? null,
    ...(input.groupChatId
      ? {
          groupChatId: input.groupChatId,
          groupMessageId: input.groupMessageId ?? null,
          groupRunKey: input.groupRunKey ?? null,
          groupChatProtocolVersion: input.groupChatProtocolVersion ?? null,
          relayOfMessageId: input.relayOfMessageId ?? null,
        }
      : {}),
  })}`;
}
