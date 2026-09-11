import { readMemberWorkSyncStatusRevision } from './MemberWorkSyncStatusRevision';

import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncStatusRevision,
} from '../../contracts';

export class MemberWorkSyncReportReceiptError extends Error {
  constructor() {
    super('Invalid member work sync report receipt');
    this.name = 'MemberWorkSyncReportReceiptError';
  }
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function readMemberWorkSyncReportReceiptDraft(
  value: unknown,
  incarnation: string
): MemberWorkSyncReportReceiptDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemberWorkSyncReportReceiptError();
  }
  const candidate = value as Record<string, unknown>;
  if (
    !identifier(candidate.intentId) ||
    !identifier(candidate.incarnation) ||
    candidate.incarnation !== incarnation ||
    !identifier(candidate.requestDigest) ||
    !timestamp(candidate.acceptedAt) ||
    (candidate.originalExpiresAt !== undefined && !timestamp(candidate.originalExpiresAt))
  ) {
    throw new MemberWorkSyncReportReceiptError();
  }
  return {
    intentId: candidate.intentId,
    incarnation: candidate.incarnation,
    requestDigest: candidate.requestDigest,
    acceptedAt: candidate.acceptedAt,
    ...(candidate.originalExpiresAt === undefined
      ? {}
      : { originalExpiresAt: candidate.originalExpiresAt }),
  };
}

/** Persisted checkpoints require a valid revision in the current status lineage. */
export function readMemberWorkSyncReportReceipt(
  value: unknown,
  currentRevision: MemberWorkSyncStatusRevision | null
): MemberWorkSyncReportReceipt {
  if (!currentRevision) throw new MemberWorkSyncReportReceiptError();
  const draft = readMemberWorkSyncReportReceiptDraft(value, currentRevision.incarnation);
  const revision = readMemberWorkSyncStatusRevision({
    statusRevision: (value as Record<string, unknown>).appliedStatusRevision,
  });
  if (
    revision?.incarnation !== currentRevision.incarnation ||
    revision.lineageId !== currentRevision.lineageId ||
    revision.sequence > currentRevision.sequence ||
    (revision.sequence === currentRevision.sequence && revision.nonce !== currentRevision.nonce)
  ) {
    throw new MemberWorkSyncReportReceiptError();
  }
  return { ...draft, appliedStatusRevision: revision };
}
