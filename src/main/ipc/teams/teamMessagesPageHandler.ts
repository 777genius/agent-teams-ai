import { classifyTeamReadWorkerFailure } from '@features/team-read-recovery/main';
import {
  getTeamDataWorkerClient,
  isTeamDataWorkerFatalError,
} from '@main/services/team/TeamDataWorkerClient';
import { createLogger } from '@shared/utils/logger';

import { validateTeamName } from '../guards';

import { teamMessageNotificationScanner } from './teamMessageNotificationScanner';

import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { InboxMessage, MessagesPage } from '@shared/types';
import type { IpcResult } from '@shared/types/ipc';
import type { IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:teams');

interface MessagesPageHandlerPorts {
  getService(): Pick<TeamDataService, 'getMessagesPage' | 'getTeamNotificationContext'>;
  getLiveMessages(teamName: string): InboxMessage[];
  withLiveOverlay(input: {
    teamName: string;
    limit: number;
    liveMessages: InboxMessage[];
    includeUndefinedCursorInFallback?: boolean;
  }): Promise<MessagesPage>;
  wrap<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>>;
  noteFallback(operation: string): void;
}

/** Existing history IPC entry; group selection shares the same main/worker route. */
export function createMessagesPageHandler(ports: MessagesPageHandlerPorts) {
  return async function handleGetMessagesPage(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    options: unknown
  ): Promise<IpcResult<MessagesPage>> {
    const vTeam = validateTeamName(teamName);
    if (!vTeam.valid) {
      return { success: false, error: vTeam.error ?? 'Invalid teamName' };
    }
    const opts = (options && typeof options === 'object' ? options : {}) as {
      cursor?: string | null;
      limit?: number;
      groupChatId?: string;
    };
    if (
      opts.groupChatId !== undefined &&
      (typeof opts.groupChatId !== 'string' ||
        !opts.groupChatId.trim() ||
        opts.groupChatId.length > 128)
    )
      return { success: false, error: 'Invalid groupChatId' };
    const groupChatId = opts.groupChatId;
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const cursor =
      typeof opts.cursor === 'string' ? opts.cursor : opts.cursor === null ? null : undefined;

    return ports.wrap('getMessagesPage', async () => {
      let page: MessagesPage;
      const teamName = vTeam.value!;
      const scanNotifications = (messagesPage: MessagesPage): void => {
        const notificationContextPromise: Promise<{ displayName: string; projectPath?: string }> =
          ports
            .getService()
            .getTeamNotificationContext(teamName)
            .catch(() => ({ displayName: teamName }));
        void notificationContextPromise
          .then((notificationContext) => {
            teamMessageNotificationScanner.scan(messagesPage.messages, {
              teamName,
              teamDisplayName: notificationContext.displayName,
              projectPath: notificationContext.projectPath,
            });
          })
          .catch((error: unknown) => {
            logger.debug(
              `[teams:getMessagesPage] notification scan skipped team=${teamName}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
      };
      const liveMessages = !groupChatId && cursor == null ? ports.getLiveMessages(teamName) : [];

      if (liveMessages.length > 0) {
        page = await ports.withLiveOverlay({
          teamName,
          limit,
          liveMessages,
          includeUndefinedCursorInFallback: true,
        });
        scanNotifications(page);
        return page;
      }

      const worker = getTeamDataWorkerClient();
      if (worker.isAvailable()) {
        try {
          page = await worker.getMessagesPage(teamName, {
            cursor,
            limit,
            ...(groupChatId ? { groupChatId } : {}),
          });
          scanNotifications(page);
          return page;
        } catch (workerErr) {
          const failure = classifyTeamReadWorkerFailure(
            workerErr,
            isTeamDataWorkerFatalError(workerErr)
          );
          if (failure) throw failure;
          logger.warn(
            `[teams:getMessagesPage] worker failed, falling back: ${workerErr instanceof Error ? workerErr.message : String(workerErr)}`
          );
        }
      }
      ports.noteFallback('teams:getMessagesPage');
      page = await ports.getService().getMessagesPage(teamName, {
        cursor,
        limit,
        ...(groupChatId ? { groupChatId } : {}),
      });
      scanNotifications(page);
      return page;
    });
  };
}
