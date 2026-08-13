import { parseTeamId, type TeamId, type WorkspaceId } from '@shared/contracts/hosted';

import {
  type ExternalWriterIdentityInventoryCapture,
  MAX_TEAM_IDENTITY_READ_RECORDS,
  parseIdentityTimestamp,
  parseTeamIdentityChecksum,
  parseTeamIdentityRecord,
} from '../../contracts/teamIdentityStorageContracts';
import {
  parseTeamRosterSnapshotRecord,
  type TeamRosterAdoptRecordResult,
  type TeamRosterSnapshotRecord,
  type TeamRosterStorageGateway,
} from '../../contracts/teamRosterStorageContracts';
import {
  parseHostedAuthorityProjectionCommitResult,
  parseHostedAuthorityProjectionRecord,
} from '../application/hostedAuthorityProjectionStorage';

import {
  type HostedTeamConfigurationWorkerPayloadByOp,
  type InternalStorageWorkerRequest,
  type ProcessOwnershipWorkerPayloadByOp,
} from './worker/internalStorageWorkerProtocol';
import { CoordinationDurabilityStorageGatewayClient } from './CoordinationDurabilityStorageGatewayClient';
import { HostedTeamStorageWorkerClient } from './HostedTeamStorageWorkerClient';
import { resolveInternalStorageWorkerPath } from './internalStorageWorkerPath';
import {
  type InternalStorageWorkerCallOptions,
  type InternalStorageWorkerPayloadFor,
  InternalStorageWorkerTransport,
} from './InternalStorageWorkerTransport';

import type {
  ExternalWriterCleanHandoffConsumeRequest,
  ExternalWriterCleanHandoffSaveRequest,
  ExternalWriterObservationCheckpointIdentity,
  ExternalWriterObservationCheckpointRecord,
  ExternalWriterObservationCheckpointSaveRequest,
  ExternalWriterObservationCheckpointStorageGateway,
} from '../../contracts/externalWriterObservationStorageContracts';
import type {
  HostedAuthStorageGateway,
  HostedAuthStorageOperation,
} from '../../contracts/hostedAuthStorageContracts';
import type {
  HostedTeamApprovalAuthorityStorageGateway,
  HostedTeamApprovalDecisionStorageRequest,
  HostedTeamApprovalDecisionStorageResult,
  HostedTeamApprovalDeliveryAcknowledgeRequest,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingReadRequest,
  HostedTeamApprovalPendingReadResult,
  HostedTeamApprovalPendingStorageRecord,
  HostedTeamApprovalPreviewReadRequest,
  HostedTeamApprovalPreviewReadResult,
  HostedTeamApprovalTimeoutAuditRequest,
  HostedTeamApprovalTimeoutAuditResult,
} from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type {
  HostedTeamConfigurationStorageCreateRequest,
  HostedTeamConfigurationStorageCreateResult,
  HostedTeamConfigurationStorageDeleteRequest,
  HostedTeamConfigurationStorageDeleteResult,
  HostedTeamConfigurationStorageGateway,
  HostedTeamConfigurationStorageMutationOptions,
  HostedTeamConfigurationStorageReadResult,
  HostedTeamConfigurationStorageUpdateRequest,
  HostedTeamConfigurationStorageUpdateResult,
} from '../../contracts/hostedTeamConfigurationStorageContracts';
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
import type { CoordinationDurabilityStorageGateway } from '../application/coordinationDurabilityStorage';
import type { ProcessOwnershipStorageCallContext } from '../application/processOwnershipStorage';
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
  HostedAuthorityProjectionCommitResult,
  HostedAuthorityProjectionPersistRequest,
  HostedAuthorityProjectionReadRequest,
  HostedAuthorityProjectionRecord,
} from '@features/application-command-ledger';

/**
 * Async facade over the internal-storage worker thread. Requests run one at a
 * time (SQLite access is serialized anyway); a timeout or worker crash rejects
 * all in-flight requests and the worker is recreated on the next call.
 */
export class InternalStorageWorkerClient
  extends CoordinationDurabilityStorageGatewayClient
  implements
    InternalStorageGateway,
    MemberWorkSyncStorageGateway,
    ApplicationCommandLedgerStorageGateway,
    DurableApplicationCommandLedgerStorageGateway,
    TeamIdentityReadGateway,
    TeamRosterStorageGateway,
    CoordinationDurabilityStorageGateway,
    HostedAuthStorageGateway,
    HostedTeamApprovalAuthorityStorageGateway,
    HostedTeamConfigurationStorageGateway,
    ExternalWriterObservationCheckpointStorageGateway
{
  private readonly workerPath: string | null = resolveInternalStorageWorkerPath();
  private readonly transport: InternalStorageWorkerTransport;
  private readonly hostedTeamStorage: HostedTeamStorageWorkerClient;

  constructor(options: { databasePath: string }) {
    super();
    this.transport = new InternalStorageWorkerTransport(options, () => this.workerPath);
    this.hostedTeamStorage = new HostedTeamStorageWorkerClient(
      (op, payload, callOptions) => this.call(op, payload, callOptions),
      (op, payload, callOptions) => this.callHostedTeamConfiguration(op, payload, callOptions)
    );
  }
  isAvailable(): boolean {
    return this.transport.isAvailable();
  }
  getWorkerPathCandidatesForDiagnostics(): string[] {
    return this.transport.getWorkerPathCandidatesForDiagnostics();
  }
  async ping(): Promise<InternalStorageBackendInfo> {
    const result = await this.call('ping', {});
    return result as InternalStorageBackendInfo;
  }
  async hostedAuthCall(operation: HostedAuthStorageOperation, payload: unknown): Promise<unknown> {
    return this.call('hostedAuth.call', { operation, payload });
  }

  async loadExternalWriterObservationCheckpoint(
    identity: ExternalWriterObservationCheckpointIdentity
  ): Promise<ExternalWriterObservationCheckpointRecord | null> {
    return (await this.call('externalWriterObservation.load', identity)) as
      | ExternalWriterObservationCheckpointRecord
      | null;
  }

  async saveExternalWriterObservationCheckpoint(
    request: ExternalWriterObservationCheckpointSaveRequest
  ): Promise<ExternalWriterObservationCheckpointRecord> {
    return (await this.call(
      'externalWriterObservation.save',
      request
    )) as ExternalWriterObservationCheckpointRecord;
  }
  async saveExternalWriterCleanHandoffEligibility(
    request: ExternalWriterCleanHandoffSaveRequest
  ): Promise<ExternalWriterObservationCheckpointRecord> {
    return (await this.call('externalWriterObservation.saveCleanHandoff', request)) as ExternalWriterObservationCheckpointRecord;
  }
  async consumeExternalWriterCleanHandoffEligibility(
    request: ExternalWriterCleanHandoffConsumeRequest
  ): Promise<ExternalWriterObservationCheckpointRecord | null> {
    return (await this.call('externalWriterObservation.consumeCleanHandoff', request)) as ExternalWriterObservationCheckpointRecord | null;
  }
  async callHostedTeamConfiguration<TOp extends keyof HostedTeamConfigurationWorkerPayloadByOp>(
    op: TOp,
    payload: HostedTeamConfigurationWorkerPayloadByOp[TOp],
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    return this.hostedTeamStorage.callHostedTeamConfiguration(op, payload, options);
  }
  async createHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageCreateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageCreateResult> {
    return this.hostedTeamStorage.createHostedTeamConfiguration(request, options);
  }
  async readHostedTeamConfiguration(input: {
    readonly workspaceId: WorkspaceId;
    readonly teamId: TeamId;
  }): Promise<HostedTeamConfigurationStorageReadResult> {
    return this.hostedTeamStorage.readHostedTeamConfiguration(input);
  }
  async updateHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageUpdateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageUpdateResult> {
    return this.hostedTeamStorage.updateHostedTeamConfiguration(request, options);
  }
  async deleteHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageDeleteRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageDeleteResult> {
    return this.hostedTeamStorage.deleteHostedTeamConfiguration(request, options);
  }
  async hostedTeamApprovalObserve(
    record: HostedTeamApprovalPendingStorageRecord
  ): Promise<HostedTeamApprovalPendingReadRecord> {
    return this.hostedTeamStorage.hostedTeamApprovalObserve(record);
  }
  async hostedTeamApprovalReadPending(
    request: HostedTeamApprovalPendingReadRequest
  ): Promise<HostedTeamApprovalPendingReadResult> {
    return this.hostedTeamStorage.hostedTeamApprovalReadPending(request);
  }
  async hostedTeamApprovalReadPreview(
    request: HostedTeamApprovalPreviewReadRequest
  ): Promise<HostedTeamApprovalPreviewReadResult> {
    return this.hostedTeamStorage.hostedTeamApprovalReadPreview(request);
  }
  async hostedTeamApprovalDecide(
    request: HostedTeamApprovalDecisionStorageRequest
  ): Promise<HostedTeamApprovalDecisionStorageResult> {
    return this.hostedTeamStorage.hostedTeamApprovalDecide(request);
  }
  async hostedTeamApprovalClaimDeliveries(
    request: HostedTeamApprovalDeliveryClaimRequest
  ): Promise<readonly HostedTeamApprovalDeliveryRecord[]> {
    return this.hostedTeamStorage.hostedTeamApprovalClaimDeliveries(request);
  }
  async hostedTeamApprovalAcknowledgeDelivery(
    request: HostedTeamApprovalDeliveryAcknowledgeRequest
  ): Promise<void> {
    await this.hostedTeamStorage.hostedTeamApprovalAcknowledgeDelivery(request);
  }

  async hostedTeamApprovalAuditTimeouts(
    request: HostedTeamApprovalTimeoutAuditRequest
  ): Promise<HostedTeamApprovalTimeoutAuditResult> {
    return this.hostedTeamStorage.hostedTeamApprovalAuditTimeouts(request);
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
    return this.parseIdentityList(value);
  }
  async listActiveTeamIdentities(): Promise<readonly TeamIdentityRecord[]> {
    const value = await this.call('teamIdentity.listActive', {});
    return this.parseIdentityList(value);
  }
  async captureExternalWriterTeamIdentities(
    request: { readonly retirementCandidates: readonly TeamId[] }
  ): Promise<ExternalWriterIdentityInventoryCapture> {
    const value = await this.call('teamIdentity.captureExternalWriterInventory', {
      retirementCandidates: request.retirementCandidates,
    });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('external-writer-inventory-capture-invalid');
    }
    const record = value as Record<string, unknown>;
    if (
      Reflect.ownKeys(record).length !== 2 ||
      !Object.hasOwn(record, 'active') ||
      !Object.hasOwn(record, 'retiredCandidates') ||
      !Array.isArray(record.retiredCandidates) ||
      record.retiredCandidates.length > 1_024
    ) {
      throw new TypeError('external-writer-inventory-capture-invalid');
    }
    const active = this.parseIdentityList(record.active);
    const retiredCandidates = record.retiredCandidates.map((proof) => {
      if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) {
        throw new TypeError('external-writer-inventory-capture-invalid');
      }
      const candidate = proof as Record<string, unknown>;
      if (
        Reflect.ownKeys(candidate).length !== 3 ||
        !Object.hasOwn(candidate, 'teamId') ||
        !Object.hasOwn(candidate, 'identityChecksum') ||
        !Object.hasOwn(candidate, 'tombstonedAt')
      ) {
        throw new TypeError('external-writer-inventory-capture-invalid');
      }
      const identity = active.find((entry) => entry.teamId === candidate.teamId);
      if (identity) throw new TypeError('external-writer-inventory-capture-invalid');
      return Object.freeze({
        teamId: parseTeamId(candidate.teamId),
        identityChecksum: parseTeamIdentityChecksum(candidate.identityChecksum),
        tombstonedAt: parseIdentityTimestamp(candidate.tombstonedAt),
      });
    });
    return Object.freeze({ active, retiredCandidates: Object.freeze(retiredCandidates) });
  }
  private parseIdentityList(value: unknown): readonly TeamIdentityRecord[] {
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

  async applicationCommandLedgerHostedAuthorityProjectionCommit<TCommandKind extends string>(
    request: HostedAuthorityProjectionPersistRequest<TCommandKind>
  ): Promise<HostedAuthorityProjectionCommitResult> {
    return parseHostedAuthorityProjectionCommitResult(
      await this.call('appCommandLedger.hostedAuthorityProjection.commit', request, {
        timeoutAtMs: request.deadlineAtMs,
      })
    );
  }

  async applicationCommandLedgerHostedAuthorityProjectionGet(
    request: HostedAuthorityProjectionReadRequest
  ): Promise<HostedAuthorityProjectionRecord | null> {
    const result = await this.call('appCommandLedger.hostedAuthorityProjection.get', request, {
      timeoutAtMs: request.deadlineAtMs,
    });
    return result === null ? null : parseHostedAuthorityProjectionRecord(result);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  protected callCoordinationWorker<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    return this.transport.call(op, payload, options);
  }

  private call<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    return this.transport.call(op, payload, options);
  }
}
