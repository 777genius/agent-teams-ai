/**
 * Worker thread for heavy team I/O operations (getTeamData, findLogsForTask).
 *
 * Runs in its own event loop, completely isolated from the Electron main thread.
 * This prevents file-heavy operations (scanning 300+ subagent JSONL files,
 * parsing large session files) from stalling the main process UI/IPC.
 */

import { parentPort } from 'node:worker_threads';

import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import { applyElectronDevClaudeRootOverrideForWorker } from '@main/utils/electronDevPathOverrides';
import { createLogger } from '@shared/utils/logger';

import type {
  TeamDataWorkerRequest,
  TeamDataWorkerResponse,
} from '@main/services/team/teamDataWorkerTypes';
import type { MemberLogSummary } from '@shared/types';

const logger = createLogger('Worker:TeamData');

// Worker threads do not execute the Electron startup path that normally applies
// the explicit dev root. Mirror that single override before constructing any
// path-dependent services so dev:mcp reads teams, tasks, and messages from the
// same isolated profile as the main process.
applyElectronDevClaudeRootOverrideForWorker();

// Instantiate services with default dependencies — worker has its own event loop
const teamDataService = new TeamDataService();
const logsFinder = new TeamMemberLogsFinder();

// In-flight dedup: concurrent calls for the same task piggyback on one request
const logsInFlight = new Map<string, Promise<unknown>>();
// Result cache with TTL to avoid re-scanning files
const logsResultCache = new Map<string, { result: MemberLogSummary[]; cachedAt: number }>();
const LOGS_CACHE_TTL_MS = 10_000;
let heavyReadQueue: Promise<void> = Promise.resolve();

function respond(msg: TeamDataWorkerResponse): void {
  parentPort?.postMessage(msg);
}

function runHeavyRead<T>(load: () => Promise<T>): Promise<T> {
  const result = heavyReadQueue.catch(() => undefined).then(load);
  heavyReadQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

parentPort?.on('message', async (msg: TeamDataWorkerRequest) => {
  const startedAt = Date.now();
  const buildDiag = (): NonNullable<Extract<TeamDataWorkerResponse, { ok: true }>['diag']> => ({
    op: msg.op,
    ...(msg.payload && 'teamName' in msg.payload ? { teamName: msg.payload.teamName } : {}),
    ...(msg.payload && 'taskId' in msg.payload ? { taskId: msg.payload.taskId } : {}),
    totalMs: Date.now() - startedAt,
  });
  try {
    switch (msg.op) {
      case 'warmup': {
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'getTeamData': {
        const result = await runHeavyRead(() =>
          teamDataService.getTeamData(msg.payload.teamName, msg.payload.options)
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'getMessagesPage': {
        const result = await runHeavyRead(() =>
          teamDataService.getMessagesPage(msg.payload.teamName, msg.payload.options)
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'getMemberActivityMeta': {
        const result = await runHeavyRead(() =>
          teamDataService.getMemberActivityMeta(msg.payload.teamName)
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'invalidateTeamConfig': {
        TeamConfigReader.invalidateTeam(msg.payload.teamName);
        teamDataService.invalidateMessageFeed(msg.payload.teamName);
        teamDataService.invalidateTeamRuntimeAdvisories(msg.payload.teamName);
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'invalidateTeamMessageFeed': {
        teamDataService.invalidateMessageFeed(msg.payload.teamName);
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'invalidateMemberRuntimeAdvisory': {
        if (msg.payload.memberName) {
          teamDataService.invalidateMemberRuntimeAdvisory(
            msg.payload.teamName,
            msg.payload.memberName
          );
        } else {
          teamDataService.invalidateTeamRuntimeAdvisories(msg.payload.teamName);
        }
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'findLogsForTask': {
        const result = await runHeavyRead(async () => {
          const { teamName, taskId, options } = msg.payload;
          const intervalsKey = options?.intervals
            ? options.intervals.map((i) => `${i.startedAt}~${i.completedAt ?? ''}`).join(',')
            : '';
          const cacheKey = `${teamName}:${taskId}:${options?.owner ?? ''}:${options?.status ?? ''}:${options?.since ?? ''}:${intervalsKey}`;

          // Check result cache
          const cached = logsResultCache.get(cacheKey);
          if (cached && Date.now() - cached.cachedAt < LOGS_CACHE_TTL_MS) {
            return cached.result;
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
          return promise;
        });
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
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
