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
import type { ApplicationCommandLedgerStorageGateway } from '@features/application-command-ledger/core/application';
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
} from '@features/internal-storage/contracts/internalStorageContracts';
import type {
  InternalStorageGateway,
  MemberWorkSyncStorageGateway,
} from '@features/internal-storage/core/application/ports';
import type { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';

/** In-process gateway: same op handlers the worker uses, minus the thread hop. */
export class InProcessGateway
  implements
    InternalStorageGateway,
    MemberWorkSyncStorageGateway,
    ApplicationCommandLedgerStorageGateway
{
  constructor(private readonly core: InternalStorageWorkerCore) {}

  private op<T>(op: string, payload: unknown): Promise<T> {
    return Promise.resolve(this.core.handle(op as never, payload as never) as T);
  }

  statusRead(teamName: string, memberKey: string): Promise<MemberWorkSyncStatusRecord | null> {
    return this.op('mws.status.read', { teamName, memberKey });
  }

  statusWrite(
    record: MemberWorkSyncStatusRecord,
    events: MemberWorkSyncMetricEventRecord[]
  ): Promise<void> {
    return this.op('mws.status.write', { record, events });
  }

  statusList(teamName: string): Promise<MemberWorkSyncStatusRecord[]> {
    return this.op('mws.status.list', { teamName });
  }

  metricEventsList(teamName: string): Promise<MemberWorkSyncMetricEventRecord[]> {
    return this.op('mws.metricEvents.list', { teamName });
  }

  reportsAppend(record: MemberWorkSyncReportIntentRecord): Promise<void> {
    return this.op('mws.reports.append', { record });
  }

  reportsListPending(teamName: string): Promise<MemberWorkSyncReportIntentRecord[]> {
    return this.op('mws.reports.listPending', { teamName });
  }

  reportsMarkProcessed(
    teamName: string,
    id: string,
    result: { status: string; resultCode: string; processedAt: string }
  ): Promise<void> {
    return this.op('mws.reports.markProcessed', { teamName, id, ...result });
  }

  outboxEnsurePending(
    input: MemberWorkSyncOutboxEnsureRecordInput
  ): Promise<MemberWorkSyncOutboxEnsureRecordResult> {
    return this.op('mws.outbox.ensurePending', input);
  }

  outboxClaimDue(input: {
    teamName: string;
    claimedBy: string;
    nowIso: string;
    limit: number;
  }): Promise<MemberWorkSyncOutboxItemRecord[]> {
    return this.op('mws.outbox.claimDue', input);
  }

  outboxMarkDelivered(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    deliveredMessageId: string;
    deliveryState: string | null;
    deliveryDiagnosticsJson: string | null;
    nowIso: string;
  }): Promise<void> {
    return this.op('mws.outbox.markDelivered', input);
  }

  outboxMarkSuperseded(input: {
    teamName: string;
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<void> {
    return this.op('mws.outbox.markSuperseded', input);
  }

  outboxMarkFailed(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    error: string;
    retryable: boolean;
    nextAttemptAt: string | null;
    nowIso: string;
  }): Promise<void> {
    return this.op('mws.outbox.markFailed', input);
  }

  outboxCountRecentDelivered(input: {
    teamName: string;
    memberKey: string;
    sinceIso: string;
    workSyncIntentKeyPrefix: string | null;
  }): Promise<number> {
    return this.op('mws.outbox.countRecentDelivered', input);
  }

  outboxCountDeliveredForAgenda(input: {
    teamName: string;
    memberKey: string;
    agendaFingerprint: string;
    sinceIso: string | null;
  }): Promise<number> {
    return this.op('mws.outbox.countDeliveredForAgenda', input);
  }

  outboxFindDeliveredReviewPickupEventIds(input: {
    teamName: string;
    memberKey: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    return this.op('mws.outbox.findDeliveredReviewPickupEventIds', input);
  }

  outboxFindRecentRecoveryByIntent(input: {
    teamName: string;
    memberKey: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<MemberWorkSyncOutboxItemRecord | null> {
    return this.op('mws.outbox.findRecentRecoveryByIntent', input);
  }

  listTeamSnapshot(teamName: string): Promise<MemberWorkSyncTeamSnapshotRecords> {
    return this.op('mws.snapshot.list', { teamName });
  }

  importTeam(teamName: string, snapshot: MemberWorkSyncTeamSnapshotRecords): Promise<void> {
    return this.op('mws.importTeam', { teamName, snapshot });
  }

  applicationCommandLedgerBegin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>> {
    return this.op('appCommandLedger.begin', request);
  }

  applicationCommandLedgerMarkCompleted(
    request: ApplicationCommandLedgerCompleteRequest
  ): Promise<void> {
    return this.op('appCommandLedger.markCompleted', request);
  }

  applicationCommandLedgerMarkFailed(request: ApplicationCommandLedgerFailRequest): Promise<void> {
    return this.op('appCommandLedger.markFailed', request);
  }

  applicationCommandLedgerGetByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return this.op('appCommandLedger.getByCommandId', request);
  }

  applicationCommandLedgerGetByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return this.op('appCommandLedger.getByIdempotencyKey', request);
  }

  applicationCommandLedgerListByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]> {
    return this.op('appCommandLedger.listByScope', request);
  }

  ping(): Promise<InternalStorageBackendInfo> {
    return Promise.resolve(this.core.handle('ping', {}) as InternalStorageBackendInfo);
  }

  loadStallJournalEntries(teamName: string): Promise<StallJournalEntryRecord[]> {
    return Promise.resolve(
      this.core.handle('stallJournal.load', { teamName }) as StallJournalEntryRecord[]
    );
  }

  replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): Promise<void> {
    this.core.handle('stallJournal.replace', { teamName, entries });
    return Promise.resolve();
  }

  loadCommentJournalEntries(teamName: string): Promise<CommentJournalEntryRecord[]> {
    return Promise.resolve(
      this.core.handle('commentJournal.load', { teamName }) as CommentJournalEntryRecord[]
    );
  }

  replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): Promise<void> {
    this.core.handle('commentJournal.replace', { teamName, entries });
    return Promise.resolve();
  }

  commentJournalExists(teamName: string): Promise<boolean> {
    return Promise.resolve(this.core.handle('commentJournal.exists', { teamName }) === true);
  }

  ensureCommentJournalInitialized(teamName: string): Promise<void> {
    this.core.handle('commentJournal.ensureInitialized', { teamName });
    return Promise.resolve();
  }

  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void> {
    this.core.handle('storeImports.record', { storeId, teamName, entryCount });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.core.close();
    return Promise.resolve();
  }
}
