import { EXTERNAL_AGENT_CONNECTION_CHANNELS, EXTERNAL_AGENT_RUN_CHANNELS } from '../contracts';

import type {
  ConnectionInfoV1,
  ExternalAgentConfirmation,
  ExternalAgentConnectionApi,
  ExternalAgentRunAvailability,
  ExternalAgentRunSnapshot,
} from '../contracts';
import type { IpcRenderer } from 'electron';

export function createExternalAgentConnectionBridge(
  ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): ExternalAgentConnectionApi {
  return {
    getConnectionInfo: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.getInfo) as Promise<ConnectionInfoV1>,
    retryConnection: () =>
      ipcRenderer.invoke(EXTERNAL_AGENT_CONNECTION_CHANNELS.retry) as Promise<ConnectionInfoV1>,
    getPendingConfirmation: () =>
      ipcRenderer.invoke(
        EXTERNAL_AGENT_CONNECTION_CHANNELS.getConfirmation
      ) as Promise<ExternalAgentConfirmation | null>,
    dismissConfirmation: (id) =>
      ipcRenderer.invoke(
        EXTERNAL_AGENT_CONNECTION_CHANNELS.dismissConfirmation,
        id
      ) as Promise<void>,
    onConfirmation: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ExternalAgentConfirmation) =>
        listener(payload);
      ipcRenderer.on(EXTERNAL_AGENT_CONNECTION_CHANNELS.confirmation, handler);
      return () => {
        ipcRenderer.removeListener(EXTERNAL_AGENT_CONNECTION_CHANNELS.confirmation, handler);
      };
    },
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
