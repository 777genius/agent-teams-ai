import { decodeMemberWorkSyncReportJournalMetadata } from './MemberWorkSyncReportJournalMetadata';

import type { MemberWorkSyncReportJournalMetadata } from '../../contracts';

interface Scope {
  teamName: string;
  memberName?: string;
  incarnation?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** Validate raw ownership and outcome before any routing normalization can hide corruption. */
export function validateMemberWorkSyncReportJournalRow(
  value: unknown,
  expected?: Scope
): MemberWorkSyncReportJournalMetadata | undefined {
  if (!object(value)) throw new Error('Invalid report journal row');
  if (value.journal === undefined) return undefined;
  if (
    typeof value.id !== 'string' ||
    value.id?.trim() !== value.id ||
    !key(value.teamName) ||
    !key(value.memberName) ||
    !object(value.request) ||
    key(value.request.teamName) !== key(value.teamName) ||
    key(value.request.memberName) !== key(value.memberName) ||
    (expected && key(value.teamName) !== key(expected.teamName)) ||
    (expected?.memberName !== undefined && key(value.memberName) !== key(expected.memberName))
  )
    throw new Error('Conflicting report journal row identity');
  const metadata = decodeMemberWorkSyncReportJournalMetadata(value.journal, value.id);
  if (expected?.incarnation !== undefined && metadata.incarnation !== expected.incarnation)
    throw new Error('Conflicting report journal incarnation');
  if (metadata.receipt) {
    if (
      value.status !== 'accepted' ||
      value.resultCode !== 'accepted' ||
      value.processedAt !== metadata.receipt.acceptedAt
    )
      throw new Error('Report journal receipt disagrees with processed outcome');
  } else if (value.status !== 'pending' || value.resultCode != null || value.processedAt != null) {
    throw new Error('Report journal outcome requires a receipt');
  }
  return metadata;
}
