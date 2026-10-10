import { readGroupHistoryPage } from '@features/team-message-history/main';

import { mergeLiveLeadProcessMessagesPage } from './mergeLiveLeadProcessMessages';
import { capMessagesPageLiveOverlay } from './teamInboxOrdering';
import { resolveInboxPath } from './teamInboxPath';

import type { TeamInboxReader } from './TeamInboxReader';
import type { TeamMessageFeedService } from './TeamMessageFeedService';
import type { InboxMessage, MessagesPage } from '@shared/types';

export async function readTeamMessagesPage(
  ports: {
    inboxReader: Pick<TeamInboxReader, 'getMessagesWindow'>;
    messageFeedService: Pick<TeamMessageFeedService, 'getPage'>;
  },
  teamName: string,
  options: {
    cursor?: string | null;
    limit: number;
    liveMessages?: InboxMessage[];
    groupChatId?: string;
  }
): Promise<MessagesPage> {
  if (options.groupChatId)
    return readGroupHistoryPage(
      (windowOptions) => ports.inboxReader.getMessagesWindow(teamName, windowOptions),
      { ...options, groupChatId: options.groupChatId, sourceIdentity: resolveInboxPath(teamName, 'user') }
    );
  const liveMessages = capMessagesPageLiveOverlay(options.liveMessages);
  const pageOptions =
    liveMessages.length > 0
      ? {
          ...options,
          liveMessages,
        }
      : {
          cursor: options.cursor,
          limit: options.limit,
        };
  const page = await ports.messageFeedService.getPage(teamName, pageOptions);
  if (options.cursor || liveMessages.length === 0) {
    return {
      messages: page.messages,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      feedRevision: page.feedRevision,
    };
  }

  return mergeLiveLeadProcessMessagesPage({
    durableMessages: page.durableWindowMessages,
    liveMessages,
    limit: options.limit,
    feedRevision: page.feedRevision,
    durableHasMoreAfterWindow: page.durableHasMoreAfterWindow,
  });
}
