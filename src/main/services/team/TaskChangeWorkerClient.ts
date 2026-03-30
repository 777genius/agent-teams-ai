import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import type {
  ResolvedTaskChangeComputeInput,
  TaskChangeWorkerRequest,
  TaskChangeWorkerResponse,
} from './taskChangeWorkerTypes';
import type { TaskChangeSetV2 } from '@shared/types';

const logger = createLogger('Service:TaskChangeWorkerClient');
const DEFAULT_WORKER_CALL_TIMEOUT_MS = 30_000;

interface WorkerLike {
  on(event: 'message', listener: (msg: TaskChangeWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: TaskChangeWorkerRequest): void;
  terminate(): Promise<number>;
}

interface QueueEntry {
  id: string;
  request: TaskChangeWorkerRequest;
  resolve: (value: TaskChangeSetV2) => void;
  reject: (error: Error) => void;
}

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

function resolveWorkerPath(): string | null {
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.join(baseDir, 'task-change-worker.cjs'),
    path.join(process.cwd(), 'dist-electron', 'main', 'task-change-worker.cjs'),
    path.join(process.cwd(), 'dist-electron', 'main', 'task-change-worker.js'),
  ];

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

export class TaskChangeWorkerClient {
  private worker: WorkerLike | null = null;
  private terminatingWorker: WorkerLike | null = null;
  private readonly workerPath: string | null;
  private readonly workerFactory: (workerPath: string) => WorkerLike;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private warnedUnavailable = false;
  private activeRequestId: string | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminatingForTimeoutRequestId: string | null = null;
  private pending = new Map<string, QueueEntry>();
  private queue: QueueEntry[] = [];

  constructor(options?: {
    workerPath?: string | null;
    workerFactory?: (workerPath: string) => WorkerLike;
    timeoutMs?: number;
    enabled?: boolean;
  }) {
    this.workerPath =
      options && 'workerPath' in options ? (options.workerPath ?? null) : resolveWorkerPath();
    this.workerFactory = options?.workerFactory ?? ((workerPath) => new Worker(workerPath));
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_WORKER_CALL_TIMEOUT_MS;
    this.enabled = options?.enabled ?? process.env.CLAUDE_TEAM_ENABLE_TASK_CHANGE_WORKER !== '0';
  }

  isAvailable(): boolean {
    if (!this.enabled) {
      return false;
    }

    if (!this.workerPath && !this.warnedUnavailable) {
      this.warnedUnavailable = true;
      logger.warn('task-change-worker not found; falling back to main-thread extraction.');
    }

    return this.workerPath !== null;
  }

  async computeTaskChanges(payload: ResolvedTaskChangeComputeInput): Promise<TaskChangeSetV2> {
    if (!this.isAvailable()) {
      throw new Error('Task change worker is not available in this environment');
    }

    const id = makeId();
    const entry: QueueEntry = {
      id,
      request: { id, op: 'computeTaskChanges', payload },
      resolve: () => undefined,
      reject: () => undefined,
    };

    return new Promise<TaskChangeSetV2>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      this.pending.set(id, entry);
      this.queue.push(entry);
      this.processQueue();
    });
  }

  private ensureWorker(): WorkerLike {
    if (!this.workerPath) {
      throw new Error('Task change worker is not available in this environment');
    }
    if (this.worker) {
      return this.worker;
    }

    const worker = this.workerFactory(this.workerPath);
    worker.on('message', (msg) => this.handleMessage(msg));
    worker.on('error', (error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));
    this.worker = worker;
    return worker;
  }

  private processQueue(): void {
    if (this.activeRequestId || this.queue.length === 0) {
      return;
    }

    const entry = this.queue.shift();
    if (!entry) {
      return;
    }

    const worker = this.ensureWorker();
    this.activeRequestId = entry.id;
    this.activeTimeout = setTimeout(() => {
      const activeId = this.activeRequestId;
      if (!activeId) {
        return;
      }

      this.clearActiveState();
      this.terminatingForTimeoutRequestId = activeId;
      const pending = this.pending.get(activeId);
      if (pending) {
        this.pending.delete(activeId);
        pending.reject(
          new Error(`Worker call timeout after ${this.timeoutMs}ms (computeTaskChanges)`)
        );
      }

      try {
        const workerToTerminate = this.worker;
        this.terminatingWorker = workerToTerminate;
        workerToTerminate?.terminate().catch(() => undefined);
      } catch {
        // ignore
      } finally {
        this.worker = null;
      }

      this.processQueue();
    }, this.timeoutMs);

    try {
      worker.postMessage(entry.request);
    } catch (error) {
      this.clearActiveState();
      this.pending.delete(entry.id);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      this.processQueue();
    }
  }

  private handleMessage(message: TaskChangeWorkerResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }

    this.pending.delete(message.id);
    if (this.activeRequestId === message.id) {
      this.clearActiveState();
    }

    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error));
    }

    this.processQueue();
  }

  private handleWorkerFailure(worker: WorkerLike, error: Error): void {
    logger.error('Task change worker error', error);
    if (this.terminatingForTimeoutRequestId && this.terminatingWorker === worker) {
      this.terminatingForTimeoutRequestId = null;
      this.terminatingWorker = null;
      return;
    }

    this.rejectAllPending(error);
    this.clearActiveState();
    if (this.worker === worker) {
      this.worker = null;
    }
  }

  private handleWorkerExit(worker: WorkerLike, code: number): void {
    if (this.terminatingForTimeoutRequestId && this.terminatingWorker === worker) {
      this.terminatingForTimeoutRequestId = null;
      this.terminatingWorker = null;
      return;
    }

    if (code !== 0) {
      logger.warn(`Task change worker exited with code ${code}`);
    }
    this.rejectAllPending(new Error(`Worker exited with code ${code}`));
    this.clearActiveState();
    if (this.worker === worker) {
      this.worker = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
    this.queue = [];
  }

  private clearActiveState(): void {
    this.activeRequestId = null;
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
  }
}

let singleton: TaskChangeWorkerClient | null = null;

export function getTaskChangeWorkerClient(): TaskChangeWorkerClient {
  if (!singleton) {
    singleton = new TaskChangeWorkerClient();
  }
  return singleton;
}
