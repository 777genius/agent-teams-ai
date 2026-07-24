import {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_SEND_MESSAGE,
} from '@features/team-message-delivery/contracts';

import { createTeamMessageDeliveryIpcHandlers } from './createTeamMessageDeliveryIpcHandlers';

import type { TeamMessageDeliveryIpcDependencies } from './TeamMessageDeliveryIpcDependencies';
import type { IpcMain } from 'electron';

export function registerTeamMessageDeliveryIpc(
  ipcMain: IpcMain,
  dependencies: TeamMessageDeliveryIpcDependencies
): void {
  const handlers = createTeamMessageDeliveryIpcHandlers(dependencies);
  ipcMain.handle(TEAM_SEND_MESSAGE, handlers.sendMessage);
  ipcMain.handle(
    TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
    handlers.getOpenCodeRuntimeDeliveryStatus
  );
  ipcMain.handle(TEAM_PROCESS_SEND, handlers.processSend);
  ipcMain.handle(TEAM_PROCESS_ALIVE, handlers.processAlive);
  ipcMain.handle(TEAM_GET_ATTACHMENTS, handlers.getAttachments);
}

export function removeTeamMessageDeliveryIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
  ipcMain.removeHandler(TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS);
  ipcMain.removeHandler(TEAM_PROCESS_SEND);
  ipcMain.removeHandler(TEAM_PROCESS_ALIVE);
  ipcMain.removeHandler(TEAM_GET_ATTACHMENTS);
}
