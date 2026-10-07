import { EXTERNAL_AGENT_CONNECTION_CHANNELS } from '../contracts';

import type { ConnectionInfoV1, ExternalAgentConnectionApi } from '../contracts';
import type { IpcRenderer } from 'electron';

export function createExternalAgentConnectionBridge(
  ipcRenderer: Pick<IpcRenderer, 'invoke'>
): ExternalAgentConnectionApi {
  return {
    getConnectionInfo: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo) as Promise<ConnectionInfoV1>,
    retryConnection: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry) as Promise<ConnectionInfoV1>,
  };
}
