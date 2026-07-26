import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncOutboxItem, MemberWorkSyncReportIntent } from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';

export function mergeDomainSnapshots(
  canonical: MemberWorkSyncStoreSnapshot,
  incoming: MemberWorkSyncStoreSnapshot | null
): MemberWorkSyncStoreSnapshot {
  if (!incoming) return { ...canonical, filesToArchive: [] };
  return {
    statuses: mergeDomainRows(
      canonical.statuses,
      incoming.statuses,
      (row) => normalizeMemberKey(row.memberName),
      (left, right) => (compareReplicaIso(right.evaluatedAt, left.evaluatedAt) >= 0 ? right : left)
    ),
    reportIntents: mergeDomainRows(
      canonical.reportIntents,
      incoming.reportIntents,
      (row) => row.id,
      pickDomainReportIntent
    ),
    outboxItems: mergeDomainRows(
      canonical.outboxItems,
      incoming.outboxItems,
      (row) => row.id,
      pickDomainOutboxItem
    ),
    metricEvents: mergeDomainRows(
      canonical.metricEvents,
      incoming.metricEvents,
      (row) => row.id,
      (_left, right) => right
    ),
    filesToArchive: [],
  };
}

function mergeDomainRows<T>(
  canonical: readonly T[],
  incoming: readonly T[],
  identity: (record: T) => string,
  pick: (canonical: T, incoming: T) => T
): T[] {
  const merged = new Map<string, T>();
  for (const record of canonical) merged.set(identity(record), record);
  for (const record of incoming) {
    const key = identity(record);
    const current = merged.get(key);
    merged.set(key, current ? pick(current, record) : record);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record);
}

export function pickDomainReportIntent(
  canonical: MemberWorkSyncReportIntent,
  incoming: MemberWorkSyncReportIntent
): MemberWorkSyncReportIntent {
  const isProcessed = (status: MemberWorkSyncReportIntent['status']): boolean =>
    status !== 'pending';
  const canonicalProcessed = isProcessed(canonical.status);
  const incomingProcessed = isProcessed(incoming.status);
  if (canonicalProcessed !== incomingProcessed) return incomingProcessed ? incoming : canonical;
  const leftTime = canonicalProcessed ? canonical.processedAt : canonical.recordedAt;
  const rightTime = incomingProcessed ? incoming.processedAt : incoming.recordedAt;
  return compareReplicaIso(rightTime, leftTime) >= 0 ? incoming : canonical;
}

export function pickDomainOutboxItem(
  canonical: MemberWorkSyncOutboxItem,
  incoming: MemberWorkSyncOutboxItem
): MemberWorkSyncOutboxItem {
  const proofRank = (status: MemberWorkSyncOutboxItem['status']): number =>
    status === 'delivered' ? 2 : status === 'failed_terminal' ? 1 : 0;
  const canonicalProof = proofRank(canonical.status);
  const incomingProof = proofRank(incoming.status);
  if (canonicalProof !== incomingProof && (canonicalProof > 0 || incomingProof > 0)) {
    return incomingProof > canonicalProof ? incoming : canonical;
  }
  if (canonical.attemptGeneration !== incoming.attemptGeneration) {
    return incoming.attemptGeneration > canonical.attemptGeneration ? incoming : canonical;
  }
  return compareReplicaIso(incoming.updatedAt, canonical.updatedAt) >= 0 ? incoming : canonical;
}

function compareReplicaIso(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  if (!leftValid || leftMs === rightMs) return 0;
  return leftMs < rightMs ? -1 : 1;
}
