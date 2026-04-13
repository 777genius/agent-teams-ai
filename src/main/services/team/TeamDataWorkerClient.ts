/**
 * Main-thread client for team-data-worker.
 *
 * Proxies getTeamData and findLogsForTask calls to a worker thread
 * so they don't block the Electron main event loop.
 * Falls back to main-thread execution if the worker is unavailable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import type { TeamDataWorkerRequest, TeamDataWorkerResponse } from './teamDataWorkerTypes';
import type { MemberLogSummary, TeamData } from '@shared/types';

const logger = createLogger('Service:TeamDataWorkerClient');
const WORKER_CALL_TIMEOUT_MS = 30_000;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

function resolveWorkerPath(): string | null {
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.join(baseDir, 'team-data-worker.cjs'),
    path.join(process.cwd(), 'dist-electron', 'main', 'team-data-worker.cjs'),
  ];

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
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class TeamDataWorkerClient {
  private worker: Worker | null = null;
  private readonly workerPath: string | null = resolveWorkerPath();
  private warnedUnavailable = false;
  private pending = new Map<string, PendingEntry>();

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;

    this.worker = null;
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();

    for (const entry of pendingEntries) {
      entry.reject(error);
    }
  }

  isAvailable(): boolean {
    if (!this.workerPath && !this.warnedUnavailable) {
      this.warnedUnavailable = true;
      logger.debug('team-data-worker not found; falling back to main-thread execution');
    }
    return this.workerPath !== null;
  }

  private ensureWorker(): Worker {
    if (!this.workerPath) throw new Error('Worker not available');
    if (this.worker) return this.worker;

    const w = new Worker(this.workerPath);
    this.worker = w;

    w.on('message', (msg: TeamDataWorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutError = new Error(`Worker call timeout after ${WORKER_CALL_TIMEOUT_MS}ms`);
        this.failWorker(worker, timeoutError);
        worker.terminate().catch(() => undefined);
        reject(timeoutError);
      }, WORKER_CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      worker.postMessage({ id, op, payload } as TeamDataWorkerRequest);
    });
  }

  async getTeamData(teamName: string): Promise<TeamData> {
    if (!SAFE_NAME_RE.test(teamName)) throw new Error('Invalid teamName');
    return this.call('getTeamData', { teamName }) as Promise<TeamData>;
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
