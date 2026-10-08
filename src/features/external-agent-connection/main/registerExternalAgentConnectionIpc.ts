import { EXTERNAL_AGENT_CONNECTION_CHANNELS, EXTERNAL_AGENT_RUN_CHANNELS } from '../contracts';

import type { ExternalAgentConnectionApi } from '../contracts';
import type { IpcMain } from 'electron';

export function registerExternalAgentConnectionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  connection: ExternalAgentConnectionApi
): void {
  ipcMain.handle(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo, () => connection.getConnectionInfo());
  ipcMain.handle(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry, () => connection.retryConnection());
  if (connection.directRun) {
    const run = connection.directRun;
    ipcMain.handle(EXTERNAL_AGENT_RUN_CHANNELS.start, (_event, input) => run.start(input));
    ipcMain.handle(EXTERNAL_AGENT_RUN_CHANNELS.snapshot, () => run.getSnapshot());
    ipcMain.handle(EXTERNAL_AGENT_RUN_CHANNELS.cancel, (_event, input) => run.cancel(input));
  }
}

export function removeExternalAgentConnectionIpc(ipcMain: Pick<IpcMain, 'removeHandler'>): void {
  ipcMain.removeHandler(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo);
  ipcMain.removeHandler(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry);
  for (const channel of Object.values(EXTERNAL_AGENT_RUN_CHANNELS)) ipcMain.removeHandler(channel);
}
