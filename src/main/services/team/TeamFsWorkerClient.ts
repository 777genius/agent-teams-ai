import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { getAppDataPath, getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { formatCurrentProcessMemorySnapshot } from '../../utils/startupTelemetry';

import type { TeamSummary, TeamTask } from '@shared/types';

const logger = createLogger('Service:TeamFsWorkerClient');

const DEFAULT_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const WORKER_CALL_TIMEOUT_MS = 20_000;

type WorkerDiag = Record<string, unknown>;

interface ListTeamsPayload {
  teamsDir: string;
  largeConfigBytes: number;
  configHeadBytes: number;
  maxConfigBytes: number;
  maxConfigReadMs: number;
  maxMembersMetaBytes: number;
  maxSessionHistoryInSummary: number;
  maxProjectPathHistoryInSummary: number;
  concurrency: number;
}

interface GetAllTasksPayload {
  tasksBase: string;
  projectionCacheBase: string;
  maxTaskBytes: number;
  maxTaskReadMs: number;
  concurrency: number;
}

type WorkerRequest =
  | { id: string; op: 'warmup'; payload?: Record<string, never> }
  | { id: string; op: 'listTeams'; payload: ListTeamsPayload }
  | { id: string; op: 'getAllTasks'; payload: GetAllTasksPayload };

type WorkerResponse =
  | { id: string; ok: true; result: unknown; diag?: WorkerDiag }
  | { id: string; ok: false; error: string };

interface PendingEntry {
  resolve: (v: { result: unknown; diag?: WorkerDiag }) => void;
  reject: (e: Error) => void;
  op: WorkerRequest['op'];
  payload: WorkerRequest['payload'];
  createdAt: number;
  postedAt: number;
  pendingAtStart: number;
}

interface QueuedEntry extends Omit<PendingEntry, 'postedAt' | 'pendingAtStart'> {
  id: string;
}

function summarizeWorkerPayload(payload: WorkerRequest['payload']): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  if ('teamsDir' in payload) {
    return {
      teamsDir: payload.teamsDir,
      concurrency: payload.concurrency,
      maxConfigReadMs: payload.maxConfigReadMs,
      maxConfigBytes: payload.maxConfigBytes,
    };
  }
  if (!('tasksBase' in payload)) {
    return {};
  }
  return {
    tasksBase: payload.tasksBase,
    projectionCacheBase: payload.projectionCacheBase,
    concurrency: payload.concurrency,
    maxTaskReadMs: payload.maxTaskReadMs,
    maxTaskBytes: payload.maxTaskBytes,
  };
}

function getDiagTotalMs(diag: WorkerDiag | undefined): unknown {
  return diag && typeof diag === 'object' ? diag.totalMs : undefined;
}

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

export function buildTeamFsWorkerPathCandidates(baseDir: string): string[] {
  const candidates = [path.join(baseDir, 'team-fs-worker.cjs')];
  if (path.basename(baseDir) === 'chunks') {
    candidates.push(path.join(path.dirname(baseDir), 'team-fs-worker.cjs'));
  }
  candidates.push(
    path.join(process.cwd(), 'dist-electron', 'main', 'team-fs-worker.cjs'),
    path.join(process.cwd(), 'dist-electron', 'main', 'team-fs-worker.js')
  );
  return candidates;
}

function resolveWorkerPath(): string | null {
  // We try multiple locations because dev/prod/test environments differ.
  // Priority: co-located with bundled main output, then workspace dist folder.
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  const candidates = buildTeamFsWorkerPathCandidates(baseDir);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function shouldWarnUnavailableWorker(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true';
}

export class TeamFsWorkerClient {
  private worker: Worker | null = null;
  private readonly workerPath: string | null = resolveWorkerPath();
  private warnedUnavailable = false;
  private pending = new Map<string, PendingEntry>();
  private queue: QueuedEntry[] = [];
  private activeCallId: string | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;

    this.worker = null;
    this.clearActiveCall();
    const pendingEntries = Array.from(this.pending.values());
    const queuedEntries = [...this.queue];
    this.pending.clear();
    this.queue = [];

    for (const entry of pendingEntries) {
      entry.reject(error);
    }
    for (const entry of queuedEntries) {
      entry.reject(error);
    }
  }

  isAvailable(): boolean {
    if (!this.workerPath && !this.warnedUnavailable && shouldWarnUnavailableWorker()) {
      this.warnedUnavailable = true;
      const baseDir =
        typeof __dirname === 'string' && __dirname.length > 0
          ? __dirname
          : path.dirname(fileURLToPath(import.meta.url));
      const expected = buildTeamFsWorkerPathCandidates(baseDir);
      logger.warn(
        `team-fs-worker not found; falling back to main-thread scanning. expectedOneOf=${expected.join(',')}`
      );
    }
    return this.workerPath !== null;
  }

  private ensureWorker(): Worker {
    if (!this.workerPath) {
      throw new Error('Worker is not available in this environment');
    }
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(this.workerPath);
    this.worker = worker;
    worker.on('message', (msg: WorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      this.clearActiveCall(msg.id);
      if (msg.ok) {
        entry.resolve({ result: msg.result, diag: msg.diag });
      } else {
        entry.reject(new Error(msg.error));
      }
      this.processQueue();
    });
    worker.on('error', (err) => {
      logger.error('Worker error', err);
      this.failWorker(worker, err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`Worker exited with code ${code}`);
      }
      this.failWorker(worker, new Error(`Worker exited with code ${code}`));
    });

    return worker;
  }

  private clearActiveCall(id?: string): void {
    if (id && this.activeCallId !== id) {
      return;
    }
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
    this.activeCallId = null;
  }

  private processQueue(): void {
    if (this.activeCallId || this.queue.length === 0) {
      return;
    }

    const entry = this.queue.shift();
    if (!entry) {
      return;
    }

    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      this.processQueue();
      return;
    }

    const postedAt = Date.now();
    const pendingAtStart = this.pending.size;
    const pendingEntry: PendingEntry = {
      ...entry,
      postedAt,
      pendingAtStart,
    };
    this.pending.set(entry.id, pendingEntry);
    this.activeCallId = entry.id;
    this.activeTimeout = setTimeout(() => {
      if (this.activeCallId !== entry.id) {
        return;
      }
      const timeoutError = new Error(
        `Worker call timeout after ${WORKER_CALL_TIMEOUT_MS}ms (${entry.op})`
      );
      logger.warn(
        `worker call timeout op=${entry.op} ms=${Date.now() - entry.createdAt} workerMs=${Date.now() - postedAt} queuedMs=${postedAt - entry.createdAt} pendingAtStart=${pendingAtStart} pendingNow=${this.pending.size} queued=${this.queue.length} payload=${JSON.stringify(
          summarizeWorkerPayload(entry.payload)
        )} memory=${formatCurrentProcessMemorySnapshot()}`
      );
      this.failWorker(worker, timeoutError);
      // Terminate and recreate on next call - worker may be stuck in native IO.
      void worker.terminate().catch(() => undefined);
    }, WORKER_CALL_TIMEOUT_MS);

    try {
      worker.postMessage({ id: entry.id, op: entry.op, payload: entry.payload } as WorkerRequest);
    } catch (error) {
      const postError = error instanceof Error ? error : new Error(String(error));
      this.pending.delete(entry.id);
      this.clearActiveCall(entry.id);
      pendingEntry.reject(postError);
      this.processQueue();
    }
  }

  private call(
    op: WorkerRequest['op'],
    payload: WorkerRequest['payload']
  ): Promise<{ result: unknown; diag?: WorkerDiag }> {
    const id = makeId();
    const createdAt = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        resolve: (value) => {
          const ms = Date.now() - createdAt;
          if (ms >= 1500) {
            const memorySuffix =
              ms >= 5_000 ? ` memory=${formatCurrentProcessMemorySnapshot()}` : '';
            logger.warn(
              `worker call slow op=${op} ms=${ms} workerTotalMs=${String(getDiagTotalMs(value.diag))} pendingNow=${this.pending.size} queued=${this.queue.length} payload=${JSON.stringify(
                summarizeWorkerPayload(payload)
              )}${memorySuffix}`
            );
          }
          resolve(value);
        },
        reject: (error) => {
          const ms = Date.now() - createdAt;
          if (ms >= 1500) {
            const memorySuffix =
              ms >= 5_000 ? ` memory=${formatCurrentProcessMemorySnapshot()}` : '';
            logger.warn(
              `worker call failed slow op=${op} ms=${ms} pendingNow=${this.pending.size} queued=${this.queue.length} payload=${JSON.stringify(
                summarizeWorkerPayload(payload)
              )}${memorySuffix} error=${error.message}`
            );
          }
          reject(error);
        },
        op,
        payload,
        createdAt,
      });
      this.processQueue();
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

  async listTeams(options: {
    largeConfigBytes: number;
    configHeadBytes: number;
    maxConfigBytes: number;
    maxMembersMetaBytes: number;
    maxSessionHistoryInSummary: number;
    maxProjectPathHistoryInSummary: number;
    concurrency?: number;
    maxConfigReadMs?: number;
  }): Promise<{ teams: TeamSummary[]; diag?: WorkerDiag }> {
    const payload: ListTeamsPayload = {
      teamsDir: getTeamsBasePath(),
      largeConfigBytes: options.largeConfigBytes,
      configHeadBytes: options.configHeadBytes,
      maxConfigBytes: options.maxConfigBytes,
      maxConfigReadMs: options.maxConfigReadMs ?? DEFAULT_READ_TIMEOUT_MS,
      maxMembersMetaBytes: options.maxMembersMetaBytes,
      maxSessionHistoryInSummary: options.maxSessionHistoryInSummary,
      maxProjectPathHistoryInSummary: options.maxProjectPathHistoryInSummary,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    };
    const { result, diag } = await this.call('listTeams', payload);
    return { teams: result as TeamSummary[], diag };
  }

  async getAllTasks(options: {
    maxTaskBytes: number;
    concurrency?: number;
    maxTaskReadMs?: number;
  }): Promise<{ tasks: (TeamTask & { teamName: string })[]; diag?: WorkerDiag }> {
    const payload: GetAllTasksPayload = {
      tasksBase: getTasksBasePath(),
      projectionCacheBase: path.join(getAppDataPath(), 'cache', 'team-task-projections'),
      maxTaskBytes: options.maxTaskBytes,
      maxTaskReadMs: options.maxTaskReadMs ?? DEFAULT_READ_TIMEOUT_MS,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    };
    const { result, diag } = await this.call('getAllTasks', payload);
    return { tasks: result as (TeamTask & { teamName: string })[], diag };
  }
}

let singleton: TeamFsWorkerClient | null = null;

export function getTeamFsWorkerClient(): TeamFsWorkerClient {
  if (!singleton) {
    singleton = new TeamFsWorkerClient();
  }
  return singleton;
}
