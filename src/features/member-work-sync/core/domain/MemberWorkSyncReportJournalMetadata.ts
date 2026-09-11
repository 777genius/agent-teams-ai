import { readMemberWorkSyncReportReceipt } from './MemberWorkSyncReportReceipt';
import { readMemberWorkSyncStatusRevision } from './MemberWorkSyncStatusRevision';

import type {
  MemberWorkSyncReportJournalMetadata,
  MemberWorkSyncReportReceipt,
} from '../../contracts';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;

/** Shared JSON/SQLite decoder. Throws on malformed or mismatched immutable metadata. */
export function decodeMemberWorkSyncReportJournalMetadata(
  value: unknown,
  intentId: string
): MemberWorkSyncReportJournalMetadata {
  if (
    !record(value) ||
    !identifier(value.incarnation) ||
    !identifier(value.requestDigest) ||
    typeof value.firstRecordedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.firstRecordedAt)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.firstRecordedAt) ||
    (value.origin !== 'online' && value.origin !== 'fallback')
  )
    throw new Error('Invalid report journal metadata');
  let receipt: MemberWorkSyncReportReceipt | undefined;
  if (value.receipt !== undefined) {
    if (!record(value.receipt)) throw new Error('Invalid report journal receipt');
    const revision = readMemberWorkSyncStatusRevision({
      statusRevision: value.receipt.appliedStatusRevision,
    });
    receipt = readMemberWorkSyncReportReceipt(value.receipt, revision);
    if (
      receipt.intentId !== intentId ||
      receipt.incarnation !== value.incarnation ||
      receipt.requestDigest !== value.requestDigest
    )
      throw new Error('Conflicting report journal receipt');
  }
  return {
    incarnation: value.incarnation,
    requestDigest: value.requestDigest,
    firstRecordedAt: value.firstRecordedAt,
    origin: value.origin,
    ...(receipt ? { receipt } : {}),
  };
}
