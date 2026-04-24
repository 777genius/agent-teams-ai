import type {
  JsonRpcSession,
  JsonRpcStdioClient,
} from '@main/services/infrastructure/codexAppServer';

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 6_000;
const MIN_SESSION_OVERHEAD_TIMEOUT_MS = 1_500;
const SUPPRESSED_NOTIFICATION_METHODS = [
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

interface ThreadListResponse {
  data?: CodexThreadSummary[];
}

interface CodexGitInfo {
  branch?: string | null;
  originUrl?: string | null;
  sha?: string | null;
}

export interface CodexThreadSummary {
  id: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string | null;
  source?: unknown;
  modelProvider?: string | null;
  gitInfo?: CodexGitInfo | null;
  name?: string | null;
  path?: string | null;
}

export interface CodexThreadSegmentResult {
  threads: CodexThreadSummary[];
  error?: string;
}

export interface CodexRecentThreadsResult {
  live: CodexThreadSegmentResult;
  archived: CodexThreadSegmentResult;
}

interface ThreadListSessionOptions {
  binaryPath: string;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  totalTimeoutMs: number;
  label: string;
}

export class CodexAppServerClient {
  constructor(private readonly rpcClient: JsonRpcStdioClient) {}

  async listRecentLiveThreads(
    binaryPath: string,
    options: {
      limit: number;
      requestTimeoutMs?: number;
      initializeTimeoutMs?: number;
      totalTimeoutMs?: number;
    }
  ): Promise<CodexThreadSegmentResult> {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    const totalTimeoutMs = Math.max(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      initializeTimeoutMs + requestTimeoutMs + MIN_SESSION_OVERHEAD_TIMEOUT_MS
    );

    return this.#withThreadListSession(
      {
        binaryPath,
        requestTimeoutMs,
        initializeTimeoutMs,
        totalTimeoutMs,
        label: 'codex app-server thread/list live',
      },
      async (session) => {
        const live = await session.request<ThreadListResponse>(
          'thread/list',
          {
            archived: false,
            limit: options.limit,
            sortKey: 'updated_at',
          },
          requestTimeoutMs
        );

        return {
          threads: live.data ?? [],
        };
      }
    );
  }

  async listRecentThreads(
    binaryPath: string,
    options: {
      limit: number;
      liveRequestTimeoutMs?: number;
      archivedRequestTimeoutMs?: number;
      initializeTimeoutMs?: number;
      totalTimeoutMs?: number;
    }
  ): Promise<CodexRecentThreadsResult> {
    const liveRequestTimeoutMs = options.liveRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const archivedRequestTimeoutMs = options.archivedRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const sessionRequestTimeoutMs = Math.max(liveRequestTimeoutMs, archivedRequestTimeoutMs);
    const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    const totalTimeoutMs = Math.max(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      initializeTimeoutMs +
        liveRequestTimeoutMs +
        archivedRequestTimeoutMs +
        MIN_SESSION_OVERHEAD_TIMEOUT_MS
    );

    return this.#withThreadListSession(
      {
        binaryPath,
        requestTimeoutMs: sessionRequestTimeoutMs,
        initializeTimeoutMs,
        totalTimeoutMs,
        label: 'codex app-server thread/list',
      },
      async (session) => {
        const live = await this.#requestThreadListSegment(session, {
          archived: false,
          limit: options.limit,
          timeoutMs: liveRequestTimeoutMs,
        });
        const archived = await this.#requestThreadListSegment(session, {
          archived: true,
          limit: options.limit,
          timeoutMs: archivedRequestTimeoutMs,
        });

        return {
          live,
          archived,
        };
      }
    );
  }

  async #requestThreadListSegment(
    session: JsonRpcSession,
    options: {
      archived: boolean;
      limit: number;
      timeoutMs: number;
    }
  ): Promise<CodexThreadSegmentResult> {
    try {
      const response = await session.request<ThreadListResponse>(
        'thread/list',
        {
          archived: options.archived,
          limit: options.limit,
          sortKey: 'updated_at',
        },
        options.timeoutMs
      );

      return {
        threads: response.data ?? [],
      };
    } catch (error) {
      return {
        threads: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #withThreadListSession<T>(
    options: ThreadListSessionOptions,
    handler: (session: JsonRpcSession) => Promise<T>
  ): Promise<T> {
    return this.rpcClient.withSession(
      {
        binaryPath: options.binaryPath,
        args: ['app-server'],
        requestTimeoutMs: options.requestTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        label: options.label,
      },
      async (session) => {
        await session.request(
          'initialize',
          {
            clientInfo: {
              name: 'agent-teams-ai',
              title: 'Agent Teams UI',
              version: '0.1.0',
            },
            capabilities: {
              experimentalApi: false,
              optOutNotificationMethods: SUPPRESSED_NOTIFICATION_METHODS,
            },
          },
          options.initializeTimeoutMs
        );

        await session.notify('initialized');
        return handler(session);
      }
    );
  }
}
