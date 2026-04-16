import { normalizeIdentityPath } from '@features/recent-projects/main/infrastructure/identity/normalizeIdentityPath';
import path from 'path';

import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
import type {
  RecentProjectsSourcePort,
  RecentProjectsSourceResult,
} from '@features/recent-projects/core/application/ports/RecentProjectsSourcePort';
import type { RecentProjectCandidate } from '@features/recent-projects/core/domain/models/RecentProjectCandidate';
import type {
  CodexAppServerClient,
  CodexRecentThreadsResult,
  CodexThreadSummary,
} from '@features/recent-projects/main/infrastructure/codex/CodexAppServerClient';
import type { RecentProjectIdentityResolver } from '@features/recent-projects/main/infrastructure/identity/RecentProjectIdentityResolver';
import type { ServiceContext } from '@main/services';

const CODEX_THREAD_LIMIT = 40;
const CODEX_INITIALIZE_TIMEOUT_MS = 6_000;
const CODEX_LIVE_FETCH_TIMEOUT_MS = 4_500;
const CODEX_ARCHIVED_FETCH_TIMEOUT_MS = 2_500;
const CODEX_SESSION_OVERHEAD_TIMEOUT_MS = 1_500;
const CODEX_TOTAL_FETCH_TIMEOUT_MS =
  CODEX_INITIALIZE_TIMEOUT_MS + CODEX_LIVE_FETCH_TIMEOUT_MS + CODEX_SESSION_OVERHEAD_TIMEOUT_MS;
const CODEX_SOURCE_TIMEOUT_MS = CODEX_TOTAL_FETCH_TIMEOUT_MS + 500;
const CODEX_LIVE_ONLY_FALLBACK_TOTAL_TIMEOUT_MS =
  CODEX_INITIALIZE_TIMEOUT_MS + CODEX_LIVE_FETCH_TIMEOUT_MS + CODEX_SESSION_OVERHEAD_TIMEOUT_MS;

function isInteractiveSource(source: unknown): boolean {
  return source === 'vscode' || source === 'cli';
}

function normalizeTimestamp(value: number | undefined): number {
  if (!value) {
    return 0;
  }
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function isDegradedThreadResult(result: CodexRecentThreadsResult): boolean {
  return Boolean(result.live.error || result.archived.error);
}

export class CodexRecentProjectsSourceAdapter implements RecentProjectsSourcePort {
  readonly sourceId = 'codex';
  readonly timeoutMs = CODEX_SOURCE_TIMEOUT_MS;

  constructor(
    private readonly deps: {
      getActiveContext: () => ServiceContext;
      getLocalContext: () => ServiceContext | undefined;
      resolveBinary: () => Promise<string | null>;
      appServerClient: CodexAppServerClient;
      identityResolver: RecentProjectIdentityResolver;
      logger: LoggerPort;
    }
  ) {}

  async list(): Promise<RecentProjectsSourceResult> {
    const activeContext = this.deps.getActiveContext();
    const localContext = this.deps.getLocalContext();

    if (activeContext.type !== 'local' || activeContext.id !== localContext?.id) {
      return {
        candidates: [],
        degraded: false,
      };
    }

    const binaryPath = await this.deps.resolveBinary();
    if (!binaryPath) {
      this.deps.logger.info('codex recent-projects source skipped - binary unavailable');
      return {
        candidates: [],
        degraded: false,
      };
    }

    const threadSegments = await this.#listRecentThreadsSafe(binaryPath);
    const degraded = isDegradedThreadResult(threadSegments);
    this.#logSegmentFailure(threadSegments, 'live');
    this.#logSegmentFailure(threadSegments, 'archived');
    const liveThreads = threadSegments.live.threads;
    const archivedThreads = threadSegments.archived.threads;

    const interactiveThreads = [...liveThreads, ...archivedThreads].filter(
      (thread) => Boolean(thread.cwd) && isInteractiveSource(thread.source)
    );

    const candidates = (
      await Promise.all(interactiveThreads.map((thread) => this.#toCandidate(thread)))
    ).filter((candidate): candidate is RecentProjectCandidate => candidate !== null);

    this.deps.logger.info('codex recent-projects source loaded', {
      count: candidates.length,
      degraded,
    });

    return {
      candidates,
      degraded,
    };
  }

  async #listRecentThreads(binaryPath: string): Promise<CodexRecentThreadsResult> {
    const result = await this.deps.appServerClient.listRecentThreads(binaryPath, {
      limit: CODEX_THREAD_LIMIT,
      liveRequestTimeoutMs: CODEX_LIVE_FETCH_TIMEOUT_MS,
      archivedRequestTimeoutMs: CODEX_ARCHIVED_FETCH_TIMEOUT_MS,
      initializeTimeoutMs: CODEX_INITIALIZE_TIMEOUT_MS,
      totalTimeoutMs: CODEX_TOTAL_FETCH_TIMEOUT_MS,
    });

    this.deps.logger.info('codex recent-projects thread lists loaded', {
      liveCount: result.live.threads.length,
      archivedCount: result.archived.threads.length,
    });
    return result;
  }

  #logSegmentFailure(result: CodexRecentThreadsResult, segment: 'live' | 'archived'): void {
    const error = result[segment].error;
    if (!error) {
      return;
    }

    if (segment === 'archived' && !result.live.error) {
      this.deps.logger.info('codex recent-projects archived thread list degraded', {
        error,
      });
      return;
    }

    this.deps.logger.warn('codex recent-projects thread list failed', {
      segment,
      error,
    });
  }

  async #listRecentThreadsSafe(binaryPath: string): Promise<CodexRecentThreadsResult> {
    try {
      return await this.#listRecentThreads(binaryPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn('codex recent-projects thread list session failed', {
        error: message,
      });

      if (message.toLowerCase().includes('timed out')) {
        return {
          live: { threads: [], error: message },
          archived: { threads: [], error: message },
        };
      }

      try {
        const liveFallback = await this.deps.appServerClient.listRecentLiveThreads(binaryPath, {
          limit: CODEX_THREAD_LIMIT,
          requestTimeoutMs: CODEX_LIVE_FETCH_TIMEOUT_MS,
          initializeTimeoutMs: CODEX_INITIALIZE_TIMEOUT_MS,
          totalTimeoutMs: CODEX_LIVE_ONLY_FALLBACK_TOTAL_TIMEOUT_MS,
        });

        this.deps.logger.info('codex recent-projects recovered with live-only fallback', {
          liveCount: liveFallback.threads.length,
        });

        return {
          live: liveFallback,
          archived: { threads: [], error: message },
        };
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.deps.logger.warn('codex recent-projects live-only fallback failed', {
          error: fallbackMessage,
        });
      }

      return {
        live: { threads: [], error: message },
        archived: { threads: [], error: message },
      };
    }
  }

  async #toCandidate(thread: CodexThreadSummary): Promise<RecentProjectCandidate | null> {
    const cwd = thread.cwd?.trim();
    if (!cwd) {
      return null;
    }

    const identity = await this.deps.identityResolver.resolve(cwd);
    const displayName = identity?.name ?? path.basename(cwd) ?? thread.name?.trim() ?? cwd;

    return {
      identity: identity?.id ?? `path:${normalizeIdentityPath(cwd)}`,
      displayName,
      primaryPath: cwd,
      associatedPaths: [cwd],
      lastActivityAt: normalizeTimestamp(thread.updatedAt ?? thread.createdAt),
      providerIds: ['codex'],
      sourceKind: 'codex',
      openTarget: {
        type: 'synthetic-path',
        path: cwd,
      },
      branchName: thread.gitInfo?.branch ?? undefined,
    };
  }
}
