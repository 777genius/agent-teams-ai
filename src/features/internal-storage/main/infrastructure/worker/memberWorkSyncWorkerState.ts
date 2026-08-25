import { normalizeMemberWorkSyncTeamKey } from '../../../contracts/memberWorkSyncTeamIdentity';

import {
  memberWorkSyncMetricEvents,
  memberWorkSyncOutbox,
  memberWorkSyncReportIntents,
  memberWorkSyncStatus,
} from './internalStorageSchema';

import type { MemberWorkSyncOutboxItemRecord } from '../../../contracts/internalStorageContracts';

// Mirrors MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS in JsonMemberWorkSyncStore.
const CLAIM_STALE_MS = 5 * 60 * 1000;
const INSERT_CHUNK_SIZE = 200;
const OUTBOX_TERMINAL_STATUSES = ['delivered', 'superseded', 'failed_terminal'];

export const METRIC_EVENTS_CAP = 200;

export const STATUS_RECORD_SELECTION = {
  teamName: memberWorkSyncStatus.teamName,
  memberKey: memberWorkSyncStatus.memberKey,
  memberName: memberWorkSyncStatus.memberName,
  state: memberWorkSyncStatus.state,
  evaluatedAt: memberWorkSyncStatus.evaluatedAt,
  providerId: memberWorkSyncStatus.providerId,
  statusJson: memberWorkSyncStatus.statusJson,
};

export const REPORT_INTENT_RECORD_SELECTION = {
  teamName: memberWorkSyncReportIntents.teamName,
  id: memberWorkSyncReportIntents.id,
  memberKey: memberWorkSyncReportIntents.memberKey,
  memberName: memberWorkSyncReportIntents.memberName,
  status: memberWorkSyncReportIntents.status,
  reason: memberWorkSyncReportIntents.reason,
  recordedAt: memberWorkSyncReportIntents.recordedAt,
  processedAt: memberWorkSyncReportIntents.processedAt,
  resultCode: memberWorkSyncReportIntents.resultCode,
  requestJson: memberWorkSyncReportIntents.requestJson,
};

export const OUTBOX_ITEM_RECORD_SELECTION = {
  teamName: memberWorkSyncOutbox.teamName,
  id: memberWorkSyncOutbox.id,
  memberKey: memberWorkSyncOutbox.memberKey,
  memberName: memberWorkSyncOutbox.memberName,
  agendaFingerprint: memberWorkSyncOutbox.agendaFingerprint,
  payloadHash: memberWorkSyncOutbox.payloadHash,
  status: memberWorkSyncOutbox.status,
  attemptGeneration: memberWorkSyncOutbox.attemptGeneration,
  claimedBy: memberWorkSyncOutbox.claimedBy,
  claimedAt: memberWorkSyncOutbox.claimedAt,
  deliveredMessageId: memberWorkSyncOutbox.deliveredMessageId,
  deliveryState: memberWorkSyncOutbox.deliveryState,
  lastError: memberWorkSyncOutbox.lastError,
  nextAttemptAt: memberWorkSyncOutbox.nextAttemptAt,
  createdAt: memberWorkSyncOutbox.createdAt,
  updatedAt: memberWorkSyncOutbox.updatedAt,
  workSyncIntent: memberWorkSyncOutbox.workSyncIntent,
  workSyncIntentKey: memberWorkSyncOutbox.workSyncIntentKey,
  reviewRequestEventIdsJson: memberWorkSyncOutbox.reviewRequestEventIdsJson,
  deliveryDiagnosticsJson: memberWorkSyncOutbox.deliveryDiagnosticsJson,
  payloadJson: memberWorkSyncOutbox.payloadJson,
};

export const METRIC_EVENT_RECORD_SELECTION = {
  teamName: memberWorkSyncMetricEvents.teamName,
  id: memberWorkSyncMetricEvents.id,
  memberKey: memberWorkSyncMetricEvents.memberKey,
  memberName: memberWorkSyncMetricEvents.memberName,
  kind: memberWorkSyncMetricEvents.kind,
  recordedAt: memberWorkSyncMetricEvents.recordedAt,
  eventJson: memberWorkSyncMetricEvents.eventJson,
};

export function isOutboxTerminal(status: string): boolean {
  return OUTBOX_TERMINAL_STATUSES.includes(status);
}

// Mirrors canReviveOutboxItem: superseded | claimed | failed_retryable.
export function canRevive(status: string): boolean {
  return status === 'superseded' || (!isOutboxTerminal(status) && status !== 'pending');
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isStaleClaim(claimedAt: string | null, updatedAt: string, nowIso: string): boolean {
  const claimedAtMs = parseIsoMs(claimedAt ?? updatedAt);
  const nowMs = parseIsoMs(nowIso);
  return (
    claimedAtMs != null &&
    nowMs != null &&
    (claimedAtMs > nowMs || nowMs - claimedAtMs >= CLAIM_STALE_MS)
  );
}

function isNextAttemptDue(nextAttemptAt: string | null, nowIso: string): boolean {
  if (!nextAttemptAt) {
    return true;
  }
  const nextAttemptAtMs = parseIsoMs(nextAttemptAt);
  if (nextAttemptAtMs == null) {
    return true;
  }
  const nowMs = parseIsoMs(nowIso);
  return nowMs != null && nextAttemptAtMs <= nowMs;
}

export function canClaim(item: MemberWorkSyncOutboxItemRecord, nowIso: string): boolean {
  if (item.status === 'claimed') {
    return isStaleClaim(item.claimedAt, item.updatedAt, nowIso);
  }
  if (item.status !== 'pending' && item.status !== 'failed_retryable') {
    return false;
  }
  return isNextAttemptDue(item.nextAttemptAt, nowIso);
}

// Load-bearing guard: drizzle's .values([]) throws, while an empty import is valid.
export function chunked<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += INSERT_CHUNK_SIZE) {
    chunks.push(values.slice(start, start + INSERT_CHUNK_SIZE));
  }
  return chunks;
}

export function toPersistenceRow<T extends { teamName: string }>(row: T): T & { teamKey: string } {
  return { ...row, teamKey: normalizeMemberWorkSyncTeamKey(row.teamName) };
}
