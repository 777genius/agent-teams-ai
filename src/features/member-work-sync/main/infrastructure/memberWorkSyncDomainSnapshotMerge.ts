import { validateMemberWorkSyncReportJournalRow } from '../../core/domain/MemberWorkSyncReportJournalRow';
import {
  chooseMemberWorkSyncStatusRevision,
  readMemberWorkSyncStatusRevision,
} from '../../core/domain/MemberWorkSyncStatusRevision';

import { chooseMemberWorkSyncReportJournalMerge } from './memberWorkSyncReportJournalMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type {
  MemberWorkSyncOutboxItem,
  MemberWorkSyncReportIntent,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';

export function mergeDomainSnapshots(
  canonical: MemberWorkSyncStoreSnapshot,
  incoming: MemberWorkSyncStoreSnapshot | null
): MemberWorkSyncStoreSnapshot {
  for (const row of [...canonical.statuses, ...(incoming?.statuses ?? [])]) {
    readMemberWorkSyncStatusRevision(row);
  }
  for (const row of [...canonical.reportIntents, ...(incoming?.reportIntents ?? [])])
    validateMemberWorkSyncReportJournalRow(row);
  return {
    statuses: mergeDomainRows(
      canonical.statuses,
      incoming?.statuses ?? [],
      (row) => normalizeMemberKey(row.memberName),
      (left, right) => {
        const revision = chooseImportRevision(left, right);
        if (revision) return revision === 'incoming' ? right : left;
        return compareReplicaIso(right.evaluatedAt, left.evaluatedAt) >= 0 ? right : left;
      }
    ),
    reportIntents: mergeDomainRows(
      canonical.reportIntents,
      incoming?.reportIntents ?? [],
      (row) => row.id,
      pickDomainReportIntent
    ),
    outboxItems: mergeDomainRows(
      canonical.outboxItems,
      incoming?.outboxItems ?? [],
      (row) => row.id,
      pickDomainOutboxItem
    ),
    metricEvents: mergeDomainRows(
      canonical.metricEvents,
      incoming?.metricEvents ?? [],
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

export function pickDomainReportIntent(
  canonical: MemberWorkSyncReportIntent,
  incoming: MemberWorkSyncReportIntent
): MemberWorkSyncReportIntent {
  const journalChoice = chooseMemberWorkSyncReportJournalMerge(canonical, incoming);
  if (journalChoice) return journalChoice === 'incoming' ? incoming : canonical;
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

/** Fold raw import sources before any file-format precedence can discard revision evidence. */
export function mergeImportedStatus(
  statuses: Map<string, MemberWorkSyncStatus>,
  key: string,
  candidate: MemberWorkSyncStatus,
  preferExistingLegacy = false
): void {
  readMemberWorkSyncStatusRevision(candidate);
  const current = statuses.get(key);
  if (!current) {
    statuses.set(key, candidate);
    return;
  }
  const choice = chooseImportRevision(current, candidate);
  if (choice === 'incoming' || (choice === null && !preferExistingLegacy)) {
    statuses.set(key, candidate);
  }
}

function chooseImportRevision(current: MemberWorkSyncStatus, candidate: MemberWorkSyncStatus) {
  const normalize = (status: MemberWorkSyncStatus): MemberWorkSyncStatus => {
    const teamName = status.teamName.trim().toLowerCase();
    const sameTeam = (name: unknown): boolean =>
      typeof name === 'string' && name.trim().toLowerCase() === teamName;
    if (
      !teamName ||
      !sameTeam(status.agenda?.teamName) ||
      (status.report && !sameTeam(status.report.teamName)) ||
      (status.lastAcceptedReport && !sameTeam(status.lastAcceptedReport.teamName))
    ) {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
    return {
      ...status,
      teamName,
      agenda: { ...status.agenda, teamName },
      ...(status.report ? { report: { ...status.report, teamName } } : {}),
      ...(status.lastAcceptedReport
        ? { lastAcceptedReport: { ...status.lastAcceptedReport, teamName } }
        : {}),
    };
  };
  // Only comparison copies change spelling. The winner/raw token retains its original payload.
  return chooseMemberWorkSyncStatusRevision(normalize(current), normalize(candidate));
}
