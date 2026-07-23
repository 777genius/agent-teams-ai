import {
  getTeamDataWorkerErrorMessage,
  noteHeavyTeamDataWorkerFallback,
  throwIfFatalTeamDataWorkerFailure,
} from '../services/teamDataWorkerPolicy';

import type {
  LiveLeadMessageReaderPort,
  NewestMessagesPageReaderPort,
  RuntimeEnvironmentPort,
  TeamMessageFeedReaderPort,
  TeamMessageNotificationScannerPort,
  TeamMessagesWorkerReadPort,
  TeamViewReadLoggerPort,
} from '../ports/TeamViewReadModelPorts';
import type { MessagesPage } from '@shared/types';

export class GetMessagesPageUseCase {
  constructor(
    private readonly dependencies: {
      messages: TeamMessageFeedReaderPort;
      worker: TeamMessagesWorkerReadPort;
      liveMessages: LiveLeadMessageReaderPort;
      newestMessages: NewestMessagesPageReaderPort;
      notifications: TeamMessageNotificationScannerPort;
      environment: RuntimeEnvironmentPort;
      logger: TeamViewReadLoggerPort;
    }
  ) {}

  async execute(input: {
    teamName: string;
    cursor?: string | null;
    limit: number;
  }): Promise<MessagesPage> {
    const scanNotifications = (page: MessagesPage): void => {
      const contextPromise: Promise<{ displayName: string; projectPath?: string }> =
        this.dependencies.messages
          .getTeamNotificationContext(input.teamName)
          .catch(() => ({ displayName: input.teamName }));
      void contextPromise
        .then((context) => {
          this.dependencies.notifications.scan(page.messages, {
            teamName: input.teamName,
            teamDisplayName: context.displayName,
            projectPath: context.projectPath,
          });
        })
        .catch((error: unknown) => {
          this.dependencies.logger.debug(
            `[teams:getMessagesPage] notification scan skipped team=${input.teamName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    };
    const liveMessages =
      input.cursor == null
        ? this.dependencies.liveMessages.getLiveLeadProcessMessages(input.teamName)
        : [];

    if (liveMessages.length > 0) {
      const page = await this.dependencies.newestMessages.execute({
        teamName: input.teamName,
        limit: input.limit,
        liveMessages,
        includeUndefinedCursorInFallback: true,
      });
      scanNotifications(page);
      return page;
    }

    if (this.dependencies.worker.isAvailable()) {
      try {
        const page = await this.dependencies.worker.getMessagesPage(input.teamName, {
          cursor: input.cursor,
          limit: input.limit,
        });
        scanNotifications(page);
        return page;
      } catch (error) {
        throwIfFatalTeamDataWorkerFailure(this.dependencies.worker, error);
        this.dependencies.logger.warn(
          `[teams:getMessagesPage] worker failed, falling back: ${getTeamDataWorkerErrorMessage(
            error
          )}`
        );
      }
    }

    noteHeavyTeamDataWorkerFallback(
      this.dependencies.environment,
      this.dependencies.logger,
      'teams:getMessagesPage'
    );
    const page = await this.dependencies.messages.getMessagesPage(input.teamName, {
      cursor: input.cursor,
      limit: input.limit,
    });
    scanNotifications(page);
    return page;
  }
}
