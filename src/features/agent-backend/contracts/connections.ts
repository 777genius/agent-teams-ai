import type { BackendHandle } from './index';

export const AGENT_BACKEND_CONNECTIONS_CHANNEL = 'agentBackend:connections';
export const AGENT_BACKEND_CONNECTIONS_ROUTE = '/api/agent-backend/connections';

export interface BackendConnectionSnapshot {
  /** Descriptor/handle availability only; never native session/member readiness. */
  state: 'unconfigured' | 'ready' | 'hold' | 'shutting-down';
  bindings: {
    handle: BackendHandle;
    label: string;
    /** Captured scope identities for navigation only, never send authority. */
    teamResourceRef?: string;
    ownerResourceRef?: string;
    members: { memberId: string; label: string }[];
  }[];
}

export interface AgentBackendConnectionsApi {
  /** Context is captured by the shell; clients cannot select another context. */
  getConnections(): Promise<BackendConnectionSnapshot>;
}
