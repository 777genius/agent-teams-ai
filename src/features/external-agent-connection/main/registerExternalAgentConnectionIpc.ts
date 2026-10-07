import { EXTERNAL_AGENT_CONNECTION_CHANNELS } from '../contracts';

import type { ExternalAgentConnectionApi } from '../contracts';
import type { IpcMain } from 'electron';

export function registerExternalAgentConnectionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  connection: ExternalAgentConnectionApi
): void {
  ipcMain.handle(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo, () => connection.getConnectionInfo());
  ipcMain.handle(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry, () => connection.retryConnection());
}

export function removeExternalAgentConnectionIpc(ipcMain: Pick<IpcMain, 'removeHandler'>): void {
  ipcMain.removeHandler(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo);
  ipcMain.removeHandler(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry);
}
