import { EXTERNAL_AGENT_CONNECTION_CHANNELS, EXTERNAL_AGENT_RUN_CHANNELS } from '../contracts';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
  ExternalAgentRunSnapshot,
} from '../contracts';
import type { IpcRenderer } from 'electron';

export function createExternalAgentConnectionBridge(
  ipcRenderer: Pick<IpcRenderer, 'invoke'>
): ExternalAgentConnectionApi {
  return {
    getConnectionInfo: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo) as Promise<ConnectionInfoV1>,
    retryConnection: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry) as Promise<ConnectionInfoV1>,
    directRun: {
      start: (request) =>
        ipcRenderer.invoke(
          EXTERNAL_AGENT_RUN_CHANNELS.start,
          request
        ) as Promise<ExternalAgentRunSnapshot>,
      getSnapshot: () =>
        ipcRenderer.invoke(
          EXTERNAL_AGENT_RUN_CHANNELS.snapshot
        ) as Promise<ExternalAgentRunSnapshot | null>,
      cancel: (request) =>
        ipcRenderer.invoke(
          EXTERNAL_AGENT_RUN_CHANNELS.cancel,
          request
        ) as Promise<ExternalAgentRunSnapshot | null>,
    },
  };
}
