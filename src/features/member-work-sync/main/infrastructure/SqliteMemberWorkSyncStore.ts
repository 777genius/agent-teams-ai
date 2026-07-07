import { KeyedMutex } from '@features/internal-storage/main';

import { normalizeMemberKey, toMetrics } from './JsonMemberWorkSyncStore';
import {
  outboxItemToRecord,
  recordToMetricEvent,
  recordToOutboxItem,
  recordToReportIntent,
  recordToStatus,
  reportIntentToRecord,
  statusToMetricEventRecords,
  statusToRecord,
} from './memberWorkSyncSqliteMappers';

import type {
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncOutboxStorePort,
  MemberWorkSyncReportStorePort,
  MemberWorkSyncStatusStorePort,
} from '../../core/application/ports';
import type { MetricsIndexFile } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncSqliteImporter } from './MemberWorkSyncSqliteImporter';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';

export interface SqliteMemberWorkSyncStoreDeps {
  gateway: MemberWorkSyncStorageGateway;
  importer: MemberWorkSyncSqliteImporter;
  now?(): Date;
  /** Mirrors the JSON store's buildPendingReportIntentId. */
  buildReportIntentId(request: MemberWorkSyncReportRequest): string;
}

/**
 * SQLite-backed member-work-sync persistence, implementing the same three
 * ports as JsonMemberWorkSyncStore. All state-machine semantics live in the
 * worker ops (single transaction per mutation); this class maps domain
 * objects to wire records and runs the lazy legacy import per team.
 */
export class SqliteMemberWorkSyncStore
  implements
    MemberWorkSyncStatusStorePort,
    MemberWorkSyncReportStorePort,
    MemberWorkSyncOutboxStorePort
{
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;

  constructor(private readonly deps: SqliteMemberWorkSyncStoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async ready(teamName: string): Promise<void> {
    await this.mutex.run(teamName, () => this.deps.importer.ensureImported(teamName));
  }

  async read(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncStatus | null> {
    await this.ready(input.teamName);
    const record = await this.deps.gateway.statusRead(
      input.teamName,
      normalizeMemberKey(input.memberName)
    );
    return record ? recordToStatus(record) : null;
  }

  async write(status: MemberWorkSyncStatus): Promise<void> {
    await this.ready(status.teamName);
    await this.deps.gateway.statusWrite(statusToRecord(status), statusToMetricEventRecords(status));
  }

  async readTeamMetrics(teamName: string): Promise<MemberWorkSyncTeamMetrics> {
    await this.ready(teamName);
    const [statusRecords, eventRecords] = await Promise.all([
      this.deps.gateway.statusList(teamName),
      this.deps.gateway.metricEventsList(teamName),
    ]);
    // Reuses the JSON store's aggregation for exact metric parity.
    const file: MetricsIndexFile = { schemaVersion: 2, members: {}, recentEvents: [] };
    for (const record of statusRecords) {
      const status = recordToStatus(record);
      file.members[record.memberKey] = {
        memberName: status.memberName,
        state: status.state,
        agendaFingerprint: status.agenda.fingerprint,
        actionableCount: status.agenda.items.length,
        evaluatedAt: status.evaluatedAt,
        ...(status.providerId ? { providerId: status.providerId } : {}),
      };
    }
    file.recentEvents = eventRecords.map(recordToMetricEvent);
    return toMetrics(teamName, file);
  }

  async appendPendingReport(request: MemberWorkSyncReportRequest, reason: string): Promise<void> {
    await this.ready(request.teamName);
    const intent: MemberWorkSyncReportIntent = {
      id: this.deps.buildReportIntentId(request),
      teamName: request.teamName,
      memberName: request.memberName,
      request,
      reason,
      status: 'pending',
      recordedAt: this.now().toISOString(),
    };
    await this.deps.gateway.reportsAppend(reportIntentToRecord(intent));
  }

  async listPendingReports(teamName: string): Promise<MemberWorkSyncReportIntent[]> {
    await this.ready(teamName);
    const records = await this.deps.gateway.reportsListPending(teamName);
    return records.map(recordToReportIntent);
  }

  async markPendingReportProcessed(
    teamName: string,
    id: string,
    result: { status: MemberWorkSyncReportIntentStatus; resultCode: string; processedAt: string }
  ): Promise<void> {
    await this.ready(teamName);
    await this.deps.gateway.reportsMarkProcessed(teamName, id, result);
  }

  async ensurePending(
    input: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncOutboxEnsureResult> {
    await this.ready(input.teamName);
    const record = outboxItemToRecord({
      id: input.id,
      teamName: input.teamName,
      memberName: input.memberName,
      agendaFingerprint: input.agendaFingerprint,
      payloadHash: input.payloadHash,
      payload: input.payload,
      status: 'pending',
      attemptGeneration: 0,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    });
    const result = await this.deps.gateway.outboxEnsurePending({
      record,
      nowIso: input.nowIso,
      nextAttemptAt: input.nextAttemptAt ?? null,
    });
    if (result.ok) {
      return { ok: true, outcome: result.outcome, item: recordToOutboxItem(result.item) };
    }
    return {
      ok: false,
      outcome: 'payload_conflict',
      item: recordToOutboxItem(result.item),
      existingPayloadHash: result.existingPayloadHash,
      requestedPayloadHash: result.requestedPayloadHash,
    };
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    await this.ready(input.teamName);
    const records = await this.deps.gateway.outboxClaimDue(input);
    return records.map(recordToOutboxItem);
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    await this.ready(input.teamName);
    await this.deps.gateway.outboxMarkDelivered({
      teamName: input.teamName,
      id: input.id,
      attemptGeneration: input.attemptGeneration,
      deliveredMessageId: input.deliveredMessageId,
      deliveryState: input.deliveryState ?? null,
      deliveryDiagnosticsJson: input.deliveryDiagnostics?.length
        ? JSON.stringify(input.deliveryDiagnostics)
        : null,
      nowIso: input.nowIso,
    });
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    await this.ready(input.teamName);
    await this.deps.gateway.outboxMarkSuperseded({
      teamName: input.teamName,
      id: input.id,
      reason: input.reason,
      nowIso: input.nowIso,
    });
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    await this.ready(input.teamName);
    await this.deps.gateway.outboxMarkFailed({
      teamName: input.teamName,
      id: input.id,
      attemptGeneration: input.attemptGeneration,
      error: input.error,
      retryable: input.retryable,
      nextAttemptAt: input.retryable ? (input.nextAttemptAt ?? null) : null,
      nowIso: input.nowIso,
    });
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<number> {
    await this.ready(input.teamName);
    return this.deps.gateway.outboxCountRecentDelivered({
      teamName: input.teamName,
      memberKey: normalizeMemberKey(input.memberName),
      sinceIso: input.sinceIso,
      workSyncIntentKeyPrefix: input.workSyncIntentKeyPrefix?.trim() || null,
    });
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    await this.ready(input.teamName);
    const agendaFingerprint = input.agendaFingerprint.trim();
    if (!agendaFingerprint) {
      return 0;
    }
    return this.deps.gateway.outboxCountDeliveredForAgenda({
      teamName: input.teamName,
      memberKey: normalizeMemberKey(input.memberName),
      agendaFingerprint,
      sinceIso: input.sinceIso?.trim() || null,
    });
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    await this.ready(input.teamName);
    return this.deps.gateway.outboxFindDeliveredReviewPickupEventIds({
      teamName: input.teamName,
      memberKey: normalizeMemberKey(input.memberName),
      reviewRequestEventIds: input.reviewRequestEventIds,
    });
  }

  async findRecentRecoveryByIntent(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null> {
    const intentKey = input.intentKey.trim();
    if (!intentKey) {
      return null;
    }
    await this.ready(input.teamName);
    const record = await this.deps.gateway.outboxFindRecentRecoveryByIntent({
      teamName: input.teamName,
      memberKey: normalizeMemberKey(input.memberName),
      intentKey,
      sinceIso: input.sinceIso,
    });
    if (!record) {
      return null;
    }
    const item = recordToOutboxItem(record);
    return {
      id: item.id,
      status: item.status,
      ...(item.deliveredMessageId ? { deliveredMessageId: item.deliveredMessageId } : {}),
      payloadHash: item.payloadHash,
      updatedAt: item.updatedAt,
    };
  }
}
