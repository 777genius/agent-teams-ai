/** Identity expectations, not credentials: a copied prompt is bound to this app and root. */
export interface AppConnectionContext {
  appInstanceId: string;
  dataRootFingerprint: string;
  connectionGeneration: number;
}

export type ConnectionStatus = 'starting' | 'ready' | 'error' | 'stopped';

export interface ConnectionInfoV1 {
  schemaVersion: 1;
  context: AppConnectionContext;
  appVersion: string;
  profileFingerprint: string;
  observedAt: string;
  mcp: {
    status: ConnectionStatus;
    transport: 'httpStream';
    url: string | null;
    generation: number;
  };
  control: { status: ConnectionStatus };
  cdp: {
    status: ConnectionStatus | 'disabled' | 'restart-required';
    httpOrigin: string | null;
    browserWsUrl: string | null;
    rendererTargetId: string | null;
    rendererWsUrl: string | null;
    targetGeneration: number;
  };
  capabilities: { draftCreation: boolean; rendererControl: boolean };
  errorCode: string | null;
  reason: string | null;
  recovery: string | null;
}

export interface ExternalAgentConnectionApi {
  getConnectionInfo(): Promise<ConnectionInfoV1>;
  retryConnection(): Promise<ConnectionInfoV1>;
}

export const EXTERNAL_AGENT_CONNECTION_CHANNELS = {
  getInfo: 'external-agent-connection:getInfo',
  retry: 'external-agent-connection:retry',
} as const;

export const EXTERNAL_AGENT_RENDERER_MARKER = '__AGENT_TEAMS_CONNECTION_CONTEXT__';
export const BOUND_CONTROL_CONTEXT_HEADER = 'x-agent-teams-app-context';
export const BOUND_CONTROL_URL_ENV = 'AGENT_TEAMS_BOUND_CONTROL_URL';
export const BOUND_CONTROL_CONTEXT_ENV = 'AGENT_TEAMS_BOUND_CONTEXT_JSON';
