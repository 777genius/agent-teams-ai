import { AGENT_BACKEND_INVOKE_CHANNEL } from '../contracts';

import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../contracts';

/** Accepts the captured ipcRenderer without importing Electron into feature consumers. */
export interface AgentBackendIpcPort {
  invoke(
    channel: typeof AGENT_BACKEND_INVOKE_CHANNEL,
    request: BackendOperationRequest
  ): Promise<BackendOperationResult>;
}

export function createAgentBackendBridge(ipc: AgentBackendIpcPort): AgentBackendApi {
  return {
    // No ID creation, retry, backend selection or conversion of UNKNOWN to rejection.
    invoke: (request) => ipc.invoke(AGENT_BACKEND_INVOKE_CHANNEL, request),
  };
}
