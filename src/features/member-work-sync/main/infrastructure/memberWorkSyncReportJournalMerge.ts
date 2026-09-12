import { isDeepStrictEqual } from 'node:util';

import { normalizeMemberWorkSyncTeamKey } from '@features/internal-storage/contracts/memberWorkSyncTeamIdentity';

import { validateMemberWorkSyncReportJournalRow } from '../../core/domain/MemberWorkSyncReportJournalRow';

import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

interface JournalMergeRow {
  id: string;
  teamName: string;
  memberName: string;
  request: unknown;
  journal?: unknown;
  status: string;
  resultCode?: string | null;
  processedAt?: string | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizedRequest(row: JournalMergeRow): Record<string, unknown> {
  const teamName = normalizeMemberWorkSyncTeamKey(row.teamName);
  const memberName = normalizeMemberKey(row.memberName);
  if (
    !object(row.request) ||
    !teamName ||
    !memberName ||
    normalizeMemberWorkSyncTeamKey(row.request.teamName) !== teamName ||
    normalizeMemberKey(row.request.memberName) !== memberName
  ) {
    throw new Error('Conflicting report journal request identity');
  }
  return { ...row.request, teamName, memberName };
}

/** null delegates unchanged legacy/compatible timestamp policy to the caller. */
export function chooseMemberWorkSyncReportJournalMerge(
  canonical: JournalMergeRow,
  incoming: JournalMergeRow
): 'canonical' | 'incoming' | null {
  if (canonical.journal === undefined && incoming.journal === undefined) return null;
  if (
    canonical.journal === undefined ||
    incoming.journal === undefined ||
    canonical.id !== incoming.id ||
    normalizeMemberWorkSyncTeamKey(canonical.teamName) !==
      normalizeMemberWorkSyncTeamKey(incoming.teamName) ||
    normalizeMemberKey(canonical.memberName) !== normalizeMemberKey(incoming.memberName)
  ) {
    throw new Error('Conflicting bound and unbound report journal identity');
  }
  const left = validateMemberWorkSyncReportJournalRow(canonical)!;
  const right = validateMemberWorkSyncReportJournalRow(incoming)!;
  const { receipt: leftReceipt, ...leftBinding } = left;
  const { receipt: rightReceipt, ...rightBinding } = right;
  if (
    !isDeepStrictEqual(leftBinding, rightBinding) ||
    !isDeepStrictEqual(normalizedRequest(canonical), normalizedRequest(incoming))
  ) {
    throw new Error('Conflicting immutable report journal binding');
  }
  if (leftReceipt && rightReceipt && !isDeepStrictEqual(leftReceipt, rightReceipt)) {
    throw new Error('Conflicting report journal receipts');
  }
  if (leftReceipt || rightReceipt) return rightReceipt && !leftReceipt ? 'incoming' : 'canonical';
  return null;
}
