import {
  getTeamDataWorkerErrorMessage,
  noteHeavyTeamDataWorkerFallback,
  throwIfFatalTeamDataWorkerFailure,
} from './teamDataWorkerPolicy';

import type {
  MessageMergePort,
  NewestMessagesPageReaderPort,
  RuntimeEnvironmentPort,
  TeamMessagePageReaderPort,
  TeamMessagesWorkerReadPort,
  TeamViewReadLoggerPort,
} from '../ports/TeamViewReadModelPorts';
import type { InboxMessage, MessagesPage } from '@shared/types';

const MAX_LIVE_MESSAGES_OVERLAY_PAYLOAD = 200;

function compareInboxMessagesNewestFirst(left: InboxMessage, right: InboxMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const leftId = typeof left.messageId === 'string' ? left.messageId : '';
  const rightId = typeof right.messageId === 'string' ? right.messageId : '';
  return leftId.localeCompare(rightId);
}

function capLiveOverlayMessages(liveMessages: readonly InboxMessage[]): InboxMessage[] {
  if (liveMessages.length <= MAX_LIVE_MESSAGES_OVERLAY_PAYLOAD) {
    return [...liveMessages];
  }
  return [...liveMessages]
    .sort(compareInboxMessagesNewestFirst)
    .slice(0, MAX_LIVE_MESSAGES_OVERLAY_PAYLOAD);
}

export class NewestMessagesPageReader implements NewestMessagesPageReaderPort {
  constructor(
    private readonly dependencies: {
      worker: TeamMessagesWorkerReadPort;
      durableMessages: TeamMessagePageReaderPort;
      merger: MessageMergePort;
      environment: RuntimeEnvironmentPort;
      logger: TeamViewReadLoggerPort;
    }
  ) {}

  async execute(input: {
    teamName: string;
    limit: number;
    liveMessages: InboxMessage[];
    includeUndefinedCursorInFallback?: boolean;
  }): Promise<MessagesPage> {
    const liveMessages = capLiveOverlayMessages(input.liveMessages);
    const liveReserve = liveMessages.length ? Math.max(liveMessages.length, 100) : 0;
    const durableLimit = input.limit + liveReserve + 1;
    const options = input.includeUndefinedCursorInFallback
      ? { cursor: undefined, limit: durableLimit }
      : { limit: durableLimit };
    let durablePage: MessagesPage;

    if (this.dependencies.worker.isAvailable()) {
      try {
        durablePage = await this.dependencies.worker.getMessagesPage(input.teamName, options);
        return this.mergePage(durablePage, liveMessages, input.limit);
      } catch (error) {
        throwIfFatalTeamDataWorkerFailure(this.dependencies.worker, error);
        this.dependencies.logger.warn(
          `[teams:getMessagesPage] worker failed for live overlay, falling back: ${getTeamDataWorkerErrorMessage(
            error
          )}`
        );
      }
    }

    noteHeavyTeamDataWorkerFallback(
      this.dependencies.environment,
      this.dependencies.logger,
      'teams:getMessagesPage.liveOverlay'
    );
    durablePage = await this.dependencies.durableMessages.getMessagesPage(input.teamName, options);
    return this.mergePage(durablePage, liveMessages, input.limit);
  }

  private mergePage(
    durablePage: MessagesPage,
    liveMessages: InboxMessage[],
    limit: number
  ): MessagesPage {
    return this.dependencies.merger.mergePage({
      durableMessages: durablePage.messages,
      liveMessages,
      limit,
      feedRevision: durablePage.feedRevision,
      durableHasMoreAfterWindow: durablePage.hasMore,
    });
  }
}
