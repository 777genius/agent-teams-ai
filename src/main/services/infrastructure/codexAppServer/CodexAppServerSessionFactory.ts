import type { JsonRpcSession, JsonRpcStdioClient } from './JsonRpcStdioClient';
import type { CodexAppServerInitializeResponse } from './protocol';

const DEFAULT_INITIALIZE_TIMEOUT_MS = 6_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;

export const DEFAULT_CODEX_APP_SERVER_SUPPRESSED_NOTIFICATION_METHODS = [
  'thread/started',
  'thread/status/changed',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/name/updated',
  'turn/started',
  'turn/completed',
  'item/agentMessage/delta',
  'item/agentReasoning/delta',
  'item/execCommandOutputDelta',
];

export interface CodexAppServerSession extends JsonRpcSession {
  readonly initializeResponse: CodexAppServerInitializeResponse;
}

export class CodexAppServerSessionFactory {
  constructor(private readonly rpcClient: JsonRpcStdioClient) {}

  async withSession<T>(
    options: {
      binaryPath: string;
      env?: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
      initializeTimeoutMs?: number;
      totalTimeoutMs?: number;
      label: string;
      experimentalApi?: boolean;
      optOutNotificationMethods?: string[];
    },
    handler: (session: CodexAppServerSession) => Promise<T>
  ): Promise<T> {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const initializeTimeoutMs = Math.max(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      requestTimeoutMs
    );

    return this.rpcClient.withSession(
      {
        binaryPath: options.binaryPath,
        args: ['app-server'],
        env: options.env,
        requestTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
        label: options.label,
      },
      async (session) => {
        const initializedSession = await this.initializeSession(session, {
          initializeTimeoutMs,
          experimentalApi: options.experimentalApi ?? false,
          optOutNotificationMethods:
            options.optOutNotificationMethods ??
            DEFAULT_CODEX_APP_SERVER_SUPPRESSED_NOTIFICATION_METHODS,
        });
        return handler(initializedSession);
      }
    );
  }

  async openSession(options: {
    binaryPath: string;
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
    initializeTimeoutMs?: number;
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  }): Promise<CodexAppServerSession> {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const initializeTimeoutMs = Math.max(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      requestTimeoutMs
    );
    const session = await this.rpcClient.openSession({
      binaryPath: options.binaryPath,
      args: ['app-server'],
      env: options.env,
      requestTimeoutMs,
    });

    try {
      return await this.initializeSession(session, {
        initializeTimeoutMs,
        experimentalApi: options.experimentalApi ?? false,
        optOutNotificationMethods:
          options.optOutNotificationMethods ??
          DEFAULT_CODEX_APP_SERVER_SUPPRESSED_NOTIFICATION_METHODS,
      });
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  private async initializeSession(
    session: JsonRpcSession,
    options: {
      initializeTimeoutMs: number;
      experimentalApi: boolean;
      optOutNotificationMethods: string[];
    }
  ): Promise<CodexAppServerSession> {
    const initializeResponse = await session.request<CodexAppServerInitializeResponse>(
      'initialize',
      {
        clientInfo: {
          name: 'claude-agent-teams-ui',
          title: 'Agent Teams UI',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: options.experimentalApi,
          optOutNotificationMethods: options.optOutNotificationMethods,
        },
      },
      options.initializeTimeoutMs
    );

    await session.notify('initialized');

    return {
      ...session,
      initializeResponse,
    };
  }
}
