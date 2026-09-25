import { useCallback } from 'react';

import { shouldClearPendingReplyForOpenCodeRuntimeDelivery } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';

import type { ActionMode } from './ActionModeSelector';
import type {
  AttachmentPayload,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
} from '@shared/types';

interface UseMessagesPanelSendOptions {
  readonly teamName: string;
  readonly sendTeamMessage: (
    teamName: string,
    request: SendMessageRequest
  ) => Promise<SendMessageResult>;
  readonly sendCrossTeamMessage: (
    request: CrossTeamSendRequest
  ) => Promise<CrossTeamSendResult | null>;
  readonly onPendingReplyChange: (
    updater: (previous: Record<string, number>) => Record<string, number>
  ) => void;
}

export function useMessagesPanelSend({
  teamName,
  sendTeamMessage,
  sendCrossTeamMessage,
  onPendingReplyChange,
}: UseMessagesPanelSendOptions): {
  handleSend: (
    member: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[]
  ) => Promise<SendMessageResult>;
  handleCrossTeamSend: (
    toTeam: string,
    text: string,
    summary?: string,
    actionMode?: ActionMode,
    taskRefs?: TaskRef[],
    toMember?: string
  ) => Promise<CrossTeamSendResult | null>;
} {
  const handleSend = useCallback(
    async (
      member: string,
      text: string,
      summary?: string,
      attachments?: AttachmentPayload[],
      actionMode?: ActionMode,
      taskRefs?: TaskRef[]
    ): Promise<SendMessageResult> => {
      const sentAtMs = Date.now();
      onPendingReplyChange((previous) => ({ ...previous, [member]: sentAtMs }));
      try {
        const result = await sendTeamMessage(teamName, {
          member,
          text,
          summary,
          attachments,
          actionMode,
          taskRefs,
        });
        if (shouldClearPendingReplyForOpenCodeRuntimeDelivery(result.runtimeDelivery)) {
          onPendingReplyChange((previous) => {
            if (previous[member] !== sentAtMs) return previous;
            const next = { ...previous };
            delete next[member];
            return next;
          });
        }
        return result;
      } catch (error) {
        onPendingReplyChange((previous) => {
          if (previous[member] !== sentAtMs) return previous;
          const next = { ...previous };
          delete next[member];
          return next;
        });
        throw error;
      }
    },
    [onPendingReplyChange, sendTeamMessage, teamName]
  );

  const handleCrossTeamSend = useCallback(
    (
      toTeam: string,
      text: string,
      summary?: string,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[],
      toMember?: string
    ) =>
      sendCrossTeamMessage({
        fromTeam: teamName,
        fromMember: 'user',
        toTeam,
        ...(toMember ? { toMember } : {}),
        text,
        taskRefs,
        actionMode,
        summary,
      }),
    [sendCrossTeamMessage, teamName]
  );

  return { handleSend, handleCrossTeamSend };
}
