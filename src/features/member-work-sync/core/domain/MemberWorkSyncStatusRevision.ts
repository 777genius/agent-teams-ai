import type { MemberWorkSyncStatusRevision } from '../../contracts';

export class MemberWorkSyncStatusConflictError extends Error {
  constructor(
    readonly reason:
      | 'invalid_revision'
      | 'incarnation_mismatch'
      | 'lineage_mismatch'
      | 'revision_divergence'
  ) {
    super(`Member work sync storage conflict: ${reason}`);
    this.name = 'MemberWorkSyncStatusConflictError';
  }
}

/** Missing is legacy; present-but-invalid must never silently become legacy. */
export function readMemberWorkSyncStatusRevision(
  status: unknown
): MemberWorkSyncStatusRevision | null {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new MemberWorkSyncStatusConflictError('invalid_revision');
  }
  if (!Object.hasOwn(status, 'statusRevision')) return null;
  const revision = (status as { statusRevision: unknown }).statusRevision;
  if (revision === undefined) return null; // JSON omits optional undefined fields.
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    throw new MemberWorkSyncStatusConflictError('invalid_revision');
  }
  const candidate = revision as Record<string, unknown>;
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;
  if (
    !validId(candidate.incarnation) ||
    !validId(candidate.lineageId) ||
    !validId(candidate.nonce) ||
    typeof candidate.sequence !== 'number' ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence < 1
  ) {
    throw new MemberWorkSyncStatusConflictError('invalid_revision');
  }
  return {
    incarnation: candidate.incarnation,
    lineageId: candidate.lineageId,
    sequence: candidate.sequence,
    nonce: candidate.nonce,
  };
}

function canonicalPayload(value: unknown): string {
  // Compare persisted JSON semantics, including omission of undefined fields.
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return item;
  };
  return JSON.stringify(canonicalize(parsed));
}

/** null means both rows are legacy and the existing legacy import policy applies. */
export function chooseMemberWorkSyncStatusRevision(
  canonical: unknown,
  incoming: unknown
): 'canonical' | 'incoming' | null {
  const left = readMemberWorkSyncStatusRevision(canonical);
  const right = readMemberWorkSyncStatusRevision(incoming);
  if (!left && !right) return null;
  if (!left) return 'incoming';
  if (!right) return 'canonical';
  if (left.incarnation !== right.incarnation) {
    throw new MemberWorkSyncStatusConflictError('incarnation_mismatch');
  }
  if (left.lineageId !== right.lineageId) {
    throw new MemberWorkSyncStatusConflictError('lineage_mismatch');
  }
  if (left.sequence !== right.sequence)
    return left.sequence > right.sequence ? 'canonical' : 'incoming';
  if (left.nonce !== right.nonce || canonicalPayload(canonical) !== canonicalPayload(incoming)) {
    throw new MemberWorkSyncStatusConflictError('revision_divergence');
  }
  return 'canonical';
}
