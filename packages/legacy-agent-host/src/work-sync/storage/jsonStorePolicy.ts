import { createHash } from 'node:crypto';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity.js';
import type {
  MemberWorkSyncStatus,
  MemberWorkSyncReportIntent,
  MemberWorkSyncMetricEvent,
  MemberWorkSyncStatusState,
  MemberWorkSyncOutboxItem,
} from '../policy/contracts/index.js';

export interface MetricsIndexMember {
  memberName: string;
  state: MemberWorkSyncStatusState;
  agendaFingerprint: string;
  actionableCount: number;
  evaluatedAt: string;
  providerId?: string;
}

export interface MetricsIndexFile {
  schemaVersion: 2;
  members: Record<string, MetricsIndexMember>;
  recentEvents: MemberWorkSyncMetricEvent[];
}

export interface MemberOutboxFile {
  schemaVersion: 2;
  items: Record<string, MemberWorkSyncOutboxItem>;
}

export interface OutboxIndexFile {
  schemaVersion: 2;
  items: Record<
    string,
    {
      memberKey: string;
      memberName: string;
      status: MemberWorkSyncOutboxItem['status'];
      nextAttemptAt?: string;
      updatedAt: string;
      createdAt: string;
    }
  >;
}

export type OutboxIndexRoute = OutboxIndexFile['items'][string];

export type OutboxDueRoute = [string, OutboxIndexRoute];

export const MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000;

export function normalizeTeamKey(teamName: unknown): string {
  return typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
}

export function emptyMetricsIndex(): MetricsIndexFile {
  return { schemaVersion: 2, members: {}, recentEvents: [] };
}

export function isMetricsIndexFile(value: unknown): value is MetricsIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MetricsIndexFile).schemaVersion === 2 &&
    (value as MetricsIndexFile).members != null &&
    typeof (value as MetricsIndexFile).members === 'object' &&
    Array.isArray((value as MetricsIndexFile).recentEvents)
  );
}

export function isMemberOutboxFile(value: unknown): value is MemberOutboxFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MemberOutboxFile).schemaVersion === 2 &&
    (value as MemberOutboxFile).items != null &&
    typeof (value as MemberOutboxFile).items === 'object' &&
    !Array.isArray((value as MemberOutboxFile).items)
  );
}

export function isOutboxIndexFile(value: unknown): value is OutboxIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as OutboxIndexFile).schemaVersion === 2 &&
    (value as OutboxIndexFile).items != null &&
    typeof (value as OutboxIndexFile).items === 'object' &&
    !Array.isArray((value as OutboxIndexFile).items)
  );
}

export function isOutboxTerminal(status: MemberWorkSyncOutboxItem['status']): boolean {
  return status === 'delivered' || status === 'superseded' || status === 'failed_terminal';
}

export function canReviveOutboxItem(status: MemberWorkSyncOutboxItem['status']): boolean {
  return status === 'superseded' || (!isOutboxTerminal(status) && status !== 'pending');
}

export function isOutboxItemOwnedBy(
  teamName: string,
  memberName: string,
  item: MemberWorkSyncOutboxItem
): boolean {
  return (
    normalizeTeamKey(item.teamName) === normalizeTeamKey(teamName) &&
    normalizeMemberKey(item.memberName) === normalizeMemberKey(memberName)
  );
}

export function parseIsoMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isStaleClaim(claimedAt: string | undefined, nowIso: string): boolean {
  const claimedAtMs = parseIsoMs(claimedAt);
  const nowMs = parseIsoMs(nowIso);
  return (
    claimedAtMs != null &&
    nowMs != null &&
    (claimedAtMs > nowMs || nowMs - claimedAtMs >= MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS)
  );
}

export function applyOptionalNextAttemptAt(
  item: MemberWorkSyncOutboxItem,
  nextAttemptAt: string | undefined
): void {
  if (nextAttemptAt) {
    item.nextAttemptAt = nextAttemptAt;
    return;
  }
  delete item.nextAttemptAt;
}

export function isNextAttemptDue(nextAttemptAt: string | undefined, nowIso: string): boolean {
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

export function canClaimOutboxItem(item: MemberWorkSyncOutboxItem, nowIso: string): boolean {
  if (item.status === 'claimed') {
    return isStaleClaim(item.claimedAt ?? item.updatedAt, nowIso);
  }
  if (item.status !== 'pending' && item.status !== 'failed_retryable') {
    return false;
  }
  return isNextAttemptDue(item.nextAttemptAt, nowIso);
}

export function canClaimOutboxRoute(route: OutboxIndexRoute, nowIso: string): boolean {
  if (route.status === 'claimed') {
    return isStaleClaim(route.updatedAt, nowIso);
  }
  return (
    (route.status === 'pending' || route.status === 'failed_retryable') &&
    isNextAttemptDue(route.nextAttemptAt, nowIso)
  );
}

export function getDueOutboxRoutes(
  index: OutboxIndexFile,
  nowIso: string,
  limit: number
): OutboxDueRoute[] {
  return Object.entries(index.items)
    .filter(([, route]) => canClaimOutboxRoute(route, nowIso))
    .sort((left, right) => {
      const leftTime = left[1].nextAttemptAt ?? left[1].updatedAt;
      const rightTime = right[1].nextAttemptAt ?? right[1].updatedAt;
      return leftTime.localeCompare(rightTime);
    })
    .slice(0, Math.max(0, limit));
}

export function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function buildMetricEventId(
  status: MemberWorkSyncStatus,
  kind: MemberWorkSyncMetricEvent['kind']
) {
  return `member-work-sync-metric:${createHash('sha256')
    .update(
      stableStringify({
        teamName: status.teamName,
        memberName: normalizeMemberKey(status.memberName),
        kind,
        state: status.state,
        agendaFingerprint: status.agenda.fingerprint,
        evaluatedAt: status.evaluatedAt,
        reportState: status.report?.state ?? '',
        rejectionCode: status.report?.rejectionCode ?? '',
      })
    )
    .digest('hex')}`;
}

export function buildMetricEvents(status: MemberWorkSyncStatus): MemberWorkSyncMetricEvent[] {
  const base = {
    teamName: status.teamName,
    memberName: status.memberName,
    state: status.state,
    agendaFingerprint: status.agenda.fingerprint,
    recordedAt: status.evaluatedAt,
    actionableCount: status.agenda.items.length,
    ...(status.providerId ? { providerId: status.providerId } : {}),
    ...(status.shadow?.previousFingerprint
      ? { previousFingerprint: status.shadow.previousFingerprint }
      : {}),
    ...(status.shadow?.triggerReasons?.length
      ? { triggerReasons: [...status.shadow.triggerReasons] }
      : {}),
    ...(status.report?.state ? { reportState: status.report.state } : {}),
    ...(status.report?.rejectionCode ? { rejectionCode: status.report.rejectionCode } : {}),
  };
  const events: MemberWorkSyncMetricEvent[] = [
    {
      ...base,
      id: buildMetricEventId(status, 'status_evaluated'),
      kind: 'status_evaluated',
    },
  ];
  if (status.shadow?.wouldNudge) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'would_nudge'),
      kind: 'would_nudge',
    });
  }
  if (status.shadow?.fingerprintChanged) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'fingerprint_changed'),
      kind: 'fingerprint_changed',
    });
  }
  const reportMutation = !status.shadow || status.shadow.reconciledBy === 'report';
  if (reportMutation && status.report?.accepted) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'report_accepted'),
      kind: 'report_accepted',
    });
  } else if (reportMutation && status.report?.rejectionCode) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'report_rejected'),
      kind: 'report_rejected',
    });
  }
  return events;
}

export function appendMetricEvents(file: MetricsIndexFile, status: MemberWorkSyncStatus): void {
  const byId = new Map(file.recentEvents.map((event) => [event.id, event]));
  for (const event of buildMetricEvents(status)) {
    byId.set(event.id, event);
  }
  file.recentEvents = [...byId.values()]
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
    .slice(-200);
}

export function updateMetricsMember(
  file: MetricsIndexFile,
  status: MemberWorkSyncStatus,
  memberKey: string
): void {
  file.members[memberKey] = {
    memberName: status.memberName,
    state: status.state,
    agendaFingerprint: status.agenda.fingerprint,
    actionableCount: status.agenda.items.length,
    evaluatedAt: status.evaluatedAt,
    ...(status.providerId ? { providerId: status.providerId } : {}),
  };
  appendMetricEvents(file, status);
}

export function toOutboxIndexItem(
  item: MemberWorkSyncOutboxItem,
  memberKey: string
): OutboxIndexFile['items'][string] {
  return {
    memberKey,
    memberName: item.memberName,
    status: item.status,
    ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
  };
}

export interface PendingReportsIndexFile {
  schemaVersion: 2;
  items: Record<
    string,
    {
      memberKey: string;
      memberName: string;
      status: MemberWorkSyncReportIntent['status'];
      recordedAt: string;
      processedAt?: string;
    }
  >;
}

export function isPendingReportsIndexFile(value: unknown): value is PendingReportsIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as PendingReportsIndexFile).schemaVersion === 2 &&
    (value as PendingReportsIndexFile).items != null &&
    typeof (value as PendingReportsIndexFile).items === 'object' &&
    !Array.isArray((value as PendingReportsIndexFile).items)
  );
}
