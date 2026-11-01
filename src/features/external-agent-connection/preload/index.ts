import type { IpcRenderer } from 'electron';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
  ExternalAgentCopyHandoff,
  ExternalAgentRunAvailability,
  ExternalAgentRunSnapshot,
} from '../contracts';
import { EXTERNAL_AGENT_CONNECTION_CHANNELS, EXTERNAL_AGENT_RUN_CHANNELS } from '../contracts';

export function createExternalAgentConnectionBridge(
  ipcRenderer: Pick<IpcRenderer, 'invoke'>
): ExternalAgentConnectionApi {
  return {
    getConnectionInfo: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo) as Promise<ConnectionInfoV1>,
    retryConnection: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry) as Promise<ConnectionInfoV1>,
    prepareCopyHandoff: (request) =>
      ipcRenderer.invoke(
        EXTERNAL_AGENT_CONNECTION_CHANNELS.prepareCopy,
        request
      ) as Promise<ExternalAgentCopyHandoff>,
    directRun: {
      getAvailability: () =>
        ipcRenderer.invoke(
          EXTERNAL_AGENT_RUN_CHANNELS.availability
        ) as Promise<ExternalAgentRunAvailability>,
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
