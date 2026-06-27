/**
 * Main-thread client for team-data-worker.
 *
 * Proxies getTeamData and findLogsForTask calls to a worker thread
 * so they don't block the Electron main event loop.
 * Main-thread fallback is only safe when the worker is unavailable. If an
 * existing worker OOMs or times out, repeating the same read on Electron main
 * can crash the app.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import type { TeamDataWorkerRequest, TeamDataWorkerResponse } from './teamDataWorkerTypes';
import type {
  InboxMessage,
  MemberLogSummary,
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types';

const logger = createLogger('Service:TeamDataWorkerClient');
const WORKER_CALL_TIMEOUT_MS = 30_000;
const WORKER_FATAL_RESTART_COOLDOWN_MS = 30_000;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const FATAL_WORKER_ERROR_PATTERNS = [
  'ERR_WORKER_OUT_OF_MEMORY',
  'Team data worker recovering after fatal failure',
  'Worker terminated due to reaching memory limit',
  'JS heap out of memory',
  'JavaScript heap out of memory',
  'Worker exited with code',
  'Worker call timeout after',
] as const;

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

function getWorkerPathCandidates(): string[] {
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  return [
    path.join(baseDir, 'team-data-worker.cjs'),
    path.join(process.cwd(), 'dist-electron', 'main', 'team-data-worker.cjs'),
  ];
}

function resolveWorkerPath(): string | null {
  const candidates = getWorkerPathCandidates();

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  // Don't warn here — resolveWorkerPath runs at module load time and
  // the worker file is expected to be absent during tests.
  // isAvailable() warns once on first access instead.
  return null;
}

interface PendingEntry {
  resolve: (v: unknown, diag?: Extract<TeamDataWorkerResponse, { ok: true }>['diag']) => void;
  reject: (e: Error) => void;
  op: TeamDataWorkerRequest['op'];
  summary: Record<string, unknown>;
  startedAt: number;
}

function normalizeTeamGetDataOptions(options?: TeamGetDataOptions): TeamGetDataOptions | undefined {
  return options?.includeMemberBranches === false ? { includeMemberBranches: false } : undefined;
}

function getTeamDataRequestKey(teamName: string, options?: TeamGetDataOptions): string {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  return `${teamName}\u0000branches:${normalizedOptions ? '0' : '1'}`;
}

function getTeamDataRequestPayload(
  teamName: string,
  options?: TeamGetDataOptions
): Extract<TeamDataWorkerRequest, { op: 'getTeamData' }>['payload'] {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  return normalizedOptions ? { teamName, options: normalizedOptions } : { teamName };
}

function shortHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized === undefined) return undefined;
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

function getLiveMessagesRequestKey(liveMessages?: InboxMessage[]): unknown {
  if (!liveMessages?.length) return undefined;
  return liveMessages.map((message) => ({
    messageId: message.messageId,
    timestamp: message.timestamp,
    source: message.source,
    from: message.from,
    to: message.to,
    read: message.read,
    actionMode: message.actionMode,
    commentId: message.commentId,
    color: message.color,
    relayOfMessageId: message.relayOfMessageId,
    leadSessionId: message.leadSessionId,
    conversationId: message.conversationId,
    replyToConversationId: message.replyToConversationId,
    messageKind: message.messageKind,
    workSyncIntent: message.workSyncIntent,
    workSyncIntentKey: message.workSyncIntentKey,
    workSyncPayloadHash: message.workSyncPayloadHash,
    textHash: shortHash(message.text ?? ''),
    summaryHash: shortHash(message.summary),
    taskRefsHash: shortHash(message.taskRefs),
    attachmentsHash: shortHash(message.attachments),
    toolSummaryHash: shortHash(message.toolSummary),
    toolCallsHash: shortHash(message.toolCalls),
    workSyncReviewRequestEventIdsHash: shortHash(message.workSyncReviewRequestEventIds),
    slashCommandHash: shortHash(message.slashCommand),
    commandOutputHash: shortHash(message.commandOutput),
  }));
}

function summarizeWorkerRequest(request: TeamDataWorkerRequest): Record<string, unknown> {
  switch (request.op) {
    case 'warmup':
      return {};
    case 'getTeamData': {
      const { teamName, options } = request.payload;
      return {
        teamName,
        includeMemberBranches: options?.includeMemberBranches !== false,
      };
    }
    case 'getMessagesPage': {
      const { teamName, options } = request.payload;
      return {
        teamName,
        cursor: typeof options.cursor === 'string' ? options.cursor.slice(0, 24) : options.cursor,
        limit: options.limit,
        liveMessages: options.liveMessages?.length,
      };
    }
    case 'getMemberActivityMeta':
    case 'invalidateTeamConfig':
    case 'invalidateTeamMessageFeed':
      return {
        teamName: request.payload.teamName,
      };
    case 'invalidateMemberRuntimeAdvisory':
      return {
        teamName: request.payload.teamName,
        memberName: request.payload.memberName,
      };
    case 'findLogsForTask':
      return {
        teamName: request.payload.teamName,
        taskId: request.payload.taskId,
        owner: request.payload.options?.owner,
        status: request.payload.options?.status,
        intervals: Array.isArray(request.payload.options?.intervals)
          ? request.payload.options.intervals.length
          : undefined,
        since: request.payload.options?.since,
      };
  }
  return {};
}

export class TeamDataWorkerClient {
  private worker: Worker | null = null;
  private readonly workerPath: string | null = resolveWorkerPath();
  private warnedUnavailable = false;
  private pending = new Map<string, PendingEntry>();
  private getTeamDataInFlight = new Map<string, Promise<TeamViewSnapshot>>();
  private getMessagesPageInFlight = new Map<string, Promise<MessagesPage>>();
  private getMemberActivityMetaInFlight = new Map<string, Promise<TeamMemberActivityMeta>>();
  private fatalRestartCooldownUntilMs = 0;
  private lastFatalWorkerError: string | null = null;

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;

    this.worker = null;
    if (isTeamDataWorkerFatalError(error)) {
      this.lastFatalWorkerError = error.message;
      this.fatalRestartCooldownUntilMs = Date.now() + WORKER_FATAL_RESTART_COOLDOWN_MS;
      const pendingSummary = Array.from(this.pending.values())
        .slice(0, 10)
        .map((entry) => ({
          op: entry.op,
          ms: Date.now() - entry.startedAt,
          payload: entry.summary,
        }));
      logger.error(
        `worker fatal failure pending=${this.pending.size} pendingSample=${JSON.stringify(
          pendingSummary
        )} error=${error.message}`
      );
    }
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();

    for (const entry of pendingEntries) {
      entry.reject(error);
    }
  }

  isAvailable(): boolean {
    if (!this.workerPath && !this.warnedUnavailable) {
      this.warnedUnavailable = true;
      logger.warn(
        `team-data-worker not found; heavy team data paths may fall back to main-thread execution. expectedOneOf=${getWorkerPathCandidates().join(',')}`
      );
    }
    return this.workerPath !== null;
  }

  private ensureWorker(): Worker {
    if (!this.workerPath) throw new Error('Worker not available');
    if (this.worker) return this.worker;
    if (Date.now() < this.fatalRestartCooldownUntilMs) {
      throw new Error(
        `Team data worker recovering after fatal failure: ${this.lastFatalWorkerError ?? 'unknown'}`
      );
    }

    const w = new Worker(this.workerPath);
    this.worker = w;

    w.on('message', (msg: TeamDataWorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result, msg.diag);
      } else {
        entry.reject(new Error(msg.error));
      }
    });

    // Scope error/exit handlers to this specific worker instance.
    // Without this guard, a stale worker's exit event can reject
    // pending requests that belong to a newer replacement worker.
    w.on('error', (err) => {
      logger.error('Worker error', err);
      this.failWorker(w, err instanceof Error ? err : new Error(String(err)));
    });

    w.on('exit', (code) => {
      if (code !== 0) logger.warn(`Worker exited with code ${code}`);
      this.failWorker(w, new Error(`Worker exited with code ${code}`));
    });

    return w;
  }

  private call(
    op: TeamDataWorkerRequest['op'],
    payload: TeamDataWorkerRequest['payload']
  ): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = makeId();
    const request = { id, op, payload } as TeamDataWorkerRequest;
    const summary = summarizeWorkerRequest(request);
    const startedAt = Date.now();
    const pendingAtStart = this.pending.size;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutError = new Error(`Worker call timeout after ${WORKER_CALL_TIMEOUT_MS}ms`);
        logger.warn(
          `worker call timeout op=${op} ms=${Date.now() - startedAt} pendingAtStart=${pendingAtStart} pendingNow=${this.pending.size} payload=${JSON.stringify(
            summary
          )}`
        );
        this.failWorker(worker, timeoutError);
        worker.terminate().catch(() => undefined);
        reject(timeoutError);
      }, WORKER_CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value, diag) => {
          clearTimeout(timeout);
          const ms = Date.now() - startedAt;
          if (ms >= 1500) {
            logger.warn(
              `worker call slow op=${op} ms=${ms} workerTotalMs=${String(diag?.totalMs ?? 'unknown')} pendingAtStart=${pendingAtStart} pendingNow=${this.pending.size} payload=${JSON.stringify(
                summary
              )}`
            );
          }
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          const ms = Date.now() - startedAt;
          if (ms >= 1500) {
            logger.warn(
              `worker call failed slow op=${op} ms=${ms} pendingAtStart=${pendingAtStart} pendingNow=${this.pending.size} payload=${JSON.stringify(
                summary
              )} error=${error.message}`
            );
          }
          reject(error);
        },
        op,
        summary,
        startedAt,
      });

      worker.postMessage(request);
    });
  }

  async prewarm(): Promise<void> {
    if (this.worker) {
      return;
    }
    if (!this.isAvailable()) {
      return;
    }
    const startedAt = Date.now();
    await this.call('warmup', {});
    const ms = Date.now() - startedAt;
    if (ms >= 1500) {
      logger.warn(`worker prewarm slow ms=${ms}`);
    }
  }

  private postBestEffort(
    op: TeamDataWorkerRequest['op'],
    payload: TeamDataWorkerRequest['payload']
  ): void {
    const worker = this.worker;
    if (!worker) return;
    const request = { id: makeId(), op, payload } as TeamDataWorkerRequest;
    try {
      worker.postMessage(request);
    } catch (error) {
      logger.debug(
        `worker best-effort post failed op=${op} payload=${JSON.stringify(
          summarizeWorkerRequest(request)
        )} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    if (!SAFE_NAME_RE.test(teamName)) throw new Error('Invalid teamName');
    const key = getTeamDataRequestKey(teamName, options);
    const existing = this.getTeamDataInFlight.get(key);
    if (existing) return existing;

    const payload = getTeamDataRequestPayload(teamName, options);
    const promise = (this.call('getTeamData', payload) as Promise<TeamViewSnapshot>).finally(() => {
      if (this.getTeamDataInFlight.get(key) === promise) {
        this.getTeamDataInFlight.delete(key);
      }
    });
    this.getTeamDataInFlight.set(key, promise);
    return promise;
  }

  invalidateTeamConfig(teamName: string): void {
    if (!SAFE_NAME_RE.test(teamName)) return;
    this.postBestEffort('invalidateTeamConfig', { teamName });
  }

  invalidateTeamMessageFeed(teamName: string): void {
    if (!SAFE_NAME_RE.test(teamName)) return;
    this.postBestEffort('invalidateTeamMessageFeed', { teamName });
  }

  invalidateMemberRuntimeAdvisory(teamName: string, memberName?: string): void {
    if (!SAFE_NAME_RE.test(teamName)) return;
    if (memberName !== undefined && !SAFE_NAME_RE.test(memberName)) return;
    this.postBestEffort('invalidateMemberRuntimeAdvisory', {
      teamName,
      ...(memberName ? { memberName } : {}),
    });
  }

  async getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number; liveMessages?: InboxMessage[] }
  ): Promise<MessagesPage> {
    if (!SAFE_NAME_RE.test(teamName)) throw new Error('Invalid teamName');
    const key = JSON.stringify({
      teamName,
      cursor: options.cursor ?? null,
      limit: options.limit,
      liveMessages: getLiveMessagesRequestKey(options.liveMessages),
    });
    const existing = this.getMessagesPageInFlight.get(key);
    if (existing) return existing;

    const promise = (
      this.call('getMessagesPage', {
        teamName,
        options,
      }) as Promise<MessagesPage>
    ).finally(() => {
      if (this.getMessagesPageInFlight.get(key) === promise) {
        this.getMessagesPageInFlight.delete(key);
      }
    });
    this.getMessagesPageInFlight.set(key, promise);
    return promise;
  }

  async getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    if (!SAFE_NAME_RE.test(teamName)) throw new Error('Invalid teamName');
    const existing = this.getMemberActivityMetaInFlight.get(teamName);
    if (existing) return existing;

    const promise = (
      this.call('getMemberActivityMeta', { teamName }) as Promise<TeamMemberActivityMeta>
    ).finally(() => {
      if (this.getMemberActivityMetaInFlight.get(teamName) === promise) {
        this.getMemberActivityMetaInFlight.delete(teamName);
      }
    });
    this.getMemberActivityMetaInFlight.set(teamName, promise);
    return promise;
  }

  async findLogsForTask(
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    }
  ): Promise<MemberLogSummary[]> {
    if (!SAFE_NAME_RE.test(teamName)) throw new Error('Invalid teamName');
    if (!SAFE_ID_RE.test(taskId)) throw new Error('Invalid taskId');
    return this.call('findLogsForTask', { teamName, taskId, options }) as Promise<
      MemberLogSummary[]
    >;
  }

  dispose(): void {
    this.worker?.terminate().catch(() => undefined);
    this.worker = null;
    this.getTeamDataInFlight.clear();
    this.getMessagesPageInFlight.clear();
    this.getMemberActivityMetaInFlight.clear();
    for (const [, entry] of this.pending) {
      entry.reject(new Error('Client disposed'));
    }
    this.pending.clear();
  }
}

// Singleton
let singleton: TeamDataWorkerClient | null = null;
export function getTeamDataWorkerClient(): TeamDataWorkerClient {
  if (!singleton) singleton = new TeamDataWorkerClient();
  return singleton;
}

export function isTeamDataWorkerFatalError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message} ${(error as { code?: unknown }).code ?? ''}`
      : String(error);
  return FATAL_WORKER_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}
