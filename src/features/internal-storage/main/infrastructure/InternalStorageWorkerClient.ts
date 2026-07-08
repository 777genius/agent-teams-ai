import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '../../contracts/internalStorageContracts';
import type { InternalStorageGateway } from '../../core/application/ports';
import type {
  InternalStorageWorkerData,
  InternalStorageWorkerRequest,
  InternalStorageWorkerResponse,
} from './worker/internalStorageWorkerProtocol';

const logger = createLogger('Service:InternalStorageWorkerClient');

const WORKER_CALL_TIMEOUT_MS = 20_000;
const WORKER_FILENAME = 'internal-storage-worker.cjs';

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  op: InternalStorageWorkerRequest['op'];
  createdAt: number;
}

interface QueuedEntry extends PendingEntry {
  id: string;
  payload: InternalStorageWorkerRequest['payload'];
}

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

function resolveWorkerPath(): string | null {
  // Same candidate strategy as team-fs-worker: co-located with the bundled
  // main output first, then the dev dist folder.
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.join(baseDir, WORKER_FILENAME),
    path.join(process.cwd(), 'dist-electron', 'main', WORKER_FILENAME),
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

/**
 * Async facade over the internal-storage worker thread. Requests run one at a
 * time (SQLite access is serialized anyway); a timeout or worker crash rejects
 * all in-flight requests and the worker is recreated on the next call.
 */
export class InternalStorageWorkerClient implements InternalStorageGateway {
  private worker: Worker | null = null;
  private readonly workerPath: string | null = resolveWorkerPath();
  private pending = new Map<string, PendingEntry>();
  private queue: QueuedEntry[] = [];
  private activeCallId: string | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: { databasePath: string }) {}

  isAvailable(): boolean {
    return this.workerPath !== null;
  }

  getWorkerPathCandidatesForDiagnostics(): string[] {
    const baseDir =
      typeof __dirname === 'string' && __dirname.length > 0
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    return [
      path.join(baseDir, WORKER_FILENAME),
      path.join(process.cwd(), 'dist-electron', 'main', WORKER_FILENAME),
    ];
  }

  async ping(): Promise<InternalStorageBackendInfo> {
    const result = await this.call('ping', {});
    return result as InternalStorageBackendInfo;
  }

  async loadStallJournalEntries(teamName: string): Promise<StallJournalEntryRecord[]> {
    const result = await this.call('stallJournal.load', { teamName });
    return result as StallJournalEntryRecord[];
  }

  async replaceStallJournalEntries(
    teamName: string,
    entries: StallJournalEntryRecord[]
  ): Promise<void> {
    await this.call('stallJournal.replace', { teamName, entries });
  }

  async recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void> {
    await this.call('storeImports.record', { storeId, teamName, entryCount });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (!worker) {
      return;
    }
    try {
      await this.call('close', {}, { allowWhenClosed: true });
    } catch (error) {
      logger.warn(
        `internal-storage close op failed; terminating worker anyway: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    this.worker = null;
    await worker.terminate().catch(() => undefined);
  }

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

  private ensureWorker(): Worker {
    if (!this.workerPath) {
      throw new Error('internal-storage worker is not available in this environment');
    }
    if (this.worker) {
      return this.worker;
    }

    const workerData: InternalStorageWorkerData = { databasePath: this.options.databasePath };
    const worker = new Worker(this.workerPath, { workerData });
    this.worker = worker;
    worker.on('message', (msg: InternalStorageWorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      this.clearActiveCall(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error));
      }
      this.processQueue();
    });
    worker.on('error', (err) => {
      logger.error('internal-storage worker error', err);
      this.failWorker(worker, err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`internal-storage worker exited with code ${code}`);
      }
      this.failWorker(worker, new Error(`internal-storage worker exited with code ${code}`));
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

    this.pending.set(entry.id, entry);
    this.activeCallId = entry.id;
    this.activeTimeout = setTimeout(() => {
      if (this.activeCallId !== entry.id) {
        return;
      }
      const timeoutError = new Error(
        `internal-storage worker call timeout after ${WORKER_CALL_TIMEOUT_MS}ms (${entry.op})`
      );
      logger.warn(
        `worker call timeout op=${entry.op} ms=${Date.now() - entry.createdAt} pendingNow=${this.pending.size} queued=${this.queue.length}`
      );
      this.failWorker(worker, timeoutError);
      // The worker may be stuck in native IO; terminate and recreate lazily.
      // SQLite's journal makes a mid-transaction kill safe (auto-rollback).
      void worker.terminate().catch(() => undefined);
    }, WORKER_CALL_TIMEOUT_MS);

    try {
      worker.postMessage({
        id: entry.id,
        op: entry.op,
        payload: entry.payload,
      } as InternalStorageWorkerRequest);
    } catch (error) {
      const postError = error instanceof Error ? error : new Error(String(error));
      this.pending.delete(entry.id);
      this.clearActiveCall(entry.id);
      entry.reject(postError);
      this.processQueue();
    }
  }

  private call(
    op: InternalStorageWorkerRequest['op'],
    payload: InternalStorageWorkerRequest['payload'],
    options: { allowWhenClosed?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed && !options.allowWhenClosed) {
      return Promise.reject(new Error('internal-storage client is closed'));
    }
    const id = makeId();
    const createdAt = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        op,
        payload,
        createdAt,
        resolve: (value) => {
          const ms = Date.now() - createdAt;
          if (ms >= 1500) {
            logger.warn(
              `worker call slow op=${op} ms=${ms} pendingNow=${this.pending.size} queued=${this.queue.length}`
            );
          }
          resolve(value);
        },
        reject,
      });
      this.processQueue();
    });
  }
}
