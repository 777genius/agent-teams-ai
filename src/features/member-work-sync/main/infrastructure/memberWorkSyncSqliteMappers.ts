import { buildMetricEvents, normalizeMemberKey } from './JsonMemberWorkSyncStore';

import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxStatus,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from '@features/internal-storage/contracts/internalStorageContracts';

export function statusToRecord(status: MemberWorkSyncStatus): MemberWorkSyncStatusRecord {
  return {
    teamName: status.teamName,
    memberKey: normalizeMemberKey(status.memberName),
    memberName: status.memberName,
    state: status.state,
    evaluatedAt: status.evaluatedAt,
    providerId: status.providerId ?? null,
    statusJson: JSON.stringify(status),
  };
}

export function recordToStatus(record: MemberWorkSyncStatusRecord): MemberWorkSyncStatus {
  return JSON.parse(record.statusJson) as MemberWorkSyncStatus;
}

export function metricEventToRecord(
  event: MemberWorkSyncMetricEvent
): MemberWorkSyncMetricEventRecord {
  return {
    teamName: event.teamName,
    id: event.id,
    memberKey: normalizeMemberKey(event.memberName),
    memberName: event.memberName,
    kind: event.kind,
    recordedAt: event.recordedAt,
    eventJson: JSON.stringify(event),
  };
}

export function recordToMetricEvent(
  record: MemberWorkSyncMetricEventRecord
): MemberWorkSyncMetricEvent {
  return JSON.parse(record.eventJson) as MemberWorkSyncMetricEvent;
}

export function statusToMetricEventRecords(
  status: MemberWorkSyncStatus
): MemberWorkSyncMetricEventRecord[] {
  return buildMetricEvents(status).map(metricEventToRecord);
}

export function reportIntentToRecord(
  intent: MemberWorkSyncReportIntent
): MemberWorkSyncReportIntentRecord {
  return {
    teamName: intent.teamName,
    id: intent.id,
    memberKey: normalizeMemberKey(intent.memberName),
    memberName: intent.memberName,
    status: intent.status,
    reason: intent.reason,
    recordedAt: intent.recordedAt,
    processedAt: intent.processedAt ?? null,
    resultCode: intent.resultCode ?? null,
    requestJson: JSON.stringify(intent.request),
  };
}

export function recordToReportIntent(
  record: MemberWorkSyncReportIntentRecord
): MemberWorkSyncReportIntent {
  return {
    id: record.id,
    teamName: record.teamName,
    memberName: record.memberName,
    request: JSON.parse(record.requestJson) as MemberWorkSyncReportIntent['request'],
    reason: record.reason,
    status: record.status as MemberWorkSyncReportIntentStatus,
    recordedAt: record.recordedAt,
    ...(record.processedAt ? { processedAt: record.processedAt } : {}),
    ...(record.resultCode ? { resultCode: record.resultCode } : {}),
  };
}

export function outboxItemToRecord(item: MemberWorkSyncOutboxItem): MemberWorkSyncOutboxItemRecord {
  return {
    teamName: item.teamName,
    id: item.id,
    memberKey: normalizeMemberKey(item.memberName),
    memberName: item.memberName,
    agendaFingerprint: item.agendaFingerprint,
    payloadHash: item.payloadHash,
    status: item.status,
    attemptGeneration: item.attemptGeneration,
    claimedBy: item.claimedBy ?? null,
    claimedAt: item.claimedAt ?? null,
    deliveredMessageId: item.deliveredMessageId ?? null,
    deliveryState: item.deliveryState ?? null,
    lastError: item.lastError ?? null,
    nextAttemptAt: item.nextAttemptAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    workSyncIntent: item.payload.workSyncIntent,
    workSyncIntentKey: item.payload.workSyncIntentKey ?? null,
    reviewRequestEventIdsJson: item.payload.workSyncReviewRequestEventIds
      ? JSON.stringify(item.payload.workSyncReviewRequestEventIds)
      : null,
    deliveryDiagnosticsJson: item.deliveryDiagnostics
      ? JSON.stringify(item.deliveryDiagnostics)
      : null,
    payloadJson: JSON.stringify(item.payload),
  };
}

export function recordToOutboxItem(
  record: MemberWorkSyncOutboxItemRecord
): MemberWorkSyncOutboxItem {
  return {
    id: record.id,
    teamName: record.teamName,
    memberName: record.memberName,
    agendaFingerprint: record.agendaFingerprint,
    payloadHash: record.payloadHash,
    payload: JSON.parse(record.payloadJson) as MemberWorkSyncOutboxItem['payload'],
    status: record.status as MemberWorkSyncOutboxStatus,
    attemptGeneration: record.attemptGeneration,
    ...(record.claimedBy ? { claimedBy: record.claimedBy } : {}),
    ...(record.claimedAt ? { claimedAt: record.claimedAt } : {}),
    ...(record.deliveredMessageId ? { deliveredMessageId: record.deliveredMessageId } : {}),
    ...(record.deliveryState
      ? { deliveryState: record.deliveryState as MemberWorkSyncOutboxItem['deliveryState'] }
      : {}),
    ...(record.deliveryDiagnosticsJson
      ? { deliveryDiagnostics: JSON.parse(record.deliveryDiagnosticsJson) as string[] }
      : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function snapshotToRecords(
  snapshot: MemberWorkSyncStoreSnapshot
): MemberWorkSyncTeamSnapshotRecords {
  return {
    statuses: snapshot.statuses.map(statusToRecord),
    reportIntents: snapshot.reportIntents.map(reportIntentToRecord),
    outboxItems: snapshot.outboxItems.map(outboxItemToRecord),
    metricEvents: snapshot.metricEvents.map(metricEventToRecord),
  };
}

function sortByKey<T>(records: T[], key: (record: T) => string): T[] {
  return [...records].sort((left, right) => key(left).localeCompare(key(right)));
}

// Key-order-independent stringify: mapper objects and drizzle rows carry the
// same fields in different property order.
function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * Order-insensitive equality used to verify the JSON -> SQLite import before
 * the legacy files are archived. Compares full record content.
 */
export function areSnapshotRecordSetsEquivalent(
  left: MemberWorkSyncTeamSnapshotRecords,
  right: MemberWorkSyncTeamSnapshotRecords
): boolean {
  const canonical = (snapshot: MemberWorkSyncTeamSnapshotRecords): string =>
    stableStringify({
      statuses: sortByKey(snapshot.statuses, (record) => record.memberKey),
      reportIntents: sortByKey(snapshot.reportIntents, (record) => record.id),
      outboxItems: sortByKey(snapshot.outboxItems, (record) => record.id),
      metricEvents: sortByKey(snapshot.metricEvents, (record) => record.id),
    });
  return canonical(left) === canonical(right);
}
