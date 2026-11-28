import { useCallback, useMemo, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/renderer';

import { capturedCrossTeamReply } from './capturedCrossTeamReply';
import { resolveReplyRecipient } from './messagesPanelReplyRecipient';

import type { CapturedCrossTeamReply } from './capturedCrossTeamReply';
import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage } from '@shared/types';

/** Existing Reply action: captured Host destination or the original local quote dialog. */
export function useMessageReplyRouting(options: {
  contextId: string;
  teamName: string;
  scope: ConversationScope;
  members: readonly { name: string }[];
  onReply?: (message: InboxMessage, recipientHint?: string) => void;
  openTeamFeed(): void;
  fetchTargets(): Promise<unknown>;
  focusComposer(): void;
}) {
  const {
    contextId,
    teamName,
    scope,
    members,
    onReply,
    openTeamFeed,
    fetchTargets,
    focusComposer,
  } = options;
  const [selection, setSelection] = useState<{
    contextId: string;
    teamName: string;
    reply: CapturedCrossTeamReply;
  } | null>(null);
  const crossTeamReply =
    selection?.contextId === contextId && selection.teamName === teamName ? selection.reply : null;
  const replyAddressRequest = useMemo(
    () =>
      crossTeamReply
        ? {
            address: {
              contextId,
              teamName,
              target: {
                kind: 'cross-team' as const,
                toTeam: crossTeamReply.toTeam,
                toMember: crossTeamReply.toMember ?? null,
              },
            },
          }
        : null,
    [contextId, crossTeamReply, teamName]
  );
  const handleReplyToTimelineMessage = useCallback(
    (message: InboxMessage) => {
      if (
        isHostTeamSelectionKey(teamName) &&
        (message.source === 'cross_team' || message.source === 'cross_team_sent')
      ) {
        const reply = capturedCrossTeamReply(message);
        if (!reply) return;
        setSelection({ contextId, teamName, reply });
        openTeamFeed();
        void fetchTargets();
        queueMicrotask(focusComposer);
        return;
      }
      onReply?.(message, resolveReplyRecipient({ message, scope, teamName, members }));
    },
    [contextId, fetchTargets, focusComposer, members, onReply, openTeamFeed, scope, teamName]
  );
  return { crossTeamReply, replyAddressRequest, handleReplyToTimelineMessage };
}
