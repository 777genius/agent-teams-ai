import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import type {
  CommentJournalEntryRecord,
  InternalStorageBackendInfo,
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxEnsureRecordInput,
  MemberWorkSyncOutboxEnsureRecordResult,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
  StallJournalEntryRecord,
} from '../../contracts/internalStorageContracts';
import type {
  ApplicationCommandLedgerStorageGateway,
  InternalStorageGateway,
  MemberWorkSyncStorageGateway,
} from '../../core/application/ports';
import type {
  InternalStorageWorkerData,
  InternalStorageWorkerRequest,
  InternalStorageWorkerResponse,
} from './worker/internalStorageWorkerProtocol';
import type {
  ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerFailRequest,
  ApplicationCommandLedgerListScopeRequest,
  ApplicationCommandLedgerReadByCommandIdRequest,
  ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerRecord,
} from '@features/application-command-ledger/contracts';

const logger = createLogger('Service:InternalStorageWorkerClient');

// Keeps per-op payload typing for the journal ops; mws.* ops share one wire
// shape and are typed by the public gateway methods instead.
type InternalStorageWorkerPayloadFor<TOp extends InternalStorageWorkerRequest['op']> =
  TOp extends `appCommandLedger.${string}` | `mws.${string}`
    ? unknown
    : Extract<InternalStorageWorkerRequest, { op: TOp }>['payload'];

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
export class InternalStorageWorkerClient
  implements InternalStorageGateway, MemberWorkSyncStorageGateway, ApplicationCommandLedgerStorageGateway
{
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

  async loadCommentJournalEntries(teamName: string): Promise<CommentJournalEntryRecord[]> {
    const result = await this.call('commentJournal.load', { teamName });
    return result as CommentJournalEntryRecord[];
  }

  async replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): Promise<void> {
    await this.call('commentJournal.replace', { teamName, entries });
  }

  async commentJournalExists(teamName: string): Promise<boolean> {
    const result = await this.call('commentJournal.exists', { teamName });
    return result === true;
  }

  async ensureCommentJournalInitialized(teamName: string): Promise<void> {
    await this.call('commentJournal.ensureInitialized', { teamName });
  }

  async recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void> {
    await this.call('storeImports.record', { storeId, teamName, entryCount });
  }

  async statusRead(
    teamName: string,
    memberKey: string
  ): Promise<MemberWorkSyncStatusRecord | null> {
    return (await this.call('mws.status.read', {
      teamName,
      memberKey,
    })) as MemberWorkSyncStatusRecord | null;
  }

  async statusWrite(
    record: MemberWorkSyncStatusRecord,
    events: MemberWorkSyncMetricEventRecord[]
  ): Promise<void> {
    await this.call('mws.status.write', { record, events });
  }

  async statusList(teamName: string): Promise<MemberWorkSyncStatusRecord[]> {
    return (await this.call('mws.status.list', { teamName })) as MemberWorkSyncStatusRecord[];
  }

  async metricEventsList(teamName: string): Promise<MemberWorkSyncMetricEventRecord[]> {
    return (await this.call('mws.metricEvents.list', {
      teamName,
    })) as MemberWorkSyncMetricEventRecord[];
  }

  async reportsAppend(record: MemberWorkSyncReportIntentRecord): Promise<void> {
    await this.call('mws.reports.append', { record });
  }

  async reportsListPending(teamName: string): Promise<MemberWorkSyncReportIntentRecord[]> {
    return (await this.call('mws.reports.listPending', {
      teamName,
    })) as MemberWorkSyncReportIntentRecord[];
  }

  async reportsMarkProcessed(
    teamName: string,
    id: string,
    result: { status: string; resultCode: string; processedAt: string }
  ): Promise<void> {
    await this.call('mws.reports.markProcessed', { teamName, id, ...result });
  }

  async outboxEnsurePending(
    input: MemberWorkSyncOutboxEnsureRecordInput
  ): Promise<MemberWorkSyncOutboxEnsureRecordResult> {
    return (await this.call(
      'mws.outbox.ensurePending',
      input
    )) as MemberWorkSyncOutboxEnsureRecordResult;
  }

  async outboxClaimDue(input: {
    teamName: string;
    claimedBy: string;
    nowIso: string;
    limit: number;
  }): Promise<MemberWorkSyncOutboxItemRecord[]> {
    return (await this.call('mws.outbox.claimDue', input)) as MemberWorkSyncOutboxItemRecord[];
  }

  async outboxMarkDelivered(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    deliveredMessageId: string;
    deliveryState: string | null;
    deliveryDiagnosticsJson: string | null;
    nowIso: string;
  }): Promise<void> {
    await this.call('mws.outbox.markDelivered', input);
  }

  async outboxMarkSuperseded(input: {
    teamName: string;
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<void> {
    await this.call('mws.outbox.markSuperseded', input);
  }

  async outboxMarkFailed(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    error: string;
    retryable: boolean;
    nextAttemptAt: string | null;
    nowIso: string;
  }): Promise<void> {
    await this.call('mws.outbox.markFailed', input);
  }

  async outboxCountRecentDelivered(input: {
    teamName: string;
    memberKey: string;
    sinceIso: string;
    workSyncIntentKeyPrefix: string | null;
  }): Promise<number> {
    return (await this.call('mws.outbox.countRecentDelivered', input)) as number;
  }

  async outboxCountDeliveredForAgenda(input: {
    teamName: string;
    memberKey: string;
    agendaFingerprint: string;
    sinceIso: string | null;
  }): Promise<number> {
    return (await this.call('mws.outbox.countDeliveredForAgenda', input)) as number;
  }

  async outboxFindDeliveredReviewPickupEventIds(input: {
    teamName: string;
    memberKey: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    return (await this.call('mws.outbox.findDeliveredReviewPickupEventIds', input)) as string[];
  }

  async outboxFindRecentRecoveryByIntent(input: {
    teamName: string;
    memberKey: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<MemberWorkSyncOutboxItemRecord | null> {
    return (await this.call(
      'mws.outbox.findRecentRecoveryByIntent',
      input
    )) as MemberWorkSyncOutboxItemRecord | null;
  }

  async listTeamSnapshot(teamName: string): Promise<MemberWorkSyncTeamSnapshotRecords> {
    return (await this.call('mws.snapshot.list', {
      teamName,
    })) as MemberWorkSyncTeamSnapshotRecords;
  }

  async importTeam(teamName: string, snapshot: MemberWorkSyncTeamSnapshotRecords): Promise<void> {
    await this.call('mws.importTeam', { teamName, snapshot });
  }

  async applicationCommandLedgerBegin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>> {
    return (await this.call(
      'appCommandLedger.begin',
      request
    )) as ApplicationCommandLedgerBeginResult<TOperation>;
  }

  async applicationCommandLedgerMarkCompleted(
    request: ApplicationCommandLedgerCompleteRequest
  ): Promise<void> {
    await this.call('appCommandLedger.markCompleted', request);
  }

  async applicationCommandLedgerMarkFailed(
    request: ApplicationCommandLedgerFailRequest
  ): Promise<void> {
    await this.call('appCommandLedger.markFailed', request);
  }

  async applicationCommandLedgerGetByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return (await this.call(
      'appCommandLedger.getByCommandId',
      request
    )) as ApplicationCommandLedgerRecord<TOperation> | null;
  }

  async applicationCommandLedgerGetByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return (await this.call(
      'appCommandLedger.getByIdempotencyKey',
      request
    )) as ApplicationCommandLedgerRecord<TOperation> | null;
  }

  async applicationCommandLedgerListByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]> {
    return (await this.call(
      'appCommandLedger.listByScope',
      request
    )) as ApplicationCommandLedgerRecord<TOperation>[];
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

  private call<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
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
