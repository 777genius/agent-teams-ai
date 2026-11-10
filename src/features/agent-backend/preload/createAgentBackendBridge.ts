import { AGENT_BACKEND_CONNECTIONS_CHANNEL } from '../contracts/connections';
import { AGENT_BACKEND_INVOKE_CHANNEL } from '../contracts/operations';
import { STOPPED_TEAM_IMPORT_CHANNEL } from '../contracts/stoppedImport';

import { createAgentBackendReviewWatchBridge } from './createAgentBackendReviewWatchBridge';

import type {
  AgentBackendApi,
  BackendConnectionSnapshot,
  BackendOperationRequest,
  BackendOperationResult,
  StoppedTeamImportAction,
  StoppedTeamImportResult,
} from '../contracts';
import type { AgentBackendReviewWatchIpcPort } from './createAgentBackendReviewWatchBridge';

/** Accepts the captured ipcRenderer without importing Electron into feature consumers. */
export interface AgentBackendIpcPort {
  invoke(
    channel: typeof AGENT_BACKEND_INVOKE_CHANNEL,
    request: BackendOperationRequest
  ): Promise<BackendOperationResult>;
  invoke(channel: typeof AGENT_BACKEND_CONNECTIONS_CHANNEL): Promise<BackendConnectionSnapshot>;
}
export interface StoppedTeamImportIpcPort {
  invoke(
    channel: typeof STOPPED_TEAM_IMPORT_CHANNEL,
    request: StoppedTeamImportAction
  ): Promise<StoppedTeamImportResult>;
}

export function createAgentBackendBridge(
  ipc: AgentBackendIpcPort,
  watch?: AgentBackendReviewWatchIpcPort,
  stoppedImport?: StoppedTeamImportIpcPort
): AgentBackendApi {
  return {
    ...(watch ? createAgentBackendReviewWatchBridge(watch) : {}),
    // No ID creation, retry, backend selection or conversion of UNKNOWN to rejection.
    invoke: (request) => ipc.invoke(AGENT_BACKEND_INVOKE_CHANNEL, request),
    getConnections: () => ipc.invoke(AGENT_BACKEND_CONNECTIONS_CHANNEL),
    ...(stoppedImport
      ? {
          stoppedImport: (request: StoppedTeamImportAction) =>
            stoppedImport.invoke(STOPPED_TEAM_IMPORT_CHANNEL, request),
        }
      : {}),
  };
}
