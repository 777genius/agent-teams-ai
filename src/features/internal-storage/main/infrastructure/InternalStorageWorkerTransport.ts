import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import { InternalStorageOperationInterruptedError } from '../../core/application/InternalStorageOperationInterruptedError';
import {
  isProcessOwnershipStorageCallAdmitted,
  type ProcessOwnershipStorageCallContext,
} from '../application/processOwnershipStorage';

import {
  type ApplicationCommandLedgerWorkerPayloadByOp,
  type ExternalWriterObservationWorkerPayloadByOp,
  type HostedTeamConfigurationWorkerPayloadByOp,
  type InternalStorageWorkerData,
  type InternalStorageWorkerRequest,
  type InternalStorageWorkerResponse,
  parseInternalStorageWorkerResponseForPending,
} from './worker/internalStorageWorkerProtocol';
import {
  getInternalStorageWorkerPathCandidates,
  resolveInternalStorageWorkerPath,
} from './internalStorageWorkerPath';

const logger = createLogger('Service:InternalStorageWorkerClient');
const WORKER_CALL_TIMEOUT_MS = 20_000;

export type InternalStorageWorkerPayloadFor<TOp extends InternalStorageWorkerRequest['op']> =
  TOp extends keyof ApplicationCommandLedgerWorkerPayloadByOp
    ? ApplicationCommandLedgerWorkerPayloadByOp[TOp]
    : TOp extends keyof ExternalWriterObservationWorkerPayloadByOp
      ? ExternalWriterObservationWorkerPayloadByOp[TOp]
      : TOp extends keyof HostedTeamConfigurationWorkerPayloadByOp
        ? HostedTeamConfigurationWorkerPayloadByOp[TOp]
        : TOp extends `appCommandLedger.${string}` | `mws.${string}`
          ? unknown
          : Extract<InternalStorageWorkerRequest, { op: TOp }>['payload'];

export interface InternalStorageWorkerCallOptions {
  readonly allowWhenClosed?: boolean;
  readonly timeoutAtMs?: number;
  readonly admission?: ProcessOwnershipStorageCallContext;
  readonly signal?: AbortSignal;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  op: InternalStorageWorkerRequest['op'];
  createdAt: number;
  timeoutAtMs?: number;
}

interface QueuedEntry extends PendingEntry {
  id: string;
  payload: InternalStorageWorkerRequest['payload'];
  admission?: ProcessOwnershipStorageCallContext;
  signal?: AbortSignal;
  detachAbortListener?: () => void;
}

function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

function isHostedTeamConfigurationMutation(op: InternalStorageWorkerRequest['op']): boolean {
  return (
    op === 'hostedTeamConfiguration.create' ||
    op === 'hostedTeamConfiguration.update' ||
    op === 'hostedTeamConfiguration.delete'
  );
}

/**
 * Owns worker lifecycle and serialized request dispatch. The public storage
 * client only maps feature gateway methods onto this transport.
 */
export class InternalStorageWorkerTransport {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingEntry>();
  private queue: QueuedEntry[] = [];
  private activeCallId: string | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private retirement: {
    worker: Worker;
    settled: Promise<void>;
    finish(): void;
  } | null = null;

  constructor(
    private readonly options: {
      databasePath: string;
      mode?: InternalStorageWorkerData['mode'];
      promotionCommitBinding?: InternalStorageWorkerData['promotionCommitBinding'];
    },
    private readonly getWorkerPath: () => string | null = resolveInternalStorageWorkerPath
  ) {}

  isAvailable(): boolean {
    return this.getWorkerPath() !== null;
  }

  getWorkerPathCandidatesForDiagnostics(): string[] {
    return getInternalStorageWorkerPathCandidates();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeAndDrain();
    return this.closePromise;
  }

  async waitForSettling(): Promise<void> {
    while (this.retirement) await this.retirement.settled;
  }

  private async closeAndDrain(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      await this.waitForSettling();
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
    this.failWorker(worker, new Error('internal-storage client is closed'));
    await this.waitForSettling();
  }

  private finishRetirement(worker: Worker): void {
    const retirement = this.retirement;
    if (retirement?.worker !== worker) return;
    this.retirement = null;
    retirement.finish();
  }

  private failWorker(worker: Worker, error: Error, exited = false): void {
    if (this.worker !== worker) {
      if (exited) this.finishRetirement(worker);
      return;
    }

    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.retirement = { worker, settled, finish };
    this.worker = null;
    this.clearActiveCall();
    const pendingEntries = Array.from(this.pending.values());
    const queuedEntries = [...this.queue];
    this.pending.clear();
    this.queue = [];

    for (const entry of pendingEntries) {
      entry.reject(
        new InternalStorageOperationInterruptedError(error.message, 'unknown', settled, error)
      );
    }
    for (const entry of queuedEntries) {
      entry.detachAbortListener?.();
      entry.reject(
        new InternalStorageOperationInterruptedError(error.message, 'not_started', settled, error)
      );
    }
    if (exited) {
      this.finishRetirement(worker);
    } else {
      void Promise.resolve()
        .then(() => worker.terminate())
        .then(
          () => this.finishRetirement(worker),
          (terminationError: unknown) =>
            logger.error('internal-storage worker termination unconfirmed', terminationError)
        );
    }
  }

  private ensureWorker(): Worker {
    if (this.retirement) {
      throw new InternalStorageOperationInterruptedError(
        'internal-storage previous worker has not exited',
        'not_started',
        this.retirement.settled
      );
    }
    const workerPath = this.getWorkerPath();
    if (!workerPath) {
      throw new Error('internal-storage worker is not available in this environment');
    }
    if (this.worker) {
      return this.worker;
    }

    const workerData: InternalStorageWorkerData = {
      databasePath: this.options.databasePath,
      ...(this.options.mode === undefined ? {} : { mode: this.options.mode }),
      ...(this.options.promotionCommitBinding === undefined
        ? {}
        : { promotionCommitBinding: this.options.promotionCommitBinding }),
    };
    const worker = new Worker(workerPath, { workerData });
    this.worker = worker;
    worker.on('message', (value: unknown) => {
      let msg: InternalStorageWorkerResponse;
      try {
        msg = parseInternalStorageWorkerResponseForPending(value, (id) => this.pending.get(id)?.op);
      } catch (error) {
        this.failWorker(worker, error instanceof Error ? error : new Error(String(error)));
        return;
      }
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
      if (code !== 0 && !this.closed && this.worker === worker) {
        logger.warn(`internal-storage worker exited with code ${code}`);
      }
      this.failWorker(worker, new Error(`internal-storage worker exited with code ${code}`), true);
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
    if (
      entry.signal?.aborted ||
      (entry.timeoutAtMs !== undefined && Date.now() >= entry.timeoutAtMs) ||
      !isProcessOwnershipStorageCallAdmitted(entry.admission)
    ) {
      entry.detachAbortListener?.();
      entry.reject(new Error('process-ownership-storage-call-admission-expired'));
      this.processQueue();
      return;
    }
    entry.detachAbortListener?.();

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
    const dispatchedAt = Date.now();
    let timeoutMs =
      entry.timeoutAtMs === undefined || isHostedTeamConfigurationMutation(entry.op)
        ? WORKER_CALL_TIMEOUT_MS
        : Math.max(1, entry.timeoutAtMs - dispatchedAt);
    if (entry.admission) {
      timeoutMs = Math.min(timeoutMs, Math.max(1, entry.admission.deadlineAtMs - dispatchedAt));
    }
    this.activeTimeout = setTimeout(() => {
      if (this.activeCallId !== entry.id) {
        return;
      }
      const timeoutError = new Error(
        `internal-storage worker call timeout after ${Date.now() - entry.createdAt}ms (${entry.op})`
      );
      logger.warn(
        `worker call timeout op=${entry.op} ms=${Date.now() - entry.createdAt} pendingNow=${this.pending.size} queued=${this.queue.length}`
      );
      this.failWorker(worker, timeoutError);
    }, timeoutMs);

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

  call<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    if (this.closed && !options.allowWhenClosed) {
      return Promise.reject(new Error('internal-storage client is closed'));
    }
    const id = makeId();
    const createdAt = Date.now();
    return new Promise((resolve, reject) => {
      const entry: QueuedEntry = {
        id,
        op,
        payload,
        createdAt,
        timeoutAtMs: options.timeoutAtMs,
        admission: options.admission,
        signal: options.signal,
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
      };
      let rejectQueuedAbort: (() => void) | undefined;
      if (options.signal) {
        rejectQueuedAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          entry.detachAbortListener?.();
          reject(new Error('internal-storage-worker-call-aborted-before-dispatch'));
        };
        const abortListener = rejectQueuedAbort;
        options.signal.addEventListener('abort', abortListener, { once: true });
        entry.detachAbortListener = () =>
          options.signal?.removeEventListener('abort', abortListener);
      }
      this.queue.push(entry);
      if (options.signal?.aborted) {
        rejectQueuedAbort?.();
      }
      this.processQueue();
    });
  }
}
