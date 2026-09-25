import { validateMemberName, validateTeamName } from '@main/ipc/guards';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import {
  TEAM_DISCARD_QUEUED_USER_MESSAGES,
  TEAM_GET_QUEUED_USER_MESSAGES,
  // eslint-disable-next-line boundaries/element-types -- IPC channels are shared with preload.
} from '@preload/constants/ipcChannels';

import { discardQueuedUserMessages, listQueuedUserMessages } from './teamQueuedUserMessages';

import type { TeamDataService } from '../../services/team/TeamDataService';
import type {
  DiscardQueuedUserMessagesResult,
  IpcResult,
  QueuedUserMessagesSnapshot,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

function parseQueuedMessageIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messageIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return null;
    messageIds.push(entry);
  }
  return messageIds;
}

export function registerTeamQueuedUserMessagesIpc(
  ipcMain: IpcMain,
  data: Pick<TeamDataService, 'invalidateMessageFeed'>,
  wrapTeamHandler: <T>(operation: string, execute: () => Promise<T>) => Promise<IpcResult<T>>,
  withWriterAdmission: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>
): void {
  ipcMain.handle(
    TEAM_GET_QUEUED_USER_MESSAGES,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      memberName: unknown
    ): Promise<IpcResult<QueuedUserMessagesSnapshot>> => {
      const team = validateTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error ?? 'Invalid teamName' };
      const member = validateMemberName(memberName);
      if (!member.valid) return { success: false, error: member.error ?? 'Invalid memberName' };
      return wrapTeamHandler('getQueuedUserMessages', async () => ({
        member: member.value!,
        messages: await listQueuedUserMessages(getTeamsBasePath(), team.value!, member.value!),
      }));
    }
  );
  ipcMain.handle(
    TEAM_DISCARD_QUEUED_USER_MESSAGES,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      memberName: unknown,
      messageIds: unknown
    ): Promise<IpcResult<DiscardQueuedUserMessagesResult>> => {
      const team = validateTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error ?? 'Invalid teamName' };
      const member = validateMemberName(memberName);
      if (!member.valid) return { success: false, error: member.error ?? 'Invalid memberName' };
      const ids = parseQueuedMessageIds(messageIds);
      if (!ids) {
        return { success: false, error: 'messageIds must be a non-empty array of message ids' };
      }
      return wrapTeamHandler('discardQueuedUserMessages', () =>
        withWriterAdmission(team.value!, async () => {
          const result = await discardQueuedUserMessages(
            getTeamsBasePath(),
            team.value!,
            member.value!,
            ids
          );
          if (result.discarded > 0) data.invalidateMessageFeed(team.value!);
          return result;
        })
      );
    }
  );
}

export function removeTeamQueuedUserMessagesIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_GET_QUEUED_USER_MESSAGES);
  ipcMain.removeHandler(TEAM_DISCARD_QUEUED_USER_MESSAGES);
}
