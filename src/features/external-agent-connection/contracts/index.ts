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
  capabilities: {
    draftCreation: boolean;
    rendererControl: boolean;
    configurationEdit?: boolean;
    reversibleTrash?: boolean;
  };
  errorCode: string | null;
  reason: string | null;
  recovery: string | null;
}

export interface ExternalAgentConnectionApi {
  getConnectionInfo(): Promise<ConnectionInfoV1>;
  retryConnection(): Promise<ConnectionInfoV1>;
  /** Native desktop execution; deliberately unavailable in browser/server mode. */
  directRun?: ExternalAgentRunApi;
}

export type ExternalAgentRunProvider = 'anthropic' | 'codex';
export type ExternalAgentRunAvailability = Record<ExternalAgentRunProvider, boolean>;
export type ExternalAgentRunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ExternalAgentRunRequest {
  providerId: ExternalAgentRunProvider;
  task: string;
  expectedContext: AppConnectionContext;
}
export interface ExternalAgentRunSnapshot {
  runId: string;
  providerId: ExternalAgentRunProvider;
  context: AppConnectionContext;
  task: string;
  status: ExternalAgentRunStatus;
  startedAt: string;
  finishedAt: string | null;
  logs: string;
  error: string | null;
}
export interface ExternalAgentRunApi {
  getAvailability(): Promise<ExternalAgentRunAvailability>;
  start(request: ExternalAgentRunRequest): Promise<ExternalAgentRunSnapshot>;
  getSnapshot(): Promise<ExternalAgentRunSnapshot | null>;
  cancel(request: { runId: string }): Promise<ExternalAgentRunSnapshot | null>;
}
export const EXTERNAL_AGENT_RUN_CHANNELS = {
  availability: 'external-agent-connection:run:availability',
  start: 'external-agent-connection:run:start',
  snapshot: 'external-agent-connection:run:snapshot',
  cancel: 'external-agent-connection:run:cancel',
} as const;

export const EXTERNAL_AGENT_CONNECTION_CHANNELS = {
  getInfo: 'external-agent-connection:getInfo',
  retry: 'external-agent-connection:retry',
} as const;

export const EXTERNAL_AGENT_RENDERER_MARKER = '__AGENT_TEAMS_CONNECTION_CONTEXT__';
export const BOUND_CONTROL_CONTEXT_HEADER = 'x-agent-teams-app-context';
export const BOUND_CONTROL_URL_ENV = 'AGENT_TEAMS_BOUND_CONTROL_URL';
export const BOUND_CONTROL_CONTEXT_ENV = 'AGENT_TEAMS_BOUND_CONTEXT_JSON';
