import type { JsonRpcStdioClient } from './JsonRpcStdioClient';

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;
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

export class CodexAppServerClient {
  constructor(private readonly rpcClient: JsonRpcStdioClient) {}

  async listRecentThreads(
    binaryPath: string,
    options: {
      limit: number;
      liveRequestTimeoutMs?: number;
      archivedRequestTimeoutMs?: number;
      totalTimeoutMs?: number;
    }
  ): Promise<CodexRecentThreadsResult> {
    const liveRequestTimeoutMs = options.liveRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const archivedRequestTimeoutMs = options.archivedRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const sessionRequestTimeoutMs = Math.max(liveRequestTimeoutMs, archivedRequestTimeoutMs);
    const totalTimeoutMs = Math.max(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      sessionRequestTimeoutMs + MIN_SESSION_OVERHEAD_TIMEOUT_MS
    );

    return this.rpcClient.withSession(
      {
        binaryPath,
        args: ['app-server'],
        requestTimeoutMs: sessionRequestTimeoutMs,
        totalTimeoutMs,
        label: 'codex app-server thread/list',
      },
      async (session) => {
        await session.request(
          'initialize',
          {
            clientInfo: {
              name: 'claude-agent-teams-ui',
              title: 'Claude Agent Teams UI',
              version: '0.1.0',
            },
            capabilities: {
              experimentalApi: false,
              optOutNotificationMethods: SUPPRESSED_NOTIFICATION_METHODS,
            },
          },
          sessionRequestTimeoutMs
        );

        await session.notify('initialized');

        const [live, archived] = await Promise.allSettled([
          session.request<ThreadListResponse>(
            'thread/list',
            {
              archived: false,
              limit: options.limit,
              sortKey: 'updated_at',
            },
            liveRequestTimeoutMs
          ),
          session.request<ThreadListResponse>(
            'thread/list',
            {
              archived: true,
              limit: options.limit,
              sortKey: 'updated_at',
            },
            archivedRequestTimeoutMs
          ),
        ]);

        return {
          live:
            live.status === 'fulfilled'
              ? { threads: live.value.data ?? [] }
              : {
                  threads: [],
                  error: live.reason instanceof Error ? live.reason.message : String(live.reason),
                },
          archived:
            archived.status === 'fulfilled'
              ? { threads: archived.value.data ?? [] }
              : {
                  threads: [],
                  error:
                    archived.reason instanceof Error
                      ? archived.reason.message
                      : String(archived.reason),
                },
        };
      }
    );
  }
}
