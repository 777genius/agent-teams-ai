/**
 * Worker thread for heavy team I/O operations (getTeamData, findLogsForTask).
 *
 * Runs in its own event loop, completely isolated from the Electron main thread.
 * This prevents file-heavy operations (scanning 300+ subagent JSONL files,
 * parsing large session files) from stalling the main process UI/IPC.
 */

import { parentPort } from 'node:worker_threads';

import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import { createLogger } from '@shared/utils/logger';

import type {
  TeamDataWorkerRequest,
  TeamDataWorkerResponse,
} from '@main/services/team/teamDataWorkerTypes';
import type { MemberLogSummary } from '@shared/types';

const logger = createLogger('Worker:TeamData');

// Instantiate services with default dependencies — worker has its own event loop
const teamDataService = new TeamDataService();
const logsFinder = new TeamMemberLogsFinder();

// In-flight dedup: concurrent calls for the same task piggyback on one request
const logsInFlight = new Map<string, Promise<unknown>>();
// Result cache with TTL to avoid re-scanning files
const logsResultCache = new Map<string, { result: MemberLogSummary[]; cachedAt: number }>();
const LOGS_CACHE_TTL_MS = 10_000;

function respond(msg: TeamDataWorkerResponse): void {
  parentPort?.postMessage(msg);
}

parentPort?.on('message', async (msg: TeamDataWorkerRequest) => {
  try {
    switch (msg.op) {
      case 'getTeamData': {
        const result = await teamDataService.getTeamData(msg.payload.teamName);
        respond({ id: msg.id, ok: true, result });
        break;
      }
      case 'findLogsForTask': {
        const { teamName, taskId, options } = msg.payload;
        const intervalsKey = options?.intervals
          ? options.intervals.map((i) => `${i.startedAt}~${i.completedAt ?? ''}`).join(',')
          : '';
        const cacheKey = `${teamName}:${taskId}:${options?.owner ?? ''}:${options?.status ?? ''}:${options?.since ?? ''}:${intervalsKey}`;

        // Check result cache
        const cached = logsResultCache.get(cacheKey);
        if (cached && Date.now() - cached.cachedAt < LOGS_CACHE_TTL_MS) {
          respond({ id: msg.id, ok: true, result: cached.result });
          break;
        }

        // Dedup concurrent calls
        let promise = logsInFlight.get(cacheKey) as Promise<MemberLogSummary[]> | undefined;
        if (!promise) {
          promise = logsFinder
            .findLogsForTask(teamName, taskId, options)
            .then((result) => {
              logsResultCache.set(cacheKey, { result, cachedAt: Date.now() });
              // Cap cache
              if (logsResultCache.size > 100) {
                const firstKey = logsResultCache.keys().next().value;
                if (firstKey !== undefined) logsResultCache.delete(firstKey);
              }
              return result;
            })
            .finally(() => {
              logsInFlight.delete(cacheKey);
            });
          logsInFlight.set(cacheKey, promise);
        }
        const result = await promise;
        respond({ id: msg.id, ok: true, result });
        break;
      }
      default: {
        const _exhaustive: never = msg;
        respond({ id: (_exhaustive as { id: string }).id, ok: false, error: `Unknown op` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[${msg.op}] ${message}`);
    respond({ id: msg.id, ok: false, error: message });
  }
});

logger.info('team-data-worker started');
