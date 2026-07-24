import { Worker } from 'node:worker_threads';

import { createLogger } from '@shared/utils/logger';

import {
  MAX_TEAM_IDENTITY_READ_RECORDS,
  parseTeamIdentityRecord,
} from '../../contracts/teamIdentityStorageContracts';
import {
  parseTeamRosterSnapshotRecord,
  type TeamRosterAdoptRecordResult,
  type TeamRosterSnapshotRecord,
  type TeamRosterStorageGateway,
} from '../../contracts/teamRosterStorageContracts';

import {
  type ApplicationCommandLedgerWorkerPayloadByOp,
  type CoordinationDrainStorageEvidence,
  type InternalStorageWorkerData,
  type InternalStorageWorkerRequest,
  type InternalStorageWorkerResponse,
  parseInternalStorageWorkerResponseForPending,
  type ProcessOwnershipWorkerPayloadByOp,
  type SqliteBackupChunkStorageResult,
  type SqliteOnlineBackupStorageResult,
  type SqliteSnapshotVerificationStorageResult,
  type StoredCoordinationEventRow,
  type StoredEventJournalMetadata,
  type StoredSnapshotRetentionLease,
  type StoredSnapshotRetentionLeaseUse,
} from './worker/internalStorageWorkerProtocol';
import {
  getInternalStorageWorkerPathCandidates,
  resolveInternalStorageWorkerPath,
} from './internalStorageWorkerPath';
import {
  isProcessOwnershipStorageCallAdmitted,
  type ProcessOwnershipStorageCallContext,
  ProcessOwnershipStorageGatewayClient,
} from './ProcessOwnershipStorageGateway';

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
  TeamIdentityReadGateway,
  TeamIdentityRecord,
} from '../../contracts/teamIdentityStorageContracts';
import type {
  InternalStorageGateway,
  MemberWorkSyncStorageGateway,
} from '../../core/application/ports';
import type { CoordinationDurabilityStorageGateway } from './CoordinationDurabilityStorageGateway';
import type {
  ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerFailRequest,
  ApplicationCommandLedgerListScopeRequest,
  ApplicationCommandLedgerReadByCommandIdRequest,
  ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStorageGateway,
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandClaimResult,
  DurableApplicationCommandClaimStatusRequest,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerApplyResult,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandEffectTransitionRequest,
  DurableApplicationCommandLedgerStorageGateway,
  DurableApplicationCommandOutboxClaimRequest,
  DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  DurableApplicationCommandOutboxListRequest,
  DurableApplicationCommandOutboxRecord,
  DurableApplicationCommandPersistClaimRequest,
  DurableApplicationCommandRecord,
  DurableApplicationCommandStatusRequest,
  DurableApplicationCommandTransitionRequest,
} from '@features/application-command-ledger';
import type {
  BackupFenceCompletionDisposition,
  BackupRunRecord,
  BackupRunState,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotRequest } from '@features/coordination-events';
import type {
  CoordinationEventDraft,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';
import type { TeamId } from '@shared/contracts/hosted';

const logger = createLogger('Service:InternalStorageWorkerClient');

// Keeps per-op payload typing for the journal ops; mws.* ops share one wire
// shape and are typed by the public gateway methods instead.
type InternalStorageWorkerPayloadFor<TOp extends InternalStorageWorkerRequest['op']> =
  TOp extends keyof ApplicationCommandLedgerWorkerPayloadByOp
    ? ApplicationCommandLedgerWorkerPayloadByOp[TOp]
    : TOp extends `appCommandLedger.${string}` | `mws.${string}`
      ? unknown
      : Extract<InternalStorageWorkerRequest, { op: TOp }>['payload'];

const WORKER_CALL_TIMEOUT_MS = 20_000;

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
}
function makeId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Async facade over the internal-storage worker thread. Requests run one at a
 * time (SQLite access is serialized anyway); a timeout or worker crash rejects
 * all in-flight requests and the worker is recreated on the next call.
 */
export class InternalStorageWorkerClient
  extends ProcessOwnershipStorageGatewayClient
  implements
    InternalStorageGateway,
    MemberWorkSyncStorageGateway,
    ApplicationCommandLedgerStorageGateway,
    DurableApplicationCommandLedgerStorageGateway,
    TeamIdentityReadGateway,
    TeamRosterStorageGateway,
    CoordinationDurabilityStorageGateway
{
  private worker: Worker | null = null;
  private readonly workerPath: string | null = resolveInternalStorageWorkerPath();
  private pending = new Map<string, PendingEntry>();
  private queue: QueuedEntry[] = [];
  private activeCallId: string | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(private readonly options: { databasePath: string }) {
    super();
  }
  isAvailable(): boolean {
    return this.workerPath !== null;
  }
  getWorkerPathCandidatesForDiagnostics(): string[] {
    return getInternalStorageWorkerPathCandidates();
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
  async hasStoreImport(storeId: string, teamName: string): Promise<boolean> {
    return (await this.call('storeImports.has', { storeId, teamName })) === true;
  }
  async listTeamIdentities(): Promise<readonly TeamIdentityRecord[]> {
    const value = await this.call('teamIdentity.list', {});
    if (!Array.isArray(value) || value.length > MAX_TEAM_IDENTITY_READ_RECORDS) {
      throw new TypeError('team-identity-list-invalid');
    }
    const identities: TeamIdentityRecord[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError('team-identity-list-invalid');
      identities.push(parseTeamIdentityRecord(value[index]));
    }
    return Object.freeze(identities);
  }
  async getTeamIdentity(teamId: TeamId): Promise<TeamIdentityRecord | null> {
    const value = await this.call('teamIdentity.get', { teamId });
    return value === null ? null : parseTeamIdentityRecord(value);
  }
  async getTeamRoster(teamId: TeamId): Promise<TeamRosterSnapshotRecord | null> {
    const value = await this.call('teamRoster.get', { teamId });
    return value === null ? null : parseTeamRosterSnapshotRecord(value);
  }
  async adoptTeamRoster(record: TeamRosterSnapshotRecord): Promise<TeamRosterAdoptRecordResult> {
    const roster = parseTeamRosterSnapshotRecord(record);
    const value = await this.call('teamRoster.adopt', { roster });
    if (
      typeof value !== 'object' ||
      value === null ||
      ((value as { outcome?: unknown }).outcome !== 'created' &&
        (value as { outcome?: unknown }).outcome !== 'existing')
    ) {
      throw new TypeError('team-roster-storage-adopt-result-invalid');
    }
    const result = value as { outcome: 'created' | 'existing'; roster?: unknown };
    return {
      outcome: result.outcome,
      roster: parseTeamRosterSnapshotRecord(result.roster),
    };
  }
  protected callProcessOwnershipWorker<TOp extends keyof ProcessOwnershipWorkerPayloadByOp>(
    op: TOp,
    payload: ProcessOwnershipWorkerPayloadByOp[TOp],
    context: ProcessOwnershipStorageCallContext
  ): Promise<unknown> {
    return this.call(op, payload as InternalStorageWorkerPayloadFor<TOp>, {
      admission: context,
    });
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

  async applicationCommandLedgerDurableClaim<TCommandKind extends string>(
    request: DurableApplicationCommandPersistClaimRequest<TCommandKind>
  ): Promise<DurableApplicationCommandClaimResult<TCommandKind>> {
    return (await this.call(
      'appCommandLedger.durable.claim',
      request
    )) as DurableApplicationCommandClaimResult<TCommandKind>;
  }

  async applicationCommandLedgerDurableGetStatus<TCommandKind extends string>(
    request: DurableApplicationCommandStatusRequest
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null> {
    return (await this.call(
      'appCommandLedger.durable.getStatus',
      request
    )) as DurableApplicationCommandRecord<TCommandKind> | null;
  }

  async applicationCommandLedgerDurableGetByClaim<TCommandKind extends string>(
    request: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null> {
    return (await this.call(
      'appCommandLedger.durable.getByClaim',
      request
    )) as DurableApplicationCommandRecord<TCommandKind> | null;
  }

  async applicationCommandLedgerDurableRenewAttemptLease(
    request: DurableApplicationCommandAttemptLeaseRequest
  ): Promise<DurableApplicationCommandRecord> {
    return (await this.call(
      'appCommandLedger.durable.renewAttemptLease',
      request
    )) as DurableApplicationCommandRecord;
  }

  async applicationCommandLedgerDurableTransitionCommand(
    request: DurableApplicationCommandTransitionRequest
  ): Promise<DurableApplicationCommandRecord> {
    return (await this.call(
      'appCommandLedger.durable.transitionCommand',
      request
    )) as DurableApplicationCommandRecord;
  }

  async applicationCommandLedgerDurableTransitionEffect(
    request: DurableApplicationCommandEffectTransitionRequest
  ): Promise<DurableApplicationCommandRecord> {
    return (await this.call(
      'appCommandLedger.durable.transitionEffect',
      request
    )) as DurableApplicationCommandRecord;
  }

  async applicationCommandLedgerDurableCommit(
    request: DurableApplicationCommandCommitRequest
  ): Promise<DurableApplicationCommandRecord> {
    return (await this.call(
      'appCommandLedger.durable.commit',
      request
    )) as DurableApplicationCommandRecord;
  }

  async applicationCommandLedgerDurableListOutbox(
    request: DurableApplicationCommandOutboxListRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]> {
    return (await this.call(
      'appCommandLedger.durable.listOutbox',
      request
    )) as DurableApplicationCommandOutboxRecord[];
  }

  async applicationCommandLedgerDurableClaimOutbox(
    request: DurableApplicationCommandOutboxClaimRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]> {
    return (await this.call(
      'appCommandLedger.durable.claimOutbox',
      request
    )) as DurableApplicationCommandOutboxRecord[];
  }

  async applicationCommandLedgerDurableAcknowledgeOutboxDelivery(
    request: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): Promise<void> {
    await this.call('appCommandLedger.durable.acknowledgeOutboxDelivery', request);
  }

  async applicationCommandLedgerDurableApplyConsumerEvent(
    request: DurableApplicationCommandConsumerApplyRequest
  ): Promise<DurableApplicationCommandConsumerApplyResult> {
    return (await this.call(
      'appCommandLedger.durable.applyConsumerEvent',
      request
    )) as DurableApplicationCommandConsumerApplyResult;
  }

  async applicationCommandLedgerDurableGetConsumerProjection(
    request: DurableApplicationCommandConsumerProjectionRequest
  ): Promise<DurableApplicationCommandConsumerProjectionRecord | null> {
    return (await this.call(
      'appCommandLedger.durable.getConsumerProjection',
      request
    )) as DurableApplicationCommandConsumerProjectionRecord | null;
  }

  async coordinationEventInitialize(input: {
    readonly deploymentId: string;
    readonly eventEpoch?: string;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata> {
    return (await this.call('coordinationEvents.initialize', input)) as StoredEventJournalMetadata;
  }

  async coordinationEventGetWatermark(deploymentId: string): Promise<StoredEventJournalMetadata> {
    return (await this.call('coordinationEvents.getWatermark', {
      deploymentId,
    })) as StoredEventJournalMetadata;
  }

  async coordinationEventRead(input: {
    readonly deploymentId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<{
    readonly rows: readonly StoredCoordinationEventRow[];
    readonly watermark: StoredEventJournalMetadata;
  }> {
    return (await this.call('coordinationEvents.read', input)) as {
      readonly rows: readonly StoredCoordinationEventRow[];
      readonly watermark: StoredEventJournalMetadata;
    };
  }

  async coordinationEventAppend(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly draft: CoordinationEventDraft<CoordinationJsonValue>;
    readonly bodyJson: string;
    readonly nowIso: string;
  }): Promise<{
    readonly row: StoredCoordinationEventRow;
    readonly watermark: StoredEventJournalMetadata;
  }> {
    return (await this.call('coordinationEvents.append', input)) as {
      readonly row: StoredCoordinationEventRow;
      readonly watermark: StoredEventJournalMetadata;
    };
  }

  async coordinationEventPrune(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly throughSequence: number;
    readonly nowMs: number;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata> {
    return (await this.call('coordinationEvents.prune', input)) as StoredEventJournalMetadata;
  }

  async coordinationEventAcquireLease(input: {
    readonly deploymentId: string;
    readonly leaseId: string;
    readonly request: CoordinationSnapshotRequest;
    readonly nowMs: number;
    readonly deadlineAtMs: number;
  }): Promise<StoredSnapshotRetentionLease> {
    return (await this.call(
      'coordinationEvents.lease.acquire',
      input
    )) as StoredSnapshotRetentionLease;
  }

  async coordinationEventBeginLeaseUse(input: {
    readonly leaseId: string;
    readonly useToken: string;
    readonly nowMs: number;
  }): Promise<StoredSnapshotRetentionLeaseUse> {
    return (await this.call(
      'coordinationEvents.lease.beginUse',
      input
    )) as StoredSnapshotRetentionLeaseUse;
  }

  async coordinationEventEndLeaseUse(input: {
    readonly leaseId: string;
    readonly useToken: string;
  }): Promise<void> {
    await this.call('coordinationEvents.lease.endUse', input);
  }

  async coordinationEventReleaseLease(leaseId: string): Promise<void> {
    await this.call('coordinationEvents.lease.release', { leaseId });
  }

  async coordinationBackupRunCreate(record: BackupRunRecord): Promise<BackupRunRecord> {
    return (await this.call('coordinationBackupRuns.create', { record })) as BackupRunRecord;
  }

  async coordinationBackupRunGet(backupRunId: string): Promise<BackupRunRecord | null> {
    return (await this.call('coordinationBackupRuns.get', {
      backupRunId,
    })) as BackupRunRecord | null;
  }

  async coordinationBackupRunListRecoverable(): Promise<readonly BackupRunRecord[]> {
    return (await this.call(
      'coordinationBackupRuns.listRecoverable',
      {}
    )) as readonly BackupRunRecord[];
  }

  async coordinationBackupRunCompareAndSet(input: {
    readonly backupRunId: string;
    readonly expectedRevision: number;
    readonly expectedState: BackupRunState;
    readonly record: BackupRunRecord;
  }): Promise<BackupRunRecord> {
    return (await this.call('coordinationBackupRuns.compareAndSet', input)) as BackupRunRecord;
  }

  async coordinationBackupFenceAcquire(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly expectedGeneration: number | null;
    readonly leaseId: string;
    readonly acquiredAt: string;
  }): Promise<
    | { readonly status: 'acquired'; readonly generation: number; readonly leaseId: string }
    | { readonly status: 'busy'; readonly activeRunId: string }
  > {
    return (await this.call('coordinationBackupFence.acquire', input)) as
      | { readonly status: 'acquired'; readonly generation: number; readonly leaseId: string }
      | { readonly status: 'busy'; readonly activeRunId: string };
  }

  async coordinationBackupFenceComplete(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly disposition: BackupFenceCompletionDisposition;
    readonly completedAt: string;
  }): Promise<void> {
    await this.call('coordinationBackupFence.complete', input);
  }

  async coordinationBackupDrain(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }): Promise<CoordinationDrainStorageEvidence> {
    return (await this.call(
      'coordinationBackupFlush.drain',
      input
    )) as CoordinationDrainStorageEvidence;
  }

  async coordinationBackupCapture(input: {
    readonly deploymentId: string;
    readonly evidence: CoordinationDrainStorageEvidence;
  }): Promise<CoordinationDrainStorageEvidence> {
    return (await this.call(
      'coordinationBackupFlush.capture',
      input
    )) as CoordinationDrainStorageEvidence;
  }

  async coordinationBackupSqliteOnline(input: {
    readonly backupRunId: string;
    readonly deadlineAtMs: number;
    readonly busyRetryMs: number;
    readonly pagesPerStep: number;
  }): Promise<SqliteOnlineBackupStorageResult> {
    return (await this.call('coordinationBackup.sqlite.online', input, {
      timeoutAtMs: input.deadlineAtMs + 2_000,
    })) as SqliteOnlineBackupStorageResult;
  }

  async coordinationBackupSqliteVerify(input: {
    readonly backupRunId: string;
  }): Promise<SqliteSnapshotVerificationStorageResult> {
    return (await this.call(
      'coordinationBackup.sqlite.verify',
      input
    )) as SqliteSnapshotVerificationStorageResult;
  }

  async coordinationBackupSqliteReadChunk(input: {
    readonly backupRunId: string;
    readonly offset: number;
    readonly maximumBytes: number;
  }): Promise<SqliteBackupChunkStorageResult> {
    return (await this.call(
      'coordinationBackup.sqlite.readChunk',
      input
    )) as SqliteBackupChunkStorageResult;
  }

  async coordinationBackupSqliteDiscard(backupRunId: string): Promise<void> {
    await this.call('coordinationBackup.sqlite.discard', { backupRunId });
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
    worker.on('message', (value: unknown) => {
      let msg: InternalStorageWorkerResponse;
      try {
        msg = parseInternalStorageWorkerResponseForPending(value, (id) => this.pending.get(id)?.op);
      } catch (error) {
        this.failWorker(worker, error instanceof Error ? error : new Error(String(error)));
        void worker.terminate().catch(() => undefined);
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
    if (!isProcessOwnershipStorageCallAdmitted(entry.admission)) {
      entry.reject(new Error('process-ownership-storage-call-admission-expired'));
      this.processQueue();
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
    const dispatchedAt = Date.now();
    let timeoutMs =
      entry.timeoutAtMs === undefined
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
      // The worker may be stuck in native IO; terminate and recreate lazily.
      // SQLite's journal makes a mid-transaction kill safe (auto-rollback).
      void worker.terminate().catch(() => undefined);
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

  private call<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options: {
      allowWhenClosed?: boolean;
      timeoutAtMs?: number;
      admission?: ProcessOwnershipStorageCallContext;
    } = {}
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
        timeoutAtMs: options.timeoutAtMs,
        admission: options.admission,
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
