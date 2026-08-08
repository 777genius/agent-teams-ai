import { normalizeMemberWorkSyncSnapshotTeamIdentity } from '@features/internal-storage/contracts';

import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from '@features/internal-storage/contracts/internalStorageContracts';

const PROCESSED_REPORT_STATUSES = new Set(['accepted', 'rejected', 'superseded']);
const METRIC_EVENTS_CAP = 200;

export function mergeMemberWorkSyncSnapshots(
  teamName: string,
  canonical: MemberWorkSyncTeamSnapshotRecords,
  incoming: MemberWorkSyncTeamSnapshotRecords
): MemberWorkSyncTeamSnapshotRecords {
  const normalizedCanonical = normalizeMemberWorkSyncSnapshotTeamIdentity(teamName, canonical);
  const normalizedIncoming = normalizeMemberWorkSyncSnapshotTeamIdentity(teamName, incoming);
  return {
    statuses: mergeByIdentity(
      normalizedCanonical.statuses,
      normalizedIncoming.statuses,
      (row) => row.memberKey,
      pickStatus
    ),
    reportIntents: mergeByIdentity(
      normalizedCanonical.reportIntents,
      normalizedIncoming.reportIntents,
      (row) => row.id,
      pickReportIntent
    ),
    outboxItems: mergeByIdentity(
      normalizedCanonical.outboxItems,
      normalizedIncoming.outboxItems,
      (row) => row.id,
      pickOutboxItem
    ),
    metricEvents: mergeMetricEvents(
      normalizedCanonical.metricEvents,
      normalizedIncoming.metricEvents
    ),
  };
}

function mergeByIdentity<T>(
  canonical: readonly T[],
  incoming: readonly T[],
  identity: (record: T) => string,
  pick: (canonical: T, incoming: T) => T
): T[] {
  const merged = new Map<string, T>();
  for (const record of canonical) {
    const key = identity(record);
    const current = merged.get(key);
    merged.set(key, current ? pick(current, record) : record);
  }
  for (const record of incoming) {
    const key = identity(record);
    const current = merged.get(key);
    merged.set(key, current ? pick(current, record) : record);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record);
}

function pickStatus(
  canonical: MemberWorkSyncStatusRecord,
  incoming: MemberWorkSyncStatusRecord
): MemberWorkSyncStatusRecord {
  const comparison = compareIso(incoming.evaluatedAt, canonical.evaluatedAt);
  return comparison > 0 || comparison === 0 ? incoming : canonical;
}

function pickReportIntent(
  canonical: MemberWorkSyncReportIntentRecord,
  incoming: MemberWorkSyncReportIntentRecord
): MemberWorkSyncReportIntentRecord {
  const canonicalProcessed = PROCESSED_REPORT_STATUSES.has(canonical.status);
  const incomingProcessed = PROCESSED_REPORT_STATUSES.has(incoming.status);
  if (canonicalProcessed !== incomingProcessed) {
    return incomingProcessed ? incoming : canonical;
  }
  if (canonicalProcessed) {
    return compareIso(incoming.processedAt, canonical.processedAt) > 0 ? incoming : canonical;
  }
  return compareIso(incoming.recordedAt, canonical.recordedAt) >= 0 ? incoming : canonical;
}

function pickOutboxItem(
  canonical: MemberWorkSyncOutboxItemRecord,
  incoming: MemberWorkSyncOutboxItemRecord
): MemberWorkSyncOutboxItemRecord {
  const canonicalProof = outboxProofRank(canonical.status);
  const incomingProof = outboxProofRank(incoming.status);
  if (canonicalProof !== incomingProof && (canonicalProof > 0 || incomingProof > 0)) {
    return incomingProof > canonicalProof ? incoming : canonical;
  }
  if (canonical.attemptGeneration !== incoming.attemptGeneration) {
    return incoming.attemptGeneration > canonical.attemptGeneration ? incoming : canonical;
  }
  return compareIso(incoming.updatedAt, canonical.updatedAt) >= 0 ? incoming : canonical;
}

function outboxProofRank(status: string): number {
  if (status === 'delivered') return 2;
  if (status === 'failed_terminal') return 1;
  return 0;
}

function mergeMetricEvents(
  canonical: readonly MemberWorkSyncMetricEventRecord[],
  incoming: readonly MemberWorkSyncMetricEventRecord[]
): MemberWorkSyncMetricEventRecord[] {
  const union = mergeByIdentity(
    canonical,
    incoming,
    (row) => row.id,
    (_current, next) => next
  );
  return union
    .toSorted((left, right) => {
      const byTime = compareIso(left.recordedAt, right.recordedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    })
    .slice(-METRIC_EVENTS_CAP);
}

/** Invalid timestamps lose to valid timestamps; equal timestamps compare as equal. */
function compareIso(left: string | null | undefined, right: string | null | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  if (!leftValid || leftMs === rightMs) return 0;
  return leftMs < rightMs ? -1 : 1;
}
